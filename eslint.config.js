/**
 * ESLint 9 flat config（P21）。
 *
 * 口径：
 * - 规则集 = `@eslint/js` 基础推荐 + typescript-eslint 推荐（不做类型感知，避免 lint 依赖全仓 tsc）；
 * - 风格类规则一律交给 Prettier（最后一项 `eslint-config-prettier` 关掉冲突规则）；
 * - 只对 `frontend/src/**` 开 react-hooks 的两条核心规则（rules-of-hooks / exhaustive-deps）；
 *   react-hooks v7 的 `recommended` 还带一批 React Compiler 语义规则，对本仓库是噪声，不启用。
 */
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const reactHooks = require('eslint-plugin-react-hooks');
const prettier = require('eslint-config-prettier');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/tmp/**', // 排障脚本，不进库
      'data/**',
      '.codegraph/**',
      'package-lock.json',
      '**/*.min.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // 仓库脚本与配置：Node 环境（process / console / require）
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // 本文件是 CommonJS 配置，允许 require
    files: ['eslint.config.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // UI 回归：文件本身在 Node 下跑，但 page.evaluate 回调在浏览器里执行（window / document）
    files: ['tests/ui/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['frontend/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: {
      // `_` 前缀是「有意不用」的约定；catch 变量不强制使用
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
  {
    // tree-sitter 语法包不导出 AST 节点类型，语言适配层 / 遍历层只能以 any 表达节点，
    // 这是与原生 AST 打交道的边界；规则在其它文件（resolver / store / api / 前端）仍生效。
    files: ['backend/src/languages/**/*.ts', 'backend/src/indexer/walker.ts', 'backend/src/indexer/insight.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    // 「刻意写法」：glob → RegExp 用 \u0000 作哨兵，git log 用 \x02 当字段分隔符。
    // 这些源码属于其它主题的写文件范围，本任务不改源码，只在规则层放行。
    files: [
      'backend/src/indexer/ignore.ts',
      'backend/src/indexer/store.ts',
      'backend/src/indexer/gitread.ts', // git log 的 \x02 分隔符
    ],
    rules: { 'no-control-regex': 'off' },
  },
  {
    files: ['backend/src/indexer/insight.ts', 'frontend/src/monaco-setup.ts'],
    rules: { 'no-useless-escape': 'off' },
  },
  prettier,
];
