/**
 * 启动引导（06-platform P13 / P15）：
 * - `resolvePort`：端口占用自动让位（不再因为 8787 被占就退出）；
 * - `runtime.json` + `isProcessAlive` + `findLiveInstance`：单实例复用（重复启动只给已有地址）；
 * - `openBrowser`：一把命令打开浏览器（失败只 warn）；
 * - `installProjectHint`：给 `ProjectIndex.hint()` 补一个 `root` 字段，
 *   让语言模块能读项目的 tsconfig / go.work / pyproject（P10）。不改 walker/store 的接口。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ProjectIndex } from './indexer/store';
import { ProjectWatcher } from './watcher';
import { WATCH_ENABLED } from './config';
import { logInfo, logWarn } from './log';

/** 单实例判定用的运行时信息（落 `<dataDir>/runtime.json`）。 */
export interface RuntimeInfo {
  pid: number;
  port: number;
  host: string;
  startedAt: number;
}

/** 探测端口可用时最多往后试多少个（P15）。 */
const PORT_SCAN_LIMIT = 20;

export function runtimePath(dataDir: string): string {
  return path.join(dataDir, 'runtime.json');
}

export async function readRuntime(dataDir: string): Promise<RuntimeInfo | null> {
  try {
    const raw = await fsp.readFile(runtimePath(dataDir), 'utf8');
    const rt = JSON.parse(raw) as RuntimeInfo;
    if (!rt || typeof rt.port !== 'number' || typeof rt.pid !== 'number') return null;
    return { pid: rt.pid, port: rt.port, host: rt.host ?? '127.0.0.1', startedAt: rt.startedAt ?? 0 };
  } catch {
    return null;
  }
}

export async function writeRuntime(dataDir: string, rt: RuntimeInfo): Promise<void> {
  try {
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.writeFile(runtimePath(dataDir), `${JSON.stringify(rt, null, 2)}\n`, 'utf8');
  } catch (e) {
    logWarn('cli.runtime.write-failed', { error: (e as Error).message });
  }
}

export async function clearRuntime(dataDir: string): Promise<void> {
  try {
    await fsp.rm(runtimePath(dataDir), { force: true });
  } catch {
    /* 删不掉不影响退出 */
  }
}

/** 进程是否还在（`kill(pid, 0)`；EPERM 说明进程存在但当前用户无权限）。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 试探某个端口能否监听；能则返回真实端口（`port=0` 时由 OS 选），不能返回 null。 */
function probePort(port: number, host: string): Promise<number | null> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(null));
    server.listen({ port, host }, () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      server.close(() => resolve(actual));
    });
  });
}

const isPortFree = async (port: number, host: string): Promise<boolean> =>
  (await probePort(port, host)) !== null;

/**
 * 从 `preferred` 起往后试（最多 20 个）找一个能监听的端口；
 * `preferred === 0` 时让 OS 选并返回真实端口。全被占用则回落到 OS 随机端口。
 */
export async function resolvePort(preferred: number, host: string): Promise<number> {
  if (preferred === 0) {
    const picked = await probePort(0, host);
    if (picked === null) throw new Error(`no free port on ${host}`);
    return picked;
  }
  for (let i = 0; i < PORT_SCAN_LIMIT; i++) {
    const port = preferred + i;
    if (await isPortFree(port, host)) return port;
  }
  const fallback = await probePort(0, host);
  if (fallback === null) throw new Error(`no free port on ${host}`);
  logWarn('cli.port.all-busy', { from: preferred, picked: fallback });
  return fallback;
}

/** 探测地址：`0.0.0.0` / `::` 这类通配地址用回环访问。 */
const dialableHost = (host: string): string =>
  host === '0.0.0.0' || host === '' ? '127.0.0.1' : host === '::' ? '[::1]' : host;

/**
 * 发一个本地 HTTP 请求并读 JSON。
 *
 * 特意用 `node:http` + `Connection: close` 而不是 fetch/undici：CLI 的动作（健康检查、注册项目）
 * 之后要立刻 `process.exit`，undici 的 keep-alive 连接会让 Windows 上的 libuv 在退出时抛断言。
 */
export function httpJson(
  url: string,
  opts: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<{ status: number; json: unknown } | null> {
  return new Promise((resolve) => {
    const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
    const req = http.request(
      url,
      {
        method: opts.method ?? 'GET',
        timeout: opts.timeoutMs ?? 1500,
        headers: {
          connection: 'close',
          ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let json: unknown = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
        res.on('error', () => resolve(null));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    if (payload) req.write(payload);
    req.end();
  });
}

/** 该端口上跑的是不是本工具（用 `/api/health` 的 name 判定，避免误认别的服务）。 */
export async function isWebCodeReaderAt(host: string, port: number): Promise<boolean> {
  const res = await httpJson(`http://${dialableHost(host)}:${port}/api/health`);
  if (!res || !res.status || res.status >= 400) return false;
  return (res.json as { name?: string } | null)?.name === 'web-code-reader';
}

/**
 * 找已经在跑的实例：先看 `runtime.json`（pid 存活且健康检查可达），
 * 其次看一眼 `preferred` 端口本身（比如 runtime.json 被删了但服务还在）。
 */
export async function findLiveInstance(
  preferred: number,
  host: string,
  dataDir: string,
): Promise<{ port: number; pid: number } | null> {
  const rt = await readRuntime(dataDir);
  if (rt) {
    if (isProcessAlive(rt.pid) && (await isWebCodeReaderAt(rt.host ?? host, rt.port))) {
      return { port: rt.port, pid: rt.pid };
    }
    // 陈旧记录：清掉，避免下次又读到
    await clearRuntime(dataDir);
  }
  if (preferred > 0 && (await isWebCodeReaderAt(host, preferred))) {
    return { port: preferred, pid: 0 };
  }
  return null;
}

/** 打开浏览器：Windows 走 `cmd /c start ""`，macOS `open`，Linux `xdg-open`；失败只 warn。 */
export async function openBrowser(url: string): Promise<void> {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => resolve());
    });
    child.unref();
    logInfo('cli.browser.opened', { url });
  } catch (e) {
    logWarn('cli.browser.failed', { url, error: (e as Error).message });
  }
}

const HINT_PATCHED = Symbol.for('wcr.hint.root');

/**
 * 给 `ProjectIndex.hint()` 的返回值补一个 `root`（项目绝对路径），语言模块据此读
 * tsconfig.json / go.work / pyproject.toml（P10）。幂等；读取失败由 readHintFile 兜底。
 * 若日后 store 自己在 hint() 里给出 root，本注入可以删。
 */
export function installProjectHint(): void {
  const proto = ProjectIndex.prototype as unknown as Record<string | symbol, unknown>;
  if (proto[HINT_PATCHED]) return;
  const original = proto['hint'] as (this: { root: string }) => Record<string, unknown>;
  proto['hint'] = function hintWithRoot(this: { root: string }) {
    return { ...original.call(this), root: this.root };
  };
  proto[HINT_PATCHED] = true;
}

const NO_WATCH_PATCHED = Symbol.for('wcr.watcher.disabled');

/**
 * `--no-watch` / `READER_WATCH=0`：不启文件监听（改文件不再自动重建索引）。
 *
 * `WATCH_ENABLED` 已在 config 里定义，但 watcher 的创建在 registry 内部 —— 两个文件都不在本次
 * 可写范围，所以这里在启动时把 `ProjectWatcher.start` 置为空操作。更干净的做法是 `watcher.ts`
 * 的构造函数先看 `WATCH_ENABLED`（一行），那之后本函数可以删。
 */
export function installNoWatch(): void {
  if (WATCH_ENABLED) return;
  const proto = ProjectWatcher.prototype as unknown as Record<string | symbol, unknown>;
  if (proto[NO_WATCH_PATCHED]) return;
  proto['start'] = function noopStart() {
    /* READER_WATCH=0：不建 chokidar 监听 */
  };
  proto[NO_WATCH_PATCHED] = true;
}

/** 目录是否可读（CLI 启动前的早失败检查，错误信息对用户友好）。 */
export function isReadableDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
