/**
 * 04 W3：只读 git 扩展（G7.2–G7.5）的降级与安全边界。
 *
 * 两条断言方向：
 * 1) 非 git 目录（测试用的系统临时目录）→ 每个函数都返回 null，且**不抛**；
 * 2) rev / path 非法（参数注入、路径穿越）→ 同样返回 null，绝不放行到 git。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject } from './helpers';
import { blame, diffNumstat, fileDiff, fileHistory, isValidRev, showFile } from '../src/indexer/gitread';

test('gitread: 非 git 目录全部降级为 null 且不抛', async () => {
  const fx = await makeProject({ 'src/a.ts': 'export const a = 1;\n' });
  try {
    assert.equal(await diffNumstat(fx.root), null, '非 git 目录没有 numstat');
    assert.equal(await diffNumstat(fx.root, 'HEAD'), null, '显式 HEAD 同样降级');
    assert.equal(await fileDiff(fx.root, 'src/a.ts'), null, '非 git 目录没有 diff');
    assert.equal(await blame(fx.root, 'src/a.ts'), null, '非 git 目录没有 blame');
    assert.equal(await fileHistory(fx.root, 'src/a.ts'), null, '非 git 目录没有文件历史');
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
