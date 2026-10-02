/**
 * 变更感知（04 Guide · G8.2–G8.4）：把「上次阅读时的快照」与现状对比，给出 M/A/D 清单。
 *
 * 两条纪律：
 * 1) **git 可用就按 git 的事实说**（`diff --numstat` 的增删行、status 的 M/A/D、`??` 的未跟踪）；
 *    git 不可用只做快照对比 —— 只报 mtime / size / 行数是否变过，**不编造 addedLines /
 *    removedLines**，并在顶层标注 `source: 'snapshot'` 让界面写「无 git，仅行数对比」。
 * 2) 「是不是 agent 产出」不另写一套：直接复用 timeline 的 `classify`（宿主上报 > 新鲜度启发式），
 *    与 01 地图的来源口径完全同源。
 *
 * 参与对比的文件沿用索引的 `project.entries`（不在索引内 / 被忽略目录 / 非源码文件不参与）；
 * 唯一的例外是「快照里有、磁盘上已经消失」的文件 —— 那是要告诉用户的 D，必须列出来。
 */
import fsp from 'node:fs/promises';
import type {
  ChangeFile,
  ChangeSnapshotFile,
  ChangeSnapshotInput,
  ChangeSummary,
  ChangeStatus,
  FileOrigin,
  ReadmapFile,
  ReadmapResult,
} from '../types';
import { specForFile } from '../languages';
import { diffNumstat } from './gitread';
import { classify, DEFAULT_RECENT_WINDOW_MS, git, hostMarksFor, normalizeRel, readGit } from './timeline';
import type { ProjectIndex } from './store';

/** 只有源码文件参与变更清单（与「阅读快照只存索引内源码文件」同一口径）。 */
function isSourceFile(rel: string): boolean {
  return specForFile(rel) !== null;
}

/** 行数计数口径：按 `\n` 切分（与前端写快照时保持同一算法）。 */
function linesIn(source: string): number {
  return source ? source.split('\n').length : 0;
}

/**
 * 文件当前的样子：mtime / size 以磁盘 stat 为准（内存 entries 可能滞后于 watcher），
 * lines 取索引里的文本行数（文件刚改但未重索引时可能滞后，git 模式的行数以 numstat 为准）。
 */
async function sideOf(project: ProjectIndex, rel: string): Promise<ChangeSnapshotFile | undefined> {
  if (!project.resolveInside(rel)) return undefined;
  try {
    const st = await fsp.stat(project.abs(rel));
    if (!st.isFile()) return undefined;
    const fi = project.files.get(rel);
    return { mtimeMs: st.mtimeMs, size: st.size, lines: fi ? linesIn(fi.source) : 0 };
  } catch {
    return undefined;
  }
}

function normalizeSide(raw: unknown): ChangeSnapshotFile | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const side = raw as Partial<ChangeSnapshotFile>;
  return {
    mtimeMs: Number.isFinite(side.mtimeMs) ? Number(side.mtimeMs) : 0,
    size: Number.isFinite(side.size) ? Number(side.size) : 0,
    lines: Number.isFinite(side.lines) ? Number(side.lines) : 0,
  };
}

async function existsOnDisk(project: ProjectIndex, rel: string): Promise<boolean> {
  if (!project.resolveInside(rel)) return false;
  try {
    const st = await fsp.stat(project.abs(rel));
    return st.isFile();
  } catch {
    return false;
  }
}

/** 笔记 id → 文件 的计数（只关心「哪几个文件上有笔记」）。 */
function noteCounts(noteLocs: ChangeSnapshotInput['noteLocs']): Map<string, number> {
  const counts = new Map<string, number>();
  if (!noteLocs || typeof noteLocs !== 'object') return counts;
  for (const loc of Object.values(noteLocs)) {
    const file = typeof loc?.file === 'string' ? normalizeRel(loc.file) : '';
    if (!file) continue;
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
}

/** `git status --porcelain` 的一行：XY 码 + 路径（rename 取新路径）。 */
function parseStatus(out: string): Array<{ path: string; code: string }> {
  const items: Array<{ path: string; code: string }> = [];
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.length < 4) continue;
    const code = line.slice(0, 2).trim() || line.slice(0, 2);
    let p = line.slice(3).trim();
    if (!p) continue;
    if (p.includes(' -> ')) p = p.slice(p.lastIndexOf(' -> ') + 4);
    p = p.replace(/^"|"$/g, '').replace(/\\/g, '/');
    if (!p) continue;
    items.push({ path: p, code });
  }
  return items;
}

/** XY 码 → M/A/D（重命名 / 复制按新增记；旧路径由快照对比兜底成 D）。 */
function statusOf(code: string): ChangeStatus {
  if (code === '??') return 'A';
  if (code.includes('R') || code.includes('C')) return 'A';
  if (code.includes('D')) return 'D';
  if (code.includes('A')) return 'A';
  return 'M';
}

/**
 * 阅读快照的数据源（G8.2）：只列索引里的源码文件，mtime / size 取扫描时记下的 stat。
 *
 * 为什么不重新扫盘：`project.entries` 由 watcher 持续维护，已经是「磁盘现状」的镜像；
 * 行数取 `FileIndex.source`，与 `compareSnapshot` 的 `linesIn` 同一口径 ——
 * 两端算法不一致就会把「没改过」误报成 M。
 */
export function readmap(project: ProjectIndex): ReadmapResult {
  const files: ReadmapFile[] = [];
  for (const [rel, info] of project.entries) {
    if (info.dir || !isSourceFile(rel)) continue;
    const fi = project.files.get(rel);
    if (!fi) continue; // 只含已进入符号索引的源码文件
    files.push({ file: rel, mtimeMs: info.mtimeMs, size: info.size, lines: linesIn(fi.source) });
  }
  files.sort((a, b) => a.file.localeCompare(b.file));
  return { at: Date.now(), files };
}

/**
 * 对比一次阅读快照：git 可用走 numstat（M/A/D + 增删行），否则只做快照对比。
 * 任何一步拿不到事实都不猜 —— 例如 numstat 没覆盖的未跟踪新文件只给「行数」，不给删除行。
 */
export async function compareSnapshot(
  project: ProjectIndex,
  snapshot: ChangeSnapshotInput,
): Promise<ChangeSummary> {
  const now = Date.now();
  const at = Number.isFinite(snapshot?.at) ? Number(snapshot.at) : now;
  const snap = snapshot?.files && typeof snapshot.files === 'object' ? snapshot.files : {};
  const notes = noteCounts(snapshot?.noteLocs);

  const numstat = await diffNumstat(project.root, 'HEAD');
  const facts = numstat ? await readGit(project.root) : null;
  const statusEntries = numstat ? parseStatus((await git(project.root, ['status', '--porcelain'])) ?? '') : [];

  /**
   * 拿不到 numstat 时要说清是哪种：不是 git 仓库，还是「是仓库但还没提交」——
   * 后者很常见（刚 `git init` 的项目），写成「未检测到 git」是在说假话。
   */
  const gitState: ChangeSummary['git'] = numstat
    ? 'ok'
    : (await git(project.root, ['rev-parse', '--is-inside-work-tree']))?.trim() === 'true'
      ? (await git(project.root, ['rev-parse', '--verify', 'HEAD']))
        ? 'ok'
        : 'no-head'
      : 'no-repo';

  const dirty = new Set<string>(statusEntries.map((e) => e.path));
  const tracked = new Set<string>();
  for (const batch of facts?.batches ?? []) for (const f of batch.files) tracked.add(normalizeRel(f));
  const hosted = new Map(hostMarksFor(project.id).map((m) => [m.file, { at: m.at, lines: m.lines }]));

  const originOf = (file: string, mtimeMs: number): { origin: FileOrigin; confidence: number } =>
    classify(file, mtimeMs, now, DEFAULT_RECENT_WINDOW_MS, dirty, tracked, hosted);

  const out: ChangeFile[] = [];
  const seen = new Set<string>();
  const push = async (file: string, status: ChangeStatus, extra: Partial<ChangeFile> = {}) => {
    if (seen.has(file)) return;
    seen.add(file);
    const noteCount = notes.get(file) ?? 0;
    const before = normalizeSide(snap[file]);
    const after = status === 'D' ? undefined : await sideOf(project, file);
    const { origin, confidence } = originOf(file, after?.mtimeMs ?? before?.mtimeMs ?? 0);
    out.push({
      file,
      status,
      addedLines: null,
      removedLines: null,
      before,
      after,
      origin,
      originConfidence: confidence,
      notes: noteCount,
      // 有笔记 + 这个文件出现在变更清单里 = 笔记可能已经过期
      noteStale: noteCount > 0,
      ...extra,
    });
  };

  if (numstat) {
    const stat = new Map(numstat.map((e) => [normalizeRel(e.file), e]));
    const statusMap = new Map(statusEntries.map((e) => [e.path, e.code]));
    const candidates = new Set<string>();
    for (const entry of statusEntries) {
      // 未跟踪的目录项（`?? dir/`）展开成目录下已索引的文件
      if (entry.code === '??' && entry.path.endsWith('/')) {
        const prefix = entry.path.replace(/\/+$/, '');
        for (const [rel, info] of project.entries) {
          if (!info.dir && rel.startsWith(`${prefix}/`)) candidates.add(rel);
        }
        continue;
      }
      candidates.add(entry.path);
    }
    for (const e of numstat) candidates.add(normalizeRel(e.file));

    for (const rel of candidates) {
      if (!isSourceFile(rel)) continue;
      // 不在索引内、也不是快照里的文件 → 不参与（沿用 project.entries 的排除口径）
      if (project.entries.get(rel)?.dir !== false && !snap[rel]) continue;
      const entry = stat.get(rel);
      const code = statusMap.get(rel) ?? '';
      const status = code ? statusOf(code) : entry && entry.added === 0 ? 'D' : entry ? 'M' : null;
      if (!status) continue;
      const extra: Partial<ChangeFile> = {};
      if (entry) {
        extra.addedLines = entry.added;
        extra.removedLines = entry.removed;
        extra.binary = entry.binary;
      } else if (status === 'A') {
        // 未跟踪新文件不在 numstat 里：增行取文件行数，删行如实给 0（从无到有）
        extra.addedLines = linesIn(project.files.get(rel)?.source ?? '');
        extra.removedLines = 0;
        extra.binary = false;
      }
      await push(rel, status, extra);
    }
  } else {
    const keys = new Set<string>(Object.keys(snap).map(normalizeRel));
    for (const [rel, info] of project.entries) if (!info.dir && isSourceFile(rel)) keys.add(rel);

    for (const rel of keys) {
      if (!isSourceFile(rel)) continue;
      const before = normalizeSide(snap[rel]);
      const after = await sideOf(project, rel);
      if (before && !after) {
        if (await existsOnDisk(project, rel)) continue; // 还在磁盘上，只是这次没被索引
        await push(rel, 'D');
        continue;
      }
      if (!before && after) {
        await push(rel, 'A');
        continue;
      }
      if (!before || !after) continue;
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size || before.lines !== after.lines) {
        await push(rel, 'M');
      }
    }
  }

  // 快照里有、磁盘上已经消失、又没被 git 报出来的文件：同样要如实标 D
  for (const raw of Object.keys(snap)) {
    const rel = normalizeRel(raw);
    if (seen.has(rel) || !isSourceFile(rel)) continue;
    if (await existsOnDisk(project, rel)) continue;
    await push(rel, 'D');
  }

  const counts = {
    added: out.filter((f) => f.status === 'A').length,
    modified: out.filter((f) => f.status === 'M').length,
    deleted: out.filter((f) => f.status === 'D').length,
    addedLines: numstat ? out.reduce((n, f) => n + (f.addedLines ?? 0), 0) : 0,
    removedLines: numstat ? out.reduce((n, f) => n + (f.removedLines ?? 0), 0) : 0,
    noteStale: out.filter((f) => f.noteStale).length,
  };

  out.sort((a, b) => a.file.localeCompare(b.file) || a.status.localeCompare(b.status));
  return { at, now, source: numstat ? 'git' : 'snapshot', git: gitState, files: out, counts };
}
