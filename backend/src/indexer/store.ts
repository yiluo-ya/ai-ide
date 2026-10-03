/** 项目索引存储：扫描目录、建/增量更新索引、文本搜索、文件树、事件推送。 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type {
  FileNode,
  IndexEvent,
  IndexStatus,
  LangId,
  SearchMatch,
  SearchOptions,
  SearchResult,
  SkipReason,
  SnapshotStatus,
  VerifyResult,
} from '../types';
import type { IgnoreInfo } from '../types';
import type { DefRecord, FileIndex, ImportRecord, RefRecord } from './model';
import { deserializeFileIndex, indexSource, plainFileIndex, serializeFileIndex } from './parser';
import { ParsePool, type ParseResult, type ParseTask } from './parse-pool';
import { decodeBuffer, looksBinary } from './encoding';
import { IgnoreMatcher, IGNORED_DIRS, IGNORED_FILE_PATTERNS } from './ignore';
import {
  SNAPSHOT_SCHEMA,
  decodeEntries,
  encodeEntries,
  fingerprintEntries,
  fromFileRecord,
  readSnapshotStream,
  snapshotDir,
  snapshotPath,
  toFileRecord,
  writeSnapshot,
  type SnapshotHeader,
} from './snapshot';
import { logInfo, logTiming, logWarn } from '../log';
import { langForFile, specForFile } from '../languages';
import { DATA_DIR, PARSE_WORKERS, PERSIST_ENABLED } from '../config';
import type { ModuleHint } from './walker';

/** 内置黑名单（P8）已迁到 `ignore.ts`：这里只做再导出，保持既有引用点可用。 */
export { IGNORED_DIRS, IGNORED_FILE_PATTERNS };

/** 超过该大小不建完整符号索引（1MB~5MB 走顶层符号降级，P11）。 */
export const MAX_INDEX_BYTES = 1_000_000;
/** 超过该大小直接拒绝查看。 */
export const MAX_VIEW_BYTES = 5_000_000;

/** 少于该文件数不值得起 worker（tsx 启动成本高于解析收益）。 */
const MIN_PARALLEL_FILES = 8;
/** 同一批并发读盘 / stat 的上限。 */
const IO_CONCURRENCY = 16;
/** 快照写入防抖（增量变更后合并写盘，P4）。 */
const SNAPSHOT_DEBOUNCE_MS = 3000;

/** 包清单类文件：变更后需要重读项目元信息。 */
const META_FILES = new Set(['package.json', 'go.mod', 'pyproject.toml', 'pom.xml', 'Cargo.toml']);

export interface EntryInfo {
  dir: boolean;
  size: number;
  mtimeMs: number;
}

/**
 * 一次扫描的暂存结果（2026-10-03）：scan 先建后换，见 scan() 注释。
 * 只写这里，扫完再整体替换到 this.*，避免扫描期间对外露出空树。
 */
interface ScanAcc {
  entries: Map<string, EntryInfo>;
  dirs: Set<string>;
  allFiles: Map<string, { size: number; mtimeMs: number; binary: boolean }>;
  ignored: number;
}

/** 按扩展名判断「二进制 / 资源文件」（文件树里只展示、不预览）。 */
function isBinaryName(rel: string): boolean {
  return /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|tar|jar|war|class|exe|dll|so|dylib|bin|woff2?|ttf|eot|mp[34]|wav|webm|mp4|sqlite|db|wasm|lock|map)$/i.test(
    rel,
  );
}

/** 未索引文件的原因记录（P9）。 */
export interface SkipInfo {
  reason: SkipReason;
  detail?: string;
}

export interface ProjectIndexOptions {
  /** 数据目录（快照落在这里）。默认 config.DATA_DIR。 */
  dataDir?: string;
  /** 是否写索引快照（P4）。默认 config.PERSIST_ENABLED；测试传 false。 */
  persist?: boolean;
  /** 并行解析 worker 数（P5）。默认 config.PARSE_WORKERS；0 = 串行。 */
  workers?: number;
}

export class ProjectIndex {
  readonly id: string;
  name: string;
  readonly root: string;
  readonly createdAt: number;

  /** 全部非忽略条目（含目录），rel 为 POSIX 风格。 */
  readonly entries = new Map<string, EntryInfo>();
  /**
   * 2026-10-03 用户要求「文件树显示项目所有文件」：除噪声目录（node_modules/.git …）外，
   * 连被规则忽略的与二进制的文件也记一份，专供 `/all-files` 给文件树用；
   * 不混进 entries，是因为 entries 参与快照指纹与对账，语义必须是「可索引的候选文件」。
   */
  readonly allFiles = new Map<string, { size: number; mtimeMs: number; binary: boolean }>();
  readonly dirs = new Set<string>();
  /** 已建符号索引的源码文件。 */
  readonly files = new Map<string, FileIndex>();
  /** 非源码 / 过大的正文缓存（按需加载，供查看与文本搜索）。 */
  private readonly textCache = new Map<string, FileIndex>();

  /** P8：忽略规则判定器（内置黑名单 + .gitignore + .wcrignore）。 */
  readonly ignore = new IgnoreMatcher();
  /** P9：未索引文件的原因（文件 → 原因）。 */
  readonly skipLog = new Map<string, SkipInfo>();
  /** P9/P12：正文实际使用的编码分布。 */
  readonly encodingStats = new Map<string, number>();
  /** 扫描时被忽略规则跳过的条目数（目录按整棵剪枝计 1）。 */
  private ignoredCount = 0;

  /** 索引版本：每次索引增删改都 +1，供语义着色的缓存失效。 */
  indexVersion = 0;
  /** 语义着色结果缓存：file → { 版本, 扁平数据 }。 */
  readonly highlightCache = new Map<string, { revision: number; data: number[] }>();

  readonly defsByName = new Map<string, DefRecord[]>();
  /** 定义 id → 定义（N15/N16/N17 需要按 id 回找）。 */
  readonly defsById = new Map<string, DefRecord>();
  /** 基类 / 接口名 → 谁显式继承（N17 的反向索引）。 */
  readonly heritageOf = new Map<string, string[]>();
  readonly refsByName = new Map<string, Array<{ file: string; ref: RefRecord }>>();
  readonly importsByName = new Map<string, Array<{ file: string; imp: ImportRecord }>>();
  readonly classMap = new Map<string, string[]>();
  projectMeta: Record<string, string> = {};

  status: IndexStatus = {
    indexing: false,
    filesIndexed: 0,
    filesTotal: 0,
    progress: 0,
    indexedAt: null,
    error: null,
  };

  private readonly dataDir: string;
  private readonly persist: boolean;
  private readonly workers: number;
  /** 上快照状态（P4）。 */
  private snapshotSavedAt: number | null = null;
  private snapshotFileCount = 0;
  private snapshotSchema = 0;
  private snapshotFresh: boolean | null = null;
  /** 读到的快照行里带了正文（旧格式 / 未瘦身）→ 恢复后需要重写为瘦身版。 */
  private snapshotHadInlineSource = false;
  private persistTimer: NodeJS.Timeout | null = null;

  private running = false;
  /** 进行中的扫描：并发调用复用同一次，避免重复读盘与互相覆盖（见 scan()）。 */
  private scanInFlight: Promise<void> | null = null;
  private listeners = new Set<(e: IndexEvent) => void>();

  constructor(
    id: string,
    name: string,
    root: string,
    createdAt = Date.now(),
    opts: ProjectIndexOptions = {},
  ) {
    this.id = id;
    this.name = name;
    this.root = root;
    this.createdAt = createdAt;
    this.dataDir = opts.dataDir ?? DATA_DIR;
    this.persist = opts.persist ?? PERSIST_ENABLED;
    this.workers = opts.workers ?? PARSE_WORKERS;
  }

  subscribe(fn: (e: IndexEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(event: IndexEvent) {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        /* 事件消费者异常不影响索引 */
      }
    }
  }

  private emitStatus() {
    this.emit({ type: 'status', status: { ...this.status } });
  }

  // ---------------------------------------------------------------- 扫描

  /**
   * 轻量重扫（只 readdir + stat）：刷新 entries / dirs，并重新加载忽略规则。
   * 同一层的目录与文件并发处理（上限 16），供 P4 指纹校验与 P7 对账共用。
   */
  async scan(): Promise<void> {
    if (!this.scanInFlight) {
      this.scanInFlight = this.doScan().finally(() => {
        this.scanInFlight = null;
      });
    }
    return this.scanInFlight;
  }

  /**
   * 扫描本体（2026-10-03 改为「先建后换」）。此前是先把 this.entries/dirs/allFiles 清空、
   * 再逐层填回，于是每次扫描（首次索引、每 10 分钟的 P7 对账）都会开一个「文件树是空的」
   * 窗口：用户恰在此刻切换项目，左侧文件面板就一片空白。现在全程只写暂存结构 acc，
   * 扫完一次性替换，任何时刻对外看到的都是上一份完整结果。
   */
  private async doScan(): Promise<void> {
    await this.ignore.reload(this.root);
    const acc: ScanAcc = { entries: new Map(), dirs: new Set(), allFiles: new Map(), ignored: 0 };
    let level: string[] = [''];
    while (level.length) {
      const next: string[] = [];
      const results = await mapLimit(level, IO_CONCURRENCY, (dir) => this.readDir(dir, acc));
      for (const children of results) next.push(...children);
      level = next;
    }
    this.entries.clear();
    for (const [rel, info] of acc.entries) this.entries.set(rel, info);
    this.dirs.clear();
    for (const dir of acc.dirs) this.dirs.add(dir);
    this.allFiles.clear();
    for (const [rel, info] of acc.allFiles) this.allFiles.set(rel, info);
    this.ignoredCount = acc.ignored;
  }

  /**
   * 内存里还没有任何扫描结果时先扫一次（冷启动后第一次访问、或项目被释放后回来）。
   * 已有结果则立即返回 —— 文件树请求不该为了等索引而空白，但更不能给空树。
   */
  async ensureScanned(): Promise<void> {
    if (this.entries.size || this.allFiles.size) return;
    await this.scan();
  }

  /** 读一层目录：把结果写进暂存区 acc，返回需要继续下探的子目录。 */
  private async readDir(rel: string, acc: ScanAcc): Promise<string[]> {
    let dirents;
    try {
      dirents = await fsp.readdir(this.abs(rel), { withFileTypes: true });
    } catch {
      return [];
    }
    const children: string[] = [];
    const files: string[] = [];
    for (const d of dirents) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (this.ignore.ignoresDir(childRel, d.name)) {
          acc.ignored++;
          continue;
        }
        acc.entries.set(childRel, { dir: true, size: 0, mtimeMs: 0 });
        acc.dirs.add(childRel);
        children.push(childRel);
        continue;
      }
      if (!d.isFile()) continue;
      if (this.ignore.ignoresFile(childRel)) {
        // 被规则忽略的也记进 allFiles（文件树要显示「所有文件」），但不进 entries
        acc.allFiles.set(childRel, { size: 0, mtimeMs: 0, binary: isBinaryName(childRel) });
        acc.ignored++;
        continue;
      }
      files.push(childRel);
    }
    const stats = await mapLimit(files, IO_CONCURRENCY, async (childRel) => {
      try {
        const st = await fsp.stat(this.abs(childRel));
        return { rel: childRel, size: st.size, mtimeMs: st.mtimeMs };
      } catch {
        return null; // 竞态删除的文件跳过
      }
    });
    for (const st of stats) {
      if (st) acc.entries.set(st.rel, { dir: false, size: st.size, mtimeMs: st.mtimeMs });
      if (st) acc.allFiles.set(st.rel, { size: st.size, mtimeMs: st.mtimeMs, binary: isBinaryName(st.rel) });
    }
    return children;
  }

  // ---------------------------------------------------------------- 索引

  async reindexAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.status = { ...this.status, indexing: true, error: null, filesIndexed: 0, progress: 0 };
    this.emitStatus();
    try {
      await this.scan();
      const tMeta = performance.now();
      await this.loadProjectMeta();
      logTiming('index.project-meta.load', performance.now() - tMeta, { project: this.id });
      const restored = await this.restoreSnapshot();
      // 指纹一致且磁盘无变化 → 绝不重写快照（二次打开的关键预算，B4）
      let dirty = true;
      let classMapReady = false;
      if (restored) {
        dirty = await this.applySnapshot(restored);
        // 旧格式快照（行里带正文）→ 重写为不落正文的瘦身版，下次二次打开才真的零正文解压
        if (restored.needsRewrite) dirty = true;
        // 恢复路径已在逐行恢复时顺手建了 classMap；有增量就必须重建
        classMapReady = !dirty;
      } else {
        await this.fullIndex();
      }
      if (!classMapReady) {
        const tClass = performance.now();
        this.rebuildClassMap();
        logTiming('index.class-map.rebuild', performance.now() - tClass, { project: this.id, files: this.files.size });
      }
      this.indexVersion++;
      this.status.indexing = false;
      this.status.indexedAt = Date.now();
      this.status.progress = 1;
      this.emitStatus();
      this.emit({ type: 'index-ready', status: { ...this.status } });
      if (dirty) await this.persistSnapshot();
    } catch (e) {
      this.status.indexing = false;
      this.status.error = e instanceof Error ? e.message : String(e);
      logWarn('index.reindex.failed', { project: this.id, error: this.status.error });
      this.emitStatus();
    } finally {
      this.running = false;
    }
  }

  /** 全量重建（没有可用快照时）。 */
  private async fullIndex(): Promise<void> {
    this.clearIndex();
    this.skipLog.clear();
    const targets: string[] = [];
    for (const [rel, info] of this.entries) {
      if (info.dir) continue;
      if (!specForFile(rel)) continue;
      if (info.size > MAX_VIEW_BYTES) {
        this.skipLog.set(rel, { reason: 'too-large', detail: `>${MAX_VIEW_BYTES}B，仅正文不索引` });
        continue;
      }
      targets.push(rel);
    }
    this.status.filesTotal = targets.length;
    await this.indexTargets(targets);
  }

  /** 串行 / 并行解析一批文件（读盘并发 16，解析按池并行），按原顺序写入索引。 */
  private async indexTargets(targets: string[]): Promise<void> {
    if (!targets.length) return;
    const pool = this.workers > 1 && targets.length >= MIN_PARALLEL_FILES ? new ParsePool(this.workers) : null;
    // 进度是「累计已索引完成数」：并行批次不能用批内下标，否则会被最后一批的数量覆盖（B4）
    const total = this.status.filesTotal || targets.length;
    let done = this.status.filesIndexed;
    try {
      for (let start = 0; start < targets.length; start += IO_CONCURRENCY) {
        const slice = targets.slice(start, start + IO_CONCURRENCY);
        const prepared = await mapLimit(slice, IO_CONCURRENCY, (rel) => this.prepareIndex(rel));
        const tasks: ParseTask[] = [];
        for (const prep of prepared) {
          if (prep.ok) {
            tasks.push({
              rel: prep.rel,
              source: prep.text,
              langId: prep.langId,
              mtimeMs: prep.mtimeMs,
              size: prep.size,
              topLevelOnly: prep.degraded,
            });
          }
        }
        const results = pool ? await pool.parseBatch(tasks) : tasks.map((t) => serialParse(t));
        const byRel = new Map<string, ParseResult>();
        tasks.forEach((task, i) => byRel.set(task.rel, results[i] ?? { ok: false, error: 'no result' }));
        for (let i = 0; i < slice.length; i++) {
          const prep = prepared[i];
          if (prep.ok) {
            const result = byRel.get(prep.rel);
            if (result?.ok) {
              try {
                const fi = deserializeFileIndex(result.data, prep.text);
                fi.encoding = prep.encoding;
                this.files.set(prep.rel, fi);
                this.addToMaps(fi);
                this.recordParseOutcome(prep.rel, fi);
              } catch (e) {
                this.noteParseFailure(prep.rel, e);
              }
            } else {
              this.noteParseFailure(prep.rel, result?.error ?? 'parse failed');
            }
          }
          const doneCount = done + 1;
          this.status.filesIndexed = doneCount;
          this.status.progress = total ? Math.min(1, doneCount / total) : 1;
          // 事件频率与改造前一致：每 25 个 + 本批最后一个
          if (done % 25 === 0 || i === slice.length - 1) {
            this.emitStatus();
            await new Promise((r) => setTimeout(r, 0));
          }
          done = doneCount;
        }
      }
    } finally {
      await pool?.close();
    }
  }

  private clearIndex() {
    this.files.clear();
    this.textCache.clear();
    this.highlightCache.clear();
    this.defsByName.clear();
    this.defsById.clear();
    this.heritageOf.clear();
    this.refsByName.clear();
    this.importsByName.clear();
    this.classMap.clear();
  }

  /** 读盘 + 解码 + 二进制 / 过大判定；失败时写入 skipLog（P9）。 */
  private async prepareIndex(rel: string): Promise<PreparedFile> {
    const spec = specForFile(rel);
    if (!spec) return { ok: false, rel };
    const entry = this.entries.get(rel);
    if (entry && entry.size > MAX_VIEW_BYTES) {
      this.skipLog.set(rel, { reason: 'too-large', detail: `>${MAX_VIEW_BYTES}B，仅正文不索引` });
      return { ok: false, rel };
    }
    let buf: Buffer;
    let mtimeMs = entry?.mtimeMs ?? 0;
    try {
      buf = await fsp.readFile(this.abs(rel));
      mtimeMs = (await fsp.stat(this.abs(rel))).mtimeMs;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.skipLog.set(rel, { reason: 'read-error', detail });
      logWarn('index.file.read-failed', { file: rel, error: detail });
      return { ok: false, rel };
    }
    if (looksBinary(buf)) {
      this.skipLog.set(rel, { reason: 'binary' });
      this.textCache.delete(rel);
      return { ok: false, rel };
    }
    const decoded = decodeBuffer(buf);
    this.noteEncoding(decoded.encoding);
    return {
      ok: true,
      rel,
      text: decoded.text,
      encoding: decoded.encoding,
      langId: String(spec.id),
      mtimeMs,
      size: buf.length,
      // P11：1MB~5MB 走顶层符号降级
      degraded: buf.length > MAX_INDEX_BYTES,
    };
  }

  private noteEncoding(encoding: string) {
    this.encodingStats.set(encoding, (this.encodingStats.get(encoding) ?? 0) + 1);
  }

  private recordParseOutcome(rel: string, fi: FileIndex) {
    if (!fi.indexed) {
      // 解析失败 / 超预算（P9）：不索引，只留正文；大文件归到 too-large（降级阈值内连顶层符号都没拿到）
      const reason: SkipReason = fi.size > MAX_INDEX_BYTES ? 'too-large' : 'parse-failed';
      this.skipLog.set(rel, { reason, detail: fi.error ?? undefined });
      if (reason === 'parse-failed') logWarn('index.file.parse-failed', { file: rel, error: fi.error });
      return;
    }
    if (fi.error) {
      this.skipLog.set(rel, { reason: 'parse-failed', detail: fi.error });
      logWarn('index.file.parse-failed', { file: rel, error: fi.error });
    } else {
      this.skipLog.delete(rel);
    }
  }

  private noteParseFailure(rel: string, e: unknown) {
    const detail = e instanceof Error ? e.message : String(e);
    this.skipLog.set(rel, { reason: 'parse-failed', detail });
    logWarn('index.file.parse-failed', { file: rel, error: detail });
  }

  /** 单文件索引（增量路径）：读盘 → 解析 → 写索引（串行，预算 ≤1s）。 */
  private async indexOne(rel: string): Promise<void> {
    const spec = specForFile(rel);
    if (!spec) return;
    const prep = await this.prepareIndex(rel);
    if (!prep.ok) return;
    try {
      const fi = indexSource(
        rel,
        prep.text,
        spec,
        { mtimeMs: prep.mtimeMs, size: prep.size },
        { topLevelOnly: prep.degraded },
      );
      fi.encoding = prep.encoding;
      this.files.set(rel, fi);
      this.addToMaps(fi);
      this.recordParseOutcome(rel, fi);
    } catch (e) {
      this.noteParseFailure(rel, e);
    }
  }

  private addToMaps(fi: FileIndex) {
    for (const def of fi.definitions) {
      const list = this.defsByName.get(def.name);
      if (list) list.push(def);
      else this.defsByName.set(def.name, [def]);
      this.defsById.set(def.id, def);
      for (const base of def.bases ?? []) {
        const derived = this.heritageOf.get(base.name);
        if (derived) derived.push(def.id);
        else this.heritageOf.set(base.name, [def.id]);
      }
    }
    for (const ref of fi.references) {
      const list = this.refsByName.get(ref.name);
      const item = { file: fi.file, ref };
      if (list) list.push(item);
      else this.refsByName.set(ref.name, [item]);
    }
    for (const imp of fi.imports) {
      const list = this.importsByName.get(imp.localName);
      const item = { file: fi.file, imp };
      if (list) list.push(item);
      else this.importsByName.set(imp.localName, [item]);
    }
  }

  private removeFromMaps(rel: string, fi: FileIndex) {
    for (const def of fi.definitions) {
      const list = this.defsByName.get(def.name);
      if (list) {
        const next = list.filter((d) => d.id !== def.id);
        if (next.length) this.defsByName.set(def.name, next);
        else this.defsByName.delete(def.name);
      }
      this.defsById.delete(def.id);
      for (const base of def.bases ?? []) {
        const derived = this.heritageOf.get(base.name);
        if (!derived) continue;
        const next = derived.filter((id) => id !== def.id);
        if (next.length) this.heritageOf.set(base.name, next);
        else this.heritageOf.delete(base.name);
      }
    }
    for (const ref of fi.references) {
      const list = this.refsByName.get(ref.name);
      if (!list) continue;
      const next = list.filter((r) => !(r.file === rel && sameRange(r.ref, ref)));
      if (next.length) this.refsByName.set(ref.name, next);
      else this.refsByName.delete(ref.name);
    }
    for (const imp of fi.imports) {
      const list = this.importsByName.get(imp.localName);
      if (!list) continue;
      const next = list.filter((r) => !(r.file === rel && sameRange(r.imp, imp)));
      if (next.length) this.importsByName.set(imp.localName, next);
      else this.importsByName.delete(imp.localName);
    }
  }

  private rebuildClassMap() {
    this.classMap.clear();
    for (const fi of this.files.values()) this.addFileToClassMap(fi);
  }

  /** 单文件贡献的 classMap 条目（全量重建与快照恢复共用同一口径）。 */
  private addFileToClassMap(fi: FileIndex) {
    for (const def of fi.definitions) {
      if (def.scopeId !== `${fi.file}#s0`) continue;
      if (def.kind !== 'class' && def.kind !== 'interface' && def.kind !== 'enum' && def.kind !== 'struct') {
        continue;
      }
      const list = this.classMap.get(def.name);
      if (list) list.push(fi.file);
      else this.classMap.set(def.name, [fi.file]);
    }
  }

  private async loadProjectMeta() {
    this.projectMeta = {};
    if (this.entries.has('go.mod')) {
      try {
        const text = await fsp.readFile(this.abs('go.mod'), 'utf8');
        const m = /^\s*module\s+(\S+)/m.exec(text);
        if (m) this.projectMeta['go.modulePath'] = m[1];
      } catch {
        /* 忽略 */
      }
    }
    if (this.entries.has('package.json')) {
      try {
        const pkg = JSON.parse(await fsp.readFile(this.abs('package.json'), 'utf8')) as {
          name?: string;
          main?: string;
          module?: string;
          bin?: string | Record<string, string>;
          scripts?: Record<string, string>;
        };
        if (typeof pkg.name === 'string') this.projectMeta['npm.name'] = pkg.name;
        const targets = new Set<string>();
        const addTargets = (value: unknown) => {
          if (typeof value !== 'string') return;
          for (const token of value.split(/\s+/)) {
            const clean = token.replace(/^\.\//, '');
            if (!clean || clean.startsWith('-')) continue;
            if (this.entries.has(clean)) targets.add(clean);
          }
        };
        addTargets(pkg.main);
        addTargets(pkg.module);
        if (typeof pkg.bin === 'string') addTargets(pkg.bin);
        else if (pkg.bin && typeof pkg.bin === 'object') for (const v of Object.values(pkg.bin)) addTargets(v);
        const scripts = pkg.scripts ?? {};
        const names = Object.keys(scripts);
        if (names.length) this.projectMeta['npm.scripts'] = names.join('\n');
        for (const v of Object.values(scripts)) addTargets(v);
        if (targets.size) this.projectMeta['npm.entries'] = [...targets].join('\n');
      } catch {
        /* 忽略 */
      }
    }
    if (this.entries.has('pyproject.toml')) {
      try {
        const text = await fsp.readFile(this.abs('pyproject.toml'), 'utf8');
        const m = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(text);
        if (m) this.projectMeta['python.name'] = m[1];
      } catch {
        /* 忽略 */
      }
    }
    if (this.entries.has('pom.xml')) {
      try {
        const text = await fsp.readFile(this.abs('pom.xml'), 'utf8');
        const m = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(text);
        if (m) this.projectMeta['java.artifactId'] = m[1];
      } catch {
        /* 忽略 */
      }
    }
    if (this.entries.has('Cargo.toml')) {
      try {
        const text = await fsp.readFile(this.abs('Cargo.toml'), 'utf8');
        const m = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(text);
        if (m) this.projectMeta['rust.name'] = m[1];
      } catch {
        /* 忽略 */
      }
    }
  }

  // ------------------------------------------------------------ 快照（P4）

  /**
   * 读快照并逐行恢复索引事实；没有 / 版本不符 / 项目根不符 / 损坏 → null（回落全量重建）。
   * 流式：峰值内存只与单个文件同阶（万级文件场景不会堆出一条超大字符串 / 超大数组）。
   */
  private async restoreSnapshot(): Promise<RestoredSnapshot | null> {
    if (!this.persist) return null;
    const fingerprint = fingerprintEntries(this.entries);
    const file = snapshotPath(this.dataDir, this.id);
    const t0 = performance.now();
    let restored = 0;
    let buildMs = 0;
    let mapsMs = 0;
    let entries = new Map<string, EntryInfo>();
    const result = await readSnapshotStream(file, {
      onHeader: (header) => {
        this.clearIndex();
        this.skipLog.clear();
        this.encodingStats.clear();
        for (const [enc, count] of Object.entries(header.encodings ?? {})) this.encodingStats.set(enc, count);
        for (const [rel, skip] of Object.entries(header.skips ?? {})) {
          this.skipLog.set(rel, { reason: skip.reason, detail: skip.detail });
        }
        this.snapshotSavedAt = header.savedAt;
        this.snapshotSchema = header.schema;
        this.snapshotFresh = fingerprint === header.fingerprint;
        entries = decodeEntries(header.entries);
      },
      onFile: (rec) => {
        try {
          const tBuild = performance.now();
          if (typeof rec.source === 'string') this.snapshotHadInlineSource = true;
          // 懒读正文：恢复期一次盘都不读，首次访问 fi.source / fi.text 时才读（读失败记 read-error）
          const fi = fromFileRecord(rec, {
            root: this.root,
            onReadError: (rel, detail) => this.skipLog.set(rel, { reason: 'read-error', detail }),
          });
          const tMaps = performance.now();
          this.files.set(fi.file, fi);
          this.addToMaps(fi);
          this.addFileToClassMap(fi);
          buildMs += tMaps - tBuild;
          mapsMs += performance.now() - tMaps;
          restored++;
        } catch {
          /* 单条坏数据忽略：后面按「未索引」处理 */
        }
      },
    });
    if (!result || result.header.root !== this.root || result.header.schema !== SNAPSHOT_SCHEMA) {
      this.snapshotFresh = null;
      return null;
    }
    const totalMs = performance.now() - t0;
    this.snapshotFileCount = restored;
    const needsRewrite = this.snapshotHadInlineSource;
    this.snapshotHadInlineSource = false;
    // 分段计时（P4 观测点）：parse = gunzip + 行切分 + JSON.parse，build = 构造 FileIndex，maps = 派生表
    logTiming('index.snapshot.load', totalMs, {
      files: restored,
      parse: Math.round(Math.max(0, totalMs - buildMs - mapsMs)),
      build: Math.round(buildMs),
      maps: Math.round(mapsMs),
    });
    return { header: result.header, entries, needsRewrite };
  }

  /**
   * 快照恢复后的增量：只重解析新增 / 变更文件，删除已消失的文件（Q8）。
   * 返回「快照是否需要重写」：指纹一致且无增删改时返回 false（二次打开不重写快照）。
   */
  private async applySnapshot(restored: RestoredSnapshot): Promise<boolean> {
    const { header, entries: oldEntries } = restored;
    const fingerprint = fingerprintEntries(this.entries);
    const added: string[] = [];
    const changed: string[] = [];
    const deleted: string[] = [];
    for (const [rel, info] of this.entries) {
      if (info.dir) continue;
      const old = oldEntries.get(rel);
      if (!old || old.dir) added.push(rel);
      else if (old.size !== info.size || Math.round(old.mtimeMs) !== Math.round(info.mtimeMs)) changed.push(rel);
    }
    for (const [rel, info] of oldEntries) {
      if (info.dir) continue;
      if (!this.entries.has(rel)) deleted.push(rel);
    }
    for (const rel of deleted) {
      const fi = this.files.get(rel);
      if (fi) {
        this.removeFromMaps(rel, fi);
        this.files.delete(rel);
      }
      this.textCache.delete(rel);
      this.skipLog.delete(rel);
    }
    for (const rel of changed) {
      const fi = this.files.get(rel);
      if (fi) {
        this.removeFromMaps(rel, fi);
        this.files.delete(rel);
      }
      this.skipLog.delete(rel);
    }
    const targets = [...added, ...changed].filter((rel) => {
      const info = this.entries.get(rel);
      if (!info || info.dir || info.size > MAX_VIEW_BYTES) {
        if (info && !info.dir && info.size > MAX_VIEW_BYTES) {
          this.skipLog.set(rel, { reason: 'too-large', detail: `>${MAX_VIEW_BYTES}B，仅正文不索引` });
        }
        return false;
      }
      return specForFile(rel) !== null;
    });
    this.status.filesTotal = this.files.size + targets.length;
    this.status.filesIndexed = this.files.size;
    if (!targets.length && !deleted.length) {
      this.status.filesTotal = this.files.size;
      this.status.progress = 1;
      const fresh = fingerprint === header.fingerprint;
      logInfo('index.snapshot.hit', { project: this.id, files: this.files.size, fresh });
      return !fresh;
    }
    logInfo('index.snapshot.incremental', {
      project: this.id,
      added: added.length,
      changed: changed.length,
      deleted: deleted.length,
    });
    if (targets.length) await this.indexTargets(targets);
    return true;
  }

  /** 写快照（reindexAll 完成后立即写；增量变更后防抖写）。逐行流式，不拼整份 JSON。 */
  private async persistSnapshot(): Promise<void> {
    if (!this.persist) return;
    const t0 = performance.now();
    try {
      const savedAt = Date.now();
      const header = {
        schema: SNAPSHOT_SCHEMA,
        projectId: this.id,
        root: this.root,
        savedAt,
        indexVersion: this.indexVersion,
        fingerprint: fingerprintEntries(this.entries),
        entries: encodeEntries(this.entries),
        encodings: Object.fromEntries(this.encodingStats),
        skips: Object.fromEntries([...this.skipLog].map(([rel, info]) => [rel, { ...info }])),
      };
      // 先把 FileIndex 引用复制成数组（写盘期间 watcher 可能改索引），再逐行序列化
      const files = [...this.files.values()];
      await writeSnapshot(snapshotPath(this.dataDir, this.id), header, function* () {
        for (const fi of files) yield toFileRecord(fi, { omitSource: true });
      });
      this.snapshotSavedAt = savedAt;
      this.snapshotFileCount = files.length;
      this.snapshotSchema = SNAPSHOT_SCHEMA;
      this.snapshotFresh = true;
      logTiming('index.snapshot.save', performance.now() - t0, { files: files.length });
    } catch (e) {
      logWarn('index.snapshot.save-failed', { project: this.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private schedulePersist() {
    if (!this.persist) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistSnapshot();
    }, SNAPSHOT_DEBOUNCE_MS);
    this.persistTimer.unref?.();
  }

  /** 快照状态（P4 端点用）。 */
  snapshotStatus(): SnapshotStatus {
    const dir = snapshotDir(this.dataDir, this.id);
    return {
      exists: this.snapshotSavedAt !== null,
      savedAt: this.snapshotSavedAt,
      fileCount: this.snapshotFileCount,
      schema: this.snapshotSchema,
      fresh: this.snapshotFresh,
      dir,
    };
  }

  // ------------------------------------------------------------ 增量更新

  async onFileChanged(rel: string): Promise<void> {
    if (this.ignore.ignoresFile(rel)) {
      // 规则变更导致的不再纳入：当成删除处理
      await this.onFileDeleted(rel);
      return;
    }
    const entry = this.entries.get(rel);
    if (entry?.dir) {
      // 路径从文件变成目录（P7 对账能走到这里）：丢掉旧的文件事实，保留目录条目
      const stale = this.files.get(rel);
      if (stale) {
        this.removeFromMaps(rel, stale);
        this.files.delete(rel);
      }
      this.textCache.delete(rel);
      this.skipLog.delete(rel);
      this.rebuildClassMap();
      this.indexVersion++;
      this.emit({ type: 'file-changed', file: rel });
      this.schedulePersist();
      return;
    }
    const spec = specForFile(rel);
    if (!spec) {
      this.textCache.delete(rel);
      this.skipLog.delete(rel);
      const entry = this.entries.get(rel);
      if (entry) entry.mtimeMs = Date.now();
      this.emit({ type: 'file-changed', file: rel });
      this.schedulePersist();
      return;
    }
    const old = this.files.get(rel);
    if (old) {
      this.removeFromMaps(rel, old);
      this.files.delete(rel);
    }
    try {
      const st = await fsp.stat(this.abs(rel));
      this.entries.set(rel, { dir: false, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* 文件已消失 */
    }
    await this.indexOne(rel);
    if (META_FILES.has(rel)) await this.loadProjectMeta();
    this.rebuildClassMap();
    this.indexVersion++;
    this.status.filesIndexed = this.files.size;
    this.status.filesTotal = Math.max(this.status.filesTotal, this.files.size);
    this.status.indexedAt = Date.now();
    this.emit({ type: 'file-changed', file: rel });
    this.schedulePersist();
  }

  async onFileDeleted(rel: string): Promise<void> {
    const fi = this.files.get(rel);
    if (fi) {
      this.removeFromMaps(rel, fi);
      this.files.delete(rel);
    }
    this.textCache.delete(rel);
    this.skipLog.delete(rel);
    this.entries.delete(rel);
    this.rebuildClassMap();
    this.indexVersion++;
    this.status.filesIndexed = this.files.size;
    this.emit({ type: 'file-deleted', file: rel });
    this.schedulePersist();
  }

  async onFileCreated(rel: string): Promise<void> {
    if (this.ignore.ignoresFile(rel)) return;
    try {
      const st = await fsp.stat(this.abs(rel));
      if (!st.isFile()) return;
      this.entries.set(rel, { dir: false, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      return;
    }
    await this.onFileChanged(rel);
  }

  // ------------------------------------------------------------ 对账（P7）

  /**
   * 与磁盘对账：重扫一遍（含并发 stat）求新增 / 变更 / 删除，并自动修复。
   * 索引正在跑时不动（返回空结果，healed=false），避免与全量索引抢索引表。
   */
  async verify(): Promise<VerifyResult> {
    const checkedAt = Date.now();
    if (this.running) return { checkedAt, added: [], changed: [], deleted: [], healed: false };
    const before = new Map(this.entries);
    const changed = new Set<string>();
    const deleted = new Set<string>();
    const typeChanged = new Set<string>();
    // 并发（上限 16）重 stat 已知条目：找变更 / 消失 / 类型变化
    await mapLimit([...before.keys()], IO_CONCURRENCY, async (rel) => {
      const info = before.get(rel)!;
      try {
        const st = await fsp.stat(this.abs(rel));
        if (info.dir !== st.isDirectory()) {
          typeChanged.add(rel);
          return;
        }
        if (!info.dir && (info.size !== st.size || Math.round(info.mtimeMs) !== Math.round(st.mtimeMs))) {
          changed.add(rel);
        }
      } catch {
        deleted.add(rel);
      }
    });
    // 再扫一遍：发现新增路径，并把 entries 刷新成磁盘现状
    await this.scan();
    const added: string[] = [];
    for (const [rel, info] of this.entries) {
      if (!info.dir && !before.has(rel)) added.push(rel);
    }
    for (const rel of [...typeChanged]) {
      if (before.get(rel)?.dir) {
        // 目录 → 文件：按新增处理
        if (this.entries.has(rel)) added.push(rel);
        else deleted.add(rel);
      } else {
        // 文件 → 目录：丢掉旧的文件事实，按变更处理
        changed.add(rel);
      }
    }
    for (const rel of deleted) await this.onFileDeleted(rel);
    for (const rel of added) await this.onFileCreated(rel);
    for (const rel of changed) {
      if (deleted.has(rel) || added.includes(rel)) continue;
      await this.onFileChanged(rel);
    }
    const result: VerifyResult = {
      checkedAt,
      added: [...added].sort(),
      changed: [...changed].filter((r) => !deleted.has(r) && !added.includes(r)).sort(),
      deleted: [...deleted].sort(),
      healed: true,
    };
    logInfo('index.verify', {
      project: this.id,
      added: result.added.length,
      changed: result.changed.length,
      deleted: result.deleted.length,
    });
    this.schedulePersist();
    return result;
  }

  // ---------------------------------------------------------------- 忽略规则

  /** 重新读取忽略规则文件（watcher 检测到 .gitignore / .wcrignore 变更时用）。 */
  async reloadIgnore(): Promise<void> {
    await this.ignore.reload(this.root);
  }

  ignoresDir(rel: string, name: string): boolean {
    return this.ignore.ignoresDir(rel, name);
  }

  ignoresFile(rel: string): boolean {
    return this.ignore.ignoresFile(rel);
  }

  /** chokidar 的 `ignored` 回调入口（拿不到类型时按目录口径剪枝）。 */
  ignoresPath(rel: string, isDir = true): boolean {
    return this.ignore.ignoresPath(rel, isDir);
  }

  /** 忽略规则现状 + 命中统计（P8 端点用）。 */
  ignoreInfo(): IgnoreInfo {
    return this.ignore.info(this.ignoredCount);
  }

  /** 释放定时器（registry 关闭项目时调用）。 */
  dispose(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
  }

  /**
   * S9c：释放内存索引（宿主收起面板时调用）。
   * 只丢内存里的索引与缓存，不碰磁盘、不注销项目；再次访问时 `reindexAll()` 会重建。
   * indexVersion 自增是为了让着色 / 概览这些按版本缓存的派生结果一并失效。
   */
  release(): void {
    this.clearIndex();
    this.skipLog.clear();
    this.status.filesIndexed = 0;
    this.status.filesTotal = 0;
    this.status.progress = 0;
    this.status.indexing = false;
    this.status.indexedAt = null;
    this.indexVersion += 1;
    this.dispose();
  }

  // ---------------------------------------------------------------- 查询

  abs(rel: string): string {
    return rel ? path.posix.join(this.root, rel) : this.root;
  }

  /** 安全校验：解析后的绝对路径必须落在项目根内（防路径穿越）。 */
  resolveInside(rel: string): string | null {
    const abs = path.resolve(this.abs(rel));
    const normalizedRoot = path.resolve(this.root);
    if (abs !== normalizedRoot && !abs.startsWith(normalizedRoot + path.sep)) return null;
    return abs;
  }

  hint(): ModuleHint {
    return {
      exists: (rel: string) => {
        if (!rel) return true;
        const clean = rel.replace(/\/+$/, '');
        return this.dirs.has(clean) || this.entries.has(clean) || this.files.has(clean);
      },
      files: () => this.entries.keys(),
      classFiles: (name: string) => this.classMap.get(name) ?? [],
      projectMeta: this.projectMeta,
    };
  }

  langOf(rel: string): LangId {
    const fi = this.files.get(rel);
    if (fi) return fi.lang;
    return langForFile(rel);
  }

  /** 取正文（供查看）：源码走索引缓存，其它按需读取并按 LRU 缓存。 */
  async readText(
    rel: string,
  ): Promise<{ text: string; lang: LangId; size: number; truncated: boolean } | null> {
    const fi = await this.ensureText(rel);
    if (!fi) return null;
    return { text: fi.source, lang: fi.lang, size: fi.size, truncated: false };
  }

  /** 确保拿到某个文件的正文字段（已索引 / 已缓存 / 现读），二进制与超大文件返回 null。 */
  private async ensureText(rel: string): Promise<FileIndex | null> {
    const indexed = this.files.get(rel);
    if (indexed) return indexed;
    const cached = this.textCache.get(rel);
    if (cached) return cached;
    const abs = this.resolveInside(rel);
    if (!abs) return null;
    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch {
      return null;
    }
    if (!stat.isFile() || stat.size > MAX_VIEW_BYTES) return null;
    let source: string;
    let encoding: string;
    try {
      const buf = await fsp.readFile(abs);
      // 含 NUL 判二进制；但带 BOM 的 UTF-16 是文本（P12）
      if (looksBinary(buf)) return null;
      const decoded = decodeBuffer(buf);
      source = decoded.text;
      encoding = decoded.encoding;
    } catch {
      return null;
    }
    this.noteEncoding(encoding);
    const spec = specForFile(rel);
    const lang: LangId = langForFile(rel);
    const fi = plainFileIndex(rel, source, lang, { mtimeMs: stat.mtimeMs, size: stat.size });
    fi.encoding = encoding;
    this.cacheText(fi);
    // 非源码文件不计入报告（P9 只解释「源码为什么没索引上」）
    if (!spec) this.skipLog.delete(rel);
    return fi;
  }

  private cacheText(fi: FileIndex) {
    if (this.textCache.size >= 2000) {
      const firstKey = this.textCache.keys().next().value;
      if (firstKey) this.textCache.delete(firstKey);
    }
    this.textCache.set(fi.file, fi);
  }

  /**
   * 一个文件的状态：能不能预览、为什么不能（前端要据此说清「太大」还是「二进制」）。
   * 读盘失败（不存在）返回 null。
   */
  fileStatus(rel: string): { size: number; binary: boolean } | null {
    const known = this.allFiles.get(rel);
    if (known) return { size: known.size, binary: known.binary };
    const entry = this.entries.get(rel);
    if (entry) return { size: entry.size, binary: isBinaryName(rel) };
    return null;
  }

  /**
   * 全部文件的树（2026-10-03）：只跳过噪声目录（node_modules / .git 那类），
   * 被规则忽略的、二进制的、超大的文件都出现在树上，各自标出自己的状态。
   * 与 buildFileTree 的区别：后者只给「可索引的候选文件」。
   */
  buildAllFileTree(): FileNode {
    const root: FileNode = { name: this.name, path: '', type: 'directory', count: 0, children: [] };
    const dirNodes = new Map<string, FileNode>();
    dirNodes.set('', root);
    for (const dir of [...this.dirs].sort()) {
      const parts = dir.split('/');
      const parent = dirNodes.get(parts.slice(0, -1).join('/'));
      if (!parent) continue;
      const node: FileNode = { name: parts[parts.length - 1], path: dir, type: 'directory', count: 0, children: [] };
      parent.children?.push(node);
      dirNodes.set(dir, node);
    }
    for (const rel of [...this.allFiles.keys()].sort()) {
      const parts = rel.split('/');
      const parent = dirNodes.get(parts.slice(0, -1).join('/'));
      if (!parent) continue;
      const info = this.allFiles.get(rel)!;
      const indexed = this.files.has(rel) || this.textCache.has(rel);
      parent.children?.push({
        name: parts[parts.length - 1],
        path: rel,
        type: 'file',
        size: info.size,
        lang: langForFile(rel),
        binary: info.binary,
        indexed,
      });
    }
    const countFiles = (n: FileNode): number => {
      if (n.type === 'file') return 1;
      let total = 0;
      for (const c of n.children ?? []) total += countFiles(c);
      n.count = total;
      return total;
    };
    countFiles(root);
    return root;
  }

  buildFileTree(): FileNode {
    const root: FileNode = { name: this.name, path: '', type: 'directory', count: 0, children: [] };
    const childrenOf = new Map<string, FileNode>();
    childrenOf.set('', root);
    const sorted = [...this.entries.keys()].sort();
    for (const rel of sorted) {
      const info = this.entries.get(rel);
      if (!info) continue;
      const parts = rel.split('/');
      const name = parts[parts.length - 1];
      const parentPath = parts.slice(0, -1).join('/');
      const parent = childrenOf.get(parentPath);
      if (!parent) continue;
      const node: FileNode = {
        name,
        path: rel,
        type: info.dir ? 'directory' : 'file',
        children: info.dir ? [] : undefined,
        size: info.dir ? undefined : info.size,
      };
      if (!info.dir) {
        const spec = specForFile(rel);
        node.lang = spec ? spec.id : 'plaintext';
      }
      parent.children!.push(node);
      if (info.dir) childrenOf.set(rel, node);
    }
    const countFiles = (n: FileNode): number => {
      if (n.type === 'file') return 1;
      let total = 0;
      for (const c of n.children ?? []) total += countFiles(c);
      n.count = total;
      return total;
    };
    countFiles(root);
    return root;
  }

  /**
   * 全项目文本搜索。
   * @param signal 请求中断（N12）：文件循环与行循环双层检查，中止即停。
   * @param onFile 每扫完一个命中文件回调一次（N12 流式返回：结果边出边看）。
   */
  async searchText(
    query: string,
    options: SearchOptions = {},
    signal?: AbortSignal,
    onFile?: (matches: SearchMatch[], truncated: boolean) => void,
  ): Promise<SearchResult> {
    const maxResults = Math.max(1, Math.min(options.maxResults ?? 500, 5000));
    const flags = options.caseSensitive ? 'g' : 'gi';
    let pattern: RegExp;
    try {
      const body = options.regex ? query : escapeRegExp(query);
      pattern = new RegExp(options.wholeWord ? `\\b(?:${body})\\b` : body, flags);
    } catch (e) {
      throw new Error(`invalid regex: ${e instanceof Error ? e.message : String(e)}`);
    }
    const fileFilter = options.filePattern ? globToRegExp(options.filePattern) : null;
    // N14：目录限定用前缀匹配，避免把目录展开成上千条文件列表传给后端
    const dirs = (options.dirs ?? []).filter((d) => d.length > 0);
    const inDirs = (rel: string) =>
      !dirs.length || dirs.some((d) => rel === d || rel.startsWith(d.endsWith('/') ? d : `${d}/`));
    const matches: SearchMatch[] = [];
    let truncated = false;
    // 全项目搜索：已索引源码 + 其余可读文本文件（按需读取、按 LRU 缓存）
    const candidates: string[] = [];
    if (options.files?.length) {
      candidates.push(...options.files);
    } else {
      for (const [rel, info] of this.entries) {
        if (!info.dir && info.size <= MAX_VIEW_BYTES) candidates.push(rel);
      }
    }
    for (const rel of candidates) {
      // N12：请求中断即停止扫描（文件级 / 行级双层检查）
      if (signal?.aborted) break;
      if (fileFilter && !fileFilter.test(rel)) continue;
      if (!inDirs(rel)) continue;
      const fi = await this.ensureText(rel);
      if (!fi) continue;
      const lines = fi.source.split(/\r?\n/);
      const before = matches.length;
      for (let i = 0; i < lines.length; i++) {
        if (signal?.aborted) break;
        const line = lines[i];
        pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = pattern.exec(line)) !== null) {
          if (m[0] === '' && pattern.lastIndex === m.index) pattern.lastIndex++;
          matches.push({
            file: rel,
            range: { start: { line: i + 1, col: m.index + 1 }, end: { line: i + 1, col: m.index + m[0].length + 1 } },
            lineText: line.length > 400 ? line.slice(0, 400) : line,
            index: matches.length,
          });
          if (matches.length >= maxResults) {
            truncated = true;
            break;
          }
          if (!pattern.global) break;
        }
        if (truncated) break;
      }
      // 流式返回：这个文件的命中刚收集完，先交给调用方（N12）
      if (onFile && matches.length > before) onFile(matches.slice(before), truncated);
      if (truncated) break;
    }
    return { query, matches, fileCount: new Set(matches.map((m) => m.file)).size, truncated };
  }
}

/** 快照恢复的中间结果：header（项目级事实）+ 扫描结果（增量 diff 用）。 */
interface RestoredSnapshot {
  header: SnapshotHeader;
  entries: Map<string, EntryInfo>;
  /** 快照行里带了正文（旧格式）→ 需要重写为瘦身版。 */
  needsRewrite: boolean;
}

type PreparedFile =
  | {
      ok: true;
      rel: string;
      text: string;
      encoding: string;
      langId: string;
      mtimeMs: number;
      size: number;
      degraded: boolean;
    }
  | { ok: false; rel: string };

/** 串行解析一个任务（worker 池不可用时的回落路径）。 */
function serialParse(task: ParseTask): ParseResult {
  const spec = specForFile(task.rel);
  if (!spec) return { ok: false, error: `unknown file: ${task.rel}` };
  try {
    const fi = indexSource(
      task.rel,
      task.source,
      spec,
      { mtimeMs: task.mtimeMs, size: task.size },
      { topLevelOnly: task.topLevelOnly },
    );
    return { ok: true, data: serializeFileIndex(fi) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 并发映射（保序），limit 为并发上限。 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

function sameRange(a: { range: { start: { line: number; col: number } } }, b: { range: { start: { line: number; col: number } } }): boolean {
  return a.range.start.line === b.range.start.line && a.range.start.col === b.range.start.col;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/\u0000/g, '.*');
  return new RegExp(`(^|/)${body}$`, 'i');
}
