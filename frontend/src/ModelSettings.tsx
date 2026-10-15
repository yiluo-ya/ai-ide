/**
 * 设置面板里的「模型」区块：内置 code-agent 用的 provider。
 *
 * 一个 provider = **API 类型**（协议形状，见 backend/src/agent/llm.ts）+ base URL + API key + 模型 id。
 * 2026-10-13 用户要求：类型可选（OpenAI 兼容 / Anthropic / OpenAI Responses / Gemini）、
 * base URL 有常见预设，并且**先「测试连接」再保存**（测试用的就是表单里这些值，不必先保存）。
 *
 * 与「pi 的凭证」无关：pi 有自己的 auth.json，这里只服务于阅读器内置的 agent（以及以后的适配器）。
 * 明文 key 只存在服务端的 `data/model-config.json`（0o600），界面只回显打码值。
 */
import { useEffect, useState } from 'react';
import {
  agentApi,
  type ApiType,
  type ModelConfigPublic,
  type ModelProviderPublic,
  type PiSyncStatusPublic,
  type ProbeResultPublic,
} from './agentApi';
import { useI18n } from './i18n';

/** 表单里 baseUrl 的初始值 / 切类型时的默认值。 */
const TYPE_DEFAULT_URL: Record<ApiType, string> = {
  openai: 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
};

/** 常见服务的一键填充（类型 + baseUrl，都能再改）。 */
const API_PRESETS: Array<{ id: string; label: string; apiType: ApiType; baseUrl: string }> = [
  { id: 'openai', label: 'OpenAI', apiType: 'openai', baseUrl: 'https://api.openai.com/v1' },
  { id: 'deepseek', label: 'DeepSeek', apiType: 'openai', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'moonshot', label: 'Moonshot', apiType: 'openai', baseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'zhipu', label: 'Zhipu GLM', apiType: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'dashscope', label: 'Qwen', apiType: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'anthropic', label: 'Anthropic', apiType: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  { id: 'gemini', label: 'Gemini', apiType: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' },
];

/** 这些地址是「预设值」：切类型时可以直接被覆盖，用户手填的地址不覆盖。 */
const PRESET_URLS = new Set<string>([
  ...API_PRESETS.map((preset) => preset.baseUrl),
  ...Object.values(TYPE_DEFAULT_URL),
]);

const parseModels = (text: string): string[] =>
  text
    .split(/[,\s]+/)
    .map((model) => model.trim())
    .filter(Boolean);

export function ModelSettings() {
  const { t } = useI18n();
  const [config, setConfig] = useState<ModelConfigPublic | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [apiType, setApiType] = useState<ApiType>('openai');
  const [baseUrl, setBaseUrl] = useState(TYPE_DEFAULT_URL.openai);
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<ProbeResultPublic[] | null>(null);
  /** FR-0013：pi 同步状态（目录 / 装没装 / 上次结果）。 */
  const [piSync, setPiSync] = useState<PiSyncStatusPublic | null>(null);
  const [syncing, setSyncing] = useState(false);

  const refreshPiSync = () => {
    agentApi
      .piSyncStatus()
      .then(setPiSync)
      .catch(() => setPiSync(null));
  };

  useEffect(() => {
    agentApi
      .modelConfig()
      .then(setConfig)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    refreshPiSync();
  }, []);

  const reset = () => {
    setEditing(null);
    setName('');
    setApiType('openai');
    setBaseUrl(TYPE_DEFAULT_URL.openai);
    setApiKey('');
    setModels('');
    setTestResults(null);
  };

  const edit = (provider: ModelProviderPublic) => {
    setEditing(provider.id);
    setName(provider.name);
    setApiType(provider.apiType);
    setBaseUrl(provider.baseUrl);
    setModels(provider.models.join(', '));
    setApiKey('');
    setNote(null);
    setTestResults(null);
  };

  /** 切类型：只把「还是预设值」的 baseUrl 换成新类型的默认值，用户手填的不动。 */
  const changeApiType = (next: ApiType) => {
    setApiType(next);
    if (!baseUrl.trim() || PRESET_URLS.has(baseUrl.trim())) setBaseUrl(TYPE_DEFAULT_URL[next]);
  };

  const applyPreset = (preset: { apiType: ApiType; baseUrl: string }) => {
    setApiType(preset.apiType);
    setBaseUrl(preset.baseUrl);
    setTestResults(null);
  };

  const submit = async () => {
    if (!baseUrl.trim()) return;
    setSaving(true);
    setError(null);
    setNote(null);
    try {
      const res = await agentApi.saveProvider({
        ...(editing ? { id: editing } : {}),
        name: name.trim() || undefined,
        apiType,
        baseUrl: baseUrl.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        models: parseModels(models),
      });
      setConfig(res.config);
      setNote(editing ? t('model.updated') : t('model.added'));
      reset();
      refreshPiSync(); // 保存会顺带同步到 pi（FR-0013）
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!baseUrl.trim()) return;
    setTesting(true);
    setError(null);
    setNote(null);
    setTestResults(null);
    try {
      const res = await agentApi.testProvider({
        ...(editing ? { id: editing } : {}),
        apiType,
        baseUrl: baseUrl.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        models: parseModels(models),
      });
      setTestResults(res.results);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  const remove = async (id: string) => {
    try {
      const res = await agentApi.removeProvider(id);
      setConfig(res.config);
      if (editing === id) reset();
      refreshPiSync();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** 手动重推一次（幂等；装上 pi 之后点一下就行）。 */
  const syncToPi = async () => {
    setSyncing(true);
    setError(null);
    setNote(null);
    try {
      const res = await agentApi.syncModelsToPi();
      setPiSync({ ...res.status, last: res });
      if (!res.ok) setError(res.error ?? t('model.piSyncFailed', { error: '' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  /** 状态行文案：上次结果优先，没有结果就看 pi 在不在。 */
  const piSyncText = (() => {
    const last = piSync?.last;
    if (last && !last.ok) return { text: t('model.piSyncFailed', { error: last.error ?? '' }), bad: true };
    if (last) {
      const n = String(last.synced.length);
      const dir = piSync?.dir ?? '';
      return {
        text: last.changed ? t('model.piSyncOk', { n, dir }) : t('model.piSyncUnchanged', { n }),
        bad: false,
      };
    }
    if (piSync && !piSync.installed) return { text: t('model.piSyncNoPi'), bad: true };
    return { text: t('model.piSyncHint'), bad: false };
  })();

  const setDefault = async (provider: string, modelId: string) => {
    try {
      const isDefault = config?.default?.provider === provider && config?.default?.modelId === modelId;
      const res = isDefault ? await agentApi.clearDefaultModel() : await agentApi.setDefaultModel(provider, modelId);
      setConfig(res.config);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const apiTypeLabel = (type: ApiType) => t(`model.type.${type}`);

  return (
    <section className="model-settings">
      <h3 className="wcr-section-title">{t('model.title')}</h3>
      <p className="ag-note">
        {t('model.intro')}
        {config ? t('model.savedTo', { path: config.path }) : ''}
        {t('model.defaultHint')}
      </p>

      {error && <div className="ms-error">{error}</div>}

      <div className="ms-sync">
        <span className="ms-presets-label">{t('model.piSync')}</span>
        <span className="ms-hint" title={piSync?.dir ?? ''}>
          {piSync?.dir ?? ''}
        </span>
        <button className="btn ghost small" disabled={syncing} onClick={() => void syncToPi()}>
          {syncing ? t('model.piSyncing') : t('model.piSyncNow')}
        </button>
        <span className={piSyncText.bad ? 'ms-bad' : 'ms-hint'}>{piSyncText.text}</span>
      </div>

      <ul className="ms-list">
        {(config?.providers ?? []).map((provider) => (
          <li key={provider.id} className="ms-item">
            <div className="ms-row">
              <span className="ms-name">{provider.name}</span>
              <span className="ms-type" title={apiTypeLabel(provider.apiType)}>
                {apiTypeLabel(provider.apiType)}
              </span>
              <span className="ms-url" title={provider.baseUrl}>
                {provider.baseUrl}
              </span>
              <span className={provider.hasKey ? 'ms-ok' : 'ms-bad'}>
                {provider.hasKey ? `key ${provider.keyHint}` : t('model.missingKey')}
              </span>
              <button className="btn ghost small" onClick={() => edit(provider)}>
                {t('guide.note.edit')}
              </button>
              <button className="btn ghost small" onClick={() => void remove(provider.id)}>
                {t('guide.note.delete')}
              </button>
            </div>
            <div className="ms-models">
              {provider.models.map((model) => {
                const on = config?.default?.provider === provider.id && config?.default?.modelId === model;
                return (
                  <button
                    key={model}
                    className={`ms-chip${on ? ' on' : ''}`}
                    title={on ? t('model.unsetDefault') : t('model.setDefault')}
                    onClick={() => void setDefault(provider.id, model)}
                  >
                    {on ? '✓ ' : ''}
                    {model}
                  </button>
                );
              })}
              {provider.models.length === 0 && <span className="ag-dim">{t('model.noModels')}</span>}
            </div>
          </li>
        ))}
        {(config?.providers.length ?? 0) === 0 && <li className="ag-dim">{t('model.noProviders')}</li>}
      </ul>

      <div className="ms-presets">
        <span className="ms-presets-label">{t('model.presets')}</span>
        {API_PRESETS.map((preset) => (
          <button
            key={preset.id}
            className="ms-preset"
            title={preset.baseUrl}
            onClick={() => applyPreset(preset)}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="ms-form">
        <label className="ms-field">
          <span>{t('model.name')}</span>
          <input
            className="text-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('model.namePlaceholder')}
          />
        </label>
        <label className="ms-field">
          <span>{t('model.apiType')}</span>
          <select className="text-input" value={apiType} onChange={(e) => changeApiType(e.target.value as ApiType)}>
            <option value="openai">{t('model.type.openai')}</option>
            <option value="anthropic">{t('model.type.anthropic')}</option>
            <option value="openai-responses">{t('model.type.openai-responses')}</option>
            <option value="gemini">{t('model.type.gemini')}</option>
          </select>
        </label>
        <label className="ms-field">
          <span>{t('model.baseUrl')}</span>
          <input className="text-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
        <label className="ms-field">
          <span>API key{editing ? t('model.keyKeepHint') : ''}</span>
          <input
            className="text-input"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-…"
          />
        </label>
        <label className="ms-field">
          <span>{t('model.models')}</span>
          <input
            className="text-input"
            value={models}
            onChange={(e) => setModels(e.target.value)}
            placeholder="gpt-4o-mini, gpt-4o"
          />
        </label>
      </div>

      {testResults && (
        <ul className="ms-test">
          {testResults.map((result) => (
            <li key={result.modelId} className={result.ok ? 'ok' : 'bad'}>
              <span className="ms-test-mark">{result.ok ? '✓' : '✗'}</span>
              <span className="ms-test-model">{result.modelId}</span>
              <span className="ms-test-detail">
                {result.ok
                  ? `${result.ms}ms${result.reply ? ` · ${result.reply}` : ''}`
                  : (result.error ?? `HTTP ${result.status ?? '?'}`)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="ms-actions">
        <button className="btn ghost" disabled={testing || !baseUrl.trim()} onClick={() => void test()}>
          {testing ? t('model.testing') : t('model.test')}
        </button>
        <button className="btn" disabled={saving || !baseUrl.trim()} onClick={() => void submit()}>
          {saving ? t('model.saving') : editing ? t('guide.note.saveEdit') : t('model.addProvider')}
        </button>
        {editing && (
          <button className="btn ghost" onClick={reset}>
            {t('model.cancelEdit')}
          </button>
        )}
        {note && <span className="ms-ok">{note}</span>}
        <span className="ms-hint">{t('model.testHint')}</span>
      </div>
    </section>
  );
}
