/**
 * `wcr lang` 子命令（07-languages-plugin P5）：语言包的查看 / 安装 / 卸载。
 *
 *   wcr lang list                     已加载语言 + 来源 + 加载失败
 *   wcr lang add <pkg|目录>           装一个语言包到 <DATA_DIR>/languages
 *   wcr lang remove <包名|语言 id>    卸掉一个语言包
 *
 * 装卸都**只改插件目录**，语言集在下次启动时生效（不做热加载，见 docs/07-languages-plugin-plan.md）。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { PLUGINS_DIR } from './config';
import { LANGUAGE_SPECS, pluginErrors, BUILTIN_LANGUAGE_IDS } from './languages';
import { discoverPlugins, type PluginCandidate } from './languages/loader';

const USAGE = [
  'wcr lang —— 语言包管理',
  '',
  '用法：',
  '  wcr lang list                    列出已加载语言、来源与加载失败',
  '  wcr lang add <包名|目录>         安装语言包（npm install 到语言插件目录）',
  '  wcr lang link <插件目录>         软链一个正在开发的插件目录（改完重启即生效）',
  '  wcr lang new <语言 id> [目录]    生成插件项目骨架（默认 ./wcr-lang-<id>）',
  '  wcr lang remove <包名|语言 id>   卸载语言包',
  '',
  '说明：装 / 卸 / 链接之后重启服务生效；插件目录可用 READER_PLUGINS_DIR 覆盖。',
  '      插件标准（十项能力与自测清单）见 docs/08-language-plugin-spec.md。',
].join('\n');

/** 插件目录里建的软链名（去掉 npm scope，Windows 下 scope 会变成多余目录层级）。 */
const linkNameOf = (dir: string, pkgName: string): string => {
  const base = pkgName.split('/').filter(Boolean).pop() ?? '';
  return base || path.basename(dir);
};

const say = (line = '') => process.stdout.write(`${line}\n`);

export async function runLangCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const arg = rest[0];
  if (!sub || sub === 'list' || sub === 'ls') return list();
  if (sub === 'add' || sub === 'install') return add(arg);
  if (sub === 'link') return link(arg);
  if (sub === 'new' || sub === 'init') return create(rest);
  if (sub === 'remove' || sub === 'rm' || sub === 'uninstall') return remove(arg);
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    say(USAGE);
    return 0;
  }
  say(`未知子命令：lang ${sub}`);
  say(USAGE);
  return 1;
}

async function list(): Promise<number> {
  say(`语言插件目录：${PLUGINS_DIR}`);
  say();

  const builtin = LANGUAGE_SPECS.filter((s) => BUILTIN_LANGUAGE_IDS.has(String(s.id)));
  const plugins = LANGUAGE_SPECS.filter((s) => !BUILTIN_LANGUAGE_IDS.has(String(s.id)));
  say(`内置语言（${builtin.length}）：${builtin.map((s) => s.label).join('、') || '（无）'}`);

  const candidates = await discoverPlugins();
  const sourceOf = new Map<string, string>();
  for (const c of candidates) sourceOf.set(c.entry, c.source);
  say(
    `插件语言（${plugins.length}）：${
      plugins.map((s) => `${s.label}（${String(s.id)}）`).join('、') || '（无）'
    }`,
  );
  if (candidates.length) {
    say(`  ── 插件来源：${candidates.map((c) => c.source).join('、')}`);
  }

  if (pluginErrors.length) {
    say();
    say(`加载失败（${pluginErrors.length}）：`);
    for (const e of pluginErrors) say(`  ✗ ${e.source} —— ${e.message}`);
  }

  say();
  say('装 / 卸语言包后重启服务生效。');
  return 0;
}

/**
 * `wcr lang link <插件目录>`：把正在开发的插件目录软链进插件目录。
 * 与 `add` 的区别：不复制、不走 npm —— 改完插件代码重启即生效（开发态）。
 */
async function link(dir: string | undefined): Promise<number> {
  if (!dir) {
    say('用法：wcr lang link <插件目录>');
    return 1;
  }
  const abs = path.resolve(dir);
  let pkg: { name?: unknown; wcr?: { lang?: unknown } };
  try {
    pkg = JSON.parse(await fsp.readFile(path.join(abs, 'package.json'), 'utf8'));
  } catch {
    say(`不是插件目录（读不到 package.json）：${abs}`);
    return 1;
  }
  const entry = pkg.wcr?.lang;
  if (typeof entry !== 'string' || !entry) {
    say(`不是语言插件（package.json 缺少 wcr.lang）：${path.join(abs, 'package.json')}`);
    say('契约见 docs/08-language-plugin-spec.md。');
    return 1;
  }
  if (!(await exists(path.join(abs, entry)))) {
    say(`package.json 的 wcr.lang 指向的文件不存在：${entry}`);
    return 1;
  }

  const name = linkNameOf(abs, typeof pkg.name === 'string' ? pkg.name : '');
  await ensurePluginsDir();
  const linkPath = path.join(PLUGINS_DIR, name);
  const existing = await lstatOrNull(linkPath);
  if (existing) {
    if (!existing.isSymbolicLink()) {
      say(`插件目录里已有同名的实体目录，请先移除：${linkPath}`);
      return 1;
    }
    await fsp.rm(linkPath, { force: true });
  }
  // Windows 上用 junction（目录联接：不需要管理员权限，也不依赖开发者模式）
  await fsp.symlink(abs, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

  say(`已链接：${linkPath}`);
  say(`        → ${abs}`);
  say('重启服务后生效（改插件代码后重启即可看到变化）。');
  return 0;
}

/**
 * `wcr lang new <语言 id> [目录 | --dir <目录>]`：生成一个能跑的插件项目骨架。
 * 骨架用「行式扫描」做最小实现（无原生依赖，装完即跑），并留好换成 AST 的位置。
 */
async function create(args: string[]): Promise<number> {
  const id = args[0];
  const rest = args.slice(1);
  const dirFlag = rest.findIndex((a) => a === '--dir' || a === '-d');
  const dir = dirFlag >= 0 ? rest[dirFlag + 1] : rest.find((a) => !a.startsWith('-'));
  if (!id || !/^[a-z][a-z0-9+#._-]*$/i.test(id)) {
    say('用法：wcr lang new <语言 id> [目录]（id 形如 zig / haskell）');
    return 1;
  }
  if (dirFlag >= 0 && !dir) {
    say('--dir 后面要跟目标目录');
    return 1;
  }
  const target = path.resolve(dir ?? `wcr-lang-${id}`);
  if (await exists(target)) {
    say(`目录已存在：${target}`);
    return 1;
  }
  await fsp.mkdir(path.join(target, 'test'), { recursive: true });
  await fsp.writeFile(
    path.join(target, 'package.json'),
    `${JSON.stringify(
      {
        name: `wcr-lang-${id}`,
        version: '0.1.0',
        private: true,
        type: 'module',
        description: `${id} 语言插件（阅读器）`,
        wcr: { lang: './index.ts' },
        dependencies: {},
      },
      null,
      2,
    )}\n`,
  );
  await fsp.writeFile(
    path.join(target, '.npmrc'),
    '# 上游语法包的 peer 声明常常过期；装原生模块时用这个跳过校验\nlegacy-peer-deps=true\n',
  );
  await fsp.writeFile(path.join(target, 'index.ts'), skeletonEntry(id));
  await fsp.writeFile(path.join(target, 'test', 'selfcheck.mjs'), skeletonSelfCheck());
  await fsp.writeFile(path.join(target, 'README.md'), skeletonReadme(id));

  say(`已生成插件项目：${target}`);
  say('');
  say('下一步：');
  say(`  cd ${target} && npm install && npx tsx test/selfcheck.mjs`);
  say(`  wcr lang link ${target}`);
  say('  重启阅读器 → 打开一个该语言的文件，按 docs/08-language-plugin-spec.md 的 C1–C10 验收');
  return 0;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function lstatOrNull(p: string) {
  try {
    return await fsp.lstat(p);
  } catch {
    return null;
  }
}

async function add(spec: string | undefined): Promise<number> {
  if (!spec) {
    say('用法：wcr lang add <包名|目录>');
    return 1;
  }
  await ensurePluginsDir();
  // 本地目录：npm 需要绝对路径才稳（相对路径按 cwd 解析，容易踩坑）
  const target = path.isAbsolute(spec) || /^\.{1,2}[\\/]/.test(spec) ? path.resolve(spec) : spec;
  const code = npm(['install', target]);
  if (code !== 0) {
    say(`安装失败（npm 退出码 ${code}）：${spec}`);
    return code;
  }
  say();
  say(`已安装：${spec}`);
  say('重启服务后生效（该语言的文件会被重新索引）。');
  return 0;
}

async function remove(name: string | undefined): Promise<number> {
  if (!name) {
    say('用法：wcr lang remove <包名|语言 id>');
    return 1;
  }
  const candidates = await discoverPlugins();
  let hit: PluginCandidate | undefined = candidates.find((c) => c.pkgName === name || c.source === name);
  if (!hit) hit = (await findByLanguageId(candidates, name)) ?? undefined;
  if (!hit) {
    say(`没找到语言包：${name}（用 wcr lang list 看已装的）。`);
    return 1;
  }

  const inNodeModules = hit.dir.split(path.sep).includes('node_modules');
  if (!inNodeModules) {
    say(`${hit.source} 是放在插件目录里的本地插件，不在 npm 管理下：`);
    say(`请手动删除目录 ${hit.dir}`);
    return 1;
  }

  await ensurePluginsDir();
  const code = npm(['uninstall', hit.pkgName || hit.source]);
  if (code !== 0) {
    say(`卸载失败（npm 退出码 ${code}）：${hit.source}`);
    return code;
  }
  say();
  say(`已卸载：${hit.source}`);
  say('重启服务后生效。');
  return 0;
}

/** 参数是语言 id 时，加载候选插件找出提供它的那个包。 */
async function findByLanguageId(candidates: PluginCandidate[], id: string): Promise<PluginCandidate | null> {
  for (const c of candidates) {
    try {
      const mod: Record<string, unknown> = await import(pathToFileURL(c.entry).href);
      const plugin = (mod.plugin ?? mod.default) as { spec?: { id?: unknown } } | undefined;
      if (String(plugin?.spec?.id ?? '') === id) return c;
    } catch {
      /* 坏插件跳过（list 会报） */
    }
  }
  return null;
}

/** 插件目录 + 一个最小 package.json（npm 需要一个包根来装依赖）。 */
async function ensurePluginsDir(): Promise<void> {
  await fsp.mkdir(PLUGINS_DIR, { recursive: true });
  const file = path.join(PLUGINS_DIR, 'package.json');
  try {
    await fsp.access(file);
  } catch {
    await fsp.writeFile(
      file,
      `${JSON.stringify({ name: 'wcr-languages', private: true, type: 'module' }, null, 2)}\n`,
    );
  }
}

/** 骨架入口：行式扫描最小实现（注释里写清怎么换成 AST 拿全 C5–C8）。 */
function skeletonEntry(id: string): string {
  return [
    '/**',
    ` * ${id} 语言插件骨架（\`wcr lang new\` 生成）。`,
    ' *',
    ' * 标准：docs/08-language-plugin-spec.md（十项能力 C1–C10 与自测清单）。',
    ' *',
    ' * 当前是最小实现：行式扫描 → 只提供大纲 / 符号搜索（C3 / C4）。',
    ' * 要拿到跳转 / 引用 / Hover（C5–C8），把 lineSymbols 换成 tree-sitter：',
    ' *   1) npm i tree-sitter tree-sitter-<lang>',
    ' *   2) spec 里给 grammar + scopes + handlers + identifierTypes',
    ' *      （参考 backend/src/languages/go.ts，C/C++ 参考实现见 wcr-lang-cpp）',
    ' *   3) 跨文件跳转再补 resolveModule',
    ' *   4) 设 refs: true —— 前端据此注册 hover / 定义 / 引用三个 Provider',
    ' *',
    ' * 类型来源（可选，见标准 §5）：',
    " *   import type { LanguagePlugin } from '<阅读器>/backend/src/languages/plugin';",
    " *   import type { LanguagePlugin } from '@wcr/lang-sdk';   // 抽出 SDK 之后",
    ' */',
    '',
    '/** 按需改成这门语言的声明写法（这里只示范「函数定义」一类）。 */',
    'const DECL = /^\\s*(?:fn|function|def|fun|func)\\s+([\\w$]+)/;',
    '',
    'export const plugin = {',
    '  spec: {',
    `    id: '${id}',`,
    `    label: '${id}',`,
    `    extensions: ['.${id}'],`,
    '    // 高亮：Monaco 内置有该语言就填它的 id（如 cpp / kotlin / ruby）；',
    '    // 没有就留空，并自带 monaco.monarch（见标准 §一「高亮的两种范围」）',
    `    monaco: '${id}',`,
    `    fence: '${id}',`,
    "    color: '#888888',",
    "    commentPrefixes: ['//'],",
    '    lineSymbols: (source) =>',
    '      source.split(/\\r?\\n/).flatMap((line, i) => {',
    '        const m = DECL.exec(line);',
    '        return m',
    "          ? [{ name: m[1], kind: 'function', line: i + 1, col: line.indexOf(m[1]) + 1 }]",
    '          : [];',
    '      }),',
    '    scopes: {},',
    '    handlers: {},',
    '    identifierTypes: [],',
    '  },',
    '};',
    '',
  ].join('\n');
}

/** 骨架自测：不依赖阅读器在场，直接断言插件契约。 */
function skeletonSelfCheck(): string {
  return [
    '/**',
    ' * 插件契约自检（不需要阅读器在场）：',
    ' *   npx tsx test/selfcheck.mjs',
    ' */',
    "import { fileURLToPath, pathToFileURL } from 'node:url';",
    '',
    "const file = fileURLToPath(new URL('../index.ts', import.meta.url));",
    'const mod = await import(pathToFileURL(file).href);',
    'const raw = mod.plugin ?? mod.default;',
    '',
    "const fail = (m) => { console.error('✗ ' + m); process.exit(1); };",
    "if (!raw || typeof raw !== 'object') fail('入口没有导出 plugin / default');",
    'const specs = [...(raw.spec ? [raw.spec] : []), ...(raw.specs ?? [])];',
    "if (!specs.length && !raw.preview) fail('没有 spec / specs / preview');",
    'for (const s of specs) {',
    "  if (!s.id) fail('spec.id 为空');",
    "  if (!s.extensions?.length && !s.filenames?.length) fail(s.id + ' 没有 extensions / filenames');",
    "  if (!s.grammar && !s.lineSymbols) fail(s.id + ' 没有 grammar 也没有 lineSymbols');",
    "  if (s.refs && !s.resolveModule) console.warn('! ' + s.id + ' 声明了 refs 但没有 resolveModule：跨文件跳转会弱一些');",
    '}',
    "console.log('✔ 契约自检通过：' + specs.map((s) => s.id).join(', '));",
    "console.log('  下一步：wcr lang link <本目录> → 重启阅读器 → 按 docs/08 的 C1–C10 验收');",
    '',
  ].join('\n');
}

function skeletonReadme(id: string): string {
  return [
    `# wcr-lang-${id}`,
    '',
    `${id} 语言插件（阅读器）。标准见阅读器仓库的 \`docs/08-language-plugin-spec.md\`。`,
    '',
    '## 开发',
    '',
    '```bash',
    'npm install',
    'npx tsx test/selfcheck.mjs        # 契约自检（不需要阅读器在场）',
    `wcr lang link $(pwd)              # 软链到插件目录（开发态）`,
    '# 重启阅读器 → 打开一个该语言的文件',
    '```',
    '',
    '## 验收（十项能力）',
    '',
    '```',
    '[ ] C1  语法高亮（关键字/字符串/注释/数字各有颜色）',
    '[ ] C2  文件树色点',
    '[ ] C3  大纲 Ctrl+Shift+O',
    '[ ] C4  符号搜索 Ctrl+T',
    '[ ] C5  跳转 F12（含跨文件）',
    '[ ] C6  引用 Shift+F12（含跨文件）',
    '[ ] C7  Hover 显示签名与出处',
    '[ ] C8  跳不动时给「人话解释」而不是静默',
    '[ ] C9  密度条（代码/注释/空白）',
    '[ ] C10 签名压平一行、参数不丢',
    '```',
    '',
  ].join('\n');
}

/** 在插件目录里跑 npm（Windows 下 npm 是 .cmd，需要 shell）。 */
function npm(args: string[]): number {
  const res = spawnSync('npm', args, {
    cwd: PLUGINS_DIR,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (res.error) {
    say(`npm 执行失败：${res.error.message}`);
    return 1;
  }
  return res.status ?? 1;
}
