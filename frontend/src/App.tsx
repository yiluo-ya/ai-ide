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
import { Breadcrumbs } from './Breadcrumbs';
import { ActivityBar } from './ActivityBar';
import { moveView, reorderView, setActiveView, useLayout, viewsOn, type ViewId } from './layout';
import { OutputPanel } from './OutputPanel';
import { TerminalPanel, type RunRequest } from './TerminalPanel';
import { isRunnable } from './runCommand';
import { GraphView, type GraphViewState } from './GraphView';
import { AgentView } from './AgentView';
import { AgentSessions } from './AgentSessions';

import { FlowView } from './FlowView';
import { Overview } from './Overview';
import { OutlinePanel, SearchPanel } from './SidePanel';
import { ApiPanel } from './ApiPanel';
import { GotoNoticeBar, gotoFailureMessage } from './Notice';
import { QuickOpen, type QuickOpenMode } from './QuickOpen';
import { TopBar } from './TopBar';
import { HelpPopover } from './HelpPopover';
import { SettingsPanel } from './SettingsPanel';
import { ModelDialog } from './ModelDialog';
import { Welcome } from './Welcome';
import { SIDEBAR_MAX, SIDEBAR_MIN, loadPrefs, savePrefs } from './prefs';
import { eventToGesture, resolveAction, sidePanelModifier } from './keymap';
import { monaco, setProviderContext } from './monaco-setup';
import { listenPopState, showFlash, showToast, useStore } from './state';
import { SummaryBar } from './SummaryBar';
import { Dialog } from './Dialog';
import { initHostBridge } from './bridge';
import { useMapStore } from './mapState';
import { purgeLegacyReadState } from './marks';
import { useGuideStore } from './guideState';
import { ExplainPanel } from './ExplainPanel';
import { useExplainStore } from './explainState';
import { ChangesPanel } from './ChangesPanel';
import { DiffPanel } from './DiffPanel';
import { useChangesStore } from './changesState';
import { changesApi, flushSnapshot } from './readSnapshot';
import { blameAt, blameText, loadBlame } from './blame';
import { translate, useI18n } from './i18n';
import type { BlameResult, FileNode, FileOrigin, GitChangeEntry, RunConfigResult, RunProfile } from '../../shared/types';
import type { HotMetric } from './mapApi';

type PanelTab = 'guide' | 'files' | 'refs' | 'hierarchy' | 'outline' | 'search' | 'changes' | 'git' | 'agent' | 'api';

/**
 * 底部面板的入口（VS Code 布局迁移 2026-10-08）：输出 / 终端。
 * 输出 = 命令运行历史（跑测试 / 编译结果）；终端 = 占位空壳（PTY 后置）。
 */
type BottomTab = 'output' | 'terminal';
const BOTTOM_TABS: BottomTab[] = ['output', 'terminal'];
/** 本机回环地址：非回环访问 = 分享模式（后端终端整层拒绝，运行入口一并禁用）。 */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const BOTTOM_TITLE: Record<BottomTab, string> = {
  output: 'app.panelOutput',
  terminal: 'app.panelTerminal',
};

/**
 * 快捷键顺序的**唯一次序来源**：Ctrl/Cmd+1..6 = 文件 / 搜索 / 源码管理 / code会话 / 大纲 / 接口，0 = 最后一个。
 * 视图实际在哪一侧由 layout.ts 决定；快捷键聚焦到该视图所在侧。
 */
const PANEL_TABS: ViewId[] = ['files', 'search', 'git', 'agent', 'outline', 'api'];
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
  const layout = useLayout();
  // 左栏 / 右栏当前视图：由左右活动栏选中，位置在 layout.ts（localStorage 持久化）。
  const tab: PanelTab = layout.active.left;
  const dockTab: PanelTab = layout.active.right;
  /** W3：变更面板 tab 上的计数（变了几个文件）。 */
  // 变更计数 = git 报的未提交改动条数（2026-10-03：变更以 git 为准，不再自记录）
  const changesCount = useChangesStore((s) => s.result?.entries.length ?? 0);
  /** 文件树染色用：文件 → git 工作区状态（引用稳定，changesState 内容未变就不换对象）。 */
  const changesEntries = useChangesStore((s) => s.result?.entries);

  /**
   * 选中某侧视图；点「code会话」时主区切到 Agent。
   * 2026-10-15 需求 8：再点该侧已激活的图标 = 收拢那一侧；该侧收拢时点图标 = 展开并选中。
   */
  const onSelectView = (side: 'left' | 'right', id: ViewId) => {
    const open = side === 'left' ? sidebarOpen : changesDockOpen;
    if (layout.active[side] === id && open) {
      if (side === 'left') setSidebarOpen(false);
      else setChangesDockOpen(false);
      return;
    }
    setActiveView(side, id);
    if (side === 'left') setSidebarOpen(true);
    else setChangesDockOpen(true);
    // 活动栏与主区联动：点 code 会话 → 主区看会话；从会话切到别的面板（文件 / 搜索…）→ 主区回代码视图。
    // 只在当前确实停在会话视图时才回（不碰用户手动开的项目地图）。
    if (id === 'agent') {
      if (store.projectId) showAgent();
    } else if (mainView === 'agent') {
      backToCode();
    }
  };
  const [quick, setQuick] = useState<QuickOpenMode>(null);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  /** 状态栏：当前选区的字符数 / 行数（无选区时为 null）。 */
  const [selection, setSelection] = useState<{ chars: number; lines: number } | null>(null);
  const [fileFilter, setFileFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFullscreen, setSearchFullscreen] = useState(false);
  /** 标签右键菜单：记录鼠标位置（视口坐标）与目标文件；null = 不显示。 */
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; file: string } | null>(null);
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
  const [mainView, setMainView] = useState<'auto' | 'map' | 'agent'>(() =>
    snapshot.get('view') === 'map' ? 'map' : 'auto',
  );
  const [graphOpen, setGraphOpen] = useState(() => snapshot.get('graph') === '1');
  /** 2026-10-03：code-agent 会话（左栏管会话 + 中间看内容，见 mainView === 'agent'）。 */
  /** W5：流视图浮层的焦点（null = 关着）。 */
  const [flowTarget, setFlowTarget] = useState<{ file: string; line: number; col: number } | null>(null);
  const [graphState, setGraphState] = useState<GraphViewState | null>(null);
  const [recentFilter, setRecentFilter] = useState<RecentFilter>('all');
  const [onlyOrphans, setOnlyOrphans] = useState(false);
  /** FR-0012：文件树的两条外部信号（自增触发；FileTree 侧监听）。 */
  const [treeRevealToken, setTreeRevealToken] = useState(0);
  const [treeCollapseToken, setTreeCollapseToken] = useState(0);
  /** 2026-10-15：展开全部（与收拢对称的第三条信号）。 */
  const [treeExpandToken, setTreeExpandToken] = useState(0);
  /** P24 的浮层：设置 · 模型（模型与设置平级，2026-10-03 用户要求）。
   *  2026-10-15 需求 3：三者的入口从左下活动栏底部进（竖排图标）。 */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  /** 左下角「快捷键」图标弹出的浮层（内容与原先顶栏的 ? 一致）。 */
  const [helpOpen, setHelpOpen] = useState(false);
  /** W3 / G7.2：只读 diff 浮层的目标文件（null = 关着）；点变更行的增删行数触发。 */
  const [diffFile, setDiffFile] = useState<string | null>(null);
  /**
   * 二次确认（2026-10-03 用户要求）：重建索引 / 移除项目都是不可逆或有代价的动作，
   * 误点一下就跑掉不合理 —— 先把「会发生什么」说清楚再执行。
   */
  const [confirmAction, setConfirmAction] = useState<{
    kind: 'reindex' | 'forget' | 'delete';
    id?: string;
    /** FR-0008：待删路径（kind=delete）。 */
    path?: string;
    isDir?: boolean;
  } | null>(null);
  /**
   * FR-0009：新建 / 重命名 / 移动 / 复制一份 的参数收集（共用一个输入弹窗）。
   * 这里只管收集与拼路径，磁盘动作全部交给 store（索引跟随与提示也在那边）。
   */
  const [fsPrompt, setFsPrompt] = useState<FsPrompt | null>(null);
  const [fsValue, setFsValue] = useState('');
  const fsInputRef = useRef<HTMLInputElement>(null);
  // Dialog 挂载后会 focus 浮层容器（子组件 effect 先跑），所以在父 effect 里补一次聚焦
  useEffect(() => {
    if (fsPrompt) fsInputRef.current?.focus();
  }, [fsPrompt]);

  // 换文件时清掉上一份的选区读数（Editor 复用同一个实例，不会自动清）
  useEffect(() => setSelection(null), [store.openFile]);

  const openFsPrompt = (next: FsPrompt) => {
    setFsPrompt(next);
    if (next.kind === 'rename') setFsValue(next.path.split('/').pop() ?? next.path);
    else if (next.kind === 'duplicate') setFsValue(duplicateEntryName(next.path));
    else if (next.kind === 'move') setFsValue(next.path.split('/').slice(0, -1).join('/'));
    else setFsValue('');
  };

  const submitFsPrompt = () => {
    if (!fsPrompt) return;
    // 名字里允许 `/`（新建可一路建中间目录）；首尾斜杠去掉，其余交给后端校验
    const name = fsValue
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '');
    const s = useStore.getState();
    if (fsPrompt.kind === 'newFile' || fsPrompt.kind === 'newDir') {
      if (!name) return;
      void s.createEntry(fsPrompt.dir, name, fsPrompt.kind === 'newDir');
    } else if (fsPrompt.kind === 'move') {
      const base = fsPrompt.path.split('/').pop() ?? fsPrompt.path;
      void s.renameEntry(fsPrompt.path, name ? `${name}/${base}` : base);
    } else {
      // 重命名 / 复制一份：只换名字，不许带 `/`
      if (!name || name.includes('/')) return;
      const dir = fsPrompt.path.split('/').slice(0, -1).join('/');
      const to = dir ? `${dir}/${name}` : name;
      if (fsPrompt.kind === 'rename') void s.renameEntry(fsPrompt.path, to);
      else void s.copyEntry(fsPrompt.path, to);
    }
    setFsPrompt(null);
    setFsValue('');
  };

  /** FR-0009：拖拽移动（`toDir` 空串 = 项目根）。 */
  const moveInto = (from: string, toDir: string) => {
    const base = from.split('/').pop() ?? from;
    const to = toDir ? `${toDir}/${base}` : base;
    if (to !== from) void useStore.getState().renameEntry(from, to);
  };

  const fsPromptText = fsPrompt
    ? fsPrompt.kind === 'newFile'
      ? { title: t('prompt.newFileTitle'), label: t('prompt.nameLabel'), hint: t('prompt.newHint') }
      : fsPrompt.kind === 'newDir'
        ? { title: t('prompt.newDirTitle'), label: t('prompt.nameLabel'), hint: t('prompt.newHint') }
        : fsPrompt.kind === 'rename'
          ? { title: t('prompt.renameTitle'), label: t('prompt.renameLabel'), hint: null }
          : fsPrompt.kind === 'duplicate'
            ? { title: t('prompt.copyTitle'), label: t('prompt.copyLabel'), hint: null }
            : { title: t('prompt.moveTitle'), label: t('prompt.moveLabel'), hint: t('prompt.moveHint') }
    : null;
  /** 右侧常驻栏：默认展开（默认值来自设置），宽度可拖，可收起。 */
  const [changesDockOpen, setChangesDockOpen] = useState(() => loadPrefs().changesOpen);
  const [changesDockWidth, setChangesDockWidth] = useState(280);
  /** 左侧内容栏显隐（2026-10-08：左下角「左/右/下」三开关控制三区域收放）。 */
  const [sidebarOpen, setSidebarOpen] = useState(true);
  /**
   * 右侧栏里的五个入口，分两行排（变更 / 命令 / 总览 ｜ 大纲 / 搜索），默认变更。
   * 「变更」= git 工作区改动清单 + 四个常用命令；「命令」= 服务状态与重启 / 停止；
   * 「总览」= 规模 / 起点 / 结构告警 / 本轮产出；「大纲」「搜索」2026-10-03 从左栏搬来。
   * 初值兼容旧链接：URL 里 tab=outline / search 时直接打开右栏对应入口。
   */
  /** 底部面板：默认收拢（2026-10-15 需求 9）、默认「输出」页。 */
  const [bottomOpen, setBottomOpen] = useState(false);
  const [bottomTab, setBottomTab] = useState<BottomTab>('output');
  /** 底部面板高度（px），拖动顶边调整。 */
  const [bottomHeight, setBottomHeight] = useState(220);

  /**
   * 2026-10-15 用户要求：进 Code Agent 时把底部面板收拢，回到代码时**还原进来前的样子**。
   * 只在「在 Agent 里没自己动过底部面板」时还原 —— 用户为装 pi 特意开了终端，别抢他的状态。
   */
  const codeBottomRef = useRef<{ open: boolean; tab: BottomTab } | null>(null);
  const showAgent = useCallback(() => {
    codeBottomRef.current = { open: bottomOpen, tab: bottomTab };
    setBottomOpen(false);
    setMainView('agent');
  }, [bottomOpen, bottomTab]);
  const backToCode = useCallback(() => {
    const saved = codeBottomRef.current;
    codeBottomRef.current = null;
    setMainView('auto');
    if (saved && !bottomOpen) {
      setBottomTab(saved.tab);
      setBottomOpen(saved.open);
    }
  }, [bottomOpen]);

  /**
   * FR-0011「在终端中运行」：token 自增的一次运行请求，交给 TerminalPanel 写进激活终端。
   *
   * 2026-10-20：不再在这里缓存 Python 探测结果 —— 运行时要「每次入口重探」（新建 venv、
   * 装了新 JDK 之后要立刻能反映）；Python 解释器改由项目运行配置统一决定
   * （`GET /run-config` 的 runtimes 摘要）。
   */
  const [runRequest, setRunRequest] = useState<RunRequest | null>(null);
  const runTokenRef = useRef(0);
  /** 当前项目的运行配置（运行档 + 实际运行时摘要）；切项目重新拉。 */
  const [runConfig, setRunConfig] = useState<RunConfigResult | null>(null);
  const [runMenuOpen, setRunMenuOpen] = useState(false);

  /** 打开某个面板：视图在哪一侧就聚焦那一侧；在右侧时顺带展开右侧栏。 */
  const openPanel = useCallback(
    (id: ViewId) => {
      if (layout.sides[id] === 'right') {
        setChangesDockOpen(true);
        setActiveView('right', id);
        return;
      }
      setActiveView('left', id);
    },
    [layout.sides],
  );

  /**
   * FR-0012：把某个文件定位到文件树里（工具按钮 / 快捷键 / 标签右键共用）。
   * 过滤态下树里可能根本没有它，先把文件名过滤清掉，再发「定位」信号。
   */
  const revealFileInTree = useCallback(
    (file: string | null) => {
      if (!file) return;
      setSidebarOpen(true);
      openPanel('files');
      setFileFilter('');
      setTreeRevealToken((n) => n + 1);
    },
    [openPanel],
  );

  /** FR-0012：收拢文件树里所有文件夹。 */
  const collapseAllInTree = useCallback(() => {
    setSidebarOpen(true);
    openPanel('files');
    setTreeCollapseToken((n) => n + 1);
  }, [openPanel]);

  /** 2026-10-15：展开文件树所有文件夹（与收拢对称，工具行图标触发）。 */
  const expandAllInTree = useCallback(() => {
    setSidebarOpen(true);
    openPanel('files');
    setTreeExpandToken((n) => n + 1);
  }, [openPanel]);

  /**
   * FR-0011：在终端里运行一个文件（文件树右键 / 编辑器右键 / 标签栏 ▶ / Ctrl+F5 共用）。
   * - 运行时（Python 解释器等）由**项目运行配置**决定：每次点都重拉一次 run-config（见 2026-10-20）；
   * - 环境变量 / PATH 前插 / JAVA_HOME 由后端在 PTY spawn 时注入，不拼进命令；
   * - 展开底部面板并切到「终端」，把请求交给 TerminalPanel（它知道当前 pane 用哪种 shell）。
   */
  const runFileInTerminal = useCallback((file: string) => {
    const s = useStore.getState();
    const projectId = s.projectId;
    if (!projectId) return;
    // 共享模式：后端终端整层拒绝（terminal.ts 的 403），入口一并禁用
    if (!LOCAL_HOSTNAMES.has(window.location.hostname)) {
      showFlash(translate('run.shareMode'));
      return;
    }
    if (!isRunnable(file)) {
      showFlash(translate('run.unsupported'));
      return;
    }
    setBottomTab('terminal');
    setBottomOpen(true);
    void (async () => {
      // 每次入口都重拉：环境变化（新建 venv / 换 conda / 装了新 JDK）要能立刻感知。
      // 优先级：项目锁定 → 设置里的全局默认 → 自动探测到的第一个。
      let pythonPath: string | null = null;
      try {
        const result = await api.runConfig(projectId);
        setRunConfig(result);
        const selected = result.runtimes.find((r) => r.id === 'python')?.path ?? null;
        const locked = Boolean(result.config.runtimes.python);
        pythonPath = locked ? selected : loadPrefs().pythonPath || selected;
      } catch {
        pythonPath = loadPrefs().pythonPath || null; // 探测失败就退回全局默认 / PATH
      }
      setRunRequest({ token: ++runTokenRef.current, file, pythonPath });
    })();
  }, []);

  /**
   * 2026-10-20：跑一个运行档（▶ 下拉里的「构建 / 运行 / 测试」）。
   * 命令原样写进终端；env / PATH / JAVA_HOME 由后端 PTY 注入，所以这里不用拼任何环境。
   */
  const runProfile = useCallback((profile: RunProfile) => {
    const projectId = useStore.getState().projectId;
    if (!projectId) return;
    if (!LOCAL_HOSTNAMES.has(window.location.hostname)) {
      showFlash(translate('run.shareMode'));
      return;
    }
    setRunMenuOpen(false);
    setBottomTab('terminal');
    setBottomOpen(true);
    setRunRequest({ token: ++runTokenRef.current, command: profile.command });
  }, []);

  /**
   * 2026-10-20：切项目（或首次进入）时拉一份运行配置，供 ▶ 下拉显示运行档与实际运行时。
   * 这是「入口处重拉」的另一半 —— 打开下拉也是重新拉（见下面的 effect）。
   */
  useEffect(() => {
    const projectId = store.projectId;
    setRunConfig(null);
    if (!projectId) return;
    let alive = true;
    void api
      .runConfig(projectId)
      .then((result) => {
        if (alive) setRunConfig(result);
      })
      .catch(() => {
        /* 探测失败不影响阅读，下拉里显示“正在读取” */
      });
    return () => {
      alive = false;
    };
  }, [store.projectId]);

  // 打开下拉时重新拉一次（环境变化：新建 venv / 装了新 JDK）
  useEffect(() => {
    const projectId = store.projectId;
    if (!runMenuOpen || !projectId) return;
    void api
      .runConfig(projectId)
      .then(setRunConfig)
      .catch(() => undefined);
  }, [runMenuOpen, store.projectId]);

  /**
   * FR-0013：把一条命令**填进**终端（不回车）。跟 runFileInTerminal 同一条通道，
   * 差别只在 submit=false —— 安装在系统里落东西的命令，要用户自己看一眼再按回车。
   */
  const installPiInTerminal = useCallback((command: string) => {
    if (!LOCAL_HOSTNAMES.has(window.location.hostname)) {
      showFlash(translate('run.shareMode'));
      return;
    }
    setBottomTab('terminal');
    setBottomOpen(true);
    setRunRequest({ token: ++runTokenRef.current, command, submit: false });
  }, []);
  /** W3 / G7.3：整文件 blame 视图开关 + 当前文件的 blame（按文件缓存，光标移动不重新拉）。 */
  const [blameOn, setBlameOn] = useState(false);
  const [blame, setBlame] = useState<BlameResult | null>(null);
  const blameOnRef = useRef(false);
  blameOnRef.current = blameOn;
  /** W3 / G7.3：光标所在行的 blame（只在开着 blame 视图时取）。 */
  const cursorBlame = useMemo(() => (blameOn ? blameAt(blame, cursor.line) : null), [blameOn, blame, cursor.line]);
  /** 状态栏：整份文档的总字符数 / 总行数（以编辑器当前内容为准）。 */
  const docStats = useMemo(() => {
    const text = store.fileContent;
    return { chars: text.length, lines: text.length === 0 ? 1 : text.split('\n').length };
  }, [store.fileContent]);
  const mapOverview = useMapStore((s) => s.overview);
  /** FR-0008：状态栏的保存状态文案（idle / 无文件时不显示）。 */
  const saveLabel = !store.openFile
    ? null
    : store.saveStatus === 'pending'
      ? t('save.pending')
      : store.saveStatus === 'saving'
        ? t('save.saving')
        : store.saveStatus === 'saved'
          ? t('save.saved')
          : store.saveStatus === 'error'
            ? t('save.error')
            : null;
  const mapTimeline = useMapStore((s) => s.timeline);
  const mapPulse = useMapStore((s) => s.pulse);
  const mapOptions = useMapStore((s) => s.options);

  useEffect(() => {
    void store.init();
    // 2026-10-08 用户要求清除「已读 / 待读」：清掉早期版本留在本机的旧标记（仅跑一次）。
    purgeLegacyReadState();
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
      const keymap = loadPrefs().keymap;
      // N-δ：命中导航 —— 有搜索结果时 F3 / Shift+F3 在命中之间前后走（没结果就不抢这个键）
      if (e.key === 'F3' && !mod && !e.altKey) {
        const s = useStore.getState();
        if (s.searchHits.length) {
          e.preventDefault();
          s.stepSearchHit(e.shiftKey ? -1 : 1);
        }
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
      // 侧栏面板数字键：Ctrl/Cmd+1..9/0（vsCode）或 Alt+1..9/0（IDea）；0 = 最后一个。
      if (/^[0-9]$/.test(key) && !e.shiftKey) {
        const isSidePanel =
          sidePanelModifier(keymap) === 'alt'
            ? e.altKey && !e.ctrlKey && !e.metaKey
            : (e.ctrlKey || e.metaKey) && !e.altKey;
        if (isSidePanel) {
          e.preventDefault();
          // 面板搬走后 PANEL_TABS 会变短：越界时什么都不做（否则会 setTab(undefined)，看上去像面板空了）
          const next = key === '0' ? PANEL_TABS[PANEL_TABS.length - 1] : PANEL_TABS[Number(key) - 1];
          if (next) openPanel(next);
          return;
        }
      }
      // 其余导航类快捷键走 keymap 表（打开文件 / 符号 / 设置 / 面板切换）。
      const action = resolveAction(eventToGesture(e), keymap);
      switch (action) {
        case 'openFile':
          e.preventDefault();
          setQuick('file');
          return;
        case 'openSymbol':
          e.preventDefault();
          setQuick('symbol');
          return;
        case 'settings':
          e.preventDefault();
          setSettingsOpen(true);
          return;
        case 'searchPanel':
          e.preventDefault();
          openPanel('search');
          // 搜索框在左栏（活动栏「搜索」）：切换到该视图后才在，所以晚一拍聚焦
          setTimeout(() => {
            searchInputRef.current?.querySelector('input')?.focus();
          }, 0);
          return;
        case 'outlinePanel':
          e.preventDefault();
          openPanel('outline');
          return;
        case 'filesPanel':
          e.preventDefault();
          openPanel('files');
          return;
        case 'continueReading': {
          // G3.4：继续阅读 —— 直达上次离开的文件与行列（没有断点就不抢这个键）
          const last = useGuideStore.getState().readstate;
          if (last) {
            e.preventDefault();
            backToCode();
            void useStore.getState().openFileAt(last.file, last.line, last.col);
          }
          return;
        }
        case 'runFile': {
          // FR-0011：在终端中运行当前文件（Ctrl+F5）；未打开文件就先提示
          e.preventDefault();
          const file = useStore.getState().openFile;
          if (!file) {
            showFlash(translate('run.noFile'));
            return;
          }
          runFileInTerminal(file);
          return;
        }
        case 'back': // 后退/前进：绑键随 keymap 走（Alt+←/→ 或 Ctrl+Alt+←/→）
          e.preventDefault();
          void useStore.getState().goBack();
          return;
        case 'forward':
          e.preventDefault();
          void useStore.getState().goForward();
          return;
        case 'revealInFiles':
          e.preventDefault();
          revealFileInTree(useStore.getState().openFile);
          return;
        case 'collapseAll':
          e.preventDefault();
          collapseAllInTree();
          return;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [store.openFile, cursor.line, cursor.col, openPanel, runFileInTerminal, revealFileInTree, collapseAllInTree]);

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

  const searchDirOptions = useMemo(() => topDirs(store.tree), [store.tree]);
  /** N21：最近打开（标签顺序即最近访问倒序）。 */
  const recentFiles = useMemo(() => store.tabs.map((t) => t.file), [store.tabs]);
  const fileSetRef = useRef<Set<string>>(new Set());
  fileSetRef.current = new Set(collectFiles(store.tree));
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
      document.documentElement.style.setProperty(
        '--sidebar-width',
        `${clampSidebar(startWidth + ev.clientX - startX)}px`,
      );
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
    backToCode();
    void useStore.getState().openFileAt(file, line, col, endLine, endCol);
  };

  /** 关闭一批标签后，若当前打开的文件也被关了，就跳到剩余的第一个标签（否则编辑区空着）。 */
  const afterCloseTabs = (currentOpen: string) => {
    const remaining = useStore.getState().tabs;
    if (currentOpen && !remaining.some((t) => t.file === currentOpen) && remaining.length > 0) {
      const next = remaining[0];
      jump(next.file, next.line, next.col);
    }
  };

  // Esc 收起标签右键菜单（与分享下拉的 Esc 行为一致）。
  useEffect(() => {
    if (!tabMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTabMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tabMenu]);

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

  /** 文件树叠加层：时间 / 来源 / 孤立 / 热点 / 刚变更 + 视图过滤。 */
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
    // 2026-10-20 用户要求（IDEA 口径）：文件树按 git 状态染色 —— 新增绿 / 修改蓝 / 删除灰 /
    // 重命名蓝 / 冲突红；被忽略的文件不在清单里，不染色。目录汇总在 FileTree 内部做。
    const vcs = new Map<string, GitChangeEntry['status']>();
    for (const entry of changesEntries ?? []) vcs.set(entry.file, entry.status);
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
    return { timeline, orphans, hot, pulse, dirs, visible, vcs };
  }, [mapTimeline, mapOverview, mapPulse, store.tree, recentFilter, onlyOrphans, changesEntries]);

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
  const copyLocation = (file: string, line: number, col: number) => useStore.getState().copyLocation(file, line, col);

  /** S3a：选中的一段代码 → 带出处的片段（出处行 + 围栏代码块）。 */
  const copySnippet = (file: string, startLine: number, endLine: number, text: string) =>
    useStore.getState().copySnippet({ file, startLine, endLine, text });

  /** 统一渲染某视图的面板（左右两栏共用），无项目时给占位。 */
  const renderView = (id: ViewId) => {
    switch (id) {
      case 'files':
        return (
          <>
            <input
              className="text-input sidebar-filter"
              placeholder={t('app.filterPlaceholder')}
              value={fileFilter}
              onChange={(e) => setFileFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setFileFilter('');
              }}
            />
            {/* 2026-10-15 用户要求：这里只过滤文件名，不再顺带搜内容（要搜内容用「搜索」面板）。 */}
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
                <input type="checkbox" checked={onlyOrphans} onChange={(e) => setOnlyOrphans(e.target.checked)} />
                {t('app.orphan')}
              </label>
              {/* FR-0012：树的三个工具动作（与右键 / 快捷键同源）；2026-10-15 用户要求改为图标。 */}
              <span className="tree-actions">
                <button
                  className="icon-btn sm"
                  disabled={!store.openFile}
                  onClick={() => revealFileInTree(store.openFile)}
                  title={`${t('filetree.revealActive')} (Alt+F)`}
                  aria-label={t('filetree.revealActive')}
                >
                  {/* 准星（定位到当前文件） */}
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="7" />
                    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
                  </svg>
                </button>
                <button
                  className="icon-btn sm"
                  onClick={collapseAllInTree}
                  title={`${t('filetree.collapseAll')} (${
                    loadPrefs().keymap === 'idea' ? 'Ctrl+Alt+-' : 'Ctrl+Shift+-'
                  })`}
                  aria-label={t('filetree.collapseAll')}
                >
                  {/* 收拢（上下两横 + 向内合拢的箭头） */}
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M4 6h16M4 18h16M8 13l4-3 4 3" />
                  </svg>
                </button>
                <button
                  className="icon-btn sm"
                  onClick={expandAllInTree}
                  title={t('filetree.expandAll')}
                  aria-label={t('filetree.expandAll')}
                >
                  {/* 展开（上下两横 + 向外张开的箭头） */}
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M4 6h16M4 18h16M8 11l4 3 4-3" />
                  </svg>
                </button>
              </span>
            </div>
            {/* 打开文件不带行号：回到上次读到的位置（N22） */}
            <FileTree
              key={store.projectId ?? ''}
              tree={store.tree}
              activeFile={store.openFile}
              onOpen={(file) => jump(file)}
              onRun={runFileInTerminal}
              filter={fileFilter}
              decor={decor}
              onOpenAside={(file) => void useStore.getState().openInSecondary(file)}
              onCopy={(text) => useStore.getState().copyText(text)}
              projectRoot={store.project?.root}
              onDelete={(path, isDir) => setConfirmAction({ kind: 'delete', path, isDir })}
              onNewFile={(dir) => openFsPrompt({ kind: 'newFile', dir })}
              onNewDir={(dir) => openFsPrompt({ kind: 'newDir', dir })}
              onRename={(path) => openFsPrompt({ kind: 'rename', path })}
              onMove={(path) => openFsPrompt({ kind: 'move', path })}
              onDuplicate={(path) => openFsPrompt({ kind: 'duplicate', path })}
              onClipboard={(op, path) => useStore.getState().setClipboard(op, path)}
              onPaste={(dir) => void useStore.getState().pasteInto(dir)}
              hasClipboard={store.clipboard != null}
              onMoveDrop={moveInto}
              projectId={store.projectId}
              revealToken={treeRevealToken}
              collapseAllToken={treeCollapseToken}
              expandAllToken={treeExpandToken}
              onLoadDir={async (path) => (await api.dirNodes(store.projectId ?? '', path)).nodes}
            />
          </>
        );
      case 'search':
        return store.projectId ? (
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
            />
          </div>
        ) : (
          <div className="panel-empty">{t('app.noProject')}</div>
        );
      case 'git':
        return store.projectId ? (
          <ChangesPanel onOpenFile={(file) => jump(file)} onOpenDiff={(file) => setDiffFile(file)} />
        ) : (
          <div className="panel-empty">{t('app.noProject')}</div>
        );
      case 'agent':
        return store.projectId ? (
          <AgentSessions
            projectId={store.projectId}
            onBack={backToCode}
            onOpen={showAgent}
          />
        ) : (
          <div className="panel-empty">{t('app.noProject')}</div>
        );
      case 'outline':
        return (
          <OutlinePanel
            symbols={store.symbols}
            fileName={store.openFile}
            cursorLine={cursor.line}
            onJump={(s) => jump(s.location.file, s.location.range.start.line, s.location.range.start.col)}
          />
        );
      case 'api':
        return store.projectId ? (
          <ApiPanel projectId={store.projectId} />
        ) : (
          <div className="panel-empty">{t('app.noProject')}</div>
        );
    }
  };

  return (
    <div className="app">
      <TopBar
        projects={store.projects}
        project={store.project}
        status={store.status}
        onSelect={(id) => void useStore.getState().selectProject(id)}
        onOpenFolder={(root) => void useStore.getState().openFolder(root)}
        onForget={(id) => setConfirmAction({ kind: 'forget', id })}
        onReindex={() => setConfirmAction({ kind: 'reindex' })}
      />

      <div className="body">
        {/* 最左活动栏（VS Code 布局迁移 2026-10-08）+ 左下角工具区。
            2026-10-15 需求 3：模型 / 设置 / 快捷键从左下进 —— 竖排图标，从上到下：快捷键、模型、设置
            （与右下竖轨底部的区域开关对称）。 */}
        <div className="left-rail">
          <ActivityBar
            side="left"
            views={viewsOn('left')}
            active={tab}
            onSelect={(id) => onSelectView('left', id)}
            onMove={moveView}
            onReorder={(id, idx) => reorderView('left', id, idx)}
            gitCount={changesCount}
          />
          <div className="rail-bottom">
            <div className="rail-tools">
              <button
                type="button"
                className={`region-toggle${helpOpen ? ' active' : ''}`}
                title={t('topbar.help')}
                aria-label={t('topbar.help')}
                aria-expanded={helpOpen}
                onClick={() => setHelpOpen((v) => !v)}
              >
                {/* 键盘（快捷键） */}
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="2.5" y="6" width="19" height="12" rx="2" />
                  <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
                </svg>
              </button>
              <button
                type="button"
                className="region-toggle"
                title={t('topbar.modelTitle')}
                aria-label={t('topbar.model')}
                onClick={() => setModelOpen(true)}
              >
                {/* 芯片（模型） */}
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="7" y="7" width="10" height="10" rx="1.5" />
                  <path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" />
                </svg>
              </button>
              <button
                type="button"
                className="region-toggle"
                title={t('topbar.settings')}
                aria-label={t('topbar.settings')}
                onClick={() => setSettingsOpen(true)}
              >
                {/* 齿轮（设置） */}
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="3.2" />
                  <path d="M12 2.8v2.4M12 18.8v2.4M4.6 7.2l2 1.2M17.4 15.6l2 1.2M4.6 16.8l2-1.2M17.4 8.4l2-1.2" />
                </svg>
              </button>
              {helpOpen && <HelpPopover onClose={() => setHelpOpen(false)} />}
            </div>
          </div>
        </div>

        {sidebarOpen && (
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

            {/* P25：面板容器补 tabpanel 语义（aria-labelledby 指向活动栏当前项） */}
            <div
              className="panel-body"
              role="tabpanel"
              id="wcr-side-panel"
              aria-labelledby={`wcr-activity-left-${tab}`}
            >
              {renderView(tab)}
            </div>
          </aside>
        )}

        <main className="main">
          {mainView === 'agent' ? (
            <AgentView
              projectId={store.projectId ?? ''}
              projectName={store.project?.name ?? store.projectId ?? ''}
              onBack={backToCode}
              onInstallPi={installPiInTerminal}
            />
          ) : (
            <>
              {/* 代码展示区顶条（2026-10-08 用户要求）：左边标签条，右边 ← → 与分享。
              原来的导航条（总览 / 面包屑 / 复制位置 / 旁边打开 / 项目地图）整行去掉：
              复制位置与旁边打开进代码右键菜单，项目地图落到右下角竖轨的「布局」上方。 */}
              <div className="editor-topbar">
                {/* N19：标签条（上限 8 + LRU + 同文件合并） */}
                {!showMap && store.tabs.length > 0 && (
                  <div className="tabbar">
                    {store.tabs.map((t) => (
                      <span
                        key={t.file}
                        className={`tab ${t.file === store.openFile ? 'active' : ''}`}
                        onClick={() => jump(t.file, t.line, t.col)}
                        onAuxClick={(e) => {
                          // 只有中键才「在旁边打开」；右键走下面的 contextmenu，不误触发。
                          if (e.button === 1) void useStore.getState().openInSecondary(t.file);
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setTabMenu({ x: e.clientX, y: e.clientY, file: t.file });
                        }}
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
                <div className="editor-actions">
                  <button
                    className="btn ghost"
                    disabled={!store.openFile || !isRunnable(store.openFile)}
                    onClick={() => store.openFile && runFileInTerminal(store.openFile)}
                    title={t('run.title')}
                    aria-label={t('run.title')}
                  >
                    ▶
                  </button>
                  <button
                    className="btn ghost"
                    disabled={!store.projectId}
                    onClick={() => setRunMenuOpen((v) => !v)}
                    title={t('run.profiles')}
                    aria-label={t('run.profiles')}
                    aria-haspopup="menu"
                    aria-expanded={runMenuOpen}
                  >
                    ▾
                  </button>
                  {runMenuOpen && store.projectId && (
                    <RunMenu
                      result={runConfig}
                      onPick={runProfile}
                      onClose={() => setRunMenuOpen(false)}
                      onOpenSettings={() => {
                        setRunMenuOpen(false);
                        setSettingsOpen(true);
                      }}
                    />
                  )}
                  <button
                    className="btn ghost"
                    disabled={!canBack}
                    onClick={() => void useStore.getState().goBack()}
                    title={loadPrefs().keymap === 'idea' ? 'Ctrl+Alt+←' : 'Alt+←'}
                  >
                    ←
                  </button>
                  <button
                    className="btn ghost"
                    disabled={!canForward}
                    onClick={() => void useStore.getState().goForward()}
                    title={loadPrefs().keymap === 'idea' ? 'Ctrl+Alt+→' : 'Alt+→'}
                  >
                    →
                  </button>
                  {/* 2（2026-10-15 用户要求）：文件摘要条从编辑区里搬进顶条，放在原来「分享 ▾」的位置。
                  分享下拉已去掉（13），← → 导航留在原处（同日晚用户要求）。 */}
                  {!showMap && (
                    <SummaryBar
                      projectId={store.projectId}
                      file={store.openFile}
                      onOpenFile={jump}
                      onOpenHistory={openHistoryVersion}
                    />
                  )}
                </div>
              </div>

              {/* 标签右键菜单：固定定位在鼠标处，点别处 / Esc 收起。 */}
              {tabMenu && (
                <>
                  <div className="tab-menu-backdrop" onClick={() => setTabMenu(null)} />
                  <div className="tab-menu" style={{ left: tabMenu.x, top: tabMenu.y }}>
                    <button
                      className="share-item"
                      onClick={() => {
                        revealFileInTree(tabMenu.file);
                        setTabMenu(null);
                      }}
                    >
                      {translate('filetree.revealActive')}
                    </button>
                    <button
                      className="share-item"
                      onClick={() => {
                        useStore.getState().closeTab(tabMenu.file);
                        afterCloseTabs(tabMenu.file);
                        setTabMenu(null);
                      }}
                    >
                      {translate('app.tabClose')}
                    </button>
                    <button
                      className="share-item"
                      onClick={() => {
                        useStore.getState().closeOthers(tabMenu.file);
                        afterCloseTabs(tabMenu.file);
                        setTabMenu(null);
                      }}
                    >
                      {translate('app.tabCloseOthers')}
                    </button>
                    <button
                      className="share-item"
                      onClick={() => {
                        useStore.getState().closeRight(tabMenu.file);
                        afterCloseTabs(tabMenu.file);
                        setTabMenu(null);
                      }}
                    >
                      {translate('app.tabCloseRight')}
                    </button>
                    <button
                      className="share-item"
                      onClick={() => {
                        useStore.getState().closeLeft(tabMenu.file);
                        afterCloseTabs(tabMenu.file);
                        setTabMenu(null);
                      }}
                    >
                      {translate('app.tabCloseLeft')}
                    </button>
                  </div>
                </>
              )}

              <div className="editor-wrap">
                {showMap ? (
                  <Overview
                    onOpenFile={(file, line) => jump(file, line ?? 1, 1)}
                    onOpenGraph={() => setGraphOpen(true)}
                    onOpenChanges={() => openPanel('git')}
                  />
                ) : store.openFile ? (
                  <div className={`panes ${store.secondary ? 'split' : ''}`}>
                    <div className="pane">
                      <Editor
                        projectId={store.projectId}
                        file={store.openFile}
                        lang={store.fileLang}
                        content={store.fileContent}
                        contentToken={store.contentToken}
                        reveal={store.reveal}
                        highlightsToken={store.highlightsToken}
                        onCursor={(line, col) => setCursor({ line, col })}
                        onSelection={setSelection}
                        onPosition={(line, col, scrollTop) => rememberPosition(store.openFile!, line, col, scrollTop)}
                        onClickPosition={(line, col) => useStore.getState().noteCursorAt(store.openFile!, line, col)}
                        onCopyLocation={copyLocation}
                        onCopySnippet={copySnippet}
                        onOpenAside={(file, line, col) => void useStore.getState().openInSecondary(file, line, col)}
                        blame={blameOn ? (blame?.lines ?? null) : null}
                        symbols={store.symbols}
                        onExplain={openExplain}
                        onFlow={openFlow}
                        onRun={runFileInTerminal}
                        editable
                        onChange={(text) => useStore.getState().editorChanged(text)}
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
                              : (line, col, scrollTop) => rememberPosition(secondaryDoc.file, line, col, scrollTop)
                          }
                          onCopyLocation={copyLocation}
                          onCopySnippet={copySnippet}
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
            </>
          )}

          {/* 底部面板（VS Code 布局迁移 2026-10-08）：输出 / 终端，位于状态栏上方。
              标签竖排在面板右列（2026-10-08），不再占用顶部一行高度。 */}
          <div
            className={`bottom-panel ${bottomOpen ? '' : 'collapsed'}`}
            style={bottomOpen ? { height: bottomHeight } : undefined}
          >
            <div
              className="bottom-resize-handle"
              onMouseDown={(e) => {
                e.preventDefault();
                const startY = e.clientY;
                const startH = bottomHeight;
                const move = (ev: MouseEvent) => {
                  // 向上拖（clientY 减小）→ 面板变高
                  setBottomHeight(Math.max(80, Math.min(600, startH + (startY - ev.clientY))));
                };
                const up = () => {
                  window.removeEventListener('mousemove', move);
                  window.removeEventListener('mouseup', up);
                };
                window.addEventListener('mousemove', move);
                window.addEventListener('mouseup', up);
              }}
            />
            <div className="bottom-stack">
              {/* 收起面板时（.bottom-panel.collapsed 为 display:none）**不卸载内容**：终端是常驻会话，
                  卸载会把会话、滚动内容连同里面跑着的进程一起销毁（见下方终端常驻）。 */}
              <div className="bottom-body">
                {bottomTab === 'output' && <OutputPanel projectId={store.projectId} />}
                {/* 终端常驻：切到「输出」/收起面板只隐藏、不卸载 —— 会话、滚动内容与
                    里面跑着的进程都留着。切换项目时终端**跟项目走**：会话重开到新项目根
                    （路径与当前项目一致），标签保留、面板不自行退出（关闭靠标签 ×）。 */}
                <div className="terminal-slot" style={{ display: bottomTab === 'terminal' ? 'flex' : 'none' }}>
                  <TerminalPanel projectId={store.projectId} runRequest={runRequest} />
                </div>
              </div>
              <div className="bottom-rail">
                <div
                  className="bottom-tabs"
                  role="tablist"
                  aria-orientation="vertical"
                  aria-label={t('app.bottomPanels')}
                >
                  {BOTTOM_TABS.map((id) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      id={`wcr-bottom-tab-${id}`}
                      aria-selected={bottomTab === id}
                      className={`bottom-tab${bottomTab === id ? ' active' : ''}`}
                      title={t(BOTTOM_TITLE[id])}
                      onClick={() => {
                        if (bottomOpen && bottomTab === id) setBottomOpen(false);
                        else {
                          setBottomTab(id);
                          setBottomOpen(true);
                        }
                      }}
                    >
                      {t(BOTTOM_TITLE[id])}
                    </button>
                  ))}
                </div>
                <button
                  className="bottom-toggle"
                  onClick={() => setBottomOpen((v) => !v)}
                  title={bottomOpen ? t('app.collapseBottom') : t('app.expandBottom')}
                >
                  {bottomOpen ? '▾' : '▴'}
                </button>
              </div>
            </div>
          </div>

          <footer className="statusbar">
            {/* 1（2026-10-15 用户要求）：文件路径导航（面包屑）从编辑区顶部一行的位置
                挪到底部最左边 —— 不再单占一行，也不再顶在代码上方。 */}
            {store.openFile && <Breadcrumbs file={store.openFile} tree={store.tree} onOpen={(file) => jump(file)} />}
            {saveLabel && <span className={`save-state ${store.saveStatus}`}>{saveLabel}</span>}
            {cursorBlame && (
              <span className="blame-status" title={t('blame.title')}>
                {blameText(cursorBlame, t)}
              </span>
            )}
            <span className="spacer" />
            {store.flash && <span className="flash-text">{store.flash}</span>}
            {store.notice?.reason === 'no-symbol' && <span className="notice-hint">{store.notice.message}</span>}
            {store.fileLoading && <span>{t('app.loading')}</span>}
            {store.openFile && <span>{t('app.docStats', { chars: docStats.chars, lines: docStats.lines })}</span>}
            <span>
              Ln {cursor.line}, Col {cursor.col}
            </span>
            {selection && <span>{t('app.selectionInfo', { chars: selection.chars, lines: selection.lines })}</span>}
            <span>utf-8</span>
            <span>{store.fileLang}</span>
          </footer>
        </main>

        {/* 右侧栏（VS Code 布局迁移 2026-10-08）：右活动栏 + 右侧栏内容，视图可在左右两侧拖拽换侧。 */}
        {store.projectId && (
          <>
            {changesDockOpen && (
              <aside className="right-sidebar" style={{ width: changesDockWidth }} aria-label={t('app.dockAria')}>
                <div
                  className="dock-resizer"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t('app.resizeDock')}
                  tabIndex={0}
                  onPointerDown={onChangesDockResizeStart}
                />
                <div className="right-body">{renderView(dockTab)}</div>
              </aside>
            )}
            <div className="right-rail">
              <ActivityBar
                side="right"
                views={viewsOn('right')}
                active={dockTab}
                onSelect={(id) => onSelectView('right', id)}
                onMove={moveView}
                onReorder={(id, idx) => reorderView('right', id, idx)}
                gitCount={changesCount}
              />
              {/* 右下角竖轨的底部：项目地图开关（搬自顶部导航条）+ 左/右/下 三区域开关 */}
              <div className="rail-bottom">
                {store.openFile && (
                  <button
                    type="button"
                    className={`region-toggle${mainView === 'map' ? ' active' : ''}`}
                    title={t('app.mapToggleTitle')}
                    aria-pressed={mainView === 'map'}
                    onClick={() => setMainView(mainView === 'map' ? 'auto' : 'map')}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M3 6.4 9 4l6 2.4L21 4v13.6L15 20l-6-2.4L3 20V6.4Z" />
                      <path d="M9 4v13.6M15 6.4V20" />
                    </svg>
                  </button>
                )}
                <div className="region-toggles" role="group" aria-label={t('app.regionToggles')}>
                  <button
                    type="button"
                    className={`region-toggle${sidebarOpen ? ' active' : ''}`}
                    title={sidebarOpen ? t('app.collapseSidebar') : t('app.expandSidebar')}
                    onClick={() => setSidebarOpen((v) => !v)}
                  >
                    <span className="region-glyph region-glyph-left" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={`region-toggle${changesDockOpen ? ' active' : ''}`}
                    title={changesDockOpen ? t('app.collapseDock') : t('app.expandDock')}
                    onClick={() => setChangesDockOpen((v) => !v)}
                  >
                    <span className="region-glyph region-glyph-right" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={`region-toggle${bottomOpen ? ' active' : ''}`}
                    title={bottomOpen ? t('app.collapseBottom') : t('app.expandBottom')}
                    onClick={() => setBottomOpen((v) => !v)}
                  >
                    <span className="region-glyph region-glyph-bottom" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>
          </>
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
        currentFile={store.openFile}
        onClose={() => setQuick(null)}
        onOpenFile={jump}
      />

      {/* P24 浮层：设置 · 模型 */}
      {settingsOpen && (
        <SettingsPanel projectId={store.projectId} onClose={() => setSettingsOpen(false)} />
      )}
      {modelOpen && <ModelDialog onClose={() => setModelOpen(false)} />}

      {confirmAction && (
        <Dialog
          title={t(
            confirmAction.kind === 'reindex'
              ? 'app.confirmReindexTitle'
              : confirmAction.kind === 'forget'
                ? 'app.confirmRemoveTitle'
                : 'app.confirmDeleteTitle',
          )}
          onClose={() => setConfirmAction(null)}
        >
          <p className="confirm-text">
            {confirmAction.kind === 'reindex'
              ? t('app.confirmReindexBody')
              : confirmAction.kind === 'forget'
                ? t('app.confirmRemoveBody')
                : t('app.confirmDeleteBody', { path: confirmAction.path ?? '' })}
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
                else if (action.kind === 'forget' && action.id) void useStore.getState().forgetProject(action.id);
                else if (action.kind === 'delete' && action.path) void useStore.getState().deleteEntry(action.path);
              }}
            >
              {t(
                confirmAction.kind === 'reindex'
                  ? 'app.confirmReindexOk'
                  : confirmAction.kind === 'forget'
                    ? 'app.confirmRemoveOk'
                    : 'app.confirmDeleteOk',
              )}
            </button>
          </div>
        </Dialog>
      )}

      {/* FR-0009：新建 / 重命名 / 移动 / 复制一份 —— 一个输入框收参数（回车即提交） */}
      {fsPrompt && fsPromptText && (
        <Dialog title={fsPromptText.title} onClose={() => setFsPrompt(null)}>
          <p className="fs-prompt-target">
            {fsPrompt.kind === 'newFile' || fsPrompt.kind === 'newDir'
              ? t('prompt.inDir', { dir: fsPrompt.dir || t('filetree.projectRoot') })
              : fsPrompt.path}
          </p>
          <label className="fs-prompt-label" htmlFor="wcr-fs-input">
            {fsPromptText.label}
          </label>
          <input
            id="wcr-fs-input"
            ref={fsInputRef}
            className="fs-prompt-input"
            value={fsValue}
            spellCheck={false}
            placeholder={fsPrompt.kind === 'move' ? t('prompt.movePlaceholder') : t('prompt.namePlaceholder')}
            onChange={(e) => setFsValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitFsPrompt();
              }
            }}
          />
          {fsPromptText.hint && <p className="fs-prompt-hint">{fsPromptText.hint}</p>}
          <div className="confirm-actions">
            <button className="btn ghost" onClick={() => setFsPrompt(null)}>
              {t('common.cancel')}
            </button>
            <button className="btn" onClick={submitFsPrompt}>
              {t('prompt.ok')}
            </button>
          </div>
        </Dialog>
      )}

      {/* FR-0008：保存冲突 —— 磁盘被外部改过，而本地还有没落盘的改动。
          Esc / 点遮罩 = 「稍后再说」：本地改动留着，不丢。 */}
      {store.conflict && (
        <Dialog title={t('conflict.title')} onClose={() => void useStore.getState().resolveConflict('later')}>
          <p className="confirm-text">{t('conflict.body', { file: store.conflict.file })}</p>
          <div className="confirm-actions">
            <button className="btn ghost" onClick={() => void useStore.getState().resolveConflict('disk')}>
              {t('conflict.useDisk')}
            </button>
            <button className="btn" onClick={() => void useStore.getState().resolveConflict('mine')}>
              {t('conflict.keepMine')}
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

/**
 * 2026-10-20：▶ 旁边的下拉 —— 列出本项目的运行档（构建 / 运行 / 测试）与实际运行时。
 * 点外面 / Esc 收起（与标签右键菜单同款 backdrop）。
 */
function RunMenu({
  result,
  onPick,
  onClose,
  onOpenSettings,
}: {
  result: RunConfigResult | null;
  onPick: (profile: RunProfile) => void;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const profiles = result?.profiles ?? [];
  const runtimes = result?.runtimes ?? [];
  return (
    <>
      <div className="tab-menu-backdrop" onClick={onClose} />
      <div className="run-menu" role="menu">
        {!result && <div className="run-menu-empty">{t('run.loading')}</div>}
        {result && profiles.length === 0 && <div className="run-menu-empty">{t('run.noProfiles')}</div>}
        {profiles.map((p) => (
          <button
            key={p.id}
            className="run-menu-item"
            role="menuitem"
            onClick={() => onPick(p)}
            title={p.note ?? p.command}
          >
            <span className={`run-kind k-${p.kind}`}>{t(`run.kind.${p.kind}`)}</span>
            <span className="run-menu-label">{p.label}</span>
            {p.background && <span className="run-menu-tag">{t('run.background')}</span>}
          </button>
        ))}
        <div className="run-menu-foot">
          {runtimes.length > 0 && (
            <span className="run-menu-runtimes">
              {runtimes.map((r) => `${r.id} ${r.version ?? '?'}`).join(' · ')}
            </span>
          )}
          <button className="cp-link" onClick={onOpenSettings}>
            {t('run.openSettings')}
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * FR-0009：文件树上的参数收集弹窗要办的四种事（一个输入框复用）。
 * 每个成员一个单字面量 `kind`，保证 TypeScript 能按它收窄出 `dir` / `path` 的存在性。
 */
type FsPrompt =
  | { kind: 'newFile'; dir: string }
  | { kind: 'newDir'; dir: string }
  | { kind: 'rename'; path: string }
  | { kind: 'duplicate'; path: string }
  | { kind: 'move'; path: string };

/** FR-0009：复制一份的默认名字（在扩展名前插 " copy"；隐藏文件不拆扩展名）。 */
function duplicateEntryName(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? `${base.slice(0, dot)} copy${base.slice(dot)}` : `${base} copy`;
}
