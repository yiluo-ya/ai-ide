/**
 * 语言插件总开关（07-languages-plugin）：`READER_PLUGINS=0` 时一个插件都不加载。
 *
 * 与 plugins.test.ts 分开一个文件，是因为开关在 config 模块求值时读环境变量 ——
 * 必须在 import 后端模块之前设好（node:test 每个测试文件独立进程）。
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const pluginsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-lang-off-'));
process.env.READER_PLUGINS_DIR = pluginsDir;
process.env.READER_PLUGINS = '0';

const dir = path.join(pluginsDir, 'demo-lang');
await fsp.mkdir(dir, { recursive: true });
await fsp.writeFile(
  path.join(dir, 'package.json'),
  JSON.stringify({ name: 'wcr-lang-demo', type: 'module', wcr: { lang: './index.ts' } }),
);
await fsp.writeFile(
  path.join(dir, 'index.ts'),
  "export const plugin = { spec: { id: 'demolang', label: 'Demo', extensions: ['.demo'], scopes: {}, handlers: {}, identifierTypes: [] } };\n",
);

const { specForFile, pluginErrors } = await import('../src/languages');

test('plugins: READER_PLUGINS=0 → 插件不加载（内置语言照常）', () => {
  assert.equal(specForFile('a.demo'), null);
  assert.equal(specForFile('a.ts')?.id, 'typescript');
  assert.equal(pluginErrors.length, 0);
});
