/**
 * Code Agent 会话导出（2026-10-03 用户要求：会话内容支持 md 与 html 展示）。
 *
 * - `sessionToMarkdown`：纯文本记录，思考 / 工具调用 / 工具结果缩进成代码块 —— 内容里带 ``` 也不会破格式；
 * - `sessionToHtml`：单文件 HTML（样式内联），正文与界面里一样按 Markdown 渲染。
 *
 * 两条路都先清洗再输出（复用 `markdown.ts`），导出文件里也不会带上 agent 写的脚本。
 */
import { agentMessageText, type AgentMessage } from './agentApi';
import { translate } from './i18n';
import { escapeHtml, sanitizeHtml, splitBlocks } from './markdown';

export interface SessionExportInput {
  name: string;
  projectName?: string;
  projectRoot?: string;
  /** 已经是给人看的名字（如「内置 agent」），字符串由调用方翻好。 */
  backendLabel?: string;
  model?: { provider?: string; id?: string } | null;
  messages: AgentMessage[];
  at?: Date;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 人读的时间戳：2026-10-03 18:20。 */
export function stamp(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** 文件名里的时间戳：20261003-1820。 */
function fileStamp(at: Date): string {
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
}

/** 导出文件名：`agent-session-<会话名>-<时间>.<ext>`（会话名里的路径字符换成 `-`）。 */
export function sessionFilename(name: string, ext: 'md' | 'html', at: Date = new Date()): string {
  const slug =
    name
      .trim()
      .replace(/[^\p{Script=Han}A-Za-z0-9._-]+/gu, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '') || 'session';
  return `agent-session-${slug}-${fileStamp(at)}.${ext}`;
}

/** 触发浏览器下载（Blob + `<a download>`）。 */
export function downloadFile(filename: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 立刻 revoke 在部分浏览器会打断下载，让出一帧更稳
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** 每行缩进 4 空格：Markdown 里的代码块，内容再乱也不会被解析成标题 / 列表。 */
function indentBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `    ${line}` : ''))
    .join('\n');
}

function metaRows(input: SessionExportInput, at: Date): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (input.projectName) {
    rows.push([
      translate('agent.exportProject'),
      input.projectRoot ? `${input.projectName} (${input.projectRoot})` : input.projectName,
    ]);
  }
  if (input.backendLabel) rows.push([translate('agent.exportBackend'), input.backendLabel]);
  if (input.model?.id) {
    rows.push([
      translate('agent.exportModel'),
      input.model.provider ? `${input.model.provider}/${input.model.id}` : input.model.id,
    ]);
  }
  rows.push([translate('agent.exportMessageCount'), String(input.messages.length)]);
  rows.push([translate('agent.exportTime'), stamp(at)]);
  return rows;
}

function markdownMessage(message: AgentMessage): string | null {
  if (message.role === 'system') return null;

  if (message.role === 'user') {
    return `## ${translate('agent.roleUser')}\n\n${agentMessageText(message)}`;
  }

  if (message.role === 'toolResult') {
    const head = `${translate('agent.toolResultPrefix')}${message.toolName ?? ''}${
      message.isError ? ` · ${translate('agent.failed')}` : ''
    }`;
    return `**${head}**\n\n${indentBlock(agentMessageText(message))}`;
  }

  const parts: string[] = [];
  if (typeof message.content === 'string') parts.push(message.content);
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    } else if (block.type === 'thinking' && block.thinking) {
      parts.push(
        `<details><summary>${translate('agent.thinking')}</summary>\n\n${indentBlock(block.thinking)}\n\n</details>`,
      );
    } else if (block.type === 'toolCall') {
      parts.push(
        `**${translate('agent.toolCallPrefix')}${block.name ?? ''}**\n\n${indentBlock(JSON.stringify(block.arguments ?? {}, null, 2))}`,
      );
    }
  }
  if (message.stopReason === 'error' && message.errorMessage) {
    parts.push(`> ${translate('agent.failed')}: ${message.errorMessage}`);
  }
  return parts.length ? `## ${translate('agent.roleAgent')}\n\n${parts.join('\n\n')}` : null;
}

/** 会话 → Markdown 文本。 */
export function sessionToMarkdown(input: SessionExportInput): string {
  const at = input.at ?? new Date();
  const out: string[] = [`# ${input.name}`, ''];
  for (const [key, value] of metaRows(input, at)) out.push(`- ${key}: ${value}`);
  out.push('', '---', '');
  for (const message of input.messages) {
    const rendered = markdownMessage(message);
    if (rendered) out.push(rendered, '');
  }
  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

/** 导出 HTML 的样式：单文件、跟随系统深浅色。 */
const HTML_CSS = `:root{color-scheme:light dark}
body{margin:0 auto;padding:24px;max-width:880px;font:15px/1.65 system-ui,-apple-system,"Segoe UI","Microsoft YaHei UI",sans-serif;color:#1f2328;background:#fff;word-break:break-word}
h1{font-size:22px;margin:0 0 6px}
.meta{color:#59636e;font-size:13px;margin:0 0 20px;white-space:pre-line}
.m{border:1px solid #d8dee4;border-radius:8px;padding:10px 14px;margin:0 0 14px}
.m.user{background:#f6f8fa}
.role{color:#59636e;font-size:12px;margin-bottom:6px}
pre{background:#f6f8fa;border-radius:6px;padding:10px;overflow:auto;font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:13px;white-space:pre-wrap;word-break:break-word}
pre.plain{margin:0}
table{border-collapse:collapse}
th,td{border:1px solid #d0d7de;padding:4px 8px}
img,svg,video{max-width:100%;height:auto}
.fold{margin:8px 0;border:1px solid #d8dee4;border-radius:6px;padding:6px 10px}
.fold summary{cursor:pointer;color:#59636e;font-size:13px}
.html-frag{border-left:3px solid #d8dee4;padding-left:10px}
@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}.m{border-color:#30363d}.m.user{background:#161b22}pre{background:#161b22}.meta,.role,.fold summary{color:#8b949e}th,td{border-color:#30363d}.fold{border-color:#30363d}.html-frag{border-color:#30363d}}`;

function fold(title: string, contentHtml: string): string {
  return `<details class="fold"><summary>${escapeHtml(title)}</summary><pre>${contentHtml}</pre></details>`;
}

/** 一段正文 → HTML（与界面里同一套切分：Markdown 段 / 代码块 / HTML 块）。 */
function richHtml(text: string): string {
  return splitBlocks(text)
    .map((block) => {
      if (block.kind === 'md') return `<div class="md">${block.html}</div>`;
      if (block.kind === 'code') return `<pre class="code"><code>${escapeHtml(block.code)}</code></pre>`;
      return `<div class="html-frag">${sanitizeHtml(block.html)}</div>`;
    })
    .join('\n');
}

function htmlMessage(message: AgentMessage): string {
  if (message.role === 'system') return '';

  if (message.role === 'user') {
    const role = escapeHtml(translate('agent.roleUser'));
    return `<section class="m user"><div class="role">${role}</div><pre class="plain">${escapeHtml(
      agentMessageText(message),
    )}</pre></section>`;
  }

  if (message.role === 'toolResult') {
    const head = `${translate('agent.toolResultPrefix')}${message.toolName ?? ''}${
      message.isError ? ` · ${translate('agent.failed')}` : ''
    }`;
    return `<section class="m">${fold(head, escapeHtml(agentMessageText(message)))}</section>`;
  }

  const inner: string[] = [];
  if (typeof message.content === 'string') inner.push(richHtml(message.content));
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block.type === 'text' && block.text) {
      inner.push(richHtml(block.text));
    } else if (block.type === 'thinking' && block.thinking) {
      inner.push(fold(translate('agent.thinking'), escapeHtml(block.thinking)));
    } else if (block.type === 'toolCall') {
      const head = `${translate('agent.toolCallPrefix')}${block.name ?? ''}`;
      inner.push(fold(head, escapeHtml(JSON.stringify(block.arguments ?? {}, null, 2))));
    }
  }
  if (message.stopReason === 'error' && message.errorMessage) {
    inner.push(`<p><b>${escapeHtml(translate('agent.failed'))}</b>: ${escapeHtml(message.errorMessage)}</p>`);
  }
  if (inner.length === 0) return '';
  const role = escapeHtml(translate('agent.roleAgent'));
  return `<section class="m"><div class="role">${role}</div>${inner.join('\n')}</section>`;
}

/** 会话 → 单文件 HTML。 */
export function sessionToHtml(input: SessionExportInput): string {
  const at = input.at ?? new Date();
  const meta = metaRows(input, at)
    .map(([key, value]) => `${escapeHtml(key)}: ${escapeHtml(value)}`)
    .join('\n');
  const body = input.messages.map(htmlMessage).filter(Boolean).join('\n');
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.name)}</title>
<style>${HTML_CSS}</style>
</head>
<body>
<header>
<h1>${escapeHtml(input.name)}</h1>
<p class="meta">${meta}</p>
</header>
<main>
${body}
</main>
</body>
</html>
`;
}
