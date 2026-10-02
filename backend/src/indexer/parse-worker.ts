/**
 * 解析 worker（P5）：在独立线程里跑 tree-sitter，只回传纯数据（SerializedParsed）。
 *
 * 由 `parse-pool.ts` 以 `new Worker(new URL('./parse-worker.ts', import.meta.url), { execArgv: ['--import','tsx'] })`
 * 拉起；worker 内动态 import 解析器，避免主线程与 worker 的语法包状态互相影响（Q9：每个 worker 独立 Parser 实例）。
 */
import { parentPort } from 'node:worker_threads';
import type { SerializedParsed } from './model';

export interface WorkerParseTask {
  rel: string;
  source: string;
  langId: string;
  mtimeMs: number;
  size: number;
  topLevelOnly?: boolean;
}

export type WorkerParseResult = { ok: true; data: SerializedParsed } | { ok: false; error: string };

interface WorkerRequest {
  id: number;
  tasks: WorkerParseTask[];
}

const port = parentPort;
if (!port) throw new Error('parse-worker must be loaded as a worker thread');
const channel = port;

channel.on('message', (msg: WorkerRequest) => {
  void handle(msg);
});

async function handle(msg: WorkerRequest) {
  let results: WorkerParseResult[];
  try {
    const { indexSource, serializeFileIndex } = await import('./parser');
    const { specById } = await import('../languages/index');
    results = [];
    for (const task of msg.tasks) {
      try {
        const spec = specById(task.langId);
        if (!spec) {
          results.push({ ok: false, error: `unknown language: ${task.langId}` });
          continue;
        }
        const fi = indexSource(
          task.rel,
          task.source,
          spec,
          { mtimeMs: task.mtimeMs, size: task.size },
          { topLevelOnly: task.topLevelOnly },
        );
        results.push({ ok: true, data: serializeFileIndex(fi) });
      } catch (e) {
        results.push({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    results = msg.tasks.map(() => ({ ok: false, error }));
  }
  channel.postMessage({ id: msg.id, results });
}
