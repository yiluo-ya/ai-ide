/**
 * 界面偏好（P24 / Q14）的唯一真相：主题 · 字号 · 侧栏宽 · 语言。
 *
 * 纪律：
 * 1) 只写一个 localStorage 键 `wcr:prefs`，与项目无关（不分片）；
 *    项目相关的键（搜索历史 / 位置 / 书签 / map-marks）仍归 state.ts / mapState.ts 自己管。
 * 2) 读取一律容错：坏 JSON、越界数字、未知枚举都回落默认，绝不让一条脏数据把界面卡住。
 * 3) 展示层只认 CSS 变量与 `data-theme`（applyPrefs），组件订阅 subscribePrefs。
 */

import { useSyncExternalStore } from 'react';

export type ThemeMode = 'dark' | 'light' | 'system';
export type Locale = 'zh' | 'en';

export interface Prefs {
  theme: ThemeMode;
  fontSize: number;
  sidebarWidth: number;
  locale: Locale;
}

export const PREFS_KEY = 'wcr:prefs';
export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 18;
export const SIDEBAR_MIN = 240;
export const SIDEBAR_MAX = 560;

export const DEFAULT_PREFS: Prefs = {
  theme: 'dark',
  fontSize: 13,
  sidebarWidth: 320,
  locale: 'zh',
};

type Listener = (prefs: Prefs) => void;
const listeners = new Set<Listener>();

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 把任意来源的原始值收敛成合法偏好（容错读的唯一入口）。 */
function coerce(raw: unknown): Prefs {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const theme: ThemeMode =
    src.theme === 'light' || src.theme === 'dark' || src.theme === 'system' ? src.theme : DEFAULT_PREFS.theme;
  const locale: Locale = src.locale === 'en' ? 'en' : 'zh';
  return {
    theme,
    locale,
    fontSize: clampInt(src.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, DEFAULT_PREFS.fontSize),
    sidebarWidth: clampInt(src.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX, DEFAULT_PREFS.sidebarWidth),
  };
}

function readStored(): Prefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    return coerce(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_PREFS };
  }
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
  root.lang = prefs.locale === 'zh' ? 'zh-CN' : 'en';
  document.title = prefs.locale === 'en' ? 'Web Code Reader' : '代码阅读器';
  if (prefs.theme === 'system') watchSystemTheme();
}

function notify(): void {
  for (const cb of listeners) cb(current);
}

/** 合并保存一个 patch：收敛 → 落盘 → 应用 → 通知订阅者。 */
export function savePrefs(patch: Partial<Prefs>): Prefs {
  current = coerce({ ...current, ...patch });
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(current));
  } catch {
    /* 隐私模式 / 配额满：本次只用内存值，不打断阅读 */
  }
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
