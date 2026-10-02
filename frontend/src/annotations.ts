/**
 * 05 信使 Share / S10：批注与讨论线程。
 *
 * 决策（docs/05-share.md §8 问题 5 选 A）：**只存本机浏览器**，按项目 id 分片。
 * 理由与代价写在文档里：不碰被读项目（延续「只读 · 不改动磁盘」承诺），
 * 因此换机器 / 换浏览器就没了 —— 要交给别人，就走导出（Markdown 报告）。
 *
 * 纯存储 + 纯格式化，不依赖 React；写盘失败（隐私模式 / 配额满）一律吞掉，
 * 不能因为记不住批注而打断阅读。
 */
import { formatLineRange, formatLocation } from './share';

/** 一条批注（讨论线程）：首条 + 若干回复；resolved 表示已解决（仍留在列表里）。 */
export interface AnnotationThread {
  id: string;
  file: string;
  /** 1-based。 */
  line: number;
  /** 1-based；行内位置，用于精确指认。 */
  col: number;
  text: string;
  replies: AnnotationReply[];
  createdAt: number;
  resolved?: boolean;
}

export interface AnnotationReply {
  text: string;
  at: number;
}

const LIMIT = 500;

function key(projectId: string): string {
  return `wcr:annotations:${projectId}`;
}

/** 读某项目的全部批注；解析失败一律当没有（不让坏数据卡住面板）。 */
export function readAnnotations(projectId: string | null): AnnotationThread[] {
  if (!projectId) return [];
  try {
    const raw = window.localStorage.getItem(key(projectId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is AnnotationThread =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as AnnotationThread).file === 'string' &&
        typeof (item as AnnotationThread).line === 'number' &&
        typeof (item as AnnotationThread).text === 'string',
    );
  } catch {
    return [];
  }
}

/** 写回：超出上限时丢最早创建的，避免 localStorage 被无限撑大。 */
export function writeAnnotations(projectId: string, list: AnnotationThread[]): void {
  try {
    const trimmed = [...list]
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-LIMIT);
    window.localStorage.setItem(key(projectId), JSON.stringify(trimmed));
  } catch {
    /* 配额 / 隐私模式：静默失败 */
  }
}

/** 新批注 id：时间戳 + 随机后缀（同毫秒连续添加也不会撞）。 */
export function newAnnotationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function annotationsForFile(list: AnnotationThread[], file: string): AnnotationThread[] {
  return list.filter((a) => a.file === file).sort((a, b) => a.line - b.line || a.col - b.col);
}

/** 文件树 / 大纲上的计数用：file → 条数（未解决的才算，已解决的只是留档）。 */
export function unresolvedCounts(list: AnnotationThread[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const a of list) {
    if (a.resolved) continue;
    counts[a.file] = (counts[a.file] ?? 0) + 1;
  }
  return counts;
}

/**
 * 导出成 Markdown（S10「随导出物一起交付」）：
 * 按文件分组、位置 `path:line`（批注是行的概念，列只用于界面内对照）。
 */
export function annotationsMarkdown(projectName: string, list: AnnotationThread[]): string {
  const out: string[] = [`# 批注 · ${projectName}`, ''];
  if (list.length === 0) {
    out.push('（没有批注）');
    return `${out.join('\n')}\n`;
  }
  const byFile = new Map<string, AnnotationThread[]>();
  for (const a of [...list].sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line)) {
    const bucket = byFile.get(a.file);
    if (bucket) bucket.push(a);
    else byFile.set(a.file, [a]);
  }
  for (const [file, threads] of byFile) {
    out.push(`## ${file}`, '');
    for (const thread of threads) {
      const mark = thread.resolved ? '（已解决）' : '';
      out.push(`- ${formatLineRange(file, thread.line, thread.line)} — ${thread.text}${mark}`);
      for (const reply of thread.replies) out.push(`  - 回复：${reply.text}`);
    }
    out.push('');
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

/** 界面上「复制这一条」用的单条文本：位置 + 正文 + 回复。 */
export function annotationText(thread: AnnotationThread): string {
  const head = `${formatLocation(thread.file, thread.line, thread.col)} ${thread.text}`;
  const replies = thread.replies.map((r) => `↳ ${r.text}`);
  return [head, ...replies].join('\n');
}
