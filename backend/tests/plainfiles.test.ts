/**
 * 常用文件的解析（2026-10-03）：shell / JSON / YAML / TOML / ini·env / Dockerfile / Markdown / CSS / HTML / SQL。
 *
 * 口径：
 * - 有 tree-sitter 语法包的（shell/JSON/YAML/TOML/Markdown/CSS/HTML）走 AST，键 / 标题 / 名字当符号；
 * - 没有可用语法包的（Dockerfile/ini·env/SQL）走 `LanguageSpec.lineSymbols` 行式扫描；
 * - 断言以现场真实行为为准，只写「这些文件类型能被索引并出现在大纲里」这类可验证事实。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeProject,
  documentSymbols,
  workspaceSymbols,
  gotoDefinition,
  findReferences,
} from './helpers';
import { buildOverview } from '../src/indexer/insight';
import { specForFile } from '../src/languages';
import { moduleFiles } from '../src/indexer/resolver';
import type { SymbolInfo } from '../../shared/types';

const names = (list: SymbolInfo[], depth = 0): string[] =>
  list.flatMap((s) => [`${'  '.repeat(depth)}${s.name}`, ...names(s.children ?? [], depth + 1)]);

const FILES: Record<string, string> = {
  'scripts/build.sh': `#!/usr/bin/env bash
source ./lib/common.sh
APP_NAME="demo"
export PORT=8080

function greet() {
  local who="$1"
  echo "hi $who"
}

cleanup() { rm -rf ./tmp; }

greet "$APP_NAME"
cleanup
`,
  'scripts/lib/common.sh': `log() { echo "$1"; }
`,
  'package.json': `{
  "name": "demo",
  "scripts": { "build": "vite build" },
  "deps": ["a"]
}`,
  'ci.yml': `name: ci
jobs:
  build:
    steps:
      - run: npm ci
`,
  'Cargo.toml': `[package]
name = "demo"

[dependencies]
serde = { version = "1" }
`,
  'app.ini': `[server]
port = 8080
`,
  '.env': `PORT=8080
`,
  Dockerfile: `FROM node:20 AS build
ARG NODE_ENV
ENV PORT=8080
FROM nginx:alpine
`,
  'README.md': `# Title

## Sec

### Deep
`,
  'styles.css': `:root { --brand: red; }
.app, body { color: var(--brand); }
#main { margin: 0; }
@keyframes pulse { from { opacity: 0; } }
`,
  'page.html': `<div id="app"><span id="row"></span></div>`,
  'schema.sql': `CREATE TABLE users (id INT);
CREATE OR REPLACE VIEW active_users AS SELECT 1;
CREATE UNIQUE INDEX idx_users ON users (id);
`,
};

test('扩展名与固定文件名 → 语言', () => {
  assert.equal(specForFile('build.sh')?.id, 'shell');
  assert.equal(specForFile('x.bash')?.id, 'shell');
  assert.equal(specForFile('package.json')?.id, 'json');
  assert.equal(specForFile('ci.yml')?.id, 'yaml');
  assert.equal(specForFile('Cargo.TOML')?.id, 'toml');
  assert.equal(specForFile('app.ini')?.id, 'ini');
  assert.equal(specForFile('.env')?.id, 'ini');
  assert.equal(specForFile('Dockerfile')?.id, 'dockerfile');
  assert.equal(specForFile('dockerfile')?.id, 'dockerfile');
  assert.equal(specForFile('README.md')?.id, 'markdown');
  assert.equal(specForFile('styles.css')?.id, 'css');
  assert.equal(specForFile('x.scss')?.id, 'scss');
  assert.equal(specForFile('x.less')?.id, 'less');
  assert.equal(specForFile('index.html')?.id, 'html');
  assert.equal(specForFile('schema.sql')?.id, 'sql');
  assert.equal(specForFile('main.exe'), null);
});

test('Shell：函数 / 变量定义，source 依赖，变量引用与命令引用', async () => {
  const fx = await makeProject(FILES);
  try {
    const fi = fx.project.files.get('scripts/build.sh');
    assert.ok(fi && fi.indexed);
    assert.equal(fi.lang, 'shell');

    const defs = fi.definitions.filter((d) => !d.local);
    assert.deepEqual(
      defs.map((d) => `${d.kind} ${d.name}`),
      ['variable APP_NAME', 'variable PORT', 'function greet', 'function cleanup'],
    );
    // 函数内的 local 归到函数名下（局部）
    assert.deepEqual(
      fi.definitions.filter((d) => d.local).map((d) => `${d.kind} ${d.name}`),
      ['variable who'],
    );

    // source ./lib/common.sh → 相对当前文件的项目内文件
    assert.deepEqual(fi.imports.map((i) => [i.localName, i.module]), [['common', './lib/common.sh']]);
    assert.deepEqual(moduleFiles(fx.project, fi, fi.imports[0]), ['scripts/lib/common.sh']);

    // 命令名与变量读取都算引用
    const refNames = fi.references.map((r) => r.name);
    assert.ok(refNames.includes('greet'));
    assert.ok(refNames.includes('APP_NAME'));
    assert.ok(!refNames.includes('1'), '$1 不该被当成符号引用');

    // 跳转：命令名 → 同名函数定义
    const pos = {...fi.text.position(fi.source.lastIndexOf('greet'))};
    const def = gotoDefinition(fx.project, 'scripts/build.sh', pos.line, pos.col);
    assert.equal(def.reason, 'resolved');
    assert.equal(def.locations[0].file, 'scripts/build.sh');
    assert.equal(def.locations[0].range.start.line, 6);

    const refs = findReferences(fx.project, 'scripts/build.sh', pos.line, pos.col, true);
    assert.ok(refs.locations.length >= 2, '函数定义 + 调用点都该在引用列表里');
  } finally {
    await fx.cleanup();
  }
});

test('JSON：顶层键进符号搜索，嵌套键在大纲里分层', async () => {
  const fx = await makeProject(FILES);
  try {
    const symbols = documentSymbols(fx.project, 'package.json');
    assert.deepEqual(names(symbols), ['name', 'scripts', '  build', 'deps']);
    const top = workspaceSymbols(fx.project, 'name', null).map((s) => s.name);
    assert.ok(top.includes('name'));
  } finally {
    await fx.cleanup();
  }
});

test('YAML：映射键分层', async () => {
  const fx = await makeProject(FILES);
  try {
    assert.deepEqual(names(documentSymbols(fx.project, 'ci.yml')), [
      'name',
      'jobs',
      '  build',
      '    steps',
      '      run',
    ]);
  } finally {
    await fx.cleanup();
  }
});

test('TOML：表作为命名空间，表内键为字段', async () => {
  const fx = await makeProject(FILES);
  try {
    assert.deepEqual(names(documentSymbols(fx.project, 'Cargo.toml')), [
      'package',
      '  name',
      'dependencies',
      '  serde',
    ]);
  } finally {
    await fx.cleanup();
  }
});

test('ini / .env：段名与键（行式扫描、平铺；全大写的键算常量）', async () => {
  const fx = await makeProject(FILES);
  try {
    assert.deepEqual(
      documentSymbols(fx.project, 'app.ini').map((s) => `${s.kind} ${s.name}`),
      ['namespace server', 'field port'],
    );
    const env = documentSymbols(fx.project, '.env');
    assert.deepEqual(env.map((s) => `${s.kind} ${s.name}`), ['constant PORT']);
  } finally {
    await fx.cleanup();
  }
});

test('Dockerfile：构建阶段名与变量（行式扫描）', async () => {
  const fx = await makeProject(FILES);
  try {
    const syms = documentSymbols(fx.project, 'Dockerfile');
    assert.deepEqual(syms.map((s) => `${s.kind} ${s.name}@${s.location.range.start.line}`), [
      'namespace build@1',
      'variable NODE_ENV@2',
      'variable PORT@3',
    ]);
    assert.equal(fx.project.files.get('Dockerfile')?.indexed, true);
  } finally {
    await fx.cleanup();
  }
});

test('Markdown：标题按层级嵌套', async () => {
  const fx = await makeProject(FILES);
  try {
    assert.deepEqual(names(documentSymbols(fx.project, 'README.md')), ['Title', '  Sec', '    Deep']);
  } finally {
    await fx.cleanup();
  }
});

test('CSS：类 / id / @keyframes / 自定义属性', async () => {
  const fx = await makeProject(FILES);
  try {
    const syms = documentSymbols(fx.project, 'styles.css');
    assert.deepEqual(
      syms.map((s) => `${s.kind} ${s.name}`).sort(),
      ['class app', 'constant main', 'function pulse', 'variable --brand'].sort(),
    );
  } finally {
    await fx.cleanup();
  }
});

test('HTML：带 id 的元素（嵌套的也要）', async () => {
  const fx = await makeProject(FILES);
  try {
    assert.deepEqual(
      documentSymbols(fx.project, 'page.html').map((s) => s.name),
      ['app', 'row'],
    );
  } finally {
    await fx.cleanup();
  }
});

test('SQL：CREATE 声明的对象名（行式扫描）', async () => {
  const fx = await makeProject(FILES);
  try {
    assert.deepEqual(
      documentSymbols(fx.project, 'schema.sql').map((s) => `${s.kind} ${s.name}`),
      ['struct users', 'interface active_users', 'property idx_users'],
    );
  } finally {
    await fx.cleanup();
  }
});

test('语言分布把新类型算进去（项目地图概览）', async () => {
  const fx = await makeProject(FILES);
  try {
    const overview = await buildOverview(fx.project);
    const counts = new Map(overview.identity.langs.map((l) => [l.lang, l.files]));
    assert.ok((counts.get('shell') ?? 0) >= 2);
    assert.equal(counts.get('json'), 1);
    assert.equal(counts.get('yaml'), 1);
    assert.equal(counts.get('markdown'), 1);
    assert.equal(counts.get('sql'), 1);
  } finally {
    await fx.cleanup();
  }
});
