/**
 * 语言元数据（07-languages-plugin L0）：应用启动时从后端 `/api/languages` 拉一次，
 * 建「扩展名 / 文件名 → 语言」「语言 → Monaco 语法 · 围栏 · 颜色 · 能力」的映射。
 *
 * 为什么要有这一层：以前这些表被抄在前端 5 处（MONACO_LANG / PROVIDER_LANGUAGES /
 * SYMBOL_LANGUAGES / App.langForFile / share.fenceLang）+ 2 处 CSS 里，加一门语言要改
 * 前端源码再重新构建。现在语言自述、后端下发、前端消费 —— 装一个语言包 + 重启后端即可。
 *
 * 拉取失败（理论上只在后端没起时发生）：所有映射退化为 plaintext / 空，不抛错。
 */
import type { CSSProperties } from 'react';
import { api } from './api';

export interface LanguageMeta {
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
  /** 进符号索引。 */
  symbols: boolean;
  /** 有 Hover / 跳定义 / 查引用。 */
  refs: boolean;
  /** 文件名模式（只预览类才有，如 requirements-dev.txt）；已序列化为正则源码。 */
  patterns?: string[];
}

export interface LanguagesPayload {
  languages: LanguageMeta[];
  previews: LanguageMeta[];
  refLanguages: string[];
  symbolLanguages: string[];
  /** 插件自带的 Monaco 语言定义（Monarch 语法）；Monaco 内置没有的语言靠它。 */
  monacoLanguages?: MonacoContribution[];
  errors: Array<{ source: string; message: string }>;
}

/** 插件贡献的 Monaco 语言定义（只用于运行时注册，不需要前端源码参与）。 */
export interface MonacoContribution {
  id: string;
  aliases?: string[];
  extensions?: string[];
  /** Monarch 词法定义（纯 JSON；正则写成 `{ regex: '\\d+' }` 或字符串）。 */
  monarch?: unknown;
  /** 语言配置：注释 / 括号 / 自动闭合。 */
  configuration?: unknown;
}

let payload: LanguagesPayload | null = null;
let loading: Promise<void> | null = null;

const byId = new Map<string, LanguageMeta>();
const byExt = new Map<string, LanguageMeta>();
const byName = new Map<string, LanguageMeta>();
const byPattern: Array<[RegExp, LanguageMeta]> = [];

/** 先注册者优先：可索引的语言排在 previews 前（同 id 时不让 preview 覆盖）。 */
function build(p: LanguagesPayload): void {
  byId.clear();
  byExt.clear();
  byName.clear();
  byPattern.length = 0;
  for (const lang of [...p.languages, ...p.previews]) {
    if (!byId.has(lang.id)) byId.set(lang.id, lang);
    for (const ext of lang.extensions) if (!byExt.has(ext)) byExt.set(ext, lang);
    for (const name of lang.filenames) if (!byName.has(name)) byName.set(name, lang);
    for (const src of lang.patterns ?? []) {
      try {
        byPattern.push([new RegExp(src), lang]);
      } catch {
        /* 坏模式忽略（不该发生：正则来自后端自己的表） */
      }
    }
  }
}

/** 启动时拉一次语言元数据；重复调用共享同一个 promise。 */
export function ensureLanguages(): Promise<void> {
  if (!loading) {
    loading = api
      .languages()
      .then((p) => {
        payload = p;
        build(p);
      })
      .catch(() => {
        /* 后端未起：全部映射退化为 plaintext，不打断启动 */
      });
  }
  return loading;
}

/** 元数据是否已就绪（测试与排障用）。 */
export function languagesReady(): boolean {
  return payload !== null;
}

/** 插件 / 语言加载失败清单（P3 起由后端填充）。 */
export function languageErrors(): Array<{ source: string; message: string }> {
  return payload?.errors ?? [];
}

/**
 * 插件自带的前端高亮定义（Monaco 语言 + Monarch 语法）。
 * 由 `monaco-setup.ts` 在元数据到位后运行时注册 —— 所以新增一门 Monaco 没有的语言，
 * 也不必重新构建前端。
 */
export function monacoContributions(): MonacoContribution[] {
  return payload?.monacoLanguages ?? [];
}

/** 后端语言 id / Monaco 语言 id → Monaco 语言 id（认不出给 plaintext）。 */
export function monacoLangFor(lang: string | undefined): string {
  if (!lang) return 'plaintext';
  return byId.get(lang)?.monaco ?? 'plaintext';
}

/** 文件名 → 后端语言 id（认不出返回空串；历史版本文本用）。 */
export function guessLangFor(file: string): string {
  const name = file.toLowerCase();
  const base = name.slice(name.lastIndexOf('/') + 1);
  const byFilename = byName.get(base);
  if (byFilename) return byFilename.id;
  const dot = name.lastIndexOf('.');
  if (dot >= 0) {
    const hit = byExt.get(name.slice(dot));
    if (hit) return hit.id;
  }
  for (const [re, lang] of byPattern) if (re.test(base)) return lang.id;
  return '';
}

/** 后端语言 id → Markdown 代码围栏标记（认不出返回空串，交给 Markdown 自己猜）。 */
export function fenceLang(lang: string): string {
  return byId.get(lang)?.fence ?? '';
}

/** 语言显示名（缺省用 id）。 */
export function langLabel(lang: string): string {
  return byId.get(lang)?.label ?? lang;
}

/** 色点 / 色带颜色；null = 用主题灰。 */
export function langColor(lang: string): string | null {
  return byId.get(lang)?.color ?? null;
}

/** 文件树色点的内联样式（无颜色 → 交给 CSS 的默认灰）。 */
export function langDotStyle(lang: string | undefined): CSSProperties | undefined {
  const color = lang ? langColor(lang) : null;
  return color ? { background: color } : undefined;
}

/** 语言分布色带的内联样式。 */
export function langSegStyle(lang: string): CSSProperties | undefined {
  const color = langColor(lang);
  return color ? { background: color } : undefined;
}

/** 有两类能力的语言集合都是 Monaco 语言 id（注册 provider 用）。 */
const refSet = new Set<string>();
const symbolSet = new Set<string>();

export function refLanguageList(): string[] {
  syncSets();
  return [...refSet];
}

export function symbolLanguageList(): string[] {
  syncSets();
  return [...symbolSet];
}

export function isRefLang(monacoLang: string): boolean {
  syncSets();
  return refSet.has(monacoLang);
}

export function isSymbolLang(monacoLang: string): boolean {
  syncSets();
  return symbolSet.has(monacoLang);
}

let setsFrom: LanguagesPayload | null = null;
function syncSets(): void {
  if (!payload || setsFrom === payload) return;
  setsFrom = payload;
  refSet.clear();
  symbolSet.clear();
  for (const l of payload.refLanguages) refSet.add(l);
  for (const l of payload.symbolLanguages) symbolSet.add(l);
}
