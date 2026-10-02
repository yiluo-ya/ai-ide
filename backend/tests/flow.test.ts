/**
 * 04 W5：流视图数据（G9.1–G9.4）。
 *
 * 断言：
 * - `calls`：从调用方出发能拿到被调用方节点与边，覆盖率字段存在；
 * - `data`：名字级近似 —— 实参名命中形参名才有一条 `approx: true` 的边，
 *   匹配不上的实参**不画边**（不猜）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, locate } from './helpers';
import { flowGraph } from '../src/indexer/flow';

const FILES = {
  'src/util.ts': `export function double(n: number): number {
  return n * 2;
}
`,
  // 调用点实参叫 value / 字面量 3，都与形参名 n 不同 → 不应画出 data 边
  'src/caller.ts': `import { double } from './util';

export function useDouble(value: number): number {
  return double(value);
}

export const lit = double(3);
`,
  // 调用点实参也叫 n → 命中形参名，画一条 data 边
  'src/plain.ts': `import { double } from './util';

export function plain(n: number): number {
  return double(n);
}
`,
};

test('flow(calls): 从调用方出发拿到被调用方节点与边', async () => {
  const fx = await makeProject(FILES);
  try {
    const pos = locate(fx.project, 'src/caller.ts', 'useDouble');
    const result = flowGraph(fx.project, {
      file: 'src/caller.ts',
      line: pos.line,
      col: pos.col,
      kind: 'calls',
      depth: 1,
    });
    assert.ok(result, '应能定位到 useDouble');
    assert.equal(result.kind, 'calls');
    assert.equal(result.focus.name, 'useDouble');
    assert.ok(result.focus.line > 0);

    const target = result.nodes.find((n) => n.file === 'src/util.ts' && n.name === 'double');
    assert.ok(target, `节点里应有 double；实际：${result.nodes.map((n) => n.name).join(', ')}`);
    assert.equal(target.depth, 1, '直接被调用方在第 1 层');
    assert.ok(
      result.edges.some((e) => e.target === target.id && e.source === result.nodes.find((n) => n.name === 'useDouble')!.id),
      '焦点 → double 应有一条边',
    );

    assert.deepEqual(Object.keys(result.coverage).sort(), ['external', 'resolved', 'unresolved']);
    assert.ok(typeof result.coverage.resolved === 'number');
    assert.equal(typeof result.truncated, 'boolean');
  } finally {
    await fx.cleanup();
  }
});

test('flow(data): 只有实参名命中形参名才连 approx 边，匹配不上就没有边', async () => {
  const fx = await makeProject(FILES);
  try {
    const pos = locate(fx.project, 'src/util.ts', 'double');
    const result = flowGraph(fx.project, {
      file: 'src/util.ts',
      line: pos.line,
      col: pos.col,
      kind: 'data',
      depth: 1,
    });
    assert.ok(result, '应能定位到 double');
    assert.equal(result.approximate, true);
    assert.match(result.note ?? '', /名字级近似/);

    // 三个调用点里只有 plain.ts 的 `double(n)` 实参名与形参名相同
    assert.equal(result.edges.length, 1, `只应有 plain(n) 那一条边；实际 ${result.edges.length} 条`);
    for (const edge of result.edges) {
      assert.equal(edge.kind, 'data');
      assert.equal(edge.approx, true, 'data 边一律标 approx');
      assert.match(edge.label ?? '', /n/);
    }
    assert.equal(result.nodes[0].name, 'double', '焦点节点在最前');
    assert.ok(result.nodes.length >= 2, '至少有焦点与命中调用方两个节点');
    assert.deepEqual(Object.keys(result.coverage).sort(), ['external', 'resolved', 'unresolved']);
  } finally {
    await fx.cleanup();
  }
});
