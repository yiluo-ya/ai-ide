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

// ---------------------------------------------------------------- 工作区状态（2026-10-03）

/** 归一化后的改动状态：只保留人能直接理解的五种。 */
export type WorktreeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'conflicted';

export interface WorktreeEntry {
  file: string;
  status: WorktreeStatus;
  /** 重命名 / 复制时的原路径。 */
  from?: string;
}

export interface WorktreeChanges {
  isRepo: boolean;
  branch: string | null;
  entries: WorktreeEntry[];
}

/**
 * 两个状态字符 → 一种人话状态（顺序即优先级：冲突 > 重命名 > 新增 / 删除 > 修改）。
 *
 * 未跟踪（`??`）按**新增**报（2026-10-03 用户要求）：没被 add 过的新文件本来就是「新增」，
 * 再单列一种「未跟踪」只多一层噪音。被 `.gitignore` 忽略的文件根本不会出现在 status 里
 * （见 `worktreeChanges`），所以不必再区分「被忽略」与「未跟踪」。
 */
function classifyStatus(x: string, y: string): WorktreeStatus {
  if (x === '?' || y === '?') return 'added';
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'conflicted';
  if (x === 'R' || y === 'R' || x === 'C' || y === 'C') return 'renamed';
  if (x === 'A' || y === 'A') return 'added';
  if (x === 'D' || y === 'D') return 'deleted';
  return 'modified';
}

/** git 对含特殊字符的路径会加引号并转义；这里还原成可用的相对路径。 */
function unquotePath(raw: string): string {
  const s = raw.trim();
  if (!s.startsWith('"') || !s.endsWith('"')) return s;
  return s.slice(1, -1).replace(/\\(.)/g, '$1');
}

/**
 * `git status --porcelain -uall`：工作区（含未跟踪文件）相对 HEAD 的改动清单。
 *
 * 2026-10-03 用户要求「变更以 git 为基础，不自己记录变更」—— 这份清单就是变更面板的唯一来源：
 * git 说改了才算改了，不再让阅读器自己存快照去比对。非 git 仓库 / 没装 git 一律 isRepo=false。
 *
 * 命令里**没有** `--ignored`：被 `.gitignore` 忽略的文件压根不出现在输出里，也就不会进变更清单
 * （2026-10-03 用户要求「在 ignore 就直接忽略，不显示」）；剩下的未跟踪文件是真正的新增，按 added 报。
 */
export async function worktreeChanges(root: string): Promise<WorktreeChanges> {
  const statusOut = await git(root, ['status', '--porcelain', '-uall']);
  if (statusOut === null) return { isRepo: false, branch: null, entries: [] };
  const branchOut = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const entries: WorktreeEntry[] = [];
  for (const line of statusOut.split('\n')) {
    if (line.trim().length < 4) continue;
    const x = line[0];
    const y = line[1];
    let rest = line.slice(3);
    let from: string | undefined;
    if (x === 'R' || x === 'C') {
      const parts = rest.split(' -> ');
      if (parts.length === 2) {
        from = unquotePath(parts[0]);
        rest = parts[1];
      }
    }
    entries.push({ file: unquotePath(rest), status: classifyStatus(x, y), ...(from ? { from } : {}) });
  }
  return { isRepo: true, branch: branchOut?.trim() || null, entries };
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

// ---------------------------------------------------------------- 仓库级提交历史（2026-10-09）

/**
 * 仓库级提交历史的一项（SCM 面板「commits」视图用）。
 * 与 fileHistory 不同：不 `--follow`、不限单文件，是 `git log` 全仓库最近的提交。
 */
export interface RepoLogEntry {
  /** 完整 40 位 sha。 */
  rev: string;
  /** 短 sha（git 的 %h，通常 7 位）。 */
  shortRev: string;
  /** 提交时间（毫秒）。 */
  at: number;
  author: string;
  summary: string;
  /** 父提交 sha（graph 泳道用；根提交为空数组）。 */
  parentIds: string[];
  /** 挂在这条提交上的分支 / 标签（列表视图的 ref 徽章）。 */
  refs: GitRefName[];
}

/**
 * `git log -n<limit> --date-order --pretty=format:%H\x02%h\x02%P\x02%ct\x02%an\x02%s`：
 * 仓库最近 limit 条提交，一行一条；再用 `for-each-ref` 给每条提交挂 ref 徽章。
 * limit 钳制在 1..200。只读，失败（非 git 仓库 / 没装 git）返回 null。
 */
export async function repoLog(root: string, limit = 200): Promise<RepoLogEntry[] | null> {
  const n = clampInt(limit, 1, 200, 200);
  const out = await git(root, [
    'log',
    `-n${n}`,
    '--date-order',
    '--pretty=format:%H\x02%h\x02%P\x02%ct\x02%an\x02%s',
  ]);
  if (out === null) return null;
  const refs = await refMap(root);
  return parseRepoLog(out, refs ?? new Map());
}

function parseRepoLog(out: string, refs: Map<string, GitRefName[]>): RepoLogEntry[] {
  const entries: RepoLogEntry[] = [];
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    // %H \x02 %h \x02 %P \x02 %ct \x02 %an \x02 %s
    const m = line.match(/^([0-9a-f]{7,40})\x02([0-9a-f]+)\x02([0-9a-f ]*)\x02(\d+)\x02([^\x02]*)\x02(.*)$/);
    if (!m) continue;
    const at = Number(m[4]) * 1000;
    if (!Number.isFinite(at)) continue;
    const parentIds = m[3].trim() ? m[3].trim().split(/ +/) : [];
    entries.push({
      rev: m[1],
      shortRev: m[2],
      at,
      author: m[5],
      summary: m[6],
      parentIds,
      refs: refs.get(m[1]) ?? [],
    });
  }
  return entries;
}

// ---------------------------------------------------------------- 引用（ref / branch / tag）

/** 一个 git 引用（分支 / 标签 / 远程分支）。 */
export interface GitRefName {
  name: string;
  type: 'branch' | 'tag' | 'remote';
  /** 是否是当前 HEAD 指向的引用。 */
  isHead: boolean;
}

/** refname（refs/heads/main、refs/tags/v1、refs/remotes/origin/main）→ 展示名与类型。 */
function parseRefName(refname: string): { name: string; type: GitRefName['type'] } | null {
  const r = refname.trim();
  if (r.startsWith('refs/heads/')) return { name: r.slice('refs/heads/'.length), type: 'branch' };
  if (r.startsWith('refs/tags/')) return { name: r.slice('refs/tags/'.length), type: 'tag' };
  if (r.startsWith('refs/remotes/')) return { name: r.slice('refs/remotes/'.length), type: 'remote' };
  return null;
}

/** 提交 sha → 挂在其上的引用清单（含是否 HEAD）。非 git / 没装 git 返回 null。 */
async function refMap(root: string): Promise<Map<string, GitRefName[]> | null> {
  const out = await git(root, ['for-each-ref', '--format=%(objectname)\x02%(refname)']);
  if (out === null) return null;
  const headBranch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() ?? '';
  const byCommit = new Map<string, GitRefName[]>();
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    const sep = line.indexOf('\x02');
    if (sep <= 0) continue;
    const commit = line.slice(0, sep).trim();
    const parsed = parseRefName(line.slice(sep + 1));
    if (!commit || !parsed) continue;
    const isHead = parsed.type === 'branch' && parsed.name === headBranch;
    const list = byCommit.get(commit) ?? [];
    list.push({ name: parsed.name, type: parsed.type, isHead });
    byCommit.set(commit, list);
  }
  return byCommit;
}

/** 仓库的所有引用（分支 / 标签 / 远程），供「按 ref 筛选」下拉与 ref 徽章用。 */
export async function listRefs(
  root: string,
): Promise<{ refs: Array<GitRefName & { commit: string }>; headBranch: string | null } | null> {
  const out = await git(root, ['for-each-ref', '--format=%(objectname)\x02%(refname)']);
  if (out === null) return null;
  const headBranch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() || null;
  const refs: Array<GitRefName & { commit: string }> = [];
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    const sep = line.indexOf('\x02');
    if (sep <= 0) continue;
    const commit = line.slice(0, sep).trim();
    const parsed = parseRefName(line.slice(sep + 1));
    if (!commit || !parsed) continue;
    refs.push({ ...parsed, commit, isHead: parsed.type === 'branch' && parsed.name === headBranch });
  }
  return { refs, headBranch };
}

// ---------------------------------------------------------------- 单提交改动 / 详情

/** 单条提交改动的一个文件（展开提交看 change list 用）。 */
export interface CommitChange {
  status: 'M' | 'A' | 'D' | 'R';
  path: string;
  from?: string;
  added: number | null;
  removed: number | null;
  binary: boolean;
}

/**
 * 某条提交改动的文件清单（含状态 + 增删行）。
 * 用 `git diff-tree -r <rev>` 分别拿 name-status 与 numstat —— 两者对同一提交输出的文件顺序一致，
 * 按序号配对即可拿到每个文件的 `status/path/from + added/removed/binary`。
 * rev 先过白名单；失败返回 null。
 */
export async function commitChanges(root: string, rev: string): Promise<CommitChange[] | null> {
  if (!isValidRev(rev)) return null;
  const nameOut = await git(root, ['diff-tree', '--no-commit-id', '--name-status', '-r', rev.trim()]);
  if (nameOut === null) return null;
  const numOut = await git(root, ['diff-tree', '--no-commit-id', '--numstat', '-r', rev.trim()]);
  return parseCommitChanges(nameOut, numOut ?? '');
}

function parseCommitChanges(nameOut: string, numOut: string): CommitChange[] {
  const names = nameOut.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean);
  const nums = numOut.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean);
  const result: CommitChange[] = [];
  for (let i = 0; i < names.length; i++) {
    const cells = names[i].split('\t');
    const code = (cells[0] ?? '').charAt(0).toUpperCase();
    if (code !== 'M' && code !== 'A' && code !== 'D' && code !== 'R' && code !== 'C') continue;
    const status: 'M' | 'A' | 'D' | 'R' = code === 'R' ? 'R' : code === 'C' ? 'A' : (code as 'M' | 'A' | 'D');
    const from = status === 'R' ? (cells[1] ?? undefined) : undefined;
    const target = status === 'R' ? cells[2] : cells[1];
    if (!target) continue;
    // numstat 同序号行：`added\tremoved\tfile`（二进制为 `-\t-\tfile`）
    const numCells = (nums[i] ?? '').split('\t');
    let added: number | null = null;
    let removed: number | null = null;
    let binary = false;
    if (numCells.length >= 2) {
      if (numCells[0] === '-' || numCells[1] === '-') binary = true;
      else {
        const a = Number(numCells[0]);
        const r = Number(numCells[1]);
        if (Number.isFinite(a) && Number.isFinite(r)) {
          added = a;
          removed = r;
        }
      }
    }
    result.push({ status, path: target.replace(/\\/g, '/'), ...(from ? { from } : {}), added, removed, binary });
  }
  return result;
}

/**
 * `git show -s --format=...`：单条提交的详情（message 全文 + 作者 + 邮箱 + 父提交 + stats）。
 * 只读；rev 非法 / 不存在返回 null。
 */
export async function commitInfo(root: string, rev: string): Promise<{
  rev: string;
  shortRev: string;
  at: number;
  author: string;
  email: string;
  summary: string;
  body: string;
  parentIds: string[];
  refs: GitRefName[];
  stats: { files: number; added: number | null; removed: number | null };
} | null> {
  if (!isValidRev(rev)) return null;
  // %s = subject（单行）、%b = body（多行，放最后）；\x02 分格，message 里理论上不含 \x02
  const out = await git(root, [
    'show',
    '-s',
    '--format=%H\x02%h\x02%P\x02%ct\x02%an\x02%ae\x02%s\x02%b',
    rev.trim(),
  ]);
  if (out === null || !out.trim()) return null;
  // `git diff-tree --shortstat -r`：只给这棵树的增删统计，不带 diff 正文
  const shortOut = await git(root, ['diff-tree', '--shortstat', '--no-commit-id', '-r', rev.trim()]);
  const refs = await refMap(root);

  // subject 是一行，body 从第一个换行起；把第一行用 \x02 切出前七段 + body 第一行，body 剩余行从换行后取。
  const nl = out.indexOf('\n');
  const headLine = (nl >= 0 ? out.slice(0, nl) : out).replace(/\r$/, '');
  const restBody = nl >= 0 ? out.slice(nl + 1) : '';
  // 切成 7+ 段：rev/sh/par/ct/an/ae/s/body第一行（%s\x02%b 里 %b 的首行与 subject 同在一行，用 \x02 隔开）
  const seg = headLine.split('\x02');
  if (seg.length < 7) return null;
  const revOut = seg[0];
  const shortRev = seg[1];
  const parentIds = seg[2].trim() ? seg[2].trim().split(/ +/) : [];
  const at = Number(seg[3]) * 1000;
  const author = seg[4];
  const email = seg[5];
  const summary = seg[6];
  // body 第一行 = seg[7..]（subject 不跨 \x02，body 首行其后），再接第二行起的剩余行；去掉多余空行。
  const bodyFirst = seg.slice(7).join('\x02').trim();
  const body = [bodyFirst, restBody].filter((s) => s.trim()).join('\n').trim();
  const stats = parseShortstat(shortOut);
  return {
    rev: revOut,
    shortRev,
    at: Number.isFinite(at) ? at : 0,
    author,
    email,
    summary,
    body,
    parentIds,
    refs: refs?.get(revOut) ?? [],
    stats,
  };
}

/** 从 `git show --shortstat` 输出解析 `N files changed, X insertions(+), Y deletions(-)`。 */
function parseShortstat(out: string | null): { files: number; added: number | null; removed: number | null } {
  if (!out) return { files: 0, added: null, removed: null };
  const files = out.match(/(\d+) files? changed/);
  const added = out.match(/(\d+) insertions?/);
  const removed = out.match(/(\d+) deletions?/);
  return {
    files: files ? Number(files[1]) : 0,
    added: added ? Number(added[1]) : null,
    removed: removed ? Number(removed[1]) : null,
  };
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

/**
 * `git diff <base> <rev> -- <path>`：两个提交之间某个文件的差异文本（commits 视图点文件看 diff 用）。
 * 通常 base = rev 的父提交。rev / base / path 都先过校验；不可用返回 null。
 */
export async function commitFileDiff(
  root: string,
  base: string,
  rev: string,
  relPath: string,
): Promise<string | null> {
  if (!isValidRev(base) || !isValidRev(rev)) return null;
  const rel = insideRel(root, relPath);
  if (!rel) return null;
  return git(root, ['diff', '--unified=3', base.trim(), rev.trim(), '--', rel]);
}
