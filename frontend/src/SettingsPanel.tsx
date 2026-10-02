/**
 * 设置面板（P24 的入口）：主题 / 字号 / 语言，全部落 `wcr:prefs` 并即时生效。
 *
 * 无障碍（P25）：主题是一组 `role="radiogroup"` + `role="radio" aria-checked` 的按钮，
 * 字号是原生 range（带 aria-label），语言是原生 select；Esc 关闭由 Dialog 统一负责。
 */
import { useId } from 'react';
import { Dialog } from './Dialog';
import { useI18n } from './i18n';
import { FONT_SIZE_MAX, FONT_SIZE_MIN, savePrefs, usePrefs, type ThemeMode } from './prefs';

const THEMES: ThemeMode[] = ['dark', 'light', 'system'];

const THEME_KEY: Record<ThemeMode, string> = {
  dark: 'settings.themeDark',
  light: 'settings.themeLight',
  system: 'settings.themeSystem',
};

export function SettingsPanel({
  onClose,
  onOpenPrivacy,
  onOpenReport,
}: {
  onClose: () => void;
  onOpenPrivacy: () => void;
  /** 后端提供索引报告端点时才传（拿不到就隐藏入口，不报错）。 */
  onOpenReport?: () => void;
}) {
  const { t, locale } = useI18n();
  const prefs = usePrefs();
  const themeLabelId = useId();
  const fontSizeId = useId();
  const localeId = useId();

  return (
    <Dialog title={t('settings.title')} onClose={onClose}>
      <h3 className="wcr-section-title">{t('settings.appearance')}</h3>

      <div className="settings-row">
        <span className="settings-label" id={themeLabelId}>
          {t('settings.theme')}
        </span>
        <div className="settings-seg" role="radiogroup" aria-labelledby={themeLabelId}>
          {THEMES.map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={prefs.theme === mode}
              className={`settings-seg-btn${prefs.theme === mode ? ' on' : ''}`}
              onClick={() => savePrefs({ theme: mode })}
            >
              {t(THEME_KEY[mode])}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-row">
        <label className="settings-label" htmlFor={fontSizeId}>
          {t('settings.fontSize')}
        </label>
        <input
          id={fontSizeId}
          type="range"
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={1}
          value={prefs.fontSize}
          aria-label={t('settings.fontSizeAria')}
          onChange={(e) => savePrefs({ fontSize: Number(e.target.value) })}
        />
        <span className="settings-value">{prefs.fontSize}px</span>
      </div>

      <div className="settings-row">
        <label className="settings-label" htmlFor={localeId}>
          {t('settings.language')}
        </label>
        <select
          id={localeId}
          className="project-select"
          value={locale}
          onChange={(e) => savePrefs({ locale: e.target.value === 'en' ? 'en' : 'zh' })}
        >
          <option value="zh">{t('settings.localeZh')}</option>
          <option value="en">{t('settings.localeEn')}</option>
        </select>
      </div>

      <h3 className="wcr-section-title">{t('topbar.helpSectionMore')}</h3>
      <div className="settings-actions">
        <button className="btn ghost" onClick={onOpenPrivacy}>
          {t('settings.privacyEntry')}
        </button>
        {onOpenReport && (
          <button className="btn ghost" onClick={onOpenReport}>
            {t('settings.indexReport')}
          </button>
        )}
      </div>
    </Dialog>
  );
}
