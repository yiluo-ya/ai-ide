/**
 * 时间与来源（01 Map 的 M9/M10）。
 *
 * 两条纪律：
 * 1) 只读 —— 只调用 `git log` / `git status` / `git rev-parse` 三个读命令，
 *    不提交、不切换分支、不改动任何文件；非 git 目录自动降级为纯文件系统时间。
 * 2) 「AI 产出」不猜：宿主上报（POST /origin）是一等事实（confidence=1），
 *    启发式只给「最近改动」并附置信度，不冒充「谁写的」。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import type { FileOrigin, ProjectTimeline, TimelineBatch, TimelineFile } from '../types';
import { specForFile } from '../languages';
import type { ProjectIndex } from './store';

const run = promisify(execFile);

/** git 命令超时：读历史是辅助信息，绝不允许拖慢阅读器。 */
const GIT_TIMEOUT_MS = 4000;
/** 单次最多读多少个提交批次。 */
const MAX_COMMITS = 40;
/** 「最近改动」默认窗口（毫秒）。 */
export const DEFAULT_RECENT_WINDOW_MS = 30 * 60 * 1000;

/** 宿主上报的产出清单：projectId → 文件 → { 上报时间, 可选行范围 }。 */
interface HostMark {
  at: number;
  /** 宿主声明的变更行范围（M10.2），空数组 = 只标到文件级。 */
  lines: Array<[number, number]>;
}

const hostOrigins = new Map<string, Map<string, HostMark>>();

/** 归一化宿主给的相对路径。 */
export const normalizeRel = (file: string): string =>
  file.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');

/**
 * 宿主（如 xchen）上报「这些文件是 agent 刚产出的」。
 * 兼容两种输入：字符串数组（只到文件级）或 `{ file, lines }` 数组（M10.2 行级）。
 */
export function markHostOrigins(
  projectId: string,
  files: Array<string | { file: string; lines?: Array<[number, number]> }>,
  clear = false,
): number {
  let bucket = hostOrigins.get(projectId);
  if (!bucket) {
    bucket = new Map();
    hostOrigins.set(projectId, bucket);
  }
  if (clear) bucket.clear();
  const at = Date.now();
  for (const item of files) {
    const raw = typeof item === 'string' ? item : item?.file;
    if (typeof raw !== 'string') continue;
    const file = normalizeRel(raw);
    if (!file) continue;
    const lines = typeof item === 'string' ? [] : (item.lines ?? []);
    const clean = lines
      .filter((r): r is [number, number] => Array.isArray(r) && r.length === 2 && r[0] > 0 && r[1] >= r[0])
      .map(([a, b]) => [a, b] as [number, number]);
    bucket.set(file, { at, lines: clean });
  }
  return bucket.size;
}

export function hostOriginCount(projectId: string): number {
  return hostOrigins.get(projectId)?.size ?? 0;
}

/** 宿主上报的快照，供概览与编辑器行标记使用（M10.1 / M10.2）。 */
export function hostMarksFor(projectId: string): Array<{ file: string; at: number; lines: Array<[number, number]> }> {
  const bucket = hostOrigins.get(projectId);
  if (!bucket) return [];
  return [...bucket.entries()]
    .map(([file, mark]) => ({ file, at: mark.at, lines: mark.lines }))
    .sort((a, b) => b.at - a.at || a.file.localeCompare(b.file));
}

/** 某个文件被宿主上报的变更行（空 = 没上报或只有文件级）。 */
export function hostLinesFor(projectId: string, file: string): Array<[number, number]> {
  return hostOrigins.get(projectId)?.get(normalizeRel(file))?.lines ?? [];
}

// ---------------------------------------------------------------- git（只读）

/**
 * 通用只读 git 包装：`execFile('git', ['-C', root, ...args])` 数组传参、不经 shell、带超时，
 * 失败（非 git 仓库 / 没装 git / 超时）返回 null。gitread.ts 的只读扩展复用它，不另起一套。
 */
export async function git(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', root, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return null;
  }
}

export interface GitFacts {
  branch: string | null;
  dirty: string[];
  batches: TimelineBatch[];
  committedAt: number | null;
}

/** 读 git 历史（只读）。非 git 仓库或没装 git 时返回 null。 */
export async function readGit(root: string): Promise<GitFacts | null> {
  if (!existsSync(root)) return null;
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside?.trim() !== 'true') return null;

  const branchOut = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchOut?.trim() && branchOut.trim() !== 'HEAD' ? branchOut.trim() : null;

  const statusOut = (await git(root, ['status', '--porcelain'])) ?? '';
  const dirty = statusOut
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const raw = line.slice(3).trim();
      const path = raw.includes(' -> ') ? raw.slice(raw.indexOf(' -> ') + 4) : raw;
      return path.replace(/^"|"$/g, '').replace(/\\/g, '/');
    });

  // 提交批次：\x01 记录分隔，\x02 分隔时间与摘要
  const logOut = await git(root, [
    'log',
    `-n${MAX_COMMITS}`,
    '--name-only',
    '--date-order',
    '--pretty=format:\x01%ct\x02%s',
  ]);
  const batches: TimelineBatch[] = [];
  if (logOut) {
    for (const block of logOut.split('\x01')) {
      if (!block.trim()) continue;
      const [head, ...rest] = block.split('\n');
      const [rawAt, ...labelParts] = head.split('\x02');
      const at = Number(rawAt) * 1000;
      if (!Number.isFinite(at)) continue;
      const files = rest.map((l) => l.trim()).filter(Boolean);
      batches.push({ at, label: labelParts.join('\x02').trim() || null, files });
    }
  }
  return { branch, dirty, batches, committedAt: batches[0]?.at ?? null };
}

// ---------------------------------------------------------------- 时间轴

export interface TimelineOptions {
  /** 「最近改动」窗口（毫秒）。 */
  windowMs?: number;
  /** 是否尝试读 git（默认尝试）。 */
  useGit?: boolean;
}

/**
 * git status 报的是路径，未跟踪的目录只会有一个 `src/` 这样的目录项；
 * 这里把它展开成项目里真实存在的文件（注意 entries 里既有文件也有目录）。
 */
function expandDirtyPaths(project: ProjectIndex, paths: string[]): string[] {
  const isFile = (rel: string) => project.entries.get(rel)?.dir === false;
  const files = [...project.entries.keys()].filter(isFile);
  const out = new Set<string>();
  for (const raw of paths) {
    const clean = raw.replace(/\/+$/, '');
    if (isFile(clean)) {
      out.add(clean);
      continue;
    }
    if (!raw.endsWith('/')) continue;
    for (const file of files) if (file.startsWith(`${clean}/`)) out.add(file);
  }
  return [...out];
}

export async function buildTimeline(
  project: ProjectIndex,
  options: TimelineOptions = {},
): Promise<ProjectTimeline> {
  const windowMs = Math.max(60_000, options.windowMs ?? DEFAULT_RECENT_WINDOW_MS);
  const now = Date.now();
  const gitFacts = options.useGit === false ? null : await readGit(project.root);
  const dirtyFiles = gitFacts ? expandDirtyPaths(project, gitFacts.dirty) : [];
  const dirtySet = new Set(dirtyFiles);
  const tracked = new Set<string>();
  for (const batch of gitFacts?.batches ?? []) for (const f of batch.files) tracked.add(f);
  const hosted = hostOrigins.get(project.id);

  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const day = 86_400_000;
  const counts = { today: 0, last3d: 0, last7d: 0, older: 0 };
  const files: TimelineFile[] = [];

  for (const [rel, info] of project.entries) {
    if (info.dir) continue;
    const at = info.mtimeMs;
    if (at >= startOfToday) counts.today++;
    else if (at >= now - 3 * day) counts.last3d++;
    else if (at >= now - 7 * day) counts.last7d++;
    else counts.older++;

    const spec = specForFile(rel);
    const { origin, confidence } = classify(rel, at, now, windowMs, dirtySet, tracked, hosted);
    files.push({
      file: rel,
      mtimeMs: at,
      size: info.size,
      lang: spec ? spec.id : 'plaintext',
      origin,
      confidence,
    });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));

  const batches: TimelineBatch[] = [];
  if (gitFacts) {
    if (dirtyFiles.length) {
      const newest = Math.max(...dirtyFiles.map((f) => project.entries.get(f)?.mtimeMs ?? 0), 0);
      batches.push({ at: newest || now, label: '未提交的改动', files: dirtyFiles });
    }
    const known = new Set([...project.entries.keys()].filter((f) => project.entries.get(f)?.dir === false));
    for (const batch of gitFacts.batches) {
      const kept = batch.files.filter((f) => known.has(f));
      if (!kept.length) continue;
      batches.push({ at: batch.at, label: batch.label, files: kept });
    }
  } else {
    // 无 git：按本地日期把改动聚成批次（只给最近 7 天）
    const byDay = new Map<string, TimelineBatch>();
    for (const file of files) {
      if (file.mtimeMs < now - 7 * day) continue;
      const date = new Date(file.mtimeMs);
      const key = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
      let batch = byDay.get(key);
      if (!batch) {
        batch = { at: file.mtimeMs, label: key, files: [] };
        byDay.set(key, batch);
      }
      batch.files.push(file.file);
      batch.at = Math.max(batch.at, file.mtimeMs);
    }
    batches.push(...byDay.values());
  }
  batches.sort((a, b) => b.at - a.at);

  return {
    source: gitFacts ? 'git' : 'fs',
    git: {
      branch: gitFacts?.branch ?? null,
      committedAt: gitFacts?.committedAt ?? null,
      dirty: gitFacts?.dirty ?? [],
    },
    counts,
    files,
    batches: batches.slice(0, MAX_COMMITS + 1),
  };
}

/**
 * 来源判定：宿主上报 > 启发式（新鲜度 + 是否未提交的新文件）。
 * 导出供 changes.ts 复用同一口径（不另写一份「是不是 agent 产出」的判定）。
 */
export function classify(
  rel: string,
  mtimeMs: number,
  now: number,
  windowMs: number,
  dirty: Set<string>,
  tracked: Set<string>,
  hosted: Map<string, HostMark> | undefined,
): { origin: FileOrigin; confidence: number } {
  if (hosted?.has(rel)) return { origin: 'agent', confidence: 1 };
  if (mtimeMs >= now - windowMs) {
    // 刚改过；git 说它「未跟踪」（从没提交过）时更像本轮新产出
    const untracked = dirty.has(rel) && !tracked.has(rel);
    return { origin: 'recent', confidence: untracked ? 0.9 : dirty.has(rel) ? 0.8 : 0.6 };
  }
  return { origin: 'project', confidence: 0.9 };
}
