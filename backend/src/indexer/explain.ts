/**
 * 结构性解释（04 Guide · G5.2 / G5.3）：纯静态、不调模型。
 *
 * 回答的是四个能确证的问题：这段是什么（定义 / 所属类 / 签名）、它调用了谁、
 * 谁调用它、它引用了本项目哪些定义与哪些外部模块。每一条都带 `path:line` 出处。
 *
 * 三条纪律：
 * 1) **不编造**：解析不到的关系计数进 `unresolved`，并如实携带；不做类型推断。
 * 2) 目标定位复用 resolver（先 `gotoDefinition`，再 `enclosingDefAt` 回落到所在符号），
 *    「谁调用我 / 我调用了谁」复用 callgraph 的 `callHierarchy`，不另写一套判定。
 * 3) 文本层（`summary`）只由结构化字段确定性拼装，不引入模型、不加形容词。
 */
import type { CallNode, ExplainRef, ExplainResult, ExplainScope, SymbolKind } from '../types';
import type { DefRecord, FileIndex } from './model';
import { callHierarchy } from './callgraph';
import { defAt, enclosingDefAt, gotoDefinition, refAt, resolveRef } from './resolver';
import type { ProjectIndex } from './store';

export interface ExplainRequest {
  file: string;
  /** 1-based 行 / 列（与 Monaco 一致）。 */
  line: number;
  col: number;
  scope: ExplainScope;
}

/** kind 的中文名（与 summary.ts 同一张表的口径，缺省回落到原值）。 */
const KIND_LABEL: Partial<Record<SymbolKind, string>> = {
  class: '类',
  struct: '结构体',
  interface: '接口',
  enum: '枚举',
  type: '类型',
  function: '函数',
  method: '方法',
  constructor: '构造函数',
  property: '属性',
  field: '字段',
  variable: '变量',
  constant: '常量',
  module: '模块',
  namespace: '命名空间',
};

const labelOf = (kind: SymbolKind): string => KIND_LABEL[kind] ?? kind;

/** 从 import 绑定回指模块说明符（与 resolver 的可见性规则一致：沿作用域链找）。 */
function importModuleOf(fi: FileIndex, scopeId: string, name: string): string {
  let scope = fi.scopes.get(scopeId) ?? null;
  while (scope) {
    const imp = fi.importsByScope.get(scope.id)?.get(name);
    if (imp) return imp.module;
    scope = scope.parent ? fi.scopes.get(scope.parent) ?? null : null;
  }
  return '';
}

/** 目标定义体内「引用了本项目哪些定义 / 哪些外部模块」——逐条带出处，不聚合、不猜。 */
function scanRefs(
  project: ProjectIndex,
  def: DefRecord,
): {
  projectRefs: ExplainRef[];
  externalModules: Array<{ module: string; file: string; line: number }>;
  unresolved: number;
} {
  const projectRefs: ExplainRef[] = [];
  const externalModules: Array<{ module: string; file: string; line: number }> = [];
  let unresolved = 0;
  const fi = project.files.get(def.file);
  if (!fi) return { projectRefs, externalModules, unresolved };

  const seen = new Set<string>();
  const seenRef = new Set<string>();
  for (const ref of fi.references) {
    const at = ref.range.start;
    if (at.line < def.range.start.line || at.line > def.range.end.line) continue;
    if (at.line === def.range.start.line && at.col < def.range.start.col) continue;
    // 只算「直接挂在本定义体内」的引用：嵌套函数 / 内部类的引用归它们自己
    const owner = defAt(fi, at);
    if (owner && owner.id !== def.id) continue;
    const key = `${at.line}:${at.col}`;
    if (seenRef.has(key)) continue;
    seenRef.add(key);

    const resolved = resolveRef(project, fi, ref);
    if (!resolved) {
      unresolved += 1;
      continue;
    }
    if (resolved.kind === 'external') {
      const binding = ref.memberParts?.[0] ?? ref.name;
      const module = importModuleOf(fi, ref.scopeId, binding);
      externalModules.push({ module, file: def.file, line: at.line });
      continue;
    }
    if (resolved.kind === 'module') {
      const id = `module:${resolved.file}`;
      if (seen.has(id)) continue;
      seen.add(id);
      projectRefs.push({ name: ref.name, file: resolved.file, line: 1, kind: 'module' });
      continue;
    }
    if (resolved.def.id === def.id) continue;
    const id = resolved.def.id;
    if (seen.has(id)) continue;
    seen.add(id);
    projectRefs.push({
      name: resolved.def.name,
      file: resolved.def.file,
      line: resolved.def.nameRange.start.line,
      kind: resolved.def.kind,
    });
  }
  return { projectRefs, externalModules, unresolved };
}

/** 文本层：只把结构化字段连成一句，不使用模型。 */
function summaryOf(
  target: ExplainResult['target'],
  callers: CallNode[],
  callees: CallNode[],
  projectRefs: ExplainRef[],
  externalModules: Array<{ module: string }>,
  unresolved: number,
): string {
  const parts = [`${target.name} 是一个${labelOf(target.kind)}，定义在 ${target.file}:${target.line}`];
  parts.push(callers.length ? `${callers.length} 个直接调用来源` : '没有被本项目引用到');
  if (callees.length) parts.push(`它引用了 ${callees.length} 个调用目标`);
  if (projectRefs.length) parts.push(`涉及 ${projectRefs.length} 个项目内定义`);
  if (externalModules.length) parts.push(`以及 ${externalModules.length} 个外部模块符号`);
  if (unresolved > 0) parts.push(`另有 ${unresolved} 处未能归属（需要类型信息）`);
  return `${parts.join('，')}。`;
}

/**
 * 解释光标处的符号。定位不到项目内定义（外部依赖 / 空白处 / 未索引文件）返回 null，
 * 由端点层给 404 `no-symbol`。
 */
export function explainAt(project: ProjectIndex, req: ExplainRequest): ExplainResult | null {
  const fi = project.files.get(req.file);
  if (!fi) return null;
  const line = Number.isFinite(req.line) && req.line > 0 ? Math.floor(req.line) : 1;
  const col = Number.isFinite(req.col) && req.col > 0 ? Math.floor(req.col) : 1;
  const pos = { line, col };
  const scope: ExplainScope =
    req.scope === 'selection' || req.scope === 'callers' ? req.scope : 'symbol';

  const atDef = defAt(fi, pos);
  const atRef = atDef ? null : refAt(fi, pos);
  // selection 档只说光标处这一小段：那里既没有符号名也不是引用 → 如实「无从解释」
  if (scope === 'selection' && !atDef && !atRef) return null;

  // 先 gotoDefinition（能跟到别处的定义），再回落到「光标所在的符号」（在函数体内部时）
  const gd = gotoDefinition(project, req.file, line, col);
  let def: DefRecord | null = atDef;
  if (!def && gd.reason === 'resolved' && gd.locations.length) {
    const loc = gd.locations[0];
    const tfi = project.files.get(loc.file);
    def = tfi ? defAt(tfi, loc.range.start) : null;
  }
  if (!def && scope !== 'selection') def = enclosingDefAt(fi, pos);
  if (!def) return null;

  const start = def.nameRange.start;
  // callers 档把调用方一并纳入：反向树展开两层（直接 + 间接）；其余档只看直接调用方
  const inDepth = scope === 'callers' ? 2 : 1;
  const inTree = callHierarchy(project, def.file, start.line, start.col, 'in', inDepth);
  const outTree = callHierarchy(project, def.file, start.line, start.col, 'out', 1);
  const callers: CallNode[] = inTree.root?.children ?? [];
  const callees: CallNode[] = outTree.root?.children ?? [];

  const scanned = scanRefs(project, def);
  const coverage = {
    resolved: inTree.coverage.resolved + outTree.coverage.resolved,
    unresolved: inTree.coverage.unresolved + outTree.coverage.unresolved,
    external: inTree.coverage.external + outTree.coverage.external,
  };

  const tokenRange = atDef ? atDef.nameRange : (atRef?.range ?? def.range);
  const range = scope === 'selection' ? tokenRange : def.range;

  const target = {
    name: def.name,
    kind: def.kind,
    file: def.file,
    line: start.line,
    col: start.col,
    containerName: def.containerName,
    signature: def.detail,
    doc: def.doc?.length ? def.doc.join('\n') : null,
  };

  return {
    scope,
    target,
    callers,
    callees,
    projectRefs: scanned.projectRefs,
    externalModules: scanned.externalModules,
    unresolved: coverage.unresolved,
    coverage,
    lines: { start: range.start.line, end: range.end.line },
    summary: summaryOf(
      target,
      callers,
      callees,
      scanned.projectRefs,
      scanned.externalModules,
      coverage.unresolved,
    ),
  };
}
