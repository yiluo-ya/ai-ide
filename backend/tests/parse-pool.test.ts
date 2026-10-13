/**
 * P5 并行解析池单测：同一批文件并行与串行结果一致（逐文件比对 definitions / references /
 * imports 的关键字段）；`workers=0`（size<=1）强制串行；worker 不可用时回落串行仍可用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParsePool, batchTimeoutMs, type ParseTask } from '../src/indexer/parse-pool';

const TS = 'import { helper } from "./util";\n\nexport function use(x: number): number {\n  return helper(x) + 1;\n}\n';
const PY = 'import os\n\n\ndef use(path):\n    return os.path.join(path, "x")\n';
const GO = 'package main\n\nfunc Use(x int) int {\n\treturn x + 1\n}\n';

const tasks: ParseTask[] = [
  { rel: 'src/a.ts', source: TS, langId: 'typescript', mtimeMs: 1, size: Buffer.byteLength(TS) },
  { rel: 'src/b.py', source: PY, langId: 'python', mtimeMs: 2, size: Buffer.byteLength(PY) },
  { rel: 'src/c.go', source: GO, langId: 'go', mtimeMs: 3, size: Buffer.byteLength(GO) },
  { rel: 'src/d.ts', source: `export const answer = 42;\n`, langId: 'typescript', mtimeMs: 4, size: 25 },
];

/** 只取「解析事实」的关键字段做比对（AST / 时间戳不在比较范围）。 */
function pickKeyFields(task: ParseTask, result: { ok: boolean; data?: unknown; error?: string }): string {
  if (!result.ok) return `${task.rel}#error:${result.error}`;
  const data = result.data as {
    file: string;
    lang: string;
    definitions: Array<Record<string, unknown>>;
    references: Array<Record<string, unknown>>;
    imports: Array<Record<string, unknown>>;
    scopes: Array<Record<string, unknown>>;
  };
  const defs = data.definitions.map((d) => [d.id, d.name, d.kind, d.scopeId, d.range]);
  const refs = data.references.map((r) => [r.name, r.kind, r.scopeId, r.range]);
  const imports = data.imports.map((i) => [i.localName, i.module, i.kind, i.range]);
  return JSON.stringify({ file: data.file, lang: data.lang, defs, refs, imports, scopes: data.scopes.length });
}

test('parse-pool: 并行结果与串行逐文件一致，且顺序保持', async (t) => {
  const serial = new ParsePool(0);
  t.after(() => serial.close());
  const serialResults = await serial.parseBatch(tasks);
  assert.equal(serial.degraded, true, 'workers=0 强制串行');
  assert.deepEqual(
    serialResults.map((r) => (r.ok ? r.data.file : 'x')),
    tasks.map((x) => x.rel),
  );

  const parallel = new ParsePool(3);
  t.after(() => parallel.close());
  const parallelResults = await parallel.parseBatch(tasks);
  if (parallel.degraded) t.diagnostic('本机 worker 不可用，已回落串行（一致性仍验证）');
  assert.deepEqual(
    parallelResults.map((r) => (r.ok ? r.data.file : 'x')),
    tasks.map((x) => x.rel),
  );

  for (let i = 0; i < tasks.length; i++) {
    const a = serialResults[i];
    const b = parallelResults[i];
    assert.equal(b.ok, a.ok, `${tasks[i].rel} 的 ok 状态应一致`);
    assert.equal(pickKeyFields(tasks[i], b), pickKeyFields(tasks[i], a), `${tasks[i].rel} 的解析事实应一致`);
  }

  // 串行结果与「直接解析」也一致，避免两条路一起错
  assert.ok(serialResults.every((r) => r.ok));
  for (const r of serialResults) {
    if (r.ok) assert.ok(r.data.definitions.length > 0, `${r.data.file} 应解析出定义`);
  }
});

test('parse-pool: 空批次与未知语言不抛错', async (t) => {
  const pool = new ParsePool(2);
  t.after(() => pool.close());
  assert.deepEqual(await pool.parseBatch([]), []);

  const bad: ParseTask[] = [{ rel: 'src/x.unknown', source: 'x', langId: 'klingon', mtimeMs: 1, size: 1 }];
  const serial = new ParsePool(0);
  t.after(() => serial.close());
  const viaSerial = await serial.parseBatch(bad);
  const viaPool = await pool.parseBatch(bad);
  assert.equal(viaSerial[0].ok, false);
  assert.equal(viaPool[0].ok, false);
  if (!viaSerial[0].ok && !viaPool[0].ok) {
    assert.match(viaSerial[0].error, /unknown language/);
  }
});

test('parse-pool: close 后不再创建新 worker（已降级为串行）', async (t) => {
  const pool = new ParsePool(2);
  await pool.close();
  t.after(() => pool.close());
  const results = await pool.parseBatch(tasks);
  assert.equal(results.length, tasks.length);
  assert.deepEqual(
    results.map((r) => (r.ok ? r.data.file : 'x')),
    tasks.map((x) => x.rel),
  );
});

test('parse-pool: 批级超时快速标失败，不拖死后续批次', async (t) => {
  // 1ms 固定超时：worker 起线程必然超过它 —— 复现「病态批卡住」的场景
  const timing = new ParsePool(2, 1);
  t.after(() => timing.close());
  const t0 = Date.now();
  const timedOut = await timing.parseBatch(tasks);
  const elapsed = Date.now() - t0;
  assert.equal(timedOut.length, tasks.length, '结果数应与任务数一致');
  for (const r of timedOut) {
    assert.equal(r.ok, false, '超时批应整体标失败，而不是无限等待');
    if (!r.ok) assert.match(r.error, /parse timeout/);
  }
  assert.ok(elapsed < 10_000, `超时批应快速返回（实际 ${elapsed}ms）`);

  // 正常批次不受影响（另一条池，走默认动态预算；超时的 worker 已退休、会补建）
  const normal = new ParsePool(2);
  t.after(() => normal.close());
  const ok = await normal.parseBatch([
    { rel: 'src/e.ts', source: 'export const e = 1;\n', langId: 'typescript', mtimeMs: 5, size: 25 },
  ]);
  assert.equal(ok[0].ok, true, '正常批次不应受影响');
});

test('parse-pool: 批超时预算随批大小放宽且有上下限', () => {
  const one = (size: number): ParseTask => ({ rel: 'a.ts', source: '', langId: 'typescript', mtimeMs: 0, size });
  assert.equal(batchTimeoutMs([one(100)]), 5_000, '小批走下限');
  assert.equal(batchTimeoutMs(Array.from({ length: 16 }, () => one(600_000))), 30_000, '大批走上限（~9.4MB）');
  assert.equal(batchTimeoutMs(Array.from({ length: 16 }, () => one(400_000))), 20_750, '中等批按 3ms/KB 放宽');
  assert.equal(batchTimeoutMs(Array.from({ length: 16 }, () => one(50_000))), 5_000, '800KB 批仍在下限内');
});
