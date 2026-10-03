/**
 * 左栏：Code Agent 的会话管理（2026-10-03 用户要求：左边管会话，中间看内容）。
 *
 * 只做「选后端 / 建 / 删」，对话内容在中间（AgentView）。
 * 2026-10-03 追加：新建会话可选后端 —— 内置 agent 用本项目「模型」配置，
 * pi 用本机 pi 自己的凭证与工具（这就是「接别的 code-agent」的入口）。
 * 模型选择用「派生默认值 + 本地覆盖」而不是 useEffect 同步：少一次渲染，也没有依赖数组的口径问题。
 */
import { useEffect, useMemo, useState } from 'react';
import type { BackendKind } from './agentApi';
import { BACKEND_LABEL, useAgent } from './agentStore';

/** 可选后端：内置 agent（本项目模型）/ 本机 pi（pi 自己的凭证）/ OpenHands（还没接）。 */
const BACKENDS: BackendKind[] = ['builtin', 'pi', 'openhands'];

interface Pick {
  provider: string;
  modelId: string;
}

export function AgentSessions({
  projectId,
  onBack,
  onOpen,
}: {
  projectId: string;
  onBack: () => void;
  /** 选中某个会话：主区切到对话内容（左栏只列会话，见 2026-10-03 的布局调整）。 */
  onOpen?: () => void;
}) {
  const config = useAgent((s) => s.config);
  const sessions = useAgent((s) => s.sessions);
  const activeId = useAgent((s) => s.activeId);
  const loading = useAgent((s) => s.loading);
  const init = useAgent((s) => s.init);
  const create = useAgent((s) => s.create);
  const select = useAgent((s) => s.select);
  const remove = useAgent((s) => s.remove);

  /** 用户手动选的模型；没选时用下面的派生默认值。 */
  const [picked, setPicked] = useState<Pick | null>(null);
  const [backend, setBackend] = useState<BackendKind>('builtin');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void init(projectId);
  }, [init, projectId]);

  const providers = useMemo(() => config?.providers ?? [], [config]);
  const options = useMemo(
    () =>
      providers.flatMap((p) =>
        p.models.map((m) => ({ provider: p.id, modelId: m, label: `${p.name}/${m}`, hasKey: p.hasKey })),
      ),
    [providers],
  );

  /** 默认模型 → 第一个带 key 的 → 第一个可用。 */
  const preferred = useMemo<Pick | null>(() => {
    if (config?.default) return { provider: config.default.provider, modelId: config.default.modelId };
    const withKey = providers.find((p) => p.hasKey && p.models.length > 0);
    if (withKey) return { provider: withKey.id, modelId: withKey.models[0] };
    return options[0] ? { provider: options[0].provider, modelId: options[0].modelId } : null;
  }, [config, providers, options]);

  const current = picked ?? preferred;
  const mine = sessions.filter((s) => s.projectId === projectId);

  /** 内置 agent 必须先选模型；pi 用自己的凭证；OpenHands 还没接。 */
  const needsModel = backend === 'builtin';
  const canCreate = backend !== 'openhands' && (!needsModel || Boolean(current));

  const createSession = async () => {
    if (!canCreate) return;
    setBusy(true);
    try {
      await create(projectId, backend, current?.provider, current?.modelId);
    } catch {
      // store 里已经把错误写进 error，中间区会显示
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ag-side">
      <div className="ag-side-head">
        <span className="ag-side-title">Code Agent</span>
        <button className="btn ghost small" onClick={onBack} title="回到代码阅读">
          回到代码
        </button>
      </div>

      <div className="ag-side-list">
        {mine.map((s) => (
          <div key={s.id} className={`ag-session${s.id === activeId ? ' on' : ''}`}>
            <button
              className="ag-session-main"
              onClick={() => {
                void select(s.id);
                onOpen?.();
              }}
              title={s.model ? `${s.model.provider}/${s.model.id}` : ''}
            >
              <span className="ag-session-name">{s.name}</span>
              <span className="ag-session-meta">
                {BACKEND_LABEL[s.backend] ?? s.backend} · {s.messageCount} 条
                {s.isStreaming ? ' · 运行中' : ''}
                {s.alive ? '' : ' · 已停'}
              </span>
            </button>
            <button className="ag-session-x" title="删除会话" onClick={() => void remove(s.id)}>
              ✕
            </button>
          </div>
        ))}
        {mine.length === 0 && !loading && <p className="ag-note">还没有会话。</p>}
        {loading && mine.length === 0 && <p className="ag-note">加载中…</p>}
      </div>

      <div className="ag-side-new">
        <select
          className="ag-select full"
          aria-label="用哪个 code agent 后端"
          value={backend}
          onChange={(e) => setBackend(e.target.value as BackendKind)}
        >
          {BACKENDS.map((b) => (
            <option key={b} value={b}>
              {BACKEND_LABEL[b]}
              {b === 'openhands' ? '（还没接）' : ''}
            </option>
          ))}
        </select>

        {backend === 'pi' && (
          <p className="ag-note">pi 用本机的凭证与工具（~/.pi/agent/auth.json），模型在 pi 里配。</p>
        )}
        {backend === 'openhands' && (
          <p className="ag-note">OpenHands 适配器还没接：可走 agent-server 的 REST + 事件 WebSocket。</p>
        )}

        {needsModel &&
          (config && providers.length === 0 ? (
            <p className="ag-note">还没有模型 provider：去顶栏「模型」填 base URL + API key + 模型 id。</p>
          ) : (
            <select
              className="ag-select full"
              aria-label="新会话用哪个模型"
              value={current ? `${current.provider}::${current.modelId}` : ''}
              onChange={(e) => {
                const [provider, ...rest] = e.target.value.split('::');
                setPicked({ provider, modelId: rest.join('::') });
              }}
            >
              {options.map((o) => (
                <option key={`${o.provider}::${o.modelId}`} value={`${o.provider}::${o.modelId}`}>
                  {o.label}
                  {o.hasKey ? '' : '（缺 key）'}
                </option>
              ))}
              {options.length === 0 && <option value="">没有可用的模型</option>}
            </select>
          ))}

        <button className="btn" disabled={busy || !canCreate} onClick={() => void createSession()}>
          {busy ? '创建中…' : '新建会话'}
        </button>
      </div>
    </div>
  );
}
