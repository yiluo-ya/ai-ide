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
import { manifestLangFor } from './manifests';
import type { LangId } from '../types';

export const LANGUAGE_SPECS: LanguageSpec[] = [
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
