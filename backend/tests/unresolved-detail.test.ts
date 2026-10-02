/**
 * P2 / Q1 未解析细分原因单测：`needs-type-info` / `dynamic-member` / `module-not-found` / `not-in-project`
 * 各至少 1 例（Python + TS 各覆盖一些）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gotoDefinition, locate, makeProject } from './helpers';

test('unresolved-detail: module-not-found（星号导入的相对模块不存在）', async (t) => {
  const { project, cleanup } = await makeProject({
    'src/a.py': 'from .nope import *\n\ndef use():\n    return helper.x()\n',
  });
  t.after(cleanup);

  const pos = locate(project, 'src/a.py', 'helper.x');
  const out = gotoDefinition(project, 'src/a.py', pos.line, pos.col);
  assert.equal(out.reason, 'unresolved');
  assert.equal(out.detail, 'module-not-found');
  assert.equal(out.symbol, 'helper');
});

test('unresolved-detail: not-in-project（星号导入的裸包名）', async (t) => {
  const { project, cleanup } = await makeProject({
    'src/a.py': 'from lodash import *\n\ndef use():\n    return helper.x()\n',
  });
  t.after(cleanup);

  const pos = locate(project, 'src/a.py', 'helper.x');
  const out = gotoDefinition(project, 'src/a.py', pos.line, pos.col);
  assert.equal(out.reason, 'unresolved');
  assert.equal(out.detail, 'not-in-project');
});

test('unresolved-detail: needs-type-info（命名空间导入的成员名解析不到）', async (t) => {
  const { project, cleanup } = await makeProject({
    'src/util.ts': 'export function helper(): number {\n  return 1;\n}\n',
    'src/use.ts': "import * as util from './util';\nexport function use() {\n  return util.notDefined();\n}\n",
  });
  t.after(cleanup);

  const pos = locate(project, 'src/use.ts', 'notDefined();');
  const out = gotoDefinition(project, 'src/use.ts', pos.line, pos.col);
  assert.equal(out.reason, 'unresolved');
  assert.equal(out.detail, 'needs-type-info');
});

test('unresolved-detail: dynamic-member（下标访问 / 动态属性）', async (t) => {
  const { project, cleanup } = await makeProject({
    'src/dyn.py': 'def use():\n    return vals["key"]\n',
  });
  t.after(cleanup);

  const pos = locate(project, 'src/dyn.py', 'vals[');
  const out = gotoDefinition(project, 'src/dyn.py', pos.line, pos.col);
  assert.equal(out.reason, 'unresolved');
  assert.equal(out.detail, 'dynamic-member');
  assert.equal(out.symbol, 'vals');
});
