/**
 * 项目文件的写操作（2026-10-10 用户要求）：编辑器直接改文件、文件树删文件 / 目录。
 *
 * 与 `gitwrite.ts` 并列 —— 那边写的是 git 历史，这边写的是**工作区的文件本身**。
 * 三条安全约定：
 * 1) 只碰调用方（路由层）已用 `ProjectIndex.resolveInside` 校验过的绝对路径；
 * 2) 删除**只走系统回收站**：回收站不可用时如实报错，绝不静默改成永久删除；
 * 3) 写入带 `baseMtimeMs` 冲突检测：磁盘在编辑期间被外部改过就拒绝写，把决定权交回用户。
 */
import { execFile, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** 单次写入上限 5 MB：手改不可能这么大，超过多半是事故。 */
export const MAX_WRITE_BYTES = 5 * 1024 * 1024;

export type WriteOutcome =
  | { ok: true; size: number; mtimeMs: number }
  | { ok: false; error: 'not_found'; message: string }
  | { ok: false; error: 'is_dir'; message: string }
  | { ok: false; error: 'too_large'; message: string }
  | { ok: false; error: 'conflict'; message: string; mtimeMs: number; size: number };

/** mtime 允许的抖动（毫秒）：NTFS 精度与跨进程读取都可能差一点点。 */
const MTIME_TOLERANCE_MS = 1;

/**
 * 把 `text` 写进一个**已存在**的文件（不新建 —— 本轮不做「新建文件」）。
 * `baseMtimeMs` 是前端打开文件时看到的 mtime：不等于磁盘当前值就是冲突，拒写。
 */
export async function writeProjectFile(
  abs: string,
  text: string,
  baseMtimeMs?: number,
): Promise<WriteOutcome> {
  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    return { ok: false, error: 'not_found', message: `文件不存在：${abs}` };
  }
  if (stat.isDirectory()) return { ok: false, error: 'is_dir', message: `这是一个目录，不支持写入：${abs}` };
  if (Buffer.byteLength(text, 'utf8') > MAX_WRITE_BYTES) {
    return { ok: false, error: 'too_large', message: `内容超过 ${MAX_WRITE_BYTES / 1024 / 1024} MB，拒绝写入` };
  }
  if (baseMtimeMs != null && Math.abs(stat.mtimeMs - baseMtimeMs) > MTIME_TOLERANCE_MS) {
    return {
      ok: false,
      error: 'conflict',
      message: '磁盘上的文件已被其它改动覆盖（本次保存被拒绝）',
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
  }
  await fsp.writeFile(abs, text, 'utf8');
  const after = await fsp.stat(abs);
  return { ok: true, size: after.size, mtimeMs: after.mtimeMs };
}

export type TrashOutcome =
  | { ok: true }
  | { ok: false; error: 'not_found' | 'unsupported' | 'failed'; message: string };

/** 删除（移到回收站）。目录会整棵递归进去，与资源管理器里删文件夹一致。 */
export async function trashEntry(abs: string): Promise<TrashOutcome> {
  try {
    await fsp.stat(abs);
  } catch {
    return { ok: false, error: 'not_found', message: `路径不存在：${abs}` };
  }
  if (process.platform !== 'win32') {
    return { ok: false, error: 'unsupported', message: '当前系统暂不支持回收站删除（本版只实现了 Windows）' };
  }
  try {
    await runPowerShell(TRASH_SCRIPT, abs);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'failed', message: `移入回收站失败：${firstLine((e as Error).message)}` };
  }
}

/**
 * Windows 没有原生回收站 API，借 .NET 的 `Microsoft.VisualBasic.FileIO.FileSystem`
 * （`SendToRecycleBin`）。目标路径走**环境变量**传入，脚本本身不含任何字符串拼接。
 */
const TRASH_SCRIPT = [
  'Add-Type -AssemblyName Microsoft.VisualBasic',
  '$p = $env:WCR_TRASH_TARGET',
  'if (Test-Path -LiteralPath $p -PathType Container) {',
  "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')",
  '} else {',
  "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')",
  '}',
].join('\n');

function runPowerShell(script: string, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        env: { ...process.env, WCR_TRASH_TARGET: target },
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(String(stderr ?? '').trim() || err.message));
          return;
        }
        resolve();
      },
    );
  });
}

function firstLine(text: string): string {
  return (text.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? text).slice(0, 300);
}

export type RevealOutcome = { ok: true } | { ok: false; error: 'not_found' | 'failed'; message: string };

/**
 * 在系统文件管理器里打开并选中该条目（2026-10-21 用户要求：文件树右键「在资源管理器中打开」）。
 *
 * Windows 上交给 REVEAL_SCRIPT 一步做完「开窗口 → 确保显示 → 带到最前」。
 * 为什么不能只 `explorer.exe <dir>`：本机实测 explorer 打开目录后**新窗口是隐藏的**
 * （IsWindowVisible=0，EnumWindows 能看到、用户看不见），这正是「点了菜单没反应」的真因。
 *
 * 两条约定：
 * 1) 路径必须先存在：不存在就报 `not_found`，不让 explorer 自己退化成「我的文档」；
 * 2) 回执只代表**命令已交出**：窗口由独立进程创建，这边 detached 起、不等待。
 */
export async function revealInFileManager(abs: string): Promise<RevealOutcome> {
  let isDir: boolean;
  try {
    isDir = (await fsp.stat(abs)).isDirectory();
  } catch {
    return { ok: false, error: 'not_found', message: `路径不存在：${abs}` };
  }
  try {
    if (process.platform === 'win32') {
      // 用 -EncodedCommand 传脚本：-Command 传多行含引号的脚本会被 Windows 命令行转义弄坏，
      // 表现为「powershell 退出码 0、但脚本一行都没执行」（实测 2026-10-21，这是「点了没反应」的真因）。
      await spawnDetached('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(REVEAL_SCRIPT)], {
        // 目标只走 env：脚本正文不拼字符串，路径里的引号 / 空格 / 中文都安全
        WCR_REVEAL_TARGET: abs,
        WCR_REVEAL_ISDIR: isDir ? '1' : '0',
        WCR_REVEAL_DIR: isDir ? abs : path.dirname(abs),
      });
    } else {
      const [cmd, args] = revealCommand(abs, isDir, process.platform);
      await spawnDetached(cmd, args);
    }
  } catch (e) {
    return { ok: false, error: 'failed', message: `打开文件管理器失败：${firstLine((e as Error).message)}` };
  }
  return { ok: true };
}

/** 把 PowerShell 脚本编成 -EncodedCommand 需要的形式（UTF-16LE 的 base64），绕开命令行转义。 */
function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * 起一个不等它的进程（spawn 成功即算交出）。
 *
 * **不能加 detached**（2026-10-21 实测，花了很久才找到）：Windows 下 `detached: true` 起的
 * powershell.exe 会以退出码 0 结束、但脚本一行都没执行（连第一行的日志都没写），
 * 这就是「点了菜单没反应」的真因。服务本身常驻，不需要 detached 也能活下去；
 * unref() 只让父进程的事件循环不等它。
 */
function spawnDetached(cmd: string, args: string[], extraEnv?: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'ignore',
      windowsHide: true,
      ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
    });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', reject);
  });
}

/**
 * macOS / Linux 上要跑的命令与参数（Windows 走 REVEAL_SCRIPT）。
 * 目录是「打开它」；文件是「打开所在目录并选中它」（Linux 的 xdg-open 没有选中，只能开父目录）。
 */
export function revealCommand(abs: string, isDir: boolean, platform: NodeJS.Platform): [string, string[]] {
  if (platform === 'darwin') return isDir ? ['open', [abs]] : ['open', ['-R', abs]];
  return ['xdg-open', [isDir ? abs : path.dirname(abs)]];
}

/**
 * Windows：开资源管理器窗口，并保证它**真的出现在用户眼前**。
 *
 * 四步都来自实测（每一步都曾单独把功能搞挂）：
 * 1) 窗口定位用 EnumWindows 的**快照差集**：COM(Shell.Application) 的 LocationURL 对新窗口会滞后，
 *    按路径匹配经常挑到旧的隐藏窗口；快照必须在 explorer 起来之前做；
 * 2) 选中的窗口先 ShowWindowAsync(SW_RESTORE)：本机 explorer 开出的新窗口是隐藏的，不 restore 永远看不见；
 * 3) 置前要 AttachThreadInput（挂到当前前台线程）+ 补一发 ALT 键：后台进程直接 SetForegroundWindow 会被前台锁拒；
 * 4) 拿不到稳定前台就 SetWindowPos(HWND_TOPMOST) 压 2 秒，让窗口浮在所有普通窗口之上，2 秒后放掉。
 */
const REVEAL_SCRIPT = [
  // 日志最先建：detached 跑时 stdout 被丢弃，脚本哪一步崩了只能靠它（%TEMP%\wcr-reveal.log）
  "$log = Join-Path ([System.IO.Path]::GetTempPath()) 'wcr-reveal.log'",
  "function L($m) { [System.IO.File]::AppendAllText($log, ((Get-Date).ToString('HH:mm:ss') + ' ' + $m + [Environment]::NewLine)) }",
  "L 'boot'",
  "try {",
  "if (-not ('WcrReveal' -as [type])) {",
  "Add-Type -TypeDefinition @\"",
  "using System;",
  "using System.Collections.Generic;",
  "using System.Text;",
  "using System.Runtime.InteropServices;",
  "public class WcrReveal {",
  "  public delegate bool EnumProc(IntPtr h, IntPtr l);",
  "  [DllImport(\"user32.dll\")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);",
  "  [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);",
  "  [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr h);",
  "  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
  "  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);",
  "  [DllImport(\"kernel32.dll\")] public static extern uint GetCurrentThreadId();",
  "  [DllImport(\"user32.dll\")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);",
  "  [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);",
  "  [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr h, int n);",
  "  [DllImport(\"user32.dll\")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);",
  "  [DllImport(\"user32.dll\")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);",
  "  public static List<long> ShellWindows() {",
  "    var list = new List<long>();",
  "    EnumWindows((h, l) => {",
  "      var sb = new StringBuilder(256);",
  "      GetClassNameW(h, sb, 256);",
  "      var cls = sb.ToString();",
  "      if (cls == \"CabinetWClass\" || cls == \"ExploreWClass\") list.Add(h.ToInt64());",
  "      return true;",
  "    }, IntPtr.Zero);",
  "    return list;",
  "  }",
  "  public static void BringToFront(IntPtr h) {",
  "    ShowWindowAsync(h, 9);",
  "    uint fgT = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);",
  "    uint myT = GetCurrentThreadId();",
  "    AttachThreadInput(myT, fgT, true);",
  "    SetForegroundWindow(h);",
  "    AttachThreadInput(myT, fgT, false);",
  "    keybd_event(0x12, 0, 0, UIntPtr.Zero);",
  "    keybd_event(0x12, 0, 2, UIntPtr.Zero);",
  "    SetForegroundWindow(h);",
  "  }",
  "}",
  "\"@",
  "}",
  "} catch { L ('addtype-failed: ' + $_.Exception.Message); exit 0 }",
  "$target = $env:WCR_REVEAL_TARGET",
  "$isDir = $env:WCR_REVEAL_ISDIR -eq \"1\"",
  "$dir = $env:WCR_REVEAL_DIR",
  "$arg = if ($isDir) { $target } else { \"/select,$target\" }",
  "L (\"start target=$target isDir=$isDir dir=$dir\")",
  "$before = [WcrReveal]::ShellWindows()",
  "L (\"snapshot-before=\" + $before.Count)",
  "Start-Process -FilePath \"explorer.exe\" -ArgumentList $arg | Out-Null",
  "$shell = New-Object -ComObject Shell.Application",
  "$hwnd = [long]0",
  "$diag = ''",
  // 优先用 COM 定位：实测 COM 返回的 HWND 能 restore 出来，而 EnumWindows 兜到的那个 restore 无效
  "for ($i = 0; $i -lt 15 -and $hwnd -eq 0; $i++) {",
  "  Start-Sleep -Milliseconds 200",
  "  $matched = @()",
  "  foreach ($w in $shell.Windows()) {",
  "    try {",
  "      if (-not $w.LocationURL -or -not $w.HWND) { continue }",
  "      if (([System.Uri]$w.LocationURL).LocalPath -ine $dir) { continue }",
  "      $matched += [int64]$w.HWND",
  "    } catch {}",
  "  }",
  "  $diag = 'com-matched=' + $matched.Count",
  // 不过滤隐藏窗口：explorer 会把新请求交给隐藏窗口处理，跳过它们就是「点了没反应」
  "  if ($matched.Count) { $hwnd = ($matched | Sort-Object -Descending)[0] }",
  "}",
  // 兜底：COM 还没跟上（新窗口的 LocationURL 滞后）→ 用 EnumWindows 的差集找新窗口
  "if ($hwnd -eq 0) {",
  "  foreach ($h in [WcrReveal]::ShellWindows()) {",
  "    if (-not $before.Contains($h)) { $hwnd = $h; break }",
  "  }",
  "  $diag = $diag + ' enum-fresh=' + $hwnd",
  "}",
  "if ($hwnd -eq 0) { L ('no-window-found ' + $diag); exit 0 }",
  "$h2 = [System.IntPtr]$hwnd",
  "L ('picked hwnd=' + $hwnd + ' visible-before=' + [WcrReveal]::IsWindowVisible($h2) + ' ' + $diag)",
  "[WcrReveal]::BringToFront($h2)",
  "L (\"after-front visible=\" + [WcrReveal]::IsWindowVisible($h2))",
  "$tp = [WcrReveal]::SetWindowPos($h2, [System.IntPtr](-1), 0, 0, 0, 0, 0x0003)",
  "L (\"topmost=$tp visible=\" + [WcrReveal]::IsWindowVisible($h2))",
  "Start-Sleep -Milliseconds 2000",
  "[WcrReveal]::SetWindowPos($h2, [System.IntPtr](-2), 0, 0, 0, 0, 0x0003) | Out-Null",
  "L 'released'",
].join('\n');
// ------------------------------------------------- 新建 / 重命名 / 移动 / 复制（FR-0009）

/** Windows 保留设备名：这些名字（含带扩展名，如 `con.txt`）在 Win32 上建不出来。 */
const WINDOWS_RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/**
 * 路径最后一段（名字）是否可用：空 / `.` / `..` / 非法字符 / 首尾空白 / 结尾点 / 保留名一律拒绝。
 * 路径的其余部分由路由层的 `resolveInside` 与忽略规则负责。
 */
export function isValidEntryName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false;
  if (name !== name.trim()) return false;
  // 控制字符与 Windows 禁用字符（正则在服务端一次性判完，避免不同平台行为不一）
  // eslint-disable-next-line no-control-regex
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) return false;
  if (name.endsWith('.')) return false;
  return !WINDOWS_RESERVED.has(name.split('.')[0].toUpperCase());
}

function errCode(e: unknown): string {
  return (e as NodeJS.ErrnoException)?.code ?? '';
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fsp.stat(abs);
    return true;
  } catch {
    return false;
  }
}

export type CreateOutcome =
  | { ok: true; size: number; mtimeMs: number }
  | { ok: false; error: 'exists' | 'no_parent' | 'failed'; message: string };

/** 新建文件（独占创建：已存在就是 `exists`，绝不覆盖）。`text` 缺省为空文件。 */
export async function createFileEntry(abs: string, text = ''): Promise<CreateOutcome> {
  try {
    await fsp.writeFile(abs, text, { encoding: 'utf8', flag: 'wx' });
  } catch (e) {
    const code = errCode(e);
    if (code === 'EEXIST') return { ok: false, error: 'exists', message: `已存在同名文件或目录：${abs}` };
    if (code === 'ENOENT') return { ok: false, error: 'no_parent', message: `上级目录不存在：${path.dirname(abs)}` };
    return { ok: false, error: 'failed', message: `新建文件失败：${firstLine((e as Error).message)}` };
  }
  const st = await fsp.stat(abs);
  return { ok: true, size: st.size, mtimeMs: st.mtimeMs };
}

/** 新建目录（`recursive`：`a/b/c` 的中间层一并建出；已存在就是 `exists`）。 */
export async function createDirEntry(abs: string): Promise<CreateOutcome> {
  if (await exists(abs)) return { ok: false, error: 'exists', message: `已存在同名文件或目录：${abs}` };
  try {
    await fsp.mkdir(abs, { recursive: true });
  } catch (e) {
    const code = errCode(e);
    if (code === 'EEXIST') return { ok: false, error: 'exists', message: `已存在同名文件或目录：${abs}` };
    if (code === 'ENOENT') return { ok: false, error: 'no_parent', message: `上级目录不存在：${path.dirname(abs)}` };
    return { ok: false, error: 'failed', message: `新建目录失败：${firstLine((e as Error).message)}` };
  }
  return { ok: true, size: 0, mtimeMs: 0 };
}

export type MoveOutcome =
  | { ok: true; from: string; to: string; isDir: boolean }
  | { ok: false; error: 'not_found' | 'exists' | 'no_parent' | 'locked' | 'failed'; message: string };

/**
 * 重命名 / 移动（磁盘层是同一个 `rename`；跨目录移动也走这里）。
 *
 * 两条与 FR-0008 一致的安全约定：
 * 1) 目标已存在就拒绝（不覆盖）—— 例外是 Windows 上的**大小写改名**（`a.ts` → `A.ts`）；
 * 2) 目录改名撞上句柄占用（Windows 上 TGitCache 之类）如实报 `locked`，不静默回退搬移。
 */
export async function renameEntry(absFrom: string, absTo: string): Promise<MoveOutcome> {
  let st;
  try {
    st = await fsp.stat(absFrom);
  } catch {
    return { ok: false, error: 'not_found', message: `路径不存在：${absFrom}` };
  }
  const caseOnly = process.platform === 'win32' && absFrom.toLowerCase() === absTo.toLowerCase();
  if (!caseOnly && (await exists(absTo))) {
    return { ok: false, error: 'exists', message: `目标已存在：${absTo}` };
  }
  try {
    await fsp.rename(absFrom, absTo);
  } catch (e) {
    const code = errCode(e);
    if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
      return {
        ok: false,
        error: 'locked',
        message: `目标被其它进程占用（Windows 上目录改名常见）：${firstLine((e as Error).message)}`,
      };
    }
    if (code === 'ENOENT') return { ok: false, error: 'no_parent', message: `目标上级目录不存在：${path.dirname(absTo)}` };
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return { ok: false, error: 'exists', message: `目标已存在：${absTo}` };
    return { ok: false, error: 'failed', message: `重命名失败：${firstLine((e as Error).message)}` };
  }
  return { ok: true, from: absFrom, to: absTo, isDir: st.isDirectory() };
}

/** 复制一份（文件直接拷，目录连整棵子树）；目标已存在就拒绝，不覆盖。 */
export async function copyEntry(absFrom: string, absTo: string): Promise<MoveOutcome> {
  let st;
  try {
    st = await fsp.stat(absFrom);
  } catch {
    return { ok: false, error: 'not_found', message: `路径不存在：${absFrom}` };
  }
  if (await exists(absTo)) return { ok: false, error: 'exists', message: `目标已存在：${absTo}` };
  try {
    if (st.isDirectory()) {
      await fsp.cp(absFrom, absTo, { recursive: true, errorOnExist: true, force: false });
    } else {
      await fsp.copyFile(absFrom, absTo, fsConstants.COPYFILE_EXCL);
    }
  } catch (e) {
    const code = errCode(e);
    if (code === 'EEXIST') return { ok: false, error: 'exists', message: `目标已存在：${absTo}` };
    if (code === 'ENOENT') return { ok: false, error: 'no_parent', message: `目标上级目录不存在：${path.dirname(absTo)}` };
    return { ok: false, error: 'failed', message: `复制失败：${firstLine((e as Error).message)}` };
  }
  return { ok: true, from: absFrom, to: absTo, isDir: st.isDirectory() };
}
