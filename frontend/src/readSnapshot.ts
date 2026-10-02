/**
 * 阅读快照存储（04 Guide · W3 / G8.2）：把「上次阅读时代的代码是什么样」记在本机。
 *
 * 存储口径与 `guide.ts` / `notes.ts` 同源（`04-guide-plan.md` §4）：落浏览器 localStorage、
 * 按项目 id 分片（`wcr:readsnapshot:<id>`）、不写被读目录、不落后端；全部读写包 try/catch。
 *
 * 只存**索引内的源码文件**（`readmap` 已按这一口径过滤）——非源码文件不进快照，
 * 否则快照虚胖，而且它们的变化本来也不在阅读视野里。
 *
 * 这个模块同时收口 W3 的四个只读请求（readmap / changes / diff / blame / history / show），
 * 与 `guide.ts` 的 `guideApi` 同一做法：向导的 key 与请求集中放，避免往 api.ts 里堆。
 */
import type {
  BlameResult,
  ChangeSnapshotFile,
  ChangeSnapshotInput,
  ChangeSummary,
  FileDiffResult,
  FileHistoryResult,
  GitShowResult,
  ReadmapResult,
} from '../../shared/types';
import { request } from './api';
import { loadNotes, type Note } from './notes';

/** 一次阅读快照：`at` = 记录时间（客户端时钟，界面写「上次阅读」用的就是它）。 */
export interface ReadSnapshot {
  at: number;
  files: Record<string, ChangeSnapshotFile>;
  /** 笔记 id → 它当时锚在哪个文件的哪一行（文件级笔记 line=0）。 */
  noteLocs: Record<string, { file: string; line: number }>;
}

/** openFileAt 之后写快照的防抖（阅读时频繁翻文件，不该每个文件都写一次）。 */
export const SNAPSHOT_DEBOUNCE_MS = 2000;

const snapshotKey = (projectId: string): string => `wcr:readsnapshot:${projectId}`;

function readJson(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

/** 读某项目的阅读快照；没有 / 脏数据返回 null（整块按「无基线」呈现，不显示空壳）。 */
export function readSnapshot(projectId: string | null): ReadSnapshot | null {
  if (!projectId) return null;
  const raw = readJson(snapshotKey(projectId)) as Partial<ReadSnapshot> | null;
  if (!raw || typeof raw.at !== 'number' || !raw.files || typeof raw.files !== 'object') return null;
  const files: Record<string, ChangeSnapshotFile> = {};
  for (const [file, side] of Object.entries(raw.files)) {
    if (!side || typeof side !== 'object') continue;
    const s = side as Partial<ChangeSnapshotFile>;
    files[file] = {
      mtimeMs: Number.isFinite(s.mtimeMs) ? Number(s.mtimeMs) : 0,
      size: Number.isFinite(s.size) ? Number(s.size) : 0,
      lines: Number.isFinite(s.lines) ? Number(s.lines) : 0,
    };
  }
  const noteLocs: ReadSnapshot['noteLocs'] = {};
  if (raw.noteLocs && typeof raw.noteLocs === 'object') {
    for (const [id, loc] of Object.entries(raw.noteLocs)) {
      if (!loc || typeof loc.file !== 'string') continue;
      noteLocs[id] = { file: loc.file, line: typeof loc.line === 'number' ? loc.line : 0 };
    }
  }
  return { at: raw.at, files, noteLocs };
}

/** 写快照（隐私模式 / 配额满时静默失败：记不住快照不打断阅读）。 */
export function writeSnapshot(projectId: string, snap: ReadSnapshot): void {
  try {
    window.localStorage.setItem(snapshotKey(projectId), JSON.stringify(snap));
  } catch {
    /* 隐私模式 / 配额满 */
  }
}

/**
 * 由 `readmap` + 本地笔记拼一份快照。
 *
 * `noteLocs` 只收文件在索引内的笔记：读不到的路径（已被删 / 被忽略）留在笔记里没问题，
 * 但放进快照只会让「你标注过的地方被改了」这个判断失真。
 */
export function buildSnapshot(projectId: string, readmap: ReadmapResult, notes: Note[]): ReadSnapshot {
  const files: Record<string, ChangeSnapshotFile> = {};
  // projectId 是归属守卫：没有项目就没有「哪个项目的阅读基线」这回事
  if (!projectId) return { at: Date.now(), files, noteLocs: {} };
  for (const f of readmap.files) {
    files[f.file] = { mtimeMs: f.mtimeMs, size: f.size, lines: f.lines };
  }
  const noteLocs: ReadSnapshot['noteLocs'] = {};
  for (const note of notes) {
    if (!files[note.file]) continue;
    noteLocs[note.id] = { file: note.file, line: note.line };
  }
  return { at: Date.now(), files, noteLocs };
}

/** 距离「上次阅读」多久（毫秒）；没有快照返回 null。界面据此写「3 天前看过」。 */
export function snapshotAge(snap: ReadSnapshot | null, now = Date.now()): number | null {
  if (!snap || !Number.isFinite(snap.at)) return null;
  return Math.max(0, now - snap.at);
}

/**
 * 拉 readmap + 读本地笔记 → 写快照。失败返回 null（界面据此说「记不上」，
 * 而不是把旧快照当新的用）。
 */
export async function captureSnapshot(projectId: string): Promise<ReadSnapshot | null> {
  try {
    const readmap = await changesApi.readmap(projectId);
    const snap = buildSnapshot(projectId, readmap, loadNotes(projectId));
    writeSnapshot(projectId, snap);
    return snap;
  } catch {
    return null;
  }
}

let debounceTimer: number | null = null;
let debounceProject: string | null = null;

/**
 * 写时机 ①（`04-guide-plan.md` §2 W3）：`openFileAt` 成功后防抖 2s 写。
 * 只写最后一次打开的项目 —— 中途切项目时旧项目由「切项目立即写」那条兜住。
 */
export function scheduleSnapshotWrite(projectId: string, delayMs = SNAPSHOT_DEBOUNCE_MS): void {
  if (!projectId) return;
  debounceProject = projectId;
  if (debounceTimer != null) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null;
    const id = debounceProject;
    debounceProject = null;
    if (id) void captureSnapshot(id);
  }, delayMs);
}

/** 立刻写（切项目 / 页面隐藏 / 手动按钮）；返回写下的快照（失败为 null）。 */
export function flushSnapshot(projectId: string | null): Promise<ReadSnapshot | null> {
  if (debounceTimer != null) {
    window.clearTimeout(debounceTimer);
    debounceTimer = null;
    debounceProject = null;
  }
  if (!projectId) return Promise.resolve(null);
  return captureSnapshot(projectId);
}

/** W3 的只读请求收口（与 `guideApi` 同一做法，不往 api.ts 里堆）。 */
export const changesApi = {
  /** G8.2 前置：写快照需要的 mtime / size / 行数。 */
  readmap: (id: string) => request<ReadmapResult>(`/projects/${id}/readmap`),

  /** G8.1–G8.3：拿快照换变更清单（git 可用走 git，否则按快照对比）。 */
  changes: (id: string, snapshot: ChangeSnapshotInput) =>
    request<ChangeSummary>(`/projects/${id}/changes`, {
      method: 'POST',
      body: JSON.stringify(snapshot),
    }),

  /** G7.2 / G7.5：只读 diff（rev 缺省 = 工作区 vs HEAD）。 */
  fileDiff: (id: string, file: string, rev = 'HEAD') =>
    request<FileDiffResult>(
      `/projects/${id}/file-diff?path=${encodeURIComponent(file)}&rev=${encodeURIComponent(rev)}`,
    ),

  /** G7.3：行级 blame。 */
  blame: (id: string, file: string) =>
    request<BlameResult>(`/projects/${id}/blame?path=${encodeURIComponent(file)}`),

  /** G7.4：文件级提交历史。 */
  fileHistory: (id: string, file: string, limit = 20) =>
    request<FileHistoryResult>(
      `/projects/${id}/file-history?path=${encodeURIComponent(file)}&limit=${limit}`,
    ),

  /** G7.5：某个历史版本的正文（只读，不落盘）。 */
  gitShow: (id: string, rev: string, file: string) =>
    request<GitShowResult>(
      `/projects/${id}/git-show?rev=${encodeURIComponent(rev)}&path=${encodeURIComponent(file)}`,
    ),
};
