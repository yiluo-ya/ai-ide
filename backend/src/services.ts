/**
 * 服务生命周期管理（2026-10-03 用户要求：命令管理 —— 启动 / 停止 / 重启）。
 *
 * 三条硬约束（安全）：
 * 1) **只在服务自己管得着的场景下开放**：能重启的只有「阅读器后端自己」，
 *    不提供任意 shell、不执行用户输入的命令字符串 —— 命令与参数全在代码里写死；
 * 2) 停止 / 重启前要显式确认（`?confirm=1`），前端另有二次确认对话框；
 * 3) 共享模式（HOST 不是本机）下整个模块禁用：把服务交给局域网，等于把机器的开关也交出去。
 *
 * 为什么重启要另起一个进程：服务不能一边杀自己一边把自己拉起来 ——
 * `restart-worker.mjs` 是那个「旁人」：等旧进程退出，再用同样的命令把新的拉起来。
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DATA_DIR, HOST, PORT } from './config';
import type { ServiceStatus } from './types';

export type { ServiceStatus };

/** 落盘的服务信息：重启时用它原样把服务拉回来。 */
interface ServiceState {
  pid: number;
  port: number;
  host: string;
  startedAt: number;
  cwd: string;
  command: string[];
  /** 日志文件（重启后新进程要接着写同一份）。 */
  logPath?: string;
}

const stateFile = () => path.join(DATA_DIR, 'service-state.json');
export const logFile = () => path.join(DATA_DIR, 'server.log');
const workerFile = () => path.resolve(import.meta.dirname, '../../bin/restart-worker.mjs');

/** 进程是否还活着（信号 0 = 只探测，不真发信号）。 */
function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readState(): Promise<ServiceState | null> {
  try {
    const raw = await fsp.readFile(stateFile(), 'utf8');
    const parsed = JSON.parse(raw) as ServiceState;
    if (!parsed || typeof parsed.pid !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeState(state: ServiceState): Promise<void> {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(stateFile(), JSON.stringify(state, null, 2), 'utf8');
}

/** 本项目后端入口的绝对路径（与 `npm start` 跑的是同一份）。
 * 注意：本文件就在 `backend/src/` 下，入口 `server.ts` 与它同级 —— 不要写成 `../server.ts`
 * （那会解析成 `backend/server.ts`，重启时新进程直接报 ERR_MODULE_NOT_FOUND 起不来）。
 */
function serverEntry(): string {
  return path.resolve(import.meta.dirname, 'server.ts');
}

/** 起服务用的命令：保持与开发时一致（tsx 直跑 TS，不做构建）。 */
function commandFor(): string[] {
  return [process.execPath, '--import', 'tsx', serverEntry()];
}

/** 服务当前状态（含「本机是否可管理」与运行时长）。 */
let lastAction: ServiceStatus['lastAction'] = null;

export async function serviceStatus(): Promise<ServiceStatus> {
  const state = await readState();
  const ownPid = state && isAlive(state.pid) ? state.pid : process.pid;
  // 从命令行手工起的服务没有 state 文件：用进程自己的运行时长倒推启动时间，
  // 否则面板会一直显示「运行时长 0 秒」，看着像坏了。
  const startedAt =
    state && ownPid === state.pid ? state.startedAt : Date.now() - Math.round(process.uptime() * 1000);
  return {
    pid: ownPid,
    port: state?.port ?? PORT,
    host: state?.host ?? HOST,
    startedAt,
    uptimeMs: Math.max(0, Date.now() - startedAt),
    manageable: true,
    logPath: logFile(),
    lastAction,
  };
}

export function noteAction(action: string, detail?: string): void {
  lastAction = { action, at: Date.now(), ...(detail ? { detail } : {}) };
}

/**
 * 拉起一个新服务（detached：不受本进程退出影响），日志追加到 `data/server.log`。
 * 起完写 state 文件，之后的重启才有「原命令」可用。
 */
export async function startService(extraEnv: Record<string, string> = {}): Promise<ServiceState> {
  const port = PORT;
  const host = HOST;
  const command = commandFor();
  const cwd = path.resolve(import.meta.dirname, '../..');
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const fd = await fsp.open(logFile(), 'a');
  const child = spawn(command[0], command.slice(1), {
    cwd,
    detached: true,
    stdio: ['ignore', fd.fd, fd.fd],
    env: { ...process.env, ...extraEnv },
  });
  child.unref();
  await fd.close();
  const state: ServiceState = { pid: child.pid ?? 0, port, host, startedAt: Date.now(), cwd, command, logPath: logFile() };
  await writeState(state);
  return state;
}

/** 杀掉一个进程（Windows 用 taskkill 连子进程一起，其它平台用 SIGTERM）。 */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* 已经没了 */
    }
  }
}

/**
 * 重启：交给独立的 worker 做（自己杀自己之后没人能接着把它拉起来）。
 * 返回后本进程会在约 0.5 秒内退出，worker 等它退出再起新的。
 */
export async function restartService(): Promise<{ via: string }> {
  // 只在「记录里的那个进程还活着」时才沿用它；否则用当前进程现算一份，
  // 免得 worker 去等一个早就没了的 pid、或拿旧命令起错东西。
  const stored = await readState();
  const state =
    stored && isAlive(stored.pid)
      ? stored
      : {
          pid: process.pid,
          port: PORT,
          host: HOST,
          startedAt: Date.now(),
          cwd: process.cwd(),
          command: commandFor(),
          logPath: logFile(),
        };
  const worker = workerFile();
  const child = spawn(process.execPath, [worker, JSON.stringify(state)], {
    detached: true,
    stdio: 'ignore',
    cwd: state.cwd,
  });
  child.unref();
  noteAction('restart', `worker pid ${child.pid}`);
  // 给 HTTP 响应留出返回时间，再退出自己
  setTimeout(() => process.exit(0), 500).unref();
  return { via: worker };
}

/** 停止服务：杀进程树之后退出自己（同样先让响应发出去）。 */
export async function stopService(): Promise<{ pid: number }> {
  const state = await readState();
  const pid = state && isAlive(state.pid) ? state.pid : process.pid;
  noteAction('stop', `pid ${pid}`);
  killTree(pid);
  // 先让 HTTP 响应发出去，再退出自己（pid 可能就是自己）
  setTimeout(() => process.exit(0), 400).unref();
  return { pid };
}

/** 等端口可用（重启 worker 用）。 */
export async function waitHealthy(port: number, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await fetch(`http://127.0.0.1:${port}/api/health`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return true;
    await delay(300);
  }
  return false;
}
