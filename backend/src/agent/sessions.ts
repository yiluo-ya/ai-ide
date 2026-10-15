/**
 * agent 会话表：一个会话 = 一个适配器实例 + 一份历史 + 一条事件订阅线。
 *
 * FR-0013（2026-10-15）起**会话记录落盘**：`<DATA_DIR>/sessions/<projectId>/<sessionId>.json`
 * 存元数据与内置 agent 的消息；pi 的历史由 pi 自己写进同目录的 `pi/` 下。
 * 进程重启后 `list()` 会把磁盘上的记录一并列出（标 `persisted`），点开时 `resume()` 重建适配器：
 * pi 靠 `--session-id` 认领自己的会话文件，内置 agent 靠回填消息 —— 两边都能接着聊。
 *
 * 适配器实例本身仍是内存态（进程退出即释放），落盘的只是「会话记录」。
 */
import { randomUUID } from 'node:crypto';
import type { ProjectRegistry } from '../registry';
import { createAdapter } from './adapter';
import { fallbackModel } from './model-config';
import { isPiNotFound } from './runtime';
import {
  findStored,
  listStored,
  piSessionDir,
  removeSession,
  writeSession,
  type StoredSession,
} from './session-store';
import { type AdapterExit, type AgentAdapter, type BackendKind, type NormalizedEvent } from './types';

/** 会话摘要（发给前端）。 */
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
  /** 适配器已在本进程里（false = 只在磁盘上，点开才 resume；FR-0013）。 */
  loaded: boolean;
  lastError?: string;
}

export interface CreateSessionInput {
  projectId: string;
  name?: string;
  backend?: BackendKind;
  provider?: string;
  modelId?: string;
  /** 只读会话（FR-0005 命令分析用）：不给写文件工具。 */
  readOnly?: boolean;
}

interface AgentSession {
  id: string;
  name: string;
  projectId: string;
  backend: BackendKind;
  createdAt: number;
  adapter: AgentAdapter;
  alive: boolean;
  isStreaming: boolean;
  messageCount: number;
  model: { id?: string; name?: string; provider?: string } | null;
  lastError?: string;
  /**
   * 落盘串行链：同一会话的多次写盘排队。
   * 一条消息一次写盘（user / assistant 各一次），并发写会交错 —— 实测出现过
   * 「后一次写的内容先落、前一次的反而最后落地」，记录里少一条消息。
   */
  persistChain?: Promise<void>;
  listeners: Set<(event: NormalizedEvent) => void>;
}

/** 事件订阅：SSE 端点用它把 adapter 的事件推给浏览器。 */
export type SessionListener = (event: NormalizedEvent) => void;

export class AgentSessions {
  private readonly sessions = new Map<string, AgentSession>();

  constructor(private readonly registry: ProjectRegistry) {}

  async create(input: CreateSessionInput): Promise<AgentSessionSummary> {
    const project = this.registry.get(input.projectId);
    if (!project) throw new Error(`项目不存在：${input.projectId}`);

    const backend: BackendKind = input.backend ?? 'builtin';
    // 会话没选模型时用默认模型；一个都没配就交给适配器去报错（信息更具体）。
    const ref =
      input.provider && input.modelId ? { provider: input.provider, modelId: input.modelId } : await fallbackModel();

    const id = randomUUID();
    const session: AgentSession = {
      id,
      name: input.name?.trim() || `${project.name} · ${backend}`,
      projectId: project.id,
      backend,
      createdAt: Date.now(),
      adapter: createAdapter(backend, {
        host: { registry: this.registry, projectId: project.id, project },
        name: input.name,
        ...(ref ? { model: ref } : {}),
        ...(input.readOnly ? { readOnly: true } : {}),
        agentSession: { id, dir: piSessionDir(project.id) },
      }),
      alive: false,
      isStreaming: false,
      messageCount: 0,
      model: null,
      listeners: new Set(),
    };

    return this.launch(session);
  }

  /**
   * 列出会话：内存里的（活着或刚建过）+ 磁盘上有记录但当前进程没载入的。
   * 后者标 `persisted`，点开时由 `resume()` 拉起来。
   */
  async list(): Promise<AgentSessionSummary[]> {
    const live = [...this.sessions.values()].map((session) => this.summary(session));
    const ids = new Set(this.sessions.keys());
    const archived = (await listStored())
      .filter((record) => !ids.has(record.id))
      .map((record) => this.archivedSummary(record));
    return [...live, ...archived];
  }

  get(id: string): AgentAdapter | undefined {
    return this.sessions.get(id)?.adapter;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  /** 会话是否已载入本进程（`resume()` 用；未载入时消息要从磁盘读）。 */
  private loaded(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  async messages(id: string): Promise<unknown> {
    const session = this.loaded(id);
    if (session) return session.adapter.getMessages();
    const record = await findStored(id);
    if (!record) throw new Error(`会话不存在：${id}`);
    // pi 的消息在它自己的会话文件里，未 resume 时先给空（界面会先 resume 再取）
    return record.messages ?? [];
  }

  /**
   * 续传（FR-0013）：内存里没有就用磁盘记录重建适配器并启动。
   * 幂等 —— 已经在跑就直接返回摘要，前端可以放心每次选中都调一次。
   */
  async resume(id: string): Promise<AgentSessionSummary> {
    const session = this.loaded(id);
    if (session) {
      if (!session.alive) await this.restart(session);
      return this.summary(session);
    }
    const record = await findStored(id);
    if (!record) throw new Error(`会话不存在：${id}`);
    return this.launch(await this.revive(record));
  }

  async refresh(id: string): Promise<AgentSessionSummary> {
    const session = this.require(id);
    const state = await session.adapter.getState();
    session.model = state.model ?? session.model;
    session.messageCount = state.messageCount ?? session.messageCount;
    if (state.isStreaming !== undefined) session.isStreaming = state.isStreaming;
    return this.summary(session);
  }

  /** 订阅事件：返回退订函数。订阅瞬间补一发当前状态，前端不必额外拉一次。 */
  subscribe(id: string, listener: SessionListener): () => void {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`会话不存在：${id}`);
    session.listeners.add(listener);
    listener({ type: 'session_state', state: this.summary(session) });
    return () => session.listeners.delete(listener);
  }

  async rename(id: string, name: string): Promise<AgentSessionSummary> {
    const session = this.require(id);
    await session.adapter.rename(name);
    session.name = name;
    await this.persist(session);
    return this.summary(session);
  }

  async remove(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (session) {
      session.adapter.dispose();
      this.sessions.delete(id);
    }
    // 记录（含 pi 的会话文件）一并删掉 —— 不留孤儿
    const record = await findStored(id);
    if (record) await removeSession(record.projectId, id);
    return Boolean(session) || Boolean(record);
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.adapter.dispose();
    this.sessions.clear();
  }

  // ------------------------------------------------------------------ 内部

  /** 起一个会话（新建 / 续传共用）：接线 → start → 落盘。失败时按错误类型上抛。 */
  private async launch(session: AgentSession): Promise<AgentSessionSummary> {
    session.adapter.on('event', (event: NormalizedEvent) => {
      if (event.type === 'agent_start') session.isStreaming = true;
      if (event.type === 'agent_settled') {
        session.isStreaming = false;
        // 整轮结束再落一次：内置 agent 是「先发 message_end、后把助手消息入历史」
        // （`runLoop` 里 push 在 emit 之后），逐条写会漏掉最后一条助手消息。
        void this.persist(session);
      }
      if (event.type === 'message_end') {
        session.messageCount += 1;
        void this.persist(session); // 消息落盘（失败不影响对话）
      }
      this.emit(session, event);
    });
    session.adapter.on('exit', (info: AdapterExit) => {
      session.alive = false;
      session.isStreaming = false;
      session.lastError = info.message ?? `${session.backend} 后端已退出`;
      this.emit(session, { type: 'agent_settled' });
    });

    await this.start(session);
    this.sessions.set(session.id, session);
    await this.persist(session);
    return this.summary(session);
  }

  /** 已经在内存里但已退出（pi 进程挂了）：按原记录重起一次。 */
  private async restart(session: AgentSession): Promise<void> {
    session.lastError = undefined;
    await this.start(session);
  }

  private async start(session: AgentSession): Promise<void> {
    try {
      const state = await session.adapter.start();
      session.model = state.model ?? null;
      session.messageCount = state.messageCount ?? session.messageCount;
      session.alive = true;
      session.isStreaming = state.isStreaming ?? false;
    } catch (error) {
      session.adapter.dispose();
      // 「压根没装 pi」原样上抛：路由要按 code 翻成带安装命令的结构化响应（FR-0013 需求 3）
      if (isPiNotFound(error)) throw error;
      const detail = session.adapter.stderrTail.slice(-3).join(' | ');
      throw new Error(`${message(error)}${detail ? ` (${detail})` : ''}`);
    }
  }

  /** 磁盘记录 → 可启动的会话（pi 认领自己的会话文件，内置 agent 回填消息）。 */
  private async revive(record: StoredSession): Promise<AgentSession> {
    const project = this.registry.get(record.projectId);
    if (!project) throw new Error(`项目已不在：${record.name}（会话记录 ${record.id}）`);
    const ref =
      record.provider && record.modelId
        ? { provider: record.provider, modelId: record.modelId }
        : await fallbackModel();
    return {
      id: record.id,
      name: record.name,
      projectId: record.projectId,
      backend: record.backend,
      createdAt: record.createdAt,
      adapter: createAdapter(record.backend, {
        host: { registry: this.registry, projectId: project.id, project },
        name: record.name,
        ...(ref ? { model: ref } : {}),
        agentSession: { id: record.id, dir: piSessionDir(record.projectId) },
        ...(record.messages?.length ? { messages: record.messages } : {}),
      }),
      alive: false,
      isStreaming: false,
      messageCount: record.messageCount,
      model: null,
      listeners: new Set(),
    };
  }

  /** 把会话现状写进磁盘记录（同一会话串行；失败不影响对话）。 */
  private persist(session: AgentSession): Promise<void> {
    const run = () => this.persistNow(session);
    const chain = (session.persistChain ?? Promise.resolve()).then(run, run);
    // 链上尾巴总是 resolve：一次失败不会把后面的写盘全挡掉
    session.persistChain = chain.catch(() => {});
    return chain;
  }

  /** 内置 agent 连消息一起写；pi 只写元数据（历史在 pi 自己的会话文件里）。 */
  private async persistNow(session: AgentSession): Promise<void> {
    try {
      const messages = session.backend === 'builtin' ? await session.adapter.getMessages() : undefined;
      const record: StoredSession = {
        version: 1,
        id: session.id,
        name: session.name,
        projectId: session.projectId,
        backend: session.backend,
        createdAt: session.createdAt,
        updatedAt: Date.now(),
        ...(session.model?.provider ? { provider: session.model.provider } : {}),
        ...(session.model?.id ? { modelId: session.model.id } : {}),
        messageCount: session.messageCount,
        ...(messages ? { messages } : {}),
      };
      await writeSession(record);
    } catch {
      // 落盘失败不影响对话本身（只影响下次重启能不能列出这条会话）
    }
  }

  private require(id: string): AgentSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`会话未载入：${id}（先 resume 或重新打开）`);
    return session;
  }

  private emit(session: AgentSession, event: NormalizedEvent): void {
    for (const listener of session.listeners) listener(event);
  }

  private summary(session: AgentSession): AgentSessionSummary {
    const project = this.registry.get(session.projectId);
    return {
      id: session.id,
      name: session.name,
      projectId: session.projectId,
      projectName: project?.name ?? '(已移除)',
      projectRoot: project?.root ?? '',
      backend: session.backend,
      createdAt: session.createdAt,
      alive: session.alive,
      isStreaming: session.isStreaming,
      messageCount: session.messageCount,
      model: session.model,
      loaded: true,
      ...(session.lastError ? { lastError: session.lastError } : {}),
    };
  }

  /** 磁盘上有、内存里没有的记录：只能看，点开才 resume。 */
  private archivedSummary(record: StoredSession): AgentSessionSummary {
    const project = this.registry.get(record.projectId);
    return {
      id: record.id,
      name: record.name,
      projectId: record.projectId,
      projectName: project?.name ?? '(已移除)',
      projectRoot: project?.root ?? '',
      backend: record.backend,
      createdAt: record.createdAt,
      alive: false,
      isStreaming: false,
      messageCount: record.messageCount,
      model: record.provider && record.modelId ? { provider: record.provider, id: record.modelId } : null,
      loaded: false,
    };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
