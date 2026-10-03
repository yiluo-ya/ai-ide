/**
 * 最小的 OpenAI 兼容客户端：一次 POST `/chat/completions`（stream），按 SSE 增量解析。
 *
 * 内置 agent 只需要这些。刻意不做：重试、限流、其他 API 形状（responses / anthropic）；
 * 需要别的形状时，是在适配层后面再加一个适配器，而不是把这个文件堆大。
 */
import type { ToolDefinition } from './types';

export interface ChatToolCall {
  id: string;
  name: string;
  /** 模型给的原始 JSON 字符串（可能是坏的，调用方容错）。 */
  arguments: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface StreamRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
}

export interface StreamResult {
  text: string;
  reasoning: string;
  toolCalls: ChatToolCall[];
  finishReason?: string;
}

interface ToolAccumulator {
  id: string;
  name: string;
  args: string;
}

/** 一次流式调用：边回调增量，边把文本与工具调用攒出来。 */
export async function streamChat(request: StreamRequest): Promise<StreamResult> {
  const url = `${request.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    stream: true,
  };
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    body.tool_choice = 'auto';
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(request.apiKey ? { authorization: `Bearer ${request.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: request.signal,
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new Error(`模型请求失败（HTTP ${response.status}）：${(text || response.statusText).slice(0, 400)}`);
  }

  const result: StreamResult = { text: '', reasoning: '', toolCalls: [] };
  const pending = new Map<number, ToolAccumulator>();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE 帧之间是空行；LF 与 CRLF 都容忍
    let boundary = frameBoundary(buffer);
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary).replace(/^(\r?\n)+/, '');
      consumeFrame(frame, result, pending, request);
      boundary = frameBoundary(buffer);
    }
  }
  if (buffer.trim()) consumeFrame(buffer, result, pending, request);

  for (const [index, call] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
    result.toolCalls.push({ id: call.id || `call_${index}`, name: call.name, arguments: call.args });
  }
  return result;
}

function frameBoundary(buffer: string): number {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0) return crlf;
  if (crlf < 0) return lf;
  return Math.min(lf, crlf);
}

function consumeFrame(
  frame: string,
  result: StreamResult,
  pending: Map<number, ToolAccumulator>,
  request: StreamRequest,
): void {
  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;

    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue; // 半截帧（理论上不会出现）直接跳过，别让整轮失败
    }

    const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0];
    if (!choice) continue;
    if (typeof choice.finish_reason === 'string') result.finishReason = choice.finish_reason;

    const delta = (choice.delta ?? {}) as Record<string, unknown>;
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === 'string' && reasoning) {
      result.reasoning += reasoning;
      request.onReasoningDelta?.(reasoning);
    }
    if (typeof delta.content === 'string' && delta.content) {
      result.text += delta.content;
      request.onTextDelta?.(delta.content);
    }

    const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        const index = typeof call.index === 'number' ? call.index : 0;
        const current = pending.get(index) ?? { id: '', name: '', args: '' };
        if (typeof call.id === 'string') current.id = call.id;
        const fn = call.function as { name?: string; arguments?: string } | undefined;
        if (typeof fn?.name === 'string') current.name = fn.name;
        if (typeof fn?.arguments === 'string') current.args += fn.arguments;
        pending.set(index, current);
      }
    }
  }
}
