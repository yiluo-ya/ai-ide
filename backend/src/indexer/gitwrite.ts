/**
 * git 写操作（2026-10-03 用户要求：变更栏加 add all / commit / pull / push）。
 *
 * 与 `gitread.ts` 的分工：那边是**只读**清单（diff / blame / 历史），这边是**唯一的写入口**，
 * 而且只有这四个动作，没有「任意 git」「任意 shell」：
 *   `git add -A` / `git commit -m <msg>` / `git pull --ff-only` / `git push`
 *
 * 三条安全约定：
 * 1) 参数用 `execFile` 数组传递，**不经 shell**；commit message 也是数组里的一项，
 *    不会拼进命令行字符串（`;` `$()` 这类字符只是普通文本）；
 * 2) `pull` 固定 `--ff-only`：宁可失败让用户自己处理，也不偷偷产生合并提交；
 * 3) 只在本机模式下暴露（路由层判断），且失败一律如实回报 code/stderr，不假装成功。
 */
import { execFile } from 'node:child_process';
import type { GitRunResult, GitWriteAction } from '../types';

/** 写操作超时：push / pull 可能较慢，给到 60 秒。 */
const WRITE_TIMEOUT_MS = 60_000;
/** 回报给前端的输出上限（够看结论，不把终端刷屏）。 */
const MAX_OUTPUT = 20_000;

export type { GitWriteAction, GitRunResult };

function clip(text: string): string {
  const t = text.trim();
  return t.length > MAX_OUTPUT ? `${t.slice(0, MAX_OUTPUT)}\n…（输出已截断）` : t;
}

function run(root: string, args: string[]): Promise<GitRunResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', root, ...args],
      { timeout: WRITE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdoutRaw, stderrRaw) => {
        const stdout = clip(String(stdoutRaw ?? ''));
        const stderr = clip(String(stderrRaw ?? ''));
        if (err) {
          const raw = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
          const notInstalled = raw.code === 'ENOENT';
          const timedOut = raw.killed === true;
          const exitCode = typeof raw.code === 'number' ? raw.code : null;
          const reason = notInstalled
            ? '本机没有找到 git 命令'
            : timedOut
              ? `超过 ${WRITE_TIMEOUT_MS / 1000} 秒没结束（网络慢或远端无响应）`
              : `git ${args[0]} 失败（退出码 ${exitCode ?? '未知'}）`;
          resolve({
            ok: false,
            code: exitCode,
            stdout,
            stderr: stderr || raw.message,
            summary: `${reason}：${(stderr || stdout || raw.message).split('\n')[0].slice(0, 200)}`,
          });
          return;
        }
        resolve({ ok: true, code: 0, stdout, stderr, summary: summarize(args, stdout, stderr) });
      },
    );
  });
}

/** 成功时的一句话：git 自己会输出有信息量的结果，优先用它，没有才退回家常话。 */
function summarize(args: string[], stdout: string, stderr: string): string {
  const first = (stdout || stderr).split('\n').map((l) => l.trim()).filter(Boolean)[0];
  if (first) return first.slice(0, 200);
  const verb = args[0];
  if (verb === 'add') return '已把全部改动加入暂存区';
  if (verb === 'commit') return '已提交';
  if (verb === 'pull') return '已拉取（fast-forward）';
  return '已推送';
}

export const gitAddAll = (root: string): Promise<GitRunResult> => run(root, ['add', '-A']);

/**
 * 提交。message 作为数组里独立的一项传给 git，不经 shell。
 * 空 message 直接拒绝 —— git 自己会开编辑器，那在服务端是灾难。
 */
export async function gitCommit(root: string, message: string): Promise<GitRunResult> {
  const trimmed = message.trim();
  if (!trimmed) {
    return { ok: false, code: null, stdout: '', stderr: '', summary: '提交说明不能为空' };
  }
  if (trimmed.length > 2000) {
    return { ok: false, code: null, stdout: '', stderr: '', summary: '提交说明太长了（上限 2000 字）' };
  }
  return run(root, ['commit', '-m', trimmed]);
}

export const gitPull = (root: string): Promise<GitRunResult> => run(root, ['pull', '--ff-only']);

export const gitPush = (root: string): Promise<GitRunResult> => run(root, ['push']);
