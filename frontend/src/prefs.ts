/**
 * 界面偏好（P24 / Q14）的唯一真相：主题 · 字号 · 侧栏宽 · 语言 + 编辑器 / 界面细项。
 *
 * 纪律：
 * 1) 只写一个 localStorage 键 `wcr:prefs`，与项目无关（不分片）；
 *    项目相关的键（搜索历史 / 位置 / 书签 / map-marks）仍归 state.ts / mapState.ts 自己管。
 * 2) 读取一律容错：坏 JSON、越界数字、未知枚举都回落默认，绝不让一条脏数据把界面卡住。
 * 3) 展示层只认 CSS 变量与 `data-theme`（applyPrefs），组件订阅 subscribePrefs。
 * 4) 结构带版本号：字段口径变了就加一条 MIGRATIONS + 把 PREFS_VERSION 加一，
 *    老数据在 readStored() 里逐级迁移后回写（见 MIGRATIONS）。
 */

import { useSyncExternalStore } from 'react';
import { translate } from './i18n';
import type { KeymapId } from './keymap';

export type ThemeMode = 'dark' | 'light' | 'system';
export type Locale = 'zh' | 'en';

export interface Prefs {
  /** 结构版本：读存量数据时用它选迁移链的起点（见 MIGRATIONS）。 */
  version: number;
  theme: ThemeMode;
  fontSize: number;
  sidebarWidth: number;
  locale: Locale;
  /** 编辑器：自动换行。 */
  wrap: boolean;
  /** 编辑器：缩进宽度（空格数）。 */
  tabSize: number;
  /** 编辑器：显示 minimap。 */
  minimap: boolean;
  /** 编辑器：显示空白字符与缩进参考线。 */
  whitespace: boolean;
  /** 界面：动效减弱（关掉过渡 / 动画）。 */
  reduceMotion: boolean;
  /** 界面：右侧变更栏默认展开。 */
  changesOpen: boolean;
  /** 键盘映射方案（VS Code / IDEA），默认 IDEA，见 keymap.ts。 */
  keymap: KeymapId;
  /** FR-0011：跑 Python 用的解释器绝对路径；空 = 自动探测项目 venv，再退回 PATH。 */
  pythonPath: string;
  /** FR-0012：打开文件时自动在文件树里定位（展开祖先链 + 滚动 + 闪烁）。 */
  autoReveal: boolean;
}

export const PREFS_KEY = 'wcr:prefs';
/** 当前偏好结构版本：以后改字段口径（改名 / 改语义 / 删字段）就加一，并在 MIGRATIONS 补一条。 */
export const PREFS_VERSION = 3;
export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 18;
export const SIDEBAR_MIN = 240;
export const SIDEBAR_MAX = 560;
/** 缩进宽度可选值（编辑器设置里只给这三档）。 */
export const TAB_SIZES = [2, 4, 8] as const;

export const DEFAULT_PREFS: Prefs = {
  version: PREFS_VERSION,
  theme: 'dark',
  fontSize: 13,
  sidebarWidth: 320,
  locale: 'zh',
  wrap: false,
  tabSize: 4,
  minimap: true,
  whitespace: false,
  reduceMotion: false,
  changesOpen: true,
  keymap: 'idea',
  pythonPath: '',
  autoReveal: true,
};

type Listener = (prefs: Prefs) => void;
const listeners = new Set<Listener>();

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 解析 version 字段：非负整数；缺失 / 非法回落 fallback（迁移用 0，收敛已有数据用当前版本）。 */
function normalizeVersion(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** 把任意来源的原始值收敛成合法偏好（容错读的唯一入口）。 */
function coerce(raw: unknown): Prefs {
  const src = isPlainObject(raw) ? raw : {};
  const theme: ThemeMode =
    src.theme === 'light' || src.theme === 'dark' || src.theme === 'system' ? src.theme : DEFAULT_PREFS.theme;
  const locale: Locale = src.locale === 'en' ? 'en' : 'zh';
  return {
    version: normalizeVersion(src.version, PREFS_VERSION),
    theme,
    locale,
    fontSize: clampInt(src.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, DEFAULT_PREFS.fontSize),
    sidebarWidth: clampInt(src.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX, DEFAULT_PREFS.sidebarWidth),
    wrap: src.wrap === true,
    tabSize: clampInt(src.tabSize, 2, 8, DEFAULT_PREFS.tabSize),
    minimap: src.minimap !== false,
    whitespace: src.whitespace === true,
    reduceMotion: src.reduceMotion === true,
    changesOpen: src.changesOpen !== false,
    keymap: src.keymap === 'vscode' ? 'vscode' : 'idea',
    pythonPath: typeof src.pythonPath === 'string' ? src.pythonPath.trim() : DEFAULT_PREFS.pythonPath,
    autoReveal: src.autoReveal !== false,
  };
}

/**
 * 迁移链：键 = 「从哪个版本升」，值 = 把该版本的原始数据搬到下一版。
 *
 * 纪律：以后改字段口径（改名 / 改语义 / 删字段）就在这里加一条，并把 PREFS_VERSION 加一。
 * 例（升到 v2 时）：
 *   MIGRATIONS[1] = (raw) => { const o = raw as Record<string, unknown>; return { ...o, fontSize: o.editorFontSize }; };
 * 迁移函数只管搬字段，类型收敛仍归 coerce()；抛异常由 migrate() 兜成默认值。
 */
const MIGRATIONS: Record<number, (raw: unknown) => unknown> = {
  // v0 → v1：没有 version 键的存量数据，字段口径与 v1 一致，原样保留（坏数据换成默认值）。
  0: (raw) => (isPlainObject(raw) ? raw : { ...DEFAULT_PREFS }),
  // v1 → v2：新增 pythonPath（FR-0011）——老数据没这一项，缺省由 coerce 补空串。
  1: (raw) => (isPlainObject(raw) ? raw : { ...DEFAULT_PREFS }),
  // v2 → v3：新增 autoReveal（FR-0012）——老数据缺省为 true，由 coerce 默认开。
  2: (raw) => (isPlainObject(raw) ? raw : { ...DEFAULT_PREFS }),
};

/** 存量数据声明的版本：缺失 / 非法按 0（迁移链起点）处理。 */
function storedVersionOf(raw: unknown): number {
  return isPlainObject(raw) ? normalizeVersion(raw.version, 0) : 0;
}

/**
 * 把存量数据升到当前版本：从数据声明的版本起逐级跑 MIGRATIONS，末尾补上 version。
 * 已是最新（或来自更高版本，可能是被新版写过）则原样返回且 changed=false，不触发回写。
 */
function migrate(raw: unknown): { data: unknown; changed: boolean } {
  let version = storedVersionOf(raw);
  if (version >= PREFS_VERSION) return { data: raw, changed: false };
  let data: unknown = raw;
  while (version < PREFS_VERSION) {
    const step = MIGRATIONS[version];
    if (step) {
      try {
        data = step(data);
      } catch {
        data = { ...DEFAULT_PREFS };
        break;
      }
    }
    version += 1;
  }
  const base = isPlainObject(data) ? data : { ...DEFAULT_PREFS };
  return { data: { ...base, version: PREFS_VERSION }, changed: true };
}

/** 把偏好写回 localStorage（失败忽略：隐私模式 / 配额满不该打断阅读）。 */
function writeBack(data: unknown): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(data));
  } catch {
    /* 忽略 */
  }
}

function readStored(): Prefs {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(PREFS_KEY);
  } catch {
    return { ...DEFAULT_PREFS };
  }
  if (!raw) return { ...DEFAULT_PREFS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_PREFS }; // 坏 JSON：回落默认，不回写（别拿垃圾盖掉可能还能救的数据）
  }
  const { data, changed } = migrate(parsed);
  if (changed) writeBack(data);
  return coerce(data);
}

let current: Prefs = readStored();

/** 当前偏好（同步读；不碰 localStorage）。 */
export function loadPrefs(): Prefs {
  return current;
}

/** 系统是否偏好亮色（theme = 'system' 时用）。 */
export function systemTheme(): 'dark' | 'light' {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** 把 theme 偏好解析成真正生效的主题。 */
export function resolvedTheme(mode: ThemeMode = current.theme): 'dark' | 'light' {
  return mode === 'system' ? systemTheme() : mode;
}

let systemWatcher: MediaQueryList | null = null;

function watchSystemTheme(): void {
  if (typeof window === 'undefined' || !window.matchMedia || systemWatcher) return;
  systemWatcher = window.matchMedia('(prefers-color-scheme: light)');
  systemWatcher.addEventListener('change', () => {
    if (current.theme === 'system') {
      applyPrefs(current);
      notify();
    }
  });
}

/** 把偏好写到 :root：data-theme + CSS 变量 + <html lang>；纯展示层，不触发订阅回调。 */
export function applyPrefs(prefs: Prefs = current): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme(prefs.theme);
  root.style.setProperty('--ui-font-size', `${prefs.fontSize}px`);
  root.style.setProperty('--sidebar-width', `${prefs.sidebarWidth}px`);
  // 动效减弱：由 CSS 用 [data-motion='reduced'] 关掉过渡与动画
  root.dataset.motion = prefs.reduceMotion ? 'reduced' : 'full';
  root.lang = prefs.locale === 'zh' ? 'zh-CN' : 'en';
  document.title = translate('app.title', undefined, prefs.locale);
  if (prefs.theme === 'system') watchSystemTheme();
}

function notify(): void {
  for (const cb of listeners) cb(current);
}

/** 合并保存一个 patch：收敛 → 落盘 → 应用 → 通知订阅者。 */
export function savePrefs(patch: Partial<Prefs>): Prefs {
  current = coerce({ ...current, ...patch });
  writeBack(current);
  applyPrefs(current);
  notify();
  return current;
}

/** 订阅偏好变化（非组件环境用）；返回取消函数。 */
export function subscribePrefs(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** 组件里用：订阅整个偏好对象（任一字段变化即重渲染）。 */
export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribePrefs, loadPrefs, loadPrefs);
}
