/**
 * pi 后端的「定位链」（FR-0007）。源码给出去时不含 pi，所以要先回答两个问题：
 * **去哪装**（`piInstallHint`）与**装哪儿能被认出来**（下面的候选顺序）。
 *
 * 顺序（第一个存在的胜出）：
 * 1. `READER_PI_COMMAND` 环境变量（老用法，优先级最高，改了会破坏现有部署）；
 * 2. 设置里手填的路径（文件直接用；目录按落点候选名展开）；
 * 3. 落点 `~/.ide/agents/pi/`（`npm install --prefix <落点>` 或直接放可执行文件）；
 * 4. PATH 上的 `pi`（今天的默认行为，兜底）。
 *
 * 两种分发包形态都认：独立二进制（`pi.exe` / `pi`）与 npm 前缀安装的 shim
 * （`<落点>/node_modules/.bin/pi.cmd`）。Windows 上 `.cmd` / `.bat` / 裸名一律交给
 * `cmd.exe /d /s /c`（npm 的 shim 是批处理，CreateProcess 起不来，Node 直启会 EINVAL）；
 * `.exe` 直启。
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config';
import type { AgentRuntimeConfig } from './runtime-config';

const IS_WIN = process.platform === 'win32';

/** 探测超时：`pi --version` 正常是毫秒级，2 秒足够（D5 的指引不阻塞在探测上）。 */
export const PROBE_TIMEOUT_MS = 2_000;

/** 安装指引里用的 npm 包名（本机实测：全局装的就是它，命令名是 `pi`）。 */
export const PI_PACKAGE = '@earendil-works/pi-coding-agent';

/** 候选来源，前端按它取 i18n 文案。 */
export type PiRuntimeSource = 'env' | 'config' | 'agents' | 'path';

export interface PiCandidate {
  source: PiRuntimeSource;
  /** 要执行的目标：绝对路径，或 PATH 上的裸命令名。 */
  target: string;
  /** 是否已确认指向一个存在的文件（false = 交给系统碰运气）。 */
  resolved: boolean;
}

/** 解析结果：可直接喂给 `spawn`（配合 `piSpawnOptions`）。 */
export interface PiRuntime extends PiCandidate {
  /** 交给 spawn 的可执行（Windows 的 shim 场景是 cmd.exe）。 */
  command: string;
  /** 前置参数（含 cmd 的 `/d /s /c` 与拼好的命令行）。 */
  prefixArgs: string[];
  /** 是否用 `windowsVerbatimArguments`（命令行自带引号，别再转义）。 */
  verbatim: boolean;
}

export interface PiProbe {
  ok: boolean;
  runtime: PiRuntime;
  version?: string;
  error?: string;
}

/** Code Agent 的落点根目录：`~/.ide/agents/`。 */
export function agentsDir(): string {
  return path.join(DATA_DIR, 'agents');
}

/** pi 的落点目录：`~/.ide/agents/pi/`。 */
export function piAgentsDir(): string {
  return path.join(agentsDir(), 'pi');
}

/** OpenHands 的位置（只留位置，适配器还没接）：`~/.ide/agents/openhands/`。 */
export function openhandsAgentsDir(): string {
  return path.join(agentsDir(), 'openhands');
}

/** 装在哪：落点绝对路径 + 两条可复制的 npm 命令（D5）。 */
export function piInstallHint(): { dir: string; globalCommand: string; prefixCommand: string } {
  const dir = piAgentsDir();
  return {
    dir,
    globalCommand: `npm install -g ${PI_PACKAGE}`,
    prefixCommand: `npm install --prefix "${dir}" ${PI_PACKAGE}`,
  };
}

/**
 * 「一个都没找到」时给用户看的话：一句话 + 落点绝对路径 + 两条可复制的命令，不带栈（D5）。
 * 单行分号拼接：错误会经 HTTP 消息直接显示在界面上，换行在那儿不保证渲染。
 */
export function piNotFoundMessage(): string {
  const hint = piInstallHint();
  return [
    '未找到 pi：设置里没填路径，落点目录与 PATH 上也没有',
    `落点目录：${hint.dir}`,
    `装法 1（进 PATH）:${hint.globalCommand}`,
    `装法 2（装到落点）:${hint.prefixCommand}`,
    '也可以把已有的 pi 可执行文件放进落点，或在「设置 → Code Agent 后端」里手填它的路径',
  ].join('；');
}

/**
 * 定位链的全部候选（顺序即优先级）。末尾的 PATH 兜底**永远存在** ——
 * 找不到时也给裸名，行为与今天一致，由调用方在启动失败时翻译成安装指引（A1/A4）。
 */
export function piCandidates(config: AgentRuntimeConfig = { piPath: '' }): PiCandidate[] {
  const out: PiCandidate[] = [];

  const envCommand = (process.env.READER_PI_COMMAND ?? '').trim();
  if (envCommand) {
    out.push({ source: 'env', target: envCommand, resolved: isFile(envCommand) });
  }

  // D4：手填的文件与目录都收；填了但不存在就跳过（不挡落点与 PATH 兜底）
  const manual = (config.piPath ?? '').trim();
  if (manual) {
    const abs = path.resolve(manual);
    if (isDir(abs)) {
      for (const file of piFilesIn(abs)) out.push({ source: 'config', target: file, resolved: true });
    } else if (isFile(abs)) {
      out.push({ source: 'config', target: abs, resolved: true });
    }
  }

  for (const file of piFilesIn(piAgentsDir())) out.push({ source: 'agents', target: file, resolved: true });

  const onPath = findOnPath('pi');
  out.push({ source: 'path', target: onPath ?? 'pi', resolved: onPath !== null });

  return out;
}

/** 定位链取第一个候选，加上「怎么 spawn 它」的平台细节。 */
export function resolvePiRuntime(config: AgentRuntimeConfig = { piPath: '' }, piArgs: string[] = []): PiRuntime {
  const [first = { source: 'path' as const, target: 'pi', resolved: false }] = piCandidates(config);
  return toRuntime(first, piArgs);
}

/** 给 `probePi` / 适配器共用的 spawn 选项。 */
export function piSpawnOptions(runtime: PiRuntime, cwd?: string): SpawnOptions {
  return {
    ...(cwd ? { cwd } : {}),
    windowsHide: true,
    ...(runtime.verbatim ? { windowsVerbatimArguments: true } : {}),
  };
}

/** 跑一次 `pi --version`：设置页的状态行与「新建会话」前的可用性判断都靠它。 */
export function probePi(runtime: PiRuntime, timeoutMs = PROBE_TIMEOUT_MS): Promise<PiProbe> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    let child: ChildProcess;
    try {
      child = spawn(runtime.command, runtime.prefixArgs, piSpawnOptions(runtime));
    } catch (error) {
      resolve({ ok: false, runtime, error: message(error) });
      return;
    }

    const finish = (result: PiProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已经退了 */
      }
      finish({ ok: false, runtime, error: `检测超时（${timeoutMs} 毫秒）` });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      finish({ ok: false, runtime, error: runtime.resolved ? message(error) : notFoundLine() });
    });
    child.once('exit', (code) => {
      if (code === 0) {
        const version = firstLine(stdout) ?? firstLine(stderr);
        finish({ ok: true, runtime, ...(version ? { version } : {}) });
        return;
      }
      const detail = firstLine(stderr);
      finish({
        ok: false,
        runtime,
        error: runtime.resolved ? (detail ?? `pi --version 退出码 ${code ?? 'null'}`) : notFoundLine(),
      });
    });
  });
}

/** 探测失败但连原因都没有时（PATH 兜底且系统没给出话）：一句话。 */
function notFoundLine(): string {
  return '未找到 pi（PATH 上也没有）';
}

// ------------------------------------------------------------------ 内部

/** 一个目录里「算装了 pi」的文件，按优先顺序（Windows 先认 .exe，再是 npm 的 .cmd）。 */
function piFilesIn(dir: string): string[] {
  const names = IS_WIN ? ['pi.exe', 'pi.cmd', 'pi.bat', 'pi'] : ['pi', 'pi.sh'];
  const files = names.map((name) => path.join(dir, name));
  // npm 前缀安装的 shim：<dir>/node_modules/.bin/pi[.cmd]
  const bin = path.join(dir, 'node_modules', '.bin');
  files.push(...names.map((name) => path.join(bin, name)));
  return files.filter((file) => isFile(file));
}

/** PATH 上找 pi（只为让状态行显示真实路径；找不到也不影响 spawn 的兜底行为）。 */
function findOnPath(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const names = IS_WIN ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name];
  for (const dir of dirs) {
    for (const candidate of names) {
      const file = path.join(dir, candidate);
      if (isFile(file)) return file;
    }
  }
  return null;
}

function toRuntime(candidate: PiCandidate, piArgs: string[]): PiRuntime {
  const { source, target, resolved } = candidate;
  const base = { source, target, resolved };
  if (!IS_WIN || target.toLowerCase().endsWith('.exe')) {
    return { ...base, command: target, prefixArgs: piArgs, verbatim: false };
  }
  // .cmd / .bat / 裸名走 cmd.exe；含空格的路径要「外层引号 + 路径引号」两层，
  // cmd 的 /s 会剥掉最外层那一对，剩下带引号的路径照常解析（2026-10-03 实测）。
  const isPath = target.includes(path.sep) || target.includes('/');
  const line = [isPath ? `"${target}"` : target, ...piArgs].join(' ');
  return {
    ...base,
    command: process.env.ComSpec ?? 'cmd.exe',
    prefixArgs: ['/d', '/s', '/c', isPath ? `"${line}"` : line],
    verbatim: true,
  };
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function firstLine(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
