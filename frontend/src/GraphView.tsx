/**
 * 依赖图 + 目录职责 / 目录级反依赖 + 符号下钻（docs/01-map.md §3 形态二、§6 边界）。
 *
 * 几条设计约束决定了这个文件的写法：
 * 1. 图是只读展示层：不做任何编辑动作；外部依赖节点一律不给假跳转（§6）。
 * 2. 布局必须稳定：力导向只在 useMemo 里同步跑完固定步数并 stop()，
 *    节点坐标一次算定、不留动画循环，所以重绘不会让图抖。
 * 3. 大仓默认按目录聚合、按需展开：expand 只增删目录 id，重新聚合交给后端。
 * 4. 泳道布局（M4.2）用 forceY/forceX 吸附 + 每 tick 夹一次 y 把「在带内」变成硬约束：
 *    光靠力，链接拉力会把节点扯出带（实测偏出 2 倍半高）；只靠事后夹一次，
 *    被夹回的节点会与同带邻居重叠——每 tick 夹、再让 collide 在 x 上解开才是稳的。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from 'd3-force';
import type { SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';
import { api } from './api';
import { mapApi } from './mapApi';
import type { DependencyGraph, DependentsResult, DirDependentsResult } from './mapApi';
// GraphNode / GraphEdge / SymbolInfo 只有 shared/types 里才是真定义（mapApi 只再导出了其中一部分）
import type { GraphEdge, GraphLayer, GraphNode, SymbolInfo } from '../../shared/types';
import { translate, useI18n } from './i18n';
import './graph.css';

/** 与后端 `dirIdOf('')` 一致：根目录节点 id。前端靠它把根目录下的文件认到 ./ 名下。 */
const ROOT_DIR_ID = './';

interface Props {
  projectId: string;
  activeFile?: string | null;
  /** line 是 1 基行号；不传 = 打开到文件头。 */
  onOpenFile: (file: string, line?: number) => void;
  onClose: () => void;
  /** 从 URL 快照恢复的初始视图（M20 阶段五）。 */
  initial?: Partial<GraphViewState>;
  /** 视图变化上报，供调用方写回 URL（M20）。 */
  onViewChange?: (state: GraphViewState) => void;
}

/** 依赖图的视图状态（可被 URL 表达）：级别 / 展开的目录 / 外部依赖 / 布局。 */
export interface GraphViewState {
  level: 'dir' | 'file';
  expand: string[];
  external: boolean;
  layout: LayoutMode;
}

/** 泳道 = 目录节点按职责分层排带；自由 = 原来的力导向。 */
export type LayoutMode = 'lanes' | 'free';

/** 可视区域（SVG 用户坐标）。拖动 = 平移它，滚轮 = 缩放它。 */
export interface View {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type SimNode = GraphNode & SimulationNodeDatum;
export type SimEdge = GraphEdge & SimulationLinkDatum<SimNode>;

/** 一条泳道的色带几何（坐标与节点同一套 SVG 用户坐标）。 */
export interface LaneBand {
  layer: GraphLayer;
  label: string;
  y: number;
  halfH: number;
  x0: number;
  x1: number;
}

export interface Layout {
  nodes: SimNode[];
  edges: SimEdge[];
  /** 初始（重置视图用）的可视区域。 */
  base: View;
  /** 泳道色带；自由布局时为空数组。 */
  bands: LaneBand[];
}

const LAYER_COLOR: Record<string, string> = {
  entry: '#e2c08d',
  domain: '#3178c6',
  infra: '#6b9440',
  utility: '#b18cd9',
  isolated: '#6a6a6a',
};

/** 后端没给 lanes 时的兜底层名（正常情况下用 lanes[i].label）。 */
const LAYER_LABEL: Record<GraphLayer, string> = {
  entry: 'layer.entry',
  domain: 'layer.domain',
  infra: 'layer.infra',
  utility: 'layer.utility',
  isolated: 'layer.isolated',
};

const SYMBOL_KIND_CN: Record<string, string> = {
  function: 'kind.function',
  class: 'kind.class',
  method: 'kind.method',
  interface: 'kind.interface',
  enum: 'kind.enum',
  constant: 'kind.constant',
  variable: 'kind.variable',
  constructor: 'kind.constructor',
  property: 'kind.property',
};

/** 泳道带的几何常量：间距 = 相邻泳道中心线距离。 */
const LANE_SPACING = 152;
const LANE_HALF_H = 64;
/** 泳道内沿 x 均分时，单个节点的最大间隔与整条泳道的跨度上限。 */
const LANE_SPREAD_MAX = 170;
const LANE_SPREAD_SPAN = 1400;
/** 不属于任何泳道的节点（文件 / 外部依赖）与最后一条泳道的距离。 */
const LANE_FREE_GAP = 128;
/** 夹取系数（相对半高）：夹得太紧会把同带节点挤成一行，太松则跑进隔壁泳道。 */
const LANE_CLAMP = 0.6;
/** 力导向的固定步数：泳道比自由布局多一层约束，多跑 100 步让 x 方向收敛。 */
const LAYOUT_TICKS = 400;

/** 符号一节默认只列前 N 个，避免长文件把面板撑成一堵墙。 */
const SYMBOL_LIMIT = 20;

export function nodeRadius(n: GraphNode): number {
  if (n.kind === 'dir') return 6 + Math.min(18, Math.sqrt(Math.max(0, n.files)) * 1.6);
  if (n.kind === 'external') return 5;
  return 4 + Math.min(10, n.inbound + n.outbound);
}

export function nodeFill(n: GraphNode): string {
  if (n.kind === 'dir') return LAYER_COLOR[n.layer ?? 'domain'] ?? '#3178c6';
  if (n.kind === 'external') return '#6a6a6a';
  if (n.test) return '#8a8a8a';
  if (n.entry) return '#dcdcaa';
  return '#4a9edb';
}

export function nodeTitle(n: GraphNode): string {
  if (n.kind === 'external') {
    return translate('graph.nodeTitleExternal', {
      name: n.label,
      inbound: n.inbound,
      files: n.files,
    });
  }
  if (n.kind === 'dir') {
    const layer = n.layer
      ? translate('graph.nodeTitleDirLayer', { layer: translate(LAYER_LABEL[n.layer]) })
      : '';
    return translate('graph.nodeTitleDir', {
      name: n.label,
      files: n.files,
      inbound: n.inbound,
      outbound: n.outbound,
      layer,
    });
  }
  const tags = [n.entry ? translate('flow.badgeEntry') : '', n.test ? translate('flow.badgeTest') : '']
    .filter(Boolean)
    .join(' · ');
  return translate('graph.nodeTitleFile', {
    id: n.id,
    tags: tags ? translate('graph.nodeTitleTags', { tags }) : '',
    inbound: n.inbound,
    outbound: n.outbound,
  });
}

/** 标签是噪声的主要来源，这里只在「有信息量」的节点上显示。 */
export function labelVisible(
  n: GraphNode,
  selected: string | null,
  hover: string | null,
  activeFile: string | null | undefined,
): boolean {
  if (n.kind !== 'file') return true;
  if (n.focus || n.id === selected || n.id === hover || n.id === activeFile) return true;
  return n.inbound + n.outbound >= 2;
}

/** 同步跑完固定步数的力导向布局，返回节点坐标、边、泳道色带与包围盒。 */
export function layoutGraph(graph: DependencyGraph, mode: LayoutMode): Layout | null {
  if (graph.nodes.length === 0) return null;
  const ids = new Set(graph.nodes.map((n) => n.id));
  // 全部复制：forceLink 会把 source/target 改写成节点对象引用，不能污染接口返回的数据
  const nodes: SimNode[] = graph.nodes.map((n) => ({ ...n }));
  const edges: SimEdge[] = graph.edges
    .filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to)
    .map((e) => ({ ...e, source: e.from, target: e.to }));

  // 泳道模式：目录节点压到自己那一层的水平带上，文件 / 外部节点排到泳道图下方一行
  const laneOn = mode === 'lanes' && graph.lanes.length > 0;
  const slotX = new Map<string, number>();
  const slotY = new Map<string, number>();
  const bands: LaneBand[] = [];
  let freeY = 0;
  if (laneOn) {
    graph.lanes.forEach((lane, li) => {
      const y = li * LANE_SPACING;
      bands.push({ layer: lane.layer, label: lane.label, y, halfH: LANE_HALF_H, x0: 0, x1: 0 });
      const count = lane.nodes.length;
      const step = count > 1 ? Math.min(LANE_SPREAD_MAX, LANE_SPREAD_SPAN / (count - 1)) : 0;
      lane.nodes.forEach((id, i) => {
        slotX.set(id, (i - (count - 1) / 2) * step);
        slotY.set(id, y);
      });
    });
    freeY = (bands.length - 1) * LANE_SPACING + LANE_FREE_GAP;
  }
  const laneNode = (d: SimNode) => slotY.has(d.id);

  // 文件节点归属到「最近的、图上存在的祖先目录」：展开目录时文件就贴着它排，
  // 而不是被统一下沉到最后一行 —— 那正是「一堆文件堆在一起」的观感来源。
  const dirIds = new Set(graph.nodes.filter((n) => n.kind === 'dir').map((n) => n.id));
  const parentDirOf = new Map<string, string>();
  for (const n of graph.nodes) {
    if (n.kind !== 'file') continue;
    const parts = n.id.split('/');
    for (let i = parts.length - 1; i > 0; i -= 1) {
      const candidate = `${parts.slice(0, i).join('/')}/`;
      if (dirIds.has(candidate)) {
        parentDirOf.set(n.id, candidate);
        break;
      }
    }
    if (!parentDirOf.has(n.id) && dirIds.has(ROOT_DIR_ID)) parentDirOf.set(n.id, ROOT_DIR_ID);
  }
  /** 节点的锚：目录锚自己，文件锚父目录；都没有（外部依赖 / 根目录文件）返回 undefined。 */
  const anchorOf = (d: SimNode): string | undefined =>
    laneNode(d) ? d.id : parentDirOf.get(d.id);

  const targetX = (d: SimNode) => {
    if (!laneOn) return 0;
    const anchor = anchorOf(d);
    return anchor ? (slotX.get(anchor) ?? 0) : 0;
  };
  const targetY = (d: SimNode) => {
    if (!laneOn) return 0;
    const anchor = anchorOf(d);
    return anchor ? (slotY.get(anchor) ?? freeY) : freeY;
  };
  const strengthX = (d: SimNode) => {
    if (!laneOn) return 0.04;
    if (laneNode(d)) return 0.3;
    return parentDirOf.has(d.id) ? 0.12 : 0.02;
  };
  const strengthY = (d: SimNode) => {
    if (!laneOn) return 0.04;
    return laneNode(d) ? 0.7 : 0.35;
  };

  const sim = forceSimulation<SimNode>(nodes)
    .force(
      'link',
      forceLink<SimNode, SimEdge>(edges)
        .id((d) => d.id)
        .distance((e) => 50 + Math.min(80, (e.imports + e.refs) * 5))
        .strength(0.25),
    )
    .force('charge', forceManyBody<SimNode>().strength(-220))
    .force('collide', forceCollide<SimNode>().radius((d) => nodeRadius(d) + 6))
    .force('x', forceX<SimNode>(targetX).strength(strengthX))
    .force('y', forceY<SimNode>(targetY).strength(strengthY))
    .stop();
  // 泳道模式不加 forceCenter：它会把整叠泳道整体平移，色带坐标就与节点对不上了
  if (!laneOn) sim.force('center', forceCenter<SimNode>(0, 0));
  const lim = LANE_HALF_H * LANE_CLAMP;
  for (let i = 0; i < LAYOUT_TICKS; i += 1) {
    sim.tick();
    if (!laneOn) continue;
    for (const n of nodes) {
      // 目录与它的文件都夹在自己那条泳道里；外部依赖没有归属，仍压在泳道图下方一行
      const anchor = anchorOf(n);
      const target = anchor ? (slotY.get(anchor) ?? freeY) : freeY;
      n.y = Math.max(target - lim, Math.min(target + lim, n.y ?? 0));
    }
  }

  if (laneOn) {
    // 色带的左右边界按泳道内节点的实际落点算：不同层节点数差很多，固定宽度会看不出归属
    const xs = nodes.filter((n) => anchorOf(n) !== undefined).map((n) => n.x ?? 0);
    const x0 = (xs.length ? Math.min(...xs) : 0) - 74;
    const x1 = (xs.length ? Math.max(...xs) : 0) + 74;
    for (const band of bands) {
      band.x0 = x0;
      band.x1 = x1;
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const stretch = (x: number, y: number, r: number) => {
    minX = Math.min(minX, x - r);
    maxX = Math.max(maxX, x + r);
    minY = Math.min(minY, y - r);
    maxY = Math.max(maxY, y + r);
  };
  for (const n of nodes) {
    // 半径外的余量留给标签
    stretch(n.x ?? 0, n.y ?? 0, nodeRadius(n) + 20);
  }
  for (const band of bands) {
    stretch(band.x0 - 8, band.y, band.halfH + 8);
    stretch(band.x1 + 8, band.y, band.halfH + 8);
  }

  const pad = 24;
  const contentW = maxX - minX + pad * 2;
  const contentH = maxY - minY + pad * 2;
  const w = Math.max(240, contentW);
  const h = Math.max(160, contentH);
  const base: View = {
    // 兜底最小尺寸时把内容居中，避免图缩在一角
    x: minX - pad - (w - contentW) / 2,
    y: minY - pad - (h - contentH) / 2,
    w,
    h,
  };
  return { nodes, edges, base, bands };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function kindLabel(kind: string): string {
  const key = SYMBOL_KIND_CN[kind];
  return key ? translate(key) : kind;
}

/** 把 [{x, depth}] 这类列表按跳数分组，供「传递上游」逐层展示。 */
export function groupByDepth<T extends { depth: number }>(items: T[] | undefined): Array<[number, T[]]> {
  const groups = new Map<number, T[]>();
  for (const item of items ?? []) {
    const list = groups.get(item.depth);
    if (list) list.push(item);
    else groups.set(item.depth, [item]);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]);
}

export function GraphView({ projectId, activeFile, onOpenFile, onClose, initial, onViewChange }: Props) {
  const { t, locale } = useI18n();
  const [level, setLevel] = useState<'dir' | 'file'>(initial?.level ?? 'dir');
  const [expand, setExpand] = useState<string[]>(initial?.expand ?? []);
  const [withExternal, setWithExternal] = useState(initial?.external ?? false);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(initial?.layout ?? 'lanes');
  const [graph, setGraph] = useState<DependencyGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [deps, setDeps] = useState<DependentsResult | null>(null);
  const [depsLoading, setDepsLoading] = useState(false);
  const [depsError, setDepsError] = useState<string | null>(null);
  const [dirDeps, setDirDeps] = useState<DirDependentsResult | null>(null);
  const [dirDepsLoading, setDirDepsLoading] = useState(false);
  const [dirDepsError, setDirDepsError] = useState<string | null>(null);
  const [symbols, setSymbols] = useState<SymbolInfo[] | null>(null);
  const [symbolsLoading, setSymbolsLoading] = useState(false);
  const [symbolsError, setSymbolsError] = useState<string | null>(null);
  const [symbolsExpanded, setSymbolsExpanded] = useState(false);

  const [view, setView] = useState<View | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ px: number; py: number; vb: View } | null>(null);

  // M20：把当前视图报上去，调用方写进 URL —— 这样「看这个模块的依赖图」也能被贴给同事
  useEffect(() => {
    onViewChange?.({ level, expand, external: withExternal, layout: layoutMode });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, expand, withExternal, layoutMode]);

  // Esc 关闭浮层：它盖住了编辑器，不能只靠鼠标找按钮。
  // 走 capture 阶段：双击节点会打开文件、焦点落进 Monaco 的 textarea，编辑器会把 Escape 吞掉，
  // 冒泡阶段挂在 window 上的监听就收不到（按钮上写着「关闭（Esc）」却关不掉）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    mapApi
      .graph(projectId, {
        level,
        expand,
        external: withExternal ? 20 : 0,
        // 2026-10-03 用户反馈「一堆文件堆在一起」：默认目录级视图不再强制把
        // 入口 / 热点提到文件级（focus: [] = 不提升）——要看某个目录里的文件，
        // 点那个目录展开即可；文件级视图本就是全文件，不受影响。
        ...(level === 'dir' && expand.length === 0 ? { focus: [] } : {}),
      })
      .then((g) => {
        if (cancelled) return;
        setGraph(g);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setGraph(null);
        setError(errText(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, level, expand, withExternal]);

  /**
   * 泳道是目录级的概念：文件级下目录节点只剩 0 条边的空壳，排进泳道只会变成噪声，
   * 所以那里强制退回自由布局（按钮保留选中态，切回目录级即恢复）。
   */
  const laneAvailable = level === 'dir' && !!graph && graph.lanes.length > 0;
  const effectiveMode: LayoutMode = laneAvailable && layoutMode === 'lanes' ? 'lanes' : 'free';
  const layout = useMemo(
    () => (graph ? layoutGraph(graph, effectiveMode) : null),
    [graph, effectiveMode],
  );

  useEffect(() => {
    setView(layout ? layout.base : null);
  }, [layout]);

  const nodeById = useMemo(() => {
    const map = new Map<string, GraphNode>();
    graph?.nodes.forEach((n) => map.set(n.id, n));
    return map;
  }, [graph]);

  /** 节点 id → 环编号（用于 M7.2 的环高亮）。 */
  const cycleOf = useMemo(() => {
    const map = new Map<string, number>();
    graph?.cycles.forEach((cycle, i) => cycle.forEach((id) => map.set(id, i)));
    return map;
  }, [graph]);

  /**
   * 目录 id 一律以 `/` 结尾（根目录是 `./`）。选中项可能不在当前图里
   * （例如面板里点了别的目录），所以拿不到节点时按 id 形状判型。
   */
  const selectedDir = useMemo(() => {
    if (!selected) return null;
    const node = nodeById.get(selected);
    return (node ? node.kind === 'dir' : selected.endsWith('/')) ? selected : null;
  }, [selected, nodeById]);

  /** 只有文件才查反向依赖；目录与外部依赖没有这个语义。 */
  const selectedFile = useMemo(() => {
    if (!selected || selectedDir || selected.startsWith('ext:')) return null;
    const node = nodeById.get(selected);
    if (node && node.kind !== 'file') return null;
    return selected;
  }, [selected, selectedDir, nodeById]);

  useEffect(() => {
    if (!selectedFile) {
      setDeps(null);
      setDepsError(null);
      setDepsLoading(false);
      return;
    }
    let cancelled = false;
    setDepsLoading(true);
    setDepsError(null);
    mapApi
      .dependents(projectId, selectedFile, 2)
      .then((r) => {
        if (cancelled) return;
        setDeps(r);
        setDepsLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setDeps(null);
        setDepsError(errText(e));
        setDepsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, selectedFile]);

  /** M6.2：目录级反依赖单独一条请求——文件级的入边并不能回答「这块动了谁受影响」。 */
  useEffect(() => {
    if (!selectedDir) {
      setDirDeps(null);
      setDirDepsError(null);
      setDirDepsLoading(false);
      return;
    }
    let cancelled = false;
    setDirDepsLoading(true);
    setDirDepsError(null);
    mapApi
      .dirDependents(projectId, selectedDir, 2)
      .then((r) => {
        if (cancelled) return;
        setDirDeps(r);
        setDirDepsLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setDirDeps(null);
        setDirDepsError(errText(e));
        setDirDepsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, selectedDir]);

  /** M4.4：文件级下钻到符号，点符号能定位到它那一行。 */
  useEffect(() => {
    setSymbolsExpanded(false);
    if (!selectedFile) {
      setSymbols(null);
      setSymbolsError(null);
      setSymbolsLoading(false);
      return;
    }
    let cancelled = false;
    setSymbolsLoading(true);
    setSymbolsError(null);
    api
      .documentSymbols(projectId, selectedFile)
      .then((list) => {
        if (cancelled) return;
        setSymbols(list ?? []);
        setSymbolsLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setSymbols(null);
        setSymbolsError(errText(e));
        setSymbolsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, selectedFile]);

  /** 传递上游按跳数分组展示，便于逐层评估影响面。 */
  const transitiveGroups = useMemo(() => groupByDepth(deps?.transitive), [deps]);
  const dirTransitiveGroups = useMemo(() => groupByDepth(dirDeps?.transitive), [dirDeps]);

  /** 目录面板的静态部分：职责、出处、分层依据都来自 graph.duties，无需额外请求。 */
  const dirInfo = useMemo(() => {
    if (!selectedDir) return null;
    const duty = graph?.duties[selectedDir];
    const node = nodeById.get(selectedDir);
    const layer = node?.layer ?? null;
    const laneLabel =
      graph?.lanes.find((lane) => lane.nodes.includes(selectedDir))?.label ??
      translate(layer ? LAYER_LABEL[layer] : 'graph.noLayer', undefined, locale);
    return {
      duty: duty?.duty ?? node?.duty ?? '',
      from: duty?.from ?? node?.dutyFrom ?? null,
      layerReason: duty?.layerReason ?? translate('graph.noLayerReason', undefined, locale),
      laneLabel,
    };
  }, [selectedDir, graph, nodeById, locale]);

  const visibleSymbols = symbols
    ? symbolsExpanded
      ? symbols
      : symbols.slice(0, SYMBOL_LIMIT)
    : [];

  // 滚轮缩放挂在原生监听上：React 的 onWheel 是 passive 的，preventDefault 不生效
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !layout) return;
    const base = layout.base;
    const onWheel = (e: WheelEvent) => {
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      e.preventDefault();
      setView((prev) => {
        if (!prev) return prev;
        const k = Math.min(rect.width / prev.w, rect.height / prev.h);
        const ox = (rect.width - prev.w * k) / 2;
        const oy = (rect.height - prev.h * k) / 2;
        const gx = prev.x + (e.clientX - rect.left - ox) / k;
        const gy = prev.y + (e.clientY - rect.top - oy) / k;
        const factor = Math.exp(-e.deltaY * 0.0015);
        // 缩放限制在初始视图的 0.3x ~ 4x
        const w = Math.min(base.w / 0.3, Math.max(base.w / 4, prev.w / factor));
        const h = w * (prev.h / prev.w);
        return {
          x: gx - (gx - prev.x) * (w / prev.w),
          y: gy - (gy - prev.y) * (h / prev.h),
          w,
          h,
        };
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [layout]);

  const toggleDir = (id: string) => {
    setExpand((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const switchLevel = (next: 'dir' | 'file') => {
    if (next === level) return;
    setLevel(next);
    // 文件级没有「目录」可展开，顺手清掉避免把上一层的 expand 带过去
    if (next === 'file') setExpand([]);
    setSelected(null);
  };

  const resetView = () => {
    if (layout) setView(layout.base);
  };

  const onNodeClick = (n: GraphNode) => {
    if (n.kind === 'dir') {
      // 展开/收起的同时选中它：右侧面板要换成「目录职责 + 目录级反依赖」
      setSelected(n.id);
      toggleDir(n.id);
      return;
    }
    // 边界：外部依赖只标注不给假跳转，所以也不进入选中态
    if (n.kind === 'external') return;
    setSelected(n.id);
  };

  const stopPointer = (e: ReactPointerEvent<SVGGElement>) => {
    e.stopPropagation();
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || !view) return;
    dragRef.current = { px: e.clientX, py: e.clientY, vb: view };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    const svg = svgRef.current;
    if (!drag || !svg) return;
    const rect = svg.getBoundingClientRect();
    // 用按下时的视口算比例，拖拽过程中才不会因为 view 变化而加速
    const k = Math.min(rect.width / drag.vb.w, rect.height / drag.vb.h) || 1;
    setView({
      ...drag.vb,
      x: drag.vb.x - (e.clientX - drag.px) / k,
      y: drag.vb.y - (e.clientY - drag.py) / k,
    });
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const box = view ?? (layout ? layout.base : null);
  const testedDirs = dirDeps ? dirDeps.direct.filter((d) => d.tests > 0).length : 0;

  return (
    <div className="graph-view">
      <header className="gv-head">
        <span className="gv-title">{t('graph.title')}</span>
        <div className="gv-levels">
          <button
            className={`gv-btn${level === 'dir' ? ' is-on' : ''}`}
            onClick={() => switchLevel('dir')}
          >
            {t('graph.levelDir')}
          </button>
          <button
            className={`gv-btn${level === 'file' ? ' is-on' : ''}`}
            onClick={() => switchLevel('file')}
          >
            {t('graph.levelFile')}
          </button>
        </div>
        <span className="gv-axis-label">{t('graph.layout')}</span>
        <div className="gv-levels">
          <button
            className={`gv-btn${layoutMode === 'lanes' && laneAvailable ? ' is-on' : ''}`}
            onClick={() => setLayoutMode('lanes')}
            disabled={!laneAvailable}
            title={
              laneAvailable ? t('graph.lanesTitle') : t('graph.lanesDisabledTitle')
            }
          >
            {t('graph.lanes')}
          </button>
          <button
            className={`gv-btn${layoutMode === 'free' ? ' is-on' : ''}`}
            onClick={() => setLayoutMode('free')}
            title={t('graph.freeTitle')}
          >
            {t('graph.free')}
          </button>
        </div>
        <label className="gv-toggle">
          <input
            type="checkbox"
            checked={withExternal}
            onChange={(e) => setWithExternal(e.target.checked)}
          />
          {t('flow.external')}
        </label>
        <button className="gv-btn" onClick={resetView} disabled={!layout}>
          {t('flow.reset')}
        </button>
        <span className="gv-stat">
          {graph
            ? t('flow.stat', { nodes: graph.nodes.length, edges: graph.edges.length })
            : '—'}
        </span>
        {graph && graph.truncated > 0 && (
          <span className="gv-warn">{t('graph.truncated', { n: graph.truncated })}</span>
        )}
        <button className="gv-btn gv-close" onClick={onClose} title={t('flow.closeTitle')}>
          {t('common.close')}
        </button>
      </header>

      <div className="gv-body">
        <div className="gv-canvas-wrap">
          {layout && box && (
            <svg
              ref={svgRef}
              className="gv-canvas"
              viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
              preserveAspectRatio="xMidYMid meet"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={() => {
                dragRef.current = null;
                setHover(null);
              }}
            >
              <defs>
                <marker
                  id="gv-arrow"
                  viewBox="0 0 10 10"
                  refX="10"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--graph-edge)" />
                </marker>
                <marker
                  id="gv-arrow-cycle"
                  viewBox="0 0 10 10"
                  refX="10"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--danger)" />
                </marker>
              </defs>

              {/* 泳道色带画在最底层：它是背景语义，不能抢边的可读性 */}
              {layout.bands.map((band) => (
                <g key={`lane-${band.layer}`} className="gv-lane">
                  <rect
                    className={`gv-lane-bg gv-lane-${band.layer}`}
                    x={band.x0}
                    y={band.y - band.halfH}
                    width={Math.max(1, band.x1 - band.x0)}
                    height={band.halfH * 2}
                    rx={12}
                  />
                  <text
                    className="gv-lane-label"
                    x={band.x0 + 16}
                    y={band.y}
                    transform={`rotate(-90 ${band.x0 + 16} ${band.y})`}
                    textAnchor="middle"
                  >
                    {band.label}
                  </text>
                </g>
              ))}

              {layout.edges.map((e, i) => {
                const from = typeof e.source === 'object' ? e.source : null;
                const to = typeof e.target === 'object' ? e.target : null;
                if (!from || !to) return null;
                const onCycle =
                  cycleOf.get(e.from) !== undefined && cycleOf.get(e.from) === cycleOf.get(e.to);
                const weight = 1 + Math.log2(Math.max(1, e.imports + e.refs));
                return (
                  <line
                    key={`e${i}`}
                    className={onCycle ? 'gv-edge gv-edge-cycle' : 'gv-edge'}
                    x1={from.x ?? 0}
                    y1={from.y ?? 0}
                    x2={to.x ?? 0}
                    y2={to.y ?? 0}
                    strokeWidth={onCycle ? weight + 0.8 : weight}
                    strokeOpacity={onCycle ? 0.85 : 0.55}
                    markerEnd={`url(#${onCycle ? 'gv-arrow-cycle' : 'gv-arrow'})`}
                  />
                );
              })}

              {layout.nodes.map((n) => {
                const r = nodeRadius(n);
                const isSelected = n.id === selected;
                const isActive = n.kind === 'file' && !!activeFile && n.id === activeFile;
                const outlined = isSelected || isActive;
                return (
                  <g
                    key={n.id}
                    className="gv-node"
                    data-kind={n.kind}
                    data-id={n.id}
                    transform={`translate(${n.x ?? 0} ${n.y ?? 0})`}
                    onPointerDown={stopPointer}
                    onClick={() => onNodeClick(n)}
                    onDoubleClick={() => {
                      if (n.kind === 'file') onOpenFile(n.id);
                    }}
                    onMouseEnter={() => setHover(n.id)}
                    onMouseLeave={() => setHover(null)}
                  >
                    <title>{nodeTitle(n)}</title>
                    <circle
                      r={r}
                      fill={nodeFill(n)}
                      stroke={outlined ? '#ffffff' : 'rgba(0, 0, 0, 0.55)'}
                      strokeWidth={outlined ? 2 : 1}
                      strokeDasharray={n.kind === 'external' ? '3 2' : undefined}
                    />
                    {labelVisible(n, selected, hover, activeFile) && (
                      <text
                        className={isActive ? 'gv-label is-strong' : 'gv-label'}
                        y={r + 11}
                        textAnchor="middle"
                      >
                        {n.label}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          )}
          {loading && <div className="gv-status">{t('graph.loading')}</div>}
          {error && <div className="gv-status gv-status-err">{error}</div>}
          {!loading && !error && !layout && <div className="gv-status">{t('graph.empty')}</div>}
        </div>

        {selected && (
          <aside className="gv-side">
            <div className="gv-side-head">
              <span className="gv-side-file" title={selected}>
                {selected}
              </span>
              <div className="gv-side-actions">
                {selectedFile && (
                  <button className="gv-btn" onClick={() => onOpenFile(selectedFile, 1)}>
                    {t('flow.openFile')}
                  </button>
                )}
                <button className="gv-btn" onClick={() => setSelected(null)}>
                  {t('common.close')}
                </button>
              </div>
            </div>
            <div className="gv-side-body">
              {selectedDir && dirInfo && (
                <>
                  <p className="gv-note gv-note-layer">
                    {t('graph.layerNote', {
                      lane: dirInfo.laneLabel,
                      reason: dirInfo.layerReason,
                    })}
                  </p>

                  <section className="gv-sec">
                    <h4 className="gv-sec-title">{t('graph.dutyTitle')}</h4>
                    {dirInfo.duty ? (
                      <p className="gv-side-text">{dirInfo.duty}</p>
                    ) : (
                      <p className="gv-note">{t('graph.noDuty')}</p>
                    )}
                    {dirInfo.from ? (
                      <button
                        className="gv-row"
                        title={dirInfo.from}
                        onClick={() => {
                          const src = dirInfo.from;
                          if (src) onOpenFile(src, 1);
                        }}
                      >
                        <span className="gv-row-file">{t('graph.fromLabel', { from: dirInfo.from })}</span>
                        <span className="gv-row-meta">{t('welcome.open')}</span>
                      </button>
                    ) : (
                      <p className="gv-note">{t('graph.factNote')}</p>
                    )}
                  </section>

                  {dirDepsLoading && <p className="gv-note">{t('graph.dirDepsLoading')}</p>}
                  {dirDepsError && <p className="gv-note gv-note-err">{dirDepsError}</p>}
                  {selectedDir === './' && (
                    <p className="gv-note">{t('graph.rootNote')}</p>
                  )}
                  {dirDeps && !dirDepsLoading && (
                    <>
                      <section className="gv-sec">
                        <h4 className="gv-sec-title">
                          {t('graph.dirDependentsTitle', { n: dirDeps.direct.length })}
                        </h4>
                        {dirDeps.direct.length === 0 && (
                          <p className="gv-note">{t('graph.noDirDependents')}</p>
                        )}
                        {dirDeps.direct.map((d) => (
                          <button
                            key={d.dir}
                            className={d.tests > 0 ? 'gv-row gv-row-tests' : 'gv-row'}
                            title={t('graph.dirRowTitle', { dir: d.dir, files: d.files })}
                            onClick={() => setSelected(d.dir)}
                          >
                            <span className="gv-row-file">{d.dir}</span>
                            <span className="gv-row-meta">
                              {t('graph.rowMeta', {
                                files: d.files,
                                imports: d.imports,
                                refs: d.refs,
                              })}
                            </span>
                            {d.tests > 0 && <span className="gv-badge">{t('flow.badgeTest')}</span>}
                          </button>
                        ))}
                        {testedDirs > 0 && (
                          <p className="gv-note gv-note-err">{t('graph.dirTestsNote')}</p>
                        )}
                      </section>

                      <section className="gv-sec">
                        <h4 className="gv-sec-title">
                          {t('graph.dirOutboundTitle', { n: dirDeps.outbound.length })}
                        </h4>
                        {dirDeps.outbound.length === 0 && (
                          <p className="gv-note">{t('graph.noDirOutbound')}</p>
                        )}
                        {dirDeps.outbound.map((o) => (
                          <button
                            key={o.dir}
                            className="gv-row"
                            title={t('graph.dirOutboundRowTitle', { dir: o.dir, files: o.files })}
                            onClick={() => setSelected(o.dir)}
                          >
                            <span className="gv-row-file">{o.dir}</span>
                            <span className="gv-row-meta">
                              {t('graph.rowMeta', {
                                files: o.files,
                                imports: o.imports,
                                refs: o.refs,
                              })}
                            </span>
                          </button>
                        ))}
                      </section>

                      {dirTransitiveGroups.map(([depth, list]) => (
                        <section className="gv-sec" key={`d${depth}`}>
                          <h4 className="gv-sec-title">
                            {t('graph.dirTransitiveTitle', { depth, n: list.length })}
                          </h4>
                          {list.map((t) => (
                            <button
                              key={t.dir}
                              className="gv-row"
                              title={t.dir}
                              onClick={() => setSelected(t.dir)}
                            >
                              <span className="gv-row-file">{t.dir}</span>
                            </button>
                          ))}
                        </section>
                      ))}

                      <section className="gv-sec">
                        <h4 className="gv-sec-title">
                          {t('graph.keyFilesTitle', { n: dirDeps.files })}
                        </h4>
                        {dirDeps.keyFiles.length === 0 && (
                          <p className="gv-note">{t('graph.noKeyFiles')}</p>
                        )}
                        {dirDeps.keyFiles.map((f) => (
                          <button
                            key={f.file}
                            className="gv-row"
                            title={f.file}
                            onClick={() => onOpenFile(f.file, 1)}
                          >
                            <span className="gv-row-file">{f.file}</span>
                            <span className="gv-row-meta">{t('graph.refCount', { n: f.inbound })}</span>
                          </button>
                        ))}
                      </section>
                    </>
                  )}
                </>
              )}

              {!selectedDir && selected && (
                <>
                  <section className="gv-sec">
                    <h4 className="gv-sec-title">
                      {t('graph.symbolsTitle', {
                        count: symbols ? t('graph.parenCount', { n: symbols.length }) : '',
                      })}
                    </h4>
                    {symbolsLoading && <p className="gv-note">{t('graph.symbolsLoading')}</p>}
                    {symbolsError && (
                      <p className="gv-note gv-note-err">
                        {t('graph.symbolsError', { err: symbolsError })}
                      </p>
                    )}
                    {!symbolsLoading && !symbolsError && symbols && symbols.length === 0 && (
                      <p className="gv-note">{t('graph.noSymbols')}</p>
                    )}
                    {!symbolsLoading &&
                      visibleSymbols.map((s) => (
                        <button
                          key={`${s.name}@${s.location.range.start.line}`}
                          className="gv-row"
                          title={t('graph.symbolRowTitle', {
                            name: s.name,
                            line: s.location.range.start.line,
                          })}
                          onClick={() => onOpenFile(s.location.file, s.location.range.start.line)}
                        >
                          <span className="gv-row-file">{s.name}</span>
                          <span className="gv-sym-kind">{kindLabel(s.kind)}</span>
                          <span className="gv-row-meta">L{s.location.range.start.line}</span>
                        </button>
                      ))}
                    {symbols && symbols.length > SYMBOL_LIMIT && !symbolsExpanded && (
                      <button className="gv-btn gv-more" onClick={() => setSymbolsExpanded(true)}>
                        {t('graph.expandAll', { n: symbols.length })}
                      </button>
                    )}
                  </section>

                  {depsLoading && <p className="gv-note">{t('graph.depsLoading')}</p>}
                  {depsError && <p className="gv-note gv-note-err">{depsError}</p>}
                  {deps && !depsLoading && (
                    <>
                      <section className="gv-sec">
                        <h4 className="gv-sec-title">
                          {t('graph.directTitle', { n: deps.direct.length })}
                        </h4>
                        {deps.direct.length === 0 && (
                          <p className="gv-note">{t('graph.noDirect')}</p>
                        )}
                        {deps.direct.map((d) => (
                          <button
                            key={d.file}
                            className="gv-row"
                            title={d.file}
                            onClick={() => setSelected(d.file)}
                          >
                            <span className="gv-row-file">{d.file}</span>
                            <span className="gv-row-meta">
                              {d.imports} import · {d.refs} ref
                            </span>
                            {d.test && <span className="gv-badge">{t('flow.badgeTest')}</span>}
                          </button>
                        ))}
                      </section>

                      <section className="gv-sec gv-sec-tests">
                        <h4 className="gv-sec-title">
                          {t('graph.testsTitle', { n: deps.tests.length })}
                        </h4>
                        {deps.tests.length === 0 && (
                          <p className="gv-note">{t('graph.noTests')}</p>
                        )}
                        {deps.tests.map((t) => (
                          <button
                            key={t.file}
                            className="gv-row"
                            title={t.file}
                            onClick={() => setSelected(t.file)}
                          >
                            <span className="gv-row-file">{t.file}</span>
                            <span className="gv-row-meta">
                              {t.imports} import · {t.refs} ref
                            </span>
                          </button>
                        ))}
                      </section>

                      {transitiveGroups.map(([depth, list]) => (
                        <section className="gv-sec" key={depth}>
                          <h4 className="gv-sec-title">
                            {t('graph.transitiveTitle', { depth, n: list.length })}
                          </h4>
                          {list.slice(0, 50).map((t) => (
                            <button
                              key={t.file}
                              className="gv-row"
                              title={t.file}
                              onClick={() => setSelected(t.file)}
                            >
                              <span className="gv-row-file">{t.file}</span>
                            </button>
                          ))}
                          {list.length > 50 && (
                            <p className="gv-note">
                              {t('graph.transitiveMore', { n: list.length })}
                            </p>
                          )}
                        </section>
                      ))}
                    </>
                  )}
                </>
              )}
            </div>
          </aside>
        )}
      </div>

      <footer className="gv-legend">
        <span className="gv-legend-item">
          <i className="gv-dot" style={{ background: LAYER_COLOR.entry }} />
          {t('graph.legendEntry')}
        </span>
        <span className="gv-legend-item">
          <i className="gv-dot" style={{ background: LAYER_COLOR.domain }} />
          {t('graph.legendDomain')}
        </span>
        <span className="gv-legend-item">
          <i className="gv-dot" style={{ background: LAYER_COLOR.infra }} />
          {t('graph.legendInfra')}
        </span>
        <span className="gv-legend-item">
          <i className="gv-dot" style={{ background: LAYER_COLOR.utility }} />
          {t('layer.utility')}
        </span>
        <span className="gv-legend-item">
          <i className="gv-dot" style={{ background: LAYER_COLOR.isolated }} />
          {t('layer.isolated')}
        </span>
        <span className="gv-legend-item">
          <i className="gv-line-red" />
          {t('graph.legendCycle')}
        </span>
        <span className="gv-legend-item">{t('graph.legendNote')}</span>
        <span className="gv-legend-item">{t('graph.legendHint')}</span>
      </footer>
    </div>
  );
}
