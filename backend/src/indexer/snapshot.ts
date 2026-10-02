/**
 * 索引快照（P4 / Q7 / Q8）：`<DATA_DIR>/index/<projectId>/snapshot.ndjson.gz`。
 *
 * 为什么是 NDJSON + gzip 流，而不是单个 JSON：万级文件快照的正文总量会超过 V8 的
 * 单字符串上限（约 512MB），`JSON.stringify(整个快照)` 直接抛 `Invalid string length`，
 * 快照根本写不出去（bench 10k 实测）。这里逐行生成 / 逐行解析，峰值只与「单文件」同阶，
 * 不随项目规模堆出一条超长字符串。
 *
 * 布局：
 * - 第 1 行 header：`{t:'h', schema, projectId, root, savedAt, indexVersion, fingerprint, entries}`，
 *   `entries` 是 `[rel, size, mtimeMs, dirFlag]` 的紧凑数组（扫描结果，用于增量 diff / 指纹校验）；
 * - 之后每行一个文件：`{t:'f', file, lang, mtimeMs, size, indexed, error, degraded, encoding,
 *   scopes, definitions, references, imports, literals}`。
 * （不落 `source`：恢复时按需从磁盘懒读，见 `parser.ts` 的 `makeLazySource`；10k 仓库把正文
 * 写进快照会让解压后达 465MB，gunzip + JSON.parse 的物理下限就是十几秒。）
 *
 * 不落盘的东西：`defsByScope` / `importsByScope`（恢复时按 `parser.ts` 同一份实现从
 * definitions / imports 重建）、AST tree（语法包升级后由 schema 回落全量重建）。
 *
 * 快照损坏 / 版本不符 / 项目根不符 一律视为「没有快照」，静默回落全量重建。
 * 旧的 `snapshot.json.gz` 只读兼容（存在就尝试读，读不懂就忽略），不再写入。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { createGunzip, createGzip, gunzipSync } from 'node:zlib';
import { logWarn } from '../log';
import type { DefRecord, FileIndex, ImportRecord, LitRecord, RefRecord, ScopeRecord } from './model';
import type { BaseInfo, Resolved } from './model';
import { fileIndexFromSnapshot, type SnapshotRestoreOptions } from './parser';
import type { EntryInfo, SkipInfo } from './store';
import type { Range, SymbolKind } from '../types';

export const SNAPSHOT_SCHEMA = 1;

/** 当前快照格式（NDJSON + gzip）。 */
export const SNAPSHOT_FILE = 'snapshot.ndjson.gz';
/** 旧格式（单 JSON + gzip）：只读兼容。 */
export const LEGACY_SNAPSHOT_FILE = 'snapshot.json.gz';

/** gzip 级别：快照是本地缓存，取「写入 / 解压都快」的档位（体积只差几个百分点）。 */
const SNAPSHOT_GZIP_LEVEL = 1;
/** 读快照的块大小：块越大，行切分与流开销越接近整块读。 */
const SNAPSHOT_READ_CHUNK = 1 << 20;
/** 写快照的 gzip 块大小：减少 JS↔zlib 的边界调用（万级文件的写入是大头）。 */
const SNAPSHOT_WRITE_CHUNK = 1 << 20;

/** 快照第一行：项目级事实 + 扫描结果。 */
export interface SnapshotHeader {
  t: 'h';
  schema: number;
  projectId: string;
  root: string;
  savedAt: number;
  indexVersion: number;
  fingerprint: string;
  /** `[rel, size, mtimeMs, dirFlag]`（紧凑数组；10k 文件也只占一行）。 */
  entries: Array<[string, number, number, number]>;
  /** 正文编码分布（P9）。 */
  encodings?: Record<string, number>;
  /** 未索引原因（P9）：重启后报告仍能解释「为什么没进来」。 */
  skips?: Record<string, SkipInfo>;
}

/** 写盘时的 header（`t` 由 writer 补上）。 */
export type SnapshotHeaderInput = Omit<SnapshotHeader, 't'>;

/** 一行一个文件记录。 */
export interface SnapshotLine {
  t: 'f';
  file: string;
  lang: FileIndex['lang'];
  mtimeMs: number;
  size: number;
  /** true=已建符号索引；false=只读了正文（解析失败 / 超预算）。 */
  indexed: boolean;
  error: string | null;
  degraded: 'top-level' | null;
  /** 正文解码用的编码（P9 编码分布 / P12）。 */
  encoding?: string;
  /**
   * 正文原文。生产路径**不写**（`toFileRecord(fi, { omitSource: true })`）：恢复时按需读盘。
   * 旧格式快照 / 单测构造的记录可能带它，此时 `fromFileRecord` 不传 root 才会用它。
   */
  source?: string;
  /** 解析期语言模块写入的额外元数据（如 go / java 的 packageName）。 */
  meta?: Record<string, string>;
  scopes: ScopeRecord[];
  definitions: DefRecord[];
  references: RefRecord[];
  imports: ImportRecord[];
  literals: LitRecord[];
}

export function snapshotDir(dataDir: string, projectId: string): string {
  return path.join(dataDir, 'index', projectId);
}

/** 当前快照文件路径。 */
export function snapshotPath(dataDir: string, projectId: string): string {
  return path.join(snapshotDir(dataDir, projectId), SNAPSHOT_FILE);
}

/** 旧快照文件路径（只读兼容）。 */
export function legacySnapshotPath(dataDir: string, projectId: string): string {
  return path.join(snapshotDir(dataDir, projectId), LEGACY_SNAPSHOT_FILE);
}

/**
 * 指纹（Q8）：entries 按 rel 排序后 `rel|dir|size|mtimeMs` 拼接的 sha1。
 * 只读 readdir + stat 的轻量扫描就能算出，因而「指纹一致」等价于「无需重解析」。
 */
export function fingerprintEntries(entries: Iterable<[string, EntryInfo]>): string {
  const lines = [...entries].map(([rel, info]) => `${rel}|${info.dir ? 1 : 0}|${info.size}|${Math.round(info.mtimeMs)}`);
  lines.sort();
  return createHash('sha1').update(lines.join('\n')).digest('hex');
}

/** 扫描结果 → header 的紧凑数组形式。 */
export function encodeEntries(entries: Iterable<[string, EntryInfo]>): Array<[string, number, number, number]> {
  return [...entries].map(([rel, info]) => [rel, info.size, info.mtimeMs, info.dir ? 1 : 0] as [string, number, number, number]);
}

/** header 的紧凑数组 → 扫描结果 Map。 */
export function decodeEntries(list: Array<[string, number, number, number]> | undefined): Map<string, EntryInfo> {
  const out = new Map<string, EntryInfo>();
  for (const item of list ?? []) {
    if (!Array.isArray(item) || typeof item[0] !== 'string') continue;
    out.set(item[0], { dir: item[3] === 1, size: Number(item[1]) || 0, mtimeMs: Number(item[2]) || 0 });
  }
  return out;
}

export interface FileRecordOptions {
  /**
   * 不落正文（生产路径）：恢复时按需从磁盘懒读。**必须**用这个，否则快照会被正文撑爆，
   * 二次打开也就退回到「解压几百 MB + JSON.parse」的物理下限。
   */
  omitSource?: boolean;
}

/** FileIndex → 快照行（丢掉 source / defsByScope / importsByScope / tree）。 */
export function toFileRecord(fi: FileIndex, opts: FileRecordOptions = {}): SnapshotLine {
  const rec: SnapshotLine = {
    t: 'f',
    file: fi.file,
    lang: fi.lang,
    mtimeMs: fi.mtimeMs,
    size: fi.size,
    indexed: fi.indexed,
    error: fi.error ?? null,
    degraded: fi.degraded ?? null,
    encoding: fi.encoding,
    meta: fi.meta,
    scopes: fi.scopes instanceof Map ? [...fi.scopes.values()] : [],
    definitions: fi.definitions,
    references: fi.references,
    imports: fi.imports,
    literals: fi.literals,
  };
  // 只有不瘦身时才碰 fi.source（懒读的 fi 一碰就要读盘）
  if (!opts.omitSource) rec.source = fi.source;
  return rec;
}

/**
 * 快照行 → FileIndex（重建 defsByScope / importsByScope；`source` / `text` 按需懒读）。
 * 传 `opts.root` 时不读盘也不看记录里的 source —— 恢复期必须「一次盘都不读」。
 */
export function fromFileRecord(rec: SnapshotLine, opts: SnapshotRestoreOptions = {}): FileIndex {
  return fileIndexFromSnapshot(rec, { encoding: rec.encoding, ...opts });
}

// ------------------------------------------------------------------ 行编码 v2（列式数组）

/**
 * 行编码 v2：一行一个文件块，块内是**数组**而非对象。
 *
 * 为什么：索引事实本身才是二次打开的大头（1k 仓库 7 万条定义 / 5.9 万条引用，解压后 18.6MB）。
 * 两个实测结论决定了这个格式：
 * - 对象字面量的每个键都要建 hidden class：同内容对象编码 25MB 解析要 1.2s，位置数组只要 69ms；
 * - `JSON.parse` 对小串有固定开销：同一份 18.6MB 内容按每文件一行（1000 个 18KB 小串）解析要 549ms，
 *   聚成几 MB 的块后快数倍 —— 所以行不是「一文件一行」而是「一**块**一行」。
 *
 * 布局：第 1 行 header（对象）；之后每行是 `[文件记录, ...]`，每个文件记录是位置数组：
 * 0 file · 1 lang · 2 mtimeMs · 3 size · 4 indexed(0/1) · 5 error · 6 degraded ·
 * 7 encoding · 8 source（生产路径不写，`encOpt(undefined)`=0）· 9 meta ·
 * 10 scopes · 11 definitions · 12 references · 13 imports · 14 literals
 *
 * 子记录也用位置数组（range 仍用 4 元数组，实测展平到记录里 parse 更快但重建对象更慢，净持平）：
 * - scope：id · parent · kind · name · range
 * - def：id · name · kind · range · nameRange · scopeId · containerName · detail ·
 *   local(0/1) · bodyScopeId · decorators · doc · bases
 * - ref：name · kind · range · scopeId · memberParts · text · resolved
 * - lit：text · kind · range · boundDefId · keyOf
 * - import：localName · module · importedName · kind · scopeId · range · resolvedFile
 *
 * 三态字段（undefined / null / 值）统一走 `encOpt` / `decOpt`：`0`=undefined、`1`=null、其余=值。
 * 记录里的 `file` 一律省略（解码时用行记录的 file 回填）—— 每条省 20~30 字节的重复路径。
 * 旧格式（v1 对象行 / 早期单文件 v2 行）仍可读：`consumeLine` 按形状分流；
 * 旧快照会被 store 重写为当前格式。
 */

/** 三态编码：undefined → 0，null → 1，其余原样。 */
function encOpt(v: unknown): unknown {
  return v === undefined ? 0 : v === null ? 1 : v;
}

/** 三态解码：0 → undefined（字段不存在），1 → null。 */
function decOpt(v: unknown): unknown {
  return v === 0 ? undefined : v === 1 ? null : v;
}

const encRange = (r: Range): [number, number, number, number] => [r.start.line, r.start.col, r.end.line, r.end.col];
const decRange = (raw: unknown): Range => {
  const t = raw as [number, number, number, number];
  return { start: { line: t[0], col: t[1] }, end: { line: t[2], col: t[3] } };
};

/** FileIndex 记录 → 快照行数组（v2：位置数组）。 */
export function encodeFileRecord(rec: SnapshotLine): unknown[] {
  return [
    rec.file,
    rec.lang,
    rec.mtimeMs,
    rec.size,
    rec.indexed ? 1 : 0,
    encOpt(rec.error),
    encOpt(rec.degraded),
    encOpt(rec.encoding),
    encOpt(rec.source),
    encOpt(rec.meta),
    rec.scopes.map((s) => [s.id, s.parent, s.kind, s.name, encRange(s.range)]),
    rec.definitions.map((d) => [
      d.id,
      d.name,
      d.kind,
      encRange(d.range),
      encRange(d.nameRange),
      d.scopeId,
      d.containerName,
      d.detail,
      d.local ? 1 : 0,
      d.bodyScopeId,
      encOpt(d.decorators),
      encOpt(d.doc),
      encOpt(d.bases),
    ]),
    rec.references.map((r) => [r.name, r.kind, encRange(r.range), r.scopeId, encOpt(r.memberParts), r.text, encOpt(r.resolved)]),
    rec.imports.map((i) => [
      i.localName,
      i.module,
      encOpt(i.importedName),
      i.kind,
      i.scopeId,
      encRange(i.range),
      encOpt(i.resolvedFile),
    ]),
    rec.literals.map((l) => [l.text, l.kind, encRange(l.range), encOpt(l.boundDefId), encOpt(l.keyOf)]),
  ];
}

/** 快照行数组（v2）→ FileIndex 记录对象。 */
export function decodeFileRecord(raw: unknown[]): SnapshotLine {
  const file = String(raw[0] ?? '');
  const rec: SnapshotLine = {
    t: 'f',
    file,
    lang: (raw[1] ?? 'plaintext') as FileIndex['lang'],
    mtimeMs: Number(raw[2]) || 0,
    size: Number(raw[3]) || 0,
    indexed: raw[4] !== 0,
    error: (decOpt(raw[5]) ?? null) as string | null,
    degraded: (decOpt(raw[6]) ?? null) as SnapshotLine['degraded'],
    scopes: ((raw[10] ?? []) as unknown[][]).map((s) => ({
      id: String(s[0]),
      file,
      parent: (s[1] ?? null) as string | null,
      kind: s[2] as ScopeRecord['kind'],
      name: (s[3] ?? null) as string | null,
      range: decRange(s[4]),
    })),
    definitions: ((raw[11] ?? []) as unknown[][]).map((d) => {
      const def: DefRecord = {
        id: String(d[0]),
        name: String(d[1]),
        kind: d[2] as SymbolKind,
        file,
        range: decRange(d[3]),
        nameRange: decRange(d[4]),
        scopeId: String(d[5]),
        containerName: (d[6] ?? null) as string | null,
        detail: (d[7] ?? null) as string | null,
        local: d[8] === 1,
        bodyScopeId: (d[9] ?? null) as string | null,
      };
      const decorators = decOpt(d[10]);
      if (decorators !== undefined) def.decorators = decorators as string[];
      const doc = decOpt(d[11]);
      if (doc !== undefined) def.doc = doc as string[] | null;
      const bases = decOpt(d[12]);
      if (bases !== undefined) def.bases = bases as BaseInfo[];
      return def;
    }),
    references: ((raw[12] ?? []) as unknown[][]).map((r) => {
      const ref: RefRecord = {
        name: String(r[0]),
        kind: r[1] as RefRecord['kind'],
        file,
        range: decRange(r[2]),
        scopeId: String(r[3]),
        text: String(r[5]),
      };
      const parts = decOpt(r[4]);
      if (parts !== undefined) ref.memberParts = parts as string[];
      const resolved = decOpt(r[6]);
      if (resolved !== undefined) ref.resolved = resolved as Resolved;
      return ref;
    }),
    imports: ((raw[13] ?? []) as unknown[][]).map((i) => {
      const imp: ImportRecord = {
        localName: String(i[0]),
        module: String(i[1]),
        kind: i[3] as ImportRecord['kind'],
        file,
        scopeId: String(i[4]),
        range: decRange(i[5]),
      };
      const importedName = decOpt(i[2]);
      if (importedName !== undefined) imp.importedName = importedName as string;
      const resolvedFile = decOpt(i[6]);
      if (resolvedFile !== undefined) imp.resolvedFile = resolvedFile as string | null;
      return imp;
    }),
    literals: ((raw[14] ?? []) as unknown[][]).map((l) => {
      const lit: LitRecord = { text: String(l[0]), kind: l[1] as LitRecord['kind'], file, range: decRange(l[2]) };
      const bound = decOpt(l[3]);
      if (bound !== undefined) lit.boundDefId = bound as string | null;
      const keyOf = decOpt(l[4]);
      if (keyOf !== undefined) lit.keyOf = keyOf as string | null;
      return lit;
    }),
  };
  const encoding = decOpt(raw[7]);
  if (typeof encoding === 'string') rec.encoding = encoding;
  const source = decOpt(raw[8]);
  if (typeof source === 'string') rec.source = source;
  const meta = decOpt(raw[9]);
  if (meta !== undefined) rec.meta = meta as Record<string, string>;
  return rec;
}

/**
 * 流式写盘：逐行 `JSON.stringify` + gzip + 落盘，**不拼接整份快照字符串**。
 * 先写 `.tmp` 再 rename（进程中途退出不会留下半截文件）。
 */
export async function writeSnapshot(
  file: string,
  header: SnapshotHeaderInput,
  files: Iterable<SnapshotLine> | (() => Iterable<SnapshotLine>),
): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const produce = typeof files === 'function' ? files : () => files;
  try {
    await pipeline(
      Readable.from(snapshotLines(header, produce()), { objectMode: false }),
      createGzip({ level: SNAPSHOT_GZIP_LEVEL, chunkSize: SNAPSHOT_WRITE_CHUNK }),
      createWriteStream(tmp),
    );
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/** 行内块的目标字节数：太小则 `JSON.parse` 的固定开销放大，太大则峰值内存与单串长度上升。 */
const SNAPSHOT_LINE_CHUNK = 4 << 20;

/** header 一行 + 文件记录按块聚合（每块一个数组行）。 */
async function* snapshotLines(header: SnapshotHeaderInput, files: Iterable<SnapshotLine>): AsyncGenerator<string> {
  yield `${JSON.stringify({ t: 'h', ...header } satisfies SnapshotHeader)}\n`;
  let chunk: string[] = [];
  let size = 0;
  for (const rec of files) {
    const line = JSON.stringify(encodeFileRecord(rec));
    chunk.push(line);
    size += line.length + 1;
    if (size >= SNAPSHOT_LINE_CHUNK) {
      yield `[${chunk.join(',')}]\n`;
      chunk = [];
      size = 0;
    }
  }
  if (chunk.length) yield `[${chunk.join(',')}]\n`;
}

export interface SnapshotStreamHandlers {
  /** header 校验通过后立即调用（此刻可以清空内存索引，开始逐行恢复）。 */
  onHeader?: (header: SnapshotHeader) => void;
  onFile?: (rec: SnapshotLine) => void;
}

export interface SnapshotReadResult {
  header: SnapshotHeader;
  /** 实际恢复的文件行数。 */
  files: number;
}

/**
 * 流式读快照：
 * - 优先读 `snapshot.ndjson.gz`（存在即只认它：损坏就当没有快照，不去回退旧文件）；
 * - 不存在时才尝试旧的 `snapshot.json.gz`；
 * - 读失败 / 中途损坏 / schema 不符 → null（调用方回落全量重建）。
 */
export async function readSnapshotStream(
  file: string,
  handlers: SnapshotStreamHandlers = {},
): Promise<SnapshotReadResult | null> {
  if (await exists(file)) return readNdjsonFile(file, handlers);
  const legacy = legacySnapshotPathOf(file);
  if (await exists(legacy)) return readLegacyFile(legacy, handlers);
  return null;
}

async function exists(file: string): Promise<boolean> {
  return fsp.access(file).then(
    () => true,
    () => false,
  );
}

/** 与传入路径同目录的旧格式路径。 */
function legacySnapshotPathOf(file: string): string {
  return path.join(path.dirname(file), LEGACY_SNAPSHOT_FILE);
}

async function readNdjsonFile(file: string, handlers: SnapshotStreamHandlers): Promise<SnapshotReadResult | null> {
  const src = createReadStream(file, { highWaterMark: SNAPSHOT_READ_CHUNK });
  const gunzip = createGunzip({ chunkSize: SNAPSHOT_READ_CHUNK });
  let failure: Error | null = null;
  const onError = (e: Error) => {
    if (!failure) failure = e;
    gunzip.destroy();
  };
  src.on('error', onError);
  gunzip.on('error', onError);
  src.pipe(gunzip);

  let header: SnapshotHeader | null = null;
  let files = 0;
  // 手工按 \n 切行（不用 readline：逐行 async 迭代在万行量级是可观的常数开销）。
  // StringDecoder 保证多字节字符跨 chunk 不被截断。
  const decoder = new StringDecoder('utf8');
  let carry = '';
  const consumeLine = (raw: string): void => {
    const line = raw.charCodeAt(raw.length - 1) === 13 ? raw.slice(0, -1) : raw;
    if (!line) return;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      failure = new Error(`bad snapshot line: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!header) {
      const candidate = obj as SnapshotHeader;
      if (!candidate || candidate.t !== 'h' || candidate.schema !== SNAPSHOT_SCHEMA || !Array.isArray(candidate.entries)) {
        failure = new Error('bad snapshot header');
        return;
      }
      header = candidate;
      handlers.onHeader?.(candidate);
      return;
    }
    // 文件记录行：块（`[[rec], ...]`，当前格式）或早期的单文件行（`[rec]`）
    if (Array.isArray(obj)) {
      const items = typeof obj[0] === 'string' ? [obj] : (obj as unknown[][]);
      for (const item of items) {
        if (!Array.isArray(item)) continue;
        const rec = decodeFileRecord(item);
        if (rec.t !== 'f' || !rec.file) continue;
        handlers.onFile?.(rec);
        files++;
      }
      return;
    }
    // v1：一行一个对象
    const rec = obj as SnapshotLine;
    if (!rec || rec.t !== 'f' || typeof rec.file !== 'string') return;
    handlers.onFile?.(rec);
    files++;
  };

  try {
    for await (const chunk of gunzip) {
      if (failure) break;
      carry += decoder.write(chunk as Buffer);
      let start = 0;
      for (;;) {
        const nl = carry.indexOf('\n', start);
        if (nl < 0) break;
        consumeLine(carry.slice(start, nl));
        start = nl + 1;
        if (failure) break;
      }
      if (start > 0) carry = carry.slice(start);
    }
    if (!failure) {
      carry += decoder.end();
      if (carry) consumeLine(carry);
    }
  } catch (e) {
    if (!failure) failure = e instanceof Error ? e : new Error(String(e));
  }
  src.destroy();
  gunzip.destroy();

  if (failure || !header) {
    logWarn('index.snapshot.read-failed', { file, error: failure?.message ?? 'empty snapshot', files });
    return null;
  }
  return { header, files };
}

/** 旧格式（单 JSON + gzip）兼容读：解析成一整份 payload 后再按同样的回调逐条喂出去。 */
async function readLegacyFile(file: string, handlers: SnapshotStreamHandlers): Promise<SnapshotReadResult | null> {
  try {
    const raw = await fsp.readFile(file);
    const payload = JSON.parse(gunzipSync(raw).toString('utf8')) as Partial<LegacySnapshotPayload>;
    if (!payload || payload.schema !== SNAPSHOT_SCHEMA || typeof payload.fingerprint !== 'string') return null;
    if (!Array.isArray(payload.files)) return null;
    const header: SnapshotHeader = {
      t: 'h',
      schema: payload.schema,
      projectId: String(payload.projectId ?? ''),
      root: String(payload.root ?? ''),
      savedAt: Number(payload.savedAt ?? 0),
      indexVersion: Number(payload.indexVersion ?? 0),
      fingerprint: payload.fingerprint,
      entries: encodeEntries(Object.entries(payload.entries ?? {})),
      encodings: payload.encodings,
      skips: payload.skips,
    };
    handlers.onHeader?.(header);
    let files = 0;
    for (const rec of payload.files) {
      if (!rec?.file) continue;
      handlers.onFile?.(normalizeLegacyRecord(rec));
      files++;
    }
    logWarn('index.snapshot.legacy-read', { file, files });
    return { header, files };
  } catch (e) {
    logWarn('index.snapshot.read-failed', { file, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

interface LegacySnapshotPayload {
  schema: number;
  projectId: string;
  root: string;
  savedAt: number;
  indexVersion: number;
  fingerprint: string;
  entries: Record<string, EntryInfo>;
  files: Array<Partial<SnapshotLine> & { file: string }>;
  encodings: Record<string, number>;
  skips: Record<string, SkipInfo>;
}

function normalizeLegacyRecord(rec: Partial<SnapshotLine> & { file: string }): SnapshotLine {
  return {
    t: 'f',
    file: rec.file,
    lang: rec.lang ?? 'plaintext',
    mtimeMs: Number(rec.mtimeMs ?? 0),
    size: Number(rec.size ?? 0),
    indexed: rec.indexed !== false,
    error: rec.error ?? null,
    degraded: rec.degraded ?? null,
    encoding: rec.encoding,
    source: rec.source ?? '',
    meta: rec.meta ?? {},
    scopes: rec.scopes ?? [],
    definitions: rec.definitions ?? [],
    references: rec.references ?? [],
    imports: rec.imports ?? [],
    literals: rec.literals ?? [],
  };
}

/** 删除某个项目的快照目录（forget 时调用）。 */
export async function removeSnapshotDir(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true });
}
