/**
 * 项目文件的写操作（2026-10-10 用户要求）：编辑器直接改文件、文件树删文件 / 目录。
 *
 * 与 `gitwrite.ts` 并列 —— 那边写的是 git 历史，这边写的是**工作区的文件本身**。
 * 三条安全约定：
 * 1) 只碰调用方（路由层）已用 `ProjectIndex.resolveInside` 校验过的绝对路径；
 * 2) 删除**只走系统回收站**：回收站不可用时如实报错，绝不静默改成永久删除；
 * 3) 写入带 `baseMtimeMs` 冲突检测：磁盘在编辑期间被外部改过就拒绝写，把决定权交回用户。
 */
import { execFile } from 'node:child_process';
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
