/**
 * CSS / SCSS / Less 语言模块（同一套规则，用 tree-sitter-css 实例化）。
 * 只提顶层可见的「可被复用的名字」：类选择器、id 选择器、@keyframes 名、自定义属性（`--x`）。
 * 标签选择器与单条声明不做符号（太密集，提了反而淹没大纲）。
 */
// tree-sitter-css 的 package.json 是 ESM 而 .d.ts 写的是 `export =`，取 default 要绕一层；
// 显式写子路径是因为 Node 对「目录形式的 main」在 ESM 下会打弃用告警（包是 ESM，另几个不是）。
import * as CssNs from 'tree-sitter-css/bindings/node/index.js';
import type { LanguageSpec, WalkContext } from '../indexer/walker';
import type { LangId } from '../types';

const Css = (CssNs as unknown as { default?: unknown }).default ?? CssNs;

function defineNamed(node: any, childType: string, ctx: WalkContext, kind: 'class' | 'constant' | 'function' | 'variable'): true {
  const target = node.type === childType ? node : (node.namedChildren as any[]).find((c) => c.type === childType);
  if (target) ctx.define(node, { nameNode: target, kind });
  return true;
}

/** id 选择器不算「函数」，用 constant 表达「全局唯一的名字」。 */
function makeCss(id: LangId, label: string, extensions: string[]): LanguageSpec {
  return {
    id,
    label,
    extensions,
    grammar: Css,

    scopes: {},

    handlers: {
      class_selector(node, ctx) {
        return defineNamed(node, 'class_name', ctx, 'class');
      },
      id_selector(node, ctx) {
        return defineNamed(node, 'id_name', ctx, 'constant');
      },
      keyframes_statement(node, ctx) {
        return defineNamed(node, 'keyframes_name', ctx, 'function');
      },
      declaration(node, ctx) {
        const prop = node.childForFieldName('property_name') ?? (node.namedChildren as any[])[0];
        if (prop?.type === 'property_name' && String(prop.text).startsWith('--')) {
          ctx.define(node, { nameNode: prop, kind: 'variable' });
        }
        return true;
      },
    },

    identifierTypes: [],
    commentTypes: ['comment'],
  };
}

export const css = makeCss('css', 'CSS', ['.css']);
export const scss = makeCss('scss', 'SCSS', ['.scss']);
export const less = makeCss('less', 'Less', ['.less']);
