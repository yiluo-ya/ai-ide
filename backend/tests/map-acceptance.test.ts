/** 01-map 验收补测：口径表 —— 每个数字都带 note。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject } from './helpers';
import { buildOverview, HOT_METRIC_LABEL, metricNotes } from '../src/indexer/insight';

const FILES = {
  'README.md': '# demo\n\n这是给测试用的项目。\n',
  'src/util.ts': `/** 通用小工具集。 */
export const CONST = 42;

export function helper(v: string): string {
  if (v) {
    return v + CONST;
  }
  return v;
}
`,
  'src/index.ts': `import { helper } from './util';

export function main(): number {
  return helper('x').length;
}
`,
  'utils/format.ts': `export const fmt = (n: number): string => String(n);
`,
  'lib/wrap.ts': `import { helper } from '../src/util';

export const wrapped = helper('y');
`,
  'tests/util.test.ts': `import { helper } from '../src/util';

test('works', () => helper('a'));
`,
};

test('口径：每个数字都带 note（§4 硬约束①）', async () => {
  const fx = await makeProject(FILES);
  try {
    const overview = await buildOverview(fx.project);
    for (const key of ['files', 'dirs', 'bytes', 'lines', 'indexedFiles', 'langs', 'recent']) {
      const note = overview.notes[key];
      assert.ok(note, `缺少 ${key} 的口径说明`);
      assert.ok(note.label.length > 0 && note.unit.length > 0);
      assert.equal(typeof note.includesTests, 'boolean', '口径必须说明是否含测试');
    }
    // 默认为降噪口径：注明「已排除测试」
    assert.equal(overview.notes.files.includesTests, false);
    assert.match(overview.notes.files.label, /排除测试/);

    const noisy = await buildOverview(fx.project, { denoise: false });
    assert.equal(noisy.notes.files.includesTests, true);
    assert.match(noisy.notes.files.label, /含测试/);

    // 语言分布自带测试文件数，前端才能给出「不含测试」的第二档
    const ts = overview.identity.langs.find((l) => l.lang === 'typescript');
    assert.equal(ts?.tests, 1, 'tests/util.test.ts 应计入该语言的测试数');
    assert.ok((ts?.lines ?? 0) > 0, '语言分布应带行数');

    assert.equal(metricNotes(true).hot.label.includes(HOT_METRIC_LABEL.files), true);
  } finally {
    await fx.cleanup();
  }
});
