/**
 * i18n（P25）：`t(key, params?)` + `useI18n()`，语言存在 prefs 里（`wcr:prefs.locale`）。
 *
 * 约定：
 * - 默认中文；
 * - key 找不到时回落中文，再回落 key 本身（宁可显示 key，也不显示空白）；
 * - `{name}` 占位符由 params 替换，缺参保留原样（便于发现漏传）。
 */
import { useCallback, useSyncExternalStore } from 'react';
import { loadPrefs, savePrefs, subscribePrefs, type Locale } from '../prefs';
import { en } from './en';
import { zh } from './zh';

export type { Locale };

export type TParams = Record<string, string | number>;
export type TFunc = (key: string, params?: TParams) => string;

const DICT: Record<Locale, Record<string, string>> = { zh, en };

/** 纯函数翻译（非组件环境、title 属性里也能用）。 */
export function translate(key: string, params?: TParams, locale: Locale = loadPrefs().locale): string {
  const raw = DICT[locale][key] ?? zh[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/** 切换语言：落进 prefs（顺带把 <html lang> 与标题改掉）。 */
export function setLocale(locale: Locale): void {
  savePrefs({ locale });
}

/** 组件里用：locale 变化会触发重渲染；`t` / `setLocale` 引用稳定（可安全进 deps）。 */
export function useI18n(): { locale: Locale; t: TFunc; setLocale: (locale: Locale) => void } {
  const locale = useSyncExternalStore(
    subscribePrefs,
    () => loadPrefs().locale,
    () => loadPrefs().locale,
  );
  // t 必须缓存：否则每次渲染都是新函数，把它放进 deps 的 useCallback / useEffect 会全部失效
  const t = useCallback<TFunc>((key, params) => translate(key, params, locale), [locale]);
  return { locale, setLocale, t };
}
