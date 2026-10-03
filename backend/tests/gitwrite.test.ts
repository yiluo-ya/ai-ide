/**
 * 变更栏的写操作（2026-10-03 用户要求）：`add -A` / `commit -m` / `pull --ff-only` / `push`。
 *
 * 三条断言方向：
 * 1) 空提交说明**直接拒绝**（不把 git 拉起来 —— 服务端开编辑器是灾难）；
 * 2) 真仓库里 add + commit 确实落了一次提交（用 `git log` 复核，不信返回值自说自话）；
 * 3) 让 git 自己失败时（非仓库 / 没有远端）如实回报 ok:false + 原话，不假装成功。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeProject } from './helpers';
import { gitAddAll, gitCommit, gitPull, gitPush } from '../src/indexer/gitwrite';

const run = promisify(execFile);

/** 造一个带一次提交的仓库；本机没有 git 时返回 false，调用方 skip。 */
async function initRepo(root: string): Promise<boolean> {
  try {
    await run('git', ['-C', root, 'init'], { windowsHide: true });
    // 仓库级身份：后续 gitCommit 不带 -c，也必须有 user.name / user.email 才能提交
    await run('git', ['-C', root, 'config', 'user.email', 't@example.com'], { windowsHide: true });
    await run('git', ['-C', root, 'config', 'user.name', 't'], { windowsHide: true });
    await run('git', ['-C', root, 'add', '.'], { windowsHide: true });
    await run('git', ['-C', root, 'commit', '-m', 'init'], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

test('gitwrite: 空提交说明不拉起 git，直接拒绝', async () => {
  const fx = await makeProject({ 'src/a.ts': 'export const a = 1;\n' });
  try {
    const blank = await gitCommit(fx.root, '   \n ');
    assert.equal(blank.ok, false);
    assert.match(blank.summary, /提交说明不能为空/);
    const tooLong = await gitCommit(fx.root, 'x'.repeat(2001));
    assert.equal(tooLong.ok, false);
    assert.match(tooLong.summary, /太长/);
  } finally {
    await fx.cleanup();
  }
});

test('gitwrite: add + commit 真的落了一次提交', async (t) => {
  const fx = await makeProject({ 'src/a.ts': 'export const a = 1;\n' });
  try {
    if (!(await initRepo(fx.root))) {
      t.skip('本机 git 不可用，跳过');
      return;
    }
    await fsp.writeFile(path.join(fx.root, 'src', 'b.ts'), 'export const b = 2;\n');

    const add = await gitAddAll(fx.root);
    assert.equal(add.ok, true, `add 应成功：${add.summary}`);

    const commit = await gitCommit(fx.root, '加一个 b');
    assert.equal(commit.ok, true, `commit 应成功：${commit.summary}`);

    // 复核：HEAD 的标题就是刚写的说明，且工作区已干净（暂存区没留下东西）
    const log = await run('git', ['-C', fx.root, 'log', '-1', '--pretty=%s'], { windowsHide: true });
    assert.equal(log.stdout.trim(), '加一个 b');
    const status = await run('git', ['-C', fx.root, 'status', '--porcelain'], { windowsHide: true });
    assert.equal(status.stdout.trim(), '');
  } finally {
    await fx.cleanup();
  }
});

test('gitwrite: pull / push 没有远端时如实失败（不假装成功）', async (t) => {
  const fx = await makeProject({ 'src/a.ts': 'export const a = 1;\n' });
  try {
    if (!(await initRepo(fx.root))) {
      t.skip('本机 git 不可用，跳过');
      return;
    }
    for (const [name, res] of [
      ['pull', await gitPull(fx.root)],
      ['push', await gitPush(fx.root)],
    ] as const) {
      assert.equal(res.ok, false, `${name} 没有远端时不该报成功`);
      assert.ok((res.stderr || res.stdout).length > 0, `${name} 失败要带上 git 的原话`);
      assert.ok(res.summary.length > 0, `${name} 失败也要有一句人话`);
    }
  } finally {
    await fx.cleanup();
  }
});

test('gitwrite: 非 git 目录下四个命令都失败且不抛', async () => {
  const fx = await makeProject({ 'src/a.ts': 'export const a = 1;\n' });
  try {
    for (const res of [
      await gitAddAll(fx.root),
      await gitCommit(fx.root, 'x'),
      await gitPull(fx.root),
      await gitPush(fx.root),
    ]) {
      assert.equal(res.ok, false, '非 git 目录不该报成功');
      assert.ok(res.summary.length > 0, '失败也要有一句人话');
    }
  } finally {
    await fx.cleanup();
  }
});
