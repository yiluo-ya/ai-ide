/**
 * 并行解析池（P5 / Q9）：worker_threads 分批解析，worker 不可用时自动回落主线程串行。
 *
 * 设计约束：
 * - 只回传纯数据，`FileIndex` 的组装（`source` / `text` / `tree=null`）在主线程完成；
 * - worker 创建 / 执行失败（tsx 不可用、平台限制）→ logWarn 一次并整体回落串行，功能不因此不可用；
 * - `size <= 1` 直接串行（`READER_PARSE_WORKERS=0` 走这条路）；
 * - **批级墙钟超时**：个别病态文件（生成物 / 超长行）会让 tree-sitter 偶发解析数十秒，
 *   一条卡住的批能把整轮全量索引从十几秒拖到分钟级。超时即退休该 worker、
 *   本批标失败（不重跑），其它批不受影响。
 */
import { Worker } from 'node:worker_threads';
import { logWarn } from '../log';
import type { SerializedParsed } from './model';
import { indexSource, serializeFileIndex } from './parser';
import { specById } from '../languages';

export interface ParseTask {
  rel: string;
  source: string;
  langId: string;
  mtimeMs: number;
  size: number;
  /** P11：大文件降级（只取顶层符号与导入）。 */
  topLevelOnly?: boolean;
}

export type ParseResult = { ok: true; data: SerializedParsed } | { ok: false; error: string };

/** 批级超时的下限 / 上限（单批 16 文件、正常 1s 内跑完）。 */
const MIN_BATCH_TIMEOUT_MS = 5_000;
const MAX_BATCH_TIMEOUT_MS = 30_000;
/** 每 KB 源码给的余量：正常解析 1KB≈0.1ms，这里放 3ms/KB，只为拦住「病态文件」。 */
const BATCH_TIMEOUT_MS_PER_KB = 3;

/**
 * 一批任务的超时预算：随批内总字节放宽，但有上下限。
 * 下限保证正常慢批不被误杀；上限保证病态批不会拖死整轮索引。
 */
export function batchTimeoutMs(tasks: ParseTask[]): number {
  const kb = tasks.reduce((a, t) => a + t.size, 0) / 1024;
  return Math.min(MAX_BATCH_TIMEOUT_MS, Math.max(MIN_BATCH_TIMEOUT_MS, 2_000 + kb * BATCH_TIMEOUT_MS_PER_KB));
}

interface WorkerReply {
  id: number;
  results: ParseResult[];
}

export class ParsePool {
  private workers: Worker[] = [];
  private pending = new Map<number, { resolve: (r: ParseResult[]) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private broken = false;
  private closed = false;

  constructor(
    private readonly size: number,
    /** 固定批超时（毫秒）；`0`（默认）= 按批大小动态算，见 `batchTimeoutMs`。单测用小值注入。 */
    private readonly timeoutMs = 0,
  ) {}

  /**
   * 一批解析任务 → 与输入同序的结果。
   * worker 路径出问题时最终仍会返回结果（串行补齐），不抛错给调用方。
   */
  async parseBatch(tasks: ParseTask[]): Promise<ParseResult[]> {
    if (!tasks.length) return [];
    if (this.broken || this.size <= 1) return this.serial(tasks);
    try {
      const workers = this.ensureWorkers();
      if (!workers.length) return this.serial(tasks);
      const chunks = splitInto(tasks, this.size);
      const parts = await Promise.all(chunks.map((chunk, i) => this.runOn(workers[i % workers.length], chunk)));
      return parts.flat();
    } catch (e) {
      this.fallback(e);
      return this.serial(tasks);
    }
  }

  /** 关闭并回收全部 worker。 */
  async close(): Promise<void> {
    this.closed = true;
    const workers = this.takeWorkers();
    for (const [, p] of this.pending) p.reject(new Error('parse pool closed'));
    this.pending.clear();
    await Promise.all(workers.map((w) => w.terminate().catch(() => undefined)));
  }

  /** 是否已因 worker 不可用而降级为串行（供测试断言）。 */
  get degraded(): boolean {
    return this.broken || this.size <= 1;
  }

  private serial(tasks: ParseTask[]): ParseResult[] {
    return tasks.map((task) => {
      try {
        const spec = specById(task.langId);
        if (!spec) return { ok: false as const, error: `unknown language: ${task.langId}` };
        const fi = indexSource(
          task.rel,
          task.source,
          spec,
          { mtimeMs: task.mtimeMs, size: task.size },
          { topLevelOnly: task.topLevelOnly },
        );
        return { ok: true as const, data: serializeFileIndex(fi) };
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
      }
    });
  }

  private ensureWorkers(): Worker[] {
    // close 后不再补建（已降级为串行）。
    if (this.closed) return this.workers;
    if (this.workers.length >= this.size) return this.workers;
    const url = new URL('./parse-worker.ts', import.meta.url);
    const created = this.workers;
    for (let i = created.length; i < this.size; i++) {
      const worker = new Worker(url, { execArgv: ['--import', 'tsx'] });
      worker.on('message', (msg: WorkerReply) => {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        pending.resolve(msg.results);
      });
      worker.on('error', (err: Error) => this.failWorker(err));
      worker.on('exit', (code: number) => {
        if (code !== 0) this.failWorker(new Error(`parse worker exited with code ${code}`));
      });
      created.push(worker);
    }
    this.workers = created;
    return created;
  }

  private takeWorkers(): Worker[] {
    const workers = this.workers;
    this.workers = [];
    for (const w of workers) w.removeAllListeners();
    return workers;
  }

  private failWorker(err: Error) {
    if (this.closed) return;
    this.noteFallback(err);
    for (const [id, p] of this.pending) {
      p.reject(err);
      this.pending.delete(id);
    }
    for (const w of this.takeWorkers()) void w.terminate().catch(() => undefined);
  }

  private fallback(e: unknown) {
    this.noteFallback(e instanceof Error ? e : new Error(String(e)));
  }

  private noteFallback(err: Error) {
    if (this.broken) return;
    this.broken = true;
    logWarn('parse.pool.fallback', { reason: err.message });
  }

  private runOn(worker: Worker, tasks: ParseTask[]): Promise<ParseResult[]> {
    const id = this.nextId++;
    const timeoutMs = this.timeoutMs > 0 ? this.timeoutMs : batchTimeoutMs(tasks);
    return new Promise<ParseResult[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        logWarn('parse.pool.timeout', { files: tasks.length, timeoutMs, sample: tasks[0]?.rel });
        // 退休这个 worker（下次 parseBatch 由 ensureWorkers 补建），本批整体标失败。
        // **不重跑**：重跑会再卡一次；失败的文件会被上层记进 skipLog，可排障。
        void this.retireWorker(worker);
        resolve(tasks.map(() => ({ ok: false as const, error: `parse timeout after ${timeoutMs}ms` })));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        worker.postMessage({ id, tasks });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** 退休一个卡住的 worker：从池里摘掉并 terminate（不影响其它 worker 与 pending 任务）。 */
  private async retireWorker(worker: Worker): Promise<void> {
    this.workers = this.workers.filter((w) => w !== worker);
    worker.removeAllListeners();
    await worker.terminate().catch(() => undefined);
  }
}

/** 按顺序把任务切成至多 n 块（保持原顺序，便于结果按序拼回）。 */
function splitInto<T>(items: T[], n: number): T[][] {
  const count = Math.max(1, Math.min(n, items.length));
  const per = Math.ceil(items.length / count);
  const chunks: T[][] = [];
  for (let i = 0; i < count; i++) {
    const chunk = items.slice(i * per, (i + 1) * per);
    if (chunk.length) chunks.push(chunk);
  }
  return chunks;
}
