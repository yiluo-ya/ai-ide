/** tree-sitter 封装：源码 → FileIndex（作用域 / 定义 / 引用 / 导入）。 */
import fs from 'node:fs';
import path from 'node:path';
import Parser from 'tree-sitter';
import { decodeBuffer } from './encoding';
import { SourceText } from './source-text';
import { WalkContext, type LanguageSpec } from './walker';
import type {
  DefRecord,
  FileIndex,
  ImportRecord,
  LitRecord,
  RefRecord,
  ScopeRecord,
  SerializedParsed,
  SourceTextLike,
} from './model';
import type { Range } from '../types';

const parsers = new Map<string, Parser>();

function parserFor(spec: LanguageSpec): Parser {
  const key = String(spec.id);
  let p = parsers.get(key);
  if (!p) {
    p = new Parser();
    p.setLanguage(spec.grammar as never);
    parsers.set(key, p);
  }
  return p;
}

export function parseSource(source: string, spec: LanguageSpec): unknown | null {
  try {
    return parserFor(spec).parse(source);
  } catch {
    return null;
  }
}

export interface IndexOptions {
  /** P11：大文件降级 —— 只保留顶层定义与导入（不记引用 / 字面量 / 嵌套定义）。 */
  topLevelOnly?: boolean;
  /**
   * 解析时间预算（毫秒）。缺省时按文件大小自动算（见 `parseBudgetMs`），
   * 传 `null` 表示不限时（测试 / 排障）。
   */
  budgetMs?: number | null;
}

/** 小于该大小的文件不加限时保护（开销可忽略，且超时只会误伤）。 */
export const PARSE_BUDGET_MIN_BYTES = 64 * 1024;

/**
 * 单文件解析预算：1KB ≈ 1.5ms，下限 1s，上限 10s。
 * 目的是把「解析成本失控」（如超长注释块让 tree-sitter 超线性）挡在索引之外：
 * 超预算的文件不索引、只留正文。
 */
export function parseBudgetMs(size: number): number {
  return Math.min(10_000, 1_000 + Math.round((size / 1024) * 1.5));
}

/** 带截止时间的解析：超预算时 tree-sitter 会提前放弃（返回 null），把 truncated 置真。 */
export function parseSourceBudgeted(
  source: string,
  spec: LanguageSpec,
  budgetMs: number,
): { tree: unknown | null; truncated: boolean } {
  const deadline = Date.now() + Math.max(1, budgetMs);
  let truncated = false;
  try {
    const parser = parserFor(spec) as unknown as {
      parse(
        input: string,
        oldTree: null,
        options?: { progressCallback?: (index: number, hasError: boolean) => boolean },
      ): unknown;
    };
    const tree = parser.parse(source, null, {
      progressCallback: () => {
        if (Date.now() > deadline) {
          truncated = true;
          return true;
        }
        return false;
      },
    });
    if (!tree) return { tree: null, truncated };
    const end = (tree as { rootNode?: { endIndex?: number } }).rootNode?.endIndex;
    if (typeof end === 'number' && end < Buffer.byteLength(source)) truncated = true;
    return { tree, truncated };
  } catch {
    return { tree: null, truncated };
  }
}

export function indexSource(
  relPath: string,
  source: string,
  spec: LanguageSpec,
  stat: { mtimeMs: number; size: number },
  opts: IndexOptions = {},
): FileIndex {
  // 行式格式（Dockerfile / ini / env / conf / SQL）：没有可用语法包，直接按行扫顶层符号
  if (spec.lineSymbols && !spec.grammar) return lineSymbolIndex(relPath, source, spec, stat);

  const text = new SourceText(source);
  const topLevelOnly = opts.topLevelOnly === true;
  const budgetMs =
    opts.budgetMs === null ? null : opts.budgetMs ?? (stat.size >= PARSE_BUDGET_MIN_BYTES ? parseBudgetMs(stat.size) : null);
  const outcome =
    budgetMs === null
      ? { tree: parseSource(source, spec), truncated: false }
      : parseSourceBudgeted(source, spec, budgetMs);
  const tree = outcome.tree;
  let error: string | null = null;
  if (tree && !outcome.truncated) {
    const ctx = new WalkContext(relPath, text, spec, { topLevelOnly });
    try {
      ctx.run((tree as { rootNode: unknown }).rootNode);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    return buildFileIndex(relPath, source, text, spec, stat, ctx, tree, error, topLevelOnly);
  }
  // 解析失败 / 超预算：不索引（只保留正文），原因写进 error 供排障
  const failed = plainFileIndex(
    relPath,
    source,
    spec.id,
    stat,
    outcome.truncated ? `parse budget exceeded (${budgetMs}ms)` : 'parse failed',
  );
  failed.degraded = topLevelOnly ? 'top-level' : null;
  return failed;
}

/** 行式符号的一行说明的长度上限（与 walker 的签名展示同一口径）。 */
const LINE_DETAIL_CHARS = 160;

/**
 * 行式格式索引：只有文件作用域 + 定义（这些格式没有可解析的引用 / 字面量语义）。
 * 定义一律按「顶层」处理（行式扫描本来就是顶层），`range` 取整行、`nameRange` 取名字本身。
 */
function lineSymbolIndex(
  relPath: string,
  source: string,
  spec: LanguageSpec,
  stat: { mtimeMs: number; size: number },
): FileIndex {
  const text = new SourceText(source);
  const lines = source.split(/\r?\n/);
  const fileScopeId = `${relPath}#s0`;
  const definitions: DefRecord[] = [];
  for (const sym of spec.lineSymbols?.(source) ?? []) {
    if (!sym.name) continue;
    const lineText = lines[sym.line - 1] ?? '';
    const nameRange: Range = {
      start: { line: sym.line, col: sym.col },
      end: { line: sym.line, col: sym.endCol ?? sym.col + sym.name.length },
    };
    definitions.push({
      id: `${relPath}!${sym.line}:${sym.col}:${sym.name}`,
      name: sym.name,
      kind: sym.kind,
      file: relPath,
      range: { start: { line: sym.line, col: 1 }, end: { line: sym.line, col: lineText.length + 1 } },
      nameRange,
      scopeId: fileScopeId,
      containerName: null,
      detail: sym.detail ?? (lineText.trim().slice(0, LINE_DETAIL_CHARS) || null),
      local: false,
      bodyScopeId: null,
      doc: null,
    });
  }
  const { defsByScope, importsByScope } = buildScopeMaps(definitions, []);

  // 行式引用（可选，见 LanguageSpec.lineRefs）：关键字后面的对象名 → RefRecord，
  // 于是行式语言（SQL）也能进跳定义 / 查引用 / 语义着色。声明自身的位置不算引用。
  const references: RefRecord[] = [];
  for (const ref of spec.lineRefs?.(source) ?? []) {
    if (!ref.name) continue;
    const endCol = ref.endCol ?? ref.col + ref.name.length;
    const overlapsDecl = definitions.some(
      (d) =>
        d.nameRange.start.line === ref.line &&
        ref.col < d.nameRange.end.col &&
        d.nameRange.start.col < endCol,
    );
    if (overlapsDecl) continue;
    references.push({
      name: ref.name,
      kind: 'identifier',
      file: relPath,
      range: { start: { line: ref.line, col: ref.col }, end: { line: ref.line, col: endCol } },
      scopeId: fileScopeId,
      text: ref.text ?? ref.name,
    });
  }
  const lastLine = lines.length;
  const scopes = new Map<string, ScopeRecord>([
    [
      fileScopeId,
      {
        id: fileScopeId,
        file: relPath,
        parent: null,
        kind: 'file',
        name: null,
        range: {
          start: { line: 1, col: 1 },
          end: { line: lastLine, col: (lines[lastLine - 1]?.length ?? 0) + 1 },
        },
      },
    ],
  ]);
  return makeFileIndex(
    {
      file: relPath,
      lang: spec.id,
      source,
      tree: null,
      scopes,
      definitions,
      references,
      imports: [],
      literals: [],
      defsByScope,
      importsByScope,
      meta: {},
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      indexed: true,
      error: null,
      degraded: null,
    },
    () => text,
  );
}

function buildFileIndex(
  relPath: string,
  source: string,
  text: SourceText,
  spec: LanguageSpec,
  stat: { mtimeMs: number; size: number },
  ctx: WalkContext,
  tree: unknown,
  error: string | null,
  topLevelOnly: boolean,
): FileIndex {
  promoteMethods(ctx.definitions, ctx.scopes);

  const fileScopeId = `${relPath}#s0`;
  // 降级模式：只留文件作用域、顶层定义与顶层导入；引用 / 字面量整体丢弃
  const scopes = topLevelOnly
    ? new Map([...ctx.scopes].filter(([id]) => id === fileScopeId))
    : ctx.scopes;
  const definitions = topLevelOnly
    ? ctx.definitions.filter((d) => d.scopeId === fileScopeId)
    : ctx.definitions;
  const imports = topLevelOnly ? ctx.imports.filter((i) => i.scopeId === fileScopeId) : ctx.imports;
  const references = topLevelOnly ? [] : ctx.references;
  const literals = topLevelOnly ? [] : ctx.literals;

  const { defsByScope, importsByScope } = buildScopeMaps(definitions, imports);

  return {
    file: relPath,
    lang: spec.id,
    source,
    text,
    tree,
    scopes,
    definitions,
    references,
    imports,
    literals,
    defsByScope,
    importsByScope,
    meta: ctx.meta,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    indexed: true,
    error,
    degraded: topLevelOnly ? 'top-level' : null,
  };
}

/** 只读正文、不做符号索引的文件（过大 / 非源码 / 解析失败降级）。 */
export function plainFileIndex(
  relPath: string,
  source: string,
  lang: FileIndex['lang'],
  stat: { mtimeMs: number; size: number },
  error: string | null = null,
): FileIndex {
  return makeFileIndex(
    {
      file: relPath,
      lang,
      source,
      tree: null,
      scopes: new Map(),
      definitions: [],
      references: [],
      imports: [],
      literals: [],
      defsByScope: new Map(),
      importsByScope: new Map(),
      meta: {},
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      indexed: false,
      error,
    },
    () => new SourceText(source),
  );
}

/** FileIndex → 纯数据（worker 跨线程回传用）：丢掉 SourceText 与 AST。 */
export function serializeFileIndex(fi: FileIndex): SerializedParsed {
  return {
    file: fi.file,
    lang: fi.lang,
    scopes: fi.scopes instanceof Map ? [...fi.scopes.values()] : [],
    definitions: fi.definitions,
    references: fi.references,
    imports: fi.imports,
    literals: fi.literals,
    defsByScope: mapOfMapsToPlain(fi.defsByScope),
    importsByScope: mapOfMapsToPlain(fi.importsByScope),
    meta: fi.meta,
    mtimeMs: fi.mtimeMs,
    size: fi.size,
    indexed: fi.indexed,
    error: fi.error ?? null,
    degraded: fi.degraded ?? null,
  };
}

/**
 * 纯数据 → FileIndex（补 `source` / `text` / `tree=null`）：主线程与快照恢复共用。
 * `text` 走懒构造（首次访问才扫全文建行索引）：worker 回传的批量结果不必为每个文件
 * 立刻付一遍 O(行数) 的行索引代价。
 */
export function deserializeFileIndex(data: SerializedParsed, source: string): FileIndex {
  const scopes = new Map<string, ScopeRecord>(data.scopes.map((s) => [s.id, s]));
  const defsByScope = plainToMapOfMaps(data.defsByScope);
  const importsByScope = plainToMapOfMaps(data.importsByScope);
  return makeFileIndex(
    {
      file: data.file,
      lang: data.lang,
      source,
      tree: null,
      scopes,
      definitions: data.definitions,
      references: data.references,
      imports: data.imports,
      literals: data.literals,
      defsByScope,
      importsByScope,
      meta: data.meta,
      mtimeMs: data.mtimeMs,
      size: data.size,
      indexed: data.indexed,
      error: data.error,
      degraded: data.degraded ?? null,
    },
    () => new SourceText(source),
  );
}

/** 快照文件记录里需要的最小字段（`snapshot.ts` 的行记录满足它）。 */
export interface SnapshotParsedData {
  file: string;
  lang: FileIndex['lang'];
  mtimeMs: number;
  size: number;
  indexed?: boolean;
  error?: string | null;
  degraded?: 'top-level' | null;
  /** 旧格式快照 / 单测直接构造的记录里可能带正文；给了 root 时会被忽略（改为按需读盘）。 */
  source?: string;
  meta?: Record<string, string>;
  scopes?: ScopeRecord[];
  definitions?: DefRecord[];
  references?: RefRecord[];
  imports?: ImportRecord[];
  literals?: LitRecord[];
}

/** 懒读正文失败时的回调（P9：store 写进 skipLog）。 */
export type SourceReadErrorHandler = (rel: string, detail: string) => void;

/** 懒读句柄：`read()` 幂等（成功即缓存），`loaded()` 只在成功读到后才为 true。 */
export interface LazySource {
  read(): string;
  loaded(): boolean;
}

/**
 * 快照恢复用的「懒读正文」：快照不落正文（10k 仓库解压后 465MB），首次访问
 * `fi.source` / `fi.text` 时才同步读盘一次，用与索引期同一份 `decodeBuffer()` 解码并缓存。
 *
 * - 读盘失败（文件被删 / 权限）：回 `onReadError`（P9 记 read-error）并返回空串，**不抛**；
 *   失败不写入缓存，下次访问会重试。
 * - `expectedSize` 只用于失败时的诊断信息：大小与快照记录不一致（改了但 watcher 还没处理）
 *   时同样以磁盘内容为准（正确性优先），不据此跳过读盘。
 *
 * 读盘走 `fs.readFileSync` 属性访问（而非命名导入）：「恢复期一次盘都不读」靠测试探针
 * 统计该调用证明，命名导入的绑定在转译后不随 monkey patch 变化。
 */
export function makeLazySource(
  projectRoot: string,
  rel: string,
  expectedSize: number,
  onReadError?: SourceReadErrorHandler,
): LazySource {
  let cached: string | null = null;
  return {
    read(): string {
      if (cached !== null) return cached;
      try {
        const buf = fs.readFileSync(path.posix.join(projectRoot, rel));
        const text = decodeBuffer(buf).text;
        cached = text;
        return text;
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        onReadError?.(rel, `${detail} (expected ${expectedSize}B)`);
        return '';
      }
    },
    loaded(): boolean {
      return cached !== null;
    },
  };
}

export interface SnapshotRestoreOptions {
  /** 项目根：给了就懒读正文（快照瘦身路径）；不给则用记录自带的正文字段（单测 / 旧格式）。 */
  root?: string;
  encoding?: string;
  onReadError?: SourceReadErrorHandler;
}

/**
 * 快照记录 → FileIndex（与 `parser.ts` 的解析口径同一份实现）：
 * `defsByScope` / `importsByScope` 由 definitions / imports 原地重建，
 * `source` / `text` 走懒构造（给了 `opts.root` 时首次访问才读盘）。
 */
export function fileIndexFromSnapshot(data: SnapshotParsedData, opts: SnapshotRestoreOptions = {}): FileIndex {
  const definitions = data.definitions ?? [];
  const imports = data.imports ?? [];
  const { defsByScope, importsByScope } = buildScopeMaps(definitions, imports);
  const reader = opts.root ? makeLazySource(opts.root, data.file, data.size, opts.onReadError) : null;
  const staticSource = data.source ?? '';
  const fi = makeFileIndex(
    {
      file: data.file,
      lang: data.lang,
      source: reader ? '' : staticSource,
      tree: null,
      scopes: new Map<string, ScopeRecord>((data.scopes ?? []).map((s) => [s.id, s])),
      definitions,
      references: data.references ?? [],
      imports,
      literals: data.literals ?? [],
      defsByScope,
      importsByScope,
      meta: data.meta ?? {},
      mtimeMs: data.mtimeMs,
      size: data.size,
      indexed: data.indexed ?? true,
      error: data.error ?? null,
      degraded: data.degraded ?? null,
    },
    () => {
      if (!reader) return new SourceText(staticSource);
      const text = reader.read();
      // 读盘失败时不缓存空正文（下次访问可重试）
      return reader.loaded() ? new SourceText(text) : null;
    },
  );
  if (reader) {
    Object.defineProperty(fi, 'source', {
      configurable: true,
      enumerable: true,
      get: (): string => reader.read(),
    });
  }
  if (opts.encoding) fi.encoding = opts.encoding;
  return fi;
}

/** `definitions` / `imports` → 作用域索引（解析与快照恢复共用同一口径）。 */
export function buildScopeMaps(
  definitions: DefRecord[],
  imports: ImportRecord[],
): { defsByScope: Map<string, Map<string, DefRecord[]>>; importsByScope: Map<string, Map<string, ImportRecord>> } {
  const defsByScope = new Map<string, Map<string, DefRecord[]>>();
  for (const def of definitions) {
    let map = defsByScope.get(def.scopeId);
    if (!map) {
      map = new Map();
      defsByScope.set(def.scopeId, map);
    }
    const list = map.get(def.name);
    if (list) list.push(def);
    else map.set(def.name, [def]);
  }

  const importsByScope = new Map<string, Map<string, ImportRecord>>();
  for (const imp of imports) {
    let map = importsByScope.get(imp.scopeId);
    if (!map) {
      map = new Map();
      importsByScope.set(imp.scopeId, map);
    }
    if (!map.has(imp.localName)) map.set(imp.localName, imp);
  }

  return { defsByScope, importsByScope };
}

/** 空正文的替身：懒读失败时临时返回（不进缓存）。 */
const EMPTY_TEXT = new SourceText('');

/**
 * 组装 FileIndex 并挂上懒构造的 `text`（`text` 的读取方无感知）。
 * `makeText` 返回 null 表示「暂时拿不到」（如懒读失败）：此时不缓存，下次访问重试。
 */
function makeFileIndex(base: Omit<FileIndex, 'text'>, makeText: () => SourceTextLike | null): FileIndex {
  const fi = { ...base, text: null as unknown as SourceTextLike };
  let cached: SourceTextLike | null = null;
  Object.defineProperty(fi, 'text', {
    configurable: true,
    enumerable: true,
    get(): SourceTextLike {
      if (cached) return cached;
      const made = makeText();
      if (made) cached = made;
      return made ?? EMPTY_TEXT;
    },
    set(value: SourceTextLike) {
      cached = value;
    },
  });
  return fi;
}

function mapOfMapsToPlain<T>(source: Map<string, Map<string, T>>): Record<string, Record<string, T>> {
  const out: Record<string, Record<string, T>> = {};
  for (const [scope, map] of source) {
    const inner: Record<string, T> = {};
    for (const [name, value] of map) inner[name] = value;
    out[scope] = inner;
  }
  return out;
}

function plainToMapOfMaps<T>(source: Record<string, Record<string, T>> | undefined): Map<string, Map<string, T>> {
  const out = new Map<string, Map<string, T>>();
  for (const [scope, inner] of Object.entries(source ?? {})) {
    const map = new Map<string, T>();
    for (const [name, value] of Object.entries(inner)) map.set(name, value);
    out.set(scope, map);
  }
  return out;
}

/** 方法定义（定义在类体内）从 function 提升为 method，便于大纲展示。 */
function promoteMethods(definitions: DefRecord[], scopes: Map<string, ScopeRecord>) {
  for (const def of definitions) {
    if (def.kind !== 'function' && def.kind !== 'method') continue;
    let scope = scopes.get(def.scopeId) ?? null;
    while (scope) {
      if (scope.kind === 'block' || scope.kind === 'namespace') {
        scope = scope.parent ? scopes.get(scope.parent) ?? null : null;
        continue;
      }
      if (scope.kind === 'class') {
        def.kind = def.name === 'constructor' ? 'constructor' : 'method';
      }
      break;
    }
  }
}
