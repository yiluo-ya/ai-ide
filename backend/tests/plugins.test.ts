/**
 * 语言插件（07-languages-plugin）：发现 → 加载 → 进索引；坏插件只记错误、不拖垮进程。
 *
 * 这里用**行式扫描插件**（不依赖 tree-sitter 语法包），因此跑得很快、也不挑平台。
 * `READER_PLUGINS_DIR` 必须在 import 后端模块**之前**设好（config 在模块求值时读它）。
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const pluginsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-lang-plugins-'));
process.env.READER_PLUGINS_DIR = pluginsDir;
// 默认 `npm test` 会关掉插件（tests/setup.ts），这个文件专门验证插件机制 → 显式打开。
process.env.READER_PLUGINS = '1';

/** 写一个插件目录：`<dir>/<name>/{package.json,index.ts}`。 */
async function writePlugin(name: string, pkg: object, entry: string): Promise<void> {
  const dir = path.join(pluginsDir, name);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  await fsp.writeFile(path.join(dir, 'index.ts'), entry);
}

// 1) 一个好插件：`.demo` → 「以 # 开头的行声明一个符号」
await writePlugin(
  'demo-lang',
  { name: 'wcr-lang-demo', version: '1.0.0', type: 'module', wcr: { lang: './index.ts' } },
  `export const plugin = {
  spec: {
    id: 'demolang',
    label: 'Demo Lang',
    extensions: ['.demo'],
    lineSymbols: (source) =>
      source.split(/\\r?\\n/).flatMap((line, i) => {
        const m = /^#\\s+(\\w+)/.exec(line);
        return m ? [{ name: m[1], kind: 'function', line: i + 1, col: line.indexOf(m[1]) + 1 }] : [];
      }),
    scopes: {},
    handlers: {},
    identifierTypes: [],
  },
  meta: { monaco: 'go', color: '#123456' },
};
`,
);

// 2) 坏插件：入口文件不存在
await writePlugin(
  'broken-lang',
  { name: 'wcr-lang-broken', version: '1.0.0', type: 'module', wcr: { lang: './missing.ts' } },
  'export const plugin = {};\n',
);

// 3) 不是插件的目录（没有 wcr.lang）：应当被静默跳过
await writePlugin('not-a-plugin', { name: 'whatever', version: '1.0.0', type: 'module' }, '');

const { specForFile, languageMetaList, pluginErrors, langForFile } = await import('../src/languages');
const { makeProject, documentSymbols } = await import('./helpers');

test('plugins: 插件语言被注册并进索引（AST-free 行式扫描）', async () => {
  const spec = specForFile('src/a.demo');
  assert.equal(spec?.id, 'demolang');

  const fx = await makeProject({
    'src/a.demo': '# first\n# second\nplain line\n',
    'src/b.ts': 'export const x = 1;\n',
  });
  try {
    assert.ok(fx.project.files.has('src/a.demo'));
    const symbols = documentSymbols(fx.project, 'src/a.demo');
    assert.deepEqual(
      symbols.map((s) => s.name),
      ['first', 'second'],
    );
  } finally {
    await fx.cleanup();
  }
});

test('plugins: 插件元数据进 /api/languages（monaco / color），认不出的文件名仍退 plaintext', () => {
  const meta = languageMetaList().find((m) => m.id === 'demolang');
  assert.ok(meta, 'demolang 应在语言元数据里');
  assert.equal(meta?.monaco, 'go'); // 插件自己声明借 go 语法
  assert.equal(meta?.color, '#123456');
  assert.equal(meta?.fence, 'go'); // 未声明 fence → 回落 monaco
  assert.equal(meta?.symbols, true);
  assert.equal(meta?.refs, false); // 未声明 refs

  assert.equal(langForFile('src/a.demo'), 'demolang');
  assert.equal(langForFile('src/unknown.zzz'), 'plaintext');
});

test('plugins: 坏插件只记错误，不影响其它插件与服务', () => {
  const broken = pluginErrors.find((e) => e.source === 'wcr-lang-broken');
  assert.ok(broken, `应记录坏插件的加载错误，实际：${JSON.stringify(pluginErrors)}`);
  assert.match(broken!.message, /missing\.ts|Cannot find|ERR_MODULE_NOT_FOUND/);
  // 好插件不受影响
  assert.equal(specForFile('x.demo')?.id, 'demolang');
});

test('plugins: 没有 wcr.lang 的目录被静默跳过', () => {
  assert.equal(
    pluginErrors.some((e) => e.source === 'whatever'),
    false,
  );
});
