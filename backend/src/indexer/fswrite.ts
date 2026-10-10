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
import fsp from 'node:fs/promises';

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
