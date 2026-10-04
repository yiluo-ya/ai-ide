/**
 * 06 报告（S4a）：把代码画成一张图 —— 不依赖本机阅读器就能贴进聊天 / issue 的截图。
 *
 * 为什么自绘而不截 DOM：Monaco 的渲染是 canvas + DOM 分层，html2canvas 那类库拿不到真实
 * 画面，还得引新依赖。这里只画「结论」：语法色 + 语义档位 + 行号 + 出处条。
 * Monaco 自带的 tokenizer 已经能给出每行 token，直接复用，不自己写词法分析。
 *
 * 取色跟界面一致：底色 / 前景抄 READER_THEME_DARK（monaco-setup.ts），语义三档读 styles.css
 * 的 CSS 变量 —— 界面调色后截图自动跟着变，读不到（非浏览器环境）才退回默认值。
 */
import { translate } from './i18n';
import { monaco, monacoLangFor } from './monaco-setup';

const FONT_STACK = "'JetBrains Mono', 'Consolas', monospace";

/** 与 READER_THEME_DARK 的 editor.* 一致（monaco-setup.ts defineReaderTheme）。 */
const BG = '#131315';
const FG = '#c3c8ce';
const GUTTER_BG = '#191919';
const GUTTER_FG = '#4b5057';
const DIVIDER = '#2a2a30';
const BAR_BG = '#1b1b1f';
const BAR_FG = '#8b9198';

/** 语义三档的兜底色（与 styles.css 的 `--hl-*` 默认值一致）。 */
const HL_FALLBACK = { project: '#ffffff', local: '#cfe2ff', external: '#9aa7b6' } as const;

/**
 * Monaco token type → VS Code Dark+ 近似色。
 * 「近似」的原因：tokenize 给的是语言无关的粗分类（comment / string / keyword…），
 * 没有语义信息；做到 VS Code 那种逐 token 精确配色既不可能也没必要。
 * 顺序敏感：前缀先匹配到谁就用谁（更具体的规则放前面）。
 */
const TOKEN_COLORS: Array<[string, string]> = [
  ['comment', '#6a9955'],
  ['string', '#ce9178'],
  ['regexp', '#d16969'],
  ['keyword.control', '#c586c0'],
  ['keyword', '#569cd6'],
  ['constant.numeric', '#b5cea8'],
  ['constant', '#4fc1ff'],
  ['entity.name.type', '#4ec9b0'],
  ['type', '#4ec9b0'],
  ['entity.name.function', '#dcdcaa'],
  ['support.function', '#dcdcaa'],
  ['entity.name.tag', '#569cd6'],
  ['attribute', '#9cdcfe'],
  ['variable', '#9cdcfe'],
  ['operator', '#d4d4d4'],
  ['delimiter', '#d4d4d4'],
];

const MAX_LINES = 400;
const MAX_WIDTH = 4000;

/** 语义档位命中区间：列 1-based，`endCol` exclusive（与 Monaco / 后端口径一致）。 */
export interface SnapshotHit {
  line: number;
  startCol: number;
  endCol: number;
  tier: 'project' | 'local' | 'external';
}

export interface SnapshotOptions {
  text: string;
  lang: string;
  /** 首行行号（截取一段代码时用，默认 1）。 */
  startLine?: number;
  highlights?: SnapshotHit[];
  /** 出处，如 `src/auth.py:42-58`。 */
  title?: string;
  /** 右侧落款，通常放项目名。 */
  subtitle?: string;
  fontSize?: number;
  /** 目前只做与 READER_THEME_DARK 一致的深色；字段留给后续浅色主题。 */
  theme?: 'dark';
}

/** 读 CSS 变量（拿不到就退回默认色：单测 / 非浏览器里没有 document）。 */
function cssVarColor(name: string, fallback: string): string {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

function tokenColor(type: string): string {
  for (const [prefix, color] of TOKEN_COLORS) {
    if (type.startsWith(prefix)) return color;
  }
  return FG;
}

function tokenColorAt(tokens: monaco.Token[] | undefined, offset: number): string {
  let type = '';
  for (const token of tokens ?? []) {
    if (token.offset <= offset) type = token.type;
    else break; // token 按 offset 升序
  }
  return tokenColor(type);
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * 画一行：按「token 边界 + 语义命中边界」切成段，逐段选色并累加 x。
 * 为什么按段画而不是先整行上色再覆盖命中段：加粗会改变字宽，覆盖式重绘必然错位。
 */
function drawCodeLine(
  ctx: CanvasRenderingContext2D,
  text: string,
  tokens: monaco.Token[] | undefined,
  hits: SnapshotHit[] | undefined,
  x: number,
  y: number,
  font: string,
  boldFont: string,
  hl: Record<SnapshotHit['tier'], string>,
): void {
  const length = text.length;
  const cuts = new Set<number>([0, length]);
  for (const token of tokens ?? []) cuts.add(Math.min(Math.max(token.offset, 0), length));
  for (const hit of hits ?? []) {
    cuts.add(Math.min(Math.max(hit.startCol - 1, 0), length));
    cuts.add(Math.min(Math.max(hit.endCol - 1, 0), length));
  }
  const points = [...cuts].sort((a, b) => a - b);
  let cursor = x;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const from = points[i];
    const to = points[i + 1];
    if (to <= from) continue;
    const hit = hits?.find((h) => h.startCol - 1 <= from && from < h.endCol - 1);
    ctx.font = hit?.tier === 'project' ? boldFont : font;
    ctx.fillStyle = hit ? hl[hit.tier] : tokenColorAt(tokens, from);
    const piece = text.slice(from, to);
    ctx.fillText(piece, cursor, y);
    cursor += ctx.measureText(piece).width;
  }
}

/**
 * S4a：把一段代码画成 canvas —— 行号栏 + 语法色 + 语义档位 + 底部出处条。
 * 返回的 canvas 可直接 toBlob 下载 / 写剪贴板（见 exportCanvasPng / copyCanvasPng）。
 */
export function renderCodeSnapshot(opts: SnapshotOptions): HTMLCanvasElement {
  const fontSize = opts.fontSize && opts.fontSize > 0 ? opts.fontSize : 13;
  const lineHeight = Math.round(fontSize * 1.55);
  const font = `${fontSize}px ${FONT_STACK}`;
  const boldFont = `600 ${fontSize}px ${FONT_STACK}`;
  const padding = fontSize;
  const gutterPad = Math.round(fontSize * 0.9);

  const allLines = splitLines(opts.text);
  const truncatedLines = allLines.length > MAX_LINES;
  const lines = truncatedLines ? allLines.slice(0, MAX_LINES) : allLines;
  const startLine = opts.startLine && opts.startLine > 0 ? opts.startLine : 1;

  // tokenize 一次给全量：截断只影响绘制哪些行，token 与行下标仍一一对齐
  const tokenLines = monaco.editor.tokenize(opts.text.replace(/\r\n?/g, '\n'), monacoLangFor(opts.lang));

  const hitsByLine = new Map<number, SnapshotHit[]>();
  for (const hit of opts.highlights ?? []) {
    if (hit.endCol <= hit.startCol) continue;
    const list = hitsByLine.get(hit.line);
    if (list) list.push(hit);
    else hitsByLine.set(hit.line, [hit]);
  }
  for (const list of hitsByLine.values()) list.sort((a, b) => a.startCol - b.startCol);

  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) throw new Error(translate('snapshot.noCanvas'));
  measure.font = font;
  const numberWidth = measure.measureText(String(startLine + Math.max(lines.length - 1, 0))).width;
  const gutterWidth = Math.ceil(padding + numberWidth + gutterPad * 2);
  let textWidth = 0;
  for (const line of lines) textWidth = Math.max(textWidth, measure.measureText(line).width);

  const contentLeft = gutterWidth + gutterPad;
  let width = Math.ceil(contentLeft + textWidth + padding);
  const truncatedWidth = width > MAX_WIDTH;
  if (truncatedWidth) width = MAX_WIDTH;

  const barText = [opts.title, truncatedLines || truncatedWidth ? translate('snapshot.truncated') : ''].filter(Boolean).join('  ');
  const hasBar = Boolean(barText || opts.subtitle);
  const barHeight = hasBar ? Math.round(lineHeight * 1.7) : 0;
  const codeTop = padding;
  const codeHeight = lines.length * lineHeight;
  const height = hasBar
    ? codeTop + codeHeight + Math.round(padding * 0.5) + barHeight
    : codeTop + codeHeight + padding;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(translate('snapshot.noCanvas'));

  const hl: Record<SnapshotHit['tier'], string> = {
    project: cssVarColor('--hl-project', HL_FALLBACK.project),
    local: cssVarColor('--hl-local', HL_FALLBACK.local),
    external: cssVarColor('--hl-external', HL_FALLBACK.external),
  };

  // 背景 + 行号栏（单独底色，和代码区一眼分开）
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = GUTTER_BG;
  ctx.fillRect(0, 0, gutterWidth, codeTop + codeHeight);
  ctx.fillStyle = DIVIDER;
  ctx.fillRect(gutterWidth - 1, 0, 1, codeTop + codeHeight);

  ctx.textBaseline = 'middle';
  ctx.font = font;
  for (let i = 0; i < lines.length; i += 1) {
    const y = codeTop + i * lineHeight + lineHeight / 2;
    ctx.fillStyle = GUTTER_FG;
    ctx.textAlign = 'right';
    ctx.fillText(String(startLine + i), gutterWidth - gutterPad, y);
    ctx.textAlign = 'left';
    drawCodeLine(ctx, lines[i], tokenLines[i], hitsByLine.get(startLine + i), contentLeft, y, font, boldFont, hl);
  }

  if (hasBar) {
    const barY = codeTop + codeHeight + Math.round(padding * 0.5);
    ctx.fillStyle = DIVIDER;
    ctx.fillRect(0, barY, width, 1);
    ctx.fillStyle = BAR_BG;
    ctx.fillRect(0, barY + 1, width, barHeight - 1);
    ctx.font = `${Math.round(fontSize * 0.85)}px ${FONT_STACK}`;
    ctx.fillStyle = BAR_FG;
    const centerY = barY + barHeight / 2;
    if (barText) {
      ctx.textAlign = 'left';
      ctx.fillText(barText, padding, centerY);
    }
    if (opts.subtitle) {
      ctx.textAlign = 'right';
      ctx.fillText(opts.subtitle, width - padding, centerY);
      ctx.textAlign = 'left';
    }
  }

  return canvas;
}

function toPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
}

/** 导出 PNG：走 `<a download>`，失败（拿不到 blob）时静默结束，由调用方决定提示。 */
export async function exportCanvasPng(canvas: HTMLCanvasElement, filename: string): Promise<void> {
  const blob = await toPngBlob(canvas);
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** 复制 PNG 到剪贴板：权限 / 浏览器不支持时返回 false（不抛）。 */
export async function copyCanvasPng(canvas: HTMLCanvasElement): Promise<boolean> {
  try {
    const blob = await toPngBlob(canvas);
    if (!blob) return false;
    const clipboard = navigator.clipboard;
    if (!clipboard?.write || typeof ClipboardItem === 'undefined') return false;
    await clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch {
    return false;
  }
}
