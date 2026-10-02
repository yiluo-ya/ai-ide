/**
 * 调用层级（N16）、类型层级（N17）、跳到实现（N15）。
 *
 * 三条硬约束（03-navigator-plan §0）：
 * 1. 只陈述索引能确认的事实：解析不到的调用单独列出，**不用启发式凑数**；
 * 2. 覆盖率如实上报（面板底部固定显示「已解析 N 处 / 另有 M 处未能归属」）；
 * 3. 入口候选统一走 01 地图的 `looksLikeEntry`，导航内不自建第二份判定。
 */
import type { Location, SymbolKind } from '../types';
import type { DefRecord, Resolved } from './model';
import type { ProjectIndex } from './store';
import { defAt, enclosingDefAt, refAt, resolveMember, resolveName, resolveRef } from './resolver';
import { isTestFile, looksLikeEntry } from './insight';
import { specById } from '../languages';
import { basename } from './paths';

export type CallDirection = 'in' | 'out';

export interface CallNode {
  name: string;
  kind: SymbolKind;
  file: string;
  /** 该节点的定义位置（nameRange）；模块级节点为文件首行。 */
  location: Location;
  /** 与父节点之间的调用处数。 */
  callCount: number;
  /** out 方向：外部依赖叶子。 */
  external?: boolean;
  /** out 方向：解析不到的调用（聚合节点）。 */
  unresolved?: boolean;
  /** 入口候选（文件末段像 main/index/cmd…，与 01 地图同源）。 */
  isEntry?: boolean;
  isTest?: boolean;
  children?: CallNode[];
}

export interface CallHierarchyResult {
  direction: CallDirection;
  reason: 'resolved' | 'external' | 'unresolved' | 'no-symbol';
  symbol: string | null;
  root: CallNode | null;
  /** 诚实上报的覆盖率（Q0 兜底）。 */
  coverage: { resolved: number; unresolved: number; external: number };
  message?: string;
}

const MAX_NODES = 300;
const MAX_DEPTH = 3;

function loc(def: DefRecord): Location {
  return { file: def.file, range: def.nameRange };
}

function fileLoc(file: string): Location {
  return { file, range: { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } } };
}

/** 目标定义：光标在定义上取之；在引用上则解析过去。 */
function targetOf(project: ProjectIndex, file: string, line: number, col: number): {
  def: DefRecord | null;
  reason: CallHierarchyResult['reason'];
  symbol: string | null;
} {
  const fi = project.files.get(file);
  if (!fi) return { def: null, reason: 'no-symbol', symbol: null };
  const pos = { line, col };
  const direct = defAt(fi, pos);
  if (direct) return { def: direct, reason: 'resolved', symbol: direct.name };
  const ref = refAt(fi, pos);
  if (!ref) return { def: null, reason: 'no-symbol', symbol: null };
  const resolved = resolveRef(project, fi, ref);
  if (!resolved) {
    // 语言内置（print / console …）归为外部依赖，与 goto-definition 的口径一致
    const spec = specById(fi.lang);
    return {
      def: null,
      reason: spec?.builtins?.has(ref.name) ? 'external' : 'unresolved',
      symbol: ref.name,
    };
  }
  if (resolved.kind !== 'def') {
    return { def: null, reason: resolved.kind === 'external' ? 'external' : 'unresolved', symbol: ref.name };
  }
  return { def: resolved.def, reason: 'resolved', symbol: ref.name };
}

/** 调用某定义的那些位置 → 归属到「最内层定义」（调用方）。 */
function callersOf(project: ProjectIndex, target: DefRecord): {
  callers: Array<{ def: DefRecord | null; file: string; count: number }>;
  unresolved: number;
} {
  const byKey = new Map<string, { def: DefRecord | null; file: string; count: number }>();
  let unresolved = 0;
  // 与该定义同名的引用里，解析不到的就是「未归属」，如实计数
  for (const entry of project.refsByName.get(target.name) ?? []) {
    const cfi = project.files.get(entry.file);
    if (!cfi) continue;
    const resolved = resolveRef(project, cfi, entry.ref);
    if (!(resolved && resolved.kind === 'def' && resolved.def.id === target.id)) continue;
    const owner = enclosingDefAt(cfi, entry.ref.range.start);
    const key = owner ? owner.id : `file:${entry.file}`;
    const hit = byKey.get(key);
    if (hit) hit.count += 1;
    else byKey.set(key, { def: owner, file: entry.file, count: 1 });
  }
  // 未解析引用如实计数（只统计同名且不在任何定义内的裸引用）
  for (const entry of project.refsByName.get(target.name) ?? []) {
    const cfi = project.files.get(entry.file);
    if (!cfi) continue;
    const resolved = resolveRef(project, cfi, entry.ref);
    if (resolved === null) unresolved += 1;
  }
  return { callers: [...byKey.values()], unresolved };
}

/** 某定义体内调用了谁（跨文件 / 外部 / 未解析三类分开）。 */
function calleesOf(project: ProjectIndex, target: DefRecord): {
  callees: Array<{ def: DefRecord; count: number }>;
  modules: Array<{ file: string; count: number }>;
  external: number;
  unresolved: number;
} {
  const fi = project.files.get(target.file);
  const callees = new Map<string, { def: DefRecord; count: number }>();
  const modules = new Map<string, { file: string; count: number }>();
  let external = 0;
  let unresolved = 0;
  if (!fi) return { callees: [], modules: [], external, unresolved };

  for (const ref of fi.references) {
    const r = ref.range.start;
    if (r.line < target.range.start.line || r.line > target.range.end.line) continue;
    if (r.line === target.range.start.line && r.col < target.range.start.col) continue;
    // 只算「直接挂在本定义体内」的引用（嵌套函数 / 内部类的引用归属它们自己）
    const owner = defAt(fi, r);
    if (owner && owner.id !== target.id) continue;
    if (ref.name === target.name && owner === null) continue;
    const resolved = resolveRef(project, fi, ref);
    if (!resolved) {
      unresolved += 1;
      continue;
    }
    if (resolved.kind === 'external') {
      external += 1;
      continue;
    }
    if (resolved.kind === 'module') {
      const hit = modules.get(resolved.file);
      if (hit) hit.count += 1;
      else modules.set(resolved.file, { file: resolved.file, count: 1 });
      continue;
    }
    if (resolved.def.id === target.id) continue;
    const hit = callees.get(resolved.def.id);
    if (hit) hit.count += 1;
    else callees.set(resolved.def.id, { def: resolved.def, count: 1 });
  }
  return {
    callees: [...callees.values()].sort((a, b) => b.count - a.count),
    modules: [...modules.values()].sort((a, b) => b.count - a.count),
    external,
    unresolved,
  };
}

function nodeOf(def: DefRecord, count: number): CallNode {
  return {
    name: def.name,
    kind: def.kind,
    file: def.file,
    location: loc(def),
    callCount: count,
    isEntry: looksLikeEntry(def.file),
    isTest: isTestFile(def.file),
  };
}

function moduleNode(file: string, count: number): CallNode {
  return {
    name: `${basename(file)}（模块级）`,
    kind: 'module',
    file,
    location: fileLoc(file),
    callCount: count,
    isEntry: looksLikeEntry(file),
    isTest: isTestFile(file),
  };
}

/**
 * 调用层级：direction=in（谁调用我）/ out（我调用了谁），可展开到 depth 层。
 * 展开时按定义 id 去重防环，节点上限 MAX_NODES。
 */
export function callHierarchy(
  project: ProjectIndex,
  file: string,
  line: number,
  col: number,
  direction: CallDirection,
  depth = 1,
): CallHierarchyResult {
  const empty = { resolved: 0, unresolved: 0, external: 0 };
  const { def: root, reason, symbol } = targetOf(project, file, line, col);
  if (!root) {
    return {
      direction,
      reason,
      symbol,
      root: null,
      coverage: empty,
      message:
        reason === 'external'
          ? '这是外部依赖，项目内没有它的定义'
          : reason === 'no-symbol'
            ? '光标处没有可识别的符号'
            : '没能解析到定义，无法展开调用层级',
    };
  }

  const maxDepth = Math.max(1, Math.min(depth, MAX_DEPTH));
  let unresolvedTotal = 0;
  let externalTotal = 0;
  let resolvedTotal = 0;
  let nodeCount = 0;

  const expand = (target: DefRecord, level: number): CallNode[] => {
    if (level > maxDepth || nodeCount >= MAX_NODES) return [];
    const out: CallNode[] = [];
    if (direction === 'in') {
      const { callers, unresolved } = callersOf(project, target);
      unresolvedTotal += unresolved;
      resolvedTotal += callers.reduce((n, c) => n + c.count, 0);
      for (const c of callers) {
        if (nodeCount >= MAX_NODES) break;
        nodeCount += 1;
        const node = c.def ? nodeOf(c.def, c.count) : moduleNode(c.file, c.count);
        if (c.def) {
          const children = expand(c.def, level + 1);
          if (children.length) node.children = children;
        }
        out.push(node);
      }
      out.sort((a, b) => b.callCount - a.callCount);
    } else {
      const { callees, modules, external, unresolved } = calleesOf(project, target);
      externalTotal += external;
      unresolvedTotal += unresolved;
      resolvedTotal += callees.reduce((n, c) => n + c.count, 0);
      for (const c of callees) {
        if (nodeCount >= MAX_NODES) break;
        nodeCount += 1;
        const node = nodeOf(c.def, c.count);
        const children = expand(c.def, level + 1);
        if (children.length) node.children = children;
        out.push(node);
      }
      for (const m of modules) {
        if (nodeCount >= MAX_NODES) break;
        nodeCount += 1;
        out.push(moduleNode(m.file, m.count));
      }
      if (external > 0) {
        out.push({
          name: `外部依赖（${external} 处）`,
          kind: 'unknown',
          file: '',
          location: fileLoc(''),
          callCount: external,
          external: true,
        });
      }
      if (unresolved > 0) {
        out.push({
          name: `未解析（${unresolved} 处，需类型推断）`,
          kind: 'unknown',
          file: '',
          location: fileLoc(''),
          callCount: unresolved,
          unresolved: true,
        });
      }
      out.sort((a, b) => b.callCount - a.callCount);
    }
    return out;
  };

  const rootNode = nodeOf(root, 0);
  const children = expand(root, 1);
  if (children.length) rootNode.children = children;

  return {
    direction,
    reason: 'resolved',
    symbol: root.name,
    root: rootNode,
    coverage: { resolved: resolvedTotal, unresolved: unresolvedTotal, external: externalTotal },
  };
}

// ---------------------------------------------------------------- 类型层级（N17）

export interface TypeNode {
  name: string;
  kind: SymbolKind;
  file: string;
  location: Location;
  /** 关系标签：extend / implement / embed / override。 */
  relation: 'extends' | 'implements' | 'embeds' | 'overrides';
  isTest?: boolean;
}

export interface TypeHierarchyResult {
  reason: 'resolved' | 'external' | 'unresolved' | 'no-symbol';
  symbol: string | null;
  /** 自身的种类（class / interface / method …）。 */
  kind: SymbolKind | null;
  /** 显式声明的父类 / 接口（能解析到项目内定义的）。 */
  bases: TypeNode[];
  /** 谁显式继承 / 实现了它（反向）。 */
  derived: TypeNode[];
  /** 项目内找不到定义的基名（外部依赖或未索引），如实列出。 */
  unresolvedBases: string[];
  message?: string;
}

function resolveBase(project: ProjectIndex, from: DefRecord, name: string): DefRecord | null {
  // 走项目既有解析规则（含导入），不做猜测
  if (!name.includes('.')) {
    const r = resolveName(project, from.file, name, from.scopeId);
    return r && r.kind === 'def' ? r.def : null;
  }
  // 点号基名（`abc.ABC` / `mixins.M`）：先解析头部，再逐段取成员
  const parts = name.split('.');
  let cur: Resolved | null = resolveName(project, from.file, parts[0], from.scopeId);
  for (let i = 1; i < parts.length && cur; i++) cur = resolveMember(project, cur, parts[i]);
  return cur && cur.kind === 'def' ? cur.def : null;
}

/** 类型层级：显式继承 / 实现，双向（覆盖不到的形态如实列入 unresolvedBases）。 */
export function typeHierarchy(
  project: ProjectIndex,
  file: string,
  line: number,
  col: number,
): TypeHierarchyResult {
  const empty = { bases: [] as TypeNode[], derived: [] as TypeNode[], unresolvedBases: [] as string[] };
  const { def: root, reason, symbol } = targetOf(project, file, line, col);
  if (!root) {
    return {
      reason,
      symbol,
      kind: null,
      ...empty,
      message:
        reason === 'external'
          ? '这是外部依赖，项目内没有它的继承信息'
          : reason === 'no-symbol'
            ? '光标处没有可识别的符号'
            : '没能解析到定义，无法给出类型层级',
    };
  }

  const bases: TypeNode[] = [];
  const unresolvedBases: string[] = [];
  const directBases: DefRecord[] = [];
  for (const base of root.bases ?? []) {
    const found = resolveBase(project, root, base.name);
    if (found) {
      directBases.push(found);
      bases.push({
        name: found.name,
        kind: found.kind,
        file: found.file,
        location: loc(found),
        relation: base.kind,
        isTest: isTestFile(found.file),
      });
    } else {
      unresolvedBases.push(base.name);
    }
  }
  // 间接基类（祖父）也列出来，标注沿用祖先自己写下的关系
  const seen = new Set(bases.map((b) => `${b.file}:${b.location.range.start.line}`));
  for (const b of directBases) {
    for (const base of b.bases ?? []) {
      const found = resolveBase(project, root, base.name);
      if (!found) continue;
      const key = `${found.file}:${found.nameRange.start.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bases.push({
        name: found.name,
        kind: found.kind,
        file: found.file,
        location: loc(found),
        relation: base.kind,
        isTest: isTestFile(found.file),
      });
    }
  }

  const derived: TypeNode[] = [];
  for (const id of project.heritageOf.get(root.name) ?? []) {
    const d = project.defsById.get(id);
    if (!d) continue;
    const relation = (d.bases ?? []).find((b) => b.name === root.name || b.name.endsWith(`.${root.name}`))?.kind ?? 'extends';
    derived.push({
      name: d.name,
      kind: d.kind,
      file: d.file,
      location: loc(d),
      relation,
      isTest: isTestFile(d.file),
    });
  }
  derived.sort((a, b) => a.file.localeCompare(b.file) || a.location.range.start.line - b.location.range.start.line);

  return { reason: 'resolved', symbol: root.name, kind: root.kind, bases, derived, unresolvedBases };
}

// ---------------------------------------------------------------- 跳到实现（N15）

export interface ImplementationsResult {
  reason: 'resolved' | 'external' | 'unresolved' | 'no-symbol' | 'not-applicable';
  symbol: string | null;
  /** 实现清单（接口的方法 → 各实现类里的同名方法；接口 → 实现类）。 */
  items: TypeNode[];
  message?: string;
}

/**
 * 跳到实现：接口 / 抽象方法 → 实现它的类（或类里的同名方法）。
 * 只认显式 implements / extends 声明的实现类，不做鸭子类型推断。
 */
export function implementationsOf(
  project: ProjectIndex,
  file: string,
  line: number,
  col: number,
): ImplementationsResult {
  const { def: root, reason, symbol } = targetOf(project, file, line, col);
  if (!root) {
    return {
      reason,
      symbol,
      items: [],
      message:
        reason === 'external' ? '外部依赖不提供实现列表' : '没能解析到定义，无法列出实现',
    };
  }

  // 情形一：光标在类 / 接口上 → 列出继承者
  if (root.kind === 'class' || root.kind === 'interface' || root.kind === 'struct') {
    const th = typeHierarchy(project, file, line, col);
    return {
      reason: th.derived.length ? 'resolved' : 'not-applicable',
      symbol: root.name,
      items: th.derived,
      message: th.derived.length ? undefined : '项目内没有显式继承 / 实现它的类型',
    };
  }

  // 情形二：光标在接口 / 抽象方法上 → 找实现类里的同名方法
  const containerName = root.containerName;
  if (!containerName) {
    return { reason: 'not-applicable', symbol: root.name, items: [], message: '只对类 / 接口成员提供实现列表' };
  }
  const ownFi = project.files.get(root.file);
  if (!ownFi) return { reason: 'unresolved', symbol: root.name, items: [], message: '定义文件不在索引中' };
  const container =
    (ownFi.defsByScope.get(`${root.file}#s0`)?.get(containerName) ?? []).slice(-1)[0] ?? null;
  if (!container) {
    return { reason: 'not-applicable', symbol: root.name, items: [], message: `找不到 ${containerName} 的定义` };
  }

  const items: TypeNode[] = [];
  for (const id of project.heritageOf.get(container.name) ?? []) {
    const derivedType = project.defsById.get(id);
    if (!derivedType?.bodyScopeId) continue;
    const dfi = project.files.get(derivedType.file);
    const member = dfi?.defsByScope.get(derivedType.bodyScopeId)?.get(root.name)?.[0];
    const target = member ?? derivedType;
    items.push({
      name: member ? `${derivedType.name}.${member.name}` : derivedType.name,
      kind: member?.kind ?? derivedType.kind,
      file: target.file,
      location: loc(target),
      relation: 'overrides',
      isTest: isTestFile(target.file),
    });
  }
  return {
    reason: items.length ? 'resolved' : 'not-applicable',
    symbol: root.name,
    items,
    message: items.length ? undefined : `没有显式实现 ${containerName} 的类`,
  };
}
