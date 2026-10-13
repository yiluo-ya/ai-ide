/**
 * 模型调用入口：按 provider 的 `apiType` 分派到各协议实现（2026-10-13 用户要求支持多种 API 类型）。
 *
 * 中间表示固定为 OpenAI 形状（`ChatMessage[]` + `ToolDefinition[]`，见 `openai.ts` / `llm-util.ts`）：
 * 各协议实现自己负责「把中间表示转成自家请求体 → 解析自家的流」，上层（builtin agent）只认归一化结果。
 * 加一种协议 = 加一个实现文件 + 这里一个 case。
 */
import { streamChat as streamOpenAiChat, type ChatMessage, type ChatToolCall, type StreamResult } from './openai';
import { streamAnthropic } from './anthropic';
import { streamResponses } from './responses';
import { streamGemini } from './gemini';
import type { LlmStreamRequest } from './llm-util';

export type { ChatMessage, ChatToolCall, StreamResult };
export type { LlmStreamRequest };

/** 一次流式调用：按 apiType 选协议形状。 */
export async function streamChat(request: LlmStreamRequest): Promise<StreamResult> {
  switch (request.apiType) {
    case 'anthropic':
      return streamAnthropic(request);
    case 'openai-responses':
      return streamResponses(request);
    case 'gemini':
      return streamGemini(request);
    default:
      return streamOpenAiChat(request);
  }
}
