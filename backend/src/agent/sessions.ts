/**
 * agent 会话表：一个会话 = 一个适配器实例 + 一份内存历史 + 一条事件订阅线。
 *
 * 刻意不做持久化：会话历史只在内存里（阅读器本身不落业务状态，重启即清）。
 * 需要长驻会话时，由适配器自己的后端负责（pi 有 session 文件，OpenHands 有 conversation）。
 */
import { randomUUID } from 'node:crypto';
import type { ProjectRegistry } from '../registry';
import { createAdapter } from './adapter';
import { fallbackModel } from './model-config';
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

    const adapter = createAdapter(backend, {
      host: { registry: this.registry, projectId: project.id, project },
      name: input.name,
      ...(ref ? { model: ref } : {}),
      ...(input.readOnly ? { readOnly: true } : {}),
    });

    const session: AgentSession = {
      id: randomUUID(),
      name: input.name?.trim() || `${project.name} · ${backend}`,
      projectId: project.id,
      backend,
      createdAt: Date.now(),
      adapter,
      alive: false,
      isStreaming: false,
      messageCount: 0,
      model: null,
      listeners: new Set(),
    };

    adapter.on('event', (event: NormalizedEvent) => {
      if (event.type === 'agent_start') session.isStreaming = true;
      if (event.type === 'agent_settled') session.isStreaming = false;
      if (event.type === 'message_end') session.messageCount += 1;
      this.emit(session, event);
    });
    adapter.on('exit', (info: AdapterExit) => {
      session.alive = false;
      session.isStreaming = false;
      session.lastError = info.message ?? `${backend} 后端已退出`;
      this.emit(session, { type: 'agent_settled' });
    });

    try {
      const state = await adapter.start();
      session.model = state.model ?? null;
      session.messageCount = state.messageCount ?? 0;
      session.alive = true;
    } catch (error) {
      adapter.dispose();
      const detail = adapter.stderrTail.slice(-3).join(' | ');
      throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? ` (${detail})` : ''}`);
    }

    this.sessions.set(session.id, session);
    return this.summary(session);
  }

  list(): AgentSessionSummary[] {
    return [...this.sessions.values()].map((session) => this.summary(session));
  }

  get(id: string): AgentAdapter | undefined {
    return this.sessions.get(id)?.adapter;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  async messages(id: string): Promise<unknown> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`会话不存在：${id}`);
    return session.adapter.getMessages();
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
    return this.summary(session);
  }

  remove(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.adapter.dispose();
    this.sessions.delete(id);
    return true;
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.adapter.dispose();
    this.sessions.clear();
  }

  private require(id: string): AgentSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`会话不存在：${id}`);
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
      ...(session.lastError ? { lastError: session.lastError } : {}),
    };
  }
}
