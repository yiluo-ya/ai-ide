/**
 * Google Gemini API（`POST /v1beta/models/{model}:streamGenerateContent?alt=sse`）。
 *
 * 与 OpenAI 形状的差别都在这里消化：
 * - 角色只有 user / model，system 走 `systemInstruction`；
 * - 内容是一串 `parts`（text / functionCall / functionResponse）；
 * - 工具是 `tools[].functionDeclarations[]`（JSON Schema 的子集，见 sanitizeSchema）；
 * - 认证走 URL 上的 `key=`，不是 Authorization 头。
 */
import type { ChatMessage, StreamResult } from './openai';
import { asString, ensureOk, joinApiUrl, parseArgs, readSseData, systemText, type LlmStreamRequest } from './llm-util';

const DEFAULT_MAX_TOKENS = 8192;

export async function streamGemini(request: LlmStreamRequest): Promise<StreamResult> {
  const model = request.model.replace(/^models\//, '');
  const path = `/v1beta/models/${model}:streamGenerateContent`;
  const url = `${joinApiUrl(request.baseUrl, path)}?alt=sse&key=${encodeURIComponent(request.apiKey)}`;

  const body: Record<string, unknown> = { contents: toGeminiContents(request.messages) };
  const system = systemText(request.messages);
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (request.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: sanitizeSchema(tool.parameters),
        })),
      },
    ];
  }
  body.generationConfig = { maxOutputTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: request.signal,
  });
  const stream = await ensureOk(response, '模型请求');

  const result: StreamResult = { text: '', reasoning: '', toolCalls: [] };

  for await (const payload of readSseData(stream)) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.error) throw new Error(`模型返回错误：${JSON.stringify(event.error)}`);

    const feedback = event.promptFeedback as Record<string, unknown> | undefined;
    if (feedback && feedback.blockReason) {
      throw new Error(`模型拒绝了这个请求（blockReason: ${asString(feedback.blockReason)}）`);
    }

    const candidate = (event.candidates as Array<Record<string, unknown>> | undefined)?.[0];
    if (!candidate) continue;
    if (typeof candidate.finishReason === 'string') result.finishReason = candidate.finishReason;

    const content = (candidate.content ?? {}) as Record<string, unknown>;
    const parts = Array.isArray(content.parts) ? (content.parts as Array<Record<string, unknown>>) : [];
    for (const part of parts) {
      const text = typeof part.text === 'string' ? part.text : '';
      if (text) {
        if (part.thought === true) {
          result.reasoning += text;
          request.onReasoningDelta?.(text);
        } else {
          result.text += text;
          request.onTextDelta?.(text);
        }
      }
      const call = part.functionCall as { name?: unknown; args?: unknown } | undefined;
      if (call && typeof call.name === 'string') {
        result.toolCalls.push({
          id: `call_${result.toolCalls.length}`,
          name: call.name,
          arguments: JSON.stringify(call.args ?? {}),
        });
      }
    }
  }
  return result;
}

/** 中间表示 → `contents`（user / model，连续的同类合并成一条 —— Gemini 要求角色交替）。 */
function toGeminiContents(messages: ChatMessage[]): Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> {
  // 回灌工具结果时 Gemini 要的是函数名，而中间表示里只有 tool_call_id，所以先记一张表
  const toolNames = new Map<string, string>();
  const out: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = [];
  const push = (role: 'user' | 'model', part: Record<string, unknown>) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(part);
    else out.push({ role, parts: [part] });
  };

  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      push('user', { text: message.content ?? '' });
      continue;
    }
    if (message.role === 'assistant') {
      if (message.content) push('model', { text: message.content });
      for (const call of message.tool_calls ?? []) {
        toolNames.set(call.id, call.function.name);
        push('model', { functionCall: { name: call.function.name, args: parseArgs(call.function.arguments) } });
      }
      continue;
    }
    push('user', {
      functionResponse: {
        name: toolNames.get(message.tool_call_id ?? '') ?? 'tool',
        response: { result: message.content ?? '' },
      },
    });
  }
  return out;
}

/** Gemini 的 schema 是 OpenAPI 子集：剥掉它不认的关键字，避免 400。 */
function sanitizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const drop = new Set(['$schema', 'additionalProperties', '$id', '$defs', 'definitions']);
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (drop.has(key)) continue;
      out[key] = walk(item);
    }
    return out;
  };
  return walk(schema) as Record<string, unknown>;
}
