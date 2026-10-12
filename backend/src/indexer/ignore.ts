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
 *
 * 性能（2026-10-12）：判定曾经是「每条规则都跑一次 test」，单文件成本 ≈ 规则数 × 祖先层数。
 * 在 godot（1.7 万文件、268 条规则）上实测 `ignoresFile` 占总扫描时间的 99%（39.8s / 40.1s）。
 * 现在做两件事，语义逐条不变（见 tests/ignore.test.ts）：
 * ① 分桶 —— 纯名字规则进 Map、`*.ext` 进后缀桶、锚定纯路径进字面桶，只有真 glob 才走正则；
 * ② 目录判定缓存 —— 同一目录会被它下面每个文件反复问到，规则不变时结果就一样。
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

/** 目录判定缓存的条数上限（超过后整体丢弃重算，避免长跑实例无限增长）。 */
const MAX_DIR_CACHE = 100_000;

/**
 * 规则的快查类别：能在 O(1) 里判定的绝不走正则（大仓库扫描的主要成本就在这里）。
 * - `name`：纯名字（无 `/`、无通配）→ 按 basename 直查；
 * - `suffix`：`*.ext` / `*.a.ext` → 按文件名后缀直查；
 * - `literal`：锚定的纯路径（含 `/`、无通配）→ 按 rel 精确查；
 * - `regex`：真 glob（`**`、`?`、字符类…）→ 仍然逐条 test。
 */
type RuleKind = 'name' | 'suffix' | 'literal' | 'regex';

interface IgnoreRule {
  negate: boolean;
  dirOnly: boolean;
  /** 规则来源文件（内置规则为 null）。 */
  source: string | null;
  kind: RuleKind;
  /** name → 文件名；suffix → 以 `.` 开头的后缀；literal → 完整 rel；regex → 空串。 */
  key: string;
  /** 仅 kind === 'regex' 时有效。 */
  re: RegExp | null;
  /**
   * 仅 kind === 'regex' 时有效：对**完整 rel** 还是对 **basename** 做匹配。
   * 内置文件名黑名单（如 `^package-lock\.json$`）是按 basename 判定的，`/x/package-lock.json` 也算。
   */
  matchOn: 'rel' | 'name';
  /** 规则在整个序列里的序号：「最后命中者胜」用它比较，不必按序全扫。 */
  ord: number;
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

/**
 * 给一条 pattern 挑最快的判定方式（等价性由 tests/ignore.test.ts 覆盖）。
 * 注意 `*.log` 只有在**非锚定**时才等价于「文件名以 .log 结尾」：锚定的 `/*.log` 里 `*` 不跨 `/`。
 */
function classify(pattern: string, anchored: boolean): { kind: RuleKind; key: string; re: RegExp | null } {
  const magic = /[*?[\]\\]/.test(pattern);
  if (!magic && !anchored) return { kind: 'name', key: pattern, re: null };
  if (!magic) return { kind: 'literal', key: pattern, re: null };
  if (!anchored) {
    const suffix = /^\*((?:\.[^*?[\]\\/]+)+)$/.exec(pattern);
    if (suffix) return { kind: 'suffix', key: suffix[1], re: null };
  }
  const body = globBody(pattern);
  return { kind: 'regex', key: '', re: new RegExp(anchored ? `^${body}$` : `(^|.*/)${body}$`) };
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
    const { kind, key, re } = classify(pattern, anchored);
    out.push({ negate, dirOnly, source, kind, key, re, matchOn: 'rel', ord: 0 });
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

  /** 规则分桶（见文件头「性能」一节）：序号即优先级，取命中里 ord 最大的那条。 */
  private byName = new Map<string, IgnoreRule[]>();
  private bySuffix = new Map<string, IgnoreRule[]>();
  private byLiteral = new Map<string, IgnoreRule[]>();
  private regexRules: IgnoreRule[] = [];
  /** 目录判定缓存：rel → 结果（规则不变即有效，reload 时清空）。 */
  private readonly dirCache = new Map<string, Verdict>();

  constructor(builtin = IGNORE_BUILTIN) {
    this.builtinEnabled = builtin;
    this.pushBuiltin();
    this.reindex();
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
    this.reindex();
  }

  private pushBuiltin() {
    if (!this.builtinEnabled) return;
    for (const name of IGNORED_DIRS) {
      this.rules.push({
        negate: false, dirOnly: true, source: null, kind: 'name', key: name, re: null, matchOn: 'name', ord: 0,
      });
    }
    // 内置文件名模式按 **basename** 判定（`^package-lock\.json$` 对 `x/package-lock.json` 也要命中）
    for (const re of IGNORED_FILE_PATTERNS) {
      this.rules.push({
        negate: false, dirOnly: false, source: null, kind: 'regex', key: '', re, matchOn: 'name', ord: 0,
      });
    }
  }

  /** 重建分桶与序号（规则集任何变化后都要调）。 */
  private reindex() {
    this.byName.clear();
    this.bySuffix.clear();
    this.byLiteral.clear();
    this.regexRules = [];
    this.dirCache.clear();
    const push = (map: Map<string, IgnoreRule[]>, key: string, rule: IgnoreRule) => {
      const list = map.get(key);
      if (list) list.push(rule);
      else map.set(key, [rule]);
    };
    this.rules.forEach((rule, ord) => {
      rule.ord = ord;
      if (rule.kind === 'name') push(this.byName, rule.key, rule);
      else if (rule.kind === 'suffix') push(this.bySuffix, rule.key, rule);
      else if (rule.kind === 'literal') push(this.byLiteral, rule.key, rule);
      else this.regexRules.push(rule);
    });
  }

  /** 目录是否忽略（rel 为目录相对路径，name 为最后一段）。 */
  ignoresDir(rel: string, name: string): boolean {
    if (HARD_PROTECTED.has(name)) return true;
    // 同一目录会被它下面每个文件问到一次：首次算完就留下（父目录被忽略时整棵剪枝）
    const cached = this.dirCache.get(rel);
    if (cached) return cached.ignored;
    const verdict = this.decide(rel, name, true);
    if (verdict.overridden) this.noteOverridden(rel);
    if (this.dirCache.size >= MAX_DIR_CACHE) this.dirCache.clear();
    this.dirCache.set(rel, verdict);
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
      const cached = this.dirCache.get(prefix);
      if (cached ? cached.ignored : this.ignoresDir(prefix, seg)) return true;
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

  /**
   * 判定：取**最后一条命中的规则**（顺序即优先级）。
   *
   * 与改造前逐条遍历等价，但命中来源按类别分开取，最后比 ord：
   * `ignored` = 最后命中者是排除；`overridden` = 最后命中者是取反、且它之前有过排除命中。
   */
  private decide(rel: string, name: string, isDir: boolean): Verdict {
    let bestOrd = -1;
    let bestNegate = false;
    /** 最早的「排除」命中序号：只有它早于最终命中的取反规则时才算 overridden。 */
    let firstExcludeOrd = -1;

    const hit = (rule: IgnoreRule) => {
      if (rule.dirOnly && !isDir) return;
      if (rule.ord > bestOrd) {
        bestOrd = rule.ord;
        bestNegate = rule.negate;
      }
      if (!rule.negate && (firstExcludeOrd < 0 || rule.ord < firstExcludeOrd)) {
        firstExcludeOrd = rule.ord;
      }
    };

    for (const rule of this.byName.get(name) ?? []) hit(rule);
    // `*.a.b` 这类后缀规则：枚举文件名的每一段后缀（'.a.b' 与 '.b' 各自的桶都查）
    for (let dot = name.indexOf('.'); dot >= 0; dot = name.indexOf('.', dot + 1)) {
      const bucket = this.bySuffix.get(name.slice(dot));
      if (bucket) for (const rule of bucket) hit(rule);
    }
    for (const rule of this.byLiteral.get(rel) ?? []) hit(rule);
    for (const rule of this.regexRules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.re!.test(rule.matchOn === 'name' ? name : rel)) hit(rule);
    }

    return {
      ignored: bestOrd >= 0 && !bestNegate,
      overridden: bestNegate && firstExcludeOrd >= 0 && firstExcludeOrd < bestOrd,
    };
  }

  private noteOverridden(rel: string) {
    if (this.overridden.includes(rel) || this.overridden.length >= 40) return;
    this.overridden.push(rel);
  }
}
