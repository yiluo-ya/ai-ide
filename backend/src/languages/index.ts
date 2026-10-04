/** 语言注册表：扩展名 / 文件名 → LanguageSpec。 */
import type { LanguageSpec } from '../indexer/walker';
import { basename, extname } from '../indexer/paths';
import { python } from './python';
import { makeTsLanguages } from './typescript';
import { go } from './go';
import { java } from './java';
import { rust } from './rust';
import { shell } from './shell';
import { json } from './json';
import { yaml } from './yaml';
import { toml } from './toml';
import { ini } from './ini';
import { dockerfile } from './dockerfile';
import { markdown } from './markdown';
import { css, less, scss } from './css';
import { html } from './html';
import { sql } from './sql';
import { manifestLangFor, previewLanguages, buildPreviewIndex } from './manifests';
import { loadLanguagePlugins, type PluginLoadError } from './loader';
import type { MonacoContribution } from './plugin';
import { PLUGINS_ENABLED, PRESET_PLUGINS_ENABLED } from '../config';
import type { LangId } from '../types';

/**
 * 内置核心语言：Python / TS·TSX·JS·JSX / Go / Java / Rust。
 * 其余语言（shell / json / …）与第三方语言都走插件加载器（见下面的顶层 await）。
 */
const BUILTIN_SPECS: LanguageSpec[] = [
  python,
  ...makeTsLanguages(),
  go,
  java,
  rust,
  shell,
  json,
  yaml,
  toml,
  ini,
  dockerfile,
  markdown,
  css,
  scss,
  less,
  html,
  sql,
];

/** 全部已注册语言（内置 + 插件），顺序即优先级：先注册者优先。 */
export const LANGUAGE_SPECS: LanguageSpec[] = BUILTIN_SPECS;

/** 内置语言的 id 集合（`wcr lang list` 用它区分内置与插件）。 */
export const BUILTIN_LANGUAGE_IDS: ReadonlySet<string> = new Set(
  BUILTIN_SPECS.map((s) => String(s.id)),
);

/** 插件加载失败清单（`/api/languages` 回给前端展示；不影响服务启动）。 */
export const pluginErrors: PluginLoadError[] = [];

/** 插件贡献的前端高亮定义（Monaco 语言 + Monarch 语法）；前端启动时运行时注册。 */
const monacoContribs: MonacoContribution[] = [];

// 顶层 await（07-languages-plugin）：插件在本模块求值时装载完毕，
// 于是下面 byExtension 的构建、以及所有消费方（store / parse-worker / routes）
// 看到的都是「内置 + 插件」的最终集合。
// 注意：worker 也会跑一遍本模块（parse-worker.ts 动态 import 这里），语言集必然一致。
if (PLUGINS_ENABLED || PRESET_PLUGINS_ENABLED) {
  await loadLanguagePlugins({
    specs: LANGUAGE_SPECS,
    previews: previewLanguages(),
    monaco: monacoContribs,
    errors: pluginErrors,
  });
  buildPreviewIndex();
}

const byExtension = new Map<string, LanguageSpec>();
const byFilename = new Map<string, LanguageSpec>();
for (const spec of LANGUAGE_SPECS) {
  for (const ext of spec.extensions) {
    if (!byExtension.has(ext)) byExtension.set(ext, spec);
  }
  for (const name of spec.filenames ?? []) {
    if (!byFilename.has(name)) byFilename.set(name, spec);
  }
}

/** 所有被索引的源码扩展名（含点、小写）。 */
export const SOURCE_EXTENSIONS: string[] = [...byExtension.keys()];

export function specForFile(relPath: string): LanguageSpec | null {
  const lower = relPath.toLowerCase();
  // 无扩展名的固定文件名优先（Dockerfile / .env）
  const byName = byFilename.get(basename(lower));
  if (byName) return byName;
  if (lower.endsWith('.d.ts')) return byExtension.get('.d.ts') ?? null;
  return byExtension.get(extname(lower)) ?? null;
}

export function specById(id: string): LanguageSpec | null {
  return LANGUAGE_SPECS.find((s) => s.id === id) ?? null;
}

/**
 * 一个文件该用哪门语言的语法看：先看可索引的语言，再看包依赖 / 构建清单（只着色不索引），
 * 都认不出才 plaintext。预览（`readText`）、文件树色点、`langOf` 共用这一个口径。
 */
export function langForFile(relPath: string): LangId {
  const spec = specForFile(relPath);
  if (spec) return spec.id;
  return manifestLangFor(relPath) ?? 'plaintext';
}

// ---------------------------------------------------------------- 语言元数据
// 07-languages-plugin（L0 元数据层）：这些事实由语言自己（内置 spec / 插件）自述，
// 经 `/api/languages` 下发给前端 —— 前端不再维护「扩展名 → 语言」等硬编码表。

/** 一门语言对前端可见的全部事实。 */
export interface LanguageMetaEntry {
  id: string;
  label: string;
  extensions: string[];
  filenames: string[];
  /** Monaco 语言 id；null = Monaco 没有该语法（预览退 plaintext）。 */
  monaco: string | null;
  /** Markdown 代码围栏标记。 */
  fence: string;
  /** 色点 / 色带颜色；null = 主题灰。 */
  color: string | null;
  /** 文件名模式（已序列化为正则源码；只有预览类用得上，如 requirements-dev.txt）。 */
  patterns?: string[];
  /** 进符号索引（`previews` 恒为 false）。 */
  symbols: boolean;
  /** 有 Hover / 跳定义 / 查引用。 */
  refs: boolean;
}

/** Monaco 语言 id：显式 `''` 表示「Monaco 没有」，缺省视为与语言 id 同名。 */
const monacoOf = (s: { id: string; monaco?: string }): string | null =>
  s.monaco === '' ? null : (s.monaco ?? s.id);

/** 可索引语言的元数据。 */
export function languageMetaList(): LanguageMetaEntry[] {
  return LANGUAGE_SPECS.map((s) => ({
    id: String(s.id),
    label: s.label,
    extensions: [...s.extensions],
    filenames: [...(s.filenames ?? [])],
    monaco: monacoOf(s),
    fence: s.fence ?? monacoOf(s) ?? String(s.id),
    color: s.color ?? null,
    symbols: true,
    refs: s.refs === true,
  }));
}

/** 只高亮预览的文件类型（go.mod / pom.xml…）的元数据。 */
export function previewMetaList(): Array<Omit<LanguageMetaEntry, 'refs'>> {
  return previewLanguages().map((p) => ({
    id: String(p.id),
    label: String(p.id),
    extensions: [...(p.extensions ?? [])],
    filenames: [...(p.filenames ?? [])],
    monaco: monacoOf(p),
    fence: monacoOf(p) ?? String(p.id),
    color: p.color ?? null,
    patterns: (p.patterns ?? []).map((re) => re.source),
    symbols: false,
  }));
}

/** 前端要注册「引用类 Provider」（hover / 定义 / 引用）的 Monaco 语言 id（已去重）。 */
export function refLanguages(): string[] {
  const out = new Set<string>();
  for (const s of LANGUAGE_SPECS) {
    if (s.refs !== true) continue;
    const m = monacoOf(s);
    if (m) out.add(m);
  }
  return [...out];
}

/** 前端要注册「大纲 Provider」的 Monaco 语言 id（所有可索引语言，已去重）。 */
export function symbolLanguages(): string[] {
  const out = new Set<string>();
  for (const s of LANGUAGE_SPECS) {
    const m = monacoOf(s);
    if (m) out.add(m);
  }
  return [...out];
}

/**
 * 插件贡献的 Monaco 语言定义（含 Monarch 语法）。
 * 前端在 `ensureLanguages()` 之后逐条 `monaco.languages.register` +
 * `setMonarchTokensProvider` + `setLanguageConfiguration`。
 */
export function monacoLanguages(): MonacoContribution[] {
  return monacoContribs.map((c) => ({ ...c }));
}
