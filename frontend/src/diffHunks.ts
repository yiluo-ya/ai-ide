/**
 * 结构化 diff：把后端 `file-diff` 返回的原始 unified diff 文本解析成 hunk 列表，
 * 供 DiffPanel 做「第 k / 共 n 处变更」计数与上一处/下一处跳转。
 *
 * 为什么单独放一个纯模块：解析要能被单测钉住（见 diffHunks.test.ts），
 * 而 DiffPanel 是浮层组件，测它得连带拉起 React / css / api，成本不成比例。
 * 这里只做「读」——不生成 diff、不应用 diff，与面板的只读承诺一致。
 */

/** 一个 hunk（一段连续的变更上下文）。行号口径与 unified diff 一致（1 基）。 */
export interface DiffHunk {
  /** 旧文件起始行。 */
  oldStart: number;
  /** 旧文件行数（`@@ -1 +1 @@` 这类省略行数按 1 处理）。 */
  oldLines: number;
  /** 新文件起始行。 */
  newStart: number;
  /** 新文件行数（同上，省略按 1）。 */
  newLines: number;
  /**
   * 该 hunk 在 diff 文本里的行区间 `[startLine, endLine)`（按 `\n` 切分后的行下标）。
   * startLine 指向 `@@` 行头；endLine 指向下一个 hunk 行头 / 文件头，或文本末尾。
   * 面板用它滚动定位并给整段行加高亮。
   */
  startLine: number;
  endLine: number;
}

/** `@@ -a,b +c,d @@`：行数可省略（省略 = 1），也允许显式 0（如新增文件的 `-0,0`）。 */
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function toCount(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 1;
}

/**
 * 文件头判定：`--- ` 后面紧跟 `+++ ` 才算一对。
 * 为什么要成对判断：hunk 内容里删掉的那一行若恰好是 `--…`，其文本会以 `---` 开头，
 * 但下一行不可能是 `+++ ` 文件头，成对判定就不会把 hunk 内部行误当成文件边界。
 */
function isFileHeader(lines: string[], i: number): boolean {
  return /^--- /.test(lines[i]) && /^\+\+\+ /.test(lines[i + 1] ?? '');
}

/**
 * 解析 unified diff 文本中的 hunk。
 *
 * - 只认 `@@ … @@` 行头，文件头 `---`/`+++` 仅用于给 hunk 收边（不产出条目）；
 * - 空文本 / 没有 hunk 的文本（例如只有文件头）返回空列表；
 * - 被后端截断的 diff（末尾停在半个 hunk）照样返回已识别到的 hunk。
 */
export function parseDiffHunks(diff: string | null | undefined): DiffHunk[] {
  if (!diff) return [];
  const lines = diff.split('\n');
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;

  for (let i = 0; i < lines.length; i++) {
    const m = HUNK_RE.exec(lines[i]);
    if (m) {
      if (cur) {
        cur.endLine = i;
        hunks.push(cur);
      }
      cur = {
        oldStart: Number(m[1]),
        oldLines: toCount(m[2]),
        newStart: Number(m[3]),
        newLines: toCount(m[4]),
        startLine: i,
        endLine: lines.length,
      };
      continue;
    }
    // 文件头 = 上一个 hunk 的结束（多文件 diff 时下一段 hunk 属于另一个文件）
    if (cur && isFileHeader(lines, i)) {
      cur.endLine = i;
      hunks.push(cur);
      cur = null;
    }
  }
  if (cur) hunks.push(cur);
  return hunks;
}

/**
 * 计算上一处 / 下一处跳转后的下标，到边界即停（不环绕、不越界）。
 *
 * @param current 当前下标；`-1` 表示尚未定位到任何 hunk
 * @param total   hunk 总数；0 时返回 -1（没有可跳的地方）
 * @param delta   `+1` 下一处 / `-1` 上一处
 */
export function stepHunk(current: number, total: number, delta: number): number {
  if (total <= 0) return -1;
  // 尚未定位时：下一处落到第一处；上一处也落到第一处（边界处停在原地）
  const base = current < 0 ? (delta > 0 ? -1 : 0) : current;
  return Math.min(total - 1, Math.max(0, base + delta));
}
