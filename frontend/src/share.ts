/**
 * 05 信使 Share（S3）：把「位置 / 代码片段 / 符号」变成能直接贴进聊天窗、
 * issue、提交说明的文本 —— 关键是**自带出处**，三天后还能顺藤摸瓜回到同一行。
 *
 * 这里只做纯格式化（无副作用、可单测）；写剪贴板与轻提示在 state 的动作里。
 */
import type { SymbolInfo } from '../../shared/types';

/** 位置的最小形态：`path:line:col`（README「位置契约」，1-based）。 */
export function formatLocation(file: string, line: number, col: number): string {
  return `${file}:${line}:${col}`;
}

/** 行范围：单行给 `file:42`，多行给 `file:42-58`。 */
export function formatLineRange(file: string, startLine: number, endLine: number): string {
  return startLine === endLine ? `${file}:${startLine}` : `${file}:${startLine}-${endLine}`;
}

/** Monaco 语言 id → Markdown 代码围栏标记；不认识的语言不标（交给 Markdown 自己猜）。 */
export function fenceLang(lang: string): string {
  const map: Record<string, string> = {
    python: 'python',
    typescript: 'ts',
    tsx: 'tsx',
    javascript: 'js',
    jsx: 'jsx',
    go: 'go',
    java: 'java',
    rust: 'rust',
  };
  return map[lang] ?? '';
}

export interface SnippetInput {
  file: string;
  lang: string;
  /** 1-based 闭区间。 */
  startLine: number;
  endLine: number;
  /** 选中文本原文（不含行尾换行）。 */
  text: string;
}

/**
 * S3a：带出处的代码片段 —— 第一行是出处，随后是围栏代码块。
 * 出处只到行（选段是行级概念），不写 `42:7-58:13` 这种没人看的列。
 */
export function formatSnippet(input: SnippetInput): string {
  const where = formatLineRange(input.file, input.startLine, input.endLine);
  const fence = fenceLang(input.lang);
  const body = input.text.replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
  return `${where}\n\`\`\`${fence}\n${body}\n\`\`\``;
}

export interface SymbolSummaryInput {
  symbol: SymbolInfo;
  /** 覆盖出处文件（默认用符号自己的 location.file，即项目内相对路径）。 */
  file?: string;
}

/**
 * S3b：符号摘要 —— 「谁、在哪、签名是什么」，不贴整段实现。
 * 位置用 `path:line:col`，与「复制位置」同一口径，人和 agent 都能据此落到同一处。
 */
export function formatSymbolSummary({ symbol, file }: SymbolSummaryInput): string {
  const start = symbol.location.range.start;
  const where = formatLocation(file ?? symbol.location.file, start.line, start.col);
  const head = `${symbol.name} (${symbol.kind}) ${where}`;
  const signature = symbol.detail?.trim();
  return signature ? `${head}\n${signature}` : head;
}
