/** JSON 语言模块：对象键作为符号，嵌套对象 / 数组按层级嵌套（供大纲与符号搜索）。 */
import Json from 'tree-sitter-json';
import type { LanguageSpec } from '../indexer/walker';

/** `"name"` → `name`（转义键原样保留，不做反转义）。 */
const keyText = (raw: string): string => {
  const text = raw.trim();
  return /^".*"$/.test(text) ? text.slice(1, -1) : text;
};

export const json: LanguageSpec = {
  id: 'json',
  label: 'JSON',
  extensions: ['.json', '.jsonc'],
  monaco: 'json',
  fence: 'json',
  color: '#8b949e',
  grammar: Json,

  scopes: {},

  handlers: {
    /**
     * 键定义在当前作用域，值自成一个作用域（嵌套键挂在它下面）。
     * 顶层键在文件作用域里 → 进 Ctrl+T 符号搜索；嵌套键只在大纲里出现（与其它语言的成员一致）。
     */
    pair(node, ctx) {
      const key = node.childForFieldName('key');
      const name = key ? keyText(String(key.text)) : null;
      const def = name ? ctx.define(node, { nameNode: key, name, kind: 'field' }) : null;
      const scope = ctx.enterScope(node, { kind: 'block' }, name);
      if (def) def.bodyScopeId = scope.id;
      const value = node.childForFieldName('value');
      if (value) ctx.walk(value);
      ctx.exitScope();
      return true;
    },
  },

  identifierTypes: [],
  commentTypes: ['comment'],

  literalTypes: {
    string: 'string',
    number: 'number',
    true: 'other',
    false: 'other',
    null: 'other',
  },
};
