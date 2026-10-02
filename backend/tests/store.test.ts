/** 项目存储层：文本搜索的大小写 / 正则 / glob / 整词开关。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject } from './helpers';

const FILES = {
  'src/app.py': `import os


def main():
    print("hello world")
`,
  'src/util.py': `def helper():
    return "Hello World"
`,
  'README.md': '# hello world\n\nHello 项目\n',
  'node_modules/junk/index.js': 'export const junk = 1;\n',
  'dist/bundle.js': 'var x=1;\n',
};

test('store: 文本搜索（大小写 / 正则 / glob / 整词）', async () => {
  const fx = await makeProject(FILES);
  try {
    const ci = await fx.project.searchText('hello world');
    assert.equal(ci.matches.length, 3, 'README 1 处 + app.py 1 处 + util.py 1 处');

    const cs = await fx.project.searchText('hello world', { caseSensitive: true });
    assert.equal(cs.matches.length, 2, 'README 的 # hello world 与 app.py 的 print("hello world")');
    assert.ok(!cs.matches.some((m) => m.file === 'src/util.py'), 'util.py 的 Hello World 不应命中');

    const re = await fx.project.searchText('hel+o', { regex: true });
    assert.ok(re.matches.length >= 1);

    const glob = await fx.project.searchText('hello', { filePattern: '*.md' });
    assert.deepEqual([...new Set(glob.matches.map((m) => m.file))], ['README.md']);

    const word = await fx.project.searchText('hell', { wholeWord: true });
    assert.equal(word.matches.length, 0, '整词匹配不应命中 hell(o)');

    await assert.rejects(() => fx.project.searchText('(', { regex: true }), /invalid regex/);
  } finally {
    await fx.cleanup();
  }
});
