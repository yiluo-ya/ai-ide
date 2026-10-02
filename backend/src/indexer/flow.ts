/**
 * 流视图（04 Guide · G9.1–G9.3）：把「谁调用我 / 我调用了谁 / 数据怎么流」压平成图数据。
 *
 * 三条纪律：
 * 1) 调用关系复用 callgraph.callHierarchy 的树结果（不另写一套调用判定），只是把它压平成
 *    `{nodes, edges}`；深度夹 1..3，节点上限 300（超了如实标 `truncated`）。
 * 2) 数据流是**名字级近似**：拿调用点的实参文本与目标定义的参数名做名字匹配，命中才连一条
 *    `kind: 'data'` 的边并置 `approx: true`；**匹配不上的实参不画边**（不猜），不做类型推断。
 * 3) 节点 id 用 `file:line`（聚合的未解析 / 外部节点用 `~` 前缀），前端可据此点开文件。
 */
import type { FlowEdge, FlowKind, FlowNode, FlowResult, SymbolKind } from '../types';
import type { DefRecord, FileIndex } from './model';
import { callHierarchy, type CallNode } from './callgraph';
import { basename } from './paths';
import { collectReferences, defAt, enclosingDefAt, gotoDefinition } from './resolver';
import type { ProjectIndex } from './store';

/** 图的节点上限：再多就不是「看得见」而是「看不清」了。 */
export const FLOW_MAX_NODES = 300;
/** 未解析 / 外部依赖聚合节点的固定 id（`~` 不会出现在文件路径里）。 */
const EXTERNAL_ID = '~external';
const UNRESOLVED_ID = '~unresolved';

export interface FlowRequest {
  file: string;
  line: number;
  col: number;
  kind: FlowKind;
  depth: number;
}

/** 定位焦点定义：先跟到定义（gotoDefinition），再回落到光标所在的符号。 */
function focusDef(project: ProjectIndex, file: string, line: number, col: number): DefRecord | null {
  const fi = project.files.get(file);
  if (!fi) return null;
  const pos = { line, col };
  const atDef = defAt(fi, pos);
  if (atDef) return atDef;
  const gd = gotoDefinition(project, file, line, col);
  if (gd.reason === 'resolved' && gd.locations.length) {
    const loc = gd.locations[0];
    const tfi = project.files.get(loc.file);
    const found = tfi ? defAt(tfi, loc.range.start) : null;
    if (found) return found;
  }
  // 光标既不在定义名也不在任何引用上：回落到「所在的符号」（函数 / 类体内部）
  return enclosingDefAt(fi, pos);
}
function nodeIdOf(node: CallNode): string {
  if (node.external) return EXTERNAL_ID;
  if (node.unresolved) return UNRESOLVED_ID;
  if (!node.file) return `~${node.name}`;
  return `${node.file}:${node.location.range.start.line}`;
}

function toFlowNode(node: CallNode, depth: number): FlowNode {
  const at = node.location.range.start;
  return {
    id: nodeIdOf(node),
    name: node.name,
    kind: node.kind,
    file: node.file,
    line: at.line,
    col: at.col,
    depth,
    external: node.external,
    unresolved: node.unresolved,
    isEntry: node.isEntry,
    isTest: node.isTest,
  };
}

/**
 * 把 callHierarchy 的树压平成 nodes / edges（BFS，按 id 去重防菱形与环）。
 * 节点达到上限后不再追加，`truncated` 如实置 true。
 */
function flattenTree(
  root: CallNode,
): { nodes: FlowNode[]; edges: FlowEdge[]; truncated: boolean } {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const byId = new Map<string, FlowNode>();
  const edgeKeys = new Set<string>();
  let truncated = false;
  let seq = 0;

  const queue: Array<{ node: CallNode; depth: number; parent: string | null }> = [
    { node: root, depth: 0, parent: null },
  ];
  while (queue.length) {
    const { node, depth, parent } = queue.shift()!;
    let id = nodeIdOf(node);
    // 同一行的两个不同符号（如函数名与签名里的参数）：用列号兜底，避免被误合并成一个节点
    const clash = byId.get(id);
    if (clash && clash.name !== node.name) id = `${id}:${node.location.range.start.col}`;
    if (!byId.has(id)) {
      if (nodes.length >= FLOW_MAX_NODES) {
        truncated = true;
        continue;
      }
      const flow = toFlowNode(node, depth);
      byId.set(id, flow);
      nodes.push(flow);
    }
    if (parent && parent !== id) {
      const key = `${parent}->${id}`;
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        edges.push({
          id: `e${seq++}`,
          source: parent,
          target: id,
          kind: 'calls',
          count: node.callCount,
        });
      }
    }
    for (const child of node.children ?? []) queue.push({ node: child, depth: depth + 1, parent: id });
  }
  return { nodes, edges, truncated };
}

/** def.range 是否包住某个位置（用于筛出参数定义）。 */
function containsPos(def: DefRecord, line: number, col: number): boolean {
  if (line < def.range.start.line || line > def.range.end.line) return false;
  if (line === def.range.start.line && col < def.range.start.col) return false;
  if (line === def.range.end.line && col > def.range.end.col) return false;
  return true;
}

function paramNamesOf(fi: FileIndex | undefined, def: DefRecord): Set<string> {
  const names = new Set<string>();
  if (!fi) return names;
  for (const d of fi.definitions) {
    if (d.kind !== 'parameter') continue;
    if (!containsPos(def, d.nameRange.start.line, d.nameRange.start.col)) continue;
    names.add(d.name);
  }
  return names;
}

/**
 * 数据流（名字级近似）：从「调用点的实参」连到「目标定义的形参」，两边同名才连边。
 * 源节点是调用点所在的最内层定义；depth > 1 时把调用方再往上挂几层（只作上下文，不画边）。
 */
function dataFlow(
  project: ProjectIndex,
  def: DefRecord,
  depth: number,
): { nodes: FlowNode[]; edges: FlowEdge[]; truncated: boolean } {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const byId = new Map<string, FlowNode>();
  const edgeKeys = new Set<string>();
  let truncated = false;
  let seq = 0;

  const addNode = (node: FlowNode): boolean => {
    if (byId.has(node.id)) return true;
    if (nodes.length >= FLOW_MAX_NODES) {
      truncated = true;
      return false;
    }
    byId.set(node.id, node);
    nodes.push(node);
    return true;
  };

  const focusId = `${def.file}:${def.nameRange.start.line}`;
  addNode({
    id: focusId,
    name: def.name,
    kind: def.kind,
    file: def.file,
    line: def.nameRange.start.line,
    col: def.nameRange.start.col,
    depth: 0,
  });

  const paramNames = paramNamesOf(project.files.get(def.file), def);
  if (!paramNames.size) return { nodes, edges, truncated };

  /** 收集命中「实参名 == 形参名」的调用点，源节点 = 调用点所在的最内层定义。 */
  const sources: Array<{ id: string; file: string; name: string; kind: SymbolKind; line: number; col: number }> =
    [];
  const sourceSeen = new Set<string>();
  for (const entry of collectReferences(project, def)) {
    if (entry.kind !== 'ref') continue;
    const cfi = project.files.get(entry.file);
    if (!cfi) continue;
    const callAt = entry.range.start;
    const owner = enclosingDefAt(cfi, callAt);
    const src = owner
      ? {
          id: `${owner.file}:${owner.nameRange.start.line}`,
          file: owner.file,
          name: owner.name,
          kind: owner.kind,
          line: owner.nameRange.start.line,
          col: owner.nameRange.start.col,
        }
      : {
          id: `${entry.file}:1`,
          file: entry.file,
          name: basename(entry.file),
          kind: 'module' as SymbolKind,
          line: 1,
          col: 1,
        };
    if (sourceSeen.has(src.id)) continue;

    // 实参候选：同一行、位于调用点之后的引用；名字命中形参名才连边（匹配不上不画）
    const hits = new Set<string>();
    for (const arg of cfi.references) {
      if (arg.range.start.line !== callAt.line) continue;
      if (arg.range.start.col < entry.range.end.col) continue;
      const candidates = [arg.name, arg.text, ...(arg.memberParts ?? [])];
      for (const name of candidates) if (paramNames.has(name)) hits.add(name);
    }
    if (!hits.size) continue;
    sourceSeen.add(src.id);
    sources.push(src);
    if (!addNode({ ...src, depth: 1 })) break;
    for (const param of [...hits].sort()) {
      if (src.id === focusId) continue; // 自环（在焦点体内递归调用）不画边
      const key = `${src.id}->${focusId}:${param}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({
        id: `e${seq++}`,
        source: src.id,
        target: focusId,
        kind: 'data',
        count: 1,
        label: `实参 ${param} → 形参 ${param}`,
        approx: true,
      });
    }
  }

  // depth > 1：把调用方再往上挂几层，仅作上下文（没有数据流证据就不画边）
  if (depth > 1) {
    let frontier = sources.map((s) => ({ file: s.file, line: s.line, col: s.col, depth: 1 }));
    for (let level = 2; level <= depth && frontier.length; level++) {
      const next: typeof frontier = [];
      for (const cur of frontier) {
        const tree = callHierarchy(project, cur.file, cur.line, cur.col, 'in', 1);
        for (const child of tree.root?.children ?? []) {
          if (child.external || child.unresolved || !child.file) continue;
          const node: FlowNode = {
            ...toFlowNode(child, level),
            depth: level,
          };
          if (addNode(node)) next.push({ file: node.file, line: node.line, col: node.col, depth: level });
        }
      }
      frontier = next;
    }
  }

  // 排序：焦点在前，其余按 id 稳定排列
  nodes.sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
  return { nodes, edges, truncated };
}

/**
 * 流视图数据。定位不到项目内定义返回 null（端点层给 404）。
 * `calls` = 我调用了谁 / `callers` = 谁调用我 / `data` = 名字级近似的实参↔形参关系。
 */
export function flowGraph(project: ProjectIndex, req: FlowRequest): FlowResult | null {
  const fi = project.files.get(req.file);
  if (!fi) return null;
  const line = Number.isFinite(req.line) && req.line > 0 ? Math.floor(req.line) : 1;
  const col = Number.isFinite(req.col) && req.col > 0 ? Math.floor(req.col) : 1;
  const def = focusDef(project, req.file, line, col);
  if (!def) return null;

  const kind: FlowKind = req.kind === 'callers' || req.kind === 'data' ? req.kind : 'calls';
  const depth = Math.max(1, Math.min(3, Number.isFinite(req.depth) ? Math.floor(req.depth) : 1));
  const focus = { name: def.name, kind: def.kind, file: def.file, line: def.nameRange.start.line };

  if (kind === 'data') {
    const { nodes, edges, truncated } = dataFlow(project, def, depth);
    return {
      kind,
      focus,
      nodes,
      edges,
      coverage: { resolved: edges.length, unresolved: 0, external: 0 },
      truncated,
      approximate: true,
      note: '名字级近似 · 不做类型推断',
    };
  }

  const direction = kind === 'calls' ? 'out' : 'in';
  const tree = callHierarchy(project, def.file, def.nameRange.start.line, def.nameRange.start.col, direction, depth);
  if (!tree.root) return null;
  const { nodes, edges, truncated } = flattenTree(tree.root);
  return { kind, focus, nodes, edges, coverage: tree.coverage, truncated };
}
