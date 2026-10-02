/**
 * 向导（04 Guide · W2）的笔记存储与锚定（G4.1–G4.4 / Q9）。
 *
 * 存储口径与 `guide.ts` 同源（`04-guide-plan.md` §4）：全部落浏览器 localStorage、
 * 按项目 id 分片、不写被读目录、不落后端；所有读写包 try/catch，隐私模式静默降级。
 *
 * 为什么除了行号还存一份 `anchor`（该行文本快照）：代码在动是本产品的前提
 * （`04-guide.md:15`），笔记若只绑行号，上面插一行就全体错位 —— 而错位的笔记
 * 比没有笔记更糟，它会让人相信一句贴错位置的判断（`04-decisions.md` Q9）。
 * 恢复走三层兜底：① 行号命中且 anchor 匹配 → 直接用；② anchor 不匹配 → 在该行
 * ±30 行内搜同一 anchor；③ 仍找不到 → 进 `orphans`（待归位），不猜位置、不静默丢弃。
 *
 * 本模块是纯存储 + 纯函数，不依赖 React（与 `annotations.ts` 同风格）。
 */

/** 一条笔记：行级（贴在某一行的行槽上）或文件级（一个文件的整体印象）。 */
export interface Note {
  id: string;
  /** 相对项目根的 POSIX 路径。 */
  file: string;
  /** 1-based；`level === 'file'` 时为 0。 */
  line: number;
  /** 1-based；`level === 'file'` 时为 0。 */
  col: number;
  /** 写笔记那一刻该行的文本快照（去首尾空白，截前 120 字符）。 */
  anchor: string;
  body: string;
  level: NoteLevel;
  createdAt: number;
  updatedAt: number;
}

export type NoteLevel = 'line' | 'file';

/** anchor 取多少个字符（`04-decisions.md` Q9）。 */
export const ANCHOR_MAX = 120;

/** anchor 失配时在上下多少行内找（Q9 的 ±30）。 */
export const ANCHOR_SEARCH_RANGE = 30;

/** 恢复出位置的一条笔记：多带一个「实际落在哪一行」和「是否挪过位」。 */
export interface ResolvedNote extends Note {
  /** 1-based；`level === 'file'` 时为 0（文件级笔记不参与行定位）。 */
  resolvedLine: number;
  /** 行号与记录不一致，位置是靠 anchor 搜回来的。 */
  moved: boolean;
}

export interface ResolveResult {
  /** 能定位的笔记（行级已落到 `resolvedLine`，文件级原样通过）。 */
  located: ResolvedNote[];
  /** 找不到原位置的行级笔记（待归位）—— 不猜、不丢。 */
  orphans: Note[];
}

/** 新建一条笔记时需要的字段（anchor 由调用方用 `anchorOf` 从正文算好）。 */
export interface NewNote {
  file: string;
  line: number;
  col: number;
  anchor: string;
  body: string;
  level?: NoteLevel;
}

const notesKey = (projectId: string): string => `wcr:notes:${projectId}`;

// ------------------------------------------------------------------ localStorage

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
    /* 隐私模式 / 配额满：不因为记不住笔记而打断阅读 */
  }
}

/** 把任意值收成一条合法笔记；收不成返回 null（坏数据不当笔记用）。 */
function normalize(raw: unknown): Note | null {
  if (!raw || typeof raw !== 'object') return null;
  const it = raw as Partial<Note>;
  if (typeof it.file !== 'string' || !it.file || typeof it.body !== 'string') return null;
  const level: NoteLevel = it.level === 'file' ? 'file' : 'line';
  const line = typeof it.line === 'number' && it.line > 0 ? Math.floor(it.line) : 0;
  const col = typeof it.col === 'number' && it.col > 0 ? Math.floor(it.col) : 0;
  const at = typeof it.createdAt === 'number' ? it.createdAt : 0;
  return {
    id: typeof it.id === 'string' && it.id ? it.id : newNoteId(),
    file: it.file,
    // 文件级笔记没有行：即使存量数据带了行号也归零，口径只有一个
    line: level === 'file' ? 0 : line,
    col: level === 'file' ? 0 : col,
    anchor: typeof it.anchor === 'string' ? it.anchor.slice(0, ANCHOR_MAX) : '',
    body: it.body,
    level,
    createdAt: at,
    updatedAt: typeof it.updatedAt === 'number' ? it.updatedAt : at,
  };
}

/** 新笔记 id：时间戳 + 随机后缀（同毫秒连续添加也不会撞）。 */
export function newNoteId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// ------------------------------------------------------------------ 读写

/**
 * 读某项目的全部笔记（坏数据一律跳过，不让一条脏记录卡住整个面板）。
 * 返回顺序固定为「文件 → 文件级在前 → 行号升序」，与面板 / 导出的展示顺序一致。
 */
export function readNotes(projectId: string): Note[] {
  const raw = readJson(notesKey(projectId));
  if (!Array.isArray(raw)) return [];
  const out: Note[] = [];
  for (const item of raw) {
    const note = normalize(item);
    if (note) out.push(note);
  }
  return sortNotes(out);
}

/** 语义与 `readNotes` 相同（同一实现的命名别名：给「取某项目全部笔记」的调用点用）。 */
export function loadNotes(projectId: string): Note[] {
  return readNotes(projectId);
}

/** 写回全部笔记；写成功通知订阅者（同页内的其它组件据此刷新）。 */
export function saveNotes(projectId: string, notes: Note[]): void {
  writeJson(notesKey(projectId), sortNotes(notes));
  notify(projectId);
}

/** 按「文件 → 文件级在前 → 行号升序 → 创建时间」排序。 */
function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      (a.level === b.level ? 0 : a.level === 'file' ? -1 : 1) ||
      a.line - b.line ||
      a.createdAt - b.createdAt,
  );
}

type NotesListener = (projectId: string) => void;
const listeners = new Set<NotesListener>();

/** 订阅笔记变化（本页内）；返回取消函数。 */
export function subscribeNotes(cb: NotesListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function notify(projectId: string): void {
  for (const cb of listeners) cb(projectId);
}

// ------------------------------------------------------------------ 增删改查

/** 新增一条笔记并落盘（返回落盘后的那条）。 */
export function addNote(projectId: string, input: NewNote): Note {
  const now = Date.now();
  const level: NoteLevel = input.level === 'file' ? 'file' : 'line';
  const note: Note = {
    id: newNoteId(),
    file: input.file,
    line: level === 'file' ? 0 : input.line,
    col: level === 'file' ? 0 : input.col,
    anchor: level === 'file' ? '' : input.anchor.slice(0, ANCHOR_MAX),
    body: input.body,
    level,
    createdAt: now,
    updatedAt: now,
  };
  saveNotes(projectId, [...readNotes(projectId), note]);
  return note;
}

/** 改正文（只改正文：位置变了就是另一条笔记，不做隐式搬移）。 */
export function updateNote(projectId: string, id: string, body: string): Note | null {
  const notes = readNotes(projectId);
  const i = notes.findIndex((n) => n.id === id);
  if (i < 0) return null;
  const next: Note = { ...notes[i], body, updatedAt: Date.now() };
  notes[i] = next;
  saveNotes(projectId, notes);
  return next;
}

export function removeNote(projectId: string, id: string): boolean {
  const notes = readNotes(projectId);
  const next = notes.filter((n) => n.id !== id);
  if (next.length === notes.length) return false;
  saveNotes(projectId, next);
  return true;
}

/** 取某项目的笔记；给了 `file` 就只取这个文件的。 */
export function notesOf(projectId: string, file?: string): Note[] {
  const all = loadNotes(projectId);
  return file ? all.filter((n) => n.file === file) : all;
}

/** 文件树 / 列表上的计数用：file → 条数（含文件级）。 */
export function noteCountByFile(projectId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const note of loadNotes(projectId)) counts[note.file] = (counts[note.file] ?? 0) + 1;
  return counts;
}

// ------------------------------------------------------------------ 锚定

/** 行文本 → anchor（去首尾空白，截前 `ANCHOR_MAX` 字符）。 */
export function anchorOfRow(text: string): string {
  return text.trim().slice(0, ANCHOR_MAX);
}

/** 取 `text` 的第 `line` 行（1-based）的 anchor；越界返回空串。 */
export function anchorOf(text: string, line: number): string {
  const rows = text.split('\n');
  return anchorOfRow(rows[line - 1] ?? '');
}

/**
 * 三层兜底恢复（Q9）：
 * ① 行号命中且该行 anchor 一致 → 直接用（`moved: false`）；
 * ② anchor 不一致 → 在该行 ±`ANCHOR_SEARCH_RANGE` 行内搜同一 anchor，取最近的一行；
 * ③ 搜不到（含 anchor 为空、或整段被改写） → 归入 `orphans`，交给「待归位」。
 *
 * 空 anchor 只在第 ① 层生效：空白行到处长得一样，拿它去 ±30 行里搜出来的位置
 * 是猜的，不如老实进待归位。
 */
export function resolveNotes(notes: Note[], fileText: string): ResolveResult {
  const rows = fileText.split('\n');
  const located: ResolvedNote[] = [];
  const orphans: Note[] = [];
  for (const note of notes) {
    if (note.level === 'file') {
      located.push({ ...note, resolvedLine: 0, moved: false });
      continue;
    }
    const idx = note.line - 1;
    if (idx >= 0 && idx < rows.length && anchorOfRow(rows[idx]) === note.anchor) {
      located.push({ ...note, resolvedLine: note.line, moved: false });
      continue;
    }
    if (note.anchor) {
      const from = Math.max(0, idx - ANCHOR_SEARCH_RANGE);
      const to = Math.min(rows.length - 1, idx + ANCHOR_SEARCH_RANGE);
      let best = -1;
      for (let i = from; i <= to; i += 1) {
        if (anchorOfRow(rows[i]) !== note.anchor) continue;
        if (best < 0 || Math.abs(i - idx) < Math.abs(best - idx)) best = i;
      }
      if (best >= 0) {
        located.push({ ...note, resolvedLine: best + 1, moved: true });
        continue;
      }
    }
    orphans.push(note);
  }
  return { located, orphans };
}

// ------------------------------------------------------------------ 导出 / 导入

/** 一条笔记的一行文本：`path:line — 正文`（文件级不带行号）。 */
export function noteLine(note: Note): string {
  return note.level === 'file' ? `- ${note.file} — ${note.body}` : `- ${note.file}:${note.line} — ${note.body}`;
}

/** 导出 Markdown（G4.4）：按文件分组，位置写全 `path:line`，可以直接贴进周报。 */
export function exportMarkdown(notes: Note[], projectName: string): string {
  const out: string[] = [`# 阅读笔记 · ${projectName}`, ''];
  if (notes.length === 0) {
    out.push('（没有笔记）');
    return `${out.join('\n')}\n`;
  }
  out.push(`共 ${notes.length} 条 · 导出于 ${new Date().toLocaleString()}`);
  out.push('');
  const byFile = new Map<string, Note[]>();
  for (const note of sortNotes(notes)) {
    const bucket = byFile.get(note.file);
    if (bucket) bucket.push(note);
    else byFile.set(note.file, [note]);
  }
  for (const [file, list] of byFile) {
    out.push(`## ${file}`, '');
    for (const note of list) out.push(noteLine(note));
    out.push('');
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

/** 导出 JSON（G4.4 / Q3）：整包带走，换浏览器也能导回来。 */
export function exportJson(projectId: string): string {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    notes: loadNotes(projectId),
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * 导入 JSON（合并去重）：接受 `{notes: [...]}` 与裸数组两种形状。
 * 去重先看 `id`，再看 `file + line`（文件级看 file）—— 同一条笔记在两个浏览器里
 * 各写一遍不会变成两条。返回**新增**条数；JSON 坏掉时抛错（调用方负责提示）。
 */
export function importJson(projectId: string, json: string): number {
  const parsed = JSON.parse(json) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { notes?: unknown })?.notes)
      ? ((parsed as { notes: unknown[] }).notes)
      : null;
  if (!list) throw new Error('not a notes export');

  const current = readNotes(projectId);
  const byId = new Set(current.map((n) => n.id));
  const bySpot = new Set(current.map((n) => spotKey(n)));
  let added = 0;
  for (const raw of list) {
    const note = normalize(raw);
    if (!note) continue;
    if (byId.has(note.id) || bySpot.has(spotKey(note))) continue;
    current.push(note);
    byId.add(note.id);
    bySpot.add(spotKey(note));
    added += 1;
  }
  if (added > 0) saveNotes(projectId, current);
  return added;
}

/** 同一条笔记的「同一位置」判定键（文件级笔记没有行号）。 */
function spotKey(note: Note): string {
  return `${note.file}\u0000${note.level === 'file' ? 'file' : note.line}`;
}
