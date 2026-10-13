/**
 * 「在终端中运行」的命令拼装（FR-0011）。
 *
 * 借自 openvscode-server 的两件事：
 * - `preparePathForShell`（contrib/terminal/common/terminalEnvironment.ts:320）—— 路径按 shell 分支转义：
 *   PowerShell 用单引号（内嵌单引号双写）、可执行文件前置 `&` 调用操作符；
 *   Git Bash 先把反斜杠转正斜杠再用 POSIX 单引号。
 * - `sendText`（contrib/terminal/browser/terminalInstance.ts:1343）—— 换行口径：只拼**一行**，
 *   末尾的回车由 TerminalPanel 发送时补 `\r`。
 *
 * 纪律：**不认识的语言返回 null**（界面据此置灰），不做"把路径丢给 shell 兜底"。
 */
export type ShellKind = 'powershell' | 'gitbash';

/** 单文件可直接解释执行的语言 → 命令前缀（argv）。加语言只加一行。 */
const RUNNERS: Record<string, string[]> = {
  py: ['python'],
  pyw: ['python'],
  js: ['node'],
  mjs: ['node'],
  cjs: ['node'],
  go: ['go', 'run'],
  ps1: ['powershell', '-File'],
  sh: ['bash'],
  bash: ['bash'],
  rb: ['ruby'],
  php: ['php'],
  pl: ['perl'],
  lua: ['lua'],
  bat: ['cmd', '/c'],
  cmd: ['cmd', '/c'],
};

/** 出现这些字符就必须加引号（空格 / 括号 / shell 元字符）。 */
const NEEDS_QUOTE = /[\s()'&;|<>$`"!^,]/;

/** 取小写扩展名；无扩展名或点开头（`.env` 这类）返回空串。 */
export function extensionOf(file: string): string {
  const base = file.slice(file.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** 这个文件能"在终端中运行"吗？返回 argv 前缀（不认识则 null）。 */
export function runnerFor(file: string): string[] | null {
  const ext = extensionOf(file);
  if (!ext) return null;
  return RUNNERS[ext] ?? null;
}

/** 界面置灰用：这个文件有没有运行器。 */
export function isRunnable(file: string): boolean {
  return runnerFor(file) !== null;
}

/** 把单个参数按 shell 转义（路径 / 命令名 / 开关都走它）；force=true 时无条件加引号。 */
function quoteArg(value: string, shell: ShellKind, force = false): string {
  if (shell === 'gitbash') {
    // Git Bash：Windows 反斜杠是转义字符，一律换正斜杠后再用 POSIX 单引号包住
    const posix = value.replace(/\\/g, '/');
    return `'${posix.replace(/'/g, `'\\''`)}'`;
  }
  // PowerShell / cmd：没特殊字符就裸写（更好读），否则单引号包裹（内嵌单引号双写）
  if (!force && !NEEDS_QUOTE.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Git Bash（MSYS2）会把 `/c` 这类参数当路径改写成 `C:/`，得写成 `//c` 才是字面量。
 * 只影响 `.bat`/`.cmd` 的 `cmd /c`。
 */
function msysSafeFlag(arg: string): string {
  return /^\/[A-Za-z]+$/.test(arg) ? `/${arg}` : arg;
}

/** 是不是绝对路径（Windows 盘符 / UNC / POSIX）。 */
function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\');
}

export interface RunOptions {
  /** 目标文件：项目内的**相对路径**（终端 cwd = 项目根）；用正斜杠。 */
  file: string;
  /** 当前终端的 shell 种类（决定转义规则）。 */
  shellKind: ShellKind;
  /** Python 解释器绝对路径（后端探测或用户指定）；空 = 用 PATH 上的 `python`。 */
  pythonPath?: string | null;
}

/**
 * 拼出要写进终端的**一行**命令；文件没有运行器时返回 null。
 *
 * - Python 用 `pythonPath` 时写成绝对路径：PowerShell 需 `& 'D:\…\python.exe'`（前置调用操作符），
 *   Git Bash 直接 `'D:/…/python.exe'`。这样"到底跑了哪个环境"在终端里一眼可见。
 * - 文件路径按当前 shell 转义，终端 cwd 始终停在项目根。
 */
export function buildRunCommand(opts: RunOptions): string | null {
  const { file, shellKind, pythonPath } = opts;
  const argv = runnerFor(file);
  if (!argv) return null;

  const parts: string[] = [];
  argv.forEach((arg, index) => {
    if (index === 0 && pythonPath && arg === 'python') {
      // 绝对路径的可执行文件在 PowerShell 里必须用 & 调用，否则被当成字符串打印；
      // 无条件加引号（否则 `D:\proj\.venv\…` 里的盘符冒号容易踩到转义坑）
      if (shellKind !== 'gitbash' && isAbsolutePath(pythonPath)) parts.push('&');
      parts.push(quoteArg(pythonPath, shellKind, true));
      return;
    }
    parts.push(shellKind === 'gitbash' ? msysSafeFlag(arg) : arg);
  });
  parts.push(quoteArg(file, shellKind));
  return parts.join(' ');
}
