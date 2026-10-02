/**
 * 05 信使 Share / 形态 A：宿主 ↔ 阅读器的双向握手，以及形态 C 的退出清理。
 *
 * 收：`wcr:open`（跳转指令，本就存在）、`wcr:dispose`（宿主收起面板）
 * 发：`wcr:ready`（就绪 + 索引进度）、`wcr:state`（正在读哪 + 选区）、`wcr:bye`（资源已释放）
 *
 * 信任边界（docs/05-share.md §8 问题 6 选 B：收紧）：
 * - 只接受白名单来源的消息：同源、`?hostOrigin=` 声明的宿主源、或本机登记过的宿主源；
 * - 回发也用**具体来源**（不用 `'*'`），且只回给已被认过的那个来源；
 * - `?hostOrigin=*` 是显式的调试放开，不是默认。
 *
 * 粒度（docs/05-share.md §3 形态 A）：换文件必发、行号跟随（防抖）、选区后置。
 */
import { openProjectByRoot, suspendProjectEvents, useStore } from './state';

/** 已登记宿主来源的 localStorage 键（按浏览器，不写被读项目）。 */
const HOST_ORIGINS_KEY = 'wcr:host-origins';

export type HostMessage =
  | {
      type: 'wcr:open';
      root?: string;
      projectId?: string;
      file?: string;
      line?: number;
      col?: number;
    }
  | { type: 'wcr:dispose' };

export interface HostSelection {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  /** 选中原文（截断到 2000 字符，避免把整文件塞进消息）。 */
  text: string;
}

export interface DisposeResult {
  ok: boolean;
  error?: string;
  stoppedWatcher?: boolean;
  closedStreams?: number;
  releasedIndex?: boolean;
  /** 注册表条目保留（下次打开自动重建索引，宿主不必重新注册）。 */
  kept?: string;
}

// ------------------------------------------------------------ 来源白名单

export function readHostOrigins(): string[] {
  try {
    const raw = window.localStorage.getItem(HOST_ORIGINS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 登记一个宿主来源（宿主集成一次即可，之后每轮都认）。 */
export function rememberHostOrigin(origin: string): void {
  if (!origin) return;
  const next = [...new Set([...readHostOrigins(), origin])];
  try {
    window.localStorage.setItem(HOST_ORIGINS_KEY, JSON.stringify(next));
  } catch {
    /* 记不住就退回 URL 参数方式 */
  }
}

/** 允许的来源：同源 + URL `?hostOrigin=` + 登记过的；`*` 是显式放开。 */
export function allowedHostOrigins(search: string = window.location.search): string[] {
  const fromQuery = (new URLSearchParams(search).get('hostOrigin') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const all = new Set<string>([window.location.origin, ...readHostOrigins(), ...fromQuery]);
  return [...all];
}

/** 最近一次被认过的宿主来源：回发只认它，避免把状态发给未知窗口。 */
let lastHostOrigin: string | null = null;

/** 回发目标：白名单里第一个「不是本页」的来源；都没有就用最近认过的那个。 */
function sendTargetOrigin(): string | null {
  if (typeof window === 'undefined' || window.parent === window) return null;
  const allowed = allowedHostOrigins();
  const external = allowed.filter((o) => o !== '*' && o !== window.location.origin);
  if (external.length > 0) return external[0];
  if (lastHostOrigin) return lastHostOrigin;
  // 同源 iframe：只登记了本页来源时，回给自己所在的源是安全的
  if (allowed.includes(window.location.origin)) return window.location.origin;
  return null;
}

function postToHost(message: Record<string, unknown>): void {
  const target = sendTargetOrigin();
  if (!target) return;
  try {
    window.parent.postMessage(message, target);
  } catch {
    /* 目标源不合法（理论上不会）：不因为回发失败打断阅读 */
  }
}

// ------------------------------------------------------------ 回发（S7）

let caret = { file: null as string | null, line: 1, col: 1 };
let selection: HostSelection | undefined;
let stateTimer: number | null = null;
let lastFile: string | null = null;
let lastReadyKey = '';

function buildStateMessage() {
  return {
    type: 'wcr:state',
    projectId: useStore.getState().projectId,
    file: caret.file,
    line: caret.line,
    col: caret.col,
    ...(selection ? { selection } : {}),
  };
}

/**
 * 发状态：换文件立即发（宿主的面包屑要跟手），光标 / 选区防抖发（噪声大）。
 * 行程 A 的粒度约定：行号跟随、选区后置。
 */
function scheduleState(immediate = false): void {
  if (stateTimer != null) {
    window.clearTimeout(stateTimer);
    stateTimer = null;
  }
  if (immediate) {
    postToHost(buildStateMessage());
    return;
  }
  stateTimer = window.setTimeout(() => {
    stateTimer = null;
    postToHost(buildStateMessage());
  }, 250);
}

/**
 * 编辑器每次光标 / 选区变化都调它（S7a / S7b）。
 * 由 Editor 直接调用，不经 React state —— 光标是高频事件，不该触发重渲染。
 */
export function reportCaret(info: {
  file: string | null;
  line: number;
  col: number;
  selection?: HostSelection;
}): void {
  caret = { file: info.file, line: info.line, col: info.col };
  selection = info.selection;
  scheduleState(false);
}

// ------------------------------------------------------------ 收消息

let warnedOrigin: string | null = null;

function onMessage(event: MessageEvent): void {
  const data = event.data as HostMessage | undefined;
  if (!data || typeof data !== 'object') return;
  if (data.type !== 'wcr:open' && data.type !== 'wcr:dispose') return;

  const allowed = allowedHostOrigins();
  if (!allowed.includes('*') && !allowed.includes(event.origin)) {
    if (warnedOrigin !== event.origin) {
      warnedOrigin = event.origin;
      // 不弹错：嵌入方看控制台即可，读者不该被打断
      console.warn(
        `[信使] 忽略了来源 ${event.origin} 的消息（信任边界已收紧）。` +
          '宿主请在 iframe URL 上加 ?hostOrigin=<宿主源>，或在阅读器里登记该来源。',
      );
    }
    return;
  }
  lastHostOrigin = event.origin;

  if (data.type === 'wcr:dispose') {
    void handleDispose();
    return;
  }

  if (data.projectId) {
    void useStore.getState().selectProject(data.projectId).then(() => {
      if (data.file) void useStore.getState().openFileAt(data.file, data.line, data.col);
    });
  } else if (data.root) {
    void openProjectByRoot(data.root, data.file, data.line, data.col);
  }
}

/**
 * S9c：宿主收起面板 —— 关 SSE / watcher，释放内存索引，但不注销项目、不碰磁盘。
 * 释放后如果宿主又把面板拉起来（同一个 iframe 继续用），下一次 wcr:open 会重新订阅事件。
 */
async function handleDispose(): Promise<void> {
  const projectId = useStore.getState().projectId;
  const result = await disposeProject(projectId);
  postToHost({ type: 'wcr:bye', projectId, ...result });
}

/** 调用后端释放端点；失败也照实回报（宿主据此决定要不要提示用户）。 */
export async function disposeProject(projectId: string | null): Promise<DisposeResult> {
  if (!projectId) return { ok: false, error: '当前没有打开的项目' };
  // 本地先断开自己的 SSE：即使后端不可达，也不留一个空转的连接
  suspendProjectEvents();
  try {
    const res = await fetch(`/api/projects/${projectId}/dispose`, { method: 'POST' });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: String(body.message ?? body.error ?? `${res.status}`) };
    }
    return { ok: true, ...body };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ------------------------------------------------------------ 装配

/** 挂上双向桥（App 启动时调一次）。返回卸载函数，便于测试与热更新。 */
export function initHostBridge(): () => void {
  window.addEventListener('message', onMessage);
  lastFile = useStore.getState().openFile;
  caret = { file: lastFile, line: 1, col: 1 };

  const unsubscribe = useStore.subscribe((state, prev) => {
    // 就绪 + 索引进度（宿主用它显示「索引中 N%」/「已就绪」）
    const readyKey = `${state.projectId}|${state.status?.indexing ?? ''}|${state.status?.indexedAt ?? ''}|${state.status?.filesIndexed ?? ''}`;
    if (readyKey !== lastReadyKey) {
      lastReadyKey = readyKey;
      if (state.projectId) {
        postToHost({
          type: 'wcr:ready',
          projectId: state.projectId,
          projectName: state.project?.name ?? null,
          status: state.status
            ? {
                indexing: state.status.indexing,
                filesIndexed: state.status.filesIndexed,
                filesTotal: state.status.filesTotal,
                indexedAt: state.status.indexedAt ?? null,
              }
            : null,
        });
      }
    }
    // 换文件必发（行号跟随交给 reportCaret 的防抖通道）
    if (state.openFile !== prev.openFile) {
      lastFile = state.openFile;
      caret = { file: state.openFile, line: state.openFile ? caret.line : 1, col: caret.col };
      scheduleState(true);
    }
  });

  return () => {
    window.removeEventListener('message', onMessage);
    unsubscribe();
    if (stateTimer != null) window.clearTimeout(stateTimer);
  };
}
