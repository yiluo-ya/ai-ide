/** 应用外壳：侧栏（总览/文件/引用/层级/大纲/搜索）+ 编辑器 + 项目地图 + 快捷键。 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { api } from './api';
import { Editor } from './Editor';
import { FileTree, type TreeDecor } from './FileTree';
import { GraphView, type GraphViewState } from './GraphView';
import { FlowView } from './FlowView';
import { Overview, OverviewPanel } from './Overview';
import { CallsPanel, TypesPanel } from './NavPanels';
import { OutlinePanel, RefsPanel, SearchPanel, symbolPathAt } from './SidePanel';
import { GotoNoticeBar, gotoFailureMessage } from './Notice';
import { QuickOpen, type QuickOpenMode } from './QuickOpen';
import { TopBar } from './TopBar';
import { PrivacyPanel } from './PrivacyPanel';
import { SettingsPanel } from './SettingsPanel';
import { IndexReportDialog } from './IndexReport';
import { Welcome } from './Welcome';
import { SIDEBAR_MAX, SIDEBAR_MIN, loadPrefs, savePrefs } from './prefs';
import { monaco, setProviderContext } from './monaco-setup';
import { listenPopState, showFlash, useStore } from './state';
import { ShareMenu } from './ShareMenu';
import { AnnotationsPanel } from './AnnotationsPanel';
import { initHostBridge } from './bridge';
import { useMapStore } from './mapState';
import { GuidePanel } from './GuidePanel';
import { useGuideStore, visibleSteps } from './guideState';
import { useNotesStore } from './notesState';
import { ExplainPanel } from './ExplainPanel';
import { useExplainStore } from './explainState';
import { ChangesPanel } from './ChangesPanel';
import { DiffPanel } from './DiffPanel';
import { useChangesStore } from './changesState';
import { changesApi, flushSnapshot } from './readSnapshot';
import { blameAt, blameText, loadBlame } from './blame';
import { translate, useI18n } from './i18n';
import type { BlameResult, FileNode, FileOrigin, SymbolInfo } from '../../shared/types';
import type { HotMetric } from './mapApi';

type PanelTab =
  | 'overview'
  | 'guide'
  | 'files'
  | 'refs'
  | 'hierarchy'
  | 'outline'
  | 'search'
  | 'marks'
  | 'changes'
  | 'notes';

/** 侧栏 tab 的**唯一次序来源**：渲染（tablist）与 Ctrl/Cmd+1..9 快捷键都按它来。
 * 以前这里和快捷键的 order 数组各写一份，漂移过：用户按 Ctrl+4 以为是「大纲」（界面上第 4 个），
 * 却切到了「引用」。加面板时只改这一处。
 */
const PANEL_TABS: PanelTab[] = [
  'overview',
  'guide',
  'files',
  'outline',
  'refs',
  'hierarchy',
  'search',
  'marks',
  'changes',
  'notes',
];
/** tab 上的文字（guide / changes 走 i18n，单独处理）。 */
const TAB_TEXT: Record<string, string> = {
  overview: '总览',
  files: '文件',
  outline: '大纲',
  refs: '引用',
  hierarchy: '层级',
  search: '搜索',
  marks: '书签',
  notes: '批注',
};
const HOT_METRICS: HotMetric[] = ['files', 'refs', 'symbols', 'defined', 'unique', 'recent'];

/** M20 地图快照：把「地图的哪个视图」写进 URL，这样「看这个模块的依赖图 / 概览」可以被贴出去。
 * 只碰自己的这几个参数，不碰项目 / 文件 / 行号（那由 state.ts 的深链自己管）。
 */
function writeSnapshot(params: Record<string, string | null>): void {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === '') url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  window.history.replaceState(null, '', `${url.pathname}?${url.searchParams.toString()}`);
}

/** 读一次 URL 快照（只在首次挂载时用）。 */
const snapshot = new URLSearchParams(window.location.search);
/** 层级 tab 的两面：调用层级（N16）/ 类型层级（N17 + N15）。 */
type HierarchyKind = 'calls' | 'types';
type RecentFilter = 'all' | 'today' | '3d' | '7d';

/** 面包屑同级下拉（N7）的内容。 */
interface CrumbMenu {
  items: SymbolInfo[];
  currentName: string;
}

/** 搜索范围胶囊的候选：顶层目录（N14）。 */
function topDirs(node: FileNode | null): string[] {
  return (node?.children ?? []).filter((c) => c.type === 'directory').map((c) => c.path);
}

/** 「只看最近改动」的时间阈值。 */
function recentCutoff(kind: Exclude<RecentFilter, 'all'>): number {
  if (kind === 'today') return new Date().setHours(0, 0, 0, 0);
  return Date.now() - (kind === '3d' ? 3 : 7) * 86_400_000;
}

/** 拍平文件树里的文件路径。 */
function collectFiles(node: FileNode | null): string[] {
  if (!node) return [];
  if (node.type === 'file') return [node.path];
  return (node.children ?? []).flatMap(collectFiles);
}

/**
 * G7.5：历史版本正文没有后端给的 lang，按扩展名推断后端语言 id
 * （与 `indexer/languages.ts` 的 specForFile 同一集合；认不出返回空串 → Monaco 用 plaintext）。
 */
function langForFile(file: string): string {
  const name = file.toLowerCase();
  const ext = name.slice(name.lastIndexOf('.'));
  switch (ext) {
    case '.py':
    case '.pyi':
      return 'python';
    case '.ts':
    case '.mts':
    case '.cts':
      return 'typescript';
    case '.tsx':
      return 'tsx';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.jsx':
      return 'jsx';
    case '.go':
      return 'go';
    case '.java':
      return 'java';
    default:
      return '';
  }
}

export default function App() {
  const store = useStore();
  const { t } = useI18n();
  // 向导（G2/G3）：路线与状态栏提示都从 guideState 读
  const guideRoutes = useGuideStore((s) => s.routes);
  const guideKind = useGuideStore((s) => s.kind);
  const guideCustom = useGuideStore((s) => s.custom);
  const guideDone = useGuideStore((s) => s.done);
  const guideRead = useMapStore((s) => s.read);
  const guideSteps = useMemo(
    () => visibleSteps({ routes: guideRoutes, kind: guideKind, custom: guideCustom }),
    [guideRoutes, guideKind, guideCustom],
  );
  const guideDoneCount = guideSteps.filter((s) => guideDone[s.file] || guideRead[s.file]).length;
  /** W4：结构性解释面板的目标（null = 关着）。 */
  const explainTarget = useExplainStore((s) => s.target);
  const guideNext = useMemo(() => {
    const order = guideSteps.map((s) => s.file);
    if (!order.length) return null;
    const i = store.openFile ? order.indexOf(store.openFile) : -1;
    return i < 0 ? order[0] : order[i + 1] ?? null;
  }, [guideSteps, store.openFile]);
  const [tab, setTab] = useState<PanelTab>(() => {
    const fromUrl = snapshot.get('tab') as PanelTab | null;
    return fromUrl && PANEL_TABS.includes(fromUrl) ? fromUrl : 'files';
  });
  /** W3：变更面板 tab 上的计数（变了几个文件）。 */
  const changesCount = useChangesStore((s) => s.summary?.files.length ?? 0);
  const [quick, setQuick] = useState<QuickOpenMode>(null);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [fileFilter, setFileFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [crumbMenu, setCrumbMenu] = useState<CrumbMenu | null>(null);
  const [hierarchyKind, setHierarchyKind] = useState<HierarchyKind>('calls');
  const [searchFullscreen, setSearchFullscreen] = useState(false);
  /** N19 分屏：第二窗格的文件内容（与主窗格共享 model 池）。 */
  const [secondaryDoc, setSecondaryDoc] = useState<{
    file: string;
    lang: string;
    text: string;
    /** G7.5：本次是历史版本快照时的提交（`wcr-history://` model，不是磁盘文件）。 */
    rev?: string;
  } | null>(null);
  const searchInputRef = useRef<HTMLDivElement>(null);

  // 项目地图：主区视图（map = 强制看地图）、依赖图浮层、文件树叠加过滤（M9/M10）
  const [mainView, setMainView] = useState<'auto' | 'map'>(() => (snapshot.get('view') === 'map' ? 'map' : 'auto'));
  const [graphOpen, setGraphOpen] = useState(() => snapshot.get('graph') === '1');
  /** W5：流视图浮层的焦点（null = 关着）。 */
  const [flowTarget, setFlowTarget] = useState<{ file: string; line: number; col: number } | null>(null);
  const [graphState, setGraphState] = useState<GraphViewState | null>(null);
  const [recentFilter, setRecentFilter] = useState<RecentFilter>('all');
  const [onlyAgent, setOnlyAgent] = useState(false);
  const [onlyOrphans, setOnlyOrphans] = useState(false);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [hideIgnored, setHideIgnored] = useState(false);
  /** P24 / P17 / P9 的浮层：设置 · 隐私与数据 · 索引报告。 */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  /** 索引报告端点是否可用：旧后端 404 时隐藏入口，不报错、不弹红。 */
  const [reportAvailable, setReportAvailable] = useState(false);
  /** W3 / G7.2：只读 diff 浮层的目标文件（null = 关着）。 */
  const [diffFile, setDiffFile] = useState<string | null>(null);
  /** W3 / G7.3：整文件 blame 视图开关 + 当前文件的 blame（按文件缓存，光标移动不重新拉）。 */
  const [blameOn, setBlameOn] = useState(false);
  const [blame, setBlame] = useState<BlameResult | null>(null);
  const blameOnRef = useRef(false);
  blameOnRef.current = blameOn;
  /** W3 / G7.3：光标所在行的 blame（只在开着 blame 视图时取）。 */
  const cursorBlame = useMemo(
    () => (blameOn ? blameAt(blame, cursor.line) : null),
    [blameOn, blame, cursor.line],
  );
  const mapOverview = useMapStore((s) => s.overview);
  const mapTimeline = useMapStore((s) => s.timeline);
  const mapRead = useMapStore((s) => s.read);
  const mapIgnored = useMapStore((s) => s.ignored);
  const mapPulse = useMapStore((s) => s.pulse);
  const mapOptions = useMapStore((s) => s.options);
  const toggleRead = useMapStore((s) => s.toggleRead);
  const toggleIgnored = useMapStore((s) => s.toggleIgnored);

  useEffect(() => {
    void store.init();
    initHostBridge();
    listenPopState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Provider 需要拿到「当前项目」与「打开位置」两件事，这里持续同步
  useEffect(() => {
    setProviderContext({
      projectId: store.projectId,
      openLocation: (file, line, col, endLine, endCol) => {
        void useStore.getState().openFileAt(file, line, col, endLine, endCol);
      },
      // N25：正文里的路径按钮只有校验存在才给点击态
      fileExists: (rel) => fileSetRef.current.has(rel),
      // 没有跳转时不再沉默（N2）：后端算好的 reason / symbol 交给提示条
      onGotoFailed: (failure) => {
        const s = useStore.getState();
        // Q12：索引进行中优先于「认不出类型」，避免提示条说错话
        if (s.status?.indexing && failure.reason !== 'no-symbol') {
          s.showNotice({
            kind: failure.kind,
            reason: 'indexing',
            symbol: failure.symbol,
            message: '索引进行中，符号信息稍后可查',
          });
          return;
        }
        s.showNotice({ ...failure, message: gotoFailureMessage(failure) });
      },
    });
  }, [store.projectId]);

  // 常驻引用面板（N4）：切到引用 tab 时按光标位置查引用（防抖）
  useEffect(() => {
    if (tab !== 'refs' || !store.openFile) return;
    const file = store.openFile;
    const { line, col } = cursor;
    const timer = setTimeout(() => {
      void useStore.getState().loadReferences(file, line, col);
    }, 250);
    return () => clearTimeout(timer);
  }, [tab, store.openFile, cursor.line, cursor.col]);

  // no-symbol 不弹条（Q1），但也不能毫无反馈：状态栏轻提示几秒后自动消失
  useEffect(() => {
    if (store.notice?.reason !== 'no-symbol') return;
    const timer = setTimeout(() => useStore.getState().dismissNotice(), 5000);
    return () => clearTimeout(timer);
  }, [store.notice]);

  // 调用层级 / 类型层级（N16/N17/N15）：与引用面板同样按光标防抖查询
  useEffect(() => {
    if (tab !== 'hierarchy' || !store.openFile) return;
    const file = store.openFile;
    const { line, col } = cursor;
    const timer = setTimeout(() => {
      const s = useStore.getState();
      if (hierarchyKind === 'calls') void s.loadCalls(file, line, col);
      else {
        void s.loadTypes(file, line, col);
        void s.loadImpls(file, line, col);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [tab, hierarchyKind, store.openFile, cursor.line, cursor.col, store.callDirection, store.callDepth]);

  // N19：分屏第二窗格的内容
  useEffect(() => {
    const target = store.secondary;
    if (!target || !store.projectId) {
      setSecondaryDoc(null);
      return;
    }
    // G7.5：历史版本正文随请求带来（只读快照，不读盘、不落盘）
    if (target.text != null) {
      setSecondaryDoc({
        file: target.file,
        lang: target.lang ?? langForFile(target.file),
        text: target.text,
        rev: target.rev,
      });
      return;
    }
    let cancelled = false;
    void api
      .fileText(store.projectId, target.file)
      .then((res) => {
        if (!cancelled) setSecondaryDoc({ file: target.file, lang: res.lang, text: res.text });
      })
      .catch(() => {
        if (!cancelled) setSecondaryDoc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [store.secondary, store.projectId]);

  // W3：页面隐藏（切标签 / 关页）时立刻落一次阅读快照，别等防抖
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') return;
      const id = useStore.getState().projectId;
      if (id) void flushSnapshot(id);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // W3 / G7.3：blame 只在「开了视图」且换了文件时拉一次（同一文件命中缓存）
  useEffect(() => {
    if (!blameOn || !store.projectId || !store.openFile) {
      setBlame(null);
      return;
    }
    const projectId = store.projectId;
    const file = store.openFile;
    let cancelled = false;
    void loadBlame(projectId, file)
      .then((res) => {
        if (!cancelled && useStore.getState().openFile === file) setBlame(res);
      })
      .catch(() => {
        if (!cancelled) setBlame(null);
      });
    return () => {
      cancelled = true;
    };
  }, [blameOn, store.projectId, store.openFile, store.highlightsToken]);

  // 全屏搜索也是浮层：Esc 关闭（与依赖图 / 解释 / 调用流图保持一致）。
  // capture 阶段：焦点在搜索框或编辑器里时也能可靠关掉，不让 Esc 落到别处。
  useEffect(() => {
    if (!searchFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setSearchFullscreen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [searchFullscreen]);

  // 全局快捷键（捕获阶段先于 Monaco 处理，避免被编辑器吃掉）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      // P24/P17/P9 的键盘入口（Alt / 逗号组合要先于 Ctrl+P 判断，否则会被文件搜索吃掉）
      if (mod && e.altKey && key === 'p') {
        e.preventDefault();
        setPrivacyOpen(true);
        return;
      }
      if (mod && e.altKey && key === 'i') {
        e.preventDefault();
        if (reportAvailable) setReportOpen(true);
        return;
      }
      if (mod && e.altKey && key === 'b') {
        // G7.3：切换「整文件 blame 视图」；无 git → 只在状态栏轻提示一句，不弹红
        e.preventDefault();
        const s = useStore.getState();
        if (!s.projectId) return;
        if (!s.openFile) {
          // 没打开文件就没有「哪一行」这回事：轻提示一句，不做静默失败
          showFlash(translate('blame.noFile'));
          return;
        }
        if (blameOnRef.current) {
          setBlameOn(false);
          return;
        }
        const file = s.openFile;
        void loadBlame(s.projectId, file)
          .then((res) => {
            if (res.reason === 'no-git') {
              showFlash(translate('blame.noGit'));
              return;
            }
            if (res.reason) {
              showFlash(translate('blame.unavailable'));
              return;
            }
            setBlameOn(true);
          })
          .catch(() => showFlash(translate('blame.unavailable')));
        return;
      }
      if (mod && !e.altKey && key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (mod && !e.shiftKey && key === 'p') {
        e.preventDefault();
        setQuick('file');
      } else if (mod && !e.shiftKey && key === 't') {
        e.preventDefault();
        setQuick('symbol');
      } else if (mod && e.shiftKey && key === 'b') {
        // N20：在光标处加 / 去书签
        e.preventDefault();
        if (store.openFile) {
          useStore.getState().toggleBookmark(store.openFile, cursor.line, cursor.col);
        }
      } else if (mod && !e.shiftKey && /^[0-9]$/.test(key)) {
        // N-δ：键盘可达 —— Ctrl/Cmd+1..9 按侧栏里看到的顺序切面板，0 = 第 10 个（批注）。
        e.preventDefault();
        setTab(key === '0' ? PANEL_TABS[PANEL_TABS.length - 1] : PANEL_TABS[Number(key) - 1]);
      } else if (mod && e.shiftKey && key === 'f') {
        e.preventDefault();
        setTab('search');
        setTimeout(() => {
          searchInputRef.current?.querySelector('input')?.focus();
        }, 0);
      } else if (mod && e.shiftKey && key === 'o') {
        e.preventDefault();
        setTab('outline');
      } else if (mod && e.shiftKey && key === 'e') {
        e.preventDefault();
        setTab('files');
      } else if (mod && e.shiftKey && key === 'r') {
        // G3.4：继续阅读 —— 直达上次离开的文件与行列（没有断点就不抢这个键）
        const last = useGuideStore.getState().readstate;
        if (last) {
          e.preventDefault();
          setMainView('auto');
          void useStore.getState().openFileAt(last.file, last.line, last.col);
        }
      } else if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        void useStore.getState().goBack();
      } else if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        void useStore.getState().goForward();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [store.openFile, cursor.line, cursor.col]);

  // M20 地图快照：视图变化写回 URL；从 URL 打开时把热点口径也恢复
  useEffect(() => {
    writeSnapshot({
      view: mainView === 'map' ? 'map' : null,
      tab: tab === 'files' ? null : tab,
      hot: mapOptions.hot === 'files' ? null : mapOptions.hot,
      denoise: mapOptions.denoise ? null : '0',
      graph: graphOpen ? '1' : null,
      glevel: graphOpen && graphState && graphState.level !== 'dir' ? graphState.level : null,
      gexpand: graphOpen && graphState?.expand.length ? graphState.expand.join(',') : null,
      glayout: graphOpen && graphState && graphState.layout !== 'lanes' ? graphState.layout : null,
      gext: graphOpen && graphState && !graphState.external ? '0' : null,
    });
  }, [mainView, tab, graphOpen, graphState, mapOptions.hot, mapOptions.denoise]);

  // URL 里带了口径参数时，首屏就按它取数（而不是先按默认取一次再切）
  useEffect(() => {
    const hot = snapshot.get('hot') as HotMetric | null;
    const patch: { hot?: HotMetric; denoise?: boolean } = {};
    if (hot && HOT_METRICS.includes(hot)) patch.hot = hot;
    if (snapshot.get('denoise') === '0') patch.denoise = false;
    if (Object.keys(patch).length) useMapStore.getState().setOptions(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 项目地图数据：项目切换 / 索引就绪（indexedAt 变化）/ 文件树变化后重拉
  useEffect(() => {
    const id = store.projectId;
    if (!id) {
      useMapStore.getState().reset();
      useGuideStore.getState().reset();
      useNotesStore.getState().reset();
      useChangesStore.getState().reset();
      useExplainStore.getState().reset();
      return;
    }
    void useMapStore.getState().load(id);
    void useGuideStore.getState().load(id);
    useNotesStore.getState().load(id);
    void useChangesStore.getState().load(id);
  }, [store.projectId, store.status?.indexedAt, store.tree]);

  // P9 入口的能力探测：先看服务自述里有没有声明这个端点——
  // 旧后端不声明就不发请求（既隐藏入口，也不产生 404 噪音），不报错、不弹红。
  useEffect(() => {
    const id = store.projectId;
    if (!id) {
      setReportAvailable(false);
      return;
    }
    let cancelled = false;
    api
      .manifest()
      .then((m) => {
        if (!cancelled) setReportAvailable(Boolean(m.endpoints?.indexReport));
      })
      .catch(() => {
        if (!cancelled) setReportAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [store.projectId]);

  const crumbs = useMemo(() => symbolPathAt(store.symbols, cursor.line), [store.symbols, cursor.line]);
  const searchDirOptions = useMemo(() => topDirs(store.tree), [store.tree]);
  /** N21：最近打开（标签顺序即最近访问倒序）。 */
  const recentFiles = useMemo(() => store.tabs.map((t) => t.file), [store.tabs]);
  const fileSetRef = useRef<Set<string>>(new Set());
  fileSetRef.current = new Set(collectFiles(store.tree));
  const rootName = store.project?.name ?? '';
  const canBack = store.historyIndex > 0;
  const canForward = store.historyIndex < store.history.length - 1;

  /**
   * P24：侧栏宽拖拽。拖动期间只改 CSS 变量（不落盘、不重渲染），松手才写 `wcr:prefs`；
   * 键盘（←/→）也能调，保证不用鼠标。
   */
  const clampSidebar = (px: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px)));

  const onSidebarResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const target = e.currentTarget;
    const startX = e.clientX;
    const startWidth = loadPrefs().sidebarWidth;
    target.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      document.documentElement.style.setProperty('--sidebar-width', `${clampSidebar(startWidth + ev.clientX - startX)}px`);
    };
    const onUp = (ev: PointerEvent) => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      savePrefs({ sidebarWidth: clampSidebar(startWidth + ev.clientX - startX) });
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
  };

  const onSidebarResizeKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    savePrefs({ sidebarWidth: clampSidebar(loadPrefs().sidebarWidth + (e.key === 'ArrowLeft' ? -16 : 16)) });
  };

  /** 打开文件一律回到代码视图（地图不是终点，是入口）。 */
  const jump = (file: string, line?: number, col?: number, endLine?: number, endCol?: number) => {
    setMainView('auto');
    void useStore.getState().openFileAt(file, line, col, endLine, endCol);
  };

  /** W4 / G5.1：从编辑器右键或层级面板发起结构性解释（浮层）。 */
  const openExplain = (file: string, line: number, col: number) => {
    const id = useStore.getState().projectId;
    if (!id) return;
    useExplainStore.getState().open(id, { file, line, col });
  };

  /** W5 / G9.4：把某个符号展开成调用流图（浮层）。 */
  const openFlow = (file: string, line: number, col: number) => setFlowTarget({ file, line, col });

  /**
   * G7.5：点摘要条里的某次提交 → 取该版本正文，在第二窗格只读打开。
   * 正文只留在内存（`openSecondaryText` 写进 reveal 请求，不落盘、不进最近打开与位置记忆）。
   */
  const openHistoryVersion = (file: string, rev: string) => {
    const id = useStore.getState().projectId;
    if (!id) return;
    void changesApi
      .gitShow(id, rev, file)
      .then((res) => {
        useStore.getState().openSecondaryText(res.file, res.text, langForFile(res.file), res.rev);
      })
      .catch((e: unknown) => {
        useStore.getState().setError(e instanceof Error ? e.message : String(e));
      });
  };

  /** 文件树叠加层：时间 / 来源 / 孤立 / 热点 / 已读 / 忽略 / 刚变更 + 视图过滤。 */
  const decor = useMemo<TreeDecor>(() => {
    const timeline = new Map<string, { mtimeMs: number; origin: FileOrigin; confidence: number }>();
    for (const f of mapTimeline?.files ?? []) {
      timeline.set(f.file, { mtimeMs: f.mtimeMs, origin: f.origin, confidence: f.confidence });
    }
    // G6.2：目录职责 / 分层来自 01 的 overview.dirs（不重算，取不到就不显示）
    const dirs = new Map<string, { duty: string; layer: string; from: string | null }>();
    for (const d of mapOverview?.dirs ?? []) dirs.set(d.dir, { duty: d.duty, layer: d.layer, from: d.dutyFrom });
    const orphans = new Set((mapOverview?.orphans ?? []).map((o) => o.file));
    const hot = new Set((mapOverview?.hot ?? []).map((h) => h.file));
    // M9.3：SSE 刚报过的文件（mapState 里 20 秒后自动撤掉）
    const pulse = new Set(Object.keys(mapPulse));
    const read = new Set(Object.keys(mapRead));
    const ignored = new Set(Object.keys(mapIgnored));

    const filtering = recentFilter !== 'all' || onlyAgent || onlyOrphans || onlyUnread || hideIgnored;
    let visible: Set<string> | undefined;
    if (filtering) {
      const cutoff = recentFilter === 'all' ? 0 : recentCutoff(recentFilter);
      visible = new Set(
        collectFiles(store.tree).filter((file) => {
          const fact = timeline.get(file);
          if (recentFilter !== 'all' && !(fact && fact.mtimeMs >= cutoff)) return false;
          if (onlyAgent && fact?.origin !== 'agent') return false;
          if (onlyOrphans && !orphans.has(file)) return false;
          if (onlyUnread && read.has(file)) return false;
          if (hideIgnored && ignored.has(file)) return false;
          return true;
        }),
      );
    }
    return { timeline, orphans, hot, pulse, read, ignored, dirs, visible };
  }, [
    mapTimeline,
    mapOverview,
    mapPulse,
    mapRead,
    mapIgnored,
    store.tree,
    recentFilter,
    onlyAgent,
    onlyOrphans,
    onlyUnread,
    hideIgnored,
  ]);

  /** 没有打开文件时，主区就是项目地图（落点 C：首屏即主页）。 */
  const showMap = mainView === 'map' || !store.openFile;

  /** 提示条上的「退而求其次」动作：拿符号名发起项目内全文搜索（N2）。 */
  const searchByName = (name: string) => {
    setTab('search');
    setSearchQuery(name);
    void useStore.getState().runSearch(name, {});
  };

  /** N22：位置记忆上报（切换文件 / 关闭页面前都在写）。 */
  const rememberPosition = (file: string, line: number, col: number, scrollTop: number) =>
    useStore.getState().rememberPosition(file, { line, col, scrollTop });

  /** 判据 6：复制位置 `path:line:col`（状态栏会给一句轻反馈）。 */
  const copyLocation = (file: string, line: number, col: number) =>
    useStore.getState().copyLocation(file, line, col);

  /** S3a：选中的一段代码 → 带出处的片段（出处行 + 围栏代码块）。 */
  const copySnippet = (file: string, startLine: number, endLine: number, text: string) =>
    useStore.getState().copySnippet({ file, startLine, endLine, text });

  /** S3b：光标处符号 → 摘要（签名 + 位置）；认不出符号时退化为复制位置。 */
  const copySymbolAt = (file: string, line: number, col: number) =>
    useStore.getState().copySymbolAt(file, line, col);

  const bookmarked = store.openFile
    ? store.bookmarks.some((b) => b.file === store.openFile && b.line === cursor.line)
    : false;

  return (
    <div className="app">
      <TopBar
        projects={store.projects}
        project={store.project}
        status={store.status}
        openFile={store.openFile}
        onSelect={(id) => void useStore.getState().selectProject(id)}
        onOpenFolder={(root) => void useStore.getState().openFolder(root)}
        onForget={(id) => void useStore.getState().forgetProject(id)}
        onReindex={() => void useStore.getState().reindex()}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenPrivacy={() => setPrivacyOpen(true)}
        onOpenReport={reportAvailable ? () => setReportOpen(true) : undefined}
      />

      <div className="body">
        <aside className="sidebar">
          {/* P24：侧栏宽拖拽把手（键盘 ←/→ 同效） */}
          <div
            className="sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整侧栏宽度"
            tabIndex={0}
            onPointerDown={onSidebarResizeStart}
            onKeyDown={onSidebarResizeKey}
          />
          {/* tab 顺序只来自 PANEL_TABS（快捷键用同一份），不要再在这里手写一遍 */}
          <div className="panel-tabs" role="tablist" aria-label="侧栏面板">
            {PANEL_TABS.map((id) => {
              const count =
                id === 'marks'
                  ? store.bookmarks.length
                  : id === 'changes'
                    ? changesCount
                    : id === 'notes'
                      ? store.annotations.filter((a) => !a.resolved).length
                      : 0;
              const label = id === 'guide' ? t('guide.tab') : id === 'changes' ? t('changes.tab') : TAB_TEXT[id];
              const title =
                id === 'changes'
                  ? t('changes.tabTitle')
                  : id === 'notes'
                    ? '批注：在这行留一句，随导出的报告一起交付'
                    : undefined;
              return (
                <button
                  key={id}
                  role="tab"
                  id={`wcr-tab-${id}`}
                  aria-selected={tab === id}
                  aria-controls="wcr-side-panel"
                  className={tab === id ? 'active' : ''}
                  onClick={() => setTab(id)}
                  title={title}
                >
                  {label}
                  {count > 0 && <span className="tab-count">{count}</span>}
                </button>
              );
            })}
          </div>

          {/* P25：面板容器补 tabpanel 语义（aria-labelledby 指向当前 tab） */}
          <div className="panel-body" role="tabpanel" id="wcr-side-panel" aria-labelledby={`wcr-tab-${tab}`}>

          {tab === 'notes' && (
            <AnnotationsPanel
              file={store.openFile}
              cursor={cursor}
              onJump={(file, line, col) => jump(file, line, col)}
            />
          )}

          {tab === 'marks' && (
            <div className="marks-panel">
              <div className="marks-head">
                <span className="muted">{store.bookmarks.length} 处标记</span>
                <span className="spacer" />
                <button
                  className="btn ghost small"
                  title="导出书签 JSON（可以贴给别人 / 跨机器）"
                  onClick={() => {
                    const json = useStore.getState().exportBookmarks();
                    void navigator.clipboard?.writeText(json);
                  }}
                >
                  导出
                </button>
                <label className="btn ghost small" title="导入书签 JSON（合并去重）">
                  导入
                  <input
                    type="file"
                    accept=".json,application/json"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      void f.text().then((text) => useStore.getState().importBookmarks(text));
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
              <div className="marks-body">
                {!store.bookmarks.length && <div className="panel-empty">Ctrl/Cmd+Shift+B 在当前行加书签</div>}
                {store.bookmarks.map((b) => (
                  <div
                    key={`${b.file}:${b.line}:${b.col}`}
                    className="nav-row"
                    onClick={() => jump(b.file, b.line, b.col)}
                    title={`${b.file}:${b.line}:${b.col}`}
                  >
                    <span className="nav-name">{b.file.split('/').pop()}</span>
                    <span className="nav-count">L{b.line}</span>
                    <span className="nav-path">{b.file}</span>
                    <button
                      className="btn ghost small"
                      onClick={(e) => {
                        e.stopPropagation();
                        useStore.getState().removeBookmark(b.file, b.line, b.col);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <div className="nav-foot">书签存在本机浏览器，不写被读目录</div>
            </div>
          )}

          {tab === 'guide' && (
            <GuidePanel onOpenFile={(file, line, col) => jump(file, line, col)} />
          )}

          {/* W3 / G8：自上次阅读以来的变更清单 */}
          {tab === 'changes' && (
            <ChangesPanel onOpenFile={(file) => jump(file)} onOpenDiff={(file) => setDiffFile(file)} />
          )}

          {tab === 'overview' && (
            <OverviewPanel
              onOpenFile={(file, line) => jump(file, line ?? 1, 1)}
              onOpenMap={() => setMainView('map')}
              onOpenGraph={() => setGraphOpen(true)}
            />
          )}

          {tab === 'files' && (
            <>
              <input
                className="text-input sidebar-filter"
                placeholder="过滤文件名"
                value={fileFilter}
                onChange={(e) => setFileFilter(e.target.value)}
              />
              <div className="tree-views">
                <select
                  className="ov-select"
                  value={recentFilter}
                  onChange={(e) => setRecentFilter(e.target.value as RecentFilter)}
                  title="只看最近改动过的文件"
                >
                  <option value="all">时间：全部</option>
                  <option value="today">今天改过</option>
                  <option value="3d">3 天内</option>
                  <option value="7d">7 天内</option>
                </select>
                <label title="只看宿主上报的本轮 agent 产出">
                  <input type="checkbox" checked={onlyAgent} onChange={(e) => setOnlyAgent(e.target.checked)} />
                  agent 产出
                </label>
                <label title="只看没人引用的文件">
                  <input
                    type="checkbox"
                    checked={onlyOrphans}
                    onChange={(e) => setOnlyOrphans(e.target.checked)}
                  />
                  孤立
                </label>
                <label title="只看还没读过的文件">
                  <input
                    type="checkbox"
                    checked={onlyUnread}
                    onChange={(e) => setOnlyUnread(e.target.checked)}
                  />
                  未读
                </label>
                <label title="隐藏已标记忽略的文件">
                  <input
                    type="checkbox"
                    checked={hideIgnored}
                    onChange={(e) => setHideIgnored(e.target.checked)}
                  />
                  隐藏忽略
                </label>
              </div>
              {/* 打开文件不带行号：回到上次读到的位置（N22） */}
              <FileTree
                tree={store.tree}
                activeFile={store.openFile}
                onOpen={(file) => jump(file)}
                filter={fileFilter}
                decor={decor}
                onToggleRead={toggleRead}
                onToggleIgnored={toggleIgnored}
                onAddToQueue={(file) => useGuideStore.getState().addQueue({ file, line: 1, col: 1 })}
              />
            </>
          )}

          {tab === 'outline' && (
            <OutlinePanel
              symbols={store.symbols}
              fileName={store.openFile}
              cursorLine={cursor.line}
              onJump={(s) => jump(s.location.file, s.location.range.start.line, s.location.range.start.col)}
              onCopySymbol={(s) => useStore.getState().copySymbolSummary(s)}
            />
          )}

          {tab === 'refs' && (
            <RefsPanel
              data={store.references}
              busy={store.referencesBusy}
              onJump={(file, line, col) => jump(file, line, col)}
              onCopy={copyLocation}
            />
          )}

          {tab === 'hierarchy' && (
            <div className="hierarchy-host">
              <div className="nav-switch wide">
                <button className={hierarchyKind === 'calls' ? 'active' : ''} onClick={() => setHierarchyKind('calls')}>
                  调用层级
                </button>
                <button className={hierarchyKind === 'types' ? 'active' : ''} onClick={() => setHierarchyKind('types')}>
                  类型层级
                </button>
              </div>
              {hierarchyKind === 'calls' ? (
                <CallsPanel
                  data={store.calls}
                  busy={store.callsBusy}
                  direction={store.callDirection}
                  depth={store.callDepth}
                  onDirection={(d) => useStore.getState().setCallDirection(d)}
                  onDepth={(d) => useStore.getState().setCallDepth(d)}
                  onJump={(file, line, col) => jump(file, line, col)}
                  onCopy={copyLocation}
                  onExplain={openExplain}
                  onFlow={openFlow}
                />
              ) : (
                <TypesPanel
                  data={store.types}
                  busy={store.typesBusy}
                  impls={store.impls}
                  implsBusy={store.implsBusy}
                  onJump={(file, line, col) => jump(file, line, col)}
                  onCopy={copyLocation}
                />
              )}
            </div>
          )}

          {tab === 'search' && (
            <div ref={searchInputRef} className="search-host">
              <SearchPanel
                hits={store.searchHits}
                busy={store.searchBusy}
                truncated={store.searchTruncated}
                query={searchQuery}
                history={store.searchHistory}
                dirs={searchDirOptions}
                selectedDirs={store.searchDirs}
                onDirsChange={(dirs) => useStore.getState().setSearchDirs(dirs)}
                onCancel={() => useStore.getState().cancelSearch()}
                onToggleFullscreen={() => setSearchFullscreen(true)}
                onSearch={(query, options) => {
                  setSearchQuery(query);
                  void useStore.getState().runSearch(query, options);
                }}
                onOpen={(file, line, col) => jump(file, line, col)}
                onQueue={(file, line, col) => useGuideStore.getState().addQueue({ file, line, col })}
              />
            </div>
          )}
          </div>
        </aside>

        <main className="main">
          <div className="nav-bar">
            <button
              className="btn ghost guide-home"
              onClick={() => setMainView('map')}
              title={t('guide.homeTitle')}
            >
              {t('guide.home')}
            </button>
            <button className="btn ghost" disabled={!canBack} onClick={() => void useStore.getState().goBack()} title="Alt+←">
              ←
            </button>
            <button
              className="btn ghost"
              disabled={!canForward}
              onClick={() => void useStore.getState().goForward()}
              title="Alt+→"
            >
              →
            </button>
            <nav className="crumbs">
              {rootName && <span className="crumb-root">{rootName}</span>}
              {store.openFile && (
                <span className="crumb" onClick={() => jump(store.openFile!, 1, 1)}>
                  {store.openFile}
                </span>
              )}
              {crumbs.map((s, i) => (
                <span key={`${s.name}:${s.location.range.start.line}`} className="crumb-wrap">
                  <span
                    className="crumb symbol"
                    onClick={() => {
                      setCrumbMenu(null);
                      jump(s.location.file, s.location.range.start.line, s.location.range.start.col);
                    }}
                  >
                    {s.name}
                  </span>
                  <span
                    className="crumb-caret"
                    title="同级符号"
                    onClick={(e) => {
                      e.stopPropagation();
                      // 同级 = 同容器内的符号（面包屑上一级的 children），优先同类（方法→方法）
                      const container = i === 0 ? store.symbols : crumbs[i - 1].children ?? [];
                      const sameKind = container.filter((x) => x.kind === s.kind);
                      const items = sameKind.length ? sameKind : container;
                      setCrumbMenu(items.length > 1 ? { items, currentName: s.name } : null);
                    }}
                  >
                    ▾
                  </span>
                </span>
              ))}
            </nav>
            {crumbMenu && (
              <>
                <div className="crumb-menu-backdrop" onClick={() => setCrumbMenu(null)} />
                <div className="crumb-menu">
                  <div className="crumb-menu-head">同级符号 · {crumbMenu.items.length}</div>
                  {crumbMenu.items.map((s) => (
                    <div
                      key={`${s.name}:${s.location.range.start.line}`}
                      className={`crumb-menu-item ${s.name === crumbMenu.currentName ? 'current' : ''}`}
                      onClick={() => {
                        setCrumbMenu(null);
                        jump(s.location.file, s.location.range.start.line, s.location.range.start.col);
                      }}
                    >
                      <span className="crumb-menu-name">{s.name}</span>
                      <span className="muted">L{s.location.range.start.line}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            {store.openFile && (
              <button
                className="btn ghost small"
                onClick={() =>
                  useStore.getState().toggleBookmark(store.openFile!, cursor.line, cursor.col)
                }
                title="Ctrl/Cmd+Shift+B：标记 / 取消标记当前行"
              >
                {bookmarked ? '★ 已标记' : '☆ 标记'}
              </button>
            )}
            {store.openFile && (
              <button
                className="btn ghost small"
                onClick={() => copyLocation(store.openFile!, cursor.line, cursor.col)}
                title="复制位置（Ctrl/Cmd+Alt+C）：path:line:col"
              >
                复制位置
              </button>
            )}
            {store.openFile && (
              <button
                className="btn ghost small"
                onClick={() => copySymbolAt(store.openFile!, cursor.line, cursor.col)}
                title="复制光标处符号摘要（名字 + 种类 + 签名 + 位置）；认不出符号时复制位置"
              >
                复制符号
              </button>
            )}
            {store.openFile && (
              <button
                className="btn ghost small"
                onClick={() => void useStore.getState().openInSecondary(store.openFile!, cursor.line, cursor.col)}
                title="在旁边打开：同时对照两个位置（N19）"
              >
                旁边打开
              </button>
            )}
            {store.openFile && (
              <button
                className="btn ghost map-toggle"
                onClick={() => setMainView(mainView === 'map' ? 'auto' : 'map')}
                title="项目地图：这个项目分几块、从哪开始读"
              >
                {mainView === 'map' ? '回到代码' : '项目地图'}
              </button>
            )}
            {/* M20 地图快照：当前视图（地图/依赖图/口径）已经写进 URL，这里只是把它交出去 */}
            {/* 05 信使：分享 / 导出 / 批注 / 给 agent 用（一个下拉收口，不再往顶栏堆按钮） */}
            <ShareMenu
              cursor={cursor}
              searchQuery={searchQuery}
              onOpenAnnotations={() => setTab('notes')}
            />
            <button
              className="btn ghost"
              title="把当前地图视图（含热点口径、依赖图展开的目录）复制成链接"
              onClick={() => {
                void navigator.clipboard
                  .writeText(window.location.href)
                  .then(() => useStore.getState().setError(null))
                  .catch(() => useStore.getState().setError('复制失败：浏览器拒绝了剪贴板访问'));
              }}
            >
              复制地图链接
            </button>
          </div>

          {/* N19：标签条（上限 8 + LRU + 同文件合并） */}
          {!showMap && store.tabs.length > 0 && (
            <div className="tabbar">
              {store.tabs.map((t) => (
                <span
                  key={t.file}
                  className={`tab ${t.file === store.openFile ? 'active' : ''}`}
                  onClick={() => jump(t.file, t.line, t.col)}
                  onAuxClick={() => void useStore.getState().openInSecondary(t.file)}
                  title={`${t.file}:${t.line}（中键：在旁边打开）`}
                >
                  <span className="tab-name">{t.file.split('/').pop()}</span>
                  <span
                    className="tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      useStore.getState().closeTab(t.file);
                      if (t.file === store.openFile && store.tabs.length > 1) {
                        const next = store.tabs.find((x) => x.file !== t.file);
                        if (next) jump(next.file, next.line, next.col);
                      }
                    }}
                  >
                    ✕
                  </span>
                </span>
              ))}
            </div>
          )}

          <div className="editor-wrap">
            {showMap ? (
              <Overview
                onOpenFile={(file, line) => jump(file, line ?? 1, 1)}
                onOpenGraph={() => setGraphOpen(true)}
                onOpenChanges={() => setTab('changes')}
              />
            ) : store.openFile ? (
              <div className={`panes ${store.secondary ? 'split' : ''}`}>
                <div className="pane">
                  <Editor
                    projectId={store.projectId}
                    file={store.openFile}
                    lang={store.fileLang}
                    content={store.fileContent}
                    reveal={store.reveal}
                    highlightsToken={store.highlightsToken}
                    onCursor={(line, col) => setCursor({ line, col })}
                    onPosition={(line, col, scrollTop) => rememberPosition(store.openFile!, line, col, scrollTop)}
                    onCopyLocation={copyLocation}
                    onCopySnippet={copySnippet}
                    onCopySymbol={copySymbolAt}
                    onOpenFile={jump}
                    annotations={store.annotations}
                    blame={blameOn ? blame?.lines ?? null : null}
                    onOpenHistory={openHistoryVersion}
                    onExplain={openExplain}
                    onFlow={openFlow}
                  />
                </div>
                {store.secondary && secondaryDoc && secondaryDoc.file === store.secondary.file && (
                  <div className="pane secondary">
                    <div className="pane-head">
                      <span className="pane-title" title={secondaryDoc.file}>
                        {secondaryDoc.file}
                        {secondaryDoc.rev && (
                          <span className="pane-rev">
                            {t('history.badge', { rev: secondaryDoc.rev.slice(0, 7) })}
                          </span>
                        )}
                      </span>
                      <button
                        className="btn ghost small"
                        onClick={() => useStore.getState().closeSecondary()}
                        title="关掉这一栏"
                      >
                        ✕
                      </button>
                    </div>
                    <Editor
                      projectId={store.projectId}
                      file={secondaryDoc.file}
                      lang={secondaryDoc.lang}
                      content={secondaryDoc.text}
                      reveal={store.secondary}
                      highlightsToken={store.highlightsToken}
                      onPosition={
                        secondaryDoc.rev
                          ? undefined
                          : (line, col, scrollTop) =>
                              rememberPosition(secondaryDoc.file, line, col, scrollTop)
                      }
                      onCopyLocation={copyLocation}
                      onCopySnippet={copySnippet}
                      onCopySymbol={copySymbolAt}
                      onOpenFile={jump}
                      annotations={store.annotations}
                      historyRev={secondaryDoc.rev}
                    />
                  </div>
                )}
              </div>
            ) : (
              // 死分支留给兜底：无项目时同样是三步引导（正常路径下主区总是项目地图）
              <div className="welcome">
                <Welcome
                  variant={store.projectId ? 'empty' : 'first'}
                  onOpenReport={reportAvailable ? () => setReportOpen(true) : undefined}
                />
              </div>
            )}
            {store.fileLoading && <div className="loading-mask">加载中…</div>}
          </div>

          <footer className="statusbar">
            <span>{store.openFile ?? '—'}</span>
            {cursorBlame && (
              <span className="blame-status" title={t('blame.title')}>
                {blameText(cursorBlame, t)}
              </span>
            )}
            <span className="spacer" />
            {store.flash && <span className="flash-text">{store.flash}</span>}
            {store.notice?.reason === 'no-symbol' && <span className="notice-hint">{store.notice.message}</span>}
            {store.fileLoading && <span>加载中…</span>}
            {guideSteps.length > 0 && (
              <button
                className="guide-status"
                disabled={!guideNext}
                onClick={() => guideNext && jump(guideNext)}
                title={guideNext ? t('guide.status.nextTitle') : t('guide.status.noNext')}
              >
                {t('guide.status.route', { done: guideDoneCount, total: guideSteps.length })}
                {guideNext
                  ? ` · ${t('guide.status.next', { file: guideNext })}`
                  : ` · ${t('guide.status.noNext')}`}
              </button>
            )}
            <span>
              Ln {cursor.line}, Col {cursor.col}
            </span>
            <span>{store.fileLang}</span>
            <span>{store.status?.indexing ? '索引中' : '就绪'}</span>
          </footer>
        </main>
      </div>

      {searchFullscreen && (
        <div className="search-overlay">
          <SearchPanel
            hits={store.searchHits}
            busy={store.searchBusy}
            truncated={store.searchTruncated}
            query={searchQuery}
            history={store.searchHistory}
            dirs={searchDirOptions}
            selectedDirs={store.searchDirs}
            onDirsChange={(dirs) => useStore.getState().setSearchDirs(dirs)}
            onCancel={() => useStore.getState().cancelSearch()}
            fullscreen
            onToggleFullscreen={() => setSearchFullscreen(false)}
            onSearch={(query, options) => {
              setSearchQuery(query);
              void useStore.getState().runSearch(query, options);
            }}
            onOpen={(file, line, col) => {
              setSearchFullscreen(false);
              jump(file, line, col);
            }}
            onQueue={(file, line, col) => useGuideStore.getState().addQueue({ file, line, col })}
          />
        </div>
      )}

      {diffFile && store.projectId && (
        <DiffPanel projectId={store.projectId} file={diffFile} onClose={() => setDiffFile(null)} />
      )}

      <GotoNoticeBar
        notice={store.notice}
        onDismiss={() => useStore.getState().dismissNotice()}
        onSearch={searchByName}
        onJump={jump}
      />

      {graphOpen && store.projectId && (
        <div className="graph-overlay">
          <GraphView
            projectId={store.projectId}
            activeFile={store.openFile}
            onOpenFile={(file, line) => jump(file, line ?? 1, 1)}
            onClose={() => setGraphOpen(false)}
            initial={{
              level: snapshot.get('glevel') === 'file' ? 'file' : 'dir',
              expand: (snapshot.get('gexpand') ?? '').split(',').filter(Boolean),
              external: snapshot.get('gext') !== '0',
              layout: snapshot.get('glayout') === 'free' ? 'free' : 'lanes',
            }}
            onViewChange={setGraphState}
          />
        </div>
      )}

      {/* W4 / G5.1：结构性解释浮层（纯静态，不使用模型） */}
      {explainTarget && store.projectId && (
        <div className="graph-overlay">
          <ExplainPanel
            onOpenFile={(file, line, col) => jump(file, line, col)}
            onClose={() => useExplainStore.getState().close()}
          />
        </div>
      )}

      {/* W5 / G9：调用流图浮层（calls / callers / 名字级近似的 data） */}
      {flowTarget && store.projectId && (
        <div className="graph-overlay">
          <FlowView
            key={`${flowTarget.file}:${flowTarget.line}:${flowTarget.col}`}
            projectId={store.projectId}
            focus={flowTarget}
            onOpenFile={(file, line) => jump(file, line ?? 1, 1)}
            onClose={() => setFlowTarget(null)}
          />
        </div>
      )}

      <QuickOpen
        mode={quick}
        projectId={store.projectId}
        tree={store.tree}
        recent={recentFiles}
        onClose={() => setQuick(null)}
        onOpenFile={jump}
      />

      {/* P24 / P17 / P9 浮层 */}
      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          onOpenPrivacy={() => {
            setSettingsOpen(false);
            setPrivacyOpen(true);
          }}
          onOpenReport={
            reportAvailable
              ? () => {
                  setSettingsOpen(false);
                  setReportOpen(true);
                }
              : undefined
          }
        />
      )}
      {privacyOpen && <PrivacyPanel onClose={() => setPrivacyOpen(false)} />}
      {reportOpen && store.projectId && (
        <IndexReportDialog projectId={store.projectId} onClose={() => setReportOpen(false)} />
      )}

      {store.error && (
        <div className="toast" onClick={() => useStore.getState().setError(null)}>
          {store.error}
          <button className="btn ghost" onClick={() => useStore.getState().setError(null)}>
            关闭
          </button>
        </div>
      )}
    </div>
  );
}

// 让 Monaco 的编辑器实例在模块加载后即可用（provider 注册依赖它）
void monaco;
