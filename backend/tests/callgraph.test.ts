/** 03 导航（N-β）：调用层级 N16 的「谁调用我」冒烟测试。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, locate } from './helpers';
import { callHierarchy } from '../src/indexer/callgraph';

test('N16-in: 谁调用我（含模块级导入与入口候选）', async () => {
  const fx = await makeProject({
    'src/util.ts': `export function target(): number {
  return 1;
}
`,
    'src/mid.ts': `import { target } from './util';

export function callerA(): number {
  return target() + target();
}

export function callerB(): number {
  return target();
}
`,
    'src/main.ts': `import { callerA } from './mid';

export function main(): number {
  return callerA();
}
`,
  });
  try {
    const decl = locate(fx.project, 'src/util.ts', 'target(): number');
    const one = callHierarchy(fx.project, 'src/util.ts', decl.line, decl.col, 'in', 1);
    assert.equal(one.reason, 'resolved');
    assert.equal(one.symbol, 'target');
    assert.equal(one.root?.name, 'target');
    assert.equal(one.coverage.resolved, 4); // callerA 两处 + callerB 一处 + mid.ts 的 import 一处
    const names = (one.root?.children ?? []).map((n) => n.name);
    assert.ok(names.includes('callerA'));
    assert.ok(names.includes('callerB'));
    assert.ok(names.some((n) => n.includes('mid.ts'))); // 导入以模块级节点呈现
    assert.equal(names.some((n) => n === 'main'), false); // depth=1 不展开第二层

    // depth=2：callerA 的调用方 main 应作为子节点出现，且 main 是入口候选
    const two = callHierarchy(fx.project, 'src/util.ts', decl.line, decl.col, 'in', 2);
    const callerA = two.root?.children?.find((n) => n.name === 'callerA');
    assert.ok(callerA?.children?.some((n) => n.name === 'main' && n.isEntry));
  } finally {
    await fx.cleanup();
  }
});
