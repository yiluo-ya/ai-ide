/**
 * 语言插件契约（07-languages-plugin）。
 *
 * 一个语言插件就是一个 ESM 包（或目录），在自己的 `package.json` 里用 `wcr.lang`
 * 指向入口文件，入口导出 `plugin`（或 `default`）：
 *
 * ```json
 * { "name": "wcr-lang-zig", "type": "module", "wcr": { "lang": "./index.ts" } }
 * ```
 * ```ts
 * import Zig from 'tree-sitter-zig';
 * import { defineLanguage } from 'wcr-lang-sdk';
 * export const plugin = defineLanguage({
 *   spec: { id: 'zig', label: 'Zig', extensions: ['.zig'], grammar: Zig, ... },
 *   meta: { monaco: 'zig', color: '#f7a41d' },
 * });
 * ```
 *
 * 注意事项（加载器的硬约束）：
 * - 插件必须是 ESM（`"type": "module"` 或入口为 `.mjs`），否则 tsx 会按 CJS 转译而报错；
 * - 语法包（tree-sitter-xxx）是原生模块，随插件自己的 `node_modules` 走；
 * - 插件加载失败只记错误、不拖垮服务（见 `loader.ts`）。
 */
import type { LanguageSpec } from '../indexer/walker';
import type { PreviewLanguage } from './manifests';

/** 插件对前端可见的元数据（与 `LanguageSpec` 上的同名字段等价，可只写这一份）。 */
export interface PluginMeta {
  /** Monaco 语言 id；`''` 表示 Monaco 没有该语法（预览退 plaintext）。 */
  monaco?: string;
  /** Markdown 代码围栏标记。 */
  fence?: string;
  /** 文件树色点 / 语言分布色带颜色。 */
  color?: string;
}

/** 插件贡献的 Monaco 语言定义（Monaco 内置没有该语法时必需，否则只能退 plaintext）。 */
export interface MonacoContribution {
  /** Monaco 语言 id（应与 `meta.monaco` / `spec.monaco` 一致）。 */
  id: string;
  /** 别名（用于 `model.getLanguageId()` 的兼容写法，可选）。 */
  aliases?: string[];
  /** 该语言的文件扩展名（Monaco 自己按扩展名匹配时用，可选）。 */
  extensions?: string[];
  /**
   * Monarch 词法定义。写法与 Monaco 官方一致：`[/\/\/.*$/, 'comment']`、`{ regex: /\d+/ }`、
   * 字符串都能用 —— 加载器会把正则字面量转成字符串再经 JSON 下发
   * （`JSON.stringify(/x/)` 会变成 `{}`，见 loader.ts 的 normalizeMonarch）。
   */
  monarch?: unknown;
  /** 语言配置：注释符号 / 括号 / 自动闭合 / 缩进规则（可选）。 */
  configuration?: unknown;
}

/** 插件导出物。`spec` / `specs` 与 `preview` 至少有一个。 */
export interface LanguagePlugin {
  /** 可索引的语言实现（符号 / 引用 / 作用域）。 */
  spec?: LanguageSpec;
  /**
   * 一个包出多门语言时用它（如 C/C++ 同包、CSS/SCSS/Less 同语法）。
   * 与 `spec` 可同时给，最终都进注册表。
   */
  specs?: LanguageSpec[];
  /** 只做高亮预览的文件名 / 扩展名（如 go.mod → go）。 */
  preview?: PreviewLanguage[];
  /** 前端元数据；`spec` 上没写时从这里取。 */
  meta?: PluginMeta;
  /** 前端高亮贡献（Monaco 语言 + Monarch 语法）。 */
  monaco?: MonacoContribution;
}

/** 写插件时用它拿类型提示与默认值（等价于直接写 `{ spec, preview, meta, monaco }`）。 */
export function defineLanguage(plugin: LanguagePlugin): LanguagePlugin {
  return plugin;
}

/** 插件包清单里指向入口的字段（`package.json` 的 `wcr.lang`）。 */
export const PLUGIN_MANIFEST_FIELD = 'wcr.lang';
