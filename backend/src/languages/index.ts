/** 语言注册表：扩展名 → LanguageSpec。 */
import type { LanguageSpec } from '../indexer/walker';
import { extname } from '../indexer/paths';
import { python } from './python';
import { makeTsLanguages } from './typescript';
import { go } from './go';
import { java } from './java';
import { rust } from './rust';

export const LANGUAGE_SPECS: LanguageSpec[] = [
  python,
  ...makeTsLanguages(),
  go,
  java,
  rust,
];

const byExtension = new Map<string, LanguageSpec>();
for (const spec of LANGUAGE_SPECS) {
  for (const ext of spec.extensions) {
    if (!byExtension.has(ext)) byExtension.set(ext, spec);
  }
}

/** 所有被索引的源码扩展名（含点、小写）。 */
export const SOURCE_EXTENSIONS: string[] = [...byExtension.keys()];

export function specForFile(relPath: string): LanguageSpec | null {
  const lower = relPath.toLowerCase();
  if (lower.endsWith('.d.ts')) return byExtension.get('.d.ts') ?? null;
  return byExtension.get(extname(lower)) ?? null;
}

export function specById(id: string): LanguageSpec | null {
  return LANGUAGE_SPECS.find((s) => s.id === id) ?? null;
}
