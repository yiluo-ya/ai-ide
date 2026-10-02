/**
 * 向导（04 Guide · W1）的本地存储与请求。
 *
 * 单独成文件的原因与 `mapApi.ts` 一致：`api.ts` / `state.ts` 被其它主题持续改写，
 * 向导自己的键与请求放这里，既不互相踩，也避免往共享文件里堆东西。
 *
 * 存储口径（`04-guide-plan.md` §4）：全部落浏览器 localStorage、按项目 id 分片、
 * 不写被读目录、不落后端；所有读写包 try/catch，隐私模式静默降级。
 */
import type { FileSummary, GuideRoutesResult } from '../../shared/types';
import { request } from './api';

/** 四条阅读路线（G2.1–G2.4）。 */
export type RouteKind = 'dep' | 'entry' | 'hot' | 'fresh';

export const ROUTE_KINDS: RouteKind[] = ['dep', 'entry', 'hot', 'fresh'];

/** 当前路线与它的本地状态：自定义顺序 + 手动标记的完成态（G2.6 / G3.1）。 */
export interface RouteState {
  kind: RouteKind;
  /** 自定义顺序（文件路径数组）；空 / 缺省表示用后端给的顺序。 */
  custom?: string[];
  /** file → 手动标记「已读」的时间。 */
  done: Record<string, number>;
}

/** 继续阅读（G3.4）：最后一次打开的文件与行列。 */
export interface ReadState {
  file: string;
  line: number;
  col: number;
  at: number;
}

/** 待读队列的一条（G3.5）。 */
export interface QueueItem {
  file: string;
  line: number;
  col: number;
  note?: string;
  at: number;
}

/** 待读队列上限（04-guide-plan §4）。 */
export const QUEUE_LIMIT = 200;

const routesKey = (projectId: string): string => `wcr:routes:${projectId}`;
const readStateKey = (projectId: string): string => `wcr:readstate:${projectId}`;
const queueKey = (projectId: string): string => `wcr:queue:${projectId}`;

function readJson(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式 / 配额满：不因为记不住而打断阅读 */
  }
}

const isRouteKind = (value: unknown): value is RouteKind =>
  typeof value === 'string' && (ROUTE_KINDS as string[]).includes(value);

/** 读当前路线状态；没有或脏数据时回落「依赖序 + 空完成表」。 */
export function loadRouteState(projectId: string): RouteState {
  const raw = readJson(routesKey(projectId)) as Partial<RouteState> | null;
  const custom = Array.isArray(raw?.custom)
    ? raw!.custom.filter((f): f is string => typeof f === 'string')
    : undefined;
  const done: Record<string, number> = {};
  if (raw?.done && typeof raw.done === 'object') {
    for (const [file, at] of Object.entries(raw.done)) {
      if (typeof at === 'number') done[file] = at;
    }
  }
  return { kind: isRouteKind(raw?.kind) ? raw.kind : 'dep', ...(custom?.length ? { custom } : {}), done };
}

export function saveRouteState(projectId: string, state: RouteState): void {
  writeJson(routesKey(projectId), state);
}

/** 读「继续阅读」；没有或脏数据返回 null（整块不渲染，而不是显示空壳）。 */
export function loadReadState(projectId: string): ReadState | null {
  const raw = readJson(readStateKey(projectId)) as Partial<ReadState> | null;
  if (!raw || typeof raw.file !== 'string' || !raw.file) return null;
  return {
    file: raw.file,
    line: typeof raw.line === 'number' && raw.line > 0 ? raw.line : 1,
    col: typeof raw.col === 'number' && raw.col > 0 ? raw.col : 1,
    at: typeof raw.at === 'number' ? raw.at : 0,
  };
}

export function saveReadState(projectId: string, state: ReadState): void {
  writeJson(readStateKey(projectId), state);
}

/** 读待读队列（按记录时间倒序，最近加入的在前）。 */
export function loadQueue(projectId: string): QueueItem[] {
  const raw = readJson(queueKey(projectId));
  if (!Array.isArray(raw)) return [];
  const out: QueueItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Partial<QueueItem>;
    if (typeof it.file !== 'string' || !it.file) continue;
    out.push({
      file: it.file,
      line: typeof it.line === 'number' && it.line > 0 ? it.line : 1,
      col: typeof it.col === 'number' && it.col > 0 ? it.col : 1,
      ...(typeof it.note === 'string' ? { note: it.note } : {}),
      at: typeof it.at === 'number' ? it.at : 0,
    });
  }
  return out.slice(0, QUEUE_LIMIT);
}

export function saveQueue(projectId: string, items: QueueItem[]): void {
  writeJson(queueKey(projectId), items.slice(0, QUEUE_LIMIT));
}

/** 向导的两个后端请求；`request` 已由 api.ts 导出，这里不另起一套错误处理。 */
export const guideApi = {
  /** G2.1–G2.4：四条阅读路线一次算全（索引未完成时 `partial: true`）。 */
  routes: (id: string) => request<GuideRoutesResult>(`/projects/${id}/routes`),

  /** G6.1：文件级结构性摘要；文件不在索引内时后端 404（调用方整条不渲染）。 */
  fileSummary: (id: string, file: string) =>
    request<FileSummary>(`/projects/${id}/file-summary?file=${encodeURIComponent(file)}`),
};
