/**
 * Code Agent 会话内容的富文本渲染（2026-10-03 用户要求：会话内容支持 md 与 html 展示）。
 *
 * 分工：
 * - Markdown → marked 解析 + DOMPurify 清洗（禁 script / on* / javascript: / style 属性）；
 * - ```html 围栏块，以及「看起来是一份 HTML 文档 / 带样式片段」的裸 HTML 块 → 沙箱 iframe 预览
 *   （见 `RichText.tsx`，sandbox 不给 allow-scripts，agent 写的脚本不会执行）；
 * - 其余代码块 → 语言标签 + 复制按钮，不走 Markdown 解析（代码里的 `#` / `*` 不会被当标题或列表）。
 *
 * 这里只放纯函数（vitest 直接测）；React 组件在 `RichText.tsx`。
 */
import DOMPurify from 'dompurify';
import { marked, type Token, type Tokens } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

/**
 * 清洗选项。DOMPurify 默认已挡 `<script>` 与 `on*` 事件属性，这里再挡两类：
 * - 能自己加载外部内容的标签（iframe / object / link / base…）—— HTML 预览走 iframe 单独一条路；
 * - `style` 属性与 `<style>` 块 —— 可用来 position:fixed 盖住整页做钓鱼。
 */
const PURIFY = {
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'link', 'meta', 'base'],
  FORBID_ATTR: ['style'],
};

/** 正文字段里的链接一律新窗口打开：点了不清空 IDE 页面。 */
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/** 一段 Markdown → 清洗后的 HTML。 */
export function mdToHtml(text: string): string {
  return sanitizeHtml(String(marked.parse(text)));
}

/** 任意 HTML 片段 → 清洗后的 HTML（导出 HTML 时也用它，避免把 agent 输出的脚本带出去）。 */
export function sanitizeHtml(html: string): string {
  return String(DOMPurify.sanitize(html, PURIFY));
}

/**
 * 像不像「一份 HTML 文档 / 带样式的片段」。
 * 只有这种才值得用 iframe 隔离渲染；`<b>`、`<table>` 这类零散标签仍走内联清洗渲染。
 */
export function isHtmlDocument(text: string): boolean {
  return (
    /<!doctype\s+html/i.test(text) ||
    /<html[\s>]/i.test(text) ||
    /<body[\s>]/i.test(text) ||
    /<style[\s>]/i.test(text) ||
    /<script[\s>]/i.test(text)
  );
}

export interface MdBlockCode {
  kind: 'code';
  lang: string;
  code: string;
}
export interface MdBlockHtml {
  kind: 'html';
  html: string;
}
export interface MdBlockRich {
  kind: 'md';
  html: string;
}
export type MdBlock = MdBlockCode | MdBlockHtml | MdBlockRich;

/**
 * 把一段文本按顶层 token 切成「Markdown 段 / 代码块 / HTML 块」。
 * 只有 Markdown 段落走 `dangerouslySetInnerHTML`，代码与 HTML 块交给 React 元素承载。
 */
export function splitBlocks(text: string): MdBlock[] {
  const out: MdBlock[] = [];
  let buffer: Token[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    const html = sanitizeHtml(String(marked.parser(buffer)));
    if (html.trim()) out.push({ kind: 'md', html });
    buffer = [];
  };

  for (const token of marked.lexer(text)) {
    if (token.type === 'code') {
      const code = token as Tokens.Code;
      const lang = (code.lang ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
      flush();
      if (lang === 'html' || isHtmlDocument(code.text)) out.push({ kind: 'html', html: code.text });
      else out.push({ kind: 'code', lang, code: code.text });
      continue;
    }
    if (token.type === 'html' && (token as Tokens.HTML).block) {
      const raw = (token as Tokens.HTML).text;
      if (isHtmlDocument(raw)) {
        flush();
        out.push({ kind: 'html', html: raw });
        continue;
      }
    }
    buffer.push(token);
  }
  flush();
  return out;
}

/**
 * 工具结果要不要按富文本画：日志 / 文件内容 / JSON 原样显示更忠实，
 * 只有带明确 Markdown 结构（围栏、标题、表格、任务列表、引用、粗体、链接）或 HTML 文档时才渲染。
 */
export function looksRichText(text: string): boolean {
  if (isHtmlDocument(text)) return true;
  if (/^```/m.test(text)) return true;
  if (/^#{1,6} \S/m.test(text)) return true;
  if (/^\s{0,3}\|.+\|\s*$/m.test(text) && /^\s{0,3}\|[\s:|-]+\|\s*$/m.test(text)) return true;
  if (/^\s*[-*+] \[[ xX]\]\s/m.test(text)) return true;
  if (/^>\s+\S/m.test(text)) return true;
  if (/\*\*[^*\n]+\*\*/.test(text)) return true;
  if (/\[[^\]\n]+\]\((?:https?:|\/|\.)/.test(text)) return true;
  return false;
}

/**
 * 预览 iframe 的基础样式：跟随系统深浅色，用户自己的样式写在后面可以覆盖。
 * `fontSize` 由调用方传当前界面字号：iframe 是独立文档，拿不到父页面的 CSS 变量。
 */
function previewCss(fontSize: number): string {
  return `:root{color-scheme:light dark}
body{margin:12px;font:${fontSize}px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei UI",sans-serif;color:#1f2328;background:#fff;word-break:break-word}
img,svg,video,canvas{max-width:100%;height:auto}
table{border-collapse:collapse}
th,td{border:1px solid #d0d7de;padding:4px 8px}
pre,code{font-family:ui-monospace,Consolas,"Courier New",monospace}
a{color:#0969da}
@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}th,td{border-color:#30363d}a{color:#4493f8}}`;
}

/** 给一段 HTML 补成完整文档（片段则套 body），并把基础样式插在 `<head>` 最前面。 */
export function htmlPreviewDoc(html: string, fontSize = 14): string {
  const style = `<style>${previewCss(fontSize)}</style>`;
  let doc = isHtmlDocument(html)
    ? html
    : `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
  if (/<head[^>]*>/i.test(doc)) doc = doc.replace(/<head[^>]*>/i, (m) => `${m}${style}`);
  else if (/<html[^>]*>/i.test(doc))
    doc = doc.replace(/<html[^>]*>/i, (m) => `${m}<head><meta charset="utf-8">${style}</head>`);
  else doc = `<!doctype html><html><head><meta charset="utf-8">${style}</head><body>${doc}</body></html>`;
  return doc;
}

/** HTML 转义（拼导出文本时用）。 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
