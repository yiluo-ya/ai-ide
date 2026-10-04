/**
 * 设置面板里的「模型」区块：内置 code-agent 用的 provider（base URL + API key + 模型 id）。
 *
 * 与「pi 的凭证」无关：pi 有自己的 auth.json，这里只服务于阅读器内置的 agent（以及以后的适配器）。
 * 明文 key 只存在服务端的 `data/model-config.json`（0o600），界面只回显打码值。
 */
import { useEffect, useState } from 'react';
import { agentApi, type ModelConfigPublic, type ModelProviderPublic } from './agentApi';
import { useI18n } from './i18n';

export function ModelSettings() {
  const { t } = useI18n();
  const [config, setConfig] = useState<ModelConfigPublic | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    agentApi
      .modelConfig()
      .then(setConfig)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const reset = () => {
    setEditing(null);
    setName('');
    setBaseUrl('https://api.openai.com/v1');
    setApiKey('');
    setModels('');
  };

  const edit = (provider: ModelProviderPublic) => {
    setEditing(provider.id);
    setName(provider.name);
    setBaseUrl(provider.baseUrl);
    setModels(provider.models.join(', '));
    setApiKey('');
    setNote(null);
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
        baseUrl: baseUrl.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        models: models
          .split(/[,\s]+/)
          .map((m) => m.trim())
          .filter(Boolean),
      });
      setConfig(res.config);
      setNote(editing ? t('model.updated') : t('model.added'));
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      const res = await agentApi.removeProvider(id);
      setConfig(res.config);
      if (editing === id) reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const setDefault = async (provider: string, modelId: string) => {
    try {
      const isDefault = config?.default?.provider === provider && config?.default?.modelId === modelId;
      const res = isDefault ? await agentApi.clearDefaultModel() : await agentApi.setDefaultModel(provider, modelId);
      setConfig(res.config);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="model-settings">
      <h3 className="wcr-section-title">{t('model.title')}</h3>
      <p className="ag-note">
        {t('model.intro')}
        {config ? t('model.savedTo', { path: config.path }) : ''}
        {t('model.defaultHint')}
      </p>

      {error && <div className="ms-error">{error}</div>}

      <ul className="ms-list">
        {(config?.providers ?? []).map((provider) => (
          <li key={provider.id} className="ms-item">
            <div className="ms-row">
              <span className="ms-name">{provider.name}</span>
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

      <div className="ms-actions">
        <button className="btn" disabled={saving || !baseUrl.trim()} onClick={() => void submit()}>
          {saving ? t('model.saving') : editing ? t('guide.note.saveEdit') : t('model.addProvider')}
        </button>
        {editing && (
          <button className="btn ghost" onClick={reset}>
            {t('model.cancelEdit')}
          </button>
        )}
        {note && <span className="ms-ok">{note}</span>}
      </div>
    </section>
  );
}
