/**
 * 只读 git 扩展（04 Guide · G7.2–G7.5）：diff / blame / 文件历史 / 历史版本正文。
 *
 * 三条纪律（与 01 地图 timeline.ts 同源）：
 * 1) **只读命令清单**：`git diff --numstat` / `git diff --unified` / `git blame --line-porcelain`
 *    / `git log --follow --name-status` / `git show <rev>:<path>`。没有、也不会有任何写操作
 *    （commit / add / checkout / stash / merge / push / clean），被读目录一个字节都不动。
 * 2) 全部经 `timeline.git()` 的 `execFile('git', ['-C', root, ...args])` 数组传参、不经 shell；
 *    `rev` 先过白名单、`path` 先过「必须落在项目根内」的校验，杜绝参数注入与路径穿越。
 * 3) 失败（非 git 仓库 / 没装 git / 超时 / rev 不存在）一律返回 null，绝不上抛；
 *    拿不到就如实说 null，不猜、不用文件系统时间冒充 git 事实。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { git, normalizeRel } from './timeline';

/** rev 白名单：40 位以内的十六进制 sha，或 `HEAD` / `HEAD~3` 形态。 */
const REV_RE = /^(?:[0-9a-f]{4,40}|HEAD(?:~\d+)?)$/i;

/** rev 是否合法（不合法一律拒绝，不让任意字符串进 git 参数）。 */
export function isValidRev(rev: string): boolean {
  return typeof rev === 'string' && REV_RE.test(rev.trim());
}

/** 单次 diff 最多返回多少字符（超出截断，端点层标注 truncated）。 */
export const DIFF_MAX_CHARS = 400_000;

/** blame 超过这个行数就不再展开（避免整仓库级别的元数据输出拖垮阅读器）。 */
export const BLAME_MAX_LINES = 5000;

/** blame 前先按大小挡一刀：超大文件连读都不读。 */
const BLAME_MAX_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------- 路径 / 参数

/**
 * 项目内路径校验（等价 `ProjectIndex.resolveInside`，此处不依赖实例）：
 * 解析后的绝对路径必须落在 `root` 内且不是 root 本身；不合法返回 null。
 */
function insideRel(root: string, rel: unknown): string | null {
  if (typeof rel !== 'string' || !rel.trim() || rel.includes('\0')) return null;
  const normalized = normalizeRel(rel.trim());
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) return null;
  const abs = path.resolve(root, normalized);
  const base = path.resolve(root);
  if (abs === base || !abs.startsWith(base + path.sep)) return null;
  return normalized;
}

/** 正整数钳制（limit / 行数等）。 */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// ---------------------------------------------------------------- diff --numstat

/** numstat 的一行：二进制文件 added/removed 为 null 且 binary=true。 */
export interface NumstatEntry {
  file: string;
  added: number | null;
  removed: number | null;
  binary: boolean;
}

/**
 * `git diff --numstat <rev>`：每个改动文件一行 `added<TAB>removed<TAB>file`，
 * 二进制文件是 `-<TAB>-<TAB>file`（added/removed 记 null，binary=true，不假装是 0）。
 * rev 默认 HEAD（工作区 + 暂存区 vs HEAD）。
 */
export async function diffNumstat(root: string, rev = 'HEAD'): Promise<NumstatEntry[] | null> {
  if (!isValidRev(rev)) return null;
  const out = await git(root, ['diff', '--numstat', rev.trim()]);
  if (out === null) return null;
  return parseNumstat(out);
}

function parseNumstat(out: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '').trimEnd();
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [rawAdded, rawRemoved] = parts;
    const file = numstatPath(parts.slice(2).join('\t'));
    if (!file) continue;
    if (rawAdded === '-' || rawRemoved === '-') {
      entries.push({ file, added: null, removed: null, binary: true });
      continue;
    }
    const added = Number(rawAdded);
    const removed = Number(rawRemoved);
    if (!Number.isFinite(added) || !Number.isFinite(removed)) continue;
    entries.push({ file, added, removed, binary: false });
  }
  return entries;
}

/** rename / copy 的 `{old => new}` / `old => new` / `"old path"` 形态统一取新路径。 */
function numstatPath(raw: string): string {
  let file = raw.trim();
  if (!file) return '';
  const brace = file.match(/\{([^{}]*) => ([^{}]*)\}/);
  if (brace) file = file.replace(brace[0], brace[2]);
  else if (file.includes(' => ')) file = file.slice(file.lastIndexOf(' => ') + 4);
  return file.replace(/\\/g, '/').replace(/^"|"$/g, '');
}

// ---------------------------------------------------------------- diff 正文

/**
 * `git diff --unified=3 <rev> -- <path>`：原始 diff 文本，不解析（交给前端展示）。
 * 无差异返回空串（这是确定的事实）；不可用返回 null。
 */
export async function fileDiff(root: string, relPath: string, rev = 'HEAD'): Promise<string | null> {
  if (!isValidRev(rev)) return null;
  const rel = insideRel(root, relPath);
  if (!rel) return null;
  return git(root, ['diff', '--unified=3', rev.trim(), '--', rel]);
}

// ---------------------------------------------------------------- blame

/** blame 一行：提交元信息 + 该行作者时间。 */
export interface BlameEntry {
  /** 当前文件里的 1-based 行号。 */
  line: number;
  /** 提交 sha（完整 40 位；未提交行是全 0）。 */
  rev: string;
  author: string;
  email: string;
  /** 作者时间（毫秒）。 */
  at: number;
  summary: string;
}

/**
 * `git blame --line-porcelain -- <path>`：逐行解析。
 * 文件过大（> BLAME_MAX_LINES 行 / > 8MB）直接返回 null —— 端点层据此给 truncated 说明。
 */
export async function blame(root: string, relPath: string): Promise<BlameEntry[] | null> {
  const rel = insideRel(root, relPath);
  if (!rel) return null;
  const abs = path.resolve(root, rel);
  let lineCount = 0;
  try {
    const st = await fsp.stat(abs);
    if (!st.isFile() || st.size > BLAME_MAX_BYTES) return null;
    const text = await fsp.readFile(abs, 'utf8');
    lineCount = text.split('\n').length;
  } catch {
    return null;
  }
  if (lineCount > BLAME_MAX_LINES) return null;
  const out = await git(root, ['blame', '--line-porcelain', '--', rel]);
  if (out === null) return null;
  return parseBlame(out);
}

function parseBlame(out: string): BlameEntry[] {
  const entries: BlameEntry[] = [];
  let rev = '';
  let author = '';
  let email = '';
  let at = 0;
  let summary = '';
  let lineNo = 0;
  for (const raw of out.split('\n')) {
    // 代码正文行以 TAB 起头：它就是上一段元信息对应的那一行
    if (raw.startsWith('\t')) {
      if (lineNo > 0) entries.push({ line: lineNo, rev, author, email, at, summary });
      continue;
    }
    const head = raw.match(/^([0-9a-f]{7,40}) \d+ (\d+)(?: \d+)?$/);
    if (head) {
      rev = head[1];
      lineNo = Number(head[2]);
      author = '';
      email = '';
      at = 0;
      summary = '';
      continue;
    }
    const sp = raw.indexOf(' ');
    if (sp <= 0) continue;
    const key = raw.slice(0, sp);
    const value = raw.slice(sp + 1);
    if (key === 'author') author = value;
    else if (key === 'author-mail') email = value.replace(/^</, '').replace(/>$/, '');
    else if (key === 'author-time') {
      const sec = Number(value);
      at = Number.isFinite(sec) ? sec * 1000 : 0;
    } else if (key === 'summary') summary = value;
  }
  return entries;
}

// ---------------------------------------------------------------- 文件历史

/** 文件历史的一项：一次提交 + 它对（跟随重命名后的）该文件的改动。 */
export interface FileHistoryCommit {
  rev: string;
  at: number;
  author: string;
  summary: string;
  changes: Array<{ status: 'M' | 'A' | 'D' | 'R'; path: string }>;
}

/**
 * `git log --follow -n<limit> --date-order --pretty=format:%H\x02%ct\x02%an\x02%s --name-status -- <path>`。
 * `--follow` 需要单个路径，因此只查一个文件；limit 钳制在 1..200。
 */
export async function fileHistory(
  root: string,
  relPath: string,
  limit = 20,
): Promise<FileHistoryCommit[] | null> {
  const rel = insideRel(root, relPath);
  if (!rel) return null;
  const n = clampInt(limit, 1, 200, 20);
  const out = await git(root, [
    'log',
    '--follow',
    `-n${n}`,
    '--date-order',
    '--pretty=format:%H\x02%ct\x02%an\x02%s',
    '--name-status',
    '--',
    rel,
  ]);
  if (out === null) return null;
  return parseHistoryLog(out);
}

function parseHistoryLog(out: string): FileHistoryCommit[] {
  const commits: FileHistoryCommit[] = [];
  let cur: FileHistoryCommit | null = null;
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    const head = line.match(/^([0-9a-f]{7,40})\x02(\d+)\x02([^\x02]*)\x02(.*)$/);
    if (head) {
      const at = Number(head[2]) * 1000;
      cur = Number.isFinite(at)
        ? { rev: head[1], at, author: head[3], summary: head[4], changes: [] }
        : null;
      if (cur) commits.push(cur);
      continue;
    }
    if (!cur) continue;
    const cells = line.split('\t');
    const code = (cells[0] ?? '').charAt(0).toUpperCase();
    // 只认 M/A/D/R 四种；copy（C）产生的是新路径，按 A 记；其余（T/U/X）如实跳过
    if (code !== 'M' && code !== 'A' && code !== 'D' && code !== 'R' && code !== 'C') continue;
    const status: 'M' | 'A' | 'D' | 'R' = code === 'R' ? 'R' : code === 'C' ? 'A' : (code as 'M' | 'A' | 'D');
    const target = status === 'R' ? cells[2] : cells[1];
    if (!target) continue;
    cur.changes.push({ status, path: target.replace(/\\/g, '/') });
  }
  return commits;
}

// ---------------------------------------------------------------- 历史版本正文

/**
 * `git show <rev>:<path>`：某个历史版本的文件正文（只读快照，不落盘到项目目录）。
 * rev 与 path 都先过校验；任何一步不合法 / 拿不到都返回 null。
 */
export async function showFile(root: string, rev: string, relPath: string): Promise<string | null> {
  if (!isValidRev(rev)) return null;
  const rel = insideRel(root, relPath);
  if (!rel) return null;
  return git(root, ['show', `${rev.trim()}:${rel}`]);
}
