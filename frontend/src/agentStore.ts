/**
 * Code Agent 的界面状态（2026-10-03 用户要求把会话摊进主界面：左栏管会话、中间看内容）。
 *
 * 为什么单独一个 store：会话列表（左栏）与对话内容（中间）是两个组件，状态得共享；
 * 事件订阅也只能有一份（按当前会话订阅，切会话就换）—— 放在组件里会重复订阅。
 *
 * 与项目自身的 `state.ts` 分开：agent 是附加能力，不参与阅读器的核心状态与快照。
 */
import { create } from 'zustand';
import {
  agentApi,
  applyAssistantDelta,
  subscribeAgentEvents,
  type AgentEvent,
  type AgentMessage,
  type AgentSessionSummary,
  type BackendKind,
  type ModelConfigPublic,
} from './agentApi';
import { translate } from './i18n';

/** 当前会话的事件流订阅；切会话时换掉（模块级，保证只有一份）。 */
let unsubscribe: (() => void) | null = null;

interface AgentStore {
  config: ModelConfigPublic | null;
  /** 所有项目的会话（左栏只显示当前项目的）。 */
  sessions: AgentSessionSummary[];
  activeId: string | null;
  messages: AgentMessage[];
  /** 正在流式生成的那条 assistant 消息。 */
  live: AgentMessage | null;
  /** 「正在改文件：src/x.ts」这类即时提示。 */
  toolNote: string | null;
  busy: boolean;
  loading: boolean;
  error: string | null;

  init: (projectId: string) => Promise<void>;
  refreshConfig: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  create: (projectId: string, backend: BackendKind, provider?: string, modelId?: string) => Promise<void>;
  select: (sessionId: string | null) => Promise<void>;
  remove: (sessionId: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  stop: () => Promise<void>;
  setModel: (provider: string, modelId: string) => Promise<void>;
  setError: (error: string | null) => void;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useAgent = create<AgentStore>((set, get) => ({
  config: null,
  sessions: [],
  activeId: null,
  messages: [],
  live: null,
  toolNote: null,
  busy: false,
  loading: false,
  error: null,

  init: async (projectId) => {
    set({ loading: true, error: null });
    try {
      await get().refreshConfig();
      const list = await agentApi.sessions();
      set({ sessions: list });
      const mine = list.filter((s) => s.projectId === projectId);
      const current = get().activeId;
      const keep = current && mine.some((s) => s.id === current) ? current : (mine[mine.length - 1]?.id ?? null);
      await get().select(keep);
    } catch (e) {
      set({ error: errText(e) });
    } finally {
      set({ loading: false });
    }
  },

  refreshConfig: async () => {
    set({ config: await agentApi.modelConfig() });
  },

  refreshSessions: async () => {
    const list = await agentApi.sessions();
    set({ sessions: list });
  },

  create: async (projectId, backend, provider, modelId) => {
    set({ error: null });
    try {
      const session = await agentApi.createSession({
        projectId,
        backend,
        ...(provider && modelId ? { provider, modelId } : {}),
      });
      set((s) => ({ sessions: [...s.sessions, session] }));
      await get().select(session.id);
    } catch (e) {
      set({ error: errText(e) });
      throw e;
    }
  },

  select: async (sessionId) => {
    unsubscribe?.();
    unsubscribe = null;
    set({ activeId: sessionId, messages: [], live: null, toolNote: null, busy: false, error: null });
    if (!sessionId) return;

    try {
      const messages = await agentApi.messages(sessionId);
      if (get().activeId !== sessionId) return; // 期间又切走了
      set({ messages });
    } catch (e) {
      set({ error: errText(e) });
    }

    unsubscribe = subscribeAgentEvents(sessionId, (event: AgentEvent) => {
      const state = get();
      if (state.activeId !== sessionId) return;
      applyEvent(event, set, get);
    });
  },

  remove: async (sessionId) => {
    try {
      await agentApi.deleteSession(sessionId);
      const rest = get().sessions.filter((s) => s.id !== sessionId);
      set({ sessions: rest });
      if (get().activeId === sessionId) await get().select(rest[rest.length - 1]?.id ?? null);
    } catch (e) {
      set({ error: errText(e) });
    }
  },

  send: async (text) => {
    const id = get().activeId;
    if (!id || !text.trim()) return;
    set({ error: null });
    try {
      await agentApi.prompt(id, text);
    } catch (e) {
      set({ error: errText(e) });
    }
  },

  stop: async () => {
    const id = get().activeId;
    if (!id) return;
    try {
      await agentApi.abort(id);
    } catch (e) {
      set({ error: errText(e) });
    }
  },

  setModel: async (provider, modelId) => {
    const id = get().activeId;
    if (!id) return;
    try {
      const res = await agentApi.setSessionModel(id, provider, modelId);
      set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? res.session : x)) }));
    } catch (e) {
      set({ error: errText(e) });
    }
  },

  setError: (error) => set({ error }),
}));

/** 把一条归一化事件落进界面状态。 */
function applyEvent(
  event: AgentEvent,
  set: (partial: Partial<AgentStore> | ((s: AgentStore) => Partial<AgentStore>)) => void,
  get: () => AgentStore,
): void {
  switch (event.type) {
    case 'message_start': {
      const message = event.message as AgentMessage | undefined;
      if (message?.role === 'assistant') set({ live: message });
      return;
    }
    case 'message_update': {
      const delta = event.assistantMessageEvent as Record<string, unknown> | undefined;
      if (!delta) return;
      set((s) => ({ live: applyAssistantDelta(s.live ?? { role: 'assistant', content: [] }, delta) }));
      return;
    }
    case 'message_end': {
      const message = event.message as AgentMessage | undefined;
      if (!message) return;
      set((s) => ({
        messages: [...s.messages, message],
        ...(message.role === 'assistant' ? { live: null } : {}),
      }));
      return;
    }
    case 'agent_start':
      set({ busy: true });
      return;
    case 'agent_settled':
      set({ busy: false, toolNote: null, live: null });
      // 会话的 messageCount / alive 变了，顺手刷新列表（失败不影响对话）
      void get()
        .refreshSessions()
        .catch(() => {});
      return;
    case 'tool_execution_start':
      set({ toolNote: translate('agent.toolRunning', { what: `${toolLabel(event.toolName)}${summarizeArgs(event.args)}` }) });
      return;
    case 'tool_execution_end':
      set({ toolNote: null });
      return;
    case 'session_state': {
      const state = event.state as AgentSessionSummary | undefined;
      if (state) {
        set((s) => ({ sessions: s.sessions.map((x) => (x.id === state.id ? { ...x, ...state } : x)) }));
      }
      return;
    }
    default:
      return;
  }
}

/** 工具名 → 中文动作（只影响显示）。 */
export const TOOL_LABEL: Record<string, string> = {
  read_file: 'agent.toolReadFile',
  write_file: 'agent.toolWriteFile',
  edit_file: 'agent.toolEditFile',
  list_dir: 'agent.toolListDir',
  glob: 'agent.toolGlob',
  grep: 'agent.toolGrep',
  find_symbol: 'agent.toolFindSymbol',
  goto_definition: 'agent.toolGotoDefinition',
  find_references: 'agent.toolFindReferences',
  file_outline: 'agent.toolFileOutline',
  search_text: 'agent.toolSearchText',
};

export function toolLabel(name: unknown): string {
  const key = String(name ?? '');
  return TOOL_LABEL[key] ? translate(TOOL_LABEL[key]) : (key || translate('agent.tool'));
}

/** 工具参数里最有信息量的一项，接在「正在…」后面。 */
export function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const record = args as Record<string, unknown>;
  for (const key of ['path', 'file', 'pattern', 'name', 'query']) {
    const value = record[key];
    if (typeof value === 'string' && value) return translate('agent.argsSep', { value });
  }
  return '';
}

/** 后端类型显示名。 */
export const BACKEND_LABEL: Record<string, string> = {
  builtin: 'agent.backendBuiltin',
  pi: 'agent.backendPi',
  openhands: 'agent.backendOpenhands',
};
