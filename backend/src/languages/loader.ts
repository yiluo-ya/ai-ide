/**
 * 语言插件加载器（07-languages-plugin L2 分发层）。
 *
 * 三条发现规则（先发现者优先；同 id 语言不再覆盖）：
 * 1. `<PLUGINS_DIR>/<name>/package.json` 且含 `wcr.lang` —— 手放的本地插件；
 * 2. `<PLUGINS_DIR>/node_modules/<pkg>/package.json` 且含 `wcr.lang` —— `wcr lang add` 装的；
 * 3. `<REPO_ROOT>/node_modules/<pkg>/package.json` 且含 `wcr.lang` —— 随仓库预装的官方语言包。
 *
 * 设计约束：
 * - **失败隔离**：任何插件（清单读不动 / 入口 import 失败 / 导出不合法）都只记一条错误并继续，
 *   绝不让服务起不来（见 tests/plugins.test.ts）；
 * - **不做热加载**：装完要重启（用户明确的预期，实现也简单）；
 * - **worker 一致**：`languages/index.ts` 顶层 await 调用本模块，parse-worker 也会各跑一遍
 *   （成本可接受，换来「worker 里语言集与主线程必然一致」）。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLUGINS_DIR, PLUGINS_ENABLED, PRESET_PLUGINS_ENABLED, REPO_ROOT } from '../config';
import { logInfo, logWarn } from '../log';
import type { LanguageSpec } from '../indexer/walker';
import type { PreviewLanguage } from './manifests';
import type { LanguagePlugin, MonacoContribution } from './plugin';

export interface PluginLoadError {
  /** 插件来源（目录路径或包名）。 */
  source: string;
  message: string;
}

export interface LoadTarget {
  /** 内置 spec 列表（插件往里追加）。 */
  specs: LanguageSpec[];
  /** 预览语言表（插件往里追加）。 */
  previews: PreviewLanguage[];
  /** 前端高亮贡献：Monaco 语言 + Monarch 语法（插件往里追加）。 */
  monaco: MonacoContribution[];
  /** 出错时写入这里（`/api/languages` 回给前端展示）。 */
  errors: PluginLoadError[];
}

export interface PluginCandidate {
  /** 展示用来源：包名（有 name 时）或目录名。 */
  source: string;
  /** 插件包目录。 */
  dir: string;
  /** 包名（读不到 package.json 的 name 时为空串）。 */
  pkgName: string;
  /** 入口文件绝对路径。 */
  entry: string;
}

/** 读一个目录的 `package.json`，取 `wcr.lang` 指向的入口；不是插件返回 null。 */
async function candidateOf(dir: string): Promise<PluginCandidate | null> {
  let pkg: { name?: unknown; wcr?: { lang?: unknown } };
  try {
    pkg = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null; // 没有 / 读不动 / 不是 JSON：静默跳过（目录里没有插件是常态）
  }
  const rel = pkg.wcr?.lang;
  if (typeof rel !== 'string' || !rel) return null;
  const pkgName = typeof pkg.name === 'string' ? pkg.name : '';
  return { source: pkgName || dir, dir, pkgName, entry: path.resolve(dir, rel) };
}

/**
 * 列出一个目录下的直接子目录（读不到就给空表）。
 * 软链 / Windows 的 junction 也算目录 —— `wcr lang link` 就是靠它做开发态插件的。
 */
async function subdirs(dir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        out.push(full);
        continue;
      }
      if (!e.isSymbolicLink()) continue;
      try {
        if ((await fsp.stat(full)).isDirectory()) out.push(full);
      } catch {
        /* 断链忽略 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 三条规则 → 候选插件列表（顺序即优先级）。`wcr lang` 子命令也用它做发现。 */
export async function discoverPlugins(): Promise<PluginCandidate[]> {
  const out: PluginCandidate[] = [];
  const seen = new Set<string>();
  const push = (c: PluginCandidate | null) => {
    if (!c || seen.has(c.entry)) return;
    seen.add(c.entry);
    out.push(c);
  };

  if (PLUGINS_ENABLED) {
    for (const dir of await subdirs(PLUGINS_DIR)) push(await candidateOf(dir));
    for (const dir of await subdirs(path.join(PLUGINS_DIR, 'node_modules'))) push(await candidateOf(dir));
  }
  if (PRESET_PLUGINS_ENABLED) {
    for (const dir of await subdirs(path.join(REPO_ROOT, 'node_modules'))) push(await candidateOf(dir));
  }
  return out;
}

/**
 * 发现并加载全部语言插件，把结果并入 `target`。
 * 本函数**不抛错**：任何失败都写进 `target.errors`。
 */
export async function loadLanguagePlugins(target: LoadTarget): Promise<void> {
  if (!PLUGINS_ENABLED && !PRESET_PLUGINS_ENABLED) return;
  const candidates = await discoverPlugins();
  if (!candidates.length) return;

  const loaded: string[] = [];
  const takenIds = new Set(target.specs.map((s) => String(s.id)));

  for (const cand of candidates) {
    try {
      const mod: Record<string, unknown> = await import(pathToFileURL(cand.entry).href);
      const raw = (mod.plugin ?? mod.default) as LanguagePlugin | undefined;
      const specs = [...(raw?.spec ? [raw.spec] : []), ...(raw?.specs ?? [])];
      if (!raw || typeof raw !== 'object' || (!specs.length && !raw.preview)) {
        throw new Error('插件入口没有导出 spec / specs / preview（见 languages/plugin.ts 契约）');
      }

      for (const s of specs) {
        const spec = withMeta(s, raw.meta);
        const id = String(spec.id);
        if (!id) throw new Error('spec.id 为空');
        if (takenIds.has(id)) {
          logWarn('languages.plugin.duplicate', { source: cand.source, id, note: '已注册，跳过' });
        } else {
          takenIds.add(id);
          target.specs.push(spec);
          loaded.push(id);
        }
      }
      for (const p of raw.preview ?? []) {
        if (p && p.id) target.previews.push(p);
      }
      if (raw.monaco?.id) {
        // Monaco 语言定义：只有 id 是硬要求，monarch / configuration 都由插件决定给不给
        target.monaco.push({ ...raw.monaco, monarch: normalizeMonarch(raw.monaco.monarch) });
        loaded.push(`monaco:${raw.monaco.id}`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      target.errors.push({ source: cand.source, message });
      logWarn('languages.plugin.failed', { source: cand.source, error: message });
    }
  }

  if (loaded.length) logInfo('languages.plugin.loaded', { count: loaded.length, ids: loaded.join(',') });
  if (target.errors.length) {
    logWarn('languages.plugin.errors', { count: target.errors.length });
  }
}

/**
 * Monarch 里的 JS 正则 → 字符串。
 *
 * 为什么需要：插件作者最自然的写法是正则字面量（`[/\/\/.*$/, 'comment']`），但插件定义要经
 * `/api/languages` 以 JSON 下发 —— `JSON.stringify(/x/)` 得到 `{}`，前端拿到就会报
 * 「rules must start with a match string or regular expression」。
 * 所以在这里就地转成字符串（Monaco 的字符串正则语义与字面量一致，只是不能带 flags）。
 *
 * 只改 tokenizer 里的规则首项与 `{ regex: ... }`，其它键（keywords / cases / next…）原样保留。
 */
function normalizeMonarch(monarch: unknown): unknown {
  if (!monarch || typeof monarch !== 'object') return monarch;
  const src = monarch as { tokenizer?: Record<string, unknown> };
  if (!src.tokenizer || typeof src.tokenizer !== 'object') return monarch;
  const tokenizer: Record<string, unknown> = {};
  for (const [state, rules] of Object.entries(src.tokenizer)) {
    tokenizer[state] = Array.isArray(rules) ? rules.map(normalizeMonarchRule) : rules;
  }
  return { ...src, tokenizer };
}

function normalizeMonarchRule(rule: unknown): unknown {
  if (rule instanceof RegExp) return rule.source;
  if (Array.isArray(rule) && rule.length > 0) return [normalizeMonarchRule(rule[0]), ...rule.slice(1)];
  if (rule && typeof rule === 'object' && 'regex' in (rule as Record<string, unknown>)) {
    const obj = { ...(rule as Record<string, unknown>) };
    obj.regex = normalizeMonarchRule(obj.regex);
    return obj;
  }
  return rule;
}

/** 把插件 `meta` 里前端的元数据补到 spec 上（spec 自己写了就以 spec 为准）。 */
function withMeta(spec: LanguageSpec, meta: LanguagePlugin['meta']): LanguageSpec {
  if (!meta) return spec;
  return {
    ...spec,
    monaco: spec.monaco ?? meta.monaco,
    fence: spec.fence ?? meta.fence,
    color: spec.color ?? meta.color,
  };
}
