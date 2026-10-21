/**
 * 2026-10-21 用户要求：被忽略的条目也要出现在文件树里（只是画得最淡），
 * 目录不在扫描时下探、点开才懒加载一层。
 *
 * 覆盖两件事：
 * - `buildAllFileTree`：忽略目录留 `ignored + lazy` 节点（不下探），忽略文件标 `ignored`；
 * - `listDir`：懒加载一层，子项继承祖先的忽略状态；越界路径拿空。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject } from './helpers';
import type { FileNode } from '../../shared/types';

function find(node: FileNode, target: string): FileNode | undefined {
  if (node.path === target) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, target);
    if (hit) return hit;
  }
  return undefined;
}

test('all-files 树：忽略目录留 lazy 节点、忽略文件标 ignored，可索引树不受影响', async () => {
  const fx = await makeProject({
    '.gitignore': '*.log\n',
    'src/main.ts': 'export const a = 1;\n',
    'app.log': 'noise\n',
    'dist/bundle.js': 'var x = 1;\n',
    'node_modules/pkg/index.js': 'module.exports = 1;\n',
  });
  try {
    const tree = fx.project.buildAllFileTree();

    const dist = find(tree, 'dist');
    assert.ok(dist, '被 .gitignore / 内置规则命中的目录要出现在 all-files 树上');
    assert.equal(dist.ignored, true);
    assert.equal(dist.lazy, true, '没下探：子节点要靠 listDir 拉');
    assert.equal(dist.children, undefined);

    assert.equal(find(tree, 'node_modules')?.ignored, true, '内置黑名单目录同样展示');
    assert.equal(find(tree, 'app.log')?.ignored, true, '忽略文件也展示（淡色）');
    assert.equal(find(tree, 'src/main.ts')?.ignored, undefined, '普通文件不受影响');
    assert.equal(find(tree, 'dist/bundle.js'), undefined, '忽略目录内部不预扫');

    // 可索引树（/files）保持原口径：忽略的一律不出现
    const indexedTree = fx.project.buildFileTree();
    assert.equal(find(indexedTree, 'dist'), undefined);
    assert.equal(find(indexedTree, 'app.log'), undefined);
    assert.ok(find(indexedTree, 'src/main.ts'));
  } finally {
    await fx.cleanup();
  }
});

test('listDir：懒加载一层，子项继承祖先的忽略状态', async () => {
  const fx = await makeProject({
    'src/main.ts': 'export const a = 1;\n',
    'dist/a.js': '1;\n',
    'dist/sub/b.js': '2;\n',
  });
  try {
    const nodes = await fx.project.listDir('dist');
    assert.deepEqual(
      nodes.map((n) => n.name),
      ['sub', 'a.js'],
      '目录在前、文件在后',
    );
    const sub = nodes.find((n) => n.name === 'sub')!;
    assert.equal(sub.type, 'directory');
    assert.equal(sub.lazy, true);
    assert.equal(sub.ignored, true, '祖先 dist 被内置黑名单命中，子目录继承');
    assert.equal(nodes.find((n) => n.name === 'a.js')!.ignored, true);

    const inner = await fx.project.listDir('dist/sub');
    assert.equal(inner.length, 1);
    assert.equal(inner[0].ignored, true, '再深一层也靠祖先继承，而不是看名字');

    assert.deepEqual(await fx.project.listDir('../../etc'), [], '越界路径返回空');
  } finally {
    await fx.cleanup();
  }
});

test('listDir 排序：目录在前、文件在后，被忽略的沉到同类最后', async () => {
  const fx = await makeProject({
    '.gitignore': '*.log\n',
    'src/main.ts': 'export const a = 1;\n',
    'dist/a.js': '1;\n',
    'app.log': 'noise\n',
    '.editorconfig': 'root = true\n',
  });
  try {
    const names = (await fx.project.listDir('')).map((n) => `${n.type === 'directory' ? 'd' : 'f'}:${n.name}`);
    assert.deepEqual(
      names,
      ['d:src', 'd:dist', 'f:.editorconfig', 'f:.gitignore', 'f:app.log'],
      'dist 是忽略目录（排在普通目录之后）、app.log 是忽略文件（排在普通文件之后）',
    );
  } finally {
    await fx.cleanup();
  }
});
