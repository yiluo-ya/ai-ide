/**
 * 「测试连接」：用给定参数发一条最小的非流式请求，看模型到底通不通（2026-10-13 用户要求）。
 *
 * 与对话链路分开写：测试只需要「HTTP 成不成、模型认不认」，所以不用流式、不解析 SSE，
 * 只把各家响应里那句最小回复摘出来给人看。参数可以是表单里还没保存的值。
 */
import { joinApiUrl } from './llm-util';
import type { ApiType } from './types';

export interface ProbeInput {
  apiType: ApiType;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  timeoutMs?: number;
}

export interface ProbeResult {
  modelId: string;
  ok: boolean;
  /** 往返毫秒数。 */
  ms: number;
  /** HTTP 状态码（连不上时没有）。 */
  status?: number;
  /** 模型回的那句话（能摘出来时）。 */
  reply?: string;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** 给一点输出空间：有的模型（尤其推理型）max_tokens 太小会直接报错。 */
const PROBE_TOKENS = 16;

export async function probeLlm(input: ProbeInput): Promise<ProbeResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const { url, init, pick } = buildRequest(input);
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text().catch(() => '');
    const ms = Date.now() - started;
    if (!response.ok) {
      return { modelId: input.modelId, ok: false, ms, status: response.status, error: httpError(text, response) };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      // 200 但不是 JSON（极少见）：当作通了，但把开头贴出来
      return { modelId: input.modelId, ok: true, ms, status: response.status, reply: text.slice(0, 200) };
    }
    return { modelId: input.modelId, ok: true, ms, status: response.status, ...(pick(payload) ? { reply: pick(payload) } : {}) };
  } catch (error) {
    const ms = Date.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      modelId: input.modelId,
      ok: false,
      ms,
      error: aborted ? `超时（${Math.round(ms / 1000)} 秒没有响应）` : message,
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildRequest(input: ProbeInput): {
  url: string;
  init: RequestInit;
  pick: (payload: unknown) => string;
} {
  const { apiType, baseUrl, apiKey, modelId } = input;
  if (apiType === 'anthropic') {
    return {
      url: joinApiUrl(baseUrl, '/v1/messages'),
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: modelId,
          max_tokens: PROBE_TOKENS,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      },
      pick: (payload) => firstText((payload as { content?: Array<{ text?: string }> }).content?.map((b) => b.text)),
    };
  }
  if (apiType === 'openai-responses') {
    return {
      url: joinApiUrl(baseUrl, '/responses'),
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model: modelId, input: 'ping', max_output_tokens: PROBE_TOKENS }),
      },
      pick: (payload) => {
        const value = payload as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
        if (typeof value.output_text === 'string' && value.output_text) return value.output_text.slice(0, 200);
        const texts = (value.output ?? []).flatMap((item) => item.content ?? []).map((part) => part.text);
        return firstText(texts);
      },
    };
  }
  if (apiType === 'gemini') {
    const model = modelId.replace(/^models\//, '');
    return {
      url: `${joinApiUrl(baseUrl, `/v1beta/models/${model}:generateContent`)}?key=${encodeURIComponent(apiKey)}`,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: PROBE_TOKENS },
        }),
      },
      pick: (payload) => {
        const value = payload as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
        };
        const parts = value.candidates?.[0]?.content?.parts ?? [];
        return firstText(parts.filter((part) => part.thought !== true).map((part) => part.text));
      },
    };
  }
  return {
    url: joinApiUrl(baseUrl, '/chat/completions'),
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: PROBE_TOKENS,
        stream: false,
      }),
    },
    pick: (payload) => {
      const value = payload as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> };
      const message = value.choices?.[0]?.message;
      return firstText([message?.content, message?.reasoning_content]);
    },
  };
}

function firstText(values: Array<string | undefined> | undefined): string {
  const found = (values ?? []).find((value) => typeof value === 'string' && value.trim());
  return found ? found.trim().slice(0, 200) : '';
}

/** 从错误响应里摘一句人能读的信息（各家的形状不一样）。 */
function httpError(text: string, response: Response): string {
  const fallback = (text || response.statusText).slice(0, 300);
  try {
    const payload = JSON.parse(text) as {
      error?: { message?: string } | string;
      message?: string;
      detail?: string;
    };
    if (typeof payload.error === 'string') return payload.error;
    if (typeof payload.error?.message === 'string') return payload.error.message;
    if (typeof payload.message === 'string') return payload.message;
    if (typeof payload.detail === 'string') return payload.detail;
  } catch {
    /* 不是 JSON，用原文 */
  }
  return fallback;
}
