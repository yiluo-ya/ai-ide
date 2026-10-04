/**
 * 测试环境预置（`npm test` 通过 `--import` 加载，早于任何后端模块）：
 *
 * 语言插件（07-languages-plugin）默认会读 `<DATA_DIR>/languages` 与仓库 `node_modules`。
 * 在开发机上，这两个位置可能真的装着插件 —— 那会让测试结果随「本机装了什么」而变，
 * 也会让别人的环境与 CI 不一致。
 *
 * 所以测试默认**关闭插件**：需要验证插件机制的用例（tests/plugins.test.ts）自己
 * 显式打开并指定临时插件目录。
 */
process.env.READER_PLUGINS ??= '0';
