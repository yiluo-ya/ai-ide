/** 应用外壳：左栏（文件/code会话）+ 编辑器 + 项目地图 + 右栏（变更/命令/总览/大纲/搜索）+ 快捷键。 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { api } from './api';
import { ensureLanguages, guessLangFor } from './languages';
import { Editor } from './Editor';
import { FileTree, type TreeDecor } from './FileTree';
import { FileSearch, MIN_LEN } from './FileSearch';
import { CommandPanel } from './CommandPanel';
import { GraphView, type GraphViewState } from './GraphView';
import { AgentView } from './AgentView';
import { AgentSessions } from './AgentSessions';
import { useAgent } from './agentStore';
import { FlowView } from './FlowView';
import { Overview, OverviewPanel } from './Overview';
import { OutlinePanel, SearchPanel, symbolPathAt } from './SidePanel';
import { GotoNoticeBar, gotoFailureMessage } from './Notice';
import { QuickOpen, type QuickOpenMode } from './QuickOpen';
import { TopBar } from './TopBar';
import { SettingsPanel } from './SettingsPanel';
import { ModelDialog } from './ModelDialog';
import { Welcome } from './Welcome';
import { SIDEBAR_MAX, SIDEBAR_MIN, loadPrefs, savePrefs } from './prefs';
import { monaco, setProviderContext } from './monaco-setup';
import { listenPopState, showFlash, showToast, useStore } from './state';
import { ShareMenu } from './ShareMenu';
import { Dialog } from './Dialog';
import { initHostBridge } from './bridge';
import { useMapStore } from './mapState';
import { useGuideStore } from './guideState';
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
  | 'changes'
  | 'agent';

/**
 * 右栏常驻栏的入口（2026-10-03 用户要求）：变更 / 命令 / 总览 / 大纲 / 搜索。
 * 大纲与搜索原本在左栏，一起搬来右栏；五个入口一行放不下，按两行排（见 .dock-tabs）。
 */
type DockTab = 'changes' | 'service' | 'overview' | 'outline' | 'search';
const DOCK_TABS: DockTab[] = ['changes', 'service', 'overview', 'outline', 'search'];
/** 右栏入口的 hover 说明（每个入口一句「点开看到什么」）。 */
const DOCK_TITLE: Record<DockTab, string> = {
  changes: 'app.dockChangesTitle',
  service: 'app.dockServiceTitle',
  overview: 'app.dockOverviewTitle',
  outline: 'app.dockOutlineTitle',
  search: 'app.dockSearchTitle',
};

/** 左栏 tab（2026-10-03 用户要求）：只留「文件」与「code 会话」，其余都在右栏。 */
const LEFT_TABS: PanelTab[] = ['files', 'agent'];
/** 快捷键顺序的**唯一次序来源**：Ctrl/Cmd+1..4 = 文件 / 大纲 / 搜索 / code会话，0 = 最后一个。
 * 顺序不再等于左栏 tab 顺序（大纲 / 搜索搬去了右栏，由 openPanel 路由），键位保持不变。
 */
const PANEL_TABS: PanelTab[] = ['files', 'outline', 'search', 'agent'];
/** tab 文字对应的 i18n key（guide / changes 有各自的 key，单独处理）。 */
const TAB_TEXT: Record<string, string> = {
  overview: 'app.tab.overview',
  files: 'app.tab.files',
  outline: 'app.tab.outline',
  refs: 'app.tab.refs',
  hierarchy: 'app.tab.hierarchy',
  search: 'app.tab.search',
  agent: 'app.tab.agent',
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


export default function App() {
  const store = useStore();
  const { t } = useI18n();
  // 2026-10-03 用户要求移除向导面板：状态栏的「路线 · 下一步」提示与它依赖的派生值一并去掉。
  /** W4：结构性解释面板的目标（null = 关着）。 */
  const explainTarget = useExplainStore((s) => s.target);
  const [tab, setTab] = useState<PanelTab>(() => {
    // 左栏只剩文件 / code会话：URL 里的 outline / search 交给右栏（见下面的 dockTab 初值）
    const fromUrl = snapshot.get('tab') as PanelTab | null;
    return fromUrl && LEFT_TABS.includes(fromUrl) ? fromUrl : 'files';
  });
  /** W3：变更面板 tab 上的计数（变了几个文件）。 */
  // 变更计数 = git 报的未提交改动条数（2026-10-03：变更以 git 为准，不再自记录）
  const changesCount = useChangesStore((s) => s.result?.entries.length ?? 0);

  /** tab 文字：guide / changes 走 i18n，其余走 TAB_TEXT。 */
  const tabLabel = (id: PanelTab) =>
    id === 'guide' ? t('guide.tab') : id === 'changes' ? t('changes.tab') : t(TAB_TEXT[id]);

  /** tab 上的计数（变更）。 */
  const tabCount = (id: PanelTab) => (id === 'changes' ? changesCount : 0);

  /** 一个 tab 按钮（常驻直接排；辅助的在「更多」菜单里复用同一套文字与计数）。 */
  const renderTabButton = (id: PanelTab) => {
    const count = tabCount(id);
    const title = id === 'changes' ? t('changes.tabTitle') : undefined;
    return (
      <button
        key={id}
        role="tab"
        id={`wcr-tab-${id}`}
        aria-selected={tab === id}
        aria-controls="wcr-side-panel"
        className={tab === id ? 'active' : ''}
        onClick={() => {
          setTab(id);
          // 2026-10-03：顶栏「Agent 对话」入口已删 —— 点「code会话」tab 直接把主区切到 Agent
          if (id === 'agent' && store.projectId) setMainView('agent');
        }}
        title={title}
      >
        {tabLabel(id)}
        {count > 0 && <span className="tab-count">{count}</span>}
      </button>
    );
  };
  const [quick, setQuick] = useState<QuickOpenMode>(null);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [fileFilter, setFileFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [crumbMenu, setCrumbMenu] = useState<CrumbMenu | null>(null);
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
  // 2026-10-03：主区可在「代码 / 地图 / Agent 会话」之间切；agent 不入 URL
  const [mainView, setMainView] = useState<'auto' | 'map' | 'agent'>(() => (snapshot.get('view') === 'map' ? 'map' : 'auto'));
  const [graphOpen, setGraphOpen] = useState(() => snapshot.get('graph') === '1');
  /** 2026-10-03：code-agent 会话（左栏管会话 + 中间看内容，见 mainView === 'agent'）。 */
  /** W5：流视图浮层的焦点（null = 关着）。 */
  const [flowTarget, setFlowTarget] = useState<{ file: string; line: number; col: number } | null>(null);
  const [graphState, setGraphState] = useState<GraphViewState | null>(null);
  const [recentFilter, setRecentFilter] = useState<RecentFilter>('all');
  const [onlyOrphans, setOnlyOrphans] = useState(false);
  /** P24 的浮层：设置 · 模型（模型与设置平级，2026-10-03 用户要求）。 */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  /** W3 / G7.2：只读 diff 浮层的目标文件（null = 关着）；点变更行的增删行数触发。 */
  const [diffFile, setDiffFile] = useState<string | null>(null);
  /**
   * 二次确认（2026-10-03 用户要求）：重建索引 / 移除项目都是不可逆或有代价的动作，
   * 误点一下就跑掉不合理 —— 先把「会发生什么」说清楚再执行。
   */
  const [confirmAction, setConfirmAction] = useState<{ kind: 'reindex' | 'forget'; id?: string } | null>(null);
  /** 右侧常驻栏：默认展开（默认值来自设置），宽度可拖，可收起。 */
  const [changesDockOpen, setChangesDockOpen] = useState(() => loadPrefs().changesOpen);
  const [changesDockWidth, setChangesDockWidth] = useState(280);
  /**
   * 右侧栏里的五个入口，分两行排（变更 / 命令 / 总览 ｜ 大纲 / 搜索），默认变更。
   * 「变更」= git 工作区改动清单 + 四个常用命令；「命令」= 服务状态与重启 / 停止；
   * 「总览」= 规模 / 起点 / 结构告警 / 本轮产出；「大纲」「搜索」2026-10-03 从左栏搬来。
   * 初值兼容旧链接：URL 里 tab=outline / search 时直接打开右栏对应入口。
   */
  const [dockTab, setDockTab] = useState<DockTab>(() => {
    const fromUrl = snapshot.get('tab') as DockTab | null;
    return fromUrl && DOCK_TABS.includes(fromUrl) ? fromUrl : 'changes';
  });

  /** 打开某个面板：大纲 / 搜索在右栏（顺带把右栏展开），其余在左栏。 */
  const openPanel = useCallback((id: PanelTab) => {
    if (id === 'outline' || id === 'search') {
      setChangesDockOpen(true);
      setDockTab(id);
      return;
    }
    setTab(id);
  }, []);
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
  const mapPulse = useMapStore((s) => s.pulse);
  const mapOptions = useMapStore((s) => s.options);

  useEffect(() => {
    void store.init();
    // 语言元数据（07-languages-plugin）：Monaco Provider 与扩展名推断都等它到位。
    void ensureLanguages();
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
            message: translate('app.noticeIndexing'),
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

  // 2026-10-03 用户要求移除「向导 / 引用 / 层级」：层级面板的按需查询 effect 一并删除。
  // 组件（NavPanels / GuidePanel / SidePanel 的 RefsPanel）与后端接口保留，日后要恢复只需接回入口。

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
        lang: target.lang ?? guessLangFor(target.file),
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
      } else if (mod && !e.shiftKey && /^[0-9]$/.test(key)) {
        // N-δ：键盘可达 —— Ctrl/Cmd+1..4 = 左栏四个 tab（文件 / 大纲 / 搜索 / code会话），0 = 最后一个。
        e.preventDefault();
        // 面板搬走后 PANEL_TABS 会变短：越界时什么都不做（否则会 setTab(undefined)，看上去像面板空了）
        const next = key === '0' ? PANEL_TABS[PANEL_TABS.length - 1] : PANEL_TABS[Number(key) - 1];
        if (next) openPanel(next);
      } else if (mod && e.shiftKey && key === 'f') {
        e.preventDefault();
        openPanel('search');
        // 搜索框现在挂在右栏：展开 + 切到该入口后才在，所以晚一拍聚焦
        setTimeout(() => {
          searchInputRef.current?.querySelector('input')?.focus();
        }, 0);
      } else if (mod && e.shiftKey && key === 'o') {
        e.preventDefault();
        openPanel('outline');
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
  }, [store.openFile, cursor.line, cursor.col, openPanel]);

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
      useChangesStore.getState().reset();
      useExplainStore.getState().reset();
      return;
    }
    void useMapStore.getState().load(id);
    void useGuideStore.getState().load(id);
    void useChangesStore.getState().load(id);
  }, [store.projectId, store.status?.indexedAt, store.tree]);

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

  /** 右侧变更栏宽度拖拽（220~560）。变更栏在右边，所以是「往左拖变宽」。 */
  const clampDock = (w: number) => Math.max(220, Math.min(560, Math.round(w)));
  const onChangesDockResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const target = e.currentTarget;
    const startX = e.clientX;
    const startWidth = clampDock(changesDockWidth);
    target.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => setChangesDockWidth(clampDock(startWidth - (ev.clientX - startX)));
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
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
        useStore.getState().openSecondaryText(res.file, res.text, guessLangFor(res.file), res.rev);
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
    // 2026-10-03 用户要求去掉「已读 / 未读」标准：不再往文件树叠 read / ignored，也不再按未读过滤。

    const filtering = recentFilter !== 'all' || onlyOrphans;
    let visible: Set<string> | undefined;
    if (filtering) {
      const cutoff = recentFilter === 'all' ? 0 : recentCutoff(recentFilter);
      visible = new Set(
        collectFiles(store.tree).filter((file) => {
          const fact = timeline.get(file);
          if (recentFilter !== 'all' && !(fact && fact.mtimeMs >= cutoff)) return false;
          if (onlyOrphans && !orphans.has(file)) return false;
          return true;
        }),
      );
    }
    return { timeline, orphans, hot, pulse, dirs, visible };
  }, [mapTimeline, mapOverview, mapPulse, store.tree, recentFilter, onlyOrphans]);

  /** 没有打开文件时，主区就是项目地图（落点 C：首屏即主页）。 */
  // agent 模式下强制不显示地图（地图与 agent 都占主区）
  const showMap = mainView !== 'agent' && (mainView === 'map' || !store.openFile);

  /** 提示条上的「退而求其次」动作：拿符号名发起项目内全文搜索（N2）。 */
  const searchByName = (name: string) => {
    openPanel('search');
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

  return (
    <div className="app">
      <TopBar
        projects={store.projects}
        project={store.project}
        status={store.status}
        openFile={store.openFile}
        onSelect={(id) => void useStore.getState().selectProject(id)}
        onOpenFolder={(root) => void useStore.getState().openFolder(root)}
        onForget={(id) => setConfirmAction({ kind: 'forget', id })}
        onReindex={() => setConfirmAction({ kind: 'reindex' })}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenModel={() => setModelOpen(true)}
      />

      <div className="body">
        <aside className="sidebar">
          {/* P24：侧栏宽拖拽把手（键盘 ←/→ 同效） */}
          <div
            className="sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('app.resizeSidebar')}
            tabIndex={0}
            onPointerDown={onSidebarResizeStart}
            onKeyDown={onSidebarResizeKey}
          />
          {/* tab 顺序只来自 LEFT_TABS（快捷键用同一份），不要再在这里手写一遍 */}
          <div className="panel-tabs" role="tablist" aria-label={t('app.sidebarPanels')}>
            {LEFT_TABS.map((id) => renderTabButton(id))}
          </div>

          {/* P25：面板容器补 tabpanel 语义（aria-labelledby 指向当前 tab） */}
          <div className="panel-body" role="tabpanel" id="wcr-side-panel" aria-labelledby={`wcr-tab-${tab}`}>

          {/* 「变更」「命令」「总览」都在右侧常驻栏（见 .dock-changes），不再占侧栏 tab */}

          {tab === 'files' && (
            <>
              <input
                className="text-input sidebar-filter"
                placeholder={t('app.filterPlaceholder', { min: MIN_LEN })}
                value={fileFilter}
                onChange={(e) => setFileFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setFileFilter('');
                }}
              />
              {/* 2026-10-03：文件名过滤与内容搜索共用一个输入框（≥4 字才搜内容） */}
              <FileSearch query={fileFilter} onOpen={(file, line, col) => jump(file, line, col)} />
              <div className="tree-views">
                <select
                  className="ov-select"
                  value={recentFilter}
                  onChange={(e) => setRecentFilter(e.target.value as RecentFilter)}
                  title={t('app.recentFilterTitle')}
                >
                  <option value="all">{t('app.recentAll')}</option>
                  <option value="today">{t('app.recentToday')}</option>
                  <option value="3d">{t('app.recent3d')}</option>
                  <option value="7d">{t('app.recent7d')}</option>
                </select>
                <label title={t('app.onlyOrphansTitle')}>
                  <input
                    type="checkbox"
                    checked={onlyOrphans}
                    onChange={(e) => setOnlyOrphans(e.target.checked)}
                  />
                  {t('app.orphan')}
                </label>
              </div>
              {/* 打开文件不带行号：回到上次读到的位置（N22） */}
              <FileTree
                tree={store.tree}
                activeFile={store.openFile}
                onOpen={(file) => jump(file)}
                filter={fileFilter}
                decor={decor}
                onAddToQueue={(file) => useGuideStore.getState().addQueue({ file, line: 1, col: 1 })}
                onCopy={(text) => useStore.getState().copyText(text)}
              />
            </>
          )}

          {/* 大纲 / 搜索 已搬到右栏（见 .dock-changes 里的 dockTab 分支） */}

          {tab === 'agent' &&
            (store.projectId ? (
              <AgentSessions
                projectId={store.projectId}
                onBack={() => setMainView('auto')}
                onOpen={() => setMainView('agent')}
              />
            ) : (
              <div className="panel-empty">{t('app.noProject')}</div>
            ))}
          </div>
        </aside>

        <main className="main">
          {mainView === 'agent' ? (
            <AgentView
              projectId={store.projectId ?? ''}
              projectName={store.project?.name ?? store.projectId ?? ''}
              onBack={() => setMainView('auto')}
            />
          ) : (
            <>
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
                    title={t('app.siblingSymbols')}
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
                  <div className="crumb-menu-head">{t('app.siblingSymbolsHead', { n: crumbMenu.items.length })}</div>
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
                onClick={() => copyLocation(store.openFile!, cursor.line, cursor.col)}
                title={t('app.copyLocationTitle')}
              >
                {t('app.copyLocation')}
              </button>
            )}
            {store.openFile && (
              <button
                className="btn ghost small"
                onClick={() => void useStore.getState().openInSecondary(store.openFile!, cursor.line, cursor.col)}
                title={t('app.openAsideTitle')}
              >
                {t('app.openAside')}
              </button>
            )}
            {store.openFile && (
              <button
                className="btn ghost map-toggle"
                onClick={() => setMainView(mainView === 'map' ? 'auto' : 'map')}
                title={t('app.mapToggleTitle')}
              >
                {mainView === 'map' ? t('app.backToCode') : t('app.projectMap')}
              </button>
            )}
            {/* 05 信使：分享 / 导出 / 批注 / 给 agent 用（一个下拉收口，不再往顶栏堆按钮） */}
            <ShareMenu
              cursor={cursor}
              searchQuery={searchQuery}
            />
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
                  title={translate('app.tabTooltip', { file: t.file, line: t.line })}
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
                    onOpenFile={jump}
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
                        title={t('app.closePane')}
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
                      onOpenFile={jump}
                      historyRev={secondaryDoc.rev}
                    />
                  </div>
                )}
              </div>
            ) : (
              // 死分支留给兜底：无项目时同样是三步引导（正常路径下主区总是项目地图）
              <div className="welcome">
                <Welcome variant={store.projectId ? 'empty' : 'first'} />
              </div>
            )}
            {store.fileLoading && <div className="loading-mask">{t('app.loading')}</div>}
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
            {store.fileLoading && <span>{t('app.loading')}</span>}
            <span>
              Ln {cursor.line}, Col {cursor.col}
            </span>
            <span>{store.fileLang}</span>
            <span>{store.status?.indexing ? t('app.indexing') : t('app.ready')}</span>
          </footer>
            </>
          )}
        </main>

        {/* 2026-10-03 用户要求：「变更」「命令」都常驻在右边（不再占侧栏 tab），默认显示变更。 */}
        {store.projectId && (
          <aside
            className={`dock-changes ${changesDockOpen ? '' : 'collapsed'}`}
            style={changesDockOpen ? { width: changesDockWidth } : undefined}
            aria-label={t('app.dockAria')}
          >
            {changesDockOpen && (
              <div
                className="dock-resizer"
                role="separator"
                aria-orientation="vertical"
                aria-label={t('app.resizeDock')}
                tabIndex={0}
                onPointerDown={onChangesDockResizeStart}
              />
            )}
            <div className="dock-head">
              <button
                className="dock-toggle"
                onClick={() => setChangesDockOpen((v) => !v)}
                title={changesDockOpen ? t('app.collapseDock') : t('app.expandDock')}
              >
                {changesDockOpen ? '▸' : '◂'}
              </button>
              {changesDockOpen && (
                <div className="dock-tabs" role="tablist" aria-label={t('app.dockPanels')}>
                  {DOCK_TABS.map((id) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      id={`wcr-dock-tab-${id}`}
                      aria-selected={dockTab === id}
                      className={`dock-tab${dockTab === id ? ' active' : ''}`}
                      title={t(DOCK_TITLE[id])}
                      onClick={() => setDockTab(id)}
                    >
                      {id === 'changes'
                        ? t('changes.tab')
                        : id === 'service'
                          ? t('app.dockService')
                          : t(TAB_TEXT[id])}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {changesDockOpen && (
              <div className="dock-body">
                {dockTab === 'changes' ? (
                  <ChangesPanel onOpenFile={(file) => jump(file)} onOpenDiff={(file) => setDiffFile(file)} />
                ) : dockTab === 'service' ? (
                  <CommandPanel
                    projectId={store.projectId}
                    project={store.project}
                    onOpenSession={(sessionId) => {
                      const agent = useAgent.getState();
                      void agent.refreshSessions().then(() => agent.select(sessionId));
                      setMainView('agent');
                    }}
                  />
                ) : dockTab === 'overview' ? (
                  <OverviewPanel
                    onOpenFile={(file, line) => jump(file, line ?? 1, 1)}
                    onOpenMap={() => setMainView('map')}
                    onOpenGraph={() => setGraphOpen(true)}
                  />
                ) : dockTab === 'outline' ? (
                  <OutlinePanel
                    symbols={store.symbols}
                    fileName={store.openFile}
                    cursorLine={cursor.line}
                    onJump={(s) => jump(s.location.file, s.location.range.start.line, s.location.range.start.col)}
                  />
                ) : (
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
            )}
          </aside>
        )}
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

      {/* P24 浮层：设置 · 模型 */}
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      {modelOpen && <ModelDialog onClose={() => setModelOpen(false)} />}

      {confirmAction && (
        <Dialog
          title={t(confirmAction.kind === 'reindex' ? 'app.confirmReindexTitle' : 'app.confirmRemoveTitle')}
          onClose={() => setConfirmAction(null)}
        >
          <p className="confirm-text">
            {confirmAction.kind === 'reindex'
              ? t('app.confirmReindexBody')
              : t('app.confirmRemoveBody')}
          </p>
          <div className="confirm-actions">
            <button className="btn ghost" onClick={() => setConfirmAction(null)}>
              {t('common.cancel')}
            </button>
            <button
              className="btn"
              onClick={() => {
                const action = confirmAction;
                setConfirmAction(null);
                if (action.kind === 'reindex') void useStore.getState().reindex();
                else if (action.id) void useStore.getState().forgetProject(action.id);
              }}
            >
              {t(confirmAction.kind === 'reindex' ? 'app.confirmReindexOk' : 'app.confirmRemoveOk')}
            </button>
          </div>
        </Dialog>
      )}

      {store.error && (
        <div className="toast" onClick={() => useStore.getState().setError(null)}>
          {store.error}
          <button className="btn ghost" onClick={() => useStore.getState().setError(null)}>
            {t('common.close')}
          </button>
        </div>
      )}

      {/* 命令结果冒泡（2026-10-03）：变更栏的 git 命令结果走这里，点一下收起 */}
      {store.toast && (
        <div
          className={`toast-run ${store.toast.ok ? 'ok' : 'bad'}`}
          role="status"
          title={t('app.clickClose')}
          onClick={() => showToast(null)}
        >
          {store.toast.text}
        </div>
      )}
    </div>
  );
}

// 让 Monaco 的编辑器实例在模块加载后即可用（provider 注册依赖它）
void monaco;
