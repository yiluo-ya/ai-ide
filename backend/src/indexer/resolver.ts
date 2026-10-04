/**
 * 符号解析：作用域就近查找 + 导入跨文件解析 + 成员链解析（FR-0002 §4.3）。
 *
 * 明确不做的：类型推断。`obj.method()` 里的 obj 是变量时无法确定其类型，
 * 只有模块/包/类级限定名（`os.path.join`、`pkg.Func`、`Foo.bar`、`this.x`）能跨文件解析。
 */
import type {
  DensitySegment,
  ExternalSource,
  FileDensity,
  HoverDefinition,
  HoverLiteral,
  HoverResult,
  LangId,
  Location,
  Position,
  Range,
  ReferenceLocation,
  SymbolInfo,
  UnresolvedDetail,
} from '../types';
import type { DefRecord, FileIndex, ImportRecord, LitRecord, RefRecord, Resolved } from './model';
import type { ProjectIndex } from './store';
import { specById } from '../languages';

const SELF_NAMES = new Set(['self', 'cls', 'this', 'super']);

const contains = (range: { start: Position; end: Position }, pos: Position): boolean => {
  if (pos.line < range.start.line || pos.line > range.end.line) return false;
  if (pos.line === range.start.line && pos.col < range.start.col) return false;
  if (pos.line === range.end.line && pos.col > range.end.col) return false;
  return true;
};

export function defAt(fi: FileIndex, pos: Position): DefRecord | null {
  for (const def of fi.definitions) {
    if (contains(def.nameRange, pos)) return def;
  }
  return null;
}

/** 最内层「包含该位置」的定义（调用层级要把调用处归到调用方函数）。 */
export function enclosingDefAt(fi: FileIndex, pos: Position): DefRecord | null {
  let best: DefRecord | null = null;
  for (const def of fi.definitions) {
    if (!contains(def.range, pos)) continue;
    if (!best) {
      best = def;
      continue;
    }
    const a = def.range.start;
    const b = best.range.start;
    if (a.line > b.line || (a.line === b.line && a.col >= b.col)) best = def;
  }
  return best;
}

export function refAt(fi: FileIndex, pos: Position): RefRecord | null {
  for (const ref of fi.references) {
    if (contains(ref.range, pos)) return ref;
  }
  return null;
}

/** 从光标位置找出「正在讨论的符号」——定义名或引用都可。 */
export function targetAt(
  project: ProjectIndex,
  file: string,
  pos: Position,
): { def: DefRecord | null; ref: RefRecord | null } {
  const fi = project.files.get(file);
  if (!fi) return { def: null, ref: null };
  const def = defAt(fi, pos);
  if (def) return { def, ref: null };
  return { def: null, ref: refAt(fi, pos) };
}

// ---------------------------------------------------------------- 解析

export function resolveRef(
  project: ProjectIndex,
  fi: FileIndex,
  ref: RefRecord,
): Resolved | null {
  const parts = ref.memberParts;
  if (ref.kind === 'member' && parts && parts.length > 1) {
    const head = parts[0];
    let target: Resolved | null = null;
    let next = 1;
    if (SELF_NAMES.has(head)) {
      // self.x / this.x：在所属类体里找成员
      const cls = enclosingClass(fi, ref.scopeId);
      if (cls) {
        const defs = fi.defsByScope.get(cls.id)?.get(parts[1]);
        if (defs?.length) {
          target = { kind: 'def', file: fi.file, def: defs[defs.length - 1] };
          next = 2;
        }
      }
    }
    if (!target) target = resolveName(project, fi.file, head, ref.scopeId);
    for (let i = next; i < parts.length && target; i++) {
      target = resolveMember(project, target, parts[i]);
    }
    return target;
  }
  return resolveName(project, fi.file, ref.name, ref.scopeId);
}

export function resolveName(
  project: ProjectIndex,
  file: string,
  name: string,
  scopeId: string,
  seen: Set<string> = new Set(),
): Resolved | null {
  const fi = project.files.get(file);
  if (!fi) return null;
  let scope = fi.scopes.get(scopeId) ?? null;
  while (scope) {
    const defs = fi.defsByScope.get(scope.id)?.get(name);
    if (defs?.length) return { kind: 'def', file, def: defs[defs.length - 1] };

    const imp = fi.importsByScope.get(scope.id)?.get(name);
    if (imp) return resolveImport(project, fi, imp, seen);

    const star = fi.importsByScope.get(scope.id)?.get('*');
    if (star) {
      for (const target of moduleFiles(project, fi, star)) {
        const r = topLevelLookup(project, target, name, seen);
        if (r) return r;
      }
    }
    scope = scope.parent ? fi.scopes.get(scope.parent) ?? null : null;
  }
  // 同包 / 同目录隐式可见（Go）
  const spec = specById(fi.lang);
  if (spec?.siblings) {
    for (const sibling of spec.siblings(file, project.hint())) {
      const sfi = project.files.get(sibling);
      if (!sfi) continue;
      const defs = sfi.defsByScope.get(`${sibling}#s0`)?.get(name);
      if (defs?.length) return { kind: 'def', file: sibling, def: defs[defs.length - 1] };
    }
  }
  return null;
}

export function resolveImport(
  project: ProjectIndex,
  fi: FileIndex,
  imp: ImportRecord,
  seen: Set<string> = new Set(),
): Resolved | null {
  const key = `${fi.file}->${imp.module}:${imp.importedName ?? imp.localName}`;
  if (seen.has(key)) return null;
  seen.add(key);

  const targets = moduleFiles(project, fi, imp);
  if (!targets.length) return { kind: 'external' };

  if (imp.kind === 'module' || imp.kind === 'namespace' || imp.kind === 'default') {
    return { kind: 'module', file: targets[0] };
  }

  const importedName = imp.importedName ?? imp.localName;
  for (const target of targets) {
    const r = topLevelLookup(project, target, importedName, seen);
    if (r) return r;
  }

  // Python：`from pkg import sub` 里的 sub 其实是一个子模块
  const spec = specById(fi.lang);
  if (spec?.moduleSpecifierOf && imp.importedName) {
    for (const target of targets) {
      if (target.endsWith('/')) continue;
      const base = spec.moduleSpecifierOf(target);
      if (!base) continue;
      const cands = spec.resolveModule?.(`${base}.${imp.importedName}`, fi.file, project.hint()) ?? [];
      for (const c of cands) {
        if (c.kind === 'file' && project.hint().exists(c.path)) {
          return { kind: 'module', file: c.path };
        }
      }
    }
  }
  return { kind: 'external' };
}

/** 成员访问：在模块 / 类体作用域里找同名定义。 */
export function resolveMember(
  project: ProjectIndex,
  target: Resolved,
  name: string,
): Resolved | null {
  if (target.kind === 'external') return target;
  if (target.kind === 'module') return topLevelLookup(project, target.file, name);
  if (target.kind !== 'def') return null;
  const fi = project.files.get(target.file);
  if (!fi) return null;
  if (target.def.bodyScopeId) {
    const defs = fi.defsByScope.get(target.def.bodyScopeId)?.get(name);
    if (defs?.length) return { kind: 'def', file: target.file, def: defs[defs.length - 1] };
  }
  return null;
}

/** 模块说明符 → 实际目标（文件路径，或 `dir/` 形式的包目录）。 */
export function moduleFiles(
  project: ProjectIndex,
  fi: FileIndex,
  imp: ImportRecord,
): string[] {
  const spec = specById(fi.lang);
  if (!spec) return [];
  const hint = project.hint();
  let candidates = spec.resolveModule?.(imp.module, fi.file, hint) ?? null;
  if (!candidates && spec.classBasedImports && imp.importedName) {
    candidates = hint.classFiles(imp.importedName).map((p) => ({ path: p, kind: 'file' as const }));
  }
  if (!candidates && spec.classBasedImports && imp.kind === 'star') {
    const dir = imp.module.split('.').join('/');
    if (hint.exists(dir)) candidates = [{ path: dir, kind: 'dir' }];
  }
  if (!candidates) return [];

  const out: string[] = [];
  for (const c of candidates) {
    if (c.kind === 'file') {
      if (hint.exists(c.path)) out.push(c.path);
    } else if (c.kind === 'dir') {
      const clean = c.path.replace(/\/+$/, '');
      if (clean === '' || hint.exists(clean)) out.push(clean === '' ? './' : `${clean}/`);
    } else if (c.kind === 'class') {
      for (const f of hint.classFiles(c.path)) out.push(f);
    }
  }
  return out;
}

/** 在目标（文件，或 `dir/` 包目录）的文件作用域里查找名字。 */
export function topLevelLookup(
  project: ProjectIndex,
  target: string,
  name: string,
  seen: Set<string> = new Set(),
): Resolved | null {
  const fileList = target === './'
    ? [...project.files.keys()]
    : target.endsWith('/')
      ? [...project.files.keys()].filter((f) => f.startsWith(target))
      : [target];
  for (const f of fileList) {
    const fi = project.files.get(f);
    if (!fi) continue;
    const scopeId = `${f}#s0`;
    const defs = fi.defsByScope.get(scopeId)?.get(name);
    if (defs?.length) return { kind: 'def', file: f, def: defs[defs.length - 1] };
  }
  for (const f of fileList) {
    const fi = project.files.get(f);
    if (!fi) continue;
    const imp = fi.importsByScope.get(`${f}#s0`)?.get(name);
    if (imp) {
      const r = resolveImport(project, fi, imp, seen);
      if (r && r.kind === 'def') return r;
    }
  }
  return null;
}

function enclosingClass(fi: FileIndex, scopeId: string): { id: string } | null {
  let scope = fi.scopes.get(scopeId) ?? null;
  while (scope) {
    if (scope.kind === 'class') return scope;
    scope = scope.parent ? fi.scopes.get(scope.parent) ?? null : null;
  }
  return null;
}

// ---------------------------------------------------------------- 对外用例

export interface DefinitionOutcome {
  locations: Location[];
  reason: 'resolved' | 'external' | 'unresolved' | 'no-symbol';
  symbol: string | null;
  external?: ExternalSource;
  /** reason=unresolved 时的缺失原因（P2）：后端给口径，前端只做文案。 */
  detail?: UnresolvedDetail | null;
}

/** 动态成员的字面形态：`getattr(...)` / `obj[...]` / 名字以 `[` 结尾（P2 / Q1）。 */
function looksDynamicMember(fi: FileIndex, ref: RefRecord): boolean {
  if (ref.name.endsWith('[') || ref.name.includes('[')) return true;
  const text = ref.text ?? '';
  if (/^(?:getattr|setattr|delattr|hasattr)\s*\(/.test(text)) return true;
  if (ref.memberParts?.some((part) => part.includes('[') || part.includes('('))) return true;
  // 源码上下文：紧随该引用之后就是下标访问（`obj[key]` 的 obj）
  try {
    const line = fi.text.lineText(ref.range.end.line);
    return /^\s*\[/.test(line.slice(ref.range.end.col - 1));
  } catch {
    return false;
  }
}

/** 说明符是否是项目内相对路径（相对 → 文件缺失算 module-not-found；裸名 → 项目外的模块）。 */
function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('.') || specifier.startsWith('/');
}

/**
 * 未解析的具体缺失原因（P2 / Q1）。
 * 判定保守：拿不准一律给 `needs-type-info`（宁可说「需要类型信息」，也不瞎猜）。
 */
function unresolvedDetail(project: ProjectIndex, fi: FileIndex, ref: RefRecord): UnresolvedDetail {
  if (looksDynamicMember(fi, ref)) return 'dynamic-member';

  const parts = ref.memberParts;
  const head = parts && parts.length > 1 ? parts[0] : ref.name;
  const binding = importBindingFor(fi, ref.scopeId, head);
  if (binding) {
    const targets = moduleFiles(project, fi, binding);
    if (targets.length) return 'needs-type-info'; // 模块在项目内，成员名解析不到 → 需要类型信息
    return isRelativeSpecifier(binding.module) ? 'module-not-found' : 'not-in-project';
  }

  // 星号导入（`from X import *`）：没有以名字登记的绑定，名字来自 *
  const star = starImportFor(fi, ref.scopeId);
  if (star) {
    const targets = moduleFiles(project, fi, star);
    if (!targets.length) {
      return isRelativeSpecifier(star.module) ? 'module-not-found' : 'not-in-project';
    }
  }

  // 其余情况（成员访问但首段不是导入、纯名字）：需要类型信息才能继续
  return 'needs-type-info';
}

/** 从引用的作用域链上找该名字的导入绑定（与 resolveName 同一套可见性规则）。 */
function importBindingFor(fi: FileIndex, scopeId: string, name: string): ImportRecord | null {
  let scope = fi.scopes.get(scopeId) ?? null;
  while (scope) {
    const imp = fi.importsByScope.get(scope.id)?.get(name);
    if (imp) return imp;
    scope = scope.parent ? fi.scopes.get(scope.parent) ?? null : null;
  }
  return null;
}

/** 作用域链上可见的星号导入。 */
function starImportFor(fi: FileIndex, scopeId: string): ImportRecord | null {
  let scope = fi.scopes.get(scopeId) ?? null;
  while (scope) {
    const imp = fi.importsByScope.get(scope.id)?.get('*');
    if (imp) return imp;
    scope = scope.parent ? fi.scopes.get(scope.parent) ?? null : null;
  }
  return null;
}

/**
 * 外部依赖的来源（03-navigator Q1）：把绑定名回指到本文件的 import 记录，
 * 让用户能从「没跳转」继续走到「它是在哪里引入的」。
 * 语言内置符号（如 `print`）没有 import 记录，只返回空模块名。
 */
function externalSource(fi: FileIndex, ref: RefRecord): ExternalSource {
  const binding = ref.memberParts?.[0] ?? ref.name;
  if (!SELF_NAMES.has(binding)) {
    let scope = fi.scopes.get(ref.scopeId) ?? null;
    while (scope) {
      const imp = fi.importsByScope.get(scope.id)?.get(binding);
      if (imp) {
        return { module: imp.module, importLocation: { file: fi.file, range: imp.range } };
      }
      scope = scope.parent ? fi.scopes.get(scope.parent) ?? null : null;
    }
  }
  return { module: '' };
}

export function gotoDefinition(
  project: ProjectIndex,
  file: string,
  line: number,
  col: number,
): DefinitionOutcome {
  const fi = project.files.get(file);
  if (!fi) return { locations: [], reason: 'no-symbol', symbol: null };
  const pos = { line, col };
  const def = defAt(fi, pos);
  if (def) {
    return { locations: [{ file, range: def.nameRange }], reason: 'resolved', symbol: def.name };
  }
  const ref = refAt(fi, pos);
  if (!ref) return { locations: [], reason: 'no-symbol', symbol: null };
  const resolved = resolveRef(project, fi, ref);
  if (!resolved) {
    const spec = specById(fi.lang);
    if (spec?.builtins?.has(ref.name)) {
      return {
        locations: [],
        reason: 'external',
        symbol: ref.name,
        external: externalSource(fi, ref),
      };
    }
    return {
      locations: [],
      reason: 'unresolved',
      symbol: ref.name,
      detail: unresolvedDetail(project, fi, ref),
    };
  }
  if (resolved.kind === 'external') {
    return { locations: [], reason: 'external', symbol: ref.name, external: externalSource(fi, ref) };
  }
  if (resolved.kind === 'module') {
    return {
      locations: [{ file: resolved.file, range: { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } } }],
      reason: 'resolved',
      symbol: ref.name,
    };
  }
  return { locations: [{ file: resolved.file, range: resolved.def.nameRange }], reason: 'resolved', symbol: ref.name };
}

export interface ReferenceOutcome {
  locations: ReferenceLocation[];
  reason: 'resolved' | 'external' | 'unresolved' | 'no-symbol';
  symbol: string | null;
  declaration?: Location | null;
}

export interface ReferenceEntry {
  file: string;
  range: Range;
  kind: 'ref' | 'import';
  ref?: RefRecord;
  imp?: ImportRecord;
}

/**
 * 指向某个定义的全部引用条目（N4/N16 共用一份口径）。
 * 含别名导入（`from util import helper as hp`）的调用点；调用方可据此用 defAt 求最内层定义。
 */
export function collectReferences(project: ProjectIndex, targetDef: DefRecord): ReferenceEntry[] {
  const out: ReferenceEntry[] = [];
  const seen = new Set<string>();
  const push = (entry: ReferenceEntry) => {
    const key = `${entry.file}:${entry.range.start.line}:${entry.range.start.col}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };

  const candidateNames = new Set([targetDef.name]);
  for (const [localName, entries] of project.importsByName) {
    if (localName === targetDef.name) continue;
    if (entries.some((e) => e.imp.importedName === targetDef.name)) candidateNames.add(localName);
  }

  for (const name of candidateNames) {
    for (const entry of project.refsByName.get(name) ?? []) {
      const cfi = project.files.get(entry.file);
      if (!cfi) continue;
      const resolved = resolveRef(project, cfi, entry.ref);
      if (resolved && resolved.kind === 'def' && resolved.def.id === targetDef.id) {
        push({ file: entry.file, range: entry.ref.range, kind: 'ref', ref: entry.ref });
      }
    }
    for (const entry of project.importsByName.get(name) ?? []) {
      const cfi = project.files.get(entry.file);
      if (!cfi) continue;
      const resolved = resolveImport(project, cfi, entry.imp);
      if (resolved && resolved.kind === 'def' && resolved.def.id === targetDef.id) {
        push({ file: entry.file, range: entry.imp.range, kind: 'import', imp: entry.imp });
      }
    }
  }
  out.sort((a, b) =>
    a.file === b.file ? a.range.start.line - b.range.start.line : a.file.localeCompare(b.file),
  );
  return out;
}

export function findReferences(
  project: ProjectIndex,
  file: string,
  line: number,
  col: number,
  includeDeclaration = false,
): ReferenceOutcome {
  const fi = project.files.get(file);
  if (!fi) return { locations: [], reason: 'no-symbol', symbol: null };
  const pos = { line, col };
  let targetDef: DefRecord | null = defAt(fi, pos);
  let symbol = targetDef?.name ?? null;
  if (!targetDef) {
    const ref = refAt(fi, pos);
    if (!ref) return { locations: [], reason: 'no-symbol', symbol: null };
    symbol = ref.name;
    const resolved = resolveRef(project, fi, ref);
    if (!resolved) return { locations: [], reason: 'unresolved', symbol };
    if (resolved.kind !== 'def') {
      return { locations: [], reason: resolved.kind === 'external' ? 'external' : 'unresolved', symbol };
    }
    targetDef = resolved.def;
  }

  const out: Location[] = [];

  if (includeDeclaration) out.push({ file: targetDef.file, range: targetDef.nameRange });
  for (const entry of collectReferences(project, targetDef)) {
    out.push({ file: entry.file, range: entry.range });
  }

  out.sort((a, b) =>
    a.file === b.file ? a.range.start.line - b.range.start.line : a.file.localeCompare(b.file),
  );
  // isTest 由 API 层标注（避免 resolver ↔ insight 循环依赖），这里先占位为 false
  return {
    locations: out.map((loc) => ({ ...loc, isTest: false })),
    reason: 'resolved',
    symbol,
    declaration: { file: targetDef.file, range: targetDef.nameRange },
  };
}

export function documentSymbols(project: ProjectIndex, file: string): SymbolInfo[] {
  const fi = project.files.get(file);
  if (!fi) return [];
  const ownerByScope = new Map<string, DefRecord>();
  for (const def of fi.definitions) {
    if (def.bodyScopeId) ownerByScope.set(def.bodyScopeId, def);
  }
  const roots: SymbolInfo[] = [];
  const childrenOf = new Map<string, SymbolInfo[]>();
  const defIdOf = new Map<SymbolInfo, string>();
  for (const def of fi.definitions) {
    if (def.kind === 'parameter') continue;
    const info: SymbolInfo = {
      name: def.name,
      kind: def.kind,
      location: { file, range: def.nameRange },
      range: def.range,
      containerName: def.containerName,
      detail: def.detail,
    };
    defIdOf.set(info, def.id);
    const scope = fi.scopes.get(def.scopeId);
    let parent: DefRecord | null = null;
    let cursor = scope && scope.kind !== 'file' ? scope : null;
    while (cursor) {
      const owner = ownerByScope.get(cursor.id);
      if (owner && owner.id !== def.id) {
        parent = owner;
        break;
      }
      cursor = cursor.parent ? fi.scopes.get(cursor.parent) ?? null : null;
    }
    if (parent) {
      const list = childrenOf.get(parent.id);
      if (list) list.push(info);
      else childrenOf.set(parent.id, [info]);
    } else {
      roots.push(info);
    }
  }
  const attach = (infos: SymbolInfo[]): SymbolInfo[] => {
    infos.sort((a, b) =>
      a.location.range.start.line === b.location.range.start.line
        ? a.location.range.start.col - b.location.range.start.col
        : a.location.range.start.line - b.location.range.start.line,
    );
    for (const info of infos) {
      const kids = childrenOf.get(defIdOf.get(info) ?? '');
      if (kids) info.children = attach(kids);
    }
    return infos;
  };
  return attach(roots);
}

export function workspaceSymbols(
  project: ProjectIndex,
  query: string,
  kind: string | null,
  limit = 100,
): SymbolInfo[] {
  const scored: Array<{ score: number; info: SymbolInfo }> = [];
  for (const [name, defs] of project.defsByName) {
    const score = fuzzyScore(name, query);
    if (score <= 0) continue;
    for (const def of defs) {
      if (def.local) continue;
      if (kind && kind !== 'any' && def.kind !== kind) continue;
      scored.push({
        score,
        info: {
          name,
          kind: def.kind,
          location: { file: def.file, range: def.nameRange },
          range: def.range,
          containerName: def.containerName,
          detail: def.detail,
        },
      });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.info.name.length - b.info.name.length);
  return scored.slice(0, Math.max(1, Math.min(limit, 500))).map((s) => s.info);
}

// ------------------------------------------------------------ 语义着色

/** 0 = 本项目符号（提亮）；1 = 外部依赖 / 标准库符号（略暗）；2 = 局部变量 / 参数（次亮）。 */
export type HighlightKind = 0 | 1 | 2;

/**
 * 值得「提亮」的符号：项目里的模块级 / 类级定义（函数、类、方法、属性、常量）。
 * 局部变量与参数降一档（local），它们密度最高，压过这一档会淹没「哪里是外部依赖」这个信号。
 */
const isEmphasizable = (def: DefRecord): boolean => !def.local && def.kind !== 'parameter';

/**
 * 逐符号判定「本项目 / 外部 / 局部」，返回扁平数组，每 4 个一组
 * `[line(1-based), col(1-based), length(UTF-16), kind]`，按位置升序。
 *
 * 三档口径：
 * - project：项目内的顶层/类级定义，以及能解析到它们的引用（最亮）
 * - local：局部变量、参数，以及解析不出的普通名字（次亮，比默认语法色稍亮）
 * - external：外部依赖（第三方包、标准库、node_modules…）与语言内置（print / System…）（略暗）
 *
 * 不标注的：`self` / `this` 这类语法成分，以及需要类型推断的成员访问（`obj.method` 的 method）。
 */
export function highlightSpans(project: ProjectIndex, file: string): number[] {
  const fi = project.files.get(file);
  if (!fi) return [];

  const cached = project.highlightCache.get(file);
  if (cached && cached.revision === project.indexVersion) return cached.data;

  const spans: Array<[number, number, number, HighlightKind]> = [];
  const add = (range: { start: Position; end: Position }, kind: HighlightKind) => {
    if (range.start.line !== range.end.line) return; // 只着色单行内的名字
    const length = range.end.col - range.start.col;
    if (length > 0) spans.push([range.start.line, range.start.col, length, kind]);
  };

  for (const def of fi.definitions) {
    add(def.nameRange, isEmphasizable(def) ? 0 : 2);
  }

  const builtins = specById(fi.lang)?.builtins;
  for (const ref of fi.references) {
    if (SELF_NAMES.has(ref.name)) continue; // self / this 这类语法成分保持原色
    const resolved = resolveRef(project, fi, ref);
    if (!resolved) {
      // 解析不出：确定是语言内置就压暗；普通的单个名字按局部档；成员访问（obj.method）保持原色
      if (builtins?.has(ref.name)) add(ref.range, 1);
      else if (ref.kind === 'identifier') add(ref.range, 2);
      continue;
    }
    if (resolved.kind === 'external') add(ref.range, 1);
    else if (resolved.kind === 'module') add(ref.range, 0);
    else add(ref.range, isEmphasizable(resolved.def) ? 0 : 2);
  }

  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const data: number[] = [];
  let prevLine = 0;
  let prevEnd = 0;
  for (const [line, col, length, kind] of spans) {
    if (line === prevLine && col < prevEnd) continue; // 同位置重叠只保留一个
    data.push(line, col, length, kind);
    prevLine = line;
    prevEnd = col + length;
  }
  project.highlightCache.set(file, { revision: project.indexVersion, data });
  return data;
}

/** 0 = 不匹配；越大越贴近（精确 > 前缀 > 子串 > 词边界缩写子序列）。大小写不敏感。 */
export function fuzzyScore(rawName: string, rawQuery: string): number {
  const query = rawQuery.toLowerCase();
  const name = rawName.toLowerCase();
  if (!query) return 1;
  if (name === query) return 1000;
  if (name.startsWith(query)) return 800 - name.length;
  const idx = name.indexOf(query);
  if (idx >= 0) return 600 - idx - name.length * 0.1;
  // 缩写匹配（如 "hu" 命中 "handle_user"）：每个查询字符都要落在词边界上
  if (query.length < 2) return 0;
  const set = new Set<number>([0]);
  for (let i = 1; i < rawName.length; i++) {
    const prev = rawName[i - 1];
    const cur = rawName[i];
    if (cur === '_' || cur === '-' || cur === '.') set.add(i + 1);
    else if (prev === '_' || prev === '-' || prev === '.') set.add(i);
    else if (prev >= 'a' && prev <= 'z' && cur >= 'A' && cur <= 'Z') set.add(i);
  }
  let qi = 0;
  for (let i = 0; i < name.length && qi < query.length; i++) {
    if (set.has(i) && name[i] === query[qi]) qi++;
  }
  if (qi === query.length) return 250 - name.length * 0.1;
  return 0;
}

// ---------------------------------------------------------------- 透镜（悬停）

const EXTERNAL_MESSAGE = '标准库 / 第三方包，不在项目索引内';
const UNRESOLVED_MESSAGE = '未找到定义：可能是运行时注入或未索引文件';
const INDEXING_MESSAGE = '索引进行中，符号信息稍后可查';

const externalResult = (symbol: string | null): HoverResult => ({
  reason: 'external',
  symbol,
  message: EXTERNAL_MESSAGE,
});

const unresolvedResult = (symbol: string | null): HoverResult => ({
  reason: 'unresolved',
  symbol,
  message: UNRESOLVED_MESSAGE,
});

/** L3e 的引用处数缓存（定义 id → 计数，按索引版本失效）。 */
const refCountCache = new WeakMap<ProjectIndex, Map<string, { revision: number; count: number }>>();

function refCountOf(project: ProjectIndex, def: DefRecord): number {
  let cache = refCountCache.get(project);
  if (!cache) {
    cache = new Map();
    refCountCache.set(project, cache);
  }
  const hit = cache.get(def.id);
  if (hit && hit.revision === project.indexVersion) return hit.count;
  const count = findReferences(
    project,
    def.file,
    def.nameRange.start.line,
    def.nameRange.start.col,
    false,
  ).locations.length;
  cache.set(def.id, { revision: project.indexVersion, count });
  return count;
}

/** L6 的「同值出现处数」缓存（字面量原文 → 全项目计数）。 */
const sameValueCache = new WeakMap<ProjectIndex, { revision: number; counts: Map<string, number> }>();

function sameValueCount(project: ProjectIndex, text: string): number {
  let cache = sameValueCache.get(project);
  if (!cache || cache.revision !== project.indexVersion) {
    const counts = new Map<string, number>();
    for (const fi of project.files.values()) {
      for (const lit of fi.literals) counts.set(lit.text, (counts.get(lit.text) ?? 0) + 1);
    }
    cache = { revision: project.indexVersion, counts };
    sameValueCache.set(project, cache);
  }
  return cache.counts.get(text) ?? 0;
}

/** 范围大小（行数为主、列为辅），用于「同一位置被多个实体覆盖时取最具体者」。 */
const spanOf = (r: Range): number =>
  (r.end.line - r.start.line) * 10_000 + (r.end.col - r.start.col);

/**
 * 命中光标位置的字面量（L6）。
 * 同一位置可能被多个字面量覆盖（如 `f"{cfg['k']}"` 里外层模板串套着内层键串），
 * 取**范围最小**的那个——最具体的一层才是用户指着的东西。
 */
function literalAt(fi: FileIndex, pos: Position): LitRecord | null {
  let best: LitRecord | null = null;
  let bestSpan = Infinity;
  for (const lit of fi.literals) {
    if (!contains(lit.range, pos)) continue;
    const span = spanOf(lit.range);
    if (span < bestSpan) {
      best = lit;
      bestSpan = span;
    }
  }
  return best;
}

/** 一条定义 → 悬停卡片的一条 definition（L3 + L4 + L5 + L7）。 */
function toHoverDefinition(
  project: ProjectIndex,
  def: DefRecord,
  withRefCount = true,
): HoverDefinition {
  const out: HoverDefinition = {
    name: def.name,
    kind: def.kind,
    containerName: def.containerName,
    signature: def.detail,
    location: { file: def.file, range: def.nameRange },
    local: def.local,
  };
  if (def.decorators?.length) out.decorators = [...def.decorators];
  if (def.doc?.length) out.doc = [...def.doc];
  const lang = project.files.get(def.file)?.lang;
  const types = lang ? signatureTypes(def.detail, lang) : [];
  if (types.length) out.types = types;
  if (withRefCount) out.refCount = refCountOf(project, def);
  return out;
}

/** 同名多定义时的最简条目（不带 refCount，避免逐个重算）。 */
function simpleDefinition(def: DefRecord): HoverDefinition {
  return {
    name: def.name,
    kind: def.kind,
    containerName: def.containerName,
    location: { file: def.file, range: def.nameRange },
  };
}

/** 去掉字符串字面量的引号与前缀（r"" / f"" / 三引号）。 */
function unquote(text: string): string {
  const m = /^[A-Za-z]*("""|'''|"|'|`)([\s\S]*)\1$/.exec(text);
  return m ? m[2] : text;
}

/** 项目内模块文件 → 一条可跳转的模块条目。 */
function moduleResult(name: string, file: string): HoverResult {
  return {
    reason: 'resolved',
    symbol: name,
    definitions: [
      {
        name,
        kind: 'module',
        containerName: null,
        signature: null,
        location: { file, range: { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } } },
      },
    ],
    message: null,
  };
}

/**
 * 光标处若是同一行内的字符串字面量，返回其内容（引号已去）。
 * 不依赖字面量索引（`import` 语句里的路径字符串未走通用遍历）。
 */
function stringTokenAt(fi: FileIndex, pos: Position): string | null {
  const line = fi.text.lineText(pos.line);
  const at = pos.col - 1;
  if (at < 0 || at > line.length) return null;
  let start = -1;
  let quote = '';
  for (let i = at; i >= 0; i--) {
    const ch = line[i];
    if ((ch === '"' || ch === "'" || ch === '`') && line[i - 1] !== '\\') {
      start = i;
      quote = ch;
      break;
    }
  }
  if (start < 0) return null;
  for (let i = start + 1; i < line.length; i++) {
    if (line[i] === quote && line[i - 1] !== '\\') return line.slice(start + 1, i);
  }
  return null;
}

/**
 * 导入语句里的路径字符串（§3.3）：字符串若是导入路径，优先显示它的「引用」角色。
 * 解析不到项目内文件（第三方包）时返回 null，交回普通字面量处理，不硬编来源。
 */
function importPathAt(project: ProjectIndex, fi: FileIndex, pos: Position): HoverResult | null {
  const mod = stringTokenAt(fi, pos);
  if (mod === null) return null;
  const imp = fi.imports.find((i) => i.module === mod || i.module === unquote(mod));
  if (!imp) return null;
  // 字符串代表整个模块：给模块文件本身，而不是碰巧被 named 导入命中的某个符号
  const targets = moduleFiles(project, fi, imp);
  if (!targets.length) {
    // 裸说明符（node:fs / fmt）就是外部依赖；相对路径解析不到则是未解析
    return /^[./]/.test(mod) ? unresolvedResult(mod) : externalResult(mod);
  }
  const target = targets[0];
  const file = target.endsWith('/')
    ? [...project.files.keys()].find((f) => f.startsWith(target)) ?? null
    : target;
  return file ? moduleResult(mod, file) : null;
}

/** 导入语句里的绑定名（`import os` / `from util import helper` 的本地名）。 */
function hoverImport(project: ProjectIndex, fi: FileIndex, imp: ImportRecord): HoverResult {
  const resolved = resolveImport(project, fi, imp);
  if (resolved?.kind === 'def') {
    return {
      reason: 'resolved',
      symbol: imp.localName,
      definitions: [toHoverDefinition(project, resolved.def)],
      message: null,
    };
  }
  if (resolved?.kind === 'module') return moduleResult(imp.localName, resolved.file);
  if (resolved?.kind === 'external') return externalResult(imp.localName);
  return unresolvedResult(imp.localName);
}

function hoverLiteral(project: ProjectIndex, fi: FileIndex, lit: LitRecord): HoverResult {
  const bound = lit.boundDefId ? fi.definitions.find((d) => d.id === lit.boundDefId) ?? null : null;
  const literal: HoverLiteral = {
    text: lit.text,
    kind: lit.kind,
    boundTo: null,
    sameValueCount: sameValueCount(project, lit.text),
  };
  // 下标键（L6）：只陈述「被当作哪个对象的键」，没有可靠的键定义位置，因此不给跳转
  if (lit.keyOf) literal.keyOf = lit.keyOf;
  if (!bound) {
    return { reason: 'literal', symbol: null, literal, message: '字面量，无关联定义' };
  }
  literal.boundTo = {
    name: bound.name,
    kind: bound.kind,
    location: { file: bound.file, range: bound.nameRange },
  };
  literal.refCount = refCountOf(project, bound);
  return { reason: 'literal', symbol: null, literal, message: null };
}

function hoverRef(project: ProjectIndex, fi: FileIndex, ref: RefRecord): HoverResult {
  const resolved = resolveRef(project, fi, ref);
  if (resolved?.kind === 'def') {
    return {
      reason: 'resolved',
      symbol: ref.name,
      definitions: [toHoverDefinition(project, resolved.def)],
      message: null,
    };
  }
  if (resolved?.kind === 'module') {
    // 导入的是项目内的一个模块文件：给一条可跳转的模块条目
    return {
      reason: 'resolved',
      symbol: ref.name,
      definitions: [
        {
          name: ref.name,
          kind: 'module',
          containerName: null,
          signature: null,
          location: { file: resolved.file, range: { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } } },
        },
      ],
      message: null,
    };
  }
  if (resolved?.kind === 'external') return externalResult(ref.name);

  const builtins = specById(fi.lang)?.builtins;
  if (ref.kind === 'member' && ref.memberParts?.length) {
    const head = ref.memberParts[0];
    // self / this 这类语法成分不是「可跳转的对象本身」，不作为链头
    if (!SELF_NAMES.has(head)) {
      const headResolved = resolveName(project, fi.file, head, ref.scopeId);
      if (headResolved?.kind === 'def') {
        return {
          reason: 'infer-needed',
          symbol: ref.name,
          definitions: [toHoverDefinition(project, headResolved.def, false)],
          message: `无法确定 ${head} 的类型，暂不能定位定义`,
        };
      }
      if (headResolved?.kind === 'external' || builtins?.has(head)) {
        return externalResult(ref.name);
      }
    }
    return unresolvedResult(ref.name);
  }

  if (builtins?.has(ref.name)) return externalResult(ref.name);
  const candidates = project.defsByName.get(ref.name) ?? [];
  if (candidates.length > 1) {
    return {
      reason: 'unresolved',
      symbol: ref.name,
      definitions: candidates.map(simpleDefinition),
      message: `未能确定唯一目标；同名定义 ${candidates.length} 处`,
    };
  }
  return unresolvedResult(ref.name);
}

/**
 * 悬停解释（02-lens）：只读地说明光标处是什么 —— 定义 / 字面量 / 失败态。
 * 不做类型推断，不返回索引里没有的事实。
 */
export function hover(project: ProjectIndex, file: string, line: number, col: number): HoverResult {
  const fi = project.files.get(file);
  if (!fi) {
    return project.status.indexing
      ? { reason: 'indexing', symbol: null, message: INDEXING_MESSAGE }
      : { reason: 'no-symbol', symbol: null, message: null };
  }
  const pos = { line, col };

  // 导入路径字符串优先：它回答的是「这个字符串指向哪个模块」这个更具体的问题
  const importPath = importPathAt(project, fi, pos);
  if (importPath) return importPath;

  const def = defAt(fi, pos);
  const lit = literalAt(fi, pos);
  const ref = refAt(fi, pos);

  // 同一位置可能被多个实体覆盖：`f"{cfg['k']} {user.name}"` 里外层模板串套着内层键串与变量。
  // 取范围最小的那个（跨度相同则 定义 > 引用 > 字面量）——最具体的一层才是用户指着的对象。
  const candidates: Array<{ span: number; rank: number; run: () => HoverResult }> = [];
  if (def) {
    candidates.push({
      span: spanOf(def.nameRange),
      rank: 0,
      run: () => ({
        reason: 'resolved',
        symbol: def.name,
        definitions: [toHoverDefinition(project, def)],
        message: null,
      }),
    });
  }
  if (ref) {
    candidates.push({ span: spanOf(ref.range), rank: 1, run: () => hoverRef(project, fi, ref) });
  }
  if (lit) {
    candidates.push({ span: spanOf(lit.range), rank: 2, run: () => hoverLiteral(project, fi, lit) });
  }
  candidates.sort((a, b) => a.span - b.span || a.rank - b.rank);
  if (candidates.length) return candidates[0].run();

  const imp = fi.imports.find((i) => contains(i.range, pos));
  if (imp) return hoverImport(project, fi, imp);

  return project.status.indexing
    ? { reason: 'indexing', symbol: null, message: INDEXING_MESSAGE }
    : { reason: 'no-symbol', symbol: null, message: null };
}

// ------------------------------------------------------------ 类型 / 签名切分

/** 语言关键字或修饰符，从 Java 签名里剥掉后才能认出返回类型。 */
const JAVA_MODIFIERS = new Set([
  'public', 'private', 'protected', 'static', 'final', 'abstract', 'synchronized',
  'native', 'default', 'strictfp', 'sealed', 'non-sealed',
]);

/** 与 open 处的 `(` 配对的 `)`；引号内的括号不计。 */
function matchParen(line: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote && line[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 按顶层逗号切分（泛型 / 括号 / 数组 / 字符串里的逗号不切）。 */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === quote && text[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(' || ch === '<' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === '>' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth <= 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** 去掉参数默认值（顶层 `=` 之后的部分；`=>` / `==` / `<=` 不算）。 */
function stripDefault(text: string): string {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '<' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === '>' || ch === ']' || ch === '}') depth--;
    else if (ch === '=' && depth === 0) {
      const prev = text[i - 1];
      const next = text[i + 1];
      if (next === '=' || next === '>' || prev === '=' || prev === '!' || prev === '<' || prev === '>') continue;
      return text.slice(0, i);
    }
  }
  return text;
}

/** `id: string` 形态（Python / TS / JS）：只有源码里写了 `:` 才输出。 */
function cleanColonParam(raw: string): string | null {
  let p = stripDefault(raw).trim();
  p = p.replace(/^\.{3}/, '').replace(/^\*{1,2}/, '').trim();
  const i = p.indexOf(':');
  if (i <= 0) return null;
  const name = p.slice(0, i).trim();
  const type = p.slice(i + 1).trim();
  if (!name || !type) return null;
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;
  return `${name}: ${type}`;
}

/** `String id` / `a int` 形态（Java / Go）：至少两段才算写了类型。 */
function cleanTypedParam(raw: string): string | null {
  const p = stripDefault(raw)
    .replace(/@[\w.]+(\([^)]*\))?/g, ' ')
    .replace(/\bfinal\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!p) return null;
  return p.includes(' ') ? p : null;
}

/** Python / TS / JS 的「注解式」签名。 */
function colonSignatureTypes(line: string): string[] {
  const open = line.indexOf('(');
  if (open < 0) return [];
  const close = matchParen(line, open);
  if (close < 0) return [];
  const out: string[] = [];
  for (const raw of splitTopLevel(line.slice(open + 1, close))) {
    const p = cleanColonParam(raw);
    if (p) out.push(p);
  }
  const rest = line.slice(close + 1).trim();
  if (rest.startsWith('->')) {
    const m = /^->\s*([^:]+)/.exec(rest);
    if (m) out.push(`→ ${m[1].trim()}`);
  } else if (rest.startsWith(':')) {
    const ret = rest.slice(1).split('{')[0].split('=>')[0].trim();
    if (ret) out.push(`→ ${ret}`);
  } else if (rest.startsWith('=>')) {
    const ret = rest.slice(2).split('{')[0].trim();
    if (ret) out.push(`→ ${ret}`);
  }
  return out;
}

/** Go 的签名：方法要先跳过 receiver 的括号。 */
function goSignatureTypes(line: string): string[] {
  let from = 0;
  if (/^func\s*\(/.test(line)) {
    const recvOpen = line.indexOf('(');
    const recvClose = matchParen(line, recvOpen);
    if (recvClose >= 0) from = recvClose + 1;
  }
  const open = line.indexOf('(', from);
  if (open < 0) return [];
  const close = matchParen(line, open);
  if (close < 0) return [];
  const out: string[] = [];
  for (const raw of splitTopLevel(line.slice(open + 1, close))) {
    const p = cleanTypedParam(raw);
    if (p) out.push(p);
  }
  const ret = line.slice(close + 1).replace(/[:{]\s*$/, '').trim();
  if (ret) out.push(`→ ${ret}`);
  return out;
}

/** Java 的签名：返回类型在参数表之前（方法名前一个词）。 */
function javaSignatureTypes(line: string): string[] {
  const open = line.indexOf('(');
  if (open < 0) return [];
  const close = matchParen(line, open);
  if (close < 0) return [];
  const out: string[] = [];
  for (const raw of splitTopLevel(line.slice(open + 1, close))) {
    const p = cleanTypedParam(raw);
    if (p) out.push(p);
  }
  const head = line.slice(0, open).replace(/@[\w.]+(\([^)]*\))?/g, ' ');
  const cleaned = head
    .split(/\s+/)
    .filter((w) => w && !JAVA_MODIFIERS.has(w))
    .join(' ');
  const m = /([\w$.]+(?:<[^>]*>)?(?:\[\])*)\s+([\w$]+)\s*$/.exec(cleaned);
  if (m && m[1] !== m[2]) out.push(`→ ${m[1]}`);
  return out;
}

/**
 * L5：从声明首行（签名）里切出**源码里已写的**参数类型与返回类型，不做任何推断。
 * 没有注解 / 没有类型就返回空数组。
 */
export function signatureTypes(detail: string | null | undefined, lang: LangId): string[] {
  if (!detail) return [];
  const line = detail.split('\n')[0].trim();
  if (!line) return [];
  // 风格由语言 spec 自述（signatureStyle），不再按 id 分支——插件语言也能带上自己的能力。
  switch (specById(lang)?.signatureStyle) {
    case 'go':
      return goSignatureTypes(line);
    case 'java':
      return javaSignatureTypes(line);
    case 'colon':
      return colonSignatureTypes(line);
    default:
      return [];
  }
}

// ------------------------------------------------------------ 整文件密度（L10）

/** 分段行数：固定 20 行一段（导出便于测试）。 */
export const DENSITY_SEGMENT_SIZE = 20;

/** 行首注释前缀表已下沉到各语言 spec 的 `commentPrefixes`（见 walker.ts 的 LanguageSpec）。 */

/**
 * L10：把整文件压成固定行数分段的统计（代码 / 注释 / 空白占比 + 主要符号名）。
 * 索引未完成也不报错：文件不在索引里时返回空 segments。
 * 行首注释前缀来自语言 spec 的 `commentPrefixes`（缺省当代码行）。
 */
export function fileDensity(project: ProjectIndex, file: string): FileDensity {
  const revision = String(project.indexVersion);
  const fi = project.files.get(file);
  if (!fi) {
    return { file, totalLines: 0, segmentSize: DENSITY_SEGMENT_SIZE, segments: [], revision };
  }

  const totalLines = fi.source.split(/\r?\n/).length;
  const prefixes = specById(fi.lang)?.commentPrefixes ?? [];
  const kinds: Array<'code' | 'comment' | 'blank'> = new Array(totalLines);
  for (let i = 1; i <= totalLines; i++) {
    const text = fi.text.lineText(i).trim();
    if (!text) kinds[i - 1] = 'blank';
    else if (prefixes.some((p) => text.startsWith(p))) kinds[i - 1] = 'comment';
    else kinds[i - 1] = 'code';
  }

  const segments: DensitySegment[] = [];
  for (let startLine = 1; startLine <= totalLines; startLine += DENSITY_SEGMENT_SIZE) {
    const endLine = Math.min(startLine + DENSITY_SEGMENT_SIZE - 1, totalLines);
    const span = endLine - startLine + 1;
    let codeCount = 0;
    let commentCount = 0;
    for (let i = startLine; i <= endLine; i++) {
      if (kinds[i - 1] === 'code') codeCount++;
      else if (kinds[i - 1] === 'comment') commentCount++;
    }
    const code = codeCount / span;
    const comment = commentCount / span;
    const symbols = fi.definitions
      .filter((d) =>
        !d.local &&
        d.kind !== 'parameter' &&
        d.nameRange.start.line >= startLine &&
        d.nameRange.start.line <= endLine,
      )
      .sort((a, b) =>
        a.nameRange.start.line === b.nameRange.start.line
          ? a.nameRange.start.col - b.nameRange.start.col
          : a.nameRange.start.line - b.nameRange.start.line,
      )
      .slice(0, 3)
      .map((d) => d.name);
    segments.push({ startLine, endLine, code, comment, blank: 1 - code - comment, symbols });
  }

  return { file, totalLines, segmentSize: DENSITY_SEGMENT_SIZE, segments, revision };
}
