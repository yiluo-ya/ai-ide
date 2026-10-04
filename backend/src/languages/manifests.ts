/**
 * 包依赖 / 构建清单文件的语言识别（2026-10-03，用户要求「各种包依赖配置文件」）。
 *
 * 这些文件**只做语法高亮与预览**，不进符号索引：它们要么没有可用的 tree-sitter 语法包
 * （go.mod / pom.xml / Gemfile…），要么本身就是清单（索引出来的键只会淹掉大纲）。
 * 所以与 `LanguageSpec` 分开：`specForFile()` 只认「可索引的语言」，这里只回答
 * 「这个文件该用哪门语言的语法着色」（store 的 lang 字段 / 文件树色点 / 预览高亮）。
 *
 * `id` 允许用已有 LanguageSpec 的 id（如 Pipfile 是 TOML 语法、Pipfile.lock 是 JSON）。
 */
import type { LangId } from '../types';
import { basename, extname } from '../indexer/paths';

export interface PreviewLanguage {
  /** 用来着色的语言 id。 */
  id: LangId;
  /** 小写扩展名，含点。 */
  extensions?: string[];
  /** 精确文件名（小写）。 */
  filenames?: string[];
  /** 文件名模式（名字带可变部分的那类，如 requirements-dev.txt）；对 basename 匹配。 */
  patterns?: RegExp[];
  /** Monaco 语言 id（前端高亮用；缺省 = id 同名）。 */
  monaco?: string;
  /** 色点 / 色带颜色（缺省回落到主题灰）。 */
  color?: string;
}

const PREVIEW_LANGUAGES: PreviewLanguage[] = [
  // Java / .NET：Maven、MSBuild、NuGet 的清单都是 XML
  {
    id: 'xml',
    monaco: 'xml',
    color: '#0060ac',
    filenames: [
      'pom.xml',
      'nuget.config',
      'packages.config',
      'app.config',
      'web.config',
      'directory.build.props',
      'directory.build.targets',
    ],
    extensions: ['.csproj', '.fsproj', '.vbproj', '.props', '.targets', '.nuspec', '.pubxml'],
  },
  // Go module
  { id: 'gomod', monaco: 'go', color: '#00add8', filenames: ['go.mod', 'go.sum'] },
  // Gradle（Groovy DSL）、Kotlin DSL、sbt
  {
    id: 'groovy',
    monaco: 'java',
    color: '#4298b8',
    filenames: ['build.gradle', 'settings.gradle', 'init.gradle'],
    extensions: ['.gradle'],
  },
  { id: 'kotlin', monaco: 'kotlin', color: '#a97bff', extensions: ['.kts'] },
  { id: 'scala', monaco: 'scala', color: '#c22d40', extensions: ['.sbt'] },
  // Ruby：Bundler / CocoaPods / 常见 Rake 文件
  {
    id: 'ruby',
    monaco: 'ruby',
    color: '#701516',
    filenames: [
      'gemfile',
      'rakefile',
      'podfile',
      'fastfile',
      'appfile',
      'brewfile',
      'vagrantfile',
      'berksfile',
      'guardfile',
      'capfile',
      'thorfile',
    ],
    extensions: ['.gemspec', '.podspec'],
  },
  // Elixir / Swift
  { id: 'elixir', monaco: 'elixir', color: '#6e4a7e', extensions: ['.exs'], filenames: ['mix.lock'] },
  { id: 'swift', monaco: 'swift', color: '#f05138', filenames: ['package.swift'] },
  // Python 依赖清单：Pipfile 是 TOML 语法、Pipfile.lock 是 JSON、requirements*.txt 是键值行
  { id: 'pip', monaco: 'ini', color: '#6cb6ff', patterns: [/^requirements[\w.-]*\.txt$/, /^constraints[\w.-]*\.txt$/] },
  { id: 'toml', monaco: 'ini', color: '#9c4221', filenames: ['pipfile', 'cargo.lock', 'poetry.lock', 'uv.lock', 'pdm.lock'] },
  { id: 'json', monaco: 'json', color: '#8b949e', filenames: ['pipfile.lock', 'composer.lock'] },
  { id: 'yaml', monaco: 'yaml', color: '#cb171e', filenames: ['pubspec.lock'] },
  // 包管理器自身的配置（ini 语法）
  { id: 'ini', monaco: 'ini', color: '#6cb6ff', filenames: ['.npmrc', '.yarnrc', '.nvmrc', '.editorconfig'] },
  // Makefile：Monaco 没有 makefile 语法，借 shell 给注释与变量着色
  { id: 'makefile', monaco: 'shell', color: '#427819', filenames: ['makefile', 'gnumakefile'], extensions: ['.mk', '.mak'] },
];

/** 预览语言清单（只高亮预览的文件；供 `/api/languages` 下发给前端）。 */
export function previewLanguages(): PreviewLanguage[] {
  return PREVIEW_LANGUAGES;
}

const byExtension = new Map<string, LangId>();
const byFilename = new Map<string, LangId>();
const patterns: Array<[RegExp, LangId]> = [];

/**
 * 按当前 `PREVIEW_LANGUAGES` 重建索引。
 * 语言插件（07-languages-plugin）会往表里追加条目，追加后必须调一次。
 */
export function buildPreviewIndex(): void {
  byExtension.clear();
  byFilename.clear();
  patterns.length = 0;
  for (const lang of PREVIEW_LANGUAGES) {
    for (const ext of lang.extensions ?? []) if (!byExtension.has(ext)) byExtension.set(ext, lang.id);
    for (const name of lang.filenames ?? []) if (!byFilename.has(name)) byFilename.set(name, lang.id);
    for (const re of lang.patterns ?? []) patterns.push([re, lang.id]);
  }
}

buildPreviewIndex();

/** 清单文件 → 着色语言；认不出返回 null（照旧 plaintext）。 */
export function manifestLangFor(relPath: string): LangId | null {
  const lower = relPath.toLowerCase();
  const base = basename(lower);
  const byName = byFilename.get(base);
  if (byName) return byName;
  for (const [re, id] of patterns) if (re.test(base)) return id;
  return byExtension.get(extname(lower)) ?? null;
}
