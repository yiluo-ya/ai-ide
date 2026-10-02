/**
 * 行级 blame（04 Guide · W3 / G7.3）：数据获取、缓存与一行摘要。
 *
 * 缓存口径（`04-guide-plan.md` §6）：按「项目 + 文件」缓存**一次请求**，
 * 光标每移动一行都去问一次后端是不可接受的（大仓库的 blame 是数百毫秒级）。
 * 只在换文件、或用户显式重取（切换 blame 视图）时才发请求。
 *
 * 只读：blame 结果只用来展示「谁、什么时候、哪次提交」，不参与任何写操作。
 */
import type { BlameLine, BlameResult } from '../../shared/types';
import { changesApi } from './readSnapshot';
import { timeAgo } from './timeAgo';
import type { TFunc } from './i18n';

/** key = 项目 id + 文件；value = 进行中 / 已完成的请求（同一文件不重复拉）。 */
const cache = new Map<string, Promise<BlameResult>>();

/** 取某文件的 blame（命中缓存就直接用；失败时不缓存，下次仍可重试）。 */
export function loadBlame(projectId: string, file: string): Promise<BlameResult> {
  const key = `${projectId}\u0000${file}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = changesApi.blame(projectId, file).catch((e: unknown) => {
    cache.delete(key); // 失败的请求不留在缓存里当「已知结果」
    throw e;
  });
  cache.set(key, pending);
  return pending;
}

/** 切项目时清缓存（不同项目的同名文件不是一回事）。 */
export function clearBlameCache(): void {
  cache.clear();
}

/** 作者短名：状态栏 / 行尾只放得下几个字，过长截断而不是换行。 */
export function shortAuthor(author: string): string {
  const name = author.trim();
  if (!name) return '?';
  return name.length > 12 ? `${name.slice(0, 12)}…` : name;
}

/** 状态栏一行：`作者 · 相对日期 · 提交摘要`。 */
export function blameText(line: BlameLine, t: TFunc, now = Date.now()): string {
  return t('blame.line', {
    author: shortAuthor(line.author),
    when: timeAgo(line.at, t, now),
    summary: line.summary,
  });
}

/** 取某一行（1-based）的 blame；这一行没有记录返回 null（宁可不显示，也不编）。 */
export function blameAt(result: BlameResult | null, line: number): BlameLine | null {
  if (!result) return null;
  return result.lines.find((l) => l.line === line) ?? null;
}
