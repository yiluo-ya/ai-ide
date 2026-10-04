/** TOML 语言模块：`[table]` 作为命名空间，表内 `key = value` 作为字段。 */
import Toml from '@tree-sitter-grammars/tree-sitter-toml';
import type { LanguageSpec } from '../indexer/walker';

/** 键节点：bare_key / quoted_key / dotted_key（`a.b`）。 */
const isKeyNode = (type: string): boolean =>
  type === 'bare_key' || type === 'quoted_key' || type === 'dotted_key';

const unquote = (raw: string): string => raw.trim().replace(/^["']|["']$/g, '');

export const toml: LanguageSpec = {
  id: 'toml',
  label: 'TOML',
  extensions: ['.toml'],
  monaco: 'ini', // Monaco 没有 TOML 语法，用最接近的 ini（与前端原映射一致）
  fence: 'toml',
  color: '#9c4221',
  commentPrefixes: ['#'],
  grammar: Toml,

  scopes: {},

  handlers: {
    /** `[a.b]` / `[[a]]`：表名作为符号，表体自成一个作用域（表内的键挂在它下面）。 */
    table(node, ctx) {
      return handleTable(node, ctx);
    },
    table_array_element(node, ctx) {
      return handleTable(node, ctx);
    },

    /** `key = value`：键作为字段（在表作用域里 = 局部成员，顶层键则进符号搜索）。 */
    pair(node, ctx) {
      const key = (node.namedChildren as any[]).find((c) => isKeyNode(c.type));
      if (key) ctx.define(node, { name: unquote(String(key.text)), kind: 'field' });
      const value = node.childForFieldName('value');
      if (value) ctx.walk(value);
      return true;
    },
  },

  identifierTypes: [],
  commentTypes: ['comment'],

  literalTypes: {
    string: 'string',
    integer: 'number',
    float: 'number',
    boolean: 'other',
  },
};

function handleTable(node: any, ctx: any): true {
  const key = (node.namedChildren as any[]).find((c) => isKeyNode(c.type));
  const name = key ? unquote(String(key.text)) : null;
  const def = name ? ctx.define(node, { name, kind: 'namespace' }) : null;
  const scope = ctx.enterScope(node, { kind: 'block' }, name);
  if (def) def.bodyScopeId = scope.id;
  for (const child of node.namedChildren as any[]) {
    if (child !== key) ctx.walk(child);
  }
  ctx.exitScope();
  return true;
}
