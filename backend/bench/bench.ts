/**
 * P23 性能基准：合成仓库 → 冷启动索引 / 快照二次加载 / 查询 P50·P95 / 增量更新，
 * 最后输出对照（`docs/06-platform-plan.md` §1 Q5 的五个数字 + 预算判定）。
 *
 * 跑法（backend 目录下）：
 *   npm --prefix backend run bench                 # 默认 1000 文件
 *   node --import tsx backend/bench/bench.ts --files=10000 --workers=4
 *   ... --files=1000 --keep                        # 保留临时仓库便于排查
 *
 * 说明：
 * - 仓库与数据目录都在系统临时目录里，默认跑完删除（不碰 `data/`，不写被读目录以外的东西）；
 * - 查询基准各跑 20 次取 P50 / P95（与 §1 Q5 的口径一致）；
 * - 10k 文件约 1.5M 行，耗时以分钟计，建议后台跑。
 */
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ProjectIndex } from '../src/indexer/store';
import { findReferences, gotoDefinition, workspaceSymbols } from '../src/indexer/resolver';
import { writeSynthRepo } from './synth';

// ------------------------------------------------------------------ 预算（06-platform-plan §1 Q5）

const BUDGET = {
  firstOpenMs: 2000, // 万级文件仓库 · 首开可交互（文件树 + 打开文件）
  fullIndexMs: 60_000, // 万级文件仓库 · 索引完成
  queryP50Ms: 150, // 索引完成后的查询 P50
  queryP95Ms: 500, // 索引完成后查询 P95
  incrementalMs: 1000, // 单文件改动 → 新符号可查
};

/**
 * 二次打开的预算按规模分档：
 * - 1k 用 Q5 原始口径（文件树 ≤500ms / 符号 ≤1500ms，`docs/06-platform-plan.md` §1 Q5）；
 * - 10k 用万级放宽口径（文件树 ≤1s / 符号 ≤3s）：Q5 的 500/1500 是 1k 档标定值，
 *   万级下扫描 + 快照恢复 + 增量 diff 的 IO 量不是常数（实测 1k 文件树 300ms 量级）。
 */
function secondOpenBudget(files: number): { treeMs: number; jumpMs: number; note: string } {
  return files >= 10_000
    ? { treeMs: 1000, jumpMs: 3000, note: '万级放宽口径（Q5 万级行）' }
    : { treeMs: 500, jumpMs: 1500, note: 'Q5 原始口径（1k 档）' };
}

const QUERY_ROUNDS = 20;

// ------------------------------------------------------------------ 计时工具

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

const ms = (n: number): string => `${n.toFixed(1)} ms`;

interface Row {
  scenario: string;
  measured: string;
  budget: string;
  verdict: string;
}

function judge(measuredMs: number, budgetMs: number, scaleNote: string): string {
  return `${measuredMs <= budgetMs ? 'PASS' : 'OVER'}${scaleNote}`;
}

/**
 * 读盘探针（W22）：统计 `fs.readFileSync` + `fs/promises.readFile` 的次数，
 * 用于证明「二次打开不读正文」—— 文件树 / 符号表 / 增量 diff 全部走内存。
 * 忽略规则文件（`.gitignore` / `.wcrignore`）是 scan 阶段读的，不计入正文读盘。
 */
function startReadProbe(): { stop: () => string[] } {
  const realSync = fs.readFileSync;
  const realAsync = fsp.readFile;
  const paths: string[] = [];
  const note = (args: unknown[]): void => {
    const p = args[0];
    if (typeof p === 'string' && !/(^|[\\/])\.(git|wcr)ignore$/.test(p)) paths.push(p);
  };
  (fs as unknown as { readFileSync: unknown }).readFileSync = (...args: unknown[]) => {
    note(args);
    return (realSync as (...a: unknown[]) => unknown)(...args);
  };
  (fsp as unknown as { readFile: unknown }).readFile = (...args: unknown[]) => {
    note(args);
    return (realAsync as (...a: unknown[]) => unknown).apply(fsp, args);
  };
  return {
    stop: () => {
      (fs as unknown as { readFileSync: unknown }).readFileSync = realSync;
      (fsp as unknown as { readFile: unknown }).readFile = realAsync;
      return paths;
    },
  };
}

// ------------------------------------------------------------------ 主流程

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const numArg = (name: string, fallback: number): number => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? Number(hit.split('=')[1]) : fallback;
  };
  const files = numArg('files', 1000);
  const workers = numArg('workers', -1); // -1 = 用 config 默认（并行）
  const keep = argv.includes('--keep');

  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-bench-'));
  const root = path.join(base, 'repo');
  const dataDir = path.join(base, 'data');
  await fsp.mkdir(root, { recursive: true });
  const scaleNote = files >= 10_000 ? '' : '（1k 规模，非万级预算）';
  const second = secondOpenBudget(files);
  const rows: Row[] = [];
  let project: ProjectIndex | null = null;
  let project2: ProjectIndex | null = null;

  try {
    const tGen = performance.now();
    const repo = await writeSynthRepo(root, files);
    const genMs = performance.now() - tGen;
    console.log(
      `\n=== P23 性能基准 · 合成仓 ${files} 文件（${repo.ts} TS + ${repo.py} Python，约 ${repo.lines} 行） ===`,
    );
    console.log(`生成仓库：${ms(genMs)}  →  ${base}\n`);

    const opts = { dataDir, persist: true, ...(workers >= 0 ? { workers } : {}) };

    // [1/4] 冷启动：首开可交互（scan + 打开一个文件）与全量索引
    console.log('[1/4] 冷启动');
    project = new ProjectIndex('bench', 'bench', root, Date.now(), opts);
    const tFirst = performance.now();
    await project.scan();
    await project.readText(repo.firstFile);
    const firstOpenMs = performance.now() - tFirst;
    const tFull = performance.now();
    await project.reindexAll();
    const fullIndexMs = performance.now() - tFull;
    console.log(
      `  索引后：files.size=${project.files.size} filesTotal=${project.status.filesTotal} ` +
        `error=${project.status.error ?? 'null'}`,
    );
    if (project.skipLog.size) {
      console.log(
        `  未索引 ${project.skipLog.size} 个：` +
          [...project.skipLog.entries()]
            .slice(0, 5)
            .map(([rel, info]) => `${rel}(${info.reason})`)
            .join(', '),
      );
    }
    rows.push({
      scenario: '首开可交互（文件树 + 打开文件）',
      measured: ms(firstOpenMs),
      budget: `≤ ${BUDGET.firstOpenMs} ms`,
      verdict: judge(firstOpenMs, BUDGET.firstOpenMs, scaleNote),
    });
    rows.push({
      scenario: '索引完成（全量）',
      measured: ms(fullIndexMs),
      budget: `≤ ${BUDGET.fullIndexMs} ms`,
      verdict: judge(fullIndexMs, BUDGET.fullIndexMs, scaleNote),
    });

    // [2/4] 二次打开：快照命中（同 dataDir、同 root、无变更）
    console.log('\n[2/4] 二次打开（快照命中）');
    project2 = new ProjectIndex('bench', 'bench', root, Date.now(), opts);
    const tScan2 = performance.now();
    await project2.scan();
    const secondTreeMs = performance.now() - tScan2;
    const tRestore = performance.now();
    const probe = startReadProbe();
    await project2.reindexAll();
    const restoreReads = probe.stop();
    const secondJumpMs = performance.now() - tRestore;
    console.log(`  快照状态：${JSON.stringify(project2.snapshotStatus())}，恢复文件数=${project2.files.size}`);
    console.log(
      `  恢复期读盘：${restoreReads.length} 次${restoreReads.length ? `（${restoreReads.slice(0, 3).join(', ')}…）` : ''}`,
    );
    rows.push({
      scenario: '二次打开 · 文件树可用',
      measured: ms(secondTreeMs),
      budget: `≤ ${second.treeMs} ms（${second.note}）`,
      verdict: judge(secondTreeMs, second.treeMs, scaleNote),
    });
    rows.push({
      scenario: '二次打开 · 符号可跳转（快照加载）',
      measured: ms(secondJumpMs),
      budget: `≤ ${second.jumpMs} ms（${second.note}）`,
      verdict: judge(secondJumpMs, second.jumpMs, scaleNote),
    });
    rows.push({
      scenario: '二次打开 · 恢复期读盘次数',
      measured: `${restoreReads.length} 次`,
      budget: '0 次（正文懒读）',
      verdict: restoreReads.length === 0 ? `PASS${scaleNote}` : `OVER${scaleNote}`,
    });

    // [3/4] 查询 P50 / P95（各 20 次）
    console.log(`\n[3/4] 查询（各 ${QUERY_ROUNDS} 次）`);
    const measure = async (label: string, run: (i: number) => Promise<void> | void): Promise<void> => {
      const samples: number[] = [];
      for (let i = 0; i < QUERY_ROUNDS; i++) {
        const t = performance.now();
        await run(i);
        samples.push(performance.now() - t);
      }
      const sorted = samples.slice().sort((a, b) => a - b);
      const p50 = pct(sorted, 50);
      const p95 = pct(sorted, 95);
      const ok = p50 <= BUDGET.queryP50Ms && p95 <= BUDGET.queryP95Ms;
      console.log(
        `  ${label.padEnd(18)} P50 ${ms(p50).padStart(10)}   P95 ${ms(p95).padStart(10)}   ${ok ? 'PASS' : 'OVER'}`,
      );
      rows.push({
        scenario: `查询 · ${label}`,
        measured: `P50 ${ms(p50)} / P95 ${ms(p95)}`,
        budget: `P50 ≤ ${BUDGET.queryP50Ms} ms / P95 ≤ ${BUDGET.queryP95Ms} ms`,
        verdict: `${ok ? 'PASS' : 'OVER'}${scaleNote}`,
      });
    };

    const p2 = project2 as ProjectIndex; // 闭包内非空（finally 前一直有效）
    await measure('goto-definition', (i) => {
      const pt = repo.gotoPoints[i % repo.gotoPoints.length];
      gotoDefinition(p2, pt.file, pt.line, pt.col);
    });
    await measure('find-references', (i) => {
      const pt = repo.defPoints[i % repo.defPoints.length];
      findReferences(p2, pt.file, pt.line, pt.col);
    });
    await measure('search', async () => {
      await p2.searchText('helper', { maxResults: 200 });
    });
    await measure('overview（文件树）', () => {
      p2.buildFileTree();
    });

    // [4/4] 增量更新：新增一个文件 → 新符号可查
    console.log('\n[4/4] 增量更新');
    const rel = 'src/bench_incremental.ts';
    await fsp.writeFile(
      path.join(root, ...rel.split('/')),
      'export function BrandNewBenchSymbol(value: number): number {\n  return value + 1;\n}\n',
      'utf8',
    );
    const tInc = performance.now();
    await p2.onFileCreated(rel);
    const found = workspaceSymbols(p2, 'BrandNewBenchSymbol', null, 10);
    const incMs = performance.now() - tInc;
    console.log(`  新符号可查：${found.length > 0 ? '是' : '否'}（${ms(incMs)}）`);
    rows.push({
      scenario: '增量更新（单文件 → 新符号可查）',
      measured: ms(incMs) + (found.length ? '' : ' / 未查到新符号'),
      budget: `≤ ${BUDGET.incrementalMs} ms`,
      verdict: judge(incMs, BUDGET.incrementalMs, scaleNote) + (found.length ? '' : ' + 语义失败'),
    });

    // 预算对照表
    const widths = [36, 32, 30];
    const pad = (s: string, w: number) => (s.length >= w ? s : s + ' '.repeat(w - s.length));
    console.log('\n=== 预算对照（docs/06-platform-plan.md §1 Q5） ===');
    console.log(`${pad('场景', widths[0])}${pad('实测', widths[1])}${pad('预算', widths[2])}判定`);
    for (const r of rows) {
      console.log(`${pad(r.scenario, widths[0])}${pad(r.measured, widths[1])}${pad(r.budget, widths[2])}${r.verdict}`);
    }
    if (files < 10_000) {
      console.log(`\n注：本轮规模为 ${files} 文件；万级（10k）预算需以 --files=10000 复测。`);
    }
    console.log(
      `注：二次打开预算按规模分档 —— ${files} 文件用「${second.note}」（文件树 ≤${second.treeMs}ms / 符号 ≤${second.jumpMs}ms）；` +
        '1k 数字取自 Q5 原文，10k 为万级放宽值（Q5 万级行）。',
    );
    console.log(`临时目录：${keep ? base : '（已删除）'}`);
  } finally {
    project?.dispose();
    project2?.dispose();
    if (!keep) await fsp.rm(base, { recursive: true, force: true }).catch(() => undefined);
  }
}

await main();
