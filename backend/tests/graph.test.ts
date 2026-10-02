/** 依赖图：目录级聚合、跨目录边与外部依赖节点。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject } from './helpers';
import { buildGraph } from '../src/indexer/graph';

const FILES = {
  'src/util.ts': `export const CONST = 42;

export function helper(v: string): string {
  return v + CONST;
}
`,
  'src/index.ts': `import { helper } from './util';

export const out = helper('x');
`,
  'lib/helper.ts': `import { helper } from '../src/util';

export const wrapped = helper('y');
`,
  'src/a.ts': `import { b } from './b';

export const a = b;
`,
  'src/b.ts': `import { a } from './a';

export const b = a;
`,
  'src/alone.ts': `export const alone = 1;
`,
  'tests/util.test.ts': `import { helper } from '../src/util';

test('works', () => helper('a'));
`,
  'src/external.ts': `import react from 'react';
import { readFile } from 'node:fs/promises';

export const both = [react, readFile];
`,
};

test('graph: 目录级聚合 + 外部依赖节点', async () => {
  const fx = await makeProject(FILES);
  try {
    const graph = buildGraph(fx.project, { external: 20 });
    assert.equal(graph.level, 'dir');

    const ids = graph.nodes.map((n) => n.id);
    assert.ok(ids.includes('src/'), '应有 src/ 目录节点');
    assert.ok(ids.includes('lib/'));
    assert.ok(ids.includes('tests/'));

    // 跨目录边：lib/ → src/（tests/ → src/ 同理），同目录内的互引不产生边
    // 默认会把热点（util.ts）提到文件级，所以边落在具体的文件节点上
    const cross = graph.edges.find((e) => e.from === 'lib/' && e.to === 'src/util.ts');
    assert.ok(cross, 'lib/ 应有一条指向 src/util.ts（热点被提到文件级）的边');
    assert.ok(!graph.edges.some((e) => e.from === 'src/' && e.to === 'src/'), '同目录不出自环');

    // 外部依赖（Top 20）
    const names = graph.externals.map((e) => e.name);
    assert.ok(names.includes('react'));
    assert.ok(names.includes('node:fs'));
    assert.ok(ids.includes('ext:react'), '外部依赖应作为聚合节点出现');

    const ext = graph.edges.find((e) => e.to === 'ext:react');
    assert.equal(ext?.from, 'src/', 'src/external.ts 所在的目录指向 react');

    // 分层按职责（M4.2）：src/ 只被依赖、不依赖别人 → 基础设施层（无 duties 时按依赖方向回退）
    const src = graph.nodes.find((n) => n.id === 'src/');
    assert.equal(src?.layer, 'infra', '只被依赖、不依赖他人 = 基础设施层');
    const testsDir = graph.nodes.find((n) => n.id === 'tests/');
    assert.equal(testsDir?.layer, 'entry', '只依赖他人、不被依赖 = 入口层');
    // 泳道分组：每个目录节点都应落进某个泳道
    assert.ok(graph.lanes.length > 0, '应给出泳道分组');
    const laneNodeIds = graph.lanes.flatMap((l) => l.nodes);
    assert.ok(laneNodeIds.includes('src/') && laneNodeIds.includes('tests/'));
  } finally {
    await fx.cleanup();
  }
});
