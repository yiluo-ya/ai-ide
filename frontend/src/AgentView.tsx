/**
 * 中间区：Code Agent 的对话内容（2026-10-03 用户要求：不要新窗口，中间显示会话内容）。
 *
 * 会话管理在左栏（AgentSessions），状态在 agentStore；这里只负责把消息画出来 + 发消息。
 * 事件驱动：SSE 一有 message_* 就更新，所以文本流式、工具调用实时。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { agentMessageText, type AgentContentBlock, type AgentMessage } from './agentApi';
import { BACKEND_LABEL, toolLabel, useAgent } from './agentStore';
import { downloadFile, sessionFilename, sessionToHtml, sessionToMarkdown } from './agentExport';
import { looksRichText } from './markdown';
import { RichText } from './RichText';
import { showToast } from './state';
import { useI18n } from './i18n';
import './agent.css';
import './share.css';

function Block({ block }: { block: AgentContentBlock }) {
  const { t } = useI18n();
  if (block.type === 'text') return <RichText text={block.text ?? ''} className="ag-text" />;
  if (block.type === 'thinking') {
    return (
      <details className="ag-fold">
        <summary>{t('agent.thinking')}</summary>
        <pre className="ag-pre dim">{block.thinking}</pre>
      </details>
    );
  }
  if (block.type === 'toolCall') {
    return (
      <details className="ag-fold">
        <summary>
          {t('agent.toolCallPrefix')}
          <b>{toolLabel(block.name)}</b>
        </summary>
        <pre className="ag-pre">{JSON.stringify(block.arguments ?? {}, null, 2)}</pre>
      </details>
    );
  }
  return null;
}

/**
 * 工具结果：日志 / 文件内容 / JSON 默认原样最忠实；
 * 只有带明确 Markdown 结构或 HTML 文档特征（见 markdown.ts）时才按富文本画，并给「源码」切回去。
 */
function ToolResultBody({ text }: { text: string }) {
  const { t } = useI18n();
  const rich = useMemo(() => looksRichText(text), [text]);
  const [raw, setRaw] = useState(false);
  if (!rich) return <pre className="ag-pre">{text}</pre>;
  return (
    <div className="ag-rich">
      <div className="ag-rich-bar">
        <button className="md-btn" onClick={() => setRaw((v) => !v)}>
          {raw ? t('md.render') : t('md.source')}
        </button>
      </div>
      {raw ? <pre className="ag-pre">{text}</pre> : <RichText text={text} />}
    </div>
  );
}

function MessageRow({ message }: { message: AgentMessage }) {
  const { t } = useI18n();
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
          {t('agent.toolResultPrefix')}
          {toolLabel(message.toolName)}
          {message.isError ? ` · ${t('agent.failed')}` : ''}
        </summary>
        <ToolResultBody text={agentMessageText(message)} />
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

export function AgentView({
  projectId,
  projectName,
  onBack,
}: {
  projectId: string;
  projectName: string;
  onBack: () => void;
}) {
  const { t } = useI18n();
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
  const [exportOpen, setExportOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const active = sessions.find((s) => s.id === activeId) ?? null;
  const hasSession = sessions.some((s) => s.projectId === projectId);

  const options = useMemo(
    () =>
      (config?.providers ?? []).flatMap((p) =>
        p.models.map((m) => ({ provider: p.id, providerName: p.name, modelId: m })),
      ),
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

  /** 把当前会话导出成 .md / .html（含正在流式生成的那条，所见即所得）。 */
  const exportSession = (format: 'md' | 'html') => {
    setExportOpen(false);
    if (!active) return;
    const at = new Date();
    const input = {
      name: active.name,
      projectName,
      projectRoot: active.projectRoot,
      backendLabel: BACKEND_LABEL[active.backend] ? t(BACKEND_LABEL[active.backend]) : active.backend,
      model: active.model,
      messages: rows,
      at,
    };
    const filename = sessionFilename(active.name, format, at);
    if (format === 'md') downloadFile(filename, sessionToMarkdown(input), 'text/markdown');
    else downloadFile(filename, sessionToHtml(input), 'text/html');
    showToast(t('agent.exportedTo', { name: filename }));
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
            aria-label={t('agent.sessionModelAria')}
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
        {active && (
          <div className="share-wrap">
            <button
              className="btn ghost"
              onClick={() => setExportOpen((v) => !v)}
              aria-expanded={exportOpen}
              aria-haspopup="true"
            >
              {t('agent.export')}
            </button>
            {exportOpen && (
              <>
                <div className="share-backdrop" onClick={() => setExportOpen(false)} />
                <div className="share-menu">
                  <div className="share-section">{t('agent.exportSection')}</div>
                  <button className="share-item" onClick={() => exportSession('md')}>
                    {t('agent.exportMd')}
                    <span className="share-hint">{t('agent.exportMdHint')}</span>
                  </button>
                  <button className="share-item" onClick={() => exportSession('html')}>
                    {t('agent.exportHtml')}
                    <span className="share-hint">{t('agent.exportHtmlHint')}</span>
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        <button className="btn ghost" onClick={onBack} title={t('agent.backToReadingHint')}>
          {t('app.backToCode')}
        </button>
      </header>

      {error && (
        <div className="ag-banner bad">
          <span>{error}</span>
          <button className="btn ghost small" onClick={() => setError(null)}>
            {t('agent.gotIt')}
          </button>
        </div>
      )}

      {!hasSession ? (
        <div className="ag-empty">
          <h3>{t('agent.projectNoSessions')}</h3>
          <p className="ag-note">{t('agent.emptyLead')}</p>
        </div>
      ) : !active ? (
        <div className="ag-empty">
          <h3>{t('agent.pickSession')}</h3>
        </div>
      ) : (
        <div className="ag-chat">
          <div className="ag-stream" ref={scrollRef}>
            {rows.length === 0 && <p className="ag-note">{t('agent.composeHint')}</p>}
            {rows.map((m, i) => (
              <MessageRow key={i} message={m} />
            ))}
            {toolNote && <div className="ag-tool-note">{toolNote}</div>}
          </div>

          <div className="ag-compose">
            <textarea
              className="ag-input"
              rows={3}
              placeholder={busy ? t('agent.busyPlaceholder') : t('agent.inputPlaceholder')}
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
                  {t('agent.stop')}
                </button>
              )}
              <button className="btn" disabled={!draft.trim() || !activeId} onClick={submit}>
                {t('agent.send')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
