/**
 * wcr 命令行（06-platform P13 / P15 / P22）：
 *
 *   wcr [目录] [--port <n>] [--no-open] [--no-watch] [--workers <n>] [--host <h>] [--help] [--version]
 *
 * 行为：先探已有实例（runtime.json + /api/health）→ 命中就只给地址、复用它；
 * 未命中则自动选端口（占用往后让位，不再直接失败）→ 起服务 → 写 runtime.json → 打开浏览器。
 *
 * 注意：这里不在顶层静态 import 任何会读到 `config` 的模块 —— CLI 的 --host / --port /
 * --no-watch / --workers 必须先落进 process.env，config 才会拿到正确值（见下面的动态 import）。
 */
import path from 'node:path';

const VERSION = '0.1.0';

const USAGE = [
  'wcr —— 浏览器里的代码阅读器（只读 · 不上传 · 代码不出本机）',
  '',
  '用法：',
  '  wcr [目录] [选项]',
  '',
  '选项：',
  '  --port <n>     监听端口（默认 8787；被占用会自动往后找，0 = 让系统分配）',
  '  --host <h>     监听地址（默认 127.0.0.1；团队共享用 0.0.0.0）',
  '  --no-open      不自动打开浏览器',
  '  --no-watch     关闭文件监听（改文件不自动重建索引）',
  '  --workers <n>  索引并行解析 worker 数（0 = 串行）',
  '  --help         显示本帮助',
  '  --version      输出版本号',
  '',
  '示例：',
  '  wcr                          # 起服务并打开浏览器，之后在页面里填目录',
  '  wcr D:/code/my-project       # 起服务并直接注册打开该目录',
].join('\n');

export interface CliArgs {
  dir: string | null;
  port: number;
  host: string;
  open: boolean;
  watch: boolean;
  workers: number | null;
  help: boolean;
  version: boolean;
  unknown: string[];
}

export function parseArgs(argv: string[], defaults: { port?: number; host?: string } = {}): CliArgs {
  const args: CliArgs = {
    dir: null,
    port: defaults.port ?? 8787,
    host: defaults.host ?? '127.0.0.1',
    open: true,
    watch: true,
    workers: null,
    help: false,
    version: false,
    unknown: [],
  };
  const num = (raw: string | undefined): number | null => {
    const n = Number(raw);
    return raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--version' || a === '-v') args.version = true;
    else if (a === '--no-open') args.open = false;
    else if (a === '--no-watch') args.watch = false;
    else if (a === '--port') args.port = num(argv[++i]) ?? args.port;
    else if (a.startsWith('--port=')) args.port = num(a.slice('--port='.length)) ?? args.port;
    else if (a === '--host') args.host = argv[++i] ?? args.host;
    else if (a.startsWith('--host=')) args.host = a.slice('--host='.length) || args.host;
    else if (a === '--workers') args.workers = num(argv[++i]);
    else if (a.startsWith('--workers=')) args.workers = num(a.slice('--workers='.length));
    else if (a.startsWith('-')) args.unknown.push(a);
    else if (!args.dir) args.dir = a;
    else args.unknown.push(a);
  }
  return args;
}

/** 打印给用户的地址：通配监听地址换成回环，避免给出 0.0.0.0。 */
const displayHost = (host: string): string =>
  host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '[::1]' : host;

const say = (line = '') => process.stdout.write(`${line}\n`);

async function registerProject(
  baseUrl: string,
  root: string,
  http: { httpJson: (url: string, opts?: { method?: string; body?: unknown }) => Promise<{ status: number; json: unknown } | null> },
  logWarn: (msg: string, fields?: Record<string, unknown>) => void,
) {
  try {
    const res = await http.httpJson(`${baseUrl}/api/projects`, { method: 'POST', body: { root } });
    if (!res || res.status >= 400) throw new Error(`HTTP ${res?.status ?? 'no-response'}`);
    const body = res.json as { project?: { id?: string } } | null;
    say(`已注册项目：${root}（projectId ${body?.project?.id ?? '?'}）`);
  } catch (e) {
    logWarn('cli.project.register-failed', { root, error: (e as Error).message });
    say(`提示：项目注册失败（${(e as Error).message}），可在页面里手动填路径。`);
  }
}

const args = parseArgs(process.argv.slice(2), {
  port: Number.isFinite(Number(process.env.PORT)) && process.env.PORT !== '' ? Number(process.env.PORT) : 8787,
  host: process.env.HOST || undefined,
});
if (args.help) {
  say(USAGE);
  process.exit(0);
}
if (args.version) {
  say(VERSION);
  process.exit(0);
}

// CLI 覆盖值必须在 config 被求值之前落进 env（config 在模块加载时读 env）。
process.env.HOST = args.host;
process.env.PORT = String(args.port);
if (!args.watch) process.env.READER_WATCH = '0';
if (args.workers !== null) process.env.READER_PARSE_WORKERS = String(args.workers);

const boot = await import('./bootstrap');
const config = await import('./config');
const { createServer } = await import('./server');
const { logInfo, logWarn } = await import('./log');

const dataDir = config.DATA_DIR;
const root = args.dir ? path.resolve(args.dir) : null;
for (const opt of args.unknown) logWarn('cli.arg.unknown', { arg: opt });

say('web-code-reader');
say('只读 · 不上传 · 代码不出本机');
say();

// 1) 单实例：已有实例就直接给地址，不起第二个进程（P15）
const live = await boot.findLiveInstance(args.port, args.host, dataDir);
if (live) {
  const url = `http://${displayHost(args.host)}:${live.port}`;
  say(`已在 ${url} 运行（pid ${live.pid || '未知'}），复用已有实例`);
  logInfo('cli.reuse', { url, pid: live.pid });
  if (root) {
    if (boot.isReadableDir(root)) await registerProject(url, root, boot, logWarn);
    else {
      logWarn('cli.dir.invalid', { dir: root });
      say(`提示：${root} 不是一个可读目录，已跳过注册。`);
    }
  }
  if (args.open) await boot.openBrowser(url);
  process.exit(0);
}

// 2) 端口让位（P15 的核心修复：占用不再直接失败）
const port = await boot.resolvePort(args.port, args.host);
if (args.port === 0) {
  say(`端口由系统分配：${port}`);
} else if (port !== args.port) {
  say(`端口 ${args.port} 已被占用，改用 ${port}`);
  logWarn('cli.port.busy', { preferred: args.port, chosen: port });
}

const handle = await createServer({ port, host: args.host, dataDir });
await boot.writeRuntime(dataDir, {
  pid: process.pid,
  port: handle.port,
  host: args.host,
  startedAt: Date.now(),
});

const url = `http://${displayHost(args.host)}:${handle.port}`;
say(`地址：${url}`);
say(`数据目录：${dataDir}`);
say('被读目录不会被写入、不会上传任何文件；按 Ctrl+C 退出。');
say();

if (root) {
  if (boot.isReadableDir(root)) await registerProject(url, root, boot, logWarn);
  else {
    logWarn('cli.dir.invalid', { dir: root });
    say(`提示：${root} 不是一个可读目录，已跳过注册。`);
  }
}
if (args.open) await boot.openBrowser(url);

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  logInfo('cli.shutdown', { port: handle.port });
  await boot.clearRuntime(dataDir);
  await handle.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
