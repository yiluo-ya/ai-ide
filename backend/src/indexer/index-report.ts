/**
 * 索引报告（P9 / Q20）：把「工具坏了」翻译成「这个文件为什么没进来」。
 *
 * 口径：
 * - 源码文件（扩展名匹配语言 spec）才逐个给原因；非源码只给 `not-source` 计数（files 留空，避免上千行噪音）；
 * - 降级索引（P11 顶层符号模式）算已索引，单独计入 `degraded`，不进 byReason；
 * - `parse-failed` 的 detail 取自解析期记录的错误文本；
 * - 编码分布来自正文实际解码结果（P12）。
 */
import type { IndexReport, SkipReason } from '../types';
import { specForFile } from '../languages';
import { MAX_VIEW_BYTES, type ProjectIndex } from './store';

/** 每种原因最多列出的文件数（其余只计数）。 */
export const MAX_REPORT_FILES = 50;

export function buildIndexReport(project: ProjectIndex): IndexReport {
  const groups = new Map<SkipReason, { count: number; files: string[]; detail?: string }>();
  const bump = (reason: SkipReason, file: string | null, detail?: string) => {
    let group = groups.get(reason);
    if (!group) {
      group = { count: 0, files: [] };
      groups.set(reason, group);
    }
    group.count++;
    if (file && group.files.length < MAX_REPORT_FILES) group.files.push(file);
    if (detail && !group.detail) group.detail = detail;
  };

  let scanned = 0;
  let indexed = 0;
  let degraded = 0;
  let sourceFiles = 0;
  let notSource = 0;

  for (const [rel, info] of project.entries) {
    if (info.dir) continue;
    scanned++;
    if (!specForFile(rel)) {
      notSource++;
      continue;
    }
    sourceFiles++;
    const skip = project.skipLog.get(rel);
    if (skip) {
      bump(skip.reason, rel, skip.detail);
      continue;
    }
    const fi = project.files.get(rel);
    if (!fi || fi.error) {
      // 没有记录也没进索引：保守地按「没解析上」处理（不编原因）
      bump('parse-failed', rel, fi?.error ?? undefined);
      continue;
    }
    indexed++;
    if (fi.degraded === 'top-level') degraded++;
  }

  if (notSource) {
    const group = groups.get('not-source') ?? { count: 0, files: [] as string[] };
    group.count += notSource;
    groups.set('not-source', group);
  }

  const order: SkipReason[] = ['too-large', 'binary', 'parse-failed', 'read-error', 'not-source'];
  const byReason = order
    .filter((reason) => groups.has(reason))
    .map((reason) => {
      const group = groups.get(reason)!;
      return {
        reason,
        count: group.count,
        files: reason === 'not-source' ? [] : group.files,
        ...(group.detail ? { detail: group.detail } : {}),
      };
    });

  const encodings = [...project.encodingStats.entries()]
    .map(([encoding, count]) => ({ encoding, count }))
    .sort((a, b) => b.count - a.count || a.encoding.localeCompare(b.encoding));

  return { scanned, indexed, degraded, sourceFiles, byReason, encodings, generatedAt: Date.now() };
}

/** 大文件阈值（报告里对外解释口径用）。 */
export const REPORT_VIEW_LIMIT = MAX_VIEW_BYTES;
