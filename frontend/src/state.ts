/** 全局状态（zustand）：项目 / 文件树 / 当前文件 / 符号 / 搜索 / 定位请求。 */
import { create } from 'zustand';
import type {
  CallDirection,
  CallHierarchyResult,
  ExternalSource,
  FileNode,
  ImplementationsResult,
  IndexStatus,
  Location,
  ProjectInfo,
  ReferenceLocation,
  SymbolInfo,
  TypeHierarchyResult,
} from './api';
import { api, subscribeEvents } from './api';
import { setRead as setReadMark } from './marks';
import { useGuideStore } from './guideState';
import { translate } from './i18n';
import { flushSnapshot, scheduleSnapshotWrite } from './readSnapshot';
import { formatLineRange, formatSnippet, type SnippetInput } from './share';

export interface RevealRequest {
  file: string;
  line: number;
  col: number;
  endLine?: number;
  endCol?: number;
  /** 自增 token：同一位置重复跳转也能触发 effect。 */
  token: number;
  /** N22：无显式行号时恢复上次的滚动位置。 */
  scrollTop?: number;
  /**
   * G7.5：历史版本的正文（只在内存里）。带上它就表示第二窗格开的是
   * `wcr-history://` 的只读快照，不是磁盘上的真实文件（见 `openSecondaryText`）。
   */
  text?: string;
  /** 历史版本正文的语言 id（来自 `git-show` 调用方按扩展名推断）。 */
  lang?: string;
  /** 历史版本对应的提交（短哈希原样展示）。 */
  rev?: string;
}

export interface SearchHit {
  file: string;
  /** 该文件是测试文件（N11 过滤用，后端标注）。 */
  isTest?: boolean;
  matches: Array<{ line: number; col: number; endCol: number; lineText: string }>;
}

/** 打开过的标签（N19）：上限 8，同文件合并、LRU 淘汰。 */
export interface TabInfo {
  file: string;
  line: number;
  col: number;
}

/** 位置记忆（N22）：每文件的光标 / 滚动位置。 */
export interface MemoryPosition {
  line: number;
  col: number;
  scrollTop: number;
}

/** 常驻引用面板的数据（N4）。 */
export interface RefsState {
  symbol: string | null;
  reason: 'resolved' | 'external' | 'unresolved' | 'no-symbol';
  locations: ReferenceLocation[];
  declaration: Location | null;
  /** 发起查询时的光标位置（面板里标「← 光标」）。 */
  origin: { file: string; line: number; col: number };
  /**
   * 家族：这个符号在继承体系里的位置（来自类型层级）。
   * 引用列表只回答「谁提到它」；家族回答「它继承谁、谁继承了它」—— 两者合起来才看得出结构。
   */
  family?: TypeHierarchyResult | null;
}

/**
 * 「没有跳转」时给用户的一句话 + 可点动作（03-navigator §3.1 / 决策 D1）。
 * reason 三态对应三种人话：external=不是你的代码；unresolved=工具认不出类型；
 * no-symbol=光标处本身没有符号。
 */
export interface GotoNotice {
  kind: 'definition' | 'references';
  reason: 'external' | 'unresolved' | 'no-symbol' | 'indexing';
  /** 命中的符号名；no-symbol 时为 null。 */
  symbol: string | null;
  /** 可直接展示的人话。 */
  message: string;
  /** reason=external 时的来源详情（Q1）：模块名与 import 位置。 */
  external?: ExternalSource;
}

/** 右下角冒泡（命令结果 / 一键动作的反馈）：只有一句话 + 成功失败两态。 */
export interface RunToast {
  id: number;
  text: string;
  ok: boolean;
}

interface State {
  ready: boolean;
  projects: ProjectInfo[];
  projectId: string | null;
  project: ProjectInfo | null;
  status: IndexStatus | null;
  tree: FileNode | null;
  openFile: string | null;
  fileLang: string;
  fileContent: string;
  fileLoading: boolean;
  symbols: SymbolInfo[];
  searchHits: SearchHit[];
  searchBusy: boolean;
  searchTruncated: boolean;
  /** 常驻引用面板（N4）。 */
  references: RefsState | null;
  referencesBusy: boolean;
  /** 调用层级（N16）。 */
  calls: CallHierarchyResult | null;
  callsBusy: boolean;
  callDirection: CallDirection;
  callDepth: number;
  /** 类型层级（N17）。 */
  types: TypeHierarchyResult | null;
  typesBusy: boolean;
  /** 实现清单（N15）。 */
  impls: ImplementationsResult | null;
  implsBusy: boolean;
  /** 搜索历史（N13，本机持久化）。 */
  searchHistory: string[];
  /** 搜索范围：选中的目录（N14）。 */
  searchDirs: string[];
  /** 状态栏轻提示（判据 6：复制位置后的反馈；几秒后自动消失）。 */
  flash: string | null;
  /** 标签页（N19）。 */
  tabs: TabInfo[];
  /** 分屏（N19）：第二窗格；null = 单栏。 */
  secondary: RevealRequest | null;
  /** 位置记忆（N22，本机持久化）：file → 位置。 */
  positions: Record<string, MemoryPosition>;
  error: string | null;
  reveal: RevealRequest | null;
  notice: GotoNotice | null;
  /** 右下角冒泡（2026-10-03：变更栏的 git 命令结果用）；几秒后自动消失。 */
  toast: RunToast | null;
  history: Array<{ file: string; line: number; col: number }>;
  historyIndex: number;

  highlightsToken: number;

  init: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  selectProject: (id: string) => Promise<void>;
  openFolder: (root: string, name?: string) => Promise<void>;
  forgetProject: (id: string) => Promise<void>;
  reindex: () => Promise<void>;
  loadTree: () => Promise<void>;
  openFileAt: (file: string, line?: number, col?: number, endLine?: number, endCol?: number) => Promise<void>;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  refreshSymbols: () => Promise<void>;
  runSearch: (query: string, options: Record<string, unknown>) => Promise<void>;
  clearSearch: () => void;
  loadReferences: (file: string, line: number, col: number) => Promise<void>;
  loadCalls: (file: string, line: number, col: number) => Promise<void>;
  setCallDirection: (direction: CallDirection) => void;
  setCallDepth: (depth: number) => void;
  loadTypes: (file: string, line: number, col: number) => Promise<void>;
  loadImpls: (file: string, line: number, col: number) => Promise<void>;
  cancelSearch: () => void;
  setSearchDirs: (dirs: string[]) => void;
  /** N19：在旁边打开（分屏）。 */
  openInSecondary: (file: string, line?: number, col?: number) => Promise<void>;
  /** G7.5：在第二窗格打开一段内存里的历史版本（不读盘、不落盘、不进最近打开与位置记忆）。 */
  openSecondaryText: (file: string, text: string, lang: string, rev: string) => void;
  closeSecondary: () => void;
  closeTab: (file: string) => void;
  /** N22：记录某文件的光标与滚动位置。 */
  rememberPosition: (file: string, position: MemoryPosition) => void;
  /** 判据 6：复制 `path:line:col` 到剪贴板，并在状态栏轻提示。 */
  copyLocation: (file: string, line: number, col: number) => void;
  /** S3a：把选中的一段代码连同出处（`path:行范围` + 围栏语言）复制走。 */
  copySnippet: (input: Omit<SnippetInput, 'file' | 'lang'> & { file?: string; lang?: string }) => void;
  setError: (message: string | null) => void;
  showNotice: (notice: GotoNotice) => void;
  dismissNotice: () => void;
}

let unsubscribeEvents: (() => void) | null = null;
/** 历史导航自身触发的 openFile 不再压入历史（避免自激）。 */
let suppressHistory = false;
const HISTORY_LIMIT = 300;
/** N19：标签页上限（Q5：上限 8 + LRU 淘汰 + 同文件合并）。 */
const TAB_LIMIT = 8;
/** 状态栏轻提示的定时器（判据 6：复制位置后的反馈）。 */
let flashTimer: number | null = null;

/** 状态栏轻提示：几秒后自动消失（不占对话框、不需用户点确认）。 */
export function showFlash(text: string) {
  if (flashTimer != null) window.clearTimeout(flashTimer);
  useStore.setState({ flash: text });
  flashTimer = window.setTimeout(() => {
    useStore.setState({ flash: null });
    flashTimer = null;
  }, 3000);
}

let toastTimer: number | null = null;
let toastSeq = 0;

/**
 * 右下角冒泡：说一句结果，几秒后自己消失（命令类操作不需要用户点关闭）。
 * 传 null 表示立刻收起；同一时刻只留一条（新的顶掉旧的）。
 */
export function showToast(text: string | null, ok = true) {
  if (toastTimer != null) window.clearTimeout(toastTimer);
  if (text === null) {
    toastTimer = null;
    useStore.setState({ toast: null });
    return;
  }
  const id = (toastSeq += 1);
  useStore.setState({ toast: { id, text, ok } });
  toastTimer = window.setTimeout(() => {
    if (useStore.getState().toast?.id === id) useStore.setState({ toast: null });
    toastTimer = null;
  }, 4000);
}
/** N12：正在进行的搜索请求（新一次搜索 / 停止按钮会中止它）。 */
let searchAbort: AbortController | null = null;

// -------------------------------------------- 本机持久化（N13 / Q4：不写被读目录）

const SEARCH_HISTORY_LIMIT = 20;

function searchHistoryKey(projectId: string): string {
  return `wcr:search-history:${projectId}`;
}

/** 读搜索历史（N13）：只存本机 localStorage，按项目隔离。 */
export function readSearchHistory(projectId: string | null): string[] {
  if (!projectId) return [];
  try {
    const raw = window.localStorage.getItem(searchHistoryKey(projectId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function rememberSearch(projectId: string, query: string) {
  const next = [query, ...readSearchHistory(projectId).filter((q) => q !== query)].slice(
    0,
    SEARCH_HISTORY_LIMIT,
  );
  try {
    window.localStorage.setItem(searchHistoryKey(projectId), JSON.stringify(next));
  } catch {
    /* 隐私模式 / 配额满：不因为记不住历史而打断搜索 */
  }
}

// ---------------------------------- 位置记忆（N22）/ 书签（N20）（Q4：本机持久化）

/** 位置记忆上限（按项目分片，Q4 风险兜底）。 */
const POSITION_LIMIT = 200;

/**
 * 把「光标所在行」解析成「一个具体符号的位置」。
 * 光标常停在行首 / 空白处，此时后端只能答 no-symbol；
 * 这里用当前文件的符号树就近吸附：先找包含光标的符号，再找该行上的第一个符号。
 * 不猜语义，只是把「你正看着哪一行」翻译成「这行的哪个符号」。
 */
function snapToSymbol(
  symbols: SymbolInfo[],
  line: number,
  col: number,
): { line: number; col: number } {
  const flat: SymbolInfo[] = [];
  const walk = (list: SymbolInfo[]) => {
    for (const s of list) {
      flat.push(s);
      if (s.children?.length) walk(s.children);
    }
  };
  walk(symbols);
  const inside = flat.filter((s) => {
    const r = s.range ?? s.location.range;
    if (line < r.start.line || line > r.end.line) return false;
    if (line === r.start.line && col < r.start.col) return false;
    if (line === r.end.line && col > r.end.col) return false;
    return true;
  });
  if (inside.length) {
    // 最内层：声明结束得最早的那个
    const span = (s: SymbolInfo) => (s.range ?? s.location.range).end.line;
    const best = inside.reduce((a, b) => (span(a) <= span(b) ? a : b));
    return { line: best.location.range.start.line, col: best.location.range.start.col };
  }
  const onLine = flat
    .filter((s) => s.location.range.start.line === line)
    .sort((a, b) => a.location.range.start.col - b.location.range.start.col)[0];
  if (onLine) return { line: onLine.location.range.start.line, col: onLine.location.range.start.col };
  return { line, col };
}

/** 文档类文件的预览上限：超过就不加载，直接提示（用户 2026-10-03 定的 100KB）。 */
export const DOC_PREVIEW_MAX_BYTES = 100 * 1024;

/** 文档 / 配置类扩展名：这类文件常常很大（日志、锁文件），整篇塞进编辑器没意义。 */
const DOC_LIKE = /\.(md|markdown|txt|log|json|ya?ml|toml|ini|csv|tsv|xml|html?|css|map|lock|svg)$/i;

function isDocLike(file: string): boolean {
  return DOC_LIKE.test(file);
}

function formatBytes(n: number): string {
  if (n < 1024) return translate('state.bytes', { n });
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 在文件树里找某个路径的节点（拿体积用；找不到返回 null）。 */
function findFileNode(node: FileNode | null, path: string): FileNode | null {
  if (!node) return null;
  if (node.path === path) return node;
  for (const child of node.children ?? []) {
    const hit = findFileNode(child, path);
    if (hit) return hit;
  }
  return null;
}

export function readPositions(projectId: string | null): Record<string, MemoryPosition> {
  if (!projectId) return {};
  try {
    const raw = window.localStorage.getItem(`wcr:positions:${projectId}`);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, MemoryPosition>) : {};
  } catch {
    return {};
  }
}

function writePositions(projectId: string, positions: Record<string, MemoryPosition>) {
  try {
    // 超出上限时丢弃最早写入的条目
    const keys = Object.keys(positions);
    if (keys.length > POSITION_LIMIT) {
      for (const k of keys.slice(0, keys.length - POSITION_LIMIT)) delete positions[k];
    }
    window.localStorage.setItem(`wcr:positions:${projectId}`, JSON.stringify(positions));
  } catch {
    /* 忽略配额错误 */
  }
}

/**
 * 打开文件后把位置写进地址栏，便于把「文件+行」当链接分享（也是给宿主的深链格式）。
 * N18：程序化跳转用 pushState（浏览器后退键回到上一个阅读位置），
 * 历史导航自身（Alt+←/→ 与 popstate）用 replaceState，避免自激。同 URL 去重。
 */
function syncUrl(
  projectId: string | null,
  file: string | null,
  line: number | undefined,
  col: number | undefined,
  mode: 'push' | 'replace' = 'push',
) {
  const params = new URLSearchParams();
  if (projectId) params.set('project', projectId);
  if (file) {
    params.set('file', file);
    if (line) params.set('line', String(line));
    if (col) params.set('col', String(col));
  }
  const qs = params.toString();
  const url = qs ? `/?${qs}` : '/';
  if (`${window.location.pathname}${window.location.search}` === url) return;
  if (mode === 'replace') window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  projects: [],
  projectId: null,
  project: null,
  status: null,
  tree: null,
  openFile: null,
  fileLang: 'plaintext',
  fileContent: '',
  fileLoading: false,
  symbols: [],
  searchHits: [],
  searchBusy: false,
  searchTruncated: false,
  references: null,
  referencesBusy: false,
  calls: null,
  callsBusy: false,
  callDirection: 'in',
  callDepth: 1,
  types: null,
  typesBusy: false,
  impls: null,
  implsBusy: false,
  searchHistory: [],
  searchDirs: [],
  flash: null,
  tabs: [],
  secondary: null,
  positions: {},
  error: null,
  reveal: null,
  notice: null,
  toast: null,
  history: [],
  historyIndex: -1,
  highlightsToken: 0,

  async init() {
    const params = new URLSearchParams(window.location.search);
    const urlProject = params.get('project');
    const urlFile = params.get('file');
    const urlLine = Number(params.get('line') ?? 1);
    const urlCol = Number(params.get('col') ?? 1);

    await get().refreshProjects();
    const projects = get().projects;
    const target = urlProject && projects.some((p) => p.id === urlProject) ? urlProject : projects[0]?.id;
    if (target) {
      await get().selectProject(target);
      if (urlFile) await get().openFileAt(urlFile, urlLine, urlCol);
    }
    set({ ready: true });
  },

  async refreshProjects() {
    try {
      set({ projects: await api.listProjects() });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async selectProject(id) {
    // W3：离开的那个项目先把阅读快照落一次（防抖可能还没到点）
    const previous = get().projectId;
    unsubscribeEvents?.();
    if (previous && previous !== id) void flushSnapshot(previous);
    set({
      projectId: id,
      // 顶栏项目下拉绑的是 project.id：这里不能先置 null，否则在「等文件树返回」的窗口里
      // 下拉会跳回第一项（界面抖动）。列表里已有该项目，直接用它当占位元数据。
      project: get().projects.find((p) => p.id === id) ?? null,
      status: null,
      tree: null,
      openFile: null,
      fileContent: '',
      symbols: [],
      searchHits: [],
      notice: null,
      references: null,
      calls: null,
      types: null,
      impls: null,
      searchHistory: readSearchHistory(id),
      searchDirs: [],
      tabs: [],
      secondary: null,
      positions: readPositions(id),
      history: [],
      historyIndex: -1,
      highlightsToken: 0,
    });
    try {
      // 文件树给「所有文件」（2026-10-03 用户要求）：二进制 / 被规则忽略的也看得见，
      // 拉不到（旧后端）就退回只含可索引文件的那份。
      const { tree, status } = await api.allFiles(id).catch(() => api.fileTree(id));
      const project = get().projects.find((p) => p.id === id) ?? null;
      set({ tree, status, project });
      unsubscribeEvents = subscribeEvents(id, (event) => {
        if (event.type === 'status' || event.type === 'index-ready') {
          set({ status: event.status as IndexStatus });
          if (event.type === 'index-ready') {
            // 索引刚完成：此前因未索引而没着的色要补上
            set((s) => ({ highlightsToken: s.highlightsToken + 1 }));
            // 索引完成意味着磁盘扫描也已就绪：补拉一次文件树。此前只在切项目时拉一次，
            // 若那一次撞在扫描窗口里拿到空树 / 半棵树，用户会一直盯着空白面板不自动恢复。
            void get().loadTree();
          }
        } else if (event.type === 'file-changed' || event.type === 'file-deleted') {
          void get().loadTree();
          set((s) => ({ highlightsToken: s.highlightsToken + 1 }));
          if (event.file === get().openFile) void get().openFileAt(event.file as string);
        }
      });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async openFolder(root, name) {
    try {
      const { project } = await api.openProject(root, name);
      await get().refreshProjects();
      await get().selectProject(project.id);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async forgetProject(id) {
    try {
      await api.forgetProject(id);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
    const projects = await api.listProjects().catch(() => []);
    set({ projects });
    if (get().projectId === id) {
      unsubscribeEvents?.();
      unsubscribeEvents = null;
      const next = projects[0]?.id ?? null;
      set({ projectId: null, project: null, tree: null, openFile: null, fileContent: '', symbols: [] });
      if (next) await get().selectProject(next);
    }
  },

  async reindex() {
    const id = get().projectId;
    if (!id) return;
    await api.reindex(id).catch((e) => set({ error: String(e) }));
  },

  async loadTree() {
    const id = get().projectId;
    if (!id) return;
    try {
      const { tree, status } = await api.allFiles(id).catch(() => api.fileTree(id));
      set({ tree, status });
    } catch {
      /* 树刷新失败不打断阅读 */
    }
  },

  async openFileAt(file, line, col, endLine, endCol) {
    const id = get().projectId;
    if (!id) return;
    // 历史导航自身触发的打开不压栈、也不推 URL（避免自激）
    const suppressed = suppressHistory;
    suppressHistory = false;
    // N22：没给行号时回到「上次读到哪里」，而不是文件开头
    const memory = line == null ? get().positions[file] : undefined;
    const targetLine = line ?? memory?.line ?? 1;
    const targetCol = col ?? memory?.col ?? 1;
    // 先只置 loading：openFile 与 fileLang 必须同时更新，否则 Editor 会先用旧语言建 model
    set({ fileLoading: true });
    // 2026-10-03 用户要求：文档类文件超过 10KB 不预览，直接说清楚（不把浏览器拖死）
    const node = findFileNode(get().tree, file);
    if (node && node.type === 'file' && isDocLike(file) && (node.size ?? 0) > DOC_PREVIEW_MAX_BYTES) {
      set({
        fileLoading: false,
        error: translate('state.fileTooLarge', { file, size: formatBytes(node.size ?? 0), limit: formatBytes(DOC_PREVIEW_MAX_BYTES) }),
      });
      return;
    }
    try {
      const res = await api.fileText(id, file);
      set({
        openFile: file,
        fileContent: res.text,
        fileLang: res.lang,
        fileLoading: false,
        reveal: {
          file,
          line: targetLine,
          col: targetCol,
          endLine,
          endCol,
          token: Date.now(),
          scrollTop: line == null ? memory?.scrollTop : undefined,
        },
      });
      if (!suppressed) {
        const prev = get().history.slice(0, get().historyIndex + 1);
        prev.push({ file, line: targetLine, col: targetCol });
        const trimmed = prev.slice(-HISTORY_LIMIT);
        set({ history: trimmed, historyIndex: trimmed.length - 1 });
      }
      // N19：标签页（同文件合并 + LRU 上限）
      const tabs = [
        { file, line: targetLine, col: targetCol },
        ...get().tabs.filter((t) => t.file !== file),
      ].slice(0, TAB_LIMIT);
      set({ tabs });
      void get().refreshSymbols();
      // G3.1：打开即已读；G3.4：把断点记给向导的「继续阅读」
      setReadMark(id, file, true);
      useGuideStore.getState().rememberRead(file, targetLine, targetCol, id);
      // W3 / G8.2：读到哪就把「现在的代码长什么样」防抖记一次（2s 后落盘）
      scheduleSnapshotWrite(id);
      syncUrl(id, file, targetLine, targetCol, suppressed ? 'replace' : 'push');
    } catch (e) {
      set({ fileLoading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  /** N19：在旁边打开（分屏）——同一文件也允许（对照两个位置）。 */
  async openInSecondary(file, line, col) {
    const id = get().projectId;
    if (!id) return;
    const memory = line == null ? get().positions[file] : undefined;
    const targetLine = line ?? memory?.line ?? 1;
    const targetCol = col ?? memory?.col ?? 1;
    try {
      await api.fileText(id, file); // 先确保可读（失败则不动分屏）
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return;
    }
    set({
      secondary: {
        file,
        line: targetLine,
        col: targetCol,
        token: Date.now(),
        scrollTop: line == null ? memory?.scrollTop : undefined,
      },
    });
  },

  closeSecondary() {
    set({ secondary: null });
  },
  /**
   * G7.5：第二窗格开一个历史版本（只读快照）。
   * 与 `openInSecondary` 的区别：不读盘（正文由调用方用 `git-show` 取好）、
   * 不写标签 / 位置记忆 / 阅读状态 —— 它不是真实文件，不能被当成「打开过」。
   */
  openSecondaryText(file, text, lang, rev) {
    set({ secondary: { file, line: 1, col: 1, token: Date.now(), text, lang, rev } });
  },

  closeTab(file) {
    set({ tabs: get().tabs.filter((t) => t.file !== file) });
  },

  /** N22：记录某文件的光标与滚动位置（切走 / 关闭页面前随时可写）。 */
  rememberPosition(file, position) {
    const id = get().projectId;
    if (!id) return;
    const positions = { ...get().positions, [file]: position };
    writePositions(id, positions);
    set({ positions });
  },

  /** 判据 6：界面里出现的每一处位置都能复制成 `path:line:col`。 */
  copyLocation(file, line, col) {
    const text = `${file}:${line}:${col}`;
    void navigator.clipboard?.writeText(text);
    showFlash(translate('state.copied', { text }));
  },

  /** S3a：选中的一段代码 → 带出处的片段（出处行 + 围栏代码块）。 */
  copySnippet(input) {
    const file = input.file ?? get().openFile;
    if (!file) return;
    const text = formatSnippet({ ...input, file, lang: input.lang ?? get().fileLang });
    void navigator.clipboard?.writeText(text);
    showFlash(translate('state.copiedSnippet', { range: formatLineRange(file, input.startLine, input.endLine) }));
  },

  async goBack() {
    const { history, historyIndex } = get();
    if (historyIndex <= 0) return;
    const target = history[historyIndex - 1];
    suppressHistory = true;
    await get().openFileAt(target.file, target.line, target.col);
    set({ historyIndex: historyIndex - 1 });
  },

  async goForward() {
    const { history, historyIndex } = get();
    if (historyIndex >= history.length - 1) return;
    const target = history[historyIndex + 1];
    suppressHistory = true;
    await get().openFileAt(target.file, target.line, target.col);
    set({ historyIndex: historyIndex + 1 });
  },

  async refreshSymbols() {
    const id = get().projectId;
    const file = get().openFile;
    if (!id || !file) return;
    const symbols = await api.documentSymbols(id, file).catch(() => []);
    if (get().openFile === file) set({ symbols });
  },

  async runSearch(query, options) {
    const id = get().projectId;
    if (!id || !query.trim()) {
      set({ searchHits: [], searchTruncated: false });
      return;
    }
    // N12：新一次搜索左掉上一次未完成的请求
    searchAbort?.abort();
    searchAbort = new AbortController();
    const signal = searchAbort.signal;
    set({ searchBusy: true, searchHits: [], searchTruncated: false });
    // N12：结果边出边看——每个文件分组到达就拼进列表（同文件追加）
    const grouped = new Map<string, SearchHit>();
    const flush = () => set({ searchHits: [...grouped.values()] });
    try {
      const summary = await api.searchStream(
        id,
        query,
        options as never,
        (matches) => {
          for (const m of matches) {
            let hit = grouped.get(m.file);
            if (!hit) {
              hit = { file: m.file, isTest: m.isTest, matches: [] };
              grouped.set(m.file, hit);
            }
            hit.matches.push({
              line: m.range.start.line,
              col: m.range.start.col,
              endCol: m.range.end.col,
              lineText: m.lineText,
            });
          }
          flush();
        },
        signal,
      );
      set({ searchTruncated: summary.truncated, searchBusy: false });
      rememberSearch(id, query);
      set({ searchHistory: readSearchHistory(id) });
    } catch (e) {
      // 主动取消不算错误（已收到的结果保留，用户可以接着看）
      if (signal.aborted) set({ searchBusy: false });
      else set({ searchBusy: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  /** N12：取消正在进行的搜索（后端会在文件级 / 行级检查中止）。 */
  cancelSearch() {
    searchAbort?.abort();
    searchAbort = null;
    set({ searchBusy: false });
  },

  /** N14：设置搜索范围（目录前缀）。 */
  setSearchDirs(dirs) {
    set({ searchDirs: dirs });
  },

  /** N16：调用层级（in=谁调用我 / out=我调用了谁）。 */
  async loadCalls(file, line, col) {
    const id = get().projectId;
    if (!id) {
      set({ calls: null });
      return;
    }
    set({ callsBusy: true });
    try {
      const res = await api.callHierarchy(id, {
        file,
        ...snapToSymbol(get().symbols, line, col),
        direction: get().callDirection,
        depth: get().callDepth,
      });
      if (get().openFile !== file) return;
      set({ calls: res, callsBusy: false });
    } catch {
      set({ callsBusy: false, calls: null });
    }
  },

  setCallDirection(direction) {
    set({ callDirection: direction });
  },

  setCallDepth(depth) {
    set({ callDepth: Math.max(1, Math.min(depth, 3)) });
  },

  /** N17：类型层级。 */
  async loadTypes(file, line, col) {
    const id = get().projectId;
    if (!id) {
      set({ types: null });
      return;
    }
    set({ typesBusy: true });
    try {
      const target = snapToSymbol(get().symbols, line, col);
      const res = await api.typeHierarchy(id, file, target.line, target.col);
      if (get().openFile !== file) return;
      set({ types: res, typesBusy: false });
    } catch {
      set({ typesBusy: false, types: null });
    }
  },

  /** N15：跳到实现。 */
  async loadImpls(file, line, col) {
    const id = get().projectId;
    if (!id) {
      set({ impls: null });
      return;
    }
    set({ implsBusy: true });
    try {
      const target = snapToSymbol(get().symbols, line, col);
      const res = await api.implementations(id, file, target.line, target.col);
      if (get().openFile !== file) return;
      set({ impls: res, implsBusy: false });
    } catch {
      set({ implsBusy: false, impls: null });
    }
  },

  clearSearch() {
    set({ searchHits: [], searchTruncated: false });
  },

  /** 常驻引用面板：查当前光标的引用（N4，含声明）。 */
  async loadReferences(file, line, col) {
    const id = get().projectId;
    if (!id) {
      set({ references: null });
      return;
    }
    set({ referencesBusy: true });
    try {
      const target = snapToSymbol(get().symbols, line, col);
      const res = await api.findReferences(id, {
        file,
        line: target.line,
        col: target.col,
        includeDeclaration: true,
      });
      if (get().openFile !== file) return; // 期间已切走
      // 顺手带一次类型层级：引用面板要能回答「它在继承体系里的位置」，
      // 而「家族」只在类型符号上有意义 —— 查不到就留 null，不影响引用列表本身。
      let family: TypeHierarchyResult | null = null;
      try {
        family = await api.typeHierarchy(id, file, target.line, target.col);
      } catch {
        family = null;
      }
      if (get().openFile !== file) return;
      set({
        references: {
          symbol: res.symbol ?? null,
          reason: res.reason,
          locations: res.locations,
          declaration: res.declaration ?? null,
          origin: { file, line, col },
          family,
        },
        referencesBusy: false,
      });
    } catch {
      set({ referencesBusy: false, references: null });
    }
  },

  setError(message) {
    set({ error: message });
  },

  showNotice(notice) {
    set({ notice });
  },

  dismissNotice() {
    set({ notice: null });
  },
}));

/** 宿主（如 xchen 项目列表）通过 iframe 发来的跳转指令。 */
export interface HostOpenMessage {
  type: 'wcr:open';
  /** 本机项目根目录绝对路径。 */
  root?: string;
  /** 已注册项目的 id（与 root 二选一）。 */
  projectId?: string;
  file?: string;
  line?: number;
  col?: number;
}

/** 打开「项目列表里已有的项目」/深链——供宿主（如 xchen）跳转时调用。 */
export async function openProjectByRoot(root: string, file?: string, line?: number, col?: number) {
  const project =
    (await api.lookupByRoot(root).catch(() => null)) ??
    (await api.openProject(root).then((r) => r.project).catch(() => null));
  if (!project) return false;
  if (useStore.getState().projectId !== project.id) {
    await useStore.getState().refreshProjects();
    await useStore.getState().selectProject(project.id);
  }
  if (file) await useStore.getState().openFileAt(file, line, col);
  return true;
}

/**
 * S9c：宿主收起面板（wcr:dispose）时先停掉本页的事件流。
 * 后端会同时关 watcher、断 SSE、释放内存索引（`POST /api/projects/:id/dispose`）；
 * 这里把本地订阅也断开，不留一个连着已释放项目的 EventSource。
 * 再次打开该项目时 selectProject 会重新订阅。
 */
export function suspendProjectEvents(): void {
  unsubscribeEvents?.();
  unsubscribeEvents = null;
}

/**
 * 监听浏览器前进/后退键（N18）：只认地址栏 URL，与自建历史栈分离。
 * 程序化跳转（goBack/goForward）走 suppressHistory，不会二次压栈。
 */
export function listenPopState() {
  window.addEventListener('popstate', () => {
    const params = new URLSearchParams(window.location.search);
    const project = params.get('project');
    const file = params.get('file');
    const line = Number(params.get('line') ?? 1) || 1;
    const col = Number(params.get('col') ?? 1) || 1;
    const state = useStore.getState();
    if (!file) return;
    if (project && project !== state.projectId) {
      const inList = state.projects.some((p) => p.id === project);
      if (inList) {
        void state.selectProject(project).then(() => {
          void useStore.getState().openFileAt(file, line, col);
        });
        return;
      }
    }
    suppressHistory = true;
    void useStore.getState().openFileAt(file, line, col);
  });
}
