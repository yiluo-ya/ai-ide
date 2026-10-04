/** YAML 语言模块：映射键作为符号，嵌套映射按层级嵌套。 */
import Yaml from '@tree-sitter-grammars/tree-sitter-yaml';
import type { LanguageSpec } from '../indexer/walker';

/** `"name"` / `'name'` → `name`；裸键原样。 */
const keyText = (raw: string): string => {
  const text = raw.trim();
  return /^(["']).*\1$/.test(text) ? text.slice(1, -1) : text;
};

/** 块映射与流式映射（`{a: 1}`）的键值节点类型不同，处理方式一致。 */
function handlePair(node: any, ctx: any): true {
  const key = node.childForFieldName('key');
  const name = key ? keyText(String(key.text)) : null;
  const def = name ? ctx.define(node, { nameNode: key, name, kind: 'field' }) : null;
  const scope = ctx.enterScope(node, { kind: 'block' }, name);
  if (def) def.bodyScopeId = scope.id;
  const value = node.childForFieldName('value');
  if (value) ctx.walk(value);
  ctx.exitScope();
  return true;
}

export const yaml: LanguageSpec = {
  id: 'yaml',
  label: 'YAML',
  extensions: ['.yml', '.yaml'],
  monaco: 'yaml',
  fence: 'yaml',
  color: '#cb171e',
  commentPrefixes: ['#'],
  grammar: Yaml,

  scopes: {},

  handlers: {
    block_mapping_pair: handlePair,
    flow_pair: handlePair,
  },

  identifierTypes: [],
  commentTypes: ['comment'],

  literalTypes: {
    string_scalar: 'string',
    integer_scalar: 'number',
    float_scalar: 'number',
    boolean_scalar: 'other',
    null_scalar: 'other',
  },
};
