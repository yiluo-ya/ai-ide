/**
 * monorepo 说明符解析（06-platform P10）：
 * - TS：tsconfig 的 baseUrl / paths（含通配）、workspace 包（package.json exports/main）、`@/` 别名；
 * - Go：go.work 的 use 多个 module 根 + 本地 replace；
 * - Python：src 布局（pyproject 的 package-dir 与自动探测）。
 *
 * 这组用例走的是真实链路（resolver → LanguageSpec.resolveModule → ProjectIndex.hint()），
 * 因此先执行 `installProjectHint()`（server.ts 也在起服务时做同一件事）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, locate, gotoDefinition } from './helpers';
import { installProjectHint } from '../src/bootstrap';

installProjectHint();

test('monorepo(ts): tsconfig 的 baseUrl + paths 通配把裸说明符映到项目内文件', async () => {
  const fx = await makeProject({
    'tsconfig.json': `{
      // 注释与尾逗号都是 tsconfig 允许的
      "compilerOptions": {
        "baseUrl": ".",
        "paths": {
          "@lib/*": ["libs/core/src/*"],
          "@shared/*": ["common/*"],
        },
      },
    }`,
    'libs/core/src/util.ts': 'export function helper(): number {\n  return 1;\n}\n',
    'common/consts.ts': 'export const LIMIT = 10;\n',
    'src/index.ts': [
      "import { helper } from '@lib/util';",
      "import { LIMIT } from '@shared/consts';",
      'export function run(): number {',
      '  return helper() + LIMIT;',
      '}',
      '',
    ].join('\n'),
  });
  try {
    const call = locate(fx.project, 'src/index.ts', 'helper()');
    const r = gotoDefinition(fx.project, 'src/index.ts', call.line, call.col);
    assert.equal(r.reason, 'resolved');
    assert.equal(r.locations[0].file, 'libs/core/src/util.ts');

    const use = locate(fx.project, 'src/index.ts', 'LIMIT;');
    const r2 = gotoDefinition(fx.project, 'src/index.ts', use.line, use.col);
    assert.equal(r2.reason, 'resolved');
    assert.equal(r2.locations[0].file, 'common/consts.ts');
  } finally {
    await fx.cleanup();
  }
});

test('monorepo(ts): tsconfig 的 baseUrl 让非相对说明符按 baseUrl 解析', async () => {
  const fx = await makeProject({
    'tsconfig.base.json': '{ "compilerOptions": { "baseUrl": "./app" } }',
    'tsconfig.json': '{ "extends": "./tsconfig.base.json", "compilerOptions": { "strict": true } }',
    'app/domain/user.ts': 'export interface User {\n  name: string;\n}\n',
    'app/main.ts': "import type { User } from 'domain/user';\nexport const u: User = { name: 'a' };\n",
  });
  try {
    const use = locate(fx.project, 'app/main.ts', 'User');
    const r = gotoDefinition(fx.project, 'app/main.ts', use.line, use.col);
    assert.equal(r.reason, 'resolved');
    assert.equal(r.locations[0].file, 'app/domain/user.ts');
  } finally {
    await fx.cleanup();
  }
});

test('monorepo(ts): 项目内 workspace 包按包名 + exports/main 解析', async () => {
  const fx = await makeProject({
    'packages/ui/package.json': JSON.stringify({
      name: '@acme/ui',
      exports: { '.': './src/index.ts', './button': './src/button.ts' },
    }),
    'packages/ui/src/index.ts': "export * from './button';\n",
    'packages/ui/src/button.ts': 'export function Button(): string {\n  return "b";\n}\n',
    'web/app.ts': [
      "import { Button } from '@acme/ui/button';",
      'export const b = Button();',
      '',
    ].join('\n'),
  });
  try {
    const call = locate(fx.project, 'web/app.ts', 'Button()');
    const r = gotoDefinition(fx.project, 'web/app.ts', call.line, call.col);
    assert.equal(r.reason, 'resolved');
    assert.equal(r.locations[0].file, 'packages/ui/src/button.ts');
  } finally {
    await fx.cleanup();
  }
});

const GO_WORK_FILES = {
  'go.work': `go 1.21

use (
	./mods/libs
	./app
)

replace example.com/legacy => ./third_party/legacy-lib
`,
  'mods/libs/go.mod': 'module example.com/lib\n\ngo 1.21\n',
  'mods/libs/foo/foo.go': `package foo

func Helper() int {
	return 1
}
`,
  'third_party/legacy-lib/go.mod': 'module example.com/legacy\n\ngo 1.21\n',
  'third_party/legacy-lib/old/old.go': `package old

func Thing() int {
	return 2
}
`,
  'app/go.mod': 'module example.com/app\n\ngo 1.21\n',
  'app/main.go': `package main

import (
	"example.com/lib/foo"
	"example.com/legacy/old"
)

func main() {
	println(foo.Helper(), old.Thing())
}
`,
};

test('monorepo(go): go.work 的 use 列表让第二个 module 根可解析', async () => {
  const fx = await makeProject(GO_WORK_FILES);
  try {
    const call = locate(fx.project, 'app/main.go', 'foo.Helper');
    const r = gotoDefinition(fx.project, 'app/main.go', call.line, call.col + 'foo.'.length);
    assert.equal(r.reason, 'resolved');
    assert.equal(r.locations[0].file, 'mods/libs/foo/foo.go');
  } finally {
    await fx.cleanup();
  }
});

test('monorepo(go): go.work 的本地 replace 指令生效（目标目录名与 module path 不同，只能来自 go.work）', async () => {
  const fx = await makeProject(GO_WORK_FILES);
  try {
    const call = locate(fx.project, 'app/main.go', 'old.Thing');
    const r = gotoDefinition(fx.project, 'app/main.go', call.line, call.col + 'old.'.length);
    assert.equal(r.reason, 'resolved');
    assert.equal(r.locations[0].file, 'third_party/legacy-lib/old/old.go');
  } finally {
    await fx.cleanup();
  }
});

test('monorepo(python): pyproject 的 package-dir 声明 src 布局', async () => {
  const fx = await makeProject({
    'pyproject.toml': `[project]
name = "demo"
version = "0.1.0"

[tool.setuptools]
package-dir = {"" = "src"}
`,
    'src/pkg/__init__.py': '',
    'src/pkg/x.py': 'def helper():\n    return 1\n',
    'main.py': 'from pkg.x import helper\n\nprint(helper())\n',
  });
  try {
    const call = locate(fx.project, 'main.py', 'helper()');
    const r = gotoDefinition(fx.project, 'main.py', call.line, call.col);
    assert.equal(r.reason, 'resolved');
    assert.equal(r.locations[0].file, 'src/pkg/x.py');
  } finally {
    await fx.cleanup();
  }
});

test('monorepo(python): 无 package-dir 时自动探测 src 布局', async () => {
  const fx = await makeProject({
    'src/app/__init__.py': '',
    'src/app/deep.py': 'def deep():\n    return 2\n',
    'main.py': 'from app.deep import deep\n\nprint(deep())\n',
  });
  try {
    const call = locate(fx.project, 'main.py', 'deep()');
    const r = gotoDefinition(fx.project, 'main.py', call.line, call.col);
    assert.equal(r.reason, 'resolved');
    assert.equal(r.locations[0].file, 'src/app/deep.py');
  } finally {
    await fx.cleanup();
  }
});
