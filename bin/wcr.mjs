#!/usr/bin/env node
/**
 * 兼容入口（2026-10-15）：主入口已改名为 `bin/ai-ide.mjs`（命令 `ai-ide`）。
 *
 * 保留本文件的原因：`wcr` 是长期沿用的命令名，文档与既有脚本仍可能直接引用
 * `bin/wcr.mjs`（或 `npx wcr`）—— 留着它，这些引用一条都不会断。
 * 它不复制任何逻辑，只把控制权原样交给 `ai-ide.mjs`（参数、cwd、环境不变）；
 * 语言的 `lang` 子命令同理照常可用（链路：bin → backend/src/cli.ts → lang-cli.ts）。
 */
import './ai-ide.mjs';
