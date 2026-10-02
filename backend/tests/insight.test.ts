/** 项目地图概览：身份卡 / 语言分布 / 元信息 / README。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject } from './helpers';
import { buildOverview } from '../src/indexer/insight';

const FILES = {
  'package.json': `${JSON.stringify(
    { name: 'demo-app', main: 'src/index.ts', scripts: { start: 'node src/index.ts' } },
    null,
    2,
  )}\n`,
  'README.md': '# Demo\n\n一句话说明。\n',
  'src/util.ts': `export const CONST = 42;

export function helper(v: string): string {
  return v + CONST;
}
`,
  'src/index.ts': `import { helper } from './util';

if (helper('x')) {
  console.log('ok');
}
`,
  'src/unused.ts': `export const nothing = 1;
`,
  'src/a.ts': `import { b } from './b';

export const a = b;
`,
  'src/b.ts': `import { a } from './a';

export const b = a;
`,
  'tests/util.test.ts': `import { helper } from '../src/util';

test('works', () => {
  helper('a');
});
`,
};

test('insight: 身份卡 / 语言分布 / 元信息 / README', async () => {
  const fx = await makeProject(FILES);
  try {
    const overview = await buildOverview(fx.project);
    assert.equal(overview.identity.files, 8, 'README + package.json + 6 个 ts');
    assert.equal(overview.identity.dirs, 2, 'src / tests');
    assert.ok(overview.identity.bytes > 0);
    assert.ok(overview.identity.lines > 0);

    const ts = overview.identity.langs.find((l) => l.lang === 'typescript');
    assert.equal(ts?.files, 6);

    assert.equal(overview.meta.kind, 'npm');
    assert.equal(overview.meta.name, 'demo-app');
    assert.deepEqual(overview.meta.scripts, ['start']);
    assert.ok(overview.meta.declaredEntries.includes('src/index.ts'), 'package.json main 应被识别为入口');

    assert.equal(overview.readme?.path, 'README.md');
    assert.match(overview.readme?.excerpt ?? '', /# Demo/);
  } finally {
    await fx.cleanup();
  }
});
