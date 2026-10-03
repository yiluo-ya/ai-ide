/**
 * 重启工人（2026-10-03 命令管理的一部分）。
 *
 * 服务自己不能「一边杀自己一边拉自己」，所以重启时由本脚本代劳：
 * 1) 等旧进程退出（最多 15 秒，等不到就强杀）；
 * 2) 用记录下来的那条命令原样拉起新服务（日志追加到 data/server.log）；
 * 3) 等端口健康后自己退出。
 *
 * 用法：node bin/restart-worker.mjs '<service-state.json 的内容>'
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const raw = process.argv[2];
if (!raw) {
  console.error('[restart-worker] 缺少 service state 参数');
  process.exit(2);
}
let state;
try {
  state = JSON.parse(raw);
} catch {
  console.error('[restart-worker] service state 不是合法 JSON');
  process.exit(2);
}

const { pid, port, cwd, command } = state;
if (!Array.isArray(command) || command.length === 0) {
  console.error('[restart-worker] service state 里没有可用的启动命令');
  process.exit(2);
}

const alive = (p) => {
  try {
    process.kill(p, 0);
    return true;
  } catch {
    return false;
  }
};

// 1) 等旧进程退出
const deadline = Date.now() + 15_000;
while (alive(pid) && Date.now() < deadline) await delay(200);
if (alive(pid)) {
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已经没了 */
    }
  }
  await delay(500);
}

// 2) 拉起新服务（detached，日志追加）
//    日志路径优先用 state 里记的那份（与服务自己的 DATA_DIR 一致）；
//    没有才退回 <cwd>/data/server.log。
const logPath = state.logPath ?? path.join(cwd ?? process.cwd(), 'data', 'server.log');
await fsp.mkdir(path.dirname(logPath), { recursive: true }).catch(() => {});
let fd = null;
try {
  fd = await fsp.open(logPath, 'a');
} catch {
  fd = null;
}
const child = spawn(command[0], command.slice(1), {
  cwd: cwd ?? process.cwd(),
  detached: true,
  stdio: ['ignore', fd ? fd.fd : 'ignore', fd ? fd.fd : 'ignore'],
  env: process.env,
});
child.unref();
if (fd) await fd.close();

// 3) 等健康
const ok = await (async () => {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const healthy = await fetch(`http://127.0.0.1:${port}/api/health`)
      .then((r) => r.ok)
      .catch(() => false);
    if (healthy) return true;
    await delay(300);
  }
  return false;
})();
console.log(`[restart-worker] 新服务 pid=${child.pid} 健康=${ok ? 'ok' : '超时未就绪'}`);
process.exit(ok ? 0 : 1);
