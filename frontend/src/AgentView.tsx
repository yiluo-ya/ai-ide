/**
 * 中间区：Code Agent 的对话内容（2026-10-03 用户要求：不要新窗口，中间显示会话内容）。
 *
 * 会话管理在左栏（AgentSessions），状态在 agentStore；这里只负责把消息画出来 + 发消息。
 * 事件驱动：SSE 一有 message_* 就更新，所以文本流式、工具调用实时。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { agentMessageText, type AgentContentBlock, type AgentMessage } from './agentApi';
import { toolLabel, useAgent } from './agentStore';

function Block({ block }: { block: AgentContentBlock }) {
  if (block.type === 'text') return <div className="ag-text">{block.text}</div>;
  if (block.type === 'thinking') {
    return (
      <details className="ag-fold">
        <summary>思考</summary>
        <pre className="ag-pre dim">{block.thinking}</pre>
      </details>
    );
  }
  if (block.type === 'toolCall') {
    return (
      <details className="ag-fold">
        <summary>
          调用工具 · <b>{toolLabel(block.name)}</b>
        </summary>
        <pre className="ag-pre">{JSON.stringify(block.arguments ?? {}, null, 2)}</pre>
      </details>
    );
  }
  return null;
}

function MessageRow({ message }: { message: AgentMessage }) {
  if (message.role === 'system') return null;

  if (message.role === 'user') {
    return (
      <div className="ag-row user">
        <div className="ag-bubble">{agentMessageText(message)}</div>
      </div>
    );
  }

  if (message.role === 'toolResult') {
    return (
      <details className={`ag-fold tool${message.isError ? ' bad' : ''}`}>
        <summary>
          工具结果 · {toolLabel(message.toolName)}
          {message.isError ? ' · 失败' : ''}
        </summary>
        <pre className="ag-pre">{agentMessageText(message)}</pre>
      </details>
    );
  }

  const blocks = Array.isArray(message.content) ? message.content : [];
  return (
    <div className="ag-row assistant">
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
      {message.stopReason === 'error' && message.errorMessage && <div className="ag-error">{message.errorMessage}</div>}
    </div>
  );
}

export function AgentView({ projectId, projectName, onBack }: { projectId: string; projectName: string; onBack: () => void }) {
  const sessions = useAgent((s) => s.sessions);
  const activeId = useAgent((s) => s.activeId);
  const messages = useAgent((s) => s.messages);
  const live = useAgent((s) => s.live);
  const toolNote = useAgent((s) => s.toolNote);
  const busy = useAgent((s) => s.busy);
  const error = useAgent((s) => s.error);
  const config = useAgent((s) => s.config);
  const send = useAgent((s) => s.send);
  const stop = useAgent((s) => s.stop);
  const setModel = useAgent((s) => s.setModel);
  const setError = useAgent((s) => s.setError);

  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const active = sessions.find((s) => s.id === activeId) ?? null;
  const hasSession = sessions.some((s) => s.projectId === projectId);

  const options = useMemo(
    () =>
      (config?.providers ?? []).flatMap((p) => p.models.map((m) => ({ provider: p.id, providerName: p.name, modelId: m }))),
    [config],
  );

  const rows = useMemo(() => (live ? [...messages, live] : messages), [messages, live]);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length, toolNote]);

  const submit = () => {
    const text = draft.trim();
    if (!text || !activeId) return;
    setDraft('');
    void send(text);
  };

  return (
    <section className="agent-view">
      <header className="ag-head">
        <span className="ag-title">
          Code Agent
          <span className="ag-project" title={projectName}>
            {projectName}
          </span>
        </span>
        <span className="spacer" />
        {active && active.backend === 'builtin' && (
          <select
            className="ag-select"
            aria-label="这个会话用哪个模型"
            value={active.model ? `${active.model.provider}::${active.model.id}` : ''}
            onChange={(e) => {
              const [provider, ...rest] = e.target.value.split('::');
              void setModel(provider, rest.join('::'));
            }}
          >
            {active.model?.provider && active.model.id && (
              <option value={`${active.model.provider}::${active.model.id}`}>
                {active.model.provider}/{active.model.id}
              </option>
            )}
            {options
              .filter((o) => !active.model || o.provider !== active.model.provider || o.modelId !== active.model.id)
              .map((o) => (
                <option key={`${o.provider}::${o.modelId}`} value={`${o.provider}::${o.modelId}`}>
                  {o.providerName}/{o.modelId}
                </option>
              ))}
          </select>
        )}
        <button className="btn ghost" onClick={onBack} title="回到代码阅读（也可点左栏的「回到代码」）">
          回到代码
        </button>
      </header>

      {error && (
        <div className="ag-banner bad">
          <span>{error}</span>
          <button className="btn ghost small" onClick={() => setError(null)}>
            知道了
          </button>
        </div>
      )}

      {!hasSession ? (
        <div className="ag-empty">
          <h3>这个项目还没有会话</h3>
          <p className="ag-note">
            agent 在工作目录里读代码、改代码、写代码；找「定义在哪 / 谁在调用」用的是这个阅读器自己的索引，
            而不是 grep 猜。在左栏选好模型后点「新建会话」。
          </p>
        </div>
      ) : !active ? (
        <div className="ag-empty">
          <h3>在左栏选一个会话</h3>
        </div>
      ) : (
        <div className="ag-chat">
          <div className="ag-stream" ref={scrollRef}>
            {rows.length === 0 && (
              <p className="ag-note">在下面说出你要做的事，例如「把 src/util.ts 的 helper 改成支持空值」。</p>
            )}
            {rows.map((m, i) => (
              <MessageRow key={i} message={m} />
            ))}
            {toolNote && <div className="ag-tool-note">{toolNote}</div>}
          </div>

          <div className="ag-compose">
            <textarea
              className="ag-input"
              rows={3}
              placeholder={busy ? 'agent 正在干活…' : 'Enter 发送，Shift+Enter 换行'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <div className="ag-compose-actions">
              {active.lastError && <span className="ag-dim">{active.lastError}</span>}
              {busy && (
                <button className="btn ghost" onClick={() => void stop()}>
                  停止
                </button>
              )}
              <button className="btn" disabled={!draft.trim() || !activeId} onClick={submit}>
                发送
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
