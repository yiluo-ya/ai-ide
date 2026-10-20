/**
 * 配色主题清单（界面 + 编辑器共用一份 id）。
 *
 * 纪律：
 * 1) 这里只放「元数据」：id、显示名（i18n key）、明暗基调。具体颜色分两处落地 ——
 *    界面在 styles.css（`[data-theme='<id>']` 块，浅色基线在 `[data-tone='light']`），
 *    编辑器在 code-themes.ts（Monaco 的 colors + token rules）。
 * 2) `tone` 只影响两件事：`color-scheme` 与浅色基线变量块；主题自己的主色永远在自己块里写。
 * 3) 新增主题的三步：这里加一条 → styles.css 加主色块 → code-themes.ts 加一套 Monaco 配色。
 *
 * 许可：One Dark / One Light 的色板来自 Atom 的 atom/one-dark-syntax、atom/one-light-syntax（MIT，
 * Copyright (c) 2014 GitHub Inc.），Darcula / New UI Dark 来自 JetBrains 的 IntelliJ 内置主题，
 * Material Palenight 来自 material-theme（MIT），Nord 来自 nordtheme/nord（MIT），
 * Catppuccin 来自 catppuccin（MIT）。
 * 只借用了配色值（颜色与色值组合不受版权保护），未复制其主题代码；如需再分发，保留上述出处即可。
 */

export type ThemeTone = 'dark' | 'light';

/** 具体配色主题。`system` 不在这里 —— 它是「跟随系统」的选择，由 prefs 解析成其中之一。 */
export type ThemeId =
  | 'new-ui-dark'
  | 'dark'
  | 'light'
  | 'one-dark'
  | 'one-light'
  | 'darcula'
  | 'palenight'
  | 'nord'
  | 'catppuccin';

/** 默认主题（2026-10-20 用户拍板：默认用 IDEA New UI Dark）。 */
export const DEFAULT_THEME: ThemeId = 'new-ui-dark';

export interface ThemeMeta {
  id: ThemeId;
  /** i18n key（settings.theme<...>）。 */
  labelKey: string;
  tone: ThemeTone;
}

export const THEMES: readonly ThemeMeta[] = [
  { id: 'new-ui-dark', labelKey: 'settings.themeNewUiDark', tone: 'dark' },
  { id: 'dark', labelKey: 'settings.themeDark', tone: 'dark' },
  { id: 'light', labelKey: 'settings.themeLight', tone: 'light' },
  { id: 'one-dark', labelKey: 'settings.themeOneDark', tone: 'dark' },
  { id: 'one-light', labelKey: 'settings.themeOneLight', tone: 'light' },
  { id: 'darcula', labelKey: 'settings.themeDarcula', tone: 'dark' },
  { id: 'palenight', labelKey: 'settings.themePalenight', tone: 'dark' },
  { id: 'nord', labelKey: 'settings.themeNord', tone: 'dark' },
  { id: 'catppuccin', labelKey: 'settings.themeCatppuccin', tone: 'dark' },
] as const;

const BY_ID = new Map<string, ThemeMeta>(THEMES.map((t) => [t.id, t]));

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && BY_ID.has(value);
}

/** 按 id 取元数据；未知 id 兜底为默认主题（调用方通常已用 isThemeId 收敛过）。 */
export function themeMetaFor(id: ThemeId): ThemeMeta {
  return BY_ID.get(id) ?? BY_ID.get(DEFAULT_THEME) ?? THEMES[0];
}
