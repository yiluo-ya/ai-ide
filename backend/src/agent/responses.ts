/**
 * OpenAI Responses API（`POST /responses`，SSE）—— GPT-5 系新接口。
 *
 * 与 chat/completions 的差别都在这里消化：
 * - `input` 是条目数组（message / function_call / function_call_output），不是角色消息数组；
 * - 工具定义是扁平的 `{type:'function', name, description, parameters}`；
 * - 流事件是「命名事件 + JSON 负载」（`response.output_text.delta` / `response.function_call_arguments.delta`…），
 *   工具参数按 `output_index` 累积，回灌时要用 `call_id`。
 */
import type { ChatMessage, ChatToolCall, StreamResult } from './openai';
import { asNumber, asString, ensureOk, joinApiUrl, readSseData, type LlmStreamRequest } from './llm-util';

export async function streamResponses(request: LlmStreamRequest): Promise<StreamResult> {
  const body: Record<string, unknown> = {
    model: request.model,
    input: toResponsesInput(request.messages),
    stream: true,
  };
  if (request.maxTokens) body.max_output_tokens = request.maxTokens;
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  const response = await fetch(joinApiUrl(request.baseUrl, '/responses'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(request.apiKey ? { authorization: `Bearer ${request.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: request.signal,
  });
  const stream = await ensureOk(response, '模型请求');

  const result: StreamResult = { text: '', reasoning: '', toolCalls: [] };
  /** key = output_index（流里同一条 function_call 的增量靠它对上）。 */
  const pending = new Map<number, { id: string; callId: string; name: string; args: string }>();

  for await (const payload of readSseData(stream)) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = asString(event.type);

    if (type === 'response.output_text.delta') {
      const delta = asString(event.delta);
      if (delta) {
        result.text += delta;
        request.onTextDelta?.(delta);
      }
      continue;
    }
    if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      const delta = asString(event.delta);
      if (delta) {
        result.reasoning += delta;
        request.onReasoningDelta?.(delta);
      }
      continue;
    }
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const item = (event.item ?? {}) as Record<string, unknown>;
      if (item.type === 'function_call') {
        const index = asNumber(event.output_index);
        const current = pending.get(index) ?? {
          id: asString(item.id),
          callId: asString(item.call_id),
          name: asString(item.name),
          args: '',
        };
        if (typeof item.arguments === 'string' && item.arguments) current.args = item.arguments;
        if (typeof item.call_id === 'string' && item.call_id) current.callId = item.call_id;
        if (typeof item.name === 'string' && item.name) current.name = item.name;
        pending.set(index, current);
      }
      continue;
    }
    if (type === 'response.function_call_arguments.delta') {
      const current = pending.get(asNumber(event.output_index));
      if (current && typeof event.delta === 'string') current.args += event.delta;
      continue;
    }
    if (type === 'response.completed') {
      const done = (event.response ?? {}) as Record<string, unknown>;
      if (done.status === 'failed' || done.error) {
        throw new Error(`模型返回错误：${JSON.stringify(done.error ?? done)}`);
      }
      continue;
    }
    if (type === 'error' || type === 'response.failed') {
      throw new Error(`模型返回错误：${JSON.stringify(event.error ?? event.response ?? event)}`);
    }
  }

  for (const [index, call] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
    const toolCall: ChatToolCall = {
      id: call.callId || call.id || `call_${index}`,
      name: call.name,
      arguments: call.args,
    };
    result.toolCalls.push(toolCall);
  }
  return result;
}

/** 中间表示 → `input` 条目数组。 */
function toResponsesInput(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === 'user' || message.role === 'system') {
      out.push({ role: message.role, content: [{ type: 'input_text', text: message.content ?? '' }] });
      continue;
    }
    if (message.role === 'assistant') {
      if (message.content) out.push({ role: 'assistant', content: [{ type: 'output_text', text: message.content }] });
      for (const call of message.tool_calls ?? []) {
        out.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments || '{}',
        });
      }
      continue;
    }
    out.push({ type: 'function_call_output', call_id: message.tool_call_id ?? '', output: message.content ?? '' });
  }
  return out;
}
