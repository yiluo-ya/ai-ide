/**
 * 流视图浮层（04 Guide · W5 / G9.1–G9.4）。
 *
 * 数据来自 `POST /api/projects/:id/flow`：`calls` = 我调用了谁、`callers` = 谁调用我、
 * `data` = 参数 / 返回值在调用点之间的名字级近似。三条纪律：
 * 1. **不编造**：外部依赖是后端给的聚合灰节点；未解析节点保留并标「未解析」；
 *    数据流的边一律虚线 + 「近似」标注，并原样显示后端 `note`（不做类型推断）。
 * 2. **复用**：布局函数与配色 / 半径 / 标签规则复用 `GraphView.tsx` 导出的纯函数
 *    （交付 4 只加 export，不改行为）；滚轮缩放 / 指针平移与依赖图同一套写法。
 * 3. **点击即行动**：单击节点打开对应文件；节点上的 ◎ 按钮以它为焦点重新请求。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceRadial, forceSimulation } from 'd3-force';
import type { SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';
import type { FlowEdge, FlowKind, FlowNode, FlowResult, GraphNode, SymbolKind } from '../../shared/types';
import { groupByDepth, labelVisible, nodeFill, nodeRadius, type View } from './GraphView';
import { useI18n } from './i18n';
// 复用了 `.gv-*` 的既有样式（浮层头部 / 侧栏 / 状态行）：图与流视图长得一致
import './graph.css';
import './flow.css';

interface Props {
  projectId: string;
  /** 初始焦点：来自编辑器光标或层级面板上的符号。 */
  focus: { file: string; line: number; col: number };
  /** line 是 1 基行号。 */
  onOpenFile: (file: string, line?: number) => void;
  onClose: () => void;
}

/** 深度范围与后端一致（1–3）。 */
const DEPTHS = [1, 2, 3];
/** 力导向固定步数：径向约束比自由布局收敛慢，给足步数后 stop()（不留动画循环）。 */
const FLOW_TICKS = 380;
/** 每层半径（焦点在圆心，depth 越大越外圈）。 */
const LAYER_RADIUS = 190;

/** 请求结果：区分「没有符号」与「真的失败」（与 explainState 同一口径）。 */
type FlowResponse =
  | { ok: true; result: FlowResult }
  | { ok: false; noSymbol: boolean; message: string };

async function postFlow(
  projectId: string,
  focus: { file: string; line: number; col: number },
  kind: FlowKind,
  depth: number,
): Promise<FlowResponse> {
  try {
    const res = await fetch(`/api/projects/${projectId}/flow`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: focus.file, line: focus.line, col: focus.col, kind, depth }),
    });
    const body = (await res.json().catch(() => null)) as
      | (FlowResult & { error?: string; message?: string })
      | null;
    if (!res.ok) {
      return {
        ok: false,
        noSymbol: body?.error === 'no-symbol',
        message: body?.message ?? body?.error ?? `${res.status} ${res.statusText}`,
      };
    }
    return { ok: true, result: body as FlowResult };
  } catch (e) {
    return { ok: false, noSymbol: false, message: e instanceof Error ? e.message : String(e) };
  }
}

type FlowSimNode = FlowNode & SimulationNodeDatum;
// 不能直接与 FlowEdge 交叉：FlowEdge 的 source / target 是 string，交叉后会锁成 string，
// forceLink 运行后就把它们改写成节点对象，类型上要看得到这一点（Omit 后交给 d3 的类型）
type FlowSimEdge = Omit<FlowEdge, 'source' | 'target'> & SimulationLinkDatum<FlowSimNode>;

interface FlowLayout {
  nodes: FlowSimNode[];
  edges: FlowSimEdge[];
  /** 初始（重置视图用）的可视区域。 */
  base: View;
}

/** 图上的度数：流视图的门面（用于节点半径与标签显隐，与依赖图的 inbound/outbound 同义）。 */
function degreesOf(result: FlowResult): Map<string, { in: number; out: number }> {
  const map = new Map<string, { in: number; out: number }>();
  const ensure = (id: string) => {
    let d = map.get(id);
    if (!d) {
      d = { in: 0, out: 0 };
      map.set(id, d);
    }
    return d;
  };
  for (const n of result.nodes) ensure(n.id);
  for (const e of result.edges) {
    ensure(e.target).in += 1;
    ensure(e.source).out += 1;
  }
  return map;
}

/**
 * 把流视图节点适配成依赖图的节点形状，好复用 `GraphView` 导出的纯函数：
 * `nodeRadius` 定半径、`nodeFill` 定颜色（外部灰 / 测试灰 / 入口黄）、`labelVisible` 定标签显隐。
 * 度数就是本图上的入边与出边数（`asGraphNode` 把它们喂给半径与标签规则）。
 *
 * 这里没有复用 `nodeTitle`：它的文案绑定依赖图口径（inbound / outbound 是**全项目**的引用数），
 * 流视图的度数只在本图内成立，直接拿来说就是误导 —— 所以 title 自建（见节点渲染处）。
 */
function asGraphNode(n: FlowNode, deg: { in: number; out: number }): GraphNode {
  return {
    id: n.id,
    label: n.name,
    kind: n.external ? 'external' : 'file',
    depth: 0,
    files: 0,
    inbound: deg.in,
    outbound: deg.out,
    ...(n.isEntry ? { entry: true } : {}),
    ...(n.isTest ? { test: true } : {}),
  };
}

/** 按符号种类定形状（颜色由 `nodeFill` 决定，这里只管几何）。 */
function shapeOf(n: FlowNode): 'circle' | 'rect' | 'diamond' {
  if (n.unresolved) return 'diamond';
  if (n.external) return 'circle';
  const rectKinds: SymbolKind[] = ['file', 'module', 'namespace', 'class', 'struct', 'interface', 'enum', 'type'];
  return rectKinds.includes(n.kind) ? 'rect' : 'circle';
}

/** 未解析 / 外部聚合节点不跳转；其余节点 file / line 齐全才可点开。 */
function openable(n: FlowNode): boolean {
  return !!n.file && !n.external && !n.unresolved;
}

/**
 * 同步跑完固定步数的径向力导向：焦点在圆心，深度越大越外圈。
 * 与依赖图的布局一样一次算定、不留动画循环，所以重绘不会抖动。
 */
function layoutFlow(result: FlowResult): FlowLayout | null {
  if (!result.nodes.length) return null;
  const ids = new Set(result.nodes.map((n) => n.id));
  const deg = degreesOf(result);
  const radiusOf = (n: FlowNode) => nodeRadius(asGraphNode(n, deg.get(n.id) ?? { in: 0, out: 0 }));
  // 全部复制：forceLink 会把 source / target 改写成节点对象引用，不能污染接口返回的数据
  const nodes: FlowSimNode[] = result.nodes.map((n) => ({ ...n }));
  const edges: FlowSimEdge[] = result.edges
    .filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target)
    .map((e) => ({ ...e, source: e.source, target: e.target }));

  const sim = forceSimulation<FlowSimNode>(nodes)
    .force(
      'link',
      forceLink<FlowSimNode, FlowSimEdge>(edges)
        .id((d) => d.id)
        .distance(110)
        .strength(0.22),
    )
    .force('charge', forceManyBody<FlowSimNode>().strength(-420))
    .force('collide', forceCollide<FlowSimNode>().radius((d) => radiusOf(d) + 14))
    .force('radial', forceRadial<FlowSimNode>((d) => Math.max(0, d.depth) * LAYER_RADIUS, 0, 0).strength(0.9))
    .force('center', forceCenter<FlowSimNode>(0, 0))
    .stop();
  for (let i = 0; i < FLOW_TICKS; i += 1) sim.tick();

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    // 半径外的余量留给标签与徽标
    const r = radiusOf(n) + 26;
    minX = Math.min(minX, (n.x ?? 0) - r);
    maxX = Math.max(maxX, (n.x ?? 0) + r);
    minY = Math.min(minY, (n.y ?? 0) - r);
    maxY = Math.max(maxY, (n.y ?? 0) + r);
  }
  const pad = 26;
  const contentW = maxX - minX + pad * 2;
  const contentH = maxY - minY + pad * 2;
  const w = Math.max(280, contentW);
  const h = Math.max(180, contentH);
  const base: View = {
    x: minX - pad - (w - contentW) / 2,
    y: minY - pad - (h - contentH) / 2,
    w,
    h,
  };
  return { nodes, edges, base };
}

export function FlowView({ projectId, focus, onOpenFile, onClose }: Props) {
  const { t } = useI18n();
  const [kind, setKind] = useState<FlowKind>('calls');
  const [depth, setDepth] = useState(1);
  const [withExternal, setWithExternal] = useState(true);
  const [target, setTarget] = useState(focus);
  const [data, setData] = useState<FlowResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState<View | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ px: number; py: number; vb: View } | null>(null);

  // Esc 关闭浮层（它盖住编辑器，不能只靠鼠标找按钮）。
  // capture 阶段：从浮层里打开文件后焦点落进 Monaco，编辑器会吞掉 Escape（与依赖图同一坑）。
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
    void postFlow(projectId, target, kind, depth).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setData(res.result);
        setSelected(null);
      } else {
        setData(null);
        setError(res.noSymbol ? t('flow.noSymbol') : res.message);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // t 只用于把「没有符号」翻成人话，换语言不必重新请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, target, kind, depth]);

  /** 外部依赖默认显示为灰节点；取消勾选 = 只看本项目（G9.4）。 */
  const visible = useMemo(() => {
    if (!data) return null;
    if (withExternal) return data;
    const hidden = new Set(data.nodes.filter((n) => n.external).map((n) => n.id));
    return {
      ...data,
      nodes: data.nodes.filter((n) => !hidden.has(n.id)),
      edges: data.edges.filter((e) => !hidden.has(e.source) && !hidden.has(e.target)),
    };
  }, [data, withExternal]);

  const degrees = useMemo<Map<string, { in: number; out: number }>>(
    () => (visible ? degreesOf(visible) : new Map()),
    [visible],
  );
  const layout = useMemo(() => (visible ? layoutFlow(visible) : null), [visible]);

  useEffect(() => {
    setView(layout ? layout.base : null);
  }, [layout]);

  const nodeById = useMemo(() => {
    const map = new Map<string, FlowNode>();
    for (const n of visible?.nodes ?? []) map.set(n.id, n);
    return map;
  }, [visible]);

  /** 逐层清单：同一份数据换个形态看（低层在前），复用 GraphView 的分组函数。 */
  const byDepth = useMemo(() => groupByDepth(visible?.nodes), [visible]);

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

  const stopPointer = (e: ReactPointerEvent<SVGGElement>) => e.stopPropagation();

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

  /** G9.4：以某节点为新焦点（重新请求，范围 / 深度保持）。 */
  const focusOn = (n: FlowNode) => {
    if (!n.file) return;
    setTarget({ file: n.file, line: n.line, col: n.col || 1 });
  };

  const box = view ?? (layout ? layout.base : null);
  const selectedNode = selected ? nodeById.get(selected) ?? null : null;
  const nodeCount = visible?.nodes.length ?? 0;
  const edgeCount = visible?.edges.length ?? 0;

  const kindLabels: Array<{ value: FlowKind; label: string }> = [
    { value: 'calls', label: t('flow.kind.calls') },
    { value: 'callers', label: t('flow.kind.callers') },
    { value: 'data', label: t('flow.kind.data') },
  ];

  return (
    <div className="flow-view">
      <header className="fl-head">
        <span className="fl-title">{t('flow.title')}</span>
        <span className="fl-focus" title={`${target.file}:${target.line}`}>
          {t('flow.focus', { name: data?.focus.name ?? target.file, at: `${target.file}:${target.line}` })}
        </span>
        <div className="fl-kinds">
          {kindLabels.map((k) => (
            <button
              key={k.value}
              className={`gv-btn${kind === k.value ? ' is-on' : ''}`}
              onClick={() => setKind(k.value)}
              title={t(`flow.kind.${k.value}Title`)}
            >
              {k.label}
            </button>
          ))}
        </div>
        <label className="fl-depth">
          {t('flow.depth')}
          <select className="ov-select" value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
            {DEPTHS.map((d) => (
              <option key={d} value={d}>
                {t('flow.depthValue', { n: d })}
              </option>
            ))}
          </select>
        </label>
        <label className="fl-check" title={t('flow.externalTitle')}>
          <input type="checkbox" checked={withExternal} onChange={(e) => setWithExternal(e.target.checked)} />
          {t('flow.external')}
        </label>
        <button className="gv-btn" onClick={() => setView(layout ? layout.base : null)} disabled={!layout}>
          {t('flow.reset')}
        </button>
        <span className="gv-stat">{t('flow.stat', { nodes: nodeCount, edges: edgeCount })}</span>
        {data?.truncated && <span className="gv-warn">{t('flow.truncated')}</span>}
        <button className="gv-btn gv-close" onClick={onClose} title={t('flow.closeTitle')}>
          {t('dialog.close')}
        </button>
      </header>

      <div className="fl-body">
        <div className="fl-canvas-wrap">
          {layout && box && (
            <svg
              ref={svgRef}
              className="fl-canvas"
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
                  id="fl-arrow"
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
                  id="fl-arrow-data"
                  viewBox="0 0 10 10"
                  refX="10"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--fl-data)" />
                </marker>
              </defs>

              {layout.edges.map((e, i) => {
                const a = typeof e.source === 'object' ? e.source : null;
                const b = typeof e.target === 'object' ? e.target : null;
                if (!a || !b) return null;
                // callers 模式下 callHierarchy 的边是「焦点 → 调用方」，真实调用方向相反，画的时候翻过来
                const from = kind === 'callers' ? b : a;
                const to = kind === 'callers' ? a : b;
                const isData = e.kind === 'data';
                const weight = 1 + Math.log2(Math.max(1, e.count));
                return (
                  <g key={`e${i}`}>
                    <line
                      className={isData ? 'fl-edge fl-edge-data' : 'fl-edge'}
                      x1={from.x ?? 0}
                      y1={from.y ?? 0}
                      x2={to.x ?? 0}
                      y2={to.y ?? 0}
                      strokeWidth={weight}
                      strokeOpacity={isData ? 0.8 : 0.6}
                      strokeDasharray={isData ? '5 4' : undefined}
                      markerEnd={`url(#${isData ? 'fl-arrow-data' : 'fl-arrow'})`}
                    >
                      <title>
                        {isData
                          ? t('flow.edgeData', { label: e.label ?? t('flow.approx') })
                          : t('flow.edgeCall', { n: e.count })}
                      </title>
                    </line>
                    {/* 数据流边一律标「近似」：名字级匹配的边不能让人当成类型级事实 */}
                    {isData && (
                      <text
                        className="fl-approx"
                        x={((from.x ?? 0) + (to.x ?? 0)) / 2}
                        y={((from.y ?? 0) + (to.y ?? 0)) / 2 - 3}
                        textAnchor="middle"
                      >
                        {t('flow.approx')}
                      </text>
                    )}
                  </g>
                );
              })}

              {layout.nodes.map((n) => {
                const g = asGraphNode(n, degrees.get(n.id) ?? { in: 0, out: 0 });
                const r = nodeRadius(g);
                const isSelected = n.id === selected;
                const isFocus = n.depth === 0;
                const outlined = isSelected || isFocus;
                const shape = shapeOf(n);
                const fill = n.unresolved ? 'var(--fl-unresolved)' : nodeFill(g);
                const stroke = outlined ? '#ffffff' : 'rgba(0, 0, 0, 0.55)';
                return (
                  <g
                    key={n.id}
                    className="fl-node"
                    transform={`translate(${n.x ?? 0} ${n.y ?? 0})`}
                    onPointerDown={stopPointer}
                    onClick={() => {
                      setSelected(n.id);
                      if (openable(n)) onOpenFile(n.file, n.line);
                    }}
                    onMouseEnter={() => setHover(n.id)}
                    onMouseLeave={() => setHover(null)}
                  >
                    <title>
                      {n.external
                        ? t('flow.nodeExternal', { name: n.name, n: (degrees.get(n.id) ?? { in: 0 }).in })
                        : n.unresolved
                          ? t('flow.nodeUnresolved', { name: n.name })
                          : t('flow.nodeTitle', {
                              name: n.name,
                              kind: n.kind,
                              at: `${n.file}:${n.line}`,
                              n: (degrees.get(n.id) ?? { in: 0 }).in,
                            })}
                    </title>
                    {shape === 'rect' && (
                      <rect
                        x={-r * 1.6}
                        y={-r * 1.1}
                        width={r * 3.2}
                        height={r * 2.2}
                        rx={4}
                        fill={fill}
                        stroke={stroke}
                        strokeWidth={outlined ? 2 : 1}
                      />
                    )}
                    {shape === 'circle' && (
                      <circle
                        r={r}
                        fill={fill}
                        stroke={stroke}
                        strokeWidth={outlined ? 2 : 1}
                        strokeDasharray={n.external ? '3 2' : undefined}
                      />
                    )}
                    {shape === 'diamond' && (
                      <rect
                        x={-r}
                        y={-r}
                        width={r * 2}
                        height={r * 2}
                        transform="rotate(45)"
                        fill={fill}
                        stroke={stroke}
                        strokeWidth={outlined ? 2 : 1}
                        strokeDasharray="3 2"
                      />
                    )}
                    {n.isEntry && (
                      <text className="fl-badge fl-badge-entry" y={-r - 8} textAnchor="middle">
                        {t('flow.badgeEntry')}
                      </text>
                    )}
                    {n.isTest && (
                      <text className="fl-badge" y={r + 13} textAnchor="middle">
                        {t('flow.badgeTest')}
                      </text>
                    )}
                    {/* 焦点总显示名字；其余节点沿用依赖图的规则（度数 >= 2 或选中 / 悬停时才显示） */}
                    {(isFocus || labelVisible(g, selected, hover, null)) && (
                      <text className={isFocus ? 'fl-label is-strong' : 'fl-label'} y={r + 12} textAnchor="middle">
                        {n.name}
                      </text>
                    )}
                    {/* 「以它为焦点」：单击已经用于打开文件，聚焦放在这个小按钮上 */}
                    {openable(n) && (
                      <g
                        className="fl-focus-btn"
                        transform={`translate(${r + 10} ${-r - 8})`}
                        onPointerDown={stopPointer}
                        onClick={(e) => {
                          e.stopPropagation();
                          focusOn(n);
                        }}
                      >
                        <title>{t('flow.focusOn')}</title>
                        <circle r={7} />
                        <text y={3} textAnchor="middle">
                          ◎
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}
            </svg>
          )}
          {loading && <div className="gv-status">{t('flow.loading')}</div>}
          {!loading && error && <div className="gv-status gv-status-err">{error}</div>}
          {/* 只有焦点自己没有一条边：不说「空画布」，给一句人话（焦点仍然画在图上） */}
          {!loading && !error && nodeCount <= 1 && <div className="gv-status">{t('flow.empty')}</div>}
        </div>

        <aside className="fl-side">
          <div className="fl-side-head">
            <span className="fl-side-title">{selectedNode ? selectedNode.name : t('flow.layers')}</span>
            {selectedNode && (
              <span className="fl-side-at" title={`${selectedNode.file}:${selectedNode.line}`}>
                {selectedNode.file ? `${selectedNode.file}:${selectedNode.line}` : t('flow.noSource')}
              </span>
            )}
          </div>
          <div className="fl-side-body">
            {selectedNode ? (
              <>
                <div className="fl-meta">
                  {t('flow.metaKind', { kind: selectedNode.kind, depth: selectedNode.depth })}
                </div>
                <div className="fl-meta">
                  {t('flow.metaDegrees', {
                    in: (degrees.get(selectedNode.id) ?? { in: 0 }).in,
                    out: (degrees.get(selectedNode.id) ?? { out: 0 }).out,
                  })}
                </div>
                {selectedNode.external && <p className="gv-note">{t('flow.externalNote')}</p>}
                {selectedNode.unresolved && <p className="gv-note">{t('flow.unresolvedNote')}</p>}
                <div className="fl-side-actions">
                  {openable(selectedNode) && (
                    <button className="gv-btn" onClick={() => onOpenFile(selectedNode.file, selectedNode.line)}>
                      {t('flow.openFile')}
                    </button>
                  )}
                  {openable(selectedNode) && (
                    <button className="gv-btn" onClick={() => focusOn(selectedNode)}>
                      {t('flow.focusOn')}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <p className="gv-note">{t('flow.layersHint')}</p>
                {byDepth.map(([d, list]) => (
                  <section className="gv-sec" key={`d${d}`}>
                    <h4 className="gv-sec-title">
                      {d === 0 ? t('flow.layerFocus') : t('flow.layer', { n: d })}
                      <span className="ex-sec-count">{list.length}</span>
                    </h4>
                    {list.map((n) => (
                      <button
                        key={n.id}
                        className="gv-row"
                        title={n.file ? `${n.file}:${n.line}` : n.name}
                        onClick={() => {
                          setSelected(n.id);
                          if (openable(n)) onOpenFile(n.file, n.line);
                        }}
                      >
                        <span className="gv-row-file">{n.name}</span>
                        <span className="gv-row-meta">
                          {n.external
                            ? t('flow.tagExternal')
                            : n.unresolved
                              ? t('flow.tagUnresolved')
                              : n.file
                                ? `${n.file}:${n.line}`
                                : t('flow.noSource')}
                        </span>
                      </button>
                    ))}
                  </section>
                ))}
              </>
            )}
          </div>
        </aside>
      </div>

      <footer className="fl-foot">
        {data ? (
          <span className="ex-coverage">
            {t('flow.coverageText', {
              resolved: data.coverage.resolved,
              unresolved: data.coverage.unresolved,
              external: data.coverage.external,
            })}
          </span>
        ) : (
          <span className="ex-coverage">{t('flow.coverageUnknown')}</span>
        )}
        {kind === 'data' && (
          <span className="fl-approx-note" title={t('flow.dataNoteTitle')}>
            {data?.note ?? t('flow.dataNote')}
          </span>
        )}
        {kind === 'callers' && <span className="fl-hint">{t('flow.callersHint')}</span>}
      </footer>
    </div>
  );
}
