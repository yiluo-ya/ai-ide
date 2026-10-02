/** 文件树：目录可展开/折叠，点击文件打开；叠加「改动热力 / 来源徽标 / 已读」。 */
import { useMemo, useState } from 'react';
import type { FileOrigin } from '../../shared/types';
import type { FileNode } from './api';
import { heatLevel } from './mapState';
import { translate, useI18n } from './i18n';
import './filetree.css';

/** 文件树上叠加的事实（来自 /overview 与 /timeline，缺省即不显示徽标）。 */
export interface TreeDecor {
  /** 文件 → 时间与来源（M9/M10）。 */
  timeline?: Map<string, { mtimeMs: number; origin: FileOrigin; confidence: number }>;
  /** 没人引用的文件（M8.1）。 */
  orphans?: Set<string>;
  /** 热点骨架文件（M3.1）。 */
  hot?: Set<string>;
  /** 已读（M10.4）。 */
  read?: Set<string>;
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
  onToggleRead?: (file: string) => void;
  onToggleIgnored?: (file: string) => void;
  /** G3.5：右键菜单里的「加入待读」。 */
  onAddToQueue?: (file: string) => void;
}

/** 右键菜单（视口坐标定位）。 */
interface LeafMenu {
  file: string;
  x: number;
  y: number;
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
  const duty = info.from ? `${info.duty}（出处 ${info.from}）` : info.duty;
  return `${base}\n${translate('tree.dirDuty', { layer, duty })}`;
}

function matchesFilter(node: FileNode, term: string): boolean {
  if (!term) return true;
  if (node.type === 'file') return node.path.toLowerCase().includes(term.toLowerCase());
  return (node.children ?? []).some((c) => matchesFilter(c, term));
}

/** 过滤条件（只看最近改动 / agent 产出 / 孤立 / 未读）后的可见性。 */
function matchesVisible(node: FileNode, visible: Set<string> | undefined): boolean {
  if (!visible) return true;
  if (node.type === 'file') return visible.has(node.path);
  return (node.children ?? []).some((c) => matchesVisible(c, visible));
}

const ORIGIN_BADGE: Record<FileOrigin, { mark: string; title: string } | null> = {
  agent: { mark: '▣', title: '宿主上报：本轮 agent 产出' },
  recent: { mark: '◌', title: '最近改动（启发式推断，非「谁写的」）' },
  project: null,
};

function FileBadges({ file, decor }: { file: string; decor?: TreeDecor }) {
  const fact = decor?.timeline?.get(file);
  const level = heatLevel(fact?.mtimeMs);
  const origin = fact ? ORIGIN_BADGE[fact.origin] : null;
  const ignored = decor?.ignored?.has(file);
  const read = decor?.read?.has(file);
  const pulsing = decor?.pulse?.has(file);
  return (
    <>
      {pulsing && (
        <span className="badge pulse" title="刚被改动（本次会话内实时收到变更事件）">
          ●
        </span>
      )}
      {level >= 0 && (
        <span
          className={`heat heat-${level} ${pulsing ? 'is-pulse' : ''}`}
          title={fact ? `改动时间：${new Date(fact.mtimeMs).toLocaleString()}` : undefined}
        />
      )}
      {origin && (
        <span className="badge" title={`${origin.title}${fact ? `（置信度 ${fact.confidence}）` : ''}`}>
          {origin.mark}
        </span>
      )}
      {decor?.hot?.has(file) && <span className="badge hot" title="热点：被多个文件引用，适合当阅读起点">★</span>}
      {decor?.orphans?.has(file) && <span className="badge orphan" title="没人引用这个文件">?</span>}
      {read && <span className="badge read" title="已读过">✓</span>}
      {ignored && <span className="badge ignored" title="已标记忽略">∅</span>}
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
  toggle,
  onToggleRead,
  onToggleIgnored,
  onMenu,
}: {
  node: FileNode;
  depth: number;
  activeFile: string | null;
  onOpen: (file: string) => void;
  filter: string;
  decor?: TreeDecor;
  expanded: Set<string>;
  toggle: (path: string) => void;
  onToggleRead?: (file: string) => void;
  onToggleIgnored?: (file: string) => void;
  onMenu: (e: React.MouseEvent, file: string) => void;
}) {
  if (!matchesFilter(node, filter) || !matchesVisible(node, decor?.visible)) return null;

  if (node.type === 'directory') {
    // 过滤时自动展开，方便直接看到命中项
    const open = filter || decor?.visible ? true : expanded.has(node.path) || depth === 0;
    const children = (node.children ?? []).filter(
      (c) => matchesFilter(c, filter) && matchesVisible(c, decor?.visible),
    );
    return (
      <div className="tree-dir">
        <div
          className="tree-row dir"
          style={{ paddingLeft: depth * 12 + 6 }}
          onClick={() => toggle(node.path)}
          title={dirTitle(node, decor)}
        >
          <span className={`chevron ${open ? 'open' : ''}`}>▸</span>
          <span className="tree-name">
            <Highlight text={node.name} term={filter} />
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
              toggle={toggle}
              onToggleRead={onToggleRead}
              onToggleIgnored={onToggleIgnored}
              onMenu={onMenu}
            />
          ))}
      </div>
    );
  }

  const className = [
    'tree-row',
    'file',
    activeFile === node.path ? 'active' : '',
    decor?.read?.has(node.path) ? 'read' : '',
    decor?.ignored?.has(node.path) ? 'ignored' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={className}
      style={{ paddingLeft: depth * 12 + 18 }}
      onClick={() => onOpen(node.path)}
      onContextMenu={(e) => {
        // 右键：打开小菜单（含「加入待读」，G3.5）；Alt+右键仍是「切忽略」的老手势
        e.preventDefault();
        if (e.altKey) onToggleIgnored?.(node.path);
        else onMenu(e, node.path);
      }}
      title={node.path}
    >
      <span className={`lang-dot lang-${node.lang ?? 'plaintext'}`} />
      <span className="tree-name">
        <Highlight text={node.name} term={filter} />
      </span>
      <FileBadges file={node.path} decor={decor} />
    </div>
  );
}

export function FileTree({
  tree,
  activeFile,
  onOpen,
  filter = '',
  decor,
  onToggleRead,
  onToggleIgnored,
  onAddToQueue,
}: Props) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  /** G3.5：右键菜单；null = 不开。 */
  const [menu, setMenu] = useState<LeafMenu | null>(null);
  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const children = useMemo(() => tree?.children ?? [], [tree]);

  if (!tree) return <div className="panel-empty">尚未打开项目</div>;
  if (!children.length) return <div className="panel-empty">项目里没有可读文件</div>;
  if (decor?.visible && !children.some((c) => matchesVisible(c, decor.visible))) {
    return <div className="panel-empty">当前过滤条件下没有文件</div>;
  }

  return (
    <div className="file-tree">
      {children.map((c) => (
        <TreeNode
          key={c.path}
          node={c}
          depth={0}
          activeFile={activeFile}
          onOpen={onOpen}
          filter={filter}
          decor={decor}
          expanded={expanded}
          toggle={toggle}
          onToggleRead={onToggleRead}
          onToggleIgnored={onToggleIgnored}
          onMenu={(e, file) => setMenu({ file, x: e.clientX, y: e.clientY })}
        />
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
          <div className="tree-menu" style={{ top: menu.y, left: menu.x }} role="menu">
            <div className="tree-menu-file" title={menu.file}>
              {menu.file}
            </div>
            <button
              role="menuitem"
              onClick={() => {
                onToggleRead?.(menu.file);
                setMenu(null);
              }}
            >
              {decor?.read?.has(menu.file) ? t('guide.nav.markUnread') : t('guide.nav.markRead')}
            </button>
            <button
              role="menuitem"
              onClick={() => {
                onAddToQueue?.(menu.file);
                setMenu(null);
              }}
            >
              {t('guide.nav.queue')}
            </button>
            <button
              role="menuitem"
              onClick={() => {
                onToggleIgnored?.(menu.file);
                setMenu(null);
              }}
            >
              {decor?.ignored?.has(menu.file) ? t('guide.nav.unignore') : t('guide.nav.ignore')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
