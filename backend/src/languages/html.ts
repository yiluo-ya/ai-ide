/**
 * HTML 语言模块：只把带 `id` 的元素当符号（`id` 是页面里唯一的名字，可被 JS / CSS 引用）。
 * 标签名与 class 太密集，提出来只会淹没大纲。
 */
import Html from 'tree-sitter-html';
import type { LanguageSpec } from '../indexer/walker';

const unquote = (raw: string): string => raw.trim().replace(/^["']|["']$/g, '');

/** 元素自身或（自闭合标签）里的 `id="x"`。 */
function idOf(element: any): { name: string; nameNode: any } | null {
  const tag = (element.namedChildren as any[]).find(
    (c) => c.type === 'start_tag' || c.type === 'self_closing_tag',
  );
  if (!tag) return null;
  for (const attr of tag.namedChildren as any[]) {
    if (attr.type !== 'attribute') continue;
    const key = attr.childForFieldName('name') ?? (attr.namedChildren as any[])[0];
    if (String(key?.text ?? '').toLowerCase() !== 'id') continue;
    const value = attr.childForFieldName('value') ?? (attr.namedChildren as any[])[1];
    if (!value) continue;
    const name = unquote(String(value.text));
    if (name) return { name, nameNode: value };
  }
  return null;
}

export const html: LanguageSpec = {
  id: 'html',
  label: 'HTML',
  extensions: ['.html', '.htm'],
  grammar: Html,

  scopes: {},

  handlers: {
    element(node, ctx) {
      const found = idOf(node);
      if (found) ctx.define(node, { name: found.name, nameNode: found.nameNode, kind: 'constant' });
      return false; // 继续遍历子元素，里面的 id 同样要被索引
    },
  },

  identifierTypes: [],
  commentTypes: ['comment'],
};
