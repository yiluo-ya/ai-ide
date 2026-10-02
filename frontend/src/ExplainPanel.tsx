/**
 * 结构性解释面板（04 Guide · W4 / G5.1–G5.4）。
 *
 * 口径（`04-guide-plan.md` Q1-A）：解释**不使用模型**，全部来自后端的定义 / 引用 /
 * 调用索引；界面必须写明「结构性解释 · 未使用模型」，不许出现 AI 字样。
 * 覆盖率如实显示，未解析不隐藏、不折算。
 */
import { useEffect, type ReactNode } from 'react';
import type { CallNode } from '../../shared/types';
import { anchorOf } from './notes';
import { useNotesStore } from './notesState';
import { useStore, showFlash } from './state';
import { useI18n, translate } from './i18n';
import { EXPLAIN_SCOPES, explainNoteBody, kindText, useExplainStore } from './explainState';
import './guide.css';

/** 一条「出处」按钮：`path:line`，点击跳过去。 */
function RefRow({
  name,
  kind,
  file,
  line,
  tags,
  indent,
  onOpenFile,
}: {
  name: string;
  kind?: string;
  file: string;
  line: number;
  tags?: string[];
  indent?: number;
  onOpenFile: (file: string, line: number, col: number) => void;
}) {
  const clickable = Boolean(file);
  return (
    <button
      className={`ex-row${clickable ? '' : ' is-static'}`}
      style={indent ? { paddingLeft: 8 + indent * 14 } : undefined}
      title={clickable ? translate('explain.openAt', { at: `${file}:${line}` }) : translate('explain.noSource')}
      onClick={() => {
        if (clickable) onOpenFile(file, line, 1);
      }}
    >
      {kind && <span className="ex-kind">{kindText(kind)}</span>}
      <span className="ex-name">{name}</span>
      {tags?.map((tag) => (
        <span key={tag} className="ex-tag">
          {tag}
        </span>
      ))}
      <span className="ex-path">{file ? `${file}:${line}` : translate('explain.noSource')}</span>
    </button>
  );
}

/** 调用树（callers 档会到两层）：按 children 递归，缩进表示层数。 */
function CallRows({
  nodes,
  indent,
  onOpenFile,
}: {
  nodes: CallNode[];
  indent: number;
  onOpenFile: (file: string, line: number, col: number) => void;
}) {
  return (
    <>
      {nodes.map((n, i) => (
        <span key={`${n.name}:${n.file}:${i}`} className="ex-node">
          <RefRow
            name={n.name}
            kind={n.kind}
            file={n.file}
            line={n.location.range.start.line}
            indent={indent}
            tags={[
              ...(n.external ? [translate('explain.tagExternal')] : []),
              ...(n.unresolved ? [translate('explain.tagUnresolved')] : []),
              ...(n.isEntry ? [translate('explain.tagEntry')] : []),
              ...(n.isTest ? [translate('explain.tagTest')] : []),
            ]}
            onOpenFile={onOpenFile}
          />
          {n.children?.length ? <CallRows nodes={n.children} indent={indent + 1} onOpenFile={onOpenFile} /> : null}
        </span>
      ))}
    </>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="ex-sec">
      <h4 className="ex-sec-title">
        {title}
        <span className="ex-sec-count">{count}</span>
      </h4>
      {count === 0 ? <div className="guide-empty">{translate('explain.none')}</div> : children}
    </section>
  );
}

export function ExplainPanel({
  onOpenFile,
  onClose,
}: {
  onOpenFile: (file: string, line: number, col: number) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const target = useExplainStore((s) => s.target);
  const scope = useExplainStore((s) => s.scope);
  const result = useExplainStore((s) => s.result);
  const busy = useExplainStore((s) => s.busy);
  const error = useExplainStore((s) => s.error);
  const setScope = useExplainStore((s) => s.setScope);
  const retry = useExplainStore((s) => s.retry);

  // Esc 关闭：浮层盖住编辑器，不能只靠鼠标找按钮。
  // 走 capture 阶段：从浮层里点开会把焦点交给 Monaco，编辑器会吞掉 Escape，
  // 冒泡阶段挂在 window 上的监听就收不到（依赖图曾因此「写着 Esc 却关不掉」）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  if (!target) return null;

  /** G5.4：把解释的要点存成笔记 —— 位置对得上当前文件写行级，否则写文件级。 */
  const saveAsNote = () => {
    const r = useExplainStore.getState().result;
    if (!r) return;
    const body = explainNoteBody(r);
    const store = useStore.getState();
    const sameFile = store.openFile === r.target.file;
    const add = useNotesStore.getState().add;
    const note = sameFile
      ? add({
          file: r.target.file,
          line: r.target.line,
          col: r.target.col,
          // 行级笔记要靠 anchor 抗住代码变动（Q9）：当前文件正文才算得出来
          anchor: anchorOf(store.fileContent, r.target.line),
          body,
        })
      : add({ file: r.target.file, line: 0, col: 0, anchor: '', body, level: 'file' });
    showFlash(note ? t('explain.saved') : t('explain.saveFailed'));
  };

  const coverage = result?.coverage;

  return (
    <div className="explain-panel">
      <header className="ex-head">
        <span className="ex-title">{t('explain.title')}</span>
        <span className="ex-static-note" title={t('explain.staticNoteTitle')}>
          {t('explain.staticNote')}
        </span>
        <span className="ex-target-file" title={target.file}>
          {target.file}:{target.line}
        </span>
        <button className="gv-btn" onClick={onClose} title={t('explain.closeTitle')}>
          {t('dialog.close')}
        </button>
      </header>

      <div className="ex-scopes">
        <span className="ex-scope-label">{t('explain.scopeTitle')}</span>
        {EXPLAIN_SCOPES.map((value) => (
          <button
            key={value}
            className={`gv-btn${scope === value ? ' is-on' : ''}`}
            onClick={() => setScope(value)}
            title={t(`explain.scope.${value}Title`)}
          >
            {t(`explain.scope.${value}`)}
          </button>
        ))}
        <button className="gv-btn" onClick={retry} disabled={busy}>
          {t('explain.retry')}
        </button>
      </div>

      <div className="ex-body">
        {busy && <div className="gv-status">{t('explain.loading')}</div>}
        {!busy && error && (
          <div className="gv-status gv-status-err">
            {t('explain.error', { message: error })}
          </div>
        )}
        {!busy && !error && result && (
          <>
            <section className="ex-sec ex-target-sec">
              <h4 className="ex-sec-title">
                {t('explain.target')}
                <span className="ex-sec-count">{kindText(result.target.kind)}</span>
              </h4>
              <div className="ex-target-name">{result.target.name}</div>
              {result.target.containerName && (
                <div className="ex-meta">
                  {t('explain.container')}：{result.target.containerName}
                </div>
              )}
              <RefRow name={result.target.name} file={result.target.file} line={result.target.line} onOpenFile={onOpenFile} />
              {result.target.signature && <pre className="ex-signature">{result.target.signature.trim()}</pre>}
              {result.target.doc && <pre className="ex-doc">{result.target.doc}</pre>}
              <div className="ex-meta">
                {t('explain.lines', { start: result.lines.start, end: result.lines.end })}
              </div>
            </section>

            <Section title={t('explain.callees')} count={result.callees.length}>
              <CallRows nodes={result.callees} indent={0} onOpenFile={onOpenFile} />
            </Section>
            <Section title={t('explain.callers')} count={result.callers.length}>
              <CallRows nodes={result.callers} indent={0} onOpenFile={onOpenFile} />
            </Section>
            <Section title={t('explain.projectRefs')} count={result.projectRefs.length}>
              {result.projectRefs.map((r) => (
                <RefRow
                  key={`${r.name}:${r.file}:${r.line}`}
                  name={r.name}
                  kind={r.kind}
                  file={r.file}
                  line={r.line}
                  onOpenFile={onOpenFile}
                />
              ))}
            </Section>
            <Section title={t('explain.externalModules')} count={result.externalModules.length}>
              {result.externalModules.map((m, i) => (
                <RefRow
                  key={`${m.module}:${m.file}:${m.line}:${i}`}
                  name={m.module || t('explain.builtin')}
                  file={m.file}
                  line={m.line}
                  onOpenFile={onOpenFile}
                />
              ))}
            </Section>
          </>
        )}
      </div>

      <footer className="ex-foot">
        {coverage ? (
          <span className="ex-coverage">
            {t('explain.coverageText', {
              resolved: coverage.resolved,
              unresolved: coverage.unresolved,
              external: coverage.external,
            })}
          </span>
        ) : (
          <span className="ex-coverage">{t('explain.coverageUnknown')}</span>
        )}
        <span className="ex-foot-static">{t('explain.staticNote')}</span>
        <button className="gv-btn" onClick={saveAsNote} disabled={!result}>
          {t('explain.save')}
        </button>
      </footer>
    </div>
  );
}
