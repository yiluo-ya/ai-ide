/**
 * 内置 code-agent 的前端客户端：/api/agent/*（模型配置 + 会话 + 事件流）。
 *
 * 事件形状与后端适配层一致（agent_start / message_* / tool_execution_* / agent_settled），
 * 换后端时这一层不用改。
 */
import { request } from './api';

export type BackendKind = 'builtin' | 'pi' | 'openhands';

/** 打码后的模型 provider（明文 key 不出服务端）。 */
export interface ModelProviderPublic {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  hasKey: boolean;
  keyHint?: string;
}

export interface ModelConfigPublic {
  providers: ModelProviderPublic[];
  default: { provider: string; modelId: string } | null;
  path: string;
}

export interface AgentSessionSummary {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  projectRoot: string;
  backend: BackendKind;
  createdAt: number;
  alive: boolean;
  isStreaming: boolean;
  messageCount: number;
  model: { id?: string; name?: string; provider?: string } | null;
  lastError?: string;
}

export interface AgentContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AgentMessage {
  role: string;
  content?: string | AgentContentBlock[];
  timestamp?: number;
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  [key: string]: unknown;
}

/** SSE 事件（`type` 就是适配层的事件名）。 */
export type AgentEvent = Record<string, unknown> & { type: string };

export const agentApi = {
  modelConfig: () => request<ModelConfigPublic>('/agent/model-config'),

  saveProvider: (input: {
    id?: string;
    name?: string;
    baseUrl: string;
    apiKey?: string;
    models?: string[];
  }) =>
    request<{ ok: boolean; provider: ModelProviderPublic; config: ModelConfigPublic }>('/agent/model-config', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  removeProvider: (id: string) =>
    request<{ ok: boolean; config: ModelConfigPublic }>('/agent/model-config/remove', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),

  setDefaultModel: (provider: string, modelId: string) =>
    request<{ ok: boolean; config: ModelConfigPublic }>('/agent/model-config/default', {
      method: 'POST',
      body: JSON.stringify({ provider, modelId }),
    }),

  clearDefaultModel: () =>
    request<{ ok: boolean; config: ModelConfigPublic }>('/agent/model-config/default', {
      method: 'POST',
      body: JSON.stringify({ clear: true }),
    }),

  sessions: () => request<{ sessions: AgentSessionSummary[] }>('/agent/sessions').then((r) => r.sessions),

  createSession: (input: { projectId: string; name?: string; backend?: BackendKind; provider?: string; modelId?: string }) =>
    request<{ session: AgentSessionSummary }>('/agent/sessions', {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.session),

  deleteSession: (id: string) => request<{ ok: boolean }>(`/agent/sessions/${id}`, { method: 'DELETE' }),

  messages: (id: string) =>
    request<{ messages: AgentMessage[] }>(`/agent/sessions/${id}/messages`).then((r) => r.messages),

  prompt: (id: string, message: string) =>
    request<{ ok: boolean }>(`/agent/sessions/${id}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),

  abort: (id: string) => request<{ ok: boolean }>(`/agent/sessions/${id}/abort`, { method: 'POST' }),

  setSessionModel: (id: string, provider: string, modelId: string) =>
    request<{ ok: boolean; session: AgentSessionSummary }>(`/agent/sessions/${id}/model`, {
      method: 'POST',
      body: JSON.stringify({ provider, modelId }),
    }),
};

/** 订阅一个会话的事件流；返回退订函数。 */
export function subscribeAgentEvents(sessionId: string, onEvent: (event: AgentEvent) => void): () => void {
  const source = new EventSource(`/api/agent/sessions/${sessionId}/events`);
  source.onmessage = (e: MessageEvent) => {
    try {
      onEvent(JSON.parse(e.data as string) as AgentEvent);
    } catch {
      /* 坏事件忽略 */
    }
  };
  return () => source.close();
}

/** 把流式增量拼进消息（与后端 pi 的规则一致：end 事件带完整内容，覆盖累积值）。 */
export function applyAssistantDelta(message: AgentMessage, event: Record<string, unknown>): AgentMessage {
  const index = typeof event.contentIndex === 'number' ? event.contentIndex : 0;
  const content: AgentContentBlock[] = Array.isArray(message.content) ? [...message.content] : [];
  const current: AgentContentBlock = content[index] ?? { type: 'text', text: '' };
  const delta = typeof event.delta === 'string' ? event.delta : '';

  switch (event.type) {
    case 'text_start':
      content[index] = { type: 'text', text: '' };
      break;
    case 'text_delta':
      content[index] = { ...current, type: 'text', text: (current.text ?? '') + delta };
      break;
    case 'text_end':
      content[index] = { type: 'text', text: typeof event.content === 'string' ? event.content : current.text };
      break;
    case 'thinking_start':
      content[index] = { type: 'thinking', thinking: '' };
      break;
    case 'thinking_delta':
      content[index] = { ...current, type: 'thinking', thinking: (current.thinking ?? '') + delta };
      break;
    case 'thinking_end':
      content[index] = {
        type: 'thinking',
        thinking: typeof event.content === 'string' ? event.content : current.thinking,
      };
      break;
    case 'toolcall_end':
      if (event.toolCall && typeof event.toolCall === 'object') content[index] = event.toolCall as AgentContentBlock;
      break;
    default:
      return message;
  }
  return { ...message, content };
}

/** 消息里的纯文本。 */
export function agentMessageText(message: AgentMessage): string {
  if (typeof message.content === 'string') return message.content;
  return (message.content ?? [])
    .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}
