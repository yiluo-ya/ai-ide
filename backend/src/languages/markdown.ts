/**
 * Markdown 语言模块：标题作为符号，按标题层级嵌套（大纲即目录）。
 * 只读语法：标题文字里的行内标记（粗体 / 链接）原样保留。
 */
import Markdown from '@tree-sitter-grammars/tree-sitter-markdown';
import type { LanguageSpec } from '../indexer/walker';

const MAX_HEADING_CHARS = 120;

/** 标题文字：ATX（`## x`）与 Setext（下划线式）都有 inline 子节点。 */
function headingText(heading: any): string | null {
  const inline = findInline(heading);
  const text = String(inline?.text ?? '').trim();
  if (!text) return null;
  return text.length > MAX_HEADING_CHARS ? `${text.slice(0, MAX_HEADING_CHARS - 3)}...` : text;
}

function findInline(node: any): any | null {
  for (const c of node.namedChildren as any[]) {
    if (c.type === 'inline') return c;
    const found = findInline(c);
    if (found) return found;
  }
  return null;
}

export const markdown: LanguageSpec = {
  id: 'markdown',
  label: 'Markdown',
  extensions: ['.md', '.markdown'],
  monaco: 'markdown',
  fence: 'markdown',
  color: '#519aba',
  doc: true,
  grammar: Markdown,

  scopes: {},

  handlers: {
    /**
     * section 是「标题 + 它的内容（含子 section）」：标题定义在父作用域，
     * section 自己作为作用域，子标题自然挂在上一级标题下。
     */
    section(node, ctx) {
      const heading = (node.namedChildren as any[]).find(
        (c) => c.type === 'atx_heading' || c.type === 'setext_heading',
      );
      const name = heading ? headingText(heading) : null;
      const def = name ? ctx.define(heading, { name, kind: 'namespace', detail: name }) : null;
      const scope = ctx.enterScope(node, { kind: 'block' }, name);
      if (def) def.bodyScopeId = scope.id;
      for (const child of node.namedChildren as any[]) {
        if (child !== heading) ctx.walk(child);
      }
      ctx.exitScope();
      return true;
    },
  },

  identifierTypes: [],
};
