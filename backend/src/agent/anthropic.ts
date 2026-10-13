/**
 * Anthropic Messages API（`POST /v1/messages`，SSE）。
 *
 * 只做内置 agent 需要的三样：正文文本、thinking、tool_use（含流式 input_json_delta）。
 */
import type { ChatMessage, ChatToolCall, StreamResult } from './openai';
import { asNumber, asString, ensureOk, joinApiUrl, parseArgs, readSseData, systemText, type LlmStreamRequest } from './llm-util';

const ANTHROPIC_VERSION = '2023-06-01';
/** Messages API 的 max_tokens 是必填项；这里给一个够写代码的上限。 */
const DEFAULT_MAX_TOKENS = 8192;

export async function streamAnthropic(request: LlmStreamRequest): Promise<StreamResult> {
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: toAnthropicMessages(request.messages),
    stream: true,
  };
  const system = systemText(request.messages);
  if (system) body.system = system;
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }

  const response = await fetch(joinApiUrl(request.baseUrl, '/v1/messages'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': request.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
    signal: request.signal,
  });
  const stream = await ensureOk(response, '模型请求');

  const result: StreamResult = { text: '', reasoning: '', toolCalls: [] };
  const pending = new Map<number, ChatToolCall>();

  for await (const payload of readSseData(stream)) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = asString(event.type);

    if (type === 'error') {
      throw new Error(`模型返回错误：${errorMessage(event.error)}`);
    }
    if (type === 'content_block_start') {
      const block = event.content_block as Record<string, unknown> | undefined;
      if (block && block.type === 'tool_use') {
        pending.set(asNumber(event.index), {
          id: asString(block.id),
          name: asString(block.name),
          arguments: '',
        });
      }
      continue;
    }
    if (type === 'content_block_delta') {
      const delta = (event.delta ?? {}) as Record<string, unknown>;
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        result.text += delta.text;
        request.onTextDelta?.(delta.text);
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        result.reasoning += delta.thinking;
        request.onReasoningDelta?.(delta.thinking);
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const current = pending.get(asNumber(event.index));
        if (current) current.arguments += delta.partial_json;
      }
      continue;
    }
    if (type === 'message_delta') {
      const delta = (event.delta ?? {}) as Record<string, unknown>;
      if (typeof delta.stop_reason === 'string') result.finishReason = delta.stop_reason;
    }
  }

  for (const [index, call] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
    result.toolCalls.push({ id: call.id || `call_${index}`, name: call.name, arguments: call.arguments });
  }
  return result;
}

/**
 * 中间表示 → Messages API：
 * - system 走顶层（见 systemText），这里跳过；
 * - assistant 的 tool_calls → `tool_use` 块（input 是对象，不是字符串）；
 * - tool 结果 → `tool_result` 块，且必须并进一条 user 消息（API 要求它紧随 tool_use）。
 */
function toAnthropicMessages(messages: ChatMessage[]): Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> {
  const out: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'text', text: message.content ?? '' }] });
      continue;
    }
    if (message.role === 'assistant') {
      const content: Array<Record<string, unknown>> = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls ?? []) {
        content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: parseArgs(call.function.arguments) });
      }
      if (content.length === 0) content.push({ type: 'text', text: '' });
      out.push({ role: 'assistant', content });
      continue;
    }
    const block = { type: 'tool_result', tool_use_id: message.tool_call_id ?? '', content: message.content ?? '' };
    const last = out[out.length - 1];
    if (last && last.role === 'user' && last.content.every((item) => item.type === 'tool_result')) {
      last.content.push(block);
    } else {
      out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

function errorMessage(error: unknown): string {
  const value = error as { message?: unknown } | null;
  return typeof value?.message === 'string' ? value.message : JSON.stringify(error);
}
