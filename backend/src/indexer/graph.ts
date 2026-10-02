/**
 * 依赖图与反向依赖（01 Map 的 M4–M7）。
 *
 * 图是「import 语句级 + 已解析符号引用级」的近似：解析不到的边不画（不伪造边），
 * 外部依赖只作为聚合节点出现，点它不给假跳转。
 * 布局与渲染在前端；这里只出事实。
 */
import type {
  DependencyGraph,
  DependentsResult,
  DirDependentsResult,
  DirDuty,
  GraphEdge,
  GraphLayer,
  GraphNode,
  LangId,
} from '../types';
import { basename, dirname } from './paths';
import { findCycles, projectMap } from './insight';
import { moduleFiles } from './resolver';
import type { ProjectIndex } from './store';

/** 单次出图的文件节点上限（超过则只保留度数最高的那些）。 */
const MAX_FILE_NODES = 400;
/** 目录节点上限。 */
const MAX_DIR_NODES = 200;
/** 默认提到文件级的入口 / 热点数量（两级并存）。 */
const FOCUS_HOT = 8;

export const ROOT_DIR_ID = './';

export interface GraphOptions {
  level?: 'dir' | 'file';
  /** 展开到文件级的目录（相对路径，不带尾斜杠；根目录用空串）。 */
  expand?: string[];
  /** 外部依赖节点上限；0 = 不画外部节点。 */
  external?: number;
  /** 覆盖默认的「提到文件级」清单。 */
  focus?: string[];
  /** 目录职责与分层（M4.2/M4.3），由概览算好后传进来，避免重复 IO。 */
  duties?: DirDuty[];
}

/** 泳道名字（M4.2 泳道分组）。 */
export const LANE_LABEL: Record<GraphLayer, string> = {
  entry: '入口层',
  domain: '领域层',
  infra: '基础设施层',
  utility: '工具层',
  isolated: '孤立 / 测试',
};

/** 泳道顺序：入口在上，基础在下（与阅读顺序一致）。 */
export const LANE_ORDER: GraphLayer[] = ['entry', 'domain', 'infra', 'utility', 'isolated'];

export const dirIdOf = (dir: string): string => (dir ? `${dir}/` : ROOT_DIR_ID);
export const dirOfFile = (file: string): string => dirname(file);

function dirDepth(dir: string): number {
  return dir ? dir.split('/').filter(Boolean).length : 0;
}

/** 第三方包名归一：`@scope/pkg/sub` → `@scope/pkg`，`node:fs/promises` → `node:fs`。 */
function packageRoot(specifier: string): string {
  const clean = specifier.trim();
  if (!clean) return clean;
  if (clean.startsWith('node:')) return clean.split('/').slice(0, 1).join('/');
  if (clean.startsWith('@')) return clean.split('/').slice(0, 2).join('/');
  return clean.split('/')[0];
}

export function buildGraph(project: ProjectIndex, options: GraphOptions = {}): DependencyGraph {
  const map = projectMap(project);
  const level = options.level ?? 'dir';
  const expand = new Set(options.expand ?? []);
  const externalLimit = options.external ?? 0;

  // 「两级并存」：入口候选与热点 Top 始终提到文件级
  const focus = new Set(options.focus ?? []);
  if (!options.focus) {
    for (const f of map.facts.values()) if (f.entry) focus.add(f.file);
    [...map.facts.values()]
      .filter((f) => f.inDegree > 0 && !f.test)
      .sort((a, b) => b.inDegree - a.inDegree || a.file.localeCompare(b.file))
      .slice(0, FOCUS_HOT)
      .forEach((f) => focus.add(f.file));
  }

  const asFile = (file: string) =>
    level === 'file' || expand.has(dirOfFile(file)) || focus.has(file);

  const nodes = new Map<string, GraphNode>();
  const ensureDir = (dir: string, expanded: boolean): GraphNode => {
    const id = dirIdOf(dir);
    let node = nodes.get(id);
    if (!node) {
      node = {
        id,
        label: dir ? `${dir}/` : '.',
        kind: 'dir',
        depth: dirDepth(dir),
        files: 0,
        inbound: 0,
        outbound: 0,
      };
      nodes.set(id, node);
    }
    if (expanded) node.expanded = true;
    return node;
  };

  const dirNodes = new Set<string>();
  for (const rel of project.entries.keys()) {
    const info = project.entries.get(rel);
    if (!info || info.dir) continue;
    let dir = dirname(rel);
    for (;;) {
      dirNodes.add(dir);
      if (!dir) break;
      dir = dirname(dir);
    }
  }
  for (const dir of dirNodes) ensureDir(dir, expand.has(dir));

  // 目录文件数（子树）
  for (const fact of map.facts.values()) {
    const id = dirIdOf(dirOfFile(fact.file));
    const node = nodes.get(id);
    if (node) node.files++;
  }

  const ensureFile = (fact: { file: string; lang: LangId; test: boolean; entry: boolean }, focusNode: boolean) => {
    let node = nodes.get(fact.file);
    if (!node) {
      node = {
        id: fact.file,
        label: basename(fact.file),
        kind: 'file',
        depth: 0,
        files: 1,
        lang: fact.lang,
        inbound: 0,
        outbound: 0,
      };
      if (fact.entry) node.entry = true;
      if (fact.test) node.test = true;
      nodes.set(fact.file, node);
    }
    if (focusNode) node.focus = true;
    return node;
  };

  for (const file of focus) {
    const fact = map.facts.get(file);
    if (fact) ensureFile(fact, true);
  }
  for (const dir of expand) {
    for (const [rel, fact] of map.facts) {
      if (dirOfFile(rel) === dir) ensureFile(fact, focus.has(rel));
    }
  }
  if (level === 'file') {
    for (const fact of map.facts.values()) ensureFile(fact, focus.has(fact.file));
  }

  const nodeOf = (file: string): string | null => {
    if (asFile(file)) return map.facts.has(file) ? file : null;
    const dir = dirOfFile(file);
    return nodes.has(dirIdOf(dir)) ? dirIdOf(dir) : null;
  };

  // ---------------------------------------------------------------- 内部边
  const edges = new Map<string, GraphEdge>();
  const addEdge = (from: string, to: string, imports: number, refs: number) => {
    if (from === to) return;
    const key = `${from}\u0000${to}`;
    const edge = edges.get(key);
    if (edge) {
      edge.imports += imports;
      edge.refs += refs;
    } else {
      edges.set(key, { from, to, imports, refs });
    }
  };

  for (const [from, row] of map.edges) {
    const fromNode = nodeOf(from);
    if (!fromNode) continue;
    for (const [to, cell] of row) {
      const toNode = nodeOf(to);
      if (!toNode) continue;
      addEdge(fromNode, toNode, cell.import, cell.ref);
    }
  }

  // ---------------------------------------------------------------- 外部依赖
  const ext = new Map<string, { inbound: number; files: Set<string> }>();
  for (const fi of project.files.values()) {
    const fromNode = nodeOf(fi.file);
    if (!fromNode) continue;
    for (const imp of fi.imports) {
      if (moduleFiles(project, fi, imp).length) continue;
      const name = packageRoot(imp.module);
      if (!name) continue;
      let item = ext.get(name);
      if (!item) {
        item = { inbound: 0, files: new Set() };
        ext.set(name, item);
      }
      item.inbound++;
      item.files.add(fi.file);
    }
  }
  const externals = [...ext.entries()]
    .map(([name, item]) => ({ name, inbound: item.inbound, files: item.files.size }))
    .sort((a, b) => b.files - a.files || b.inbound - a.inbound || a.name.localeCompare(b.name));

  if (externalLimit > 0) {
    for (const item of externals.slice(0, externalLimit)) {
      const id = `ext:${item.name}`;
      nodes.set(id, {
        id,
        label: item.name,
        kind: 'external',
        depth: 0,
        files: item.files,
        inbound: 0,
        outbound: 0,
      });
    }
    for (const fi of project.files.values()) {
      const fromNode = nodeOf(fi.file);
      if (!fromNode) continue;
      const seen = new Set<string>();
      for (const imp of fi.imports) {
        if (moduleFiles(project, fi, imp).length) continue;
        const name = packageRoot(imp.module);
        const id = `ext:${name}`;
        if (!nodes.has(id) || seen.has(id)) continue;
        seen.add(id);
        addEdge(fromNode, id, 1, 0);
      }
    }
  }

  // ---------------------------------------------------------------- 度数 / 分层
  for (const edge of edges.values()) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (from) from.outbound++;
    if (to) to.inbound++;
  }

  let truncated = 0;
  const list = [...nodes.values()];
  const fileNodes = list.filter((n) => n.kind === 'file');
  if (fileNodes.length > MAX_FILE_NODES) {
    const keep = new Set(
      fileNodes
        .sort((a, b) => b.inbound + b.outbound - (a.inbound + a.outbound) || a.id.localeCompare(b.id))
        .slice(0, MAX_FILE_NODES)
        .map((n) => n.id),
    );
    truncated += fileNodes.length - keep.size;
    for (const node of fileNodes) if (!keep.has(node.id)) nodes.delete(node.id);
  }
  const dirNodesList = [...nodes.values()].filter((n) => n.kind === 'dir');
  if (dirNodesList.length > MAX_DIR_NODES) {
    const keep = new Set(
      dirNodesList
        .sort((a, b) => b.files - a.files || a.id.localeCompare(b.id))
        .slice(0, MAX_DIR_NODES)
        .map((n) => n.id),
    );
    truncated += dirNodesList.length - keep.size;
    for (const node of dirNodesList) if (!keep.has(node.id)) nodes.delete(node.id);
  }
  for (const [key, edge] of edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) edges.delete(key);
  }

  const finalNodes = [...nodes.values()];
  const finalEdges = [...edges.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  // 目录分层：优先用概览算好的职责分层（M4.2），没传就回退到「按依赖方向」的老口径
  const dirDeg = new Map<string, { in: number; out: number }>();
  const bump = (id: string, key: 'in' | 'out') => {
    const deg = dirDeg.get(id) ?? { in: 0, out: 0 };
    deg[key]++;
    dirDeg.set(id, deg);
  };
  for (const [from, row] of map.edges) {
    const fromDir = dirIdOf(dirOfFile(from));
    for (const to of row.keys()) {
      const toDir = dirIdOf(dirOfFile(to));
      if (fromDir === toDir) continue;
      bump(fromDir, 'out');
      bump(toDir, 'in');
    }
  }
  const dutyByDir = new Map<string, DirDuty>();
  for (const item of options.duties ?? []) dutyByDir.set(dirIdOf(item.dir), item);

  const duties: DependencyGraph['duties'] = {};
  for (const node of finalNodes) {
    if (node.kind !== 'dir') continue;
    const duty = dutyByDir.get(node.id);
    if (duty) {
      node.layer = duty.layer;
      node.duty = duty.duty;
      node.dutyFrom = duty.dutyFrom;
      duties[node.id] = { duty: duty.duty, from: duty.dutyFrom, layerReason: duty.layerReason };
      continue;
    }
    const deg = dirDeg.get(node.id) ?? { in: 0, out: 0 };
    const layer: GraphLayer =
      deg.in === 0 && deg.out === 0
        ? 'isolated'
        : deg.out === 0
          ? 'infra'
          : deg.in === 0
            ? 'entry'
            : 'domain';
    node.layer = layer;
    duties[node.id] = {
      duty: `${node.files} 个文件`,
      from: null,
      layerReason: `被 ${deg.in} 个目录依赖、依赖 ${deg.out} 个目录`,
    };
  }

  // 泳道（M4.2）：把目录节点按职责分层分组，前端据此做泳道布局
  const lanes = LANE_ORDER.map((layer) => ({
    layer,
    label: LANE_LABEL[layer],
    nodes: finalNodes
      .filter((n) => n.kind === 'dir' && n.layer === layer)
      .sort((a, b) => b.files - a.files || a.id.localeCompare(b.id))
      .map((n) => n.id),
  })).filter((lane) => lane.nodes.length > 0);
  finalNodes.sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));

  const adjacency = new Map<string, Map<string, GraphEdge>>();
  for (const edge of finalEdges) {
    let row = adjacency.get(edge.from);
    if (!row) {
      row = new Map();
      adjacency.set(edge.from, row);
    }
    row.set(edge.to, edge);
  }

  return {
    level,
    nodes: finalNodes,
    edges: finalEdges,
    cycles: findCycles(
      finalNodes.map((n) => n.id),
      adjacency,
    ),
    externals,
    truncated,
    totalFiles: map.facts.size,
    lanes,
    duties,
  };
}

/** 目录级反向依赖（M6.2）：我动的这块，外面有几个入口依赖。 */
export function dirDependentsOf(
  project: ProjectIndex,
  dir: string,
  depth = 2,
): DirDependentsResult {
  const map = projectMap(project);
  const clean = dir.replace(/\/+$/, '');
  const inDir = (file: string) => dirname(file) === clean;

  const inbound = new Map<string, { files: Set<string>; imports: number; refs: number; tests: Set<string> }>();
  const outbound = new Map<string, { files: Set<string>; imports: number; refs: number }>();
  for (const [from, row] of map.edges) {
    for (const [to, cell] of row) {
      const fromInside = inDir(from);
      const toInside = inDir(to);
      if (fromInside === toInside) continue;
      if (toInside) {
        const key = dirname(from);
        const item = inbound.get(key) ?? { files: new Set(), imports: 0, refs: 0, tests: new Set() };
        item.files.add(from);
        item.imports += cell.import;
        item.refs += cell.ref;
        if (map.facts.get(from)?.test) item.tests.add(dirname(from));
        inbound.set(key, item);
      } else if (fromInside) {
        const key = dirname(to);
        const item = outbound.get(key) ?? { files: new Set(), imports: 0, refs: 0 };
        item.files.add(to);
        item.imports += cell.import;
        item.refs += cell.ref;
        outbound.set(key, item);
      }
    }
  }

  // 传递上游：从目录出发反着走 N 跳
  const limit = Math.max(1, Math.min(depth, 5));
  const seen = new Map<string, number>();
  let frontier = [clean];
  for (let d = 1; d <= limit; d++) {
    const next: string[] = [];
    for (const target of frontier) {
      for (const [from, row] of map.edges) {
        if (dirname(from) === target) continue;
        for (const to of row.keys()) {
          if (dirname(to) !== target) continue;
          const fromDir = dirname(from);
          if (fromDir === clean || seen.has(fromDir) || next.includes(fromDir)) continue;
          seen.set(fromDir, d);
          next.push(fromDir);
        }
      }
    }
    if (!next.length) break;
    frontier = next;
  }

  const files = [...map.facts.values()].filter((f) => f.dir === clean);
  const keyFiles = files
    .sort((a, b) => b.inDegree - a.inDegree || a.file.localeCompare(b.file))
    .slice(0, 8)
    .map((f) => ({ file: f.file, inbound: f.inDegree }));

  return {
    dir: dirIdOf(clean),
    direct: [...inbound.entries()]
      .map(([d, item]) => ({
        dir: dirIdOf(d),
        files: item.files.size,
        imports: item.imports,
        refs: item.refs,
        tests: item.tests.size,
      }))
      .sort((a, b) => b.files - a.files || a.dir.localeCompare(b.dir)),
    outbound: [...outbound.entries()]
      .map(([d, item]) => ({ dir: dirIdOf(d), files: item.files.size, imports: item.imports, refs: item.refs }))
      .sort((a, b) => b.files - a.files || a.dir.localeCompare(b.dir)),
    transitive: [...seen.entries()].map(([d, dd]) => ({ dir: dirIdOf(d), depth: dd })).sort((a, b) => a.depth - b.depth || a.dir.localeCompare(b.dir)),
    files: files.length,
    keyFiles,
  };
}

/** 反向依赖：谁直接引用了它、谁间接依赖它、哪些测试覆盖它。 */
export function dependentsOf(project: ProjectIndex, file: string, depth = 2): DependentsResult {
  const map = projectMap(project);
  const direct: DependentsResult['direct'] = [];
  for (const [from, row] of map.edges) {
    const cell = row.get(file);
    if (!cell) continue;
    direct.push({
      file: from,
      imports: cell.import,
      refs: cell.ref,
      test: map.facts.get(from)?.test ?? false,
    });
  }
  direct.sort((a, b) => b.imports + b.refs - (a.imports + a.refs) || a.file.localeCompare(b.file));

  const limit = Math.max(1, Math.min(depth, 5));
  const seen = new Map<string, number>();
  let frontier = [file];
  for (let d = 1; d <= limit; d++) {
    const next: string[] = [];
    for (const target of frontier) {
      for (const [from, row] of map.edges) {
        if (!row.has(target)) continue;
        if (from === file || seen.has(from)) continue;
        if (next.includes(from)) continue;
        seen.set(from, d);
        next.push(from);
      }
    }
    if (!next.length) break;
    frontier = next;
  }

  const transitive = [...seen.entries()]
    .map(([dep, d]) => ({ file: dep, depth: d }))
    .sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file));

  return {
    file,
    direct,
    transitive,
    tests: direct.filter((d) => d.test).map(({ file: f, imports, refs }) => ({ file: f, imports, refs })),
    total: direct.length,
  };
}

