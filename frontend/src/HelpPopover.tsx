/**
 * 快捷键与配色说明浮层。
 *
 * 2026-10-15：入口从顶栏右侧搬到了左下（左侧活动栏底部的「快捷键」图标），
 * 浮层也就跟到左下、向上弹出（定位见 styles.css 的 .help-popover）。
 * 内容与之前顶栏里那份完全一致（快捷键表 + 语义着色图例 + 更多）。
 */
import { useEffect } from 'react';
import { useI18n } from './i18n';

export function HelpPopover({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();

  // Esc 关闭（P25 无障碍）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="help-popover" role="dialog" aria-label={t('topbar.help')}>
      <div className="help-title">{t('topbar.helpTitle')}</div>
      <ul>
        <li>
          <kbd>F12</kbd> / <kbd>Ctrl</kbd>+<kbd>F12</kbd> {t('topbar.shortcutGotoDef')}
        </li>
        <li>
          <kbd>Shift</kbd>+<kbd>F12</kbd> {t('topbar.shortcutFindRefs')}
        </li>
        <li>
          <kbd>Ctrl/Cmd</kbd>+<kbd>P</kbd> {t('topbar.shortcutFileSearch')}
        </li>
        <li>
          <kbd>Ctrl/Cmd</kbd>+<kbd>T</kbd> {t('topbar.shortcutSymbolSearch')}
        </li>
        <li>
          <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> {t('topbar.shortcutProjectSearch')}
        </li>
        <li>
          <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd> {t('topbar.shortcutOutline')}
        </li>
        <li>
          <kbd>Ctrl/Cmd</kbd>+<kbd>1..9</kbd> {t('topbar.shortcutSidePanels')}
        </li>
        <li>
          <kbd>Ctrl/Cmd</kbd>+<kbd>0</kbd> {t('topbar.shortcutAnnotations')}
        </li>
        <li>
          <kbd>Alt</kbd>+<kbd>←</kbd> / <kbd>Alt</kbd>+<kbd>→</kbd> {t('topbar.shortcutBackForward')}
        </li>
        <li>
          <kbd>Ctrl/Cmd</kbd>+<kbd>G</kbd> {t('topbar.shortcutGotoLine')}
        </li>
        <li>
          <kbd>Ctrl/Cmd</kbd>+<kbd>F</kbd> {t('topbar.shortcutFileSearchIn')}
        </li>
      </ul>
      <div className="help-title legend-title">{t('topbar.legendTitle')}</div>
      <ul className="legend">
        <li>
          <span className="swatch swatch-project">name</span>
          {t('topbar.legendProject')}
        </li>
        <li>
          <span className="swatch swatch-local">local_var</span>
          {t('topbar.legendLocal')}
        </li>
        <li>
          <span className="swatch swatch-external">os.path</span>
          {t('topbar.legendExternal')}
        </li>
      </ul>
      <div className="help-title legend-title">{t('topbar.helpSectionMore')}</div>
      <ul>
        <li>
          <kbd>Ctrl/Cmd</kbd>+<kbd>,</kbd> {t('topbar.shortcutSettings')}
        </li>
      </ul>
    </div>
  );
}
