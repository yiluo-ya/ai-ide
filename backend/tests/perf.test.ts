/**
 * P23 性能守护：1000 文件合成仓的「冷启动索引 / 快照二次加载 / 跳转 P95」。
 *
 * 定位是**守护**而不是基准：阈值放宽到「性能崩塌 / 退化数倍」才失败，避免 CI 抖动假红；
 * 真实数字与 Q5 预算判定看 `npm run bench`（backend/bench/bench.ts）。
 * 想按 Q5 的严格口径跑（本机复现）：READER_PERF_STRICT=1 npm test。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ProjectIndex } from '../src/indexer/store';
import { gotoDefinition } from '../src/indexer/resolver';
import { writeSynthRepo } from '../bench/synth';

const FILES = 1000;

/**
 * 严格模式 = 06-platform-plan Q5 的 1k 等价口径（本机实测：索引 10~12s / 二次加载 1.0s / goto P95 < 1ms）。
 * 二次加载阈值本轮快照瘦身后收紧到 1500ms：改前（快照落正文）实测 1.87s 会红，改后 1.0s 通过（留 1.5x 抖动余量）。
 */
const STRICT = process.env.READER_PERF_STRICT === '1';
const LIMITS = STRICT
  ? { indexMs: 20_000, secondLoadMs: 1_500, gotoP95Ms: 1_000 }
  : { indexMs: 60_000, secondLoadMs: 20_000, gotoP95Ms: 1_000 }; // CI 宽松：只拦「崩塌到分钟级」

/**
 * 压测默认关闭（用户 2026-10-03：压测我自己跑，不要每次都测）。
 * 要跑：READER_PERF=1 npm test（或直接单跑本文件）。
 */
const PERF_ON = process.env.READER_PERF === '1';

(PERF_ON ? test : test.skip)(
  'perf: 1000 文件合成仓（索引 / 快照二次加载 / goto P95）',
  { timeout: 240_000 },
  async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-perf-'));
  const root = path.join(base, 'repo');
  const dataDir = path.join(base, 'data');
  await fsp.mkdir(root, { recursive: true });
  const posixRoot = root.split(path.sep).join('/');
  let cold: ProjectIndex | null = null;
  let warm: ProjectIndex | null = null;
  try {
    const repo = await writeSynthRepo(root, FILES);

    cold = new ProjectIndex('perf', 'perf', posixRoot, Date.now(), { dataDir, persist: true });
    const t0 = performance.now();
    await cold.reindexAll();
    const indexMs = performance.now() - t0;
    assert.equal(cold.files.size, FILES, '所有合成文件都应进入索引');
    assert.ok(indexMs < LIMITS.indexMs, `冷启动索引 ${indexMs.toFixed(0)}ms 超过守护阈值 ${LIMITS.indexMs}ms`);

    warm = new ProjectIndex('perf', 'perf', posixRoot, Date.now(), { dataDir, persist: true });
    const t1 = performance.now();
    await warm.reindexAll();
    const secondMs = performance.now() - t1;
    assert.equal(warm.snapshotStatus().fresh, true, '无变更时应命中快照（指纹一致）');
    assert.equal(warm.files.size, FILES, '快照恢复后的文件数应完整');
    assert.ok(
      secondMs < LIMITS.secondLoadMs,
      `二次加载 ${secondMs.toFixed(0)}ms 超过守护阈值 ${LIMITS.secondLoadMs}ms`,
    );
    assert.ok(secondMs < indexMs, '二次加载必须快于全量索引（否则快照没有意义）');

    // 跳转：既看 P95，也要求「真的跳到定义」——不能快但答不出来
    const samples: number[] = [];
    let resolved = 0;
    for (let i = 0; i < 20; i++) {
      const pt = repo.gotoPoints[i % repo.gotoPoints.length];
      const t = performance.now();
      const out = gotoDefinition(warm, pt.file, pt.line, pt.col);
      samples.push(performance.now() - t);
      if (out.reason === 'resolved' && out.locations.length > 0) resolved++;
    }
    const sorted = samples.slice().sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
    assert.ok(p95 < LIMITS.gotoP95Ms, `goto P95 ${p95.toFixed(1)}ms 超过阈值 ${LIMITS.gotoP95Ms}ms`);
    assert.equal(resolved, 20, '跨文件调用点都应解析到定义');
  } finally {
    cold?.dispose();
    warm?.dispose();
    await fsp.rm(base, { recursive: true, force: true }).catch(() => undefined);
  }
  },
);
