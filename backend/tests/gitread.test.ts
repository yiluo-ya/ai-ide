/**
 * 04 W3：只读 git 扩展（G7.2–G7.5）的降级与安全边界。
 *
 * 两条断言方向：
 * 1) 非 git 目录（测试用的系统临时目录）→ 每个函数都返回 null，且**不抛**；
 * 2) rev / path 非法（参数注入、路径穿越）→ 同样返回 null，绝不放行到 git。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeProject } from './helpers';
import {
  blame,
  diffNumstat,
  fileDiff,
  fileHistory,
  isValidRev,
  repoLog,
  showFile,
  worktreeChanges,
} from '../src/indexer/gitread';

const run = promisify(execFile);

/** 造一个已有一次提交的仓库；本机没有 git 时返回 false，调用方 skip。 */
async function initRepo(root: string): Promise<boolean> {
  try {
    await run('git', ['-C', root, 'init', '-q'], { windowsHide: true });
    await run('git', ['-C', root, 'config', 'user.email', 't@example.com'], { windowsHide: true });
    await run('git', ['-C', root, 'config', 'user.name', 't'], { windowsHide: true });
    await run('git', ['-C', root, 'add', '-A'], { windowsHide: true });
    await run('git', ['-C', root, 'commit', '-qm', 'init'], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

test('gitread: 非 git 目录全部降级为 null 且不抛', async () => {
  const fx = await makeProject({ 'src/a.ts': 'export const a = 1;\n' });
  try {
    assert.equal(await diffNumstat(fx.root), null, '非 git 目录没有 numstat');
    assert.equal(await diffNumstat(fx.root, 'HEAD'), null, '显式 HEAD 同样降级');
    assert.equal(await fileDiff(fx.root, 'src/a.ts'), null, '非 git 目录没有 diff');
    assert.equal(await blame(fx.root, 'src/a.ts'), null, '非 git 目录没有 blame');
    assert.equal(await fileHistory(fx.root, 'src/a.ts'), null, '非 git 目录没有文件历史');
    assert.equal(await repoLog(fx.root), null, '非 git 目录没有仓库提交历史');
    assert.equal(await showFile(fx.root, 'HEAD', 'src/a.ts'), null, '非 git 目录拿不到历史版本');
  } finally {
    await fx.cleanup();
  }
});

test('gitread: 非法 rev / 越界 path 一律拒绝', async () => {
  const fx = await makeProject({ 'src/a.ts': 'export const a = 1;\n' });
  try {
    // rev 白名单：shell 注入串、超长串都不是合法 rev
    assert.equal(isValidRev('; rm -rf /'), false);
    assert.equal(isValidRev('HEAD; rm -rf /'), false);
    assert.equal(isValidRev('x'.repeat(41)), false);
    assert.equal(isValidRev('HEAD'), true);
    assert.equal(isValidRev('HEAD~3'), true);
    assert.equal(isValidRev('deadbeef'), true, '4~40 位十六进制 sha 合法');

    assert.equal(await diffNumstat(fx.root, '; rm -rf /'), null);
    assert.equal(await fileDiff(fx.root, 'src/a.ts', '; rm -rf /'), null);
    assert.equal(await showFile(fx.root, '; rm -rf /', 'src/a.ts'), null, '非法 rev 不进 git 参数');

    // 路径穿越 / 绝对路径越界：不落在项目根内一律拒绝
    assert.equal(await showFile(fx.root, 'HEAD', '../outside.ts'), null);
    assert.equal(await blame(fx.root, '../outside.ts'), null);
    assert.equal(await fileHistory(fx.root, '../../etc/passwd'), null);
    assert.equal(await fileDiff(fx.root, 'src/../../outside.ts'), null);
  } finally {
    await fx.cleanup();
  }
});

/**
 * 2026-10-03 用户要求：「未跟踪是 ignore 还是新增的，没有在 ignore 就是新增，在 ignore 就直接忽略。不显示。」
 * 钉住两条：没被忽略的新文件按 added 报（不再是单独的「未跟踪」档）；被 .gitignore 的文件不进清单。
 */
test('worktreeChanges: 未跟踪按新增报，被 .gitignore 的文件不出现', async (t) => {
  const fx = await makeProject({ 'src/a.ts': 'export const a = 1;\n' });
  try {
    if (!(await initRepo(fx.root))) {
      t.skip('本机 git 不可用，跳过');
      return;
    }
    await fsp.writeFile(path.join(fx.root, '.gitignore'), 'ignored.txt\n');
    await fsp.writeFile(path.join(fx.root, 'ignored.txt'), 'x\n');
    await fsp.writeFile(path.join(fx.root, 'src', 'new.ts'), 'export const n = 1;\n');
    await fsp.writeFile(path.join(fx.root, 'src', 'a.ts'), 'export const a = 2;\n');

    const res = await worktreeChanges(fx.root);
    assert.equal(res.isRepo, true);
    const status = new Map(res.entries.map((e) => [e.file, e.status]));
    assert.equal(status.get('src/new.ts'), 'added', `未跟踪的新文件应按新增报：${JSON.stringify(res.entries)}`);
    assert.equal(status.get('src/a.ts'), 'modified');
    assert.equal(status.get('.gitignore'), 'added', '刚建的 .gitignore 自己也是未跟踪的新文件');
    assert.equal(status.has('ignored.txt'), false, '被 .gitignore 忽略的文件不该出现在变更清单里');
    // 没有任何一条状态叫 untracked（这一档已按用户要求取消）
    assert.equal(res.entries.some((e) => (e.status as string) === 'untracked'), false);
  } finally {
    await fx.cleanup();
  }
});

/** 仓库级提交历史（SCM commits 视图，2026-10-09）：提交按新→旧，字段齐全。 */
test('repoLog: 返回最近提交，短 sha / 作者 / 摘要齐全', async (t) => {
  const fx = await makeProject({ 'src/a.ts': 'export const a = 1;\n' });
  try {
    if (!(await initRepo(fx.root))) {
      t.skip('本机 git 不可用，跳过');
      return;
    }
    // 再补一提交，用可断言的摘要
    await fsp.writeFile(path.join(fx.root, 'src', 'a.ts'), 'export const a = 2;\n');
    await run('git', ['-C', fx.root, 'add', '-A'], { windowsHide: true });
    await run('git', ['-C', fx.root, 'commit', '-qm', 'second'], { windowsHide: true });

    const log = await repoLog(fx.root, 10);
    assert.ok(log, 'git 仓库应有提交历史');
    assert.ok(log.length >= 2, `至少两条提交：${JSON.stringify(log)}`);
    assert.equal(log[0].summary, 'second', '最新提交在最前');
    assert.match(log[0].rev, /^[0-9a-f]{7,40}$/, '完整 sha 合法');
    assert.ok(log[0].shortRev.length <= log[0].rev.length, '短 sha 不长于完整 sha');
    assert.ok(log[0].author.length > 0, '有作者');
    assert.ok(Number.isFinite(log[0].at) && log[0].at > 0, '有提交时间');

    // limit 钳制：要 1 条就只给 1 条
    const one = await repoLog(fx.root, 1);
    assert.equal(one?.length, 1);
  } finally {
    await fx.cleanup();
  }
});
