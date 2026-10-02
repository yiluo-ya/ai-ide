/** 03 导航（N4）：includeDeclaration 时引用结果给出声明位置，且声明点可直接跳回。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, locate, findReferences } from './helpers';

test('N4: includeDeclaration 时引用结果给出声明位置，且声明点可直接跳回', async () => {
  const fx = await makeProject({
    'src/util.ts': `export function target(): void {}
`,
    'src/use.ts': `import { target } from './util';

export function caller(): void {
  target();
}
`,
  });
  try {
    const decl = locate(fx.project, 'src/util.ts', 'target(): void');
    const withDecl = findReferences(fx.project, 'src/util.ts', decl.line, decl.col, true);
    assert.equal(withDecl.reason, 'resolved');
    assert.equal(withDecl.declaration?.file, 'src/util.ts');
    // 引用 = 导入处 + 调用处
    assert.ok(withDecl.locations.length >= 2);

    const withoutDecl = findReferences(fx.project, 'src/util.ts', decl.line, decl.col, false);
    assert.equal(withoutDecl.locations.length, withDecl.locations.length - 1);
  } finally {
    await fx.cleanup();
  }
});
