/**
 * 内置 code-agent：一个循环 + 一个工具包（参考 pi 的最核心部分，不要 skill / MCP / 沙箱）。
 *
 * 循环就三步（`runLoop`）：
 *   1. 把「对话 + 工具定义」发给 OpenAI 兼容端点（流式，边收边推事件）
 *   2. 追加 assistant 消息；模型没要求用工具就停
 *   3. 要求了就把每个工具跑掉、结果作为 toolResult 追加，回到 1
 *
 * 与 pi 的差别只在「谁提供工具」：这里的索引类工具直接转发给本项目已有的 /api/agent 工具，
 * 所以 agent 查「定义在哪 / 谁在调用」用的是 tree-sitter 索引，而不是 grep 猜。
 *
 * 接入别的 agent（pi / OpenHands / 自研）时的做法：实现 `AgentAdapter`，在 adapter.ts 的工厂里注册。
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { streamChat, type ChatMessage, type ChatToolCall } from './openai';
import { fallbackModel, resolveLlm } from './model-config';
import { FILE_TOOLS, INDEX_TOOL_NAMES, runAgentTool } from './tools';
import { agentToolSpecs } from '../api/agent';
import {
  type AdapterOptions,
  type AgentAdapter,
  type AgentMessage,
  type AssistantDelta,
  type BackendKind,
  type ContentBlock,
  type ModelRef,
  type ResolvedLlm,
  type SessionState,
  type ToolDefinition,
  messageText,
} from './types';

/** 一轮里最多几次「模型 → 工具」循环（防跑飞）。 */
const MAX_STEPS = Number(process.env.READER_AGENT_MAX_STEPS ?? 24);
const MAX_STDERR_LINES = 20;

/** 只读模式下去掉的工具（FR-0005：命令分析不该往仓库里写东西）。 */
const WRITE_TOOL_NAMES = new Set(['write_file', 'edit_file']);

/** 可用工具 = 索引类（复用 /api/agent 的 schema）+ 文件类（本项目新增）。 */
function toolDefinitions(readOnly = false): ToolDefinition[] {
  const indexTools = agentToolSpecs()
    .filter((spec) => (INDEX_TOOL_NAMES as readonly string[]).includes(spec.name))
    .map((spec) => ({
      name: spec.name,
      description: spec.description,
      // AgentToolParams 是结构化类型，转成通用 JSON Schema 形状给 OpenAI 用
      parameters: spec.params as unknown as Record<string, unknown>,
    }));
  const fileTools = readOnly ? FILE_TOOLS.filter((tool) => !WRITE_TOOL_NAMES.has(tool.name)) : FILE_TOOLS;
  return [...indexTools, ...fileTools];
}

function systemPrompt(cwd: string, toolNames: string[], readOnly = false): string {
  return [
    readOnly
      ? '你是一个 code agent，在用户的项目目录里读代码、分析项目。用用户使用的语言回答。'
      : '你是一个 code agent，在用户的项目目录里读代码、改代码、写代码。用用户使用的语言回答。',
    '',
    `工作目录（= 项目根，所有路径都相对它）：${cwd}`,
    `可用工具：${toolNames.join(', ')}`,
    '',
    ...(readOnly ? ['本轮只读：只读代码与分析，不要写改任何文件。', ''] : []),
    '纪律：',
    '- 改文件前必须先读那个文件，不要凭猜测写内容；edit_file 的 old_string 要逐字照抄，含缩进。',
    '- 找「某个符号定义在哪 / 谁在调用它 / 这个文件有哪些符号」用索引类工具（find_symbol / goto_definition / find_references / file_outline），比 grep 准；找普通文本才用 grep。',
    '- 只改用户要求范围内的代码；改完简短说明「改了哪个文件、改了什么」。',
    '- 路径不能跑到项目外（会被拒绝）；不要尝试访问项目外的文件。',
    '- 不要问「要不要我改」这类确认，直接做完再说结果。',
  ].join('\n');
}

interface ModelTurn {
  message: AgentMessage;
  toolCalls: ChatToolCall[];
}

export class BuiltinAgent extends EventEmitter implements AgentAdapter {
  readonly kind: BackendKind = 'builtin';
  readonly cwd: string;

  private readonly options: AdapterOptions;
  private readonly tools: ToolDefinition[];
  private readonly history: AgentMessage[] = [];
  private readonly stderrLines: string[] = [];
  private readonly sessionId = randomUUID();

  private llm: ResolvedLlm | null;
  private modelRef: ModelRef | undefined;
  private sessionName: string | undefined;
  private running = false;
  private disposed = false;
  private controller: AbortController | null = null;
  /** 本轮已流出的文本（中止时用它保住用户已经看到的部分）。 */
  private partialText = '';
  private textStarted = false;
  private reasoningSeen = false;

  constructor(options: AdapterOptions) {
    super();
    this.options = options;
    this.cwd = options.host.project.root;
    this.llm = options.llm ?? null;
    this.modelRef = options.model;
    this.sessionName = options.name;
    this.tools = toolDefinitions(options.readOnly === true);
  }

  get stderrTail(): string[] {
    return [...this.stderrLines];
  }

  async start(): Promise<SessionState> {
    if (!this.llm) {
      const ref = this.modelRef ?? (await fallbackModel());
      if (!ref) {
        throw new Error('内置 agent 需要一个模型：先在「设置 → 模型」里添加 provider（base URL + API key + 模型 id）');
      }
      this.llm = await resolveLlm(ref);
      this.modelRef = ref;
    }
    return this.getState();
  }

  async prompt(message: string): Promise<void> {
    if (this.running) throw new Error('agent 正在运行：先停止，或等这一轮结束');
    if (!this.llm) await this.start();

    const userMessage: AgentMessage = { role: 'user', content: message, timestamp: Date.now() };
    this.history.push(userMessage);
    this.emitEvent({ type: 'message_start', message: userMessage });
    this.emitEvent({ type: 'message_end', message: userMessage });
    void this.runLoop();
  }

  async abort(): Promise<void> {
    this.controller?.abort();
  }

  async getMessages(): Promise<AgentMessage[]> {
    return this.history.map((message) => ({ ...message }));
  }

  async getState(): Promise<SessionState> {
    return {
      model: this.llm
        ? { id: this.llm.modelId, name: this.llm.modelId, provider: this.llm.providerId, api: 'openai-compat' }
        : null,
      sessionId: this.sessionId,
      ...(this.sessionName ? { sessionName: this.sessionName } : {}),
      messageCount: this.history.length,
      isStreaming: this.running,
    };
  }

  async setModel(ref: ModelRef): Promise<{ id?: string; name?: string; provider?: string } | null> {
    if (this.running) throw new Error('运行中不能切换模型');
    this.llm = await resolveLlm(ref);
    this.modelRef = ref;
    return { id: this.llm.modelId, name: this.llm.modelId, provider: this.llm.providerId };
  }

  async rename(name: string): Promise<void> {
    this.sessionName = name;
  }

  dispose(): void {
    this.disposed = true;
    this.controller?.abort();
  }

  // ------------------------------------------------------------------ 内部

  private emitEvent(record: Record<string, unknown> & { type: string }): void {
    this.emit('event', record);
  }

  private note(text: string): void {
    this.stderrLines.push(text);
    if (this.stderrLines.length > MAX_STDERR_LINES * 2) this.stderrLines.shift();
  }

  private async runLoop(): Promise<void> {
    this.running = true;
    this.controller = new AbortController();
    this.emitEvent({ type: 'agent_start' });
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const turn = await this.runModelStep();
        this.history.push(turn.message);
        if (turn.toolCalls.length === 0) break;
        for (const call of turn.toolCalls) await this.runToolStep(call);
      }
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      const text = aborted ? '已停止' : error instanceof Error ? error.message : String(error);
      this.note(text);
      if (aborted) {
        if (this.partialText) {
          this.emitEvent({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: this.partialText }],
              stopReason: 'aborted',
              timestamp: Date.now(),
            },
          });
        }
      } else {
        const message: AgentMessage = {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: text,
          timestamp: Date.now(),
        };
        this.emitEvent({ type: 'message_start', message });
        this.emitEvent({ type: 'message_end', message });
      }
    } finally {
      this.running = false;
      this.controller = null;
      if (!this.disposed) this.emitEvent({ type: 'agent_settled' });
    }
  }

  /** 一次模型调用：把增量推出去，最后给出完整 assistant 消息与它要求的工具。 */
  private async runModelStep(): Promise<ModelTurn> {
    const llm = this.llm;
    if (!llm) throw new Error('内置 agent 还没有可用模型');

    this.partialText = '';
    this.textStarted = false;
    this.reasoningSeen = false;
    this.emitEvent({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: Date.now() } });

    const result = await streamChat({
      baseUrl: llm.baseUrl,
      apiKey: llm.apiKey,
      model: llm.modelId,
      messages: this.toChatMessages(),
      tools: this.tools,
      signal: this.controller?.signal,
      onTextDelta: (delta) => {
        const contentIndex = this.reasoningSeen ? 1 : 0;
        if (!this.textStarted) {
          this.textStarted = true;
          const start: AssistantDelta = { type: 'text_start', contentIndex };
          this.emitEvent({ type: 'message_update', assistantMessageEvent: start });
        }
        this.partialText += delta;
        const event: AssistantDelta = { type: 'text_delta', contentIndex, delta };
        this.emitEvent({ type: 'message_update', assistantMessageEvent: event });
      },
      onReasoningDelta: (delta) => {
        if (!this.reasoningSeen) {
          this.reasoningSeen = true;
          const start: AssistantDelta = { type: 'thinking_start', contentIndex: 0 };
          this.emitEvent({ type: 'message_update', assistantMessageEvent: start });
        }
        const event: AssistantDelta = { type: 'thinking_delta', contentIndex: 0, delta };
        this.emitEvent({ type: 'message_update', assistantMessageEvent: event });
      },
    });

    const content: ContentBlock[] = [];
    if (result.reasoning) content.push({ type: 'thinking', thinking: result.reasoning });
    if (result.text) content.push({ type: 'text', text: result.text });
    for (const call of result.toolCalls) {
      content.push({ type: 'toolCall', id: call.id, name: call.name, arguments: parseArguments(call.arguments) });
    }

    const message: AgentMessage = {
      role: 'assistant',
      content,
      stopReason: result.toolCalls.length > 0 ? 'toolUse' : 'stop',
      timestamp: Date.now(),
    };
    this.emitEvent({ type: 'message_end', message });
    return { message, toolCalls: result.toolCalls };
  }

  /** 跑一个工具：推 tool_execution_start/end，并把结果作为 toolResult 消息入历史。 */
  private async runToolStep(call: ChatToolCall): Promise<void> {
    const args = parseArguments(call.arguments);
    this.emitEvent({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args });
    const result = await runAgentTool(call.name, args, this.options.host);
    this.emitEvent({
      type: 'tool_execution_end',
      toolCallId: call.id,
      toolName: call.name,
      result: result.content,
      isError: result.isError === true,
      changed: result.changed ?? [],
    });

    const message: AgentMessage = {
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      isError: result.isError === true,
      content: [{ type: 'text', text: result.content }],
      timestamp: Date.now(),
    };
    this.history.push(message);
    this.emitEvent({ type: 'message_start', message });
    this.emitEvent({ type: 'message_end', message });
  }

  /** 历史 → OpenAI messages（system + user/assistant/tool）。 */
  private toChatMessages(): ChatMessage[] {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: systemPrompt(
          this.cwd,
          this.tools.map((tool) => tool.name),
          this.options.readOnly === true,
        ),
      },
    ];
    for (const message of this.history) {
      if (message.role === 'user') {
        messages.push({ role: 'user', content: messageText(message) });
        continue;
      }
      if (message.role === 'toolResult') {
        messages.push({
          role: 'tool',
          tool_call_id: typeof message.toolCallId === 'string' ? message.toolCallId : '',
          content: messageText(message),
        });
        continue;
      }
      if (message.role === 'assistant') {
        const blocks = Array.isArray(message.content) ? message.content : [];
        const calls = blocks
          .filter((block) => block.type === 'toolCall')
          .map((block) => ({
            id: block.id ?? randomUUID(),
            type: 'function' as const,
            function: { name: block.name ?? '', arguments: JSON.stringify(block.arguments ?? {}) },
          }));
        const text = blocks
          .filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('\n');
        messages.push({
          role: 'assistant',
          content: text || null,
          ...(calls.length > 0 ? { tool_calls: calls } : {}),
        });
      }
    }
    return messages;
  }
}

/** 模型偶尔给坏 JSON；保留原文，别让整轮失败。 */
function parseArguments(raw: string): Record<string, unknown> {
  const text = raw.trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { _raw: parsed };
  } catch {
    return { _raw: text };
  }
}
