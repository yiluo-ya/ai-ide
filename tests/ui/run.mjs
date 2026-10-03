/**
 * UI 回归启动器（Q18 C 档）：
 * 1) 建一个已知内容的最小夹具项目（不依赖用户本机已有项目，保证断言稳定）；
 * 2) 起后端（静态资源用 frontend/dist，数据目录是本次专用的临时目录）；
 * 3) 跑 navigator.mjs；
 * 4) 收尾：从项目列表移除夹具。
 *
 * 两个曾经真把人卡住的坑（都用守护挡上了，不再靠运气）：
 * - **端口被残留服务占着**：旧服务还在监听时，waitForHealth 会“健康”地连上去，
 *   于是一整轮测试跑在别人/上一轮的状态上 —— 先探一次端口，占用就直接拒绝跑。
 * - **整轮没有上限**：夹具索引或页面卡住时只能靠各步自己的超时（加起来几分钟），
 *   现在有总看门狗，到点杀掉子进程并给明话。
 *
 * 跑法：npm run build && npm run test:ui
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = path.resolve(import.meta.dirname, '../..');
const PORT = process.env.PORT ?? process.env.UI_PORT ?? '8799';
const BASE = `http://127.0.0.1:${PORT}`;
/** 整轮上限：到点就收，不把问题变成“看起来卡死了”（可用 UI_RUN_TIMEOUT_MS 调）。 */
const RUN_TIMEOUT_MS = Number(process.env.UI_RUN_TIMEOUT_MS ?? 8 * 60_000);

/** 夹具：覆盖 N2（外部依赖/未解析）、N4（声明与测试标注）、N15/N16/N17（继承与调用层级）、N25（路径可点）。 */
const FIXTURE = {
  'src/util.ts': `import * as fs from 'fs';

export interface Runner {
  run(): number;
}

export class BaseTask {
  id = 1;
}

/** 被三处引用的核心函数。 */
export function helper(value: number): number {
  return value + fs.constants.O_RDONLY * 0;
}
`,
  'src/service.ts': `import { BaseTask, helper, type Runner } from './util';

export class FastRunner extends BaseTask implements Runner {
  run(): number {
    return helper(1) + helper(2);
  }
}

export function boot(): number {
  const local = { go: () => 3 };
  return local.go();
}

export function shutdown(): void {}

export function restart(): void {}
`,
  'src/main.ts': `import { boot } from './service';

/** 入口：见 src/util.ts 的实现。 */
export function main(): number {
  return boot();
}
`,
  'tests/service.test.ts': `import { boot } from '../src/service';
import { helper } from '../src/util';

export function testHelper(): number {
  return helper(9);
}

export function testBoot(): number {
  return boot();
}
`,
};

async function writeFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-ui-'));
  for (const [rel, content] of Object.entries(FIXTURE)) {
    const abs = path.join(root, ...rel.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf8');
  }
  return root;
}

async function waitForHealth(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await delay(500);
  }
  return false;
}

/** 等夹具索引完成（filesIndexed === filesTotal 且 > 0）。 */
async function waitForIndex(id, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/projects/${id}/status`);
      const { status } = await res.json();
      if (!status.indexing && status.filesTotal > 0 && status.filesIndexed >= status.filesTotal) return true;
    } catch {
      /* 继续等 */
    }
    await delay(300);
  }
  return false;
}

const fixtureRoot = await writeFixture();
/** 本次专用的数据目录：绝不去读使用者本机已注册的真实项目（否则会拖着一大批索引跑）。 */
const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-ui-data-'));

/**
 * 前端产物是否比源码新（新就跳过 vite build）。
 * 构建一次约 90 秒，而改后端 / 文档时根本用不着重新构建 —— 那 90 秒纯属白等。
 * 需要强制重建时：UI_FORCE_BUILD=1 npm run test:ui。
 */
async function needsBuild() {
  if (process.env.UI_FORCE_BUILD === '1') return '要求强制重建';
  const distIndex = path.join(ROOT, 'frontend/dist/index.html');
  const distStat = await fsp.stat(distIndex).catch(() => null);
  if (!distStat) return 'dist 不存在';
  const newest = async (dir) => {
    let max = 0;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        const inner = await newest(p);
        if (inner > max) max = inner;
      } else {
        const stat = await fsp.stat(p).catch(() => null);
        if (stat && stat.mtimeMs > max) max = stat.mtimeMs;
      }
    }
    return max;
  };
  const sources = [
    path.join(ROOT, 'frontend/src'),
    path.join(ROOT, 'shared'),
    path.join(ROOT, 'frontend/index.html'),
  ];
  let srcMax = distStat.mtimeMs;
  for (const s of sources) {
    const stat = await fsp.stat(s).catch(() => null);
    const m = stat && stat.isDirectory() ? await newest(s) : stat ? stat.mtimeMs : 0;
    if (m > srcMax) srcMax = m;
  }
  if (srcMax > distStat.mtimeMs) return '源码比 dist 新';
  return null;
}

const buildReason = await needsBuild();
if (buildReason) {
  console.log(`[ui] 构建前端产物（${buildReason}）…`);
  const t = Date.now();
  const build = spawn(
    process.execPath,
    [path.join(ROOT, 'frontend/node_modules/vite/bin/vite.js'), 'build'],
    { cwd: path.join(ROOT, 'frontend'), stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const code = await new Promise((resolve) => build.on('exit', resolve));
  if (code !== 0) {
    console.error('[ui] 前端构建失败，先修构建再跑 UI 回归。');
    await fsp.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    process.exit(1);
  }
  console.log(`[ui] 构建完成（${((Date.now() - t) / 1000).toFixed(1)}s）`);
} else {
  console.log('[ui] dist 已是最新，跳过构建');
}

// 端口先探一次：旧的服务还占着就直接拒绝跑，而不是“洋洋洒洒”连上去跑一轮假结果
if (await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)) {
  console.error(`端口 ${PORT} 上已经有服务在监听（可能是上一轮遗留的测试后端）。`);
  console.error('请先结束它，或用 PORT=<其它端口> npm run test:ui。');
  await fsp.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
}

const server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
  cwd: path.join(ROOT, 'backend'),
  env: { ...process.env, PORT, HOST: '127.0.0.1', READER_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

let serverStopped = false;
const stop = () => {
  if (!serverStopped) {
    serverStopped = true;
    server.kill();
  }
};
process.on('exit', stop);
process.on('SIGINT', () => {
  stop();
  process.exit(130);
});

const cleanup = async () => {
  stop();
  await fsp.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
};

// 总看门狗：卡住时给一句人话并结束，而不是把终端晾在那儿
const watchdog = setTimeout(() => {
  console.error(`\nUI 回归超过 ${Math.round(RUN_TIMEOUT_MS / 1000)} 秒仍未结束，已强制收尾。`);
  console.error('提示：若在服务端日志里看到大量索引，可用 PORT=<空闲端口> 重跑；单步卡点看上方 navigator 的最后一条输出。');
  stop();
  process.exit(1);
}, RUN_TIMEOUT_MS);
watchdog.unref?.();

if (!(await waitForHealth())) {
  console.error(`后端未能在 ${BASE} 起来`);
  await cleanup();
  process.exit(1);
}

// 注册夹具项目（同一 root 复用同一 id，因此每次跑都是干净的）
const openRes = await fetch(`${BASE}/api/projects`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ root: fixtureRoot.split(path.sep).join('/'), name: 'ui-fixture' }),
});
const { project } = await openRes.json();
if (!project?.id) {
  console.error('注册夹具项目失败');
  await cleanup();
  process.exit(1);
}
if (!(await waitForIndex(project.id))) {
  console.error('夹具索引未完成');
  await fetch(`${BASE}/api/projects/${project.id}`, { method: 'DELETE' }).catch(() => {});
  await cleanup();
  process.exit(1);
}

/** 依次跑各套 UI 用例（同一后端 / 同一夹具项目），任一套非零即整轮失败。 */
const runSuite = (file) => {
  const child = spawn(
    process.execPath,
    [path.join(import.meta.dirname, file), project.id, ...process.argv.slice(2)],
    { cwd: ROOT, env: { ...process.env, PORT }, stdio: 'inherit' },
  );
  return new Promise((resolve) => child.on('exit', resolve));
};
// 调试时只跑一套：UI_SUITES=guide.mjs node tests/ui/run.mjs
const suites = (process.env.UI_SUITES ?? 'navigator.mjs,guide.mjs,platform.mjs')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
let code = 0;
const startedAt = Date.now();
for (const suite of suites) {
  const t = Date.now();
  const c = await runSuite(suite);
  console.log(`[ui] ${suite}：${((Date.now() - t) / 1000).toFixed(1)}s${c === 0 ? '' : `（退出码 ${c}）`}`);
  if (typeof c === 'number' && c !== 0 && code === 0) code = c;
}
console.log(`[ui] 全部用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

clearTimeout(watchdog);
await fetch(`${BASE}/api/projects/${project.id}`, { method: 'DELETE' }).catch(() => {});
await cleanup();
process.exit(typeof code === 'number' ? code : 1);
