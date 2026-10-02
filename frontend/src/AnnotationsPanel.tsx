/**
 * 05 信使 Share / S10：批注与讨论线程面板。
 *
 * 只读页面上的「讨论」不是写回源码，而是**本机的一层旁注**：
 * 存在浏览器（按项目分片），导出随报告一起走（见 annotations.ts 的决策说明）。
 */
import { useState } from 'react';
import { annotationText, annotationsForFile } from './annotations';
import { showFlash, useStore } from './state';

interface Props {
  file: string | null;
  cursor: { line: number; col: number };
  onJump: (file: string, line: number, col: number) => void;
}

export function AnnotationsPanel({ file, cursor, onJump }: Props) {
  const annotations = useStore((s) => s.annotations);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState('');

  const here = file ? annotationsForFile(annotations, file) : [];
  const others = annotations.filter((a) => a.file !== file);
  const unresolved = annotations.filter((a) => !a.resolved).length;

  const add = () => {
    if (!file || !draft.trim()) return;
    useStore.getState().addAnnotation(file, cursor.line, cursor.col, draft.trim());
    setDraft('');
    showFlash(`已在本行加批注（${file}:${cursor.line}）`);
  };

  const reply = (id: string) => {
    if (!replyDraft.trim()) return;
    useStore.getState().replyAnnotation(id, replyDraft.trim());
    setReplyDraft('');
    setReplyTo(null);
  };

  return (
    <div className="notes-panel">
      <div className="notes-head">
        <span className="muted">
          {unresolved} 条未解决 / 共 {annotations.length}
        </span>
        <span className="spacer" />
        <button
          className="btn ghost small"
          title="导出全部批注为 Markdown（不打开阅读器也能看）"
          disabled={!annotations.length}
          onClick={() => {
            const list = useStore.getState().annotations;
            void navigator.clipboard
              ?.writeText(list.map((a) => annotationText(a)).join('\n\n'))
              .then(() => showFlash('已复制全部批注'));
          }}
        >
          复制全部
        </button>
      </div>

      <div className="notes-body">
        {!annotations.length && (
          <div className="panel-empty">
            在代码行上留一句「这里有问题」，同事拿到导出的报告就能看懂位置与讨论。
          </div>
        )}

        {[...here, ...others].map((thread) => (
          <div
            key={thread.id}
            className={`notes-row ${thread.resolved ? 'resolved' : ''}`}
            onClick={() => onJump(thread.file, thread.line, thread.col)}
            title={`${thread.file}:${thread.line}:${thread.col}`}
          >
            <div className="notes-where">
              {thread.file === file ? '本文件' : thread.file}:{thread.line}
              {thread.resolved ? ' · 已解决' : ''}
            </div>
            <div className="notes-text">{thread.text}</div>
            {thread.replies.map((r, i) => (
              <div className="notes-reply" key={i}>
                {r.text}
              </div>
            ))}
            <div className="notes-actions">
              <button
                className="btn ghost small"
                onClick={(e) => {
                  e.stopPropagation();
                  setReplyTo(replyTo === thread.id ? null : thread.id);
                }}
              >
                回复
              </button>
              <button
                className="btn ghost small"
                onClick={(e) => {
                  e.stopPropagation();
                  useStore.getState().toggleAnnotationResolved(thread.id);
                }}
              >
                {thread.resolved ? '重新打开' : '标为已解决'}
              </button>
              <button
                className="btn ghost small"
                onClick={(e) => {
                  e.stopPropagation();
                  useStore.getState().removeAnnotation(thread.id);
                }}
              >
                删除
              </button>
            </div>
            {replyTo === thread.id && (
              <div className="notes-compose" onClick={(e) => e.stopPropagation()}>
                <textarea
                  autoFocus
                  value={replyDraft}
                  placeholder="回一句…"
                  onChange={(e) => setReplyDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) reply(thread.id);
                    if (e.key === 'Escape') setReplyTo(null);
                  }}
                />
                <button className="btn ghost small" onClick={() => reply(thread.id)}>
                  发送回复（Ctrl/Cmd+Enter）
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="notes-compose">
        <textarea
          value={draft}
          placeholder={file ? `在 ${file}:${cursor.line} 留一句…` : '先打开一个文件'}
          disabled={!file}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) add();
          }}
        />
        <button className="btn ghost small" disabled={!file || !draft.trim()} onClick={add}>
          在光标处添加批注
        </button>
        <div className="nav-foot">批注只存本机浏览器（按项目分片），不写被读目录</div>
      </div>
    </div>
  );
}
