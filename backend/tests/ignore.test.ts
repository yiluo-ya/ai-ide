/**
 * P8 忽略规则单测：`.gitignore` 基本语法、`!` 取反、优先级（.wcrignore > .gitignore > builtin）、
 * `node_modules` / `.git` 硬保护、`info()` 的 sources / ignored / overridden。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IgnoreMatcher } from '../src/indexer/ignore';

async function makeRoot(files: Record<string, string> = {}): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-ignore-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, text, 'utf8');
  }
  return root;
}

test('ignore: .gitignore 基本语法（dir/、*.log、/root-only、**/x）', async (t) => {
  const root = await makeRoot({
    '.gitignore': ['build/', '*.log', '/root-only.txt', '**/gen/**'].join('\n'),
  });
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const ig = await IgnoreMatcher.load(root);

  // `build/` 只匹配目录，且不含 `/` → 任意层级
  assert.equal(ig.ignoresDir('build', 'build'), true);
  assert.equal(ig.ignoresDir('src/build', 'build'), true);
  // 目录规则不该命中同名文件
  assert.equal(ig.ignoresFile('src/build'), false);

  // `*.log` 任意层级
  assert.equal(ig.ignoresFile('app.log'), true);
  assert.equal(ig.ignoresFile('deep/nested/app.log'), true);
  assert.equal(ig.ignoresFile('app.log.txt'), false);

  // `/root-only.txt` 锚定项目根
  assert.equal(ig.ignoresFile('root-only.txt'), true);
  assert.equal(ig.ignoresFile('src/root-only.txt'), false);

  // `**/gen/**` 跨层匹配
  assert.equal(ig.ignoresFile('src/gen/x.ts'), true);
  assert.equal(ig.ignoresFile('gen/x.ts'), false, '`**/` 需要至少一层前缀（gitignore 同款）');
});

test('ignore: `!` 取反 —— 后者胜（规则顺序即优先级）', async (t) => {
  const root = await makeRoot({
    '.gitignore': ['*.log', '!keep.log'].join('\n'),
  });
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const ig = await IgnoreMatcher.load(root);
  assert.equal(ig.ignoresFile('keep.log'), false, '后面的 ! 把前面的排除打开');
  assert.equal(ig.ignoresFile('other.log'), true);

  const root2 = await makeRoot({
    '.gitignore': ['!important.log', '*.log'].join('\n'),
  });
  t.after(() => fsp.rm(root2, { recursive: true, force: true }));
  const ig2 = await IgnoreMatcher.load(root2);
  assert.equal(ig2.ignoresFile('important.log'), true, '排除规则在后 → 取反被覆盖');
});

test('ignore: 优先级 .wcrignore > .gitignore > builtin', async (t) => {
  const root = await makeRoot({
    '.gitignore': ['secret.txt', 'dist/'].join('\n'),
    '.wcrignore': ['!secret.txt'].join('\n'),
  });
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const ig = await IgnoreMatcher.load(root);

  assert.equal(ig.ignoresFile('secret.txt'), false, '.wcrignore 的 ! 覆盖 .gitignore');
  assert.equal(ig.ignoresDir('dist', 'dist'), true, '.wcrignore 没提 dist，.gitignore 生效');

  // 内置黑名单可被 .wcrignore 的 ! 打开
  const root2 = await makeRoot({ '.wcrignore': ['!coverage/'].join('\n') });
  t.after(() => fsp.rm(root2, { recursive: true, force: true }));
  const ig2 = await IgnoreMatcher.load(root2);
  assert.equal(ig2.ignoresDir('coverage', 'coverage'), false, '! 可打开内置目录黑名单');
});

test('ignore: node_modules / .git 是硬保护，任何 ! 都打不开', async (t) => {
  const root = await makeRoot({
    '.wcrignore': ['!node_modules', '!node_modules/pkg/index.js', '!.git', '!.git/config'].join('\n'),
  });
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const ig = await IgnoreMatcher.load(root);

  assert.equal(ig.ignoresDir('node_modules', 'node_modules'), true);
  assert.equal(ig.ignoresFile('node_modules/pkg/index.js'), true);
  assert.equal(ig.ignoresDir('.git', '.git'), true);
  assert.equal(ig.ignoresFile('.git/config'), true);
  // 深层路径里含 node_modules 段，同样整棵忽略
  assert.equal(ig.ignoresFile('packages/a/node_modules/x/y.ts'), true);
  assert.equal(ig.ignoresPath('node_modules', true), true);
});

test('ignore: info() 给出 sources / 规则数 / ignored / overridden', async (t) => {
  const root = await makeRoot({
    '.gitignore': ['*.log', 'tmp/'].join('\n'),
    '.wcrignore': ['!keep.log'].join('\n'),
  });
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const ig = await IgnoreMatcher.load(root);

  assert.equal(ig.ignoresFile('keep.log'), false);
  const info = ig.info(7);
  assert.deepEqual(
    info.sources.map((s) => s.path),
    ['.gitignore', '.wcrignore'],
  );
  for (const s of info.sources) assert.ok(s.rules > 0, `${s.path} 应解析出规则`);
  assert.equal(info.ignored, 7, 'ignored 由调用方统计后透传');
  assert.ok(info.overridden.includes('keep.log'), '被 ! 重新纳入的路径要可见');
  assert.ok(info.builtinDirs > 0 && info.builtinPatterns > 0, '内置黑名单计数');
  assert.ok(ig.ruleCount >= info.builtinDirs);
});
