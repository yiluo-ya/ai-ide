/** 04 向导 W1：依赖序阅读路线（被依赖者在前，环内相邻且共享「互相依赖」）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject } from './helpers';
import { buildRoutes, importTargets, GUIDE_ROUTE_LIMIT } from '../src/indexer/guide';

/**
 * 夹具（依赖关系）：
 *   b.ts → a.ts（a 被 b 依赖）
 *   b.ts ↔ c.ts（互相 import，构成环）
 *   main.ts → b.ts（入口向下）
 *   tests/b.test.ts → b.ts（测试文件也进路线，只是标 test）
 *   external.ts → react（外部 import）
 */
const FILES = {
  'README.md': '# demo\n',
  'src/a.ts': 'export const a = 1;\n',
  'src/b.ts': "import { a } from './a';\nimport { c } from './c';\n\nexport const b = a + c;\n",
  'src/c.ts': "import { b } from './b';\n\nexport const c = b;\n",
  'src/main.ts': "import { b } from './b';\n\nconsole.log(b);\n",
  'src/external.ts': "import react from 'react';\n\nexport const x = react;\n",
  'tests/b.test.ts': "import { b } from '../src/b';\n\ntest('b', () => b);\n",
};

const routeOf = (project: Parameters<typeof buildRoutes>[0], kind: string) => {
  const route = buildRoutes(project).routes.find((r) => r.kind === kind);
  assert.ok(route, `缺少 ${kind} 路线`);
  return route;
};

test('guide: 依赖序 —— 被依赖者在前，环内相邻且共享「互相依赖」', async () => {
  const fx = await makeProject(FILES);
  try {
    const dep = routeOf(fx.project, 'dep');
    assert.equal(dep.label, '依赖序');
    // G3.2 进度分母：6 个已索引文件里排除 1 个测试文件（tests/b.test.ts）
    assert.equal(buildRoutes(fx.project).sourceFiles, 5, 'sourceFiles 排除测试与文档 / 配置');
    assert.equal(dep.total, 6);
    assert.equal(dep.truncated, false, `6 个文件不足上限 ${GUIDE_ROUTE_LIMIT}`);
    assert.deepEqual(dep.steps.map((s) => s.order), [1, 2, 3, 4, 5, 6]);

    const order = new Map(dep.steps.map((s) => [s.file, s.order]));
    assert.ok(order.get('src/a.ts')! < order.get('src/b.ts')!, 'a 被 b 依赖，a 在前');
    assert.ok(order.get('src/a.ts')! < order.get('src/c.ts')!, 'a 是环的下游依赖，a 在前');
    assert.equal(
      Math.abs(order.get('src/b.ts')! - order.get('src/c.ts')!),
      1,
      '环内文件相邻（SCC 缩点后作为一组连续排列）',
    );

    const b = dep.steps.find((s) => s.file === 'src/b.ts')!;
    const c = dep.steps.find((s) => s.file === 'src/c.ts')!;
    assert.match(b.reason, /互相依赖/);
    assert.match(c.reason, /互相依赖/);
    assert.ok(b.reason.includes('src/c.ts'), b.reason);
    assert.ok(c.reason.includes('src/b.ts'), c.reason);

    // 通用不变量：非环依赖必须排在前面（被依赖者在前）；环内互相依赖不适用
    for (const step of dep.steps) {
      const fi = fx.project.files.get(step.file)!;
      for (const scope of fi.importsByScope.values()) {
        for (const imp of scope.values()) {
          for (const target of importTargets(fx.project, fi, imp)) {
            if (dep.steps.find((s) => s.file === target)?.reason.includes('互相依赖')) continue;
            assert.ok(
              order.get(target)! < step.order,
              `${step.file}（第 ${step.order} 步）的依赖 ${target} 排在其后`,
            );
          }
        }
      }
    }
    for (const step of dep.steps) assert.ok(step.reason.length > 0, '每一步都要有理由');
  } finally {
    await fx.cleanup();
  }
});
