/**
 * 忽略规则（P8 / Q10）：内置黑名单 < `.gitignore` < `.wcrignore`。
 *
 * 语义（对齐 gitignore 的可用子集）：
 * - 空行与 `#` 开头的行是注释；
 * - `!` 前缀是取反（把已排除的路径重新纳入）；
 * - 结尾 `/` 只匹配目录；
 * - `*` 匹配单层任意字符，`**` 跨层，`?` 匹配单字符；
 * - 不含 `/` 的 pattern 匹配任意层级；含 `/`（或以 `/` 开头）的按项目根锚定。
 *
 * 硬保护：`node_modules` 与 `.git` 是任何 `!` 都无法打开的两个名字（Q10）。
 * 规则文件只从项目根读取（不递归读子目录的 .gitignore）。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { IgnoreInfo } from '../types';
import { IGNORE_BUILTIN } from '../config';

/** 目录名黑名单（FR-0002 §9 / FR-0001 §2.4）：作为最低优先级的内置规则。 */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  '.tox',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.cache',
  '.parcel-cache',
  'coverage',
  '.idea',
  '.vscode',
  '.gradle',
  '.mvn',
  'obj',
  'bin',
  'vendor',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'site-packages',
  '.terraform',
  'tmp',
  '.tmp',
  'logs',
]);

/** 文件名黑名单（同上）：按 basename 匹配。 */
export const IGNORED_FILE_PATTERNS: RegExp[] = [
  /\.min\.(js|css)$/i,
  /\.(map|lock)$/i,
  /^package-lock\.json$/i,
  /^yarn\.lock$/i,
  /^pnpm-lock\.yaml$/i,
  /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|tar|jar|war|class|exe|dll|so|dylib|bin|woff2?|ttf|eot|mp[34]|wav|webm|mp4|sqlite|db|wasm)$/i,
];

/** 任何 `!` 都不能重新纳入的名字（Q10）。 */
const HARD_PROTECTED = new Set(['node_modules', '.git']);

/** 生效的规则文件（相对项目根，按优先级从低到高）。 */
export const IGNORE_FILES = ['.gitignore', '.wcrignore'] as const;

/** 设置面板里的自定义规则在 sources 里的显示名。 */
export const USER_RULES_SOURCE = '(设置)';

/**
 * 自定义规则文本（2026-10-03）：对所有项目生效，且优先级最高。
 * 由宿主注入（server 启动时 prime、保存设置时 write），判定器自己不碰磁盘。
 */
let userRulesText = '';

export function setUserIgnoreRules(text: string): void {
  userRulesText = text;
}

interface IgnoreRule {
  negate: boolean;
  dirOnly: boolean;
  /** 规则来源文件（内置规则为 null）。 */
  source: string | null;
  /** rel 为 POSIX 相对路径，name 为最后一段。 */
  test(rel: string, name: string): boolean;
}

interface Verdict {
  ignored: boolean;
  /** 该判定是「被 `!` 从已排除里重新纳入」。 */
  overridden: boolean;
}

function globBody(pattern: string): string {
  return pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
}

/** 把一份忽略文件解析成规则（顺序即优先级）。 */
function parseIgnoreFile(text: string, source: string): IgnoreRule[] {
  const out: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let pattern = line;
    const negate = pattern.startsWith('!');
    if (negate) pattern = pattern.slice(1);
    let dirOnly = false;
    if (pattern.endsWith('/')) {
      dirOnly = true;
      pattern = pattern.replace(/\/+$/, '');
    }
    if (pattern.startsWith('/')) pattern = pattern.replace(/^\/+/, '');
    if (!pattern) continue;
    // 含分隔符的 pattern（含以 / 开头）按项目根锚定；纯名字匹配任意层级。
    const anchored = line.replace(/^!/, '').startsWith('/') || pattern.includes('/');
    const body = globBody(pattern);
    const re = new RegExp(anchored ? `^${body}$` : `(^|.*/)${body}$`);
    out.push({ negate, dirOnly, source, test: (rel) => re.test(rel) });
  }
  return out;
}

/**
 * 忽略判定器。构造即带内置黑名单；`load()` / `reload()` 再叠加规则文件。
 * 判定是「最后命中的规则获胜」，因此 `.wcrignore` 的 `!` 可以覆盖 `.gitignore` 与内置规则。
 */
export class IgnoreMatcher {
  private rules: IgnoreRule[] = [];
  private sources: Array<{ path: string; rules: number }> = [];
  private overridden: string[] = [];
  private root = '';
  private readonly builtinEnabled: boolean;

  constructor(builtin = IGNORE_BUILTIN) {
    this.builtinEnabled = builtin;
    this.pushBuiltin();
  }

  static async load(root: string, builtin = IGNORE_BUILTIN): Promise<IgnoreMatcher> {
    const matcher = new IgnoreMatcher(builtin);
    await matcher.reload(root);
    return matcher;
  }

  /** 重新读取项目根的忽略文件（规则文件变更 / 每次全量扫描前调用）。 */
  async reload(root: string): Promise<void> {
    this.root = root;
    this.rules = [];
    this.sources = [];
    this.overridden = [];
    this.pushBuiltin();
    for (const rel of IGNORE_FILES) {
      let text: string;
      try {
        text = await fsp.readFile(path.join(root, rel), 'utf8');
      } catch {
        continue; // 没有该文件
      }
      const parsed = parseIgnoreFile(text, rel);
      this.rules.push(...parsed);
      this.sources.push({ path: rel, rules: parsed.length });
    }
    // 设置里的自定义规则：最后加载 → 优先级最高
    const extra = userRulesText.trim();
    if (extra) {
      const parsed = parseIgnoreFile(extra, USER_RULES_SOURCE);
      this.rules.push(...parsed);
      this.sources.push({ path: USER_RULES_SOURCE, rules: parsed.length });
    }
  }

  private pushBuiltin() {
    if (!this.builtinEnabled) return;
    for (const name of IGNORED_DIRS) {
      this.rules.push({ negate: false, dirOnly: true, source: null, test: (_rel, n) => n === name });
    }
    for (const re of IGNORED_FILE_PATTERNS) {
      this.rules.push({ negate: false, dirOnly: false, source: null, test: (_rel, n) => re.test(n) });
    }
  }

  /** 目录是否忽略（rel 为目录相对路径，name 为最后一段）。 */
  ignoresDir(rel: string, name: string): boolean {
    if (HARD_PROTECTED.has(name)) return true;
    const verdict = this.decide(rel, name, true);
    if (verdict.overridden) this.noteOverridden(rel);
    return verdict.ignored;
  }

  /** 文件是否忽略（含祖先目录被整目录忽略的情况）。 */
  ignoresFile(rel: string): boolean {
    const parts = rel.split('/').filter(Boolean);
    const name = parts[parts.length - 1] ?? rel;
    if (HARD_PROTECTED.has(name)) return true;
    let prefix = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      prefix = prefix ? `${prefix}/${seg}` : seg;
      if (HARD_PROTECTED.has(seg)) return true;
      if (this.decide(prefix, seg, true).ignored) return true;
    }
    const verdict = this.decide(rel, name, false);
    if (verdict.overridden) this.noteOverridden(rel);
    return verdict.ignored;
  }

  /** 路径是否忽略（chokidar 的 `ignored` 回调拿不到类型时的统一入口）。 */
  ignoresPath(rel: string, isDir = true): boolean {
    const name = rel.split('/').filter(Boolean).pop() ?? rel;
    return isDir ? this.ignoresDir(rel, name) : this.ignoresFile(rel);
  }

  /** 现况快照；`ignored` 由调用方统计（扫描时数到的被忽略条目）。 */
  info(ignored = 0): IgnoreInfo {
    return {
      sources: this.sources.map((s) => ({ ...s })),
      builtinDirs: this.builtinEnabled ? IGNORED_DIRS.size : 0,
      builtinPatterns: this.builtinEnabled ? IGNORED_FILE_PATTERNS.length : 0,
      ignored,
      overridden: this.overridden.slice(0, 20),
    };
  }

  /** 当前生效的规则条数（含内置；供测试与排障）。 */
  get ruleCount(): number {
    return this.rules.length;
  }

  get rootPath(): string {
    return this.root;
  }

  private decide(rel: string, name: string, isDir: boolean): Verdict {
    let ignored = false;
    let excludedBefore = false;
    let overridden = false;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) continue;
      if (!rule.test(rel, name)) continue;
      if (rule.negate) {
        overridden = excludedBefore;
        ignored = false;
      } else {
        excludedBefore = true;
        overridden = false;
        ignored = true;
      }
    }
    return { ignored, overridden };
  }

  private noteOverridden(rel: string) {
    if (this.overridden.includes(rel) || this.overridden.length >= 40) return;
    this.overridden.push(rel);
  }
}
