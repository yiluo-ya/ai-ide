/**
 * 重启工人（2026-10-03 命令管理的一部分；2026-10-13 加固）。
 *
 * 服务自己不能「一边杀自己一边拉自己」，所以重启时由本脚本代劳：
 * 1) 等旧进程退出（最多 15 秒，等不到就强杀旧进程树）；
 * 2) 等端口真的空出来（旧进程卡死时会占着端口，直接起新进程会 EADDRINUSE 秒退）；
 * 3) 用记录下来的那条命令原样拉起新服务（日志追加到 state.logPath）；
 * 4) 等端口健康后自己退出。
 *
 * 加固点一 —— 一级 worker 为什么要先「脱树」（2026-10-13 实测故障）：
 * 旧服务卡住不退时第 1 步会走 `taskkill /T /F`，而 /T 杀的是**旧服务的整棵进程树**；
 * worker 是旧服务 spawn 的、就在这棵树里 → 连同 worker 一起被杀 → 新服务再没人拉起，
 * 服务彻底消失（实测：日志空白 84 秒、端口无监听）。
 * 所以一级 worker 自己不干活，只用 WMI（Win32_Process.Create）起一个二级 worker ——
 * 二级的父进程是 WmiPrvSE.exe，不在旧树里，杀旧树波及不到它。
 *
 * 加固点二 —— state 用文件+base64 传：二级由 WMI 创建，它**不继承旧服务的环境变量**
 * （WMI 创建的新进程继承的是 WmiPrvSE 的环境块），所以一级要把 state 连同 process.env
 * 一起交给它，spawn 新服务时用这份 env，自定义 PORT / READER_DATA_DIR 才不会丢。
 *
 * 用法：node bin/restart-worker.mjs '<service-state.json 的内容>'
 *      node bin/restart-worker.mjs --ascended --from-file=<payload.json>   # 二级（内部用）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const argv = process.argv.slice(2);
const ascended = argv.includes('--ascended');

// ------------------------------------------------------------------ 入参与日志

function argValue(name) {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1).replace(/^"|"$/g, '') : null;
}

/** 二级从文件读 payload（含 state 与 env）；一级沿用原始的 JSON 参数。 */
async function loadPayload() {
  const fromFile = argValue('--from-file');
  if (fromFile) {
    const payload = JSON.parse(await fsp.readFile(fromFile, 'utf8'));
    void fsp.unlink(fromFile).catch(() => {});
    return payload;
  }
  return argv[0] ? { state: JSON.parse(argv[0]) } : null;
}

let payload;
try {
  payload = await loadPayload();
} catch {
  console.error('[restart-worker] service state 不是合法 JSON');
  process.exit(2);
}
const state = payload?.state;
const { pid, port, cwd, command } = state ?? {};
if (!Array.isArray(command) || command.length === 0) {
  console.error('[restart-worker] service state 里没有可用的启动命令');
  process.exit(2);
}

const logPath = state.logPath ?? path.join(cwd ?? process.cwd(), 'data', 'server.log');

/**
 * 日志既写 stderr 也落盘：二级 worker 由 WMI 创建、没有控制台，只靠文件留痕 ——
 * 它正是「旧服务卡住」时唯一还活着的当事人，没有日志就无从排障。
 * 用同步写：一级 worker 记完「已脱树」就立刻 exit，异步写会被丢掉。
 */
function log(...parts) {
  const line = `[restart-worker${ascended ? ':ascended' : ''}] ${parts.join(' ')}`;
  process.stderr.write(line + '\n');
  try {
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* 日志失败不影响重启 */
  }
}

const alive = (p) => {
  try {
    process.kill(p, 0);
    return true;
  } catch {
    return false;
  }
};

// -------------------------------------------------------------------- 脱树

/** 用 WMI 起二级 worker（父进程为 WmiPrvSE，不在旧服务进程树里）。成功返回它的 pid。 */
async function ascend() {
  const payloadFile = path.join(os.tmpdir(), `wcr-restart-${pid}-${Date.now()}.json`);
  await fsp.writeFile(payloadFile, JSON.stringify({ state, env: process.env }), 'utf8');
  const cmdline = `"${process.execPath}" "${process.argv[1]}" --ascended --from-file="${payloadFile}"`;
  // 单引号内双引号是字面量；CmdLine 自身的单引号翻倍转义
  const script =
    `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmdline.replace(/'/g, "''")}' } ` +
    `| Select-Object -ExpandProperty ProcessId`;
  const out = await new Promise((resolve) => {
    const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let text = '';
    ps.stdout.on('data', (d) => (text += String(d)));
    ps.stderr.on('data', (d) => (text += String(d)));
    const timer = setTimeout(() => {
      try {
        ps.kill();
      } catch {
        /* 已经没了 */
      }
      resolve(text);
    }, 10_000);
    ps.on('close', () => {
      clearTimeout(timer);
      resolve(text);
    });
    ps.on('error', () => {
      clearTimeout(timer);
      resolve(text);
    });
  });
  const hit = String(out).match(/^\s*(\d{2,})\s*$/m);
  if (!hit) {
    if (String(out).trim()) log(`WMI 返回：${String(out).trim().slice(0, 300)}`);
    return null;
  }
  return Number(hit[1]);
}

if (!ascended && process.platform === 'win32') {
  const second = await ascend();
  if (second) {
    log(`已脱树：二级 worker pid=${second} 接管（旧服务 pid=${pid}）`);
    process.exit(0);
  }
  log('脱树失败，原地继续（此时强杀旧进程树会把自己一起带走）');
}

// ---------------------------------------------------------- 1) 等旧进程退出

const deadline = Date.now() + 15_000;
while (alive(pid) && Date.now() < deadline) await delay(200);

if (alive(pid)) {
  log(`旧进程 pid=${pid} 15s 未退出，强杀整棵进程树`);
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已经没了 */
    }
  }
  await delay(500);
  if (alive(pid)) log(`强杀后 pid=${pid} 仍在（端口等待会兜底）`);
} else {
  log(`旧进程 pid=${pid} 已退出`);
}

// ---------------------------------------------------------- 2) 等端口空出来

/** 端口空出来才起新服务：卡死的旧进程占着端口时，新进程会 EADDRINUSE 秒退。 */
async function waitPortFree(timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const free = await new Promise((resolve) => {
      const sock = net.connect({ port, host: '127.0.0.1' });
      const done = (v) => {
        try {
          sock.destroy();
        } catch {
          /* 已经关了 */
        }
        resolve(v);
      };
      sock.once('connect', () => done(false));
      sock.once('error', () => done(true));
      sock.setTimeout(1000, () => done(false));
    });
    if (free) return true;
    await delay(200);
  }
  return false;
}

log(`端口 ${port} ${(await waitPortFree(10_000)) ? '已空闲' : '10s 内仍被占用（继续尝试拉起）'}`);

// ---------------------------------------------------------- 3) 拉起新服务

// 日志路径优先用 state 里记的那份（与服务自己的 DATA_DIR 一致）；
// 没有才退回 <cwd>/data/server.log。二级用一级透传的 env，自定义 PORT / DATA_DIR 才不会丢。
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
  env: payload.env ?? process.env,
});
child.unref();
if (fd) await fd.close();
log(`新服务 pid=${child.pid}`);

// ---------------------------------------------------------- 4) 等健康

function healthOk() {
  return new Promise((resolve) => {
    // 用 node:http 而不是 fetch：worker 结束时要立刻 process.exit，
    // undici 的 keep-alive 连接会让 Windows 上的 libuv 在退出时抛断言（见 bootstrap.ts 同款注释）。
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

let healthy = false;
for (const end = Date.now() + 30_000; Date.now() < end;) {
  if (await healthOk()) {
    healthy = true;
    break;
  }
  await delay(300);
}
log(`新服务健康=${healthy ? 'ok' : '超时未就绪'}`);
process.exit(healthy ? 0 : 1);
