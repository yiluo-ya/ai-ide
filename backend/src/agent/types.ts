/**
 * code-agent 适配层：一套接口 + 一套归一化事件（2026-10-03 用户要求）。
 *
 * 目的：阅读器里能直接跑一个会改代码 / 生成代码的 agent，且以后能换成别的 agent
 * （本机 pi、OpenHands、自研的）—— 换的只是适配器，API 与界面不动。
 *
 * 事件名沿用 pi 的会话事件名（agent_start / message_start|update|end /
 * tool_execution_start|end / agent_settled），这样前端一套渲染逻辑对所有后端都成立，
 * 接入新 agent 时不必碰前端。
 */
import type { EventEmitter } from 'node:events';
import type { ProjectIndex } from '../indexer/store';
import type { ProjectRegistry } from '../registry';

/** 后端类型；添加一个后端 = 写一个适配器 + 在这里加个名字。 */
export type BackendKind = 'builtin' | 'pi' | 'openhands';

export const BACKEND_KINDS: readonly BackendKind[] = ['builtin', 'pi', 'openhands'];

export function isBackendKind(value: unknown): value is BackendKind {
  return typeof value === 'string' && (BACKEND_KINDS as readonly string[]).includes(value);
}

/** 消息内容块（与 pi 的形状一致：text / thinking / toolCall）。 */
export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 会话消息的松散视图；role 取值 user / assistant / toolResult / system。 */
export interface AgentMessage {
  role: string;
  content?: string | ContentBlock[];
  timestamp?: number;
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  [key: string]: unknown;
}

/** 助手消息的流式增量（与 pi 的 AssistantMessageEvent 同形）。 */
export interface AssistantDelta {
  type: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
  toolCall?: ContentBlock;
}

/** 推给前端的事件；`type` 就是 pi 那套事件名。 */
export type NormalizedEvent = Record<string, unknown> & { type: string };

/** 模型引用：provider 是配置里的 provider id，modelId 是它下面某个模型 id。 */
export interface ModelRef {
  provider: string;
  modelId: string;
}

/** 解析后的调用参数（适配器不碰配置文件，宿主解析好再给）。 */
export interface ResolvedLlm {
  providerId: string;
  providerName?: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
}

/** 适配器拿到的宿主上下文：项目索引 + 工作目录（= 项目根）。 */
export interface AgentHost {
  registry: ProjectRegistry;
  projectId: string;
  project: ProjectIndex;
}

export interface AdapterOptions {
  host: AgentHost;
  /** 会话显示名。 */
  name?: string;
  /** 会话选的模型（未解析）；直接 API 的后端会用它去 resolveLlm。 */
  model?: ModelRef;
  /** 已经解析好的凭据（宿主给的，优先于 model）。 */
  llm?: ResolvedLlm;
  /**
   * 只读模式（FR-0005 命令分析用）：工具集去掉 write_file / edit_file，
   * 提示词也写明「本轮不要写文件」。默认 false（可读可写）。
   */
  readOnly?: boolean;
}

export interface SessionState {
  model?: { id?: string; name?: string; provider?: string; api?: string } | null;
  sessionId?: string;
  sessionName?: string;
  messageCount?: number;
  isStreaming?: boolean;
}

export interface AdapterExit {
  code: number | null;
  signal: string | null;
  message?: string;
}

/**
 * 一个后端实例。
 *
 * 事件：
 * - `event`(NormalizedEvent)：给前端的协议记录
 * - `exit`(AdapterExit)：后端不可再用（进程退出 / 连接断开）
 */
export interface AgentAdapter extends EventEmitter {
  readonly kind: BackendKind;
  /** 会话工作目录（= 项目根）。 */
  readonly cwd: string;
  /** 最近几行错误输出，用来解释启动 / 调用失败。 */
  readonly stderrTail: string[];
  /** 建立连接 / 起进程；失败时 reject 一个能直接给用户看的错误。 */
  start(): Promise<SessionState>;
  /** 交一条消息；完成以 `agent_settled` 事件为准。 */
  prompt(message: string): Promise<void>;
  abort(): Promise<void>;
  getMessages(): Promise<AgentMessage[]>;
  getState(): Promise<SessionState>;
  setModel(ref: ModelRef): Promise<{ id?: string; name?: string; provider?: string } | null>;
  rename(name: string): Promise<void>;
  /** 释放资源；可重复调用。 */
  dispose(): void;
}

/** 工具定义（OpenAI function calling 的 tools 项）。 */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema（`type: 'object'` + properties）。 */
  parameters: Record<string, unknown>;
}

/** 工具执行结果；content 会原样进模型上下文。 */
export interface ToolResult {
  content: string;
  isError?: boolean;
  /** 本次调用改动的项目内文件（前端据此显示「改了哪些文件」）。 */
  changed?: string[];
}

/** 拼一条 assistant 消息的流式增量（pi 的规则：end 事件带完整内容，覆盖累积值）。 */
export function applyDelta(message: AgentMessage, event: AssistantDelta): AgentMessage {
  const index = typeof event.contentIndex === 'number' ? event.contentIndex : 0;
  const content: ContentBlock[] = Array.isArray(message.content) ? [...message.content] : [];
  const current: ContentBlock = content[index] ?? { type: 'text', text: '' };
  const delta = event.delta ?? '';

  switch (event.type) {
    case 'text_start':
      content[index] = { type: 'text', text: '' };
      break;
    case 'text_delta':
      content[index] = { ...current, type: 'text', text: (current.text ?? '') + delta };
      break;
    case 'text_end':
      content[index] = {
        type: 'text',
        text: typeof event.content === 'string' ? event.content : current.text,
      };
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
      if (event.toolCall) content[index] = event.toolCall;
      break;
    default:
      return message;
  }
  return { ...message, content };
}

/** 一条消息里的文本（用于回灌给模型 / 展示）。 */
export function messageText(message: AgentMessage): string {
  if (typeof message.content === 'string') return message.content;
  return (message.content ?? [])
    .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}
