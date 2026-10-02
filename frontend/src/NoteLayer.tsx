/**
 * 行级笔记的行槽图标 + 编辑浮层 + 文件级笔记条（04 Guide · W2 / G4.1 / G4.2 / Q17）。
 *
 * 形态对齐 `docs/04-guide.md` §3.3：笔记贴在行上，以「行槽小点 + 悬浮摘要 + 点开的
 * 编辑浮层」出现，**不改动源文件一个字节**。
 *
 * 两个刻意的取舍：
 * - 装饰用**第三个独立装饰池**（`Editor.tsx` 的 `notePool`），不复用语义着色 / agent 行
 *   两个池 —— 三者刷新时机不同，共用一个池会互相清掉（`04-decisions.md` Q17 的注意项）。
 * - 类名用 `wcr-guide-note-*` 而不是 `wcr-note-*`：后者已被 05 的批注（`annotations.css`）占用，
 *   同名会让两套标记在样式上互相覆盖。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { monaco } from './monaco-setup';
import { useNotesStore } from './notesState';
import type { ResolvedNote } from './notes';
import { useI18n } from './i18n';
import './guide.css';

/**
 * 行级笔记 → 行槽装饰（纯函数，装饰池由 Editor 管）。
 * 同一行有多条笔记时只画一个点，悬浮里把几条都写出来（行槽不是列表）。
 */
export function toNoteDecorations(
  model: monaco.editor.ITextModel,
  notes: ResolvedNote[],
): monaco.editor.IModelDeltaDecoration[] {
  const max = model.getLineCount();
  const byLine = new Map<number, ResolvedNote[]>();
  for (const note of notes) {
    if (note.level !== 'line' || note.resolvedLine <= 0) continue;
    const line = Math.max(1, Math.min(note.resolvedLine, max));
    const bucket = byLine.get(line);
    if (bucket) bucket.push(note);
    else byLine.set(line, [note]);
  }
  const out: monaco.editor.IModelDeltaDecoration[] = [];
  for (const [line, list] of byLine) {
    const bodies = list.map((n) => `- ${n.body}`).join('\n');
    const moved = list.some((n) => n.moved);
    out.push({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        linesDecorationsClassName: moved ? 'wcr-guide-note-gutter moved' : 'wcr-guide-note-gutter',
        linesDecorationsTooltip: list.map((n) => n.body).join(' / ').slice(0, 200),
        hoverMessage: {
          value: `**笔记**（只存本机）\n\n${bodies}${moved ? '\n\n（代码改动过，位置是按内容锚点找回的）' : ''}`,
        },
      },
    });
  }
  return out;
}

/** 一条笔记的展示时间：只到分钟，避免卡片里塞一串毫秒。 */
function fmtTime(at: number): string {
  if (!at) return '';
  const d = new Date(at);
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

/**
 * 行级笔记的编辑浮层（自建 React 组件，与 `Notice.tsx` 同风格）：
 * 列出这一行已有的笔记（可改 / 可删）+ 一个新建输入框。
 * 定位由 Editor 用 `getScrolledVisiblePosition` + 容器 `getBoundingClientRect` 算好后传进来
 * （浮层自己不再碰编辑器，省掉一层耦合）。
 */
export function NotePopover({
  file,
  line,
  anchor,
  notes,
  position,
  onClose,
}: {
  file: string;
  /** 1-based：笔记落在这条行槽上。 */
  line: number;
  /** 该行当前的 anchor（新建笔记时一并存下）。 */
  anchor: string;
  /** 这一行已有的笔记（已按恢复后的行号筛好）。 */
  notes: ResolvedNote[];
  /** 视口坐标（fixed 定位）。 */
  position: { top: number; left: number };
  onClose: () => void;
}) {
  const { t } = useI18n();
  const add = useNotesStore((s) => s.add);
  const update = useNotesStore((s) => s.update);
  const remove = useNotesStore((s) => s.remove);
  const ref = useRef<HTMLDivElement>(null);
  /** 正在改的那条（null = 新建）。 */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [body, setBody] = useState('');

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    // 捕获阶段：Monaco 也会处理 Esc，这里先一步关掉浮层
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const save = () => {
    const text = body.trim();
    if (editingId) {
      if (!text) remove(editingId); // 空内容保存 = 删除
      else update(editingId, text);
    } else if (text) {
      add({ file, line, col: 1, anchor, body: text });
    }
    onClose();
  };

  return (
    <div className="note-pop" style={{ top: position.top, left: position.left }} ref={ref} role="dialog">
      <div className="note-pop-head">
        <span className="note-pop-title">{t('guide.note.popTitle', { line })}</span>
        <span className="guide-muted">{file}</span>
        <span className="spacer" />
        <button className="btn ghost small" onClick={onClose} title={t('guide.note.close')}>
          ✕
        </button>
      </div>

      {notes.length === 0 && <div className="note-pop-empty">{t('guide.note.popEmpty')}</div>}
      {notes.map((note) => (
        <div className={`note-pop-item ${editingId === note.id ? 'editing' : ''}`} key={note.id}>
          <div className="note-pop-body">{note.body}</div>
          <div className="note-pop-meta">
            <span className="guide-muted">{fmtTime(note.updatedAt)}</span>
            {note.moved && <span className="note-pop-moved">{t('guide.note.moved')}</span>}
            <span className="spacer" />
            <button
              className="btn ghost small"
              onClick={() => {
                setEditingId(note.id);
                setBody(note.body);
              }}
            >
              {t('guide.note.edit')}
            </button>
            <button className="btn ghost small" onClick={() => remove(note.id)}>
              {t('guide.note.delete')}
            </button>
          </div>
        </div>
      ))}

      <textarea
        className="note-pop-input"
        autoFocus
        rows={3}
        value={body}
        placeholder={editingId ? t('guide.note.editPlaceholder') : t('guide.note.placeholder')}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            save();
          }
        }}
      />
      <div className="note-pop-foot">
        <button className="btn small" onClick={save}>
          {editingId ? t('guide.note.saveEdit') : t('guide.note.save')}
        </button>
        {editingId && (
          <button
            className="btn ghost small"
            onClick={() => {
              setEditingId(null);
              setBody('');
            }}
          >
            {t('guide.note.newInstead')}
          </button>
        )}
        <span className="guide-muted">{t('guide.note.hint')}</span>
      </div>
    </div>
  );
}

/**
 * 文件级笔记（G4.2）：编辑器上方一条 —— 收起时是一行摘要，点开变成一行可编辑文本。
 * 一个文件只留一条（`notesState.add` 里保证），有笔记时摘要直接可读。
 */
export function FileNoteBar({ projectId, file }: { projectId: string | null; file: string | null }) {
  const { t } = useI18n();
  const notes = useNotesStore((s) => s.notes);
  const add = useNotesStore((s) => s.add);
  const update = useNotesStore((s) => s.update);
  const remove = useNotesStore((s) => s.remove);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');

  const note = useMemo(
    () => (file ? notes.find((n) => n.file === file && n.level === 'file') ?? null : null),
    [notes, file],
  );

  // 换文件 / 笔记被别处改掉时，收起编辑态，避免把上一条的正文留在输入框里
  useEffect(() => {
    setOpen(false);
    setText('');
  }, [file, note?.id]);

  if (!projectId || !file) return null;

  const start = () => {
    setText(note?.body ?? '');
    setOpen(true);
  };
  const save = () => {
    const body = text.trim();
    if (note) {
      if (body) update(note.id, body);
      else remove(note.id); // 清空 = 删掉这条文件级笔记
    } else if (body) {
      add({ file, line: 0, col: 0, anchor: '', body, level: 'file' });
    }
    setOpen(false);
  };

  return (
    <div className="guide-filenote">
      {open ? (
        <>
          <span className="fn-label">{t('guide.note.fileLabel')}</span>
          <input
            className="text-input small fn-input"
            autoFocus
            value={text}
            placeholder={t('guide.note.filePlaceholder')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                save();
              } else if (e.key === 'Escape') {
                setOpen(false);
              }
            }}
          />
          <button className="btn small" onClick={save}>
            {t('guide.note.save')}
          </button>
          <button className="btn ghost small" onClick={() => setOpen(false)}>
            {t('guide.note.cancel')}
          </button>
        </>
      ) : (
        <button className="fn-toggle" onClick={start} title={t('guide.note.fileTitle')}>
          <span className="fn-label">{t('guide.note.fileLabel')}</span>
          <span className={`fn-body ${note ? '' : 'empty'}`}>
            {note ? note.body : t('guide.note.fileEmpty')}
          </span>
          <span className="fn-edit">{note ? t('guide.note.edit') : t('guide.note.fileAdd')}</span>
        </button>
      )}
    </div>
  );
}
