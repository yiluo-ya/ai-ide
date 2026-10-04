/**
 * 设置面板（P24 的入口）：外观 / 编辑器 / 界面 / 索引 / 关于，全部落 `wcr:prefs` 并即时生效。
 *
 * 无障碍（P25）：主题是 `role="radiogroup"` + `role="radio" aria-checked` 的按钮组，缩进同款；
 * 字号 / 侧栏宽是原生 range（带 aria-label），语言是原生 select，开关是原生 checkbox；
 * Esc 关闭由 Dialog 统一负责。
 *
 * 模型配置**不在这里**：2026-10-03 用户要求把它提出来，与设置在顶栏平级（见 ModelDialog）。
 */
import { useEffect, useId, useState } from 'react';
import { api, type AgentRuntimeStatus } from './api';
import { Dialog } from './Dialog';
import { useI18n } from './i18n';
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  TAB_SIZES,
  savePrefs,
  usePrefs,
  type ThemeMode,
} from './prefs';

const THEMES: ThemeMode[] = ['dark', 'light', 'system'];

const THEME_KEY: Record<ThemeMode, string> = {
  dark: 'settings.themeDark',
  light: 'settings.themeLight',
  system: 'settings.themeSystem',
};

/** pi 的解析来源 → 文案（来源由后端给枚举，文案在前端，免得英文界面里混中文）。 */
const AGENT_SOURCE_KEY: Record<AgentRuntimeStatus['pi']['source'], string> = {
  env: 'settings.agentSourceEnv',
  config: 'settings.agentSourceConfig',
  agents: 'settings.agentSourceAgents',
  path: 'settings.agentSourcePath',
};

/** 键位说明表（与顶栏「?」同一份口径，改这里时两处一起改）。 */
const SHORTCUTS: Array<{ keys: string; label: string }> = [
  { keys: 'F12 / Ctrl+F12', label: 'topbar.shortcutGotoDef' },
  { keys: 'Shift+F12', label: 'topbar.shortcutFindRefs' },
  { keys: 'Ctrl/Cmd+P', label: 'topbar.shortcutFileSearch' },
  { keys: 'Ctrl/Cmd+T', label: 'topbar.shortcutSymbolSearch' },
  { keys: 'Ctrl/Cmd+Shift+F', label: 'topbar.shortcutProjectSearch' },
  { keys: 'Ctrl/Cmd+Shift+O', label: 'topbar.shortcutOutline' },
  { keys: 'Ctrl/Cmd+1..9', label: 'topbar.shortcutSidePanels' },
  { keys: 'Ctrl/Cmd+0', label: 'topbar.shortcutAnnotations' },
  { keys: 'Alt+← / Alt+→', label: 'topbar.shortcutBackForward' },
  { keys: 'Ctrl/Cmd+G', label: 'topbar.shortcutGotoLine' },
  { keys: 'Ctrl/Cmd+F', label: 'topbar.shortcutFileSearchIn' },
  { keys: 'Ctrl/Cmd+,', label: 'topbar.shortcutSettings' },
];

/** 原生 checkbox 开关（label 包住，点文字也能切）。 */
function Toggle({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="settings-row">
      <label className="settings-label" htmlFor={id}>
        {label}
      </label>
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </div>
  );
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { t, locale } = useI18n();
  const prefs = usePrefs();
  const themeLabelId = useId();
  const fontSizeId = useId();
  const localeId = useId();
  const sidebarId = useId();
  const wrapId = useId();
  const minimapId = useId();
  const whitespaceId = useId();
  const motionId = useId();
  const changesId = useId();
  const agentPathId = useId();

  /** 服务自述里的版本号（拿不到就不显示这一行）。 */
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .manifest()
      .then((m) => {
        if (!cancelled) setVersion(m.version);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /** 自定义忽略规则：后端 data 目录里一份，对所有项目生效。 */
  const [ignoreText, setIgnoreText] = useState('');
  const [ignoreNote, setIgnoreNote] = useState<string | null>(null);
  const [savingIgnore, setSavingIgnore] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api
      .customIgnore()
      .then((r) => {
        if (!cancelled) setIgnoreText(r.text);
      })
      .catch(() => {
        /* 旧后端没有这个端点：留空，不影响其它设置 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveIgnore = async () => {
    setSavingIgnore(true);
    setIgnoreNote(null);
    try {
      await api.saveCustomIgnore(ignoreText);
      setIgnoreNote(t('settings.ignoreRulesSaved'));
    } catch (e) {
      setIgnoreNote(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingIgnore(false);
    }
  };

  /** Code Agent 后端（FR-0007）：手填 pi 路径 → 落点目录 → PATH，保存后立即重探。 */
  const [agentStatus, setAgentStatus] = useState<AgentRuntimeStatus | null>(null);
  const [piPath, setPiPath] = useState('');
  const [agentNote, setAgentNote] = useState<string | null>(null);
  const [savingAgent, setSavingAgent] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api
      .agentRuntime()
      .then((r) => {
        if (cancelled) return;
        setAgentStatus(r);
        setPiPath(r.piPath);
      })
      .catch(() => {
        /* 旧后端没有这个端点：不显示这一块，不影响其它设置 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveAgent = async () => {
    setSavingAgent(true);
    setAgentNote(null);
    try {
      const r = await api.saveAgentRuntime(piPath);
      setAgentStatus(r);
      setAgentNote(t('settings.agentSaved'));
    } catch (e) {
      setAgentNote(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingAgent(false);
    }
  };

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
        <label className="settings-label" htmlFor={sidebarId}>
          {t('settings.sidebarWidth')}
        </label>
        <input
          id={sidebarId}
          type="range"
          min={SIDEBAR_MIN}
          max={SIDEBAR_MAX}
          step={10}
          value={prefs.sidebarWidth}
          aria-label={t('settings.sidebarWidthAria')}
          onChange={(e) => savePrefs({ sidebarWidth: Number(e.target.value) })}
        />
        <span className="settings-value">{prefs.sidebarWidth}px</span>
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

      <h3 className="wcr-section-title">{t('settings.editor')}</h3>
      <Toggle id={wrapId} label={t('settings.wrap')} checked={prefs.wrap} onChange={(v) => savePrefs({ wrap: v })} />

      <div className="settings-row">
        <span className="settings-label" id={`${wrapId}-tab`}>
          {t('settings.tabSize')}
        </span>
        <div className="settings-seg" role="radiogroup" aria-labelledby={`${wrapId}-tab`}>
          {TAB_SIZES.map((size) => (
            <button
              key={size}
              type="button"
              role="radio"
              aria-checked={prefs.tabSize === size}
              className={`settings-seg-btn${prefs.tabSize === size ? ' on' : ''}`}
              onClick={() => savePrefs({ tabSize: size })}
            >
              {size}
            </button>
          ))}
        </div>
      </div>

      <Toggle
        id={minimapId}
        label={t('settings.minimap')}
        checked={prefs.minimap}
        onChange={(v) => savePrefs({ minimap: v })}
      />
      <Toggle
        id={whitespaceId}
        label={t('settings.whitespace')}
        checked={prefs.whitespace}
        onChange={(v) => savePrefs({ whitespace: v })}
      />

      <h3 className="wcr-section-title">{t('settings.interface')}</h3>
      <Toggle
        id={motionId}
        label={t('settings.reduceMotion')}
        checked={prefs.reduceMotion}
        onChange={(v) => savePrefs({ reduceMotion: v })}
      />
      <Toggle
        id={changesId}
        label={t('settings.changesOpen')}
        checked={prefs.changesOpen}
        onChange={(v) => savePrefs({ changesOpen: v })}
      />

      <h3 className="wcr-section-title">{t('settings.indexSection')}</h3>
      <h4 className="settings-subtitle">{t('settings.ignoreRules')}</h4>
      <p className="wcr-note">{t('settings.ignoreRulesHint')}</p>
      <textarea
        className="text-input settings-ignore"
        rows={4}
        aria-label={t('settings.ignoreRules')}
        placeholder={t('settings.ignoreRulesEmpty')}
        value={ignoreText}
        onChange={(e) => setIgnoreText(e.target.value)}
      />
      <div className="settings-actions">
        <button className="btn" disabled={savingIgnore} onClick={() => void saveIgnore()}>
          {t('settings.ignoreRulesSave')}
        </button>
        {ignoreNote && <span className="settings-note">{ignoreNote}</span>}
      </div>

      <h3 className="wcr-section-title">{t('settings.agentSection')}</h3>
      <p className="wcr-note">{t('settings.agentHint')}</p>
      <div className="settings-row">
        <label className="settings-label" htmlFor={agentPathId}>
          {t('settings.agentPath')}
        </label>
        <input
          id={agentPathId}
          className="text-input settings-agent-input"
          type="text"
          spellCheck={false}
          placeholder={t('settings.agentPathEmpty')}
          value={piPath}
          onChange={(e) => setPiPath(e.target.value)}
        />
      </div>
      <div className="settings-actions">
        <button className="btn" disabled={savingAgent} onClick={() => void saveAgent()}>
          {t('settings.agentSave')}
        </button>
        {agentNote && <span className="settings-note">{agentNote}</span>}
      </div>

      {agentStatus && (
        <>
          <div className="settings-row">
            <span className="settings-label">{t('settings.agentStatus')}</span>
            <span className="settings-value">
              {agentStatus.pi.available ? t('settings.agentAvailable') : t('settings.agentUnavailable')}
              {agentStatus.pi.version ? ` · ${agentStatus.pi.version}` : ''}
            </span>
          </div>
          <div className="settings-row">
            <span className="settings-label">{t('settings.agentSource')}</span>
            <span className="settings-value settings-wrap">
              {`${t(AGENT_SOURCE_KEY[agentStatus.pi.source])} · ${agentStatus.pi.label}`}
            </span>
          </div>
          {agentStatus.pi.error && <p className="wcr-note">{agentStatus.pi.error}</p>}
          <p className="wcr-note">{t('settings.agentInstallHint', { dir: agentStatus.hint.dir })}</p>
          <code className="settings-cmd">{agentStatus.hint.globalCommand}</code>
          <code className="settings-cmd">{agentStatus.hint.prefixCommand}</code>
          <p className="wcr-note">{t('settings.agentOpenhands', { dir: agentStatus.openhands.dir })}</p>
        </>
      )}

      <h3 className="wcr-section-title">{t('settings.about')}</h3>
      <div className="settings-row">
        <span className="settings-label">{t('settings.version')}</span>
        <span className="settings-value">{version ?? t('settings.versionUnknown')}</span>
      </div>
      <details className="settings-shortcuts">
        <summary>{t('settings.shortcuts')}</summary>
        <ul>
          {SHORTCUTS.map((s) => (
            <li key={s.keys}>
              <span className="settings-keys">{s.keys}</span>
              {t(s.label)}
            </li>
          ))}
        </ul>
      </details>
    </Dialog>
  );
}
