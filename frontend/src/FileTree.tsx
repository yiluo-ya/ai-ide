/** 文件树：目录可展开/折叠，点击文件打开；叠加「改动热力 / 来源徽标」。 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FileOrigin } from '../../shared/types';
import type { FileNode } from './api';
import { langColor } from './languages';
import { FileIcon } from './common/fileicon/FileIcon';
import { heatLevel } from './mapState';
import { translate, useI18n } from './i18n';
import { isRunnable } from './runCommand';
import { usePrefs } from './prefs';
import { allDirPaths, ancestorDirs, readTreeState, writeTreeState } from './treeState';
import './filetree.css';

/** 文件树上叠加的事实（来自 /overview 与 /timeline，缺省即不显示徽标）。 */
export interface TreeDecor {
  /** 文件 → 时间与来源（M9/M10）。 */
  timeline?: Map<string, { mtimeMs: number; origin: FileOrigin; confidence: number }>;
  /** 没人引用的文件（M8.1）。 */
  orphans?: Set<string>;
  /** 热点骨架文件（M3.1）。 */
  hot?: Set<string>;
  /** 已标记忽略（M8.2）。 */
  ignored?: Set<string>;
  /** 刚刚被改动的文件（M9.3）：阅读时 agent 还在写，改动应即时可见。 */
  pulse?: Set<string>;
  /** G6.2：目录 → 「这一层是干嘛的」+ 分层（来自 01 的 overview.dirs；取不到就不显示）。 */
  dirs?: Map<string, { duty: string; layer: string; from: string | null }>;
  /** 只渲染集合里的文件（undefined = 不筛）。 */
  visible?: Set<string>;
}

interface Props {
  tree: FileNode | null;
  activeFile: string | null;
  onOpen: (file: string) => void;
  filter?: string;
  decor?: TreeDecor;
  /** N19：右键菜单里的「在旁边打开」（分屏对照）。 */
  onOpenAside?: (file: string) => void;
  /** FR-0011：右键菜单「在终端中运行」（App 负责解析解释器并写进终端）。 */
  onRun?: (file: string) => void;
  /** 右键菜单「复制路径 / 复制文件名」：写剪贴板 + 状态栏反馈（由 App 注入）。 */
  onCopy?: (text: string) => void;
  /** 项目根绝对路径（用于「复制路径」输出全路径而非项目相对路径）。 */
  projectRoot?: string;
  /** FR-0008：右键菜单「删除」（文件与目录都有）；App 负责二次确认与调后端。 */
  onDelete?: (path: string, isDir: boolean) => void;
  /** FR-0009：新建文件 / 文件夹（`dir` 是目标目录，空串 = 项目根）。 */
  onNewFile?: (dir: string) => void;
  onNewDir?: (dir: string) => void;
  /** FR-0009：重命名 / 移动到… / 复制一份…（都只是发起，实际动作由 App 的弹窗收集参数）。 */
  onRename?: (path: string) => void;
  onMove?: (path: string) => void;
  onDuplicate?: (path: string) => void;
  /** FR-0009：复制 / 剪切 到（前端内存）剪贴板。 */
  onClipboard?: (op: 'copy' | 'cut', path: string) => void;
  /** FR-0009：把剪贴板里的条目放到 `dir` 下。 */
  onPaste?: (dir: string) => void;
  /** 剪贴板非空（决定目录菜单里要不要出现「粘贴到这里」）。 */
  hasClipboard?: boolean;
  /** FR-0009：拖拽移动 —— `from` 拖到目录 `toDir`（空串 = 项目根）。 */
  onMoveDrop?: (from: string, toDir: string) => void;
  /** FR-0012：项目 id —— 展开 / 折叠状态按项目分键持久化。 */
  projectId?: string | null;
  /** FR-0012：每次 +1 就把当前打开文件定位到树里（展开祖先链 + 滚动可见 + 闪烁）。 */
  revealToken?: number;
  /** FR-0012：每次 +1 就收拢所有文件夹。 */
  collapseAllToken?: number;
  /** 2026-10-15：每次 +1 就展开所有文件夹（与收拢对称）。 */
  expandAllToken?: number;
}

/** 右键菜单（视口坐标定位）：文件与目录都可开（目录用于复制路径 / 文件名）。 */
interface LeafMenu {
  path: string;
  isDir: boolean;
  x: number;
  y: number;
}

/** FR-0009 的行级拖拽：把「能不能放」「往哪放」收成一个对象往下传，避免逐层摞 props。 */
interface Dnd {
  /** 源能不能放进这个目录（源自身与它的子树不行）。 */
  canDrop: (dir: string) => boolean;
  dragStart: (path: string) => (e: React.DragEvent) => void;
  dragEnd: () => void;
  /** 悬停高亮：进入 / 离开某个目标目录。 */
  setTarget: (dir: string) => void;
  clearTarget: (dir: string) => void;
  dropOn: (dir: string) => (e: React.DragEvent) => void;
  /** 当前悬停的目录（高亮用；null = 没有）。 */
  target: string | null;
}

/** 高亮命中过滤词的部分。 */
function Highlight({ text, term }: { text: string; term: string }) {
  if (!term) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + term.length)}</mark>
      {text.slice(idx + term.length)}
    </>
  );
}

/**
 * G6.2：目录节点的 hover 说明 = 这一层管什么 + 分层依据，数据来自 01 的 overview.dirs，
 * 取不到就只显示路径（不占位、不编造）。
 */
function dirTitle(node: FileNode, decor?: TreeDecor): string {
  const base = node.path || node.name;
  const info = decor?.dirs?.get(node.path);
  if (!info) return base;
  const layer = translate(`layer.${info.layer}`);
  const duty = info.from ? translate('filetree.dutyFrom', { duty: info.duty, from: info.from }) : info.duty;
  return `${base}\n${translate('tree.dirDuty', { layer, duty })}`;
}

function matchesFilter(node: FileNode, term: string): boolean {
  if (!term) return true;
  if (node.type === 'file') return node.path.toLowerCase().includes(term.toLowerCase());
  return (node.children ?? []).some((c) => matchesFilter(c, term));
}

/** 过滤条件（只看最近改动 / 孤立）后的可见性。 */
function matchesVisible(node: FileNode, visible: Set<string> | undefined): boolean {
  if (!visible) return true;
  if (node.type === 'file') return visible.has(node.path);
  return (node.children ?? []).some((c) => matchesVisible(c, visible));
}

const ORIGIN_BADGE: Record<FileOrigin, { mark: string; titleKey: string } | null> = {
  // 2026-10-03 用户要求去掉「agent 产出」（没啥用）：不再在文件树上标它。
  agent: null,
  recent: { mark: '◌', titleKey: 'filetree.originRecent' },
  project: null,
};

/**
 * 文件树的排序（2026-10-03 用户要求）：目录在前、文件在后，各自按名称升序。
 * 后端给的顺序是路径序，目录与文件会混在一起（`a.ts` 跑到 `a/` 前面），看起来乱。
 */
function sortNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** 过滤（搜索 / 只看）之后的子节点，按目录在前排序。 */
function visibleChildren(node: FileNode, filter: string, decor: TreeDecor | undefined): FileNode[] {
  return sortNodes((node.children ?? []).filter((c) => matchesFilter(c, filter) && matchesVisible(c, decor?.visible)));
}

/**
 * 单链目录压缩（2026-10-05 用户要求，等同 VSCode 的 compact folders）：
 * 从 node 起，只要「过滤后唯一子节点还是目录」就一路并进来，直到出现分支（多个子项）或子项是文件。
 * 返回的链首是最外层目录、链尾是这条链真正代表的目录。
 */
function compactChain(node: FileNode, filter: string, decor: TreeDecor | undefined): FileNode[] {
  const chain = [node];
  let cur = node;
  for (;;) {
    const kids = visibleChildren(cur, filter, decor);
    if (kids.length === 1 && kids[0].type === 'directory') {
      cur = kids[0];
      chain.push(cur);
    } else break;
  }
  return chain;
}

function FileBadges({ file, decor }: { file: string; decor?: TreeDecor }) {
  const { t } = useI18n();
  const fact = decor?.timeline?.get(file);
  const level = heatLevel(fact?.mtimeMs);
  const origin = fact ? ORIGIN_BADGE[fact.origin] : null;
  const pulsing = decor?.pulse?.has(file);
  return (
    <>
      {pulsing && (
        <span className="badge pulse" title={t('filetree.pulseTitle')}>
          ●
        </span>
      )}
      {level >= 0 && (
        <span
          className={`heat heat-${level} ${pulsing ? 'is-pulse' : ''}`}
          title={fact ? t('filetree.mtime', { time: new Date(fact.mtimeMs).toLocaleString() }) : undefined}
        />
      )}
      {origin && (
        <span
          className="badge"
          title={`${t(origin.titleKey)}${fact ? t('filetree.confidence', { n: fact.confidence }) : ''}`}
        >
          {origin.mark}
        </span>
      )}
      {decor?.hot?.has(file) && (
        <span className="badge hot" title={t('filetree.hotTitle')}>
          ★
        </span>
      )}
      {decor?.orphans?.has(file) && (
        <span className="badge orphan" title={t('filetree.orphanTitle')}>
          ?
        </span>
      )}
    </>
  );
}

function TreeNode({
  node,
  depth,
  activeFile,
  onOpen,
  filter,
  decor,
  expanded,
  collapsed,
  flashPath,
  toggle,
  onMenu,
  dnd,
}: {
  node: FileNode;
  depth: number;
  activeFile: string | null;
  onOpen: (file: string) => void;
  filter: string;
  decor?: TreeDecor;
  expanded: Set<string>;
  /** 用户显式折叠过的目录：过滤自动展开时也压得住。 */
  collapsed: Set<string>;
  /** FR-0012：正在闪烁高亮的路径（刚定位到的那一行）。 */
  flashPath: string | null;
  toggle: (paths: string[]) => void;
  onMenu: (e: React.MouseEvent, path: string, isDir: boolean) => void;
  dnd: Dnd;
}) {
  if (!matchesFilter(node, filter) || !matchesVisible(node, decor?.visible)) return null;

  if (node.type === 'directory') {
    // 过滤时自动展开，方便直接看到命中项；但用户显式折叠过的目录优先 ——
    // 折叠得动，才算真的能折叠（之前 `|| depth === 0` 让顶层目录永远展开）。
    const auto = Boolean(filter || decor?.visible);
    // 单链目录压缩（2026-10-05 用户要求）：唯一子目录并成一行 a/b/c 一直到分支处；
    // 折叠时只显示最外层名字，展开时才显示整条链。
    const chain = compactChain(node, filter, decor);
    const tail = chain[chain.length - 1];
    const open = !collapsed.has(node.path) && (expanded.has(node.path) || auto);
    const label = open ? chain.map((n) => n.name).join('/') : node.name;
    const children = visibleChildren(tail, filter, decor);
    return (
      <div className="tree-dir">
        <div
          className={`tree-row dir${dnd.target === tail.path ? ' drop-target' : ''}${
            flashPath === tail.path ? ' reveal-flash' : ''
          }`}
          data-path={tail.path}
          style={{ paddingLeft: depth * 12 + 6 }}
          onClick={() => toggle(chain.map((n) => n.path))}
          onContextMenu={(e) => {
            e.preventDefault();
            // 不让它冒到容器（容器的空白右键 = 对项目根操作）
            e.stopPropagation();
            onMenu(e, tail.path, true);
          }}
          title={dirTitle(tail, decor)}
          draggable
          onDragStart={dnd.dragStart(tail.path)}
          onDragEnd={dnd.dragEnd}
          onDragOver={(e) => {
            if (!dnd.canDrop(tail.path)) return;
            e.preventDefault();
            e.stopPropagation();
            dnd.setTarget(tail.path);
          }}
          onDragLeave={() => dnd.clearTarget(tail.path)}
          onDrop={dnd.dropOn(tail.path)}
        >
          <span className={`chevron ${open ? 'open' : ''}`} aria-hidden>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M6 4l4 4-4 4V4z" />
            </svg>
          </span>
          <FileIcon fileName={tail.name} isDirectory size={16} />
          <span className="tree-name">
            <Highlight text={label} term={filter} />
          </span>
          <span className="tree-count">{node.count ?? 0}</span>
        </div>
        {open &&
          children.map((c) => (
            <TreeNode
              key={c.path}
              node={c}
              depth={depth + 1}
              activeFile={activeFile}
              onOpen={onOpen}
              filter={filter}
              decor={decor}
              expanded={expanded}
              collapsed={collapsed}
              flashPath={flashPath}
              toggle={toggle}
              onMenu={onMenu}
              dnd={dnd}
            />
          ))}
      </div>
    );
  }

  const className = [
    'tree-row',
    'file',
    activeFile === node.path ? 'active' : '',
    flashPath === node.path ? 'reveal-flash' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={className}
      data-path={node.path}
      style={{ paddingLeft: depth * 12 + 18 }}
      onClick={() => onOpen(node.path)}
      onContextMenu={(e) => {
        // 右键：打开小菜单（新建 / 重命名 / 移动 / 复制 / 删除…）
        e.preventDefault();
        e.stopPropagation();
        onMenu(e, node.path, false);
      }}
      title={node.path}
      draggable
      onDragStart={dnd.dragStart(node.path)}
      onDragEnd={dnd.dragEnd}
    >
      <FileIcon fileName={node.name} size={16} color={langColor(node.lang ?? '')} />
      <span className="tree-name">
        <Highlight text={node.name} term={filter} />
      </span>
      <FileBadges file={node.path} decor={decor} />
    </div>
  );
}

/**
 * FR-0012：最近一次被 autoReveal 定位过的「项目 + 文件」。
 *
 * 放模块级（而非组件内 state）的原因：切面板会重挂载 FileTree，若只认组件内状态，
 * 「收拢 → 切到搜索面板 → 切回文件面板」就又会被自动展开，与「展开状态按项目记住」自相矛盾。
 * autoReveal 的语义是**打开文件时跟随**，不是「面板每次出现都展开」。
 */
let lastAutoRevealed: string | null = null;

export function FileTree({
  tree,
  activeFile,
  onOpen,
  filter = '',
  decor,
  onOpenAside,
  onRun,
  onCopy,
  projectRoot,
  onDelete,
  onNewFile,
  onNewDir,
  onRename,
  onMove,
  onDuplicate,
  onClipboard,
  onPaste,
  hasClipboard,
  onMoveDrop,
  projectId,
  revealToken = 0,
  collapseAllToken = 0,
  expandAllToken = 0,
}: Props) {
  const { t } = useI18n();
  const prefs = usePrefs();
  // FR-0012：展开 / 折叠状态按项目分键持久化（切面板 / 刷新 / 切项目回来都还在）。
  // 惰性初始值只读一次 localStorage；切项目由 App 侧的 key 重挂载实现。
  const [storedTree] = useState(() => readTreeState(projectId));
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(storedTree.expanded));
  /** 用户显式折叠过的目录（优先级高于「过滤 / 只看」的自动展开）。 */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(storedTree.collapsed));
  /** 右键菜单；null = 不开。 */
  const [menu, setMenu] = useState<LeafMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** FR-0009 拖拽：源路径放 ref（hover 时读，不必重渲），目标目录放 state（要高亮）。 */
  const dragSource = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  /** FR-0012 定位：容器 ref（在它里面按 data-path 找行）+ 待定位 / 正在闪烁的路径。 */
  const containerRef = useRef<HTMLDivElement>(null);
  const [pendingReveal, setPendingReveal] = useState<{ path: string; nonce: number } | null>(null);
  const [flashPath, setFlashPath] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);

  const canDrop = (dir: string) => {
    const src = dragSource.current;
    if (!src) return false;
    return src !== dir && !dir.startsWith(`${src}/`);
  };

  const dnd: Dnd = {
    canDrop,
    target: dropTarget,
    dragStart: (path) => (e) => {
      dragSource.current = path;
      e.dataTransfer.effectAllowed = 'move';
      // 有些浏览器不 setData 就不触发 drop
      e.dataTransfer.setData('text/plain', path);
    },
    dragEnd: () => {
      dragSource.current = null;
      setDropTarget(null);
    },
    setTarget: (dir) => setDropTarget((prev) => (prev === dir ? prev : dir)),
    clearTarget: (dir) => setDropTarget((prev) => (prev === dir ? null : prev)),
    dropOn: (dir) => (e) => {
      e.preventDefault();
      e.stopPropagation();
      const src = dragSource.current;
      dragSource.current = null;
      setDropTarget(null);
      if (!src) return;
      // 落到同一个目录 = 空操作（重名后端也会拒，这里直接不发起）
      const name = src.split('/').pop() ?? src;
      const to = dir ? `${dir}/${name}` : name;
      if (to === src) return;
      onMoveDrop?.(src, dir);
    },
  };

  // 2026-10-03 用户要求「文件夹默认折叠」：不再自动展开顶层目录，
  // 一进来就是折叠的树，要看哪一层自己点。

  /** 展开 / 收起一条目录链：链上所有目录同进同出（压缩成一行后它们共享一次点击）。 */
  const toggle = (paths: string[]) => {
    const willOpen = !expanded.has(paths[0]) || collapsed.has(paths[0]);
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const p of paths) {
        if (willOpen) next.add(p);
        else next.delete(p);
      }
      return next;
    });
    setCollapsed((prev) => {
      const next = new Set(prev);
      for (const p of paths) {
        if (willOpen) next.delete(p);
        else next.add(p);
      }
      return next;
    });
  };

  /**
   * FR-0012：把某个文件定位到树里 —— 展开它整条祖先链（含项目根那行），并排队滚动到它那一行。
   * 2026-10-15：根目录行也是一行且会参与「收拢」，所以这里必须把 `''` 一起放出来 ——
   * 否则「收拢 → 定位」看不到东西（根还折着）。
   */
  const revealPath = useCallback((path: string) => {
    const dirs = ['', ...ancestorDirs(path)];
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const d of dirs) next.add(d);
      return next;
    });
    setCollapsed((prev) => {
      if (!dirs.some((d) => prev.has(d))) return prev;
      const next = new Set(prev);
      for (const d of dirs) next.delete(d);
      return next;
    });
    setPendingReveal({ path, nonce: Date.now() });
  }, []);

  /** FR-0012：收拢所有文件夹 —— 清空展开集合，并把全部目录压进「显式折叠」集合（过滤状态下也收得动）。 */
  const collapseAll = useCallback(() => {
    setExpanded(new Set());
    setCollapsed(new Set([...allDirPaths(tree), '']));
    setPendingReveal(null);
    setFlashPath(null);
  }, [tree]);

  /** 2026-10-15：展开所有文件夹（含项目根）。 */
  const expandAll = useCallback(() => {
    setCollapsed(new Set());
    setExpanded(new Set(['', ...allDirPaths(tree)]));
  }, [tree]);

  // FR-0012：展开 / 折叠状态写回（挂载时多写一次，无副作用）。
  useEffect(() => {
    writeTreeState(projectId, { expanded: [...expanded], collapsed: [...collapsed] });
  }, [projectId, expanded, collapsed]);

  // FR-0012：外部信号（工具按钮 / 快捷键 / 标签右键）—— 每次 +1 就把当前打开文件定位到树里。
  useEffect(() => {
    if (revealToken > 0 && activeFile) revealPath(activeFile);
  }, [revealToken, activeFile, revealPath]);

  // FR-0012：外部信号 —— 每次 +1 就收拢所有文件夹。
  useEffect(() => {
    if (collapseAllToken > 0) collapseAll();
  }, [collapseAllToken, collapseAll]);

  // 2026-10-15：外部信号 —— 每次 +1 就展开所有文件夹。
  useEffect(() => {
    if (expandAllToken > 0) expandAll();
  }, [expandAllToken, expandAll]);

  // FR-0012：打开文件自动跟随（可在设置里关掉）；同一个文件只跟随一次，别跟「用户手动收拢」抢。
  useEffect(() => {
    if (!prefs.autoReveal || !activeFile) return;
    const mark = `${projectId ?? ''}|${activeFile}`;
    if (lastAutoRevealed === mark) return;
    lastAutoRevealed = mark;
    revealPath(activeFile);
  }, [activeFile, prefs.autoReveal, projectId, revealPath]);

  // FR-0012：待定位的行渲染出来后再滚动 + 闪烁（依赖里带上会影响可见性的量，展开后重试）。
  useLayoutEffect(() => {
    if (!pendingReveal) return;
    const host = containerRef.current;
    // 属性选择器里只须转义引号与反斜杠（路径里都是 `/`）
    const selector = `[data-path="${pendingReveal.path.replace(/["\\]/g, '\\$&')}"]`;
    const row = host?.querySelector<HTMLElement>(selector);
    if (!row) return; // 这一轮还不够（如在折叠的子树里 / 被过滤掉）：等依赖变化再试
    row.scrollIntoView({ block: 'nearest' });
    setFlashPath(pendingReveal.path);
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashPath(null), 1200);
    setPendingReveal(null);
  }, [pendingReveal, expanded, collapsed, filter, decor]);

  useEffect(
    () => () => {
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
    },
    [],
  );

  // 右键菜单：先按光标坐标摆（渲染前就落在那儿），再在布局阶段钳进视口 ——
  // 贴近窗口底部右击时整体上移（否则「复制路径 / 删除」这些下半截的项落到视口外点不到），
  // 贴住右边缘时左移。用 ref 直接改样式，paint 之前完成，不会看见跳一下。
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!menu || !el) return;
    const pad = 8;
    const { width, height } = el.getBoundingClientRect();
    el.style.left = `${Math.max(pad, Math.min(menu.x, window.innerWidth - pad - width))}px`;
    el.style.top = `${Math.max(pad, Math.min(menu.y, window.innerHeight - pad - height))}px`;
  }, [menu]);

  const children = useMemo(() => sortNodes(tree?.children ?? []), [tree]);

  /** 根目录行的名字：只显示最后一段（与下面的目录一样），不铺完整路径。 */
  const rootName =
    (projectRoot ?? '')
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ||
    tree?.name ||
    t('filetree.projectRoot');
  /** 根行默认展开；用户点过就折叠（过滤 / 只看时自动展开，和目录行同一口径）。 */
  const rootAuto = Boolean(filter || decor?.visible);
  const rootOpen = rootAuto || !collapsed.has('');
  /** 点根行 = 与目录行一样折叠 / 展开（key 用空串，即项目根）。 */
  const toggleRoot = () => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has('')) next.delete('');
      else next.add('');
      return next;
    });
  };

  if (!tree) return <div className="panel-empty">{t('filetree.noProject')}</div>;
  // 空树 / 被过滤空也要渲染容器：空白处右键才能对项目根新建（否则空项目里无路可走）
  const empty = !children.length || Boolean(decor?.visible && !children.some((c) => matchesVisible(c, decor.visible)));

  return (
    <div
      ref={containerRef}
      className={`file-tree${dropTarget === '' ? ' drop-target' : ''}`}
      onContextMenu={(e) => {
        // 空白处右键 = 对项目根操作（新建在根目录 / 粘贴到根目录）。
        // 只有事件直接落在容器自身（而非任何行/缝隙冒泡上来）才当「项目根」，
        // 否则目录/文件行之间的缝隙右击会误触发成项目根菜单。
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        setMenu({ path: '', isDir: true, x: e.clientX, y: e.clientY });
      }}
      onDragOver={(e) => {
        // 拖到空白 = 放到项目根（行上的 dragover 已 stopPropagation）
        if (!canDrop('')) return;
        e.preventDefault();
        setDropTarget('');
      }}
      onDragLeave={() => setDropTarget((prev) => (prev === '' ? null : prev))}
      onDrop={dnd.dropOn('')}
    >
      {/* 根目录行（2026-10-15 用户要求）：与下面的目录行同构 —— 只显示名字（不铺完整路径）、
          点击折叠 / 展开、右键是本目录的菜单（新建文件 / 新建文件夹 / 粘贴到这里）。
          右侧额外保留「复制项目链接」（此前明确要求复制入口在根目录上）。 */}
      <div
        className={`tree-row dir tree-root-row${dnd.target === '' ? ' drop-target' : ''}`}
        data-path=""
        onClick={toggleRoot}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ path: '', isDir: true, x: e.clientX, y: e.clientY });
        }}
        title={projectRoot ?? t('filetree.projectRoot')}
        onDragOver={(e) => {
          if (!canDrop('')) return;
          e.preventDefault();
          e.stopPropagation();
          dnd.setTarget('');
        }}
        onDragLeave={() => dnd.clearTarget('')}
        onDrop={dnd.dropOn('')}
      >
        <span className={`chevron ${rootOpen ? 'open' : ''}`} aria-hidden>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M6 4l4 4-4 4V4z" />
          </svg>
        </span>
        <FileIcon fileName={rootName} isDirectory size={16} />
        <span className="tree-name">
          <Highlight text={rootName} term={filter} />
        </span>
        <span className="tree-count">{tree?.count ?? 0}</span>
        {/* 2026-10-15 用户要求「根目录上的功能太少了」：把目录最常用的几个操作直接放到行上
            （悬停才显示）：新建文件 / 新建文件夹 / 粘贴到这里 / 复制项目链接；
            其余（复制路径、重命名类不做）仍在右键菜单里。 */}
        <span className="tree-root-actions">
          <button
            type="button"
            className="tree-root-act"
            title={t('filetree.newFile')}
            aria-label={t('filetree.newFile')}
            onClick={(e) => {
              e.stopPropagation();
              onNewFile?.('');
            }}
          >
            {/* 新建文件：文档 + 加号 */}
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8" />
              <path d="M13 3v6h6M18 2v5M15.5 4.5h5" />
            </svg>
          </button>
          <button
            type="button"
            className="tree-root-act"
            title={t('filetree.newDir')}
            aria-label={t('filetree.newDir')}
            onClick={(e) => {
              e.stopPropagation();
              onNewDir?.('');
            }}
          >
            {/* 新建文件夹：文件夹 + 加号 */}
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 7.2A1.7 1.7 0 0 1 4.7 5.5h4.4l1.7 2h8.5A1.7 1.7 0 0 1 21 9.2v7.6A1.7 1.7 0 0 1 19.3 18.5H4.7A1.7 1.7 0 0 1 3 16.8V7.2Z" />
              <path d="M12 12v4M10 14h4" />
            </svg>
          </button>
          {hasClipboard && (
            <button
              type="button"
              className="tree-root-act"
              title={t('filetree.paste')}
              aria-label={t('filetree.paste')}
              onClick={(e) => {
                e.stopPropagation();
                onPaste?.('');
              }}
            >
              {/* 粘贴：剪贴板 */}
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="8" y="4" width="8" height="4" rx="1" />
                <path d="M8 6H7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-1" />
              </svg>
            </button>
          )}
          <button
            type="button"
            className="tree-root-act tree-root-copy"
            disabled={!projectId}
            title={t('filetree.copyProjectLink')}
            aria-label={t('filetree.copyProjectLink')}
            onClick={(e) => {
              e.stopPropagation();
              onCopy?.(`${window.location.origin}/?project=${projectId ?? ''}`);
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M10 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7L11.5 6.3" />
              <path d="M14 10.5a4 4 0 0 0-5.7 0L5.5 13.3a4 4 0 0 0 5.7 5.7l1.3-1.3" />
            </svg>
          </button>
        </span>
      </div>
      {rootOpen &&
        (empty ? (
          <div className="panel-empty">{children.length ? t('filetree.noFilesFiltered') : t('filetree.noFiles')}</div>
        ) : (
          children.map((c) => (
            <TreeNode
              key={c.path}
              node={c}
              depth={1}
              activeFile={activeFile}
              onOpen={onOpen}
              filter={filter}
              decor={decor}
              expanded={expanded}
              collapsed={collapsed}
              flashPath={flashPath}
              toggle={toggle}
              dnd={dnd}
              onMenu={(e, path, isDir) => setMenu({ path, isDir, x: e.clientX, y: e.clientY })}
            />
          ))
        ))}
      {menu && (
        <>
          {/* 点空白关掉菜单：透明遮罩比全局监听更稳，也不与编辑器的手势抢 */}
          <div
            className="tree-menu-backdrop"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div ref={menuRef} className="tree-menu" style={{ top: menu.y, left: menu.x }} role="menu">
            <div className="tree-menu-file" title={menu.path || t('filetree.projectRoot')}>
              {menu.path || t('filetree.projectRoot')}
            </div>
            {/* 目录：新建与粘贴（项目根也算目录，空 path） */}
            {menu.isDir && (
              <>
                <button
                  role="menuitem"
                  onClick={() => {
                    onNewFile?.(menu.path);
                    setMenu(null);
                  }}
                >
                  {t('filetree.newFile')}
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    onNewDir?.(menu.path);
                    setMenu(null);
                  }}
                >
                  {t('filetree.newDir')}
                </button>
                {hasClipboard && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      onPaste?.(menu.path);
                      setMenu(null);
                    }}
                  >
                    {t('filetree.paste')}
                  </button>
                )}
                {/* 项目根：路径类操作（与普通目录同一套菜单的口径） */}
                {!menu.path && (
                  <>
                    <button
                      role="menuitem"
                      onClick={() => {
                        onCopy?.(projectRoot ?? rootName);
                        setMenu(null);
                      }}
                    >
                      {t('filetree.copyPath')}
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => {
                        onCopy?.(rootName);
                        setMenu(null);
                      }}
                    >
                      {t('filetree.copyFileName')}
                    </button>
                  </>
                )}
                <div className="tree-menu-sep" />
              </>
            )}
            {/* 改名 / 移动 / 复制（项目根不能改名或移动） */}
            {menu.path && (
              <>
                <button
                  role="menuitem"
                  onClick={() => {
                    onRename?.(menu.path);
                    setMenu(null);
                  }}
                >
                  {t('filetree.rename')}
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    onMove?.(menu.path);
                    setMenu(null);
                  }}
                >
                  {t('filetree.moveTo')}
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    onDuplicate?.(menu.path);
                    setMenu(null);
                  }}
                >
                  {t('filetree.duplicate')}
                </button>
                <div className="tree-menu-sep" />
                <button
                  role="menuitem"
                  onClick={() => {
                    onClipboard?.('copy', menu.path);
                    setMenu(null);
                  }}
                >
                  {t('filetree.copy')}
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    onClipboard?.('cut', menu.path);
                    setMenu(null);
                  }}
                >
                  {t('filetree.cut')}
                </button>
              </>
            )}
            {!menu.isDir && (
              <>
                <button
                  role="menuitem"
                  disabled={!isRunnable(menu.path)}
                  title={isRunnable(menu.path) ? undefined : t('filetree.runUnsupported')}
                  onClick={() => {
                    onRun?.(menu.path);
                    setMenu(null);
                  }}
                >
                  {t('filetree.runInTerminal')}
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    onOpenAside?.(menu.path);
                    setMenu(null);
                  }}
                >
                  {t('app.openAside')}
                </button>
              </>
            )}
            {menu.path && (
              <>
                <button
                  role="menuitem"
                  onClick={() => {
                    const abs = projectRoot ? projectRoot.replace(/\/+$/, '') + '/' + menu.path : menu.path;
                    onCopy?.(abs);
                    setMenu(null);
                  }}
                >
                  {t('filetree.copyPath')}
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    onCopy?.(menu.path);
                    setMenu(null);
                  }}
                >
                  {t('filetree.copyRelativePath')}
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    onCopy?.(menu.path.split('/').pop() ?? menu.path);
                    setMenu(null);
                  }}
                >
                  {t('filetree.copyFileName')}
                </button>
                <div className="tree-menu-sep" />
                <button
                  role="menuitem"
                  className="danger"
                  onClick={() => {
                    onDelete?.(menu.path, menu.isDir);
                    setMenu(null);
                  }}
                >
                  {t('filetree.delete')}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
