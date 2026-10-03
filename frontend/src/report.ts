/**
 * 05 信使 / S4b 报告：把「读到的结论」落成 Markdown —— 三天后不打开阅读器也能看懂、能核对。
 *
 * 三条自我约束：
 * - 位置一律 `path:line:col`（1-based，沿用 share.ts 的口径），复制出去还能落回同一处；
 * - 正文代码块保留行号 —— 脱离了阅读器，行号是唯一能对照回原文的锚；
 * - 语义着色的结论要落到文字（本项目符号 vs 外部依赖），不能只活在编辑器颜色里。
 *
 * 纯格式化：无 IO、无 React。碰浏览器 API 的只有文件末尾的下载 / 复制两个小工具。
 */
import type { HotMetric, SymbolInfo } from '../../shared/types';
import { fenceLang, formatLocation } from './share';
import type { SearchHit } from './state';

/**
 * 语义着色命中（与后端 HighlightResult.data 每 4 元组同源）。
 * 报告要「列出名字」，所以比截图多带一个命中文本。
 */
export interface HighlightItem {
  /** 1-based。 */
  line: number;
  /** 1-based。 */
  startCol: number;
  /** 结束列，exclusive（与 Monaco / 后端口径一致）。 */
  endCol: number;
  tier: 'project' | 'local' | 'external';
  /** 命中区间的原文片段。 */
  text: string;
}

// ------------------------------------------------------------------ 小工具

/** 本地时间戳：报告是给人看的，本地时区比 ISO 的 Z 好读。 */
function stamp(at: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}:${p(at.getSeconds())}`;
}

/** 文件名用的紧凑时间戳。 */
function fileStamp(at: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
}

/** 统一成 `/` 分隔、去掉前导 `./`（报告里不该出现 Windows 反斜杠）。 */
function tidyPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** 千分位：口径数字是给读者核对的，不分组容易看错位数。 */
function group(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function round1(n: number): string {
  return String(Math.round(n * 10) / 10);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${round1(value)} ${units[i]}`;
}

/** 按 `\n` 切行；末尾换行不算一行，空文件算 0 行。 */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * 围栏长度：正文里本身写了 ``` 时用更长的围栏，否则报告结构会被代码内容撑破。
 */
function fenceOf(lines: string[]): number {
  let longest = 0;
  for (const line of lines) {
    for (const run of line.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  }
  return Math.max(3, longest + 1);
}

/** 带行号的 fenced 代码块（行号右对齐，宽度随总行数）。 */
function numberedCode(lines: string[], lang: string): string[] {
  const fence = '`'.repeat(fenceOf(lines));
  const tag = fenceLang(lang);
  const width = String(lines.length).length;
  const out = [`${fence}${tag}`];
  lines.forEach((text, i) => {
    out.push(`  ${String(i + 1).padStart(width, ' ')} | ${text}`);
  });
  out.push(fence);
  return out;
}

/** 符号树 → 缩进列表；位置用 `path:line:col`（符号自带文件，跨文件引用也准）。 */
function symbolOutline(symbols: SymbolInfo[], depth = 0, out: string[] = []): string[] {
  const indent = '  '.repeat(depth);
  for (const symbol of symbols) {
    const start = symbol.location.range.start;
    const where = formatLocation(tidyPath(symbol.location.file), start.line, start.col);
    out.push(`${indent}- ${symbol.name}（${symbol.kind}）— ${where}`);
    if (symbol.children?.length) symbolOutline(symbol.children, depth + 1, out);
  }
  return out;
}

/** 按出现顺序去重，只为「本项目符号 / 外部依赖」两组名单（local 是局部变量，不进报告结论）。 */
function tierNames(hits: HighlightItem[]): { project: string[]; external: string[] } {
  const project: string[] = [];
  const external: string[] = [];
  const seenProject = new Set<string>();
  const seenExternal = new Set<string>();
  for (const hit of hits) {
    const name = hit.text.trim();
    if (!name) continue;
    if (hit.tier === 'project') {
      if (!seenProject.has(name)) {
        seenProject.add(name);
        project.push(name);
      }
    } else if (hit.tier === 'external') {
      if (!seenExternal.has(name)) {
        seenExternal.add(name);
        external.push(name);
      }
    }
  }
  return { project, external };
}

/** 搜索选项：只列有效项，避免报告里出现一堆 `regex=false`。 */
function formatOptions(options?: Record<string, unknown>): string {
  if (!options) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    if (value === true) {
      parts.push(key);
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length) parts.push(`${key}=${value.join(',')}`);
      continue;
    }
    parts.push(`${key}=${String(value)}`);
  }
  return parts.join(' ');
}

// ------------------------------------------------------------------ 文件报告

/**
 * S4b-1：单文件报告 —— 大纲 / 带行号正文 / 着色结论 / 批注，四段各自独立。
 */
export function fileReportMarkdown(input: {
  projectName: string;
  projectRoot?: string;
  file: string;
  lang: string;
  content: string;
  symbols: SymbolInfo[];
  highlights?: HighlightItem[];
}): string {
  const file = tidyPath(input.file);
  const lines = splitLines(input.content);
  const out: string[] = [];

  out.push(`# ${file}`, '');
  out.push(`- 项目：${input.projectName}`);
  if (input.projectRoot) out.push(`- 根目录：${tidyPath(input.projectRoot)}`);
  out.push(`- 语言：${input.lang || 'plaintext'}`);
  out.push(`- 行数：${group(lines.length)}`);
  out.push(`- 生成时间：${stamp(new Date())}`, '');

  out.push('## 大纲', '');
  if (input.symbols.length === 0) out.push('（未取到符号）');
  else out.push(...symbolOutline(input.symbols));
  out.push('');

  out.push('## 正文', '');
  out.push(...numberedCode(lines, input.lang));
  out.push('');

  const tiers = tierNames(input.highlights ?? []);
  if (tiers.project.length > 0 || tiers.external.length > 0) {
    out.push('## 着色（本项目 vs 外部）', '');
    if (tiers.project.length) out.push(`- 本项目符号：${tiers.project.join('、')}`);
    if (tiers.external.length) out.push(`- 外部依赖：${tiers.external.join('、')}`);
    out.push('');
  }

  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

// ------------------------------------------------------------------ 搜索报告

/**
 * S4b-2：搜索结果报告 —— 按文件分组，行文本去掉首尾空白（对齐用不上，对照靠 `path:line:col`）。
 */
export function searchReportMarkdown(input: {
  projectName: string;
  query: string;
  options?: Record<string, unknown>;
  hits: SearchHit[];
}): string {
  const fileCount = input.hits.length;
  const lineCount = input.hits.reduce((n, hit) => n + hit.matches.length, 0);
  const out: string[] = [];

  out.push(`# 搜索「${input.query}」— ${group(fileCount)} 个文件 / ${group(lineCount)} 行`, '');
  out.push(`- 项目：${input.projectName}`);
  const options = formatOptions(input.options);
  if (options) out.push(`- 选项：${options}`);
  out.push(`- 生成时间：${stamp(new Date())}`, '');

  if (fileCount === 0) {
    out.push('（没有命中）');
    return `${out.join('\n')}\n`;
  }

  for (const hit of input.hits) {
    const file = tidyPath(hit.file);
    out.push(`### ${file}${hit.isTest ? '（测试）' : ''}`, '');
    for (const match of hit.matches) {
      out.push(`- ${formatLocation(file, match.line, match.col)} — ${match.lineText.trim()}`);
    }
    out.push('');
  }

  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

// ------------------------------------------------------------------ 项目概览报告

/**
 * 概览的结构化最小接口：字段全可选，缺哪节就跳过哪节 —— 这样报告不会因为后端
 * 某个字段没给就输出一屏「undefined」。数字口径与 01-map 一致（见各字段注释）。
 */
export interface OverviewLike {
  identity?: {
    files?: number;
    dirs?: number;
    /** 含测试 / 示例文件的总数。 */
    bytes?: number;
    lines?: number;
    indexedFiles?: number;
    /** 测试 / 示例文件数。 */
    testFiles?: number;
    langs?: Array<{ lang: string; files?: number; lines?: number; tests?: number; bytes?: number }>;
  };
  /** 热点榜排序口径（M3.2）。 */
  hotMetric?: HotMetric;
  /** 入口候选 + 热点合并的「从哪看起」，每条带依据。 */
  entries?: Array<{ file: string; kind?: string; score?: number; reasons?: string[]; inbound?: number; lines?: number }>;
  /** 热点文件：inbound = 指向它的引用条目总数，inDegree = 项目内引用它的不同文件数（去重）。 */
  hot?: Array<{ file: string; score?: number; inbound?: number; inDegree?: number; lines?: number }>;
  /** 孤立文件（既不被引用也不引用别人）。 */
  orphans?: Array<{ file: string; lang?: string; lines?: number }>;
  /** 文件级循环依赖（每个数组是一个 SCC）。 */
  cycles?: string[][];
  recent?: {
    today?: number;
    last3d?: number;
    last7d?: number;
    older?: number;
    newest?: Array<{ file: string; mtimeMs: number }>;
  };
  /** 索引未完成时给「部分地图」的进度，而不是假 0。 */
  partial?: { indexing?: boolean; filesIndexed?: number; filesTotal?: number; progress?: number; notes?: string[] };
}

/** 规模一句话（口径照抄 identity 各字段，不新造数字）。 */
function scaleLine(identity: OverviewLike['identity']): string {
  if (!identity) return '';
  const parts: string[] = [];
  if (identity.files !== undefined) {
    parts.push(`${group(identity.files)} 个文件${identity.testFiles ? `（含测试 ${group(identity.testFiles)}）` : ''}`);
  }
  if (identity.dirs !== undefined) parts.push(`${group(identity.dirs)} 个目录`);
  if (identity.lines !== undefined) parts.push(`${group(identity.lines)} 行`);
  if (identity.bytes !== undefined) parts.push(formatBytes(identity.bytes));
  if (identity.indexedFiles !== undefined && identity.files !== undefined && identity.indexedFiles < identity.files) {
    parts.push(`已索引 ${group(identity.indexedFiles)} 个`);
  }
  return parts.join(' / ');
}

/**
 * S4b-3：项目概览报告 —— 只列「读者需要先知道的事」：规模、从哪看起、热点、
 * 孤立、环、最近改动。缺字段的节整节不输出。
 */
export function overviewReportMarkdown(input: {
  projectName: string;
  root?: string;
  overview: OverviewLike;
}): string {
  const overview = input.overview;
  const out: string[] = [`# ${input.projectName} 项目概览`, ''];

  if (input.root) out.push(`- 根目录：${tidyPath(input.root)}`);
  const scale = scaleLine(overview.identity);
  if (scale) out.push(`- 规模：${scale}`);
  out.push(`- 生成时间：${stamp(new Date())}`, '');

  const partial = overview.partial;
  if (partial?.indexing) {
    const progress = partial.progress !== undefined ? `（${Math.round(partial.progress * 100)}%）` : '';
    const counts =
      partial.filesIndexed !== undefined && partial.filesTotal !== undefined
        ? `：已索引 ${group(partial.filesIndexed)} / ${group(partial.filesTotal)}`
        : '';
    out.push(`> 索引进行中${counts}${progress}，以下数字是部分结果。`, '');
    if (partial.notes?.length) out.push(...partial.notes.map((note) => `> ${note}`), '');
  }

  const langs = overview.identity?.langs ?? [];
  if (langs.length) {
    out.push('## 语言分布', '');
    for (const lang of langs) {
      const files = lang.files !== undefined ? `${group(lang.files)} 文件` : '';
      const lines = lang.lines !== undefined ? `${group(lang.lines)} 行` : '';
      const tests = lang.tests ? `（含测试 ${group(lang.tests)}）` : '';
      out.push(`- ${lang.lang}：${[files, lines].filter(Boolean).join(' / ')}${tests}`);
    }
    out.push('');
  }

  const entries = overview.entries ?? [];
  if (entries.length) {
    out.push('## 从哪看起（入口候选）', '');
    for (const entry of entries) {
      const kind = entry.kind === 'hot' ? '热点' : '入口';
      const score = entry.score !== undefined ? `，评分 ${round1(entry.score)}` : '';
      const why = entry.reasons?.length ? ` — ${entry.reasons.join('；')}` : '';
      out.push(`- ${tidyPath(entry.file)}（${kind}${score}）${why}`);
    }
    out.push('');
  }

  const hot = overview.hot ?? [];
  if (hot.length) {
    out.push(`## 热点榜（口径：${overview.hotMetric ?? 'files'}）`, '');
    for (const item of hot) {
      const refs = item.inbound !== undefined ? `被引用 ${group(item.inbound)} 条` : '';
      const files = item.inDegree !== undefined ? `${group(item.inDegree)} 个文件` : '';
      const score = item.score !== undefined ? `评分 ${round1(item.score)}` : '';
      const tail = [refs && files ? `${refs}（${files}）` : refs || files, score].filter(Boolean).join('，');
      out.push(`- ${tidyPath(item.file)}${tail ? ` — ${tail}` : ''}`);
    }
    out.push('');
  }

  const orphans = overview.orphans ?? [];
  if (orphans.length) {
    out.push('## 孤立文件（没有被项目内文件引用）', '');
    for (const orphan of orphans) {
      const lines = orphan.lines !== undefined ? `（${group(orphan.lines)} 行）` : '';
      out.push(`- ${tidyPath(orphan.file)}${lines}`);
    }
    out.push('');
  }

  const cycles = overview.cycles ?? [];
  if (cycles.length) {
    out.push('## 循环依赖（文件级 SCC）', '');
    for (const cycle of cycles) {
      const names = cycle.map(tidyPath);
      // 每个数组是一个强连通分量：首尾相接写成环，读者一眼看出「绕回起点」
      out.push(`- ${names.length > 1 ? [...names, names[0]].join(' → ') : names.join('')}`);
    }
    out.push('');
  }

  const recent = overview.recent;
  if (recent) {
    const counts: string[] = [];
    if (recent.today !== undefined) counts.push(`今天 ${group(recent.today)}`);
    if (recent.last3d !== undefined) counts.push(`3 天内 ${group(recent.last3d)}`);
    if (recent.last7d !== undefined) counts.push(`7 天内 ${group(recent.last7d)}`);
    if (recent.older !== undefined) counts.push(`更早 ${group(recent.older)}`);
    if (counts.length || recent.newest?.length) {
      out.push('## 最近改动', '');
      if (counts.length) out.push(`- 改动分布：${counts.join(' / ')}`);
      for (const item of (recent.newest ?? []).slice(0, 5)) {
        out.push(`- ${tidyPath(item.file)}（${stamp(new Date(item.mtimeMs))}）`);
      }
      out.push('');
    }
  }

  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

// ------------------------------------------------------------------ 文件名 / 落盘

/** 文件名 slug：保留中文、字母数字与 `. _ -`，其余（`/`、空格、括号…）一律换成 `-`。 */
function slug(text: string): string {
  return text
    .trim()
    .replace(/[^\p{Script=Han}A-Za-z0-9._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * 报告文件名：`report-<项目名>-<文件名或search>-<时间戳>.md`。
 * file 取 basename —— 目录全塞进来只会把文件名撑长，检索时反而不好认。
 */
export function reportFilename(parts: {
  project?: string | null;
  kind: 'file' | 'search' | 'overview';
  file?: string | null;
  query?: string | null;
}): string {
  const project = slug(parts.project ?? '') || 'project';
  let subject: string = parts.kind;
  if (parts.kind === 'file' && parts.file) {
    const base = tidyPath(parts.file).split('/').pop() ?? '';
    subject = slug(base) || 'file';
  } else if (parts.kind === 'search' && parts.query) {
    subject = slug(parts.query) || 'search';
  }
  return `report-${project}-${subject}-${fileStamp(new Date())}.md`;
}

/** 触发浏览器下载（Blob + `<a download>`）。 */
export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 立刻 revoke 在部分浏览器会打断下载，让出一帧更稳
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * 写剪贴板：返回是否成功。浏览器可能因权限 / 非安全上下文拒绝，
 * 调用方据此决定要不要退回「下载」或提示，所以这里不抛。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) return false;
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
