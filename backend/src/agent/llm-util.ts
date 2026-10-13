/**
 * 各模型协议实现共用的工具（分派层 `llm.ts` 与四个协议文件都从这里取）。
 *
 * 单独成文件是为了避免 `llm.ts ⇄ 各协议实现` 的循环 import：协议实现**只依赖这里**。
 */
import type { ChatMessage } from './openai';
import type { ApiType, ToolDefinition } from './types';

export interface LlmStreamRequest {
  apiType: ApiType;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  /** 输出上限（anthropic / gemini 必填，其余可选）。 */
  maxTokens?: number;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
}

/**
 * 拼接口路径：baseUrl 去掉尾斜杠，再挂上 path。
 * baseUrl 里已经带了版本段（`/v1`、`/v1beta`）时不重复拼 —— 有人习惯两边都写。
 */
export function joinApiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (base.endsWith(path)) return base;
  const versioned = /^(.*\/v1(?:beta)?)(\/.*)$/.exec(path);
  if (versioned && base.endsWith(versioned[1])) return `${base}${versioned[2]}`;
  return `${base}${path}`;
}

/** 非 2xx / 没有响应体时抛一条能直接给用户看的错。返回可读的流。 */
export async function ensureOk(response: Response, label: string): Promise<ReadableStream<Uint8Array>> {
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new Error(`${label}失败（HTTP ${response.status}）：${(text || response.statusText).slice(0, 400)}`);
  }
  return response.body;
}

/** 逐帧吐 SSE 的 `data:` 负载（LF / CRLF、`event:` 行都容忍）。 */
export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = frameBoundary(buffer);
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary).replace(/^(\r?\n)+/, '');
      for (const payload of frameData(frame)) yield payload;
      boundary = frameBoundary(buffer);
    }
  }
  if (buffer.trim()) {
    for (const payload of frameData(buffer)) yield payload;
  }
}

/** 多条 system 消息拼一段（anthropic / gemini 把 system 放顶层，不进 messages）。 */
export function systemText(messages: ChatMessage[]): string {
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content ?? '')
    .filter(Boolean)
    .join('\n\n');
}

/** 模型给的参数字符串可能是坏的 —— 解析失败就当空对象，别让整轮崩。 */
export function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function frameBoundary(buffer: string): number {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0) return crlf;
  if (crlf < 0) return lf;
  return Math.min(lf, crlf);
}

function* frameData(frame: string): Generator<string> {
  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue; // 只认 data:，event: 行的信息都在负载里
    const payload = line.slice(5).trim();
    if (payload && payload !== '[DONE]') yield payload;
  }
}
