/**
 * 项目地图（01 Map）的聚合层：把索引里已有的事实算成「一眼看懂」的数据。
 *
 * 三条纪律（对齐 docs/01-map.md §6）：
 * 1) 只陈述索引与文件系统里能确认的事实，不做推断、不做优劣裁决；
 * 2) 所有数字都能反向列出构成（点了能列出具体文件），杜绝不可核对的汇总；
 * 3) 只读 —— 不执行构建、不启动进程。
 */
import type {
  DirDuty,
  DirStat,
  GraphLayer,
  HotMetric,
  LangId,
  LangStat,
  MetricNote,
  OverviewEntry,
  OverviewFile,
  ProjectOverview,
} from '../types';
import { specForFile, specById } from '../languages';
import { parseSource } from './parser';
import type { FileIndex } from './model';
import { basename, dirname } from './paths';
import { moduleFiles, resolveRef } from './resolver';
import type { ProjectIndex } from './store';
import { hostMarksFor } from './timeline';

export type EdgeKind = 'import' | 'ref';

export interface FileFacts {
  file: string;
  lang: LangId;
  size: number;
  lines: number;
  /** 项目级定义数（不含局部变量）。 */
  defs: number;
  /** 该文件里的引用条目数。 */
  refs: number;
  /** 最大嵌套深度（近似）。 */
  nesting: number;
  /** 分支节点数（近似圈复杂度）。 */
  branches: number;
  dir: string;
  base: string;
  test: boolean;
  entry: boolean;
  entryReasons: string[];
  /** 被项目内不同文件引用（去重）的数量。 */
  inDegree: number;
  /** 引用了项目内不同文件（去重）的数量。 */
  outDegree: number;
  /** 指向它的引用/导入条目总数。 */
  inbound: number;
  /** 从它发出的引用/导入条目总数。 */
  outbound: number;
  /** 指向它的**符号引用**条目数（不含 import 语句）。 */
  symbolRefs: number;
  /** 顶层导出（非 local 的顶层定义）数。M11.4。 */
  exports: number;
  /** 最长函数行数 / 平均函数行数。M11.2。 */
  longestFunction: number;
  avgFunction: number;
  /** 独有依赖：唯獨它能提供的符号，其上游文件数。M3.2。 */
  unique: number;
  /** 改动新鲜度 0~1（M3.2「新近度」口径的权重）。 */
  freshness: number;
  mtimeMs: number;
}

export interface EdgeCell {
  import: number;
  ref: number;
}

export interface ProjectMap {
  version: number;
  facts: Map<string, FileFacts>;
  /** from → to → 计数（文件级，已去重）。 */
  edges: Map<string, Map<string, EdgeCell>>;
  /** 文件级环（SCC 大小 > 1），按文件路径排序。 */
  cycles: string[][];
}

// ---------------------------------------------------------------- 缓存

const cache = new WeakMap<ProjectIndex, { version: number; map: ProjectMap }>();

/**
 * 取项目地图。
 * 缓存键是 indexVersion，而它只在整轮索引结束时才自增 —— 所以索引进行中必须**绕过缓存**，
 * 否则会把「索引刚开始时的空地（0 事实）」钉住直到索引结束（表现为地图一直显示假 0），
 * 违反共同约束「索引未完成时给部分地图 + 进度」。
 */
export function projectMap(project: ProjectIndex): ProjectMap {
  const indexing = project.status.indexing;
  const hit = cache.get(project);
  if (!indexing && hit && hit.version === project.indexVersion) return hit.map;
  const map = buildMap(project);
  if (!indexing) cache.set(project, { version: project.indexVersion, map });
  return map;
}

// ---------------------------------------------------------------- 判定

const ENTRY_STEMS = new Set(['main', 'index', 'app', 'cli', 'cmd', 'server', 'start', 'entry', 'manage', 'wsgi', 'asgi', '__main__']);

const TEST_DIR_RE = /(^|\/)(__tests__|tests?|specs?|examples?|samples?|fixtures?|e2e|benchmarks?|demo)(\/|$)/i;
/**
 * 文档 / 配置类扩展名（2026-10-03 收紧）：只留「不是该读完的代码」的那些。
 * shell / sql / css / html / json / yaml / toml 已进符号索引，按代码算，不再归到这里。
 */
const DOC_EXT_RE = /\.(md|markdown|txt|rst|xml|ini|cfg|conf|properties|env|gitignore|editorconfig|npmrc)$/i;
const DOC_BASE_RE = /^(readme|license|licence|changelog|contributing|notice|makefile|dockerfile|procfile)\.?/i;

export function isTestFile(rel: string): boolean {
  if (TEST_DIR_RE.test(rel)) return true;
  const base = basename(rel);
  if (/^test_/i.test(base)) return true;
  if (/[._-](test|spec)s?\.[a-z0-9]+$/i.test(base)) return true;
  return /Tests?\.java$/.test(base);
}

/** 文档 / 配置类文件：不算「没人引用的死代码」。 */
export function isDocOrConfig(rel: string): boolean {
  const base = basename(rel);
  return DOC_EXT_RE.test(base) || DOC_BASE_RE.test(base);
}

/** 改动新鲜度 0~1（M3.2「新近度」口径的权重）。 */
export function freshnessOf(mtimeMs: number, now = Date.now()): number {
  const day = 86_400_000;
  if (mtimeMs >= new Date(now).setHours(0, 0, 0, 0)) return 1;
  if (mtimeMs >= now - 3 * day) return 0.75;
  if (mtimeMs >= now - 7 * day) return 0.5;
  return 0.25;
}

function lineCount(source: string): number {
  if (!source) return 0;
  let n = 1;
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) n++;
  return n;
}

// ---------------------------------------------------------------- 复杂度（近似）

const CONTAINER_TYPES = new Set([
  'if_statement', 'if_expression', 'elif_clause', 'else_clause', 'for_statement', 'for_in_statement',
  'while_statement', 'do_statement', 'switch_statement', 'switch_expression', 'switch_case', 'case_clause',
  'when_entry', 'match_arm', 'catch_clause', 'except_clause', 'try_statement', 'with_statement',
  'lambda', 'arrow_function', 'function_definition', 'function_declaration', 'method_declaration',
]);

const BRANCH_TYPES = new Set([
  'if_statement', 'if_expression', 'elif_clause', 'for_statement', 'for_in_statement', 'while_statement',
  'do_statement', 'switch_case', 'case_clause', 'when_entry', 'match_arm', 'catch_clause', 'except_clause',
  'conditional_expression', 'ternary_expression',
]);

/** 遍历 AST 统计最大嵌套深度与分支数（各语言节点名不同，这里取并集近似）。 */
export function scanComplexity(root: unknown): { nesting: number; branches: number } {
  if (!root || typeof root !== 'object') return { nesting: 0, branches: 0 };
  let nesting = 0;
  let branches = 0;
  const walk = (node: any, depth: number): void => {
    let d = depth;
    const type = node.type as string;
    if (typeof type !== 'string') return;
    if (CONTAINER_TYPES.has(type)) {
      d = depth + 1;
      if (d > nesting) nesting = d;
    }
    if (BRANCH_TYPES.has(type)) branches++;
    if (type === 'binary_expression' || type === 'boolean_operator') {
      const op = node.childForFieldName?.('operator')?.text ?? '';
      if (op === '&&' || op === '||' || op === 'and' || op === 'or') branches++;
    }
    for (const child of node.namedChildren ?? []) walk(child, d);
  };
  walk(root, 0);
  return { nesting, branches };
}

// ---------------------------------------------------------------- 入口候选

function entryReasonsFor(project: ProjectIndex, fi: FileIndex): string[] {
  const reasons: string[] = [];
  const base = basename(fi.file);
  const stem = base.includes('.') ? base.slice(0, base.indexOf('.')).toLowerCase() : base.toLowerCase();
  if (ENTRY_STEMS.has(stem)) reasons.push(`文件名像入口（${base}）`);

  const declared = (project.projectMeta['npm.entries'] ?? '').split('\n').filter(Boolean);
  if (declared.includes(fi.file)) reasons.push('包清单声明的入口');

  const src = fi.source;
  // 入口特征由语言 spec 自述（entryPatterns），不再按 lang 分支——插件语言可自带。
  for (const rule of specById(fi.lang)?.entryPatterns ?? []) {
    if (rule.res.every((re) => re.test(src))) reasons.push(rule.reason);
  }
  return reasons;
}

// ---------------------------------------------------------------- 建图

function edgeTargets(project: ProjectIndex, fi: FileIndex, imp: FileIndex['imports'][number]): string[] {
  const out: string[] = [];
  for (const raw of moduleFiles(project, fi, imp)) {
    if (!raw || raw === './') continue;
    if (raw.endsWith('/')) {
      // 包目录：展开成该目录下的已索引文件
      const prefix = raw.replace(/\/+$/, '');
      for (const rel of project.files.keys()) {
        if (rel === fi.file) continue;
        if (rel.startsWith(`${prefix}/`)) out.push(rel);
      }
      continue;
    }
    if (project.files.has(raw)) out.push(raw);
  }
  return out;
}

function buildMap(project: ProjectIndex): ProjectMap {
  const facts = new Map<string, FileFacts>();
  for (const fi of project.files.values()) {
    const reasons = entryReasonsFor(project, fi);
    // P4：快照恢复后 tree 为空（不落盘 AST）——需要复杂度时按需重解析一次
    const spec = fi.tree ? null : specForFile(fi.file);
    const tree = fi.tree ?? (spec ? parseSource(fi.source, spec) : null);
    const { nesting, branches } = scanComplexity(tree ? (tree as { rootNode?: unknown }).rootNode : null);
    // 函数长度（M11.2）：直接用定义的行范围算，不需要重新遍历 AST
    const fns = fi.definitions.filter(
      (d) => d.kind === 'function' || d.kind === 'method' || d.kind === 'constructor',
    );
    const fnLens = fns.map((d) => Math.max(1, d.range.end.line - d.range.start.line + 1));
    const longestFunction = fnLens.length ? Math.max(...fnLens) : 0;
    const avgFunction = fnLens.length
      ? Math.round((fnLens.reduce((a, b) => a + b, 0) / fnLens.length) * 10) / 10
      : 0;
    facts.set(fi.file, {
      file: fi.file,
      lang: fi.lang,
      size: fi.size,
      lines: lineCount(fi.source),
      defs: fi.definitions.filter((d) => !d.local).length,
      refs: fi.references.length,
      nesting,
      branches,
      dir: dirname(fi.file),
      base: basename(fi.file),
      test: isTestFile(fi.file),
      entry: reasons.length > 0,
      entryReasons: reasons,
      inDegree: 0,
      outDegree: 0,
      inbound: 0,
      outbound: 0,
      symbolRefs: 0,
      exports: fi.definitions.filter((d) => !d.local && d.scopeId === `${fi.file}#s0`).length,
      longestFunction,
      avgFunction,
      unique: 0,
      freshness: freshnessOf(fi.mtimeMs),
      mtimeMs: fi.mtimeMs,
    });
  }

  const edges = new Map<string, Map<string, EdgeCell>>();
  const add = (from: string, to: string, kind: EdgeKind) => {
    if (from === to || !facts.has(from) || !facts.has(to)) return;
    let row = edges.get(from);
    if (!row) {
      row = new Map();
      edges.set(from, row);
    }
    const cell = row.get(to) ?? { import: 0, ref: 0 };
    cell[kind]++;
    row.set(to, cell);
  };

  for (const fi of project.files.values()) {
    for (const imp of fi.imports) {
      for (const target of edgeTargets(project, fi, imp)) add(fi.file, target, 'import');
    }
    for (const ref of fi.references) {
      if (ref.kind === 'import') continue;
      const res = resolveRef(project, fi, ref);
      if (!res || res.kind === 'external') continue;
      const target = res.kind === 'def' ? res.def.file : res.file;
      if (!target || target.endsWith('/') || target === './') continue;
      add(fi.file, target, 'ref');
    }
  }

  for (const [from, row] of edges) {
    const f = facts.get(from);
    if (!f) continue;
    f.outDegree = row.size;
    for (const [to, cell] of row) {
      const t = facts.get(to);
      if (!t) continue;
      const total = cell.import + cell.ref;
      f.outbound += total;
      t.inDegree++;
      t.inbound += total;
      t.symbolRefs += cell.ref;
    }
  }

  // 独有依赖（M3.2）：这个名字在整个项目里只有一处定义，引用它的文件就「离了这个文件不行」
  const uniqueUpstream = new Map<string, Set<string>>();
  for (const [name, defs] of project.defsByName) {
    if (defs.length !== 1) continue;
    const owner = defs[0].file;
    if (!facts.has(owner)) continue;
    let set = uniqueUpstream.get(owner);
    if (!set) {
      set = new Set();
      uniqueUpstream.set(owner, set);
    }
    for (const ref of project.refsByName.get(name) ?? []) {
      if (ref.file !== owner) set.add(ref.file);
    }
  }
  for (const [file, set] of uniqueUpstream) {
    const fact = facts.get(file);
    if (fact) fact.unique = set.size;
  }

  return { version: project.indexVersion, facts, edges, cycles: findCycles([...facts.keys()], edges) };
}

/** Tarjan SCC（迭代版）：找出文件级循环依赖。 */
export function findCycles(nodes: string[], edges: Map<string, Map<string, unknown>>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let counter = 0;

  for (const root of nodes) {
    if (index.has(root)) continue;
    index.set(root, counter);
    low.set(root, counter);
    counter++;
    stack.push(root);
    onStack.add(root);
    const frame: Array<{ v: string; iter: Iterator<string> }> = [
      { v: root, iter: (edges.get(root)?.keys() ?? [][Symbol.iterator]()) as Iterator<string> },
    ];
    while (frame.length) {
      const top = frame[frame.length - 1];
      const next = top.iter.next();
      if (!next.done) {
        const w = next.value;
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter);
          counter++;
          stack.push(w);
          onStack.add(w);
          frame.push({ v: w, iter: (edges.get(w)?.keys() ?? [][Symbol.iterator]()) as Iterator<string> });
        } else if (onStack.has(w)) {
          low.set(top.v, Math.min(low.get(top.v)!, index.get(w)!));
        }
        continue;
      }
      frame.pop();
      const v = top.v;
      if (frame.length) {
        const parent = frame[frame.length - 1].v;
        low.set(parent, Math.min(low.get(parent)!, low.get(v)!));
      }
      if (low.get(v) === index.get(v)) {
        const comp: string[] = [];
        for (;;) {
          const w = stack.pop()!;
          onStack.delete(w);
          comp.push(w);
          if (w === v) break;
        }
        if (comp.length > 1) cycles.push(comp.sort());
      }
    }
  }
  return cycles.sort((a, b) => b.length - a.length);
}

// ---------------------------------------------------------------- 概览

export interface OverviewOptions {
  hot?: HotMetric;
  /** 降噪：测试 / 示例文件既不进榜，它们产生的引用也不计入。默认开。 */
  denoise?: boolean;
  limit?: number;
  /** 是否返回全量文件事实（供「点数字列出构成」）。 */
  files?: boolean;
}

/** 热点口径的中文说明（同时作为「口径必须注明」的一部分）。 */
export const HOT_METRIC_LABEL: Record<HotMetric, string> = {
  files: '被引用文件数（去重）',
  refs: '被引用条目数',
  symbols: '定义的符号被引用数',
  defined: '定义的项目级符号数',
  unique: '独有依赖（仅它能提供的符号，其上游文件数）',
  recent: '新近度（改动越新得分越高）',
};

/** 数字口径表（01-map §4 硬约束①）。 */
export function metricNotes(denoise: boolean): Record<string, MetricNote> {
  const suffix = denoise ? '（已排除测试 / 示例）' : '（含测试 / 示例）';
  const fileNote = (label: string, scope: MetricNote['scope'] = 'file'): MetricNote => ({
    label: `${label}${suffix}`,
    unit: scope === 'byte' ? '字节' : scope === 'line' ? '行' : '个',
    includesTests: !denoise,
    scope,
  });
  return {
    files: fileNote('项目里的文件数', 'file'),
    dirs: fileNote('目录数（含空目录）', 'dir'),
    bytes: fileNote('全部文件字节数', 'byte'),
    lines: fileNote('已索引源码的行数'),
    indexedFiles: fileNote('已进入符号索引的文件数'),
    testFiles: fileNote('测试 / 示例文件数'),
    langs: { ...fileNote('按扩展名归类的文件数'), unit: '文件' },
    recent: { ...fileNote('按文件修改时间分组的文件数'), unit: '文件' },
    hot: { ...fileNote(`热点排序口径：${HOT_METRIC_LABEL.files}`), includesTests: !denoise },
  };
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

/** 去噪后的入度（被不同文件引用数 / 引用条目数 / 符号引用数）。 */
function filteredInbound(map: ProjectMap, denoise: boolean) {
  const byFile = new Map<string, number>();
  const byEntry = new Map<string, number>();
  const bySymbol = new Map<string, number>();
  // 独有依赖也要跟着去噪：上游文件里的测试文件不应抬高「离了它不行」的分数
  const uniqueUp = new Map<string, Set<string>>();
  for (const [from, row] of map.edges) {
    if (denoise && map.facts.get(from)?.test) continue;
    for (const [to, cell] of row) {
      if (denoise && map.facts.get(to)?.test) continue;
      byFile.set(to, (byFile.get(to) ?? 0) + 1);
      byEntry.set(to, (byEntry.get(to) ?? 0) + cell.import + cell.ref);
      bySymbol.set(to, (bySymbol.get(to) ?? 0) + cell.ref);
    }
  }
  // 独有依赖的口径：只要上游文件（去噪后）能引用到它，就算「少了它这个上游就读不到」
  for (const [from, row] of map.edges) {
    if (denoise && map.facts.get(from)?.test) continue;
    for (const to of row.keys()) {
      if (denoise && map.facts.get(to)?.test) continue;
      let set = uniqueUp.get(to);
      if (!set) {
        set = new Set();
        uniqueUp.set(to, set);
      }
      set.add(from);
    }
  }
  return { byFile, byEntry, bySymbol, uniqueUp };
}

function toOverviewFile(
  f: FileFacts,
  deg: { byFile: Map<string, number>; byEntry: Map<string, number>; uniqueUp?: Map<string, Set<string>> },
): OverviewFile {
  return {
    file: f.file,
    lang: f.lang,
    size: f.size,
    lines: f.lines,
    defs: f.defs,
    inDegree: deg.byFile.get(f.file) ?? 0,
    outDegree: f.outDegree,
    inbound: deg.byEntry.get(f.file) ?? 0,
    nesting: f.nesting,
    branches: f.branches,
    dir: f.dir,
    test: f.test,
    exports: f.exports,
    longestFunction: f.longestFunction,
    avgFunction: f.avgFunction,
    uniqueUpstream: deg.uniqueUp?.get(f.file)?.size ?? f.unique,
    freshness: f.freshness,
    mtimeMs: f.mtimeMs,
  };
}

/** 目录级汇总（文件数 / 字节 / 依赖面），按字节降序。 */
export function dirStats(project: ProjectIndex, map: ProjectMap, limit = 12): DirStat[] {
  const acc = new Map<string, DirStat>();
  for (const [rel, info] of project.entries) {
    if (info.dir) continue;
    const dir = dirname(rel);
    let item = acc.get(dir);
    if (!item) {
      item = { dir, files: 0, bytes: 0, inbound: 0, outbound: 0 };
      acc.set(dir, item);
    }
    item.files++;
    item.bytes += info.size;
  }
  const inbound = new Map<string, Set<string>>();
  const outbound = new Map<string, Set<string>>();
  for (const [from, row] of map.edges) {
    const fromDir = dirname(from);
    for (const to of row.keys()) {
      const toDir = dirname(to);
      if (fromDir === toDir) continue;
      if (!inbound.has(toDir)) inbound.set(toDir, new Set());
      inbound.get(toDir)!.add(fromDir);
      if (!outbound.has(fromDir)) outbound.set(fromDir, new Set());
      outbound.get(fromDir)!.add(toDir);
    }
  }
  for (const item of acc.values()) {
    item.inbound = inbound.get(item.dir)?.size ?? 0;
    item.outbound = outbound.get(item.dir)?.size ?? 0;
  }
  return [...acc.values()].sort((a, b) => b.bytes - a.bytes).slice(0, limit);
}

const DOC_NAME_RE = /^(readme|index|__init__|mod|main)\.(md|txt|rst|py|pyi|ts|tsx|js|jsx|rs|go|java)$/i;

/** 目录职责分层（M4.2）：按依赖方向 + 目录名惯例，不宣称「唯一确定」。 */
function layerOfDir(
  dir: string,
  inboundDirs: number,
  outboundDirs: number,
  isTest: boolean,
): { layer: GraphLayer; reason: string } {
  const name = (dir.split('/').pop() ?? dir).toLowerCase();
  const facts = `被 ${inboundDirs} 个目录依赖、依赖 ${outboundDirs} 个目录`;
  if (isTest) return { layer: 'isolated', reason: `${facts}；测试目录不计入层次` };
  if (inboundDirs === 0 && outboundDirs === 0) {
    return { layer: 'isolated', reason: `${facts}（与项目内其它目录无依赖关系）` };
  }
  if (outboundDirs === 0) return { layer: 'infra', reason: `${facts}：只被依赖、不依赖他人` };
  if (inboundDirs === 0) return { layer: 'entry', reason: `${facts}：只依赖他人、不被依赖` };

  const has = (set: string[]) => set.includes(name);
  if (has(['cmd', 'bin', 'cli', 'scripts', 'entry', 'main', 'apps', 'app'])) {
    return { layer: 'entry', reason: `${facts}；目录名像入口（${name}）` };
  }
  if (has(['utils', 'util', 'tools', 'tool', 'common', 'shared', 'helpers', 'helper', 'libs', 'lib', 'core', 'base', 'support'])) {
    return { layer: 'utility', reason: `${facts}；目录名像工具/基础库（${name}）` };
  }
  if (has(['infra', 'infrastructure', 'platform', 'framework', 'db', 'storage', 'store', 'client', 'clients', 'api', 'http', 'net', 'network', 'log', 'logging', 'observability', 'config', 'conf', 'adapter', 'adapters', 'driver', 'middleware'])) {
    return { layer: 'infra', reason: `${facts}；目录名像基础设施/适配层（${name}）` };
  }
  return { layer: 'domain', reason: `${facts}：双向都有的领域层` };
}

/** 从文件头找可截取的原文（注释 / 文档字符串），拿不到就返回 null。 */
function firstCommentLine(source: string): string | null {
  const head = source.split(/\r?\n/).slice(0, 14);
  let inBlock = false;
  for (const raw of head) {
    let line = raw.trim();
    if (!line) continue;
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      line = line.replace(/^\*+/, '').replace(/\*\/.*$/, '').trim();
      if (line && !/^@\w+/.test(line)) return line.slice(0, 120);
      continue;
    }
    if (/^\/\*\*?/.test(line)) {
      inBlock = !line.includes('*/');
      line = line.replace(/^\/\*+/, '').replace(/\*\/.*$/, '').trim();
      if (line && !/^@\w+/.test(line)) return line.slice(0, 120);
      continue;
    }
    if (line.startsWith('//')) {
      const text = line.replace(/^\/\/+/, '').trim();
      if (text) return text.slice(0, 120);
      continue;
    }
    if (line.startsWith('#')) {
      const text = line.replace(/^#+/, '').trim();
      if (text) return text.slice(0, 120);
      continue;
    }
    if (line.startsWith('"""') || line.startsWith("'''")) {
      const text = line.replace(/^["']{3}/, '').replace(/["']{3}.*$/, '').trim();
      if (text) return text.slice(0, 120);
      continue;
    }
    if (/^(import|from|use|package|export|const|let|var|function|class|def|public|private|@)/.test(line)) {
      return null;
    }
  }
  return null;
}

/**
 * 目录职责与分层（M4.2 / M4.3）。
 * M4.3 只用原文截取（README / index / __init__ 的文件头注释），拿不到就给事实句，
 * 绝不生成「这个目录负责 X」这类描述（01-map §6 边界）。
 */
async function dirDuties(project: ProjectIndex, map: ProjectMap): Promise<DirDuty[]> {
  interface Acc {
    files: number;
    bytes: number;
    inDirs: Set<string>;
    outDirs: Set<string>;
    inRefs: number;
    outRefs: number;
    tests: number;
    candidates: string[];
  }
  const acc = new Map<string, Acc>();
  const ensure = (dir: string): Acc => {
    let item = acc.get(dir);
    if (!item) {
      item = { files: 0, bytes: 0, inDirs: new Set(), outDirs: new Set(), inRefs: 0, outRefs: 0, tests: 0, candidates: [] };
      acc.set(dir, item);
    }
    return item;
  };

  for (const [rel, info] of project.entries) {
    if (info.dir) continue;
    const item = ensure(dirname(rel));
    item.files++;
    item.bytes += info.size;
    if (isTestFile(rel)) item.tests++;
    // 职责原文候选：目录自己的 README / 入口文件排前面，其余文件排后面
    if (isDocOrConfig(rel)) item.candidates.push(rel);
    else if (DOC_NAME_RE.test(basename(rel))) item.candidates.push(rel);
    if (isDocOrConfig(rel)) item.candidates.unshift(rel);
  }

  for (const [from, row] of map.edges) {
    const fromDir = dirname(from);
    for (const [to, cell] of row) {
      const toDir = dirname(to);
      if (fromDir === toDir) continue;
      const a = ensure(fromDir);
      a.outDirs.add(toDir);
      a.outRefs += cell.import + cell.ref;
      const b = ensure(toDir);
      b.inDirs.add(fromDir);
      b.inRefs += cell.import + cell.ref;
    }
  }

  const keyFilesOf = (dir: string): string[] =>
    [...map.facts.values()]
      .filter((f) => f.dir === dir)
      .sort((a, b) => b.inDegree - a.inDegree || a.file.localeCompare(b.file))
      .slice(0, 3)
      .map((f) => f.file);

  const out: DirDuty[] = [];
  for (const [dir, item] of acc) {
    if (item.files === 0) continue;
    const { layer, reason } = layerOfDir(dir, item.inDirs.size, item.outDirs.size, item.tests === item.files);

    let duty: string | null = null;
    let dutyFrom: string | null = null;
    for (const cand of item.candidates.slice(0, 6)) {
      const file = await project.readText(cand).catch(() => null);
      if (!file) continue;
      const text = /^readme/i.test(basename(cand)) ? readmeFirstLine(file.text) : firstCommentLine(file.text);
      if (text) {
        duty = text;
        dutyFrom = cand;
        break;
      }
    }
    if (!duty) {
      duty = `${item.files} 个文件、被 ${item.inDirs.size} 个目录依赖、依赖 ${item.outDirs.size} 个目录`;
      dutyFrom = null;
    }

    out.push({
      dir,
      files: item.files,
      bytes: item.bytes,
      layer,
      layerReason: reason,
      duty,
      dutyFrom,
      inboundDirs: [...item.inDirs].sort(),
      outboundDirs: [...item.outDirs].sort(),
      inboundRefs: item.inRefs,
      outboundRefs: item.outRefs,
      keyFiles: keyFilesOf(dir),
    });
  }
  return out.sort((a, b) => b.files - a.files || a.dir.localeCompare(b.dir));
}

/** README 的第一行有内容的原文（跳过标题井号与徽章）。 */
function readmeFirstLine(text: string): string | null {
  for (const raw of text.split(/\r?\n/).slice(0, 30)) {
    const line = raw.replace(/^#+\s*/, '').trim();
    if (!line) continue;
    if (/^[\[!]/.test(line)) continue; // 徽章 / 图片
    return line.slice(0, 120);
  }
  return null;
}

/** 项目概览：身份卡 / 语言分布 / 从哪看起 / 热点 / 孤立 / 指标 / 环 / 最近改动。 */
export async function buildOverview(project: ProjectIndex, options: OverviewOptions = {}): Promise<ProjectOverview> {
  const map = projectMap(project);
  const hotMetric: HotMetric = options.hot ?? 'files';
  const denoise = options.denoise ?? true;
  const limit = clamp(options.limit ?? 12, 3, 50);
  const deg = filteredInbound(map, denoise);
  const facts = [...map.facts.values()];

  const langs = new Map<LangId, LangStat>();
  let indexedLines = 0;
  for (const f of facts) {
    const item = langs.get(f.lang) ?? { lang: f.lang, files: 0, tests: 0, bytes: 0, lines: 0 };
    item.files++;
    if (f.test) item.tests++;
    item.bytes += f.size;
    item.lines += f.lines;
    langs.set(f.lang, item);
    indexedLines += f.lines;
  }

  let totalFiles = 0;
  let totalBytes = 0;
  for (const info of project.entries.values()) {
    if (info.dir) continue;
    totalFiles++;
    totalBytes += info.size;
  }

  // 从哪看起：入口候选（有依据的）在前，热点在后
  // 六档口径（M3.2）：被引用文件数 / 被引用条目数 / 符号被引用数 / 定义数 / 独有依赖 / 新近度
  const scoreOf = (f: FileFacts): number => {
    switch (hotMetric) {
      case 'refs':
        return deg.byEntry.get(f.file) ?? 0;
      case 'symbols':
        return f.symbolRefs;
      case 'defined':
        return f.exports;
      case 'unique':
        return deg.uniqueUp.get(f.file)?.size ?? 0;
      case 'recent':
        // 新近度：新鲜度 × 引用数 —— 光新没人用不算骨架，两者都高才是「最近热的那块」
        return Math.round(f.freshness * 10 * ((deg.byFile.get(f.file) ?? 0) + 1));
      default:
        return deg.byFile.get(f.file) ?? 0;
    }
  };

  const candidates = facts.filter((f) => !(denoise && f.test));
  const hot = candidates
    .map((f) => ({ ...toOverviewFile(f, deg), score: scoreOf(f) }))
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, limit);

  const entries: OverviewEntry[] = [];
  const seen = new Set<string>();
  const push = (f: FileFacts, kind: 'entry' | 'hot') => {
    if (seen.has(f.file)) {
      const item = entries.find((e) => e.file === f.file);
      if (item && kind === 'entry') {
        item.kind = 'entry';
        item.score += 1000;
      }
      return;
    }
    seen.add(f.file);
    const reasons = [...f.entryReasons];
    const inbound = deg.byFile.get(f.file) ?? 0;
    if (inbound > 0) reasons.push(`被 ${inbound} 个文件引用`);
    entries.push({
      file: f.file,
      kind,
      score: (kind === 'entry' ? 1000 : 0) + scoreOf(f),
      reasons,
      inbound,
      lines: f.lines,
    });
  };
  for (const f of candidates.filter((x) => x.entry)) push(f, 'entry');
  for (const f of candidates) push(f, 'hot');
  const fromList = entries
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, Math.max(limit, 12));

  const orphans = candidates
    .filter((f) => (deg.byFile.get(f.file) ?? 0) === 0 && !f.entry && !isDocOrConfig(f.file))
    .map((f) => toOverviewFile(f, deg))
    .sort((a, b) => b.size - a.size);

  const largestFiles = [...facts]
    .sort((a, b) => b.size - a.size)
    .slice(0, 10)
    .map((f) => ({ file: f.file, size: f.size, lines: f.lines, lang: f.lang }));

  const complex = [...facts]
    .filter((f) => f.lines >= 20)
    .sort((a, b) => b.branches - a.branches || b.nesting - a.nesting || b.lines - a.lines)
    .slice(0, 10)
    .map((f) => toOverviewFile(f, deg));

  // 最近改动：按本地日界分组
  const now = Date.now();
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const day = 86_400_000;
  const recent = { today: 0, last3d: 0, last7d: 0, older: 0, newest: [] as Array<{ file: string; mtimeMs: number }> };
  for (const [rel, info] of project.entries) {
    if (info.dir) continue;
    const at = info.mtimeMs;
    if (at >= startOfToday) recent.today++;
    else if (at >= now - 3 * day) recent.last3d++;
    else if (at >= now - 7 * day) recent.last7d++;
    else recent.older++;
    recent.newest.push({ file: rel, mtimeMs: at });
  }
  recent.newest.sort((a, b) => b.mtimeMs - a.mtimeMs);
  recent.newest = recent.newest.slice(0, 8);

  const readme = await readReadme(project);
  const meta = describeMeta(project);
  const dirs = await dirDuties(project, map);

  // 「不阻塞首屏」：把进度与「现在能信什么」一并交给前端，让它显示部分地图而不是空白/假 0
  const st = project.status;
  const partial = {
    indexing: st.indexing,
    filesIndexed: st.filesIndexed,
    filesTotal: st.filesTotal,
    progress: st.progress,
    notes: st.indexing
      ? [
          `索引进行中（${st.filesIndexed}/${st.filesTotal}）：规模与目录树可信，`,
          '语言分布 / 热点榜 / 孤立清单 / 环检测会随后续文件陆续长出来',
        ]
      : [],
  };

  return {
    project: { id: project.id, name: project.name, root: project.root, createdAt: project.createdAt },
    status: { ...st },
    identity: {
      files: totalFiles,
      dirs: project.dirs.size,
      bytes: totalBytes,
      lines: indexedLines,
      indexedFiles: facts.length,
      testFiles: facts.filter((f) => f.test).length,
      langs: [...langs.values()].sort((a, b) => b.files - a.files || b.bytes - a.bytes),
    },
    meta,
    readme,
    entries: fromList,
    hot,
    hotMetric,
    orphans,
    largestFiles,
    largestDirs: dirStats(project, map),
    complex,
    cycles: map.cycles.slice(0, 20).map((c) => c.slice(0, 12)),
    recent,
    dirs,
    partial,
    notes: metricNotes(denoise),
    agentMarks: hostMarksFor(project.id),
    files: options.files ? allFileFacts(project, facts, deg) : undefined,
  };
}

/**
 * `?files=1` 时的文件清单：以「扫到的全部文件」为准，而不是只给已索引的那些。
 * 否则会出现「说 192 个文件、点开只列 191 个」——即文档明令禁止的不可核对汇总。
 * 没进索引的文件用 `indexed:false` 标出来，数字本身仍然可核对。
 */
function allFileFacts(
  project: ProjectIndex,
  facts: FileFacts[],
  deg: { byFile: Map<string, number>; byEntry: Map<string, number>; uniqueUp: Map<string, Set<string>> },
): ProjectOverview['files'] {
  const byFile = new Map(facts.map((f) => [f.file, f]));
  const out: NonNullable<ProjectOverview['files']> = [];
  for (const [rel, info] of project.entries) {
    if (info.dir) continue;
    const fact = byFile.get(rel);
    if (fact) {
      out.push({ ...toOverviewFile(fact, deg), indexed: true });
      continue;
    }
    // 只读了正文 / 没进符号索引的文件（过大 / 无法解析 / 非源码）
    const spec = specForFile(rel);
    out.push({
      file: rel,
      lang: spec ? spec.id : 'plaintext',
      size: info.size,
      lines: 0,
      defs: 0,
      inDegree: 0,
      outDegree: 0,
      inbound: 0,
      nesting: 0,
      branches: 0,
      dir: dirname(rel),
      test: isTestFile(rel),
      exports: 0,
      longestFunction: 0,
      avgFunction: 0,
      uniqueUpstream: 0,
      freshness: freshnessOf(info.mtimeMs),
      mtimeMs: info.mtimeMs,
      indexed: false,
    });
  }
  return out;
}

/** README：只截原文，不做生成式摘要（01-map.md §6）。 */
async function readReadme(project: ProjectIndex): Promise<ProjectOverview['readme']> {
  const candidates = [...project.entries.keys()]
    .filter((rel) => !project.entries.get(rel)?.dir)
    .filter((rel) => /^readme(\.[a-z0-9]+)?$/i.test(basename(rel)))
    .sort((a, b) => {
      const rank = (p: string) => (p.includes('/') ? 1 : 0) + (p.toLowerCase().endsWith('.md') ? 0 : 2);
      return rank(a) - rank(b) || a.length - b.length;
    });
  const pick = candidates[0];
  if (!pick) return null;
  const file = await project.readText(pick).catch(() => null);
  if (!file) return null;
  const LIMIT = 1600;
  const excerpt = file.text.length > LIMIT ? file.text.slice(0, LIMIT) : file.text;
  return { path: pick, excerpt, truncated: file.text.length > LIMIT };
}

const META_KINDS: Array<{ kind: ProjectOverview['meta']['kind']; markers: string[] }> = [
  { kind: 'npm', markers: ['package.json'] },
  { kind: 'go', markers: ['go.mod'] },
  { kind: 'python', markers: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile'] },
  { kind: 'java', markers: ['pom.xml', 'build.gradle'] },
  { kind: 'rust', markers: ['Cargo.toml'] },
];

function describeMeta(project: ProjectIndex): ProjectOverview['meta'] {
  const kind = META_KINDS.find((k) => k.markers.some((m) => project.entries.has(m)))?.kind ?? 'unknown';
  const meta = project.projectMeta;
  return {
    kind,
    name: meta['npm.name'] ?? meta['python.name'] ?? meta['java.artifactId'] ?? meta['rust.name'] ?? null,
    modulePath: meta['go.modulePath'] ?? null,
    scripts: (meta['npm.scripts'] ?? '').split('\n').filter(Boolean),
    declaredEntries: (meta['npm.entries'] ?? '').split('\n').filter(Boolean),
  };
}

/** 供端点复用的文件级事实（依赖图、时间轴等也要）。 */
export function fileFacts(project: ProjectIndex): Map<string, FileFacts> {
  return projectMap(project).facts;
}

/** 文件名启发：路径末段是否像入口（供依赖图等复用）。 */
export function looksLikeEntry(rel: string): boolean {
  const spec = specForFile(rel);
  const base = basename(rel);
  const stem = base.includes('.') ? base.slice(0, base.indexOf('.')).toLowerCase() : base.toLowerCase();
  return ENTRY_STEMS.has(stem) && !!spec;
}
