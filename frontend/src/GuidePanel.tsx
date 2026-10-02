/**
 * 侧栏向导面板（04 Guide · W1/W2）：路线 / 进度 / 待读 / 笔记。
 *
 * 形态对齐 `docs/04-guide.md` §3.2：路线是一张可执行的清单 —— 每一步一个文件，
 * 带序号、一句理由、状态（已读 / 在读 / 待读），底部是行进控制；
 * §3.3 的笔记汇总在底部（G4.3 / G4.4）：按文件分组 + 筛选 + 导出。
 * 文案全部走 i18n（`guide.*`），状态与存储都在 `guideState.ts` / `guide.ts` / `notes.ts`。
 */
import { useMemo, useState } from 'react';
import type { FileNode } from '../../shared/types';
import { ROUTE_KINDS } from './guide';
import { useGuideStore, visibleSteps } from './guideState';
import { setRead as setReadMark } from './marks';
import { useMapStore } from './mapState';
import type { Note } from './notes';
import { exportJson as exportNotesJson } from './notes';
import { useNotesStore } from './notesState';
import { downloadText } from './report';
import { showFlash, useStore } from './state';
import { useI18n } from './i18n';
import './guide.css';

/** 文件树里带 lang 的文件数（后端 sourceFiles 字段暂缺时的进度分母兜底）。 */
function countLangFiles(node: FileNode | null): number {
  if (!node) return 0;
  if (node.type === 'file') return node.lang ? 1 : 0;
  return (node.children ?? []).reduce((n, child) => n + countLangFiles(child), 0);
}

export function GuidePanel({
  onOpenFile,
}: {
  onOpenFile: (file: string, line?: number, col?: number) => void;
}) {
  const { t } = useI18n();
  const openFile = useStore((s) => s.openFile);
  const projectId = useStore((s) => s.projectId);
  const tree = useStore((s) => s.tree);
  const readMarks = useMapStore((s) => s.read);

  const routes = useGuideStore((s) => s.routes);
  const busy = useGuideStore((s) => s.busy);
  const partial = useGuideStore((s) => s.partial);
  const kind = useGuideStore((s) => s.kind);
  const custom = useGuideStore((s) => s.custom);
  const done = useGuideStore((s) => s.done);
  const readstate = useGuideStore((s) => s.readstate);
  const queue = useGuideStore((s) => s.queue);
  const sourceFiles = useGuideStore((s) => s.sourceFiles);
  const setKind = useGuideStore((s) => s.setKind);
  const markDone = useGuideStore((s) => s.markDone);
  const moveStep = useGuideStore((s) => s.moveStep);
  const saveCustom = useGuideStore((s) => s.saveCustom);
  const resetCustom = useGuideStore((s) => s.resetCustom);
  const addQueue = useGuideStore((s) => s.addQueue);
  const removeQueue = useGuideStore((s) => s.removeQueue);
  const clearQueue = useGuideStore((s) => s.clearQueue);

  /** 「重排」开关：打开后每一步显示上移 / 下移（不做拖拽）。 */
  const [reorder, setReorder] = useState(false);

  const route = routes?.routes.find((r) => r.kind === kind) ?? null;
  const steps = useMemo(() => visibleSteps({ routes, kind, custom }), [routes, kind, custom]);
  const doneCount = steps.filter((s) => done[s.file] || readMarks[s.file]).length;
  const hereIndex = steps.findIndex((s) => s.file === openFile);
  const currentFile = openFile && hereIndex >= 0 ? openFile : null;
  const nextFile = useGuideStore((s) => s.nextStepOf(currentFile));
  const prevFile = hereIndex > 0 ? steps[hereIndex - 1].file : null;

  const readCount = Object.keys(readMarks).length;
  const totalSource = sourceFiles ?? (countLangFiles(tree) || null);
  /** 当前文件的「已读」——打开即已读与手动标记合并，取消时两套一起清。 */
  const openIsDone = openFile ? Boolean(done[openFile] || readMarks[openFile]) : false;
  const toggleRead = () => {
    if (!openFile) return;
    if (openIsDone) {
      markDone(openFile, false);
      if (projectId) setReadMark(projectId, openFile, false);
    } else {
      markDone(openFile, true);
    }
  };

  const cycleRoute = () => {
    const i = ROUTE_KINDS.indexOf(kind);
    setKind(ROUTE_KINDS[(i + 1) % ROUTE_KINDS.length]);
  };

  return (
    <div className="guide-panel">
      {partial && (
        <div className="guide-partial" role="status">
          {t('guide.route.partial')}
        </div>
      )}

      {/* ------------------------------------------------------------ 路线 */}
      <section className="guide-section">
        <header className="guide-sec-head">
          <h3>
            {t('guide.route.title', {
              label: route?.label ?? kind,
              total: route?.total ?? 0,
            })}
          </h3>
          <span className="guide-muted">
            {t('guide.route.done', { done: doneCount, total: steps.length })}
          </span>
        </header>

        <div className="guide-actions">
          <button className="btn ghost small" onClick={cycleRoute} title={t('guide.route.changeTitle')}>
            {t('guide.route.change')}
          </button>
          <button
            className={`btn ghost small ${reorder ? 'active' : ''}`}
            onClick={() => setReorder((v) => !v)}
            disabled={!steps.length}
            title={t('guide.route.reorderTitle')}
          >
            {t('guide.route.reorder')}
          </button>
          <button className="btn ghost small" onClick={saveCustom} disabled={!steps.length}>
            {t('guide.route.save')}
          </button>
          {custom.length > 0 && (
            <button className="btn ghost small" onClick={resetCustom} title={t('guide.route.resetTitle')}>
              {t('guide.route.reset')}
            </button>
          )}
        </div>

        {busy && !routes && <div className="guide-empty">{t('guide.route.loading')}</div>}
        {!busy && !steps.length && <div className="guide-empty">{t('guide.route.empty')}</div>}

        {steps.length > 0 && (
          <div className="guide-steps">
            {steps.map((step) => {
              // G3.1「打开即已读」与手动标记合并：任一为真就是已读
              const isDone = Boolean(done[step.file]) || Boolean(readMarks[step.file]);
              const isHere = step.file === openFile;
              return (
                <div
                  key={step.file}
                  className={`guide-step ${isDone ? 'done' : ''} ${isHere ? 'here' : ''}`}
                >
                  <span className="guide-step-order">{step.order}</span>
                  <button
                    className="guide-step-main"
                    onClick={() => onOpenFile(step.file)}
                    title={`${step.file}\n${step.reason}`}
                  >
                    <span className="guide-step-file">{step.file}</span>
                    <span className="guide-step-reason">{step.reason}</span>
                  </button>
                  <span className={`guide-step-state ${isDone ? 'read' : isHere ? 'at' : 'todo'}`}>
                    {isDone ? t('guide.route.status.read') : isHere ? t('guide.route.status.at') : t('guide.route.status.todo')}
                  </span>
                  {isHere && <span className="guide-step-here">{t('guide.route.here')}</span>}
                  {reorder && (
                    <span className="guide-step-move">
                      <button
                        className="btn ghost small"
                        disabled={step.order === 1}
                        onClick={() => moveStep(step.file, -1)}
                        title={t('guide.route.up')}
                      >
                        ↑
                      </button>
                      <button
                        className="btn ghost small"
                        disabled={step.order === steps.length}
                        onClick={() => moveStep(step.file, 1)}
                        title={t('guide.route.down')}
                      >
                        ↓
                      </button>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {route?.truncated && (
          <div className="guide-muted">
            {t('guide.route.truncated', { shown: steps.length, total: route.total })}
          </div>
        )}

        <div className="guide-nav">
          <button
            className="btn ghost small"
            disabled={!prevFile}
            onClick={() => prevFile && onOpenFile(prevFile)}
            title={prevFile ?? t('guide.nav.noPrev')}
          >
            {t('guide.nav.prev')}
          </button>
          <button
            className="btn ghost small"
            disabled={!nextFile}
            onClick={() => nextFile && onOpenFile(nextFile)}
            title={nextFile ?? t('guide.nav.noNext')}
          >
            {t('guide.nav.next')}
          </button>
          <button className="btn ghost small" disabled={!openFile} onClick={toggleRead}>
            {openIsDone ? t('guide.nav.markUnread') : t('guide.nav.markRead')}
          </button>
          <button
            className="btn ghost small"
            disabled={!openFile}
            onClick={() => openFile && addQueue({ file: openFile, line: 1, col: 1 })}
          >
            {t('guide.nav.queue')}
          </button>
        </div>
      </section>

      {/* ------------------------------------------------------------ 进度 */}
      <section className="guide-section">
        <h3>{t('guide.progress.title')}</h3>
        <div className="guide-progress" title={t('guide.progress.note')}>
          {totalSource
            ? t('guide.progress.line', { read: readCount, total: totalSource })
            : t('guide.progress.noTotal', { read: readCount })}
        </div>
      </section>

      {/* ------------------------------------------------------------ 待读 */}
      <section className="guide-section">
        <header className="guide-sec-head">
          <h3>{t('guide.queue.title', { n: queue.length })}</h3>
          {queue.length > 0 && (
            <button className="btn ghost small" onClick={clearQueue}>
              {t('guide.queue.clear')}
            </button>
          )}
        </header>
        {queue.length === 0 && <div className="guide-empty">{t('guide.queue.empty')}</div>}
        {queue.map((item) => (
          <div className="guide-queue-row" key={`${item.file}:${item.line}`}>
            <button
              className="guide-queue-main"
              onClick={() => onOpenFile(item.file, item.line, item.col)}
              title={`${item.file}:${item.line}`}
            >
              <span className="guide-queue-file">{item.file}</span>
              <span className="guide-muted">L{item.line}</span>
            </button>
            {item.note && <span className="guide-queue-note">{item.note}</span>}
            <button
              className="btn ghost small"
              onClick={() => removeQueue(item.file, item.line)}
              title={t('guide.queue.remove')}
            >
              ✕
            </button>
          </div>
        ))}
        {readstate && (
          <div className="guide-muted">
            {t('guide.progress.lastRead', { file: readstate.file, line: readstate.line })}
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------ 笔记（W2） */}
      <NotesSection currentFile={openFile} onOpenFile={onOpenFile} />
    </div>
  );
}

/** 文件级笔记在列表里的标记（行级写 `path:line`，文件级只有路径）。 */
function noteSpot(note: Note): string {
  return note.level === 'file' ? note.file : `${note.file}:${note.line}`;
}

/**
 * G4.3 / G4.4：笔记汇总 —— 按文件分组、三档筛选（全部 / 当前文件 / 待归位）、
 * 点一条跳回原处、导出 Markdown / JSON、导入 JSON（合并去重）。
 *
 * 「待归位」只对**当前打开的文件**成立：锚点校验要靠文件正文，而正文只有编辑器有。
 * 所以这一档的条数是「当前文件里没找到原位置的笔记」，文案里如实说明。
 */
function NotesSection({
  currentFile,
  onOpenFile,
}: {
  currentFile: string | null;
  onOpenFile: (file: string, line?: number, col?: number) => void;
}) {
  const { t } = useI18n();
  const projectId = useStore((s) => s.projectId);
  const projectName = useStore((s) => s.project?.name ?? '');
  const notes = useNotesStore((s) => s.notes);
  const orphans = useNotesStore((s) => s.orphans);
  const remove = useNotesStore((s) => s.remove);
  const importJson = useNotesStore((s) => s.importJson);
  const exportMarkdown = useNotesStore((s) => s.exportMarkdown);
  const [filter, setFilter] = useState<'all' | 'current' | 'orphans'>('all');

  /** 筛过的笔记，按「文件 → 文件级在前 → 行号」分组（顺序与存储一致）。 */
  const groups = useMemo(() => {
    const list = filter === 'current' ? notes.filter((n) => n.file === currentFile) : filter === 'orphans' ? orphans : notes;
    const out: Array<{ file: string; items: Note[] }> = [];
    for (const note of list) {
      const last = out[out.length - 1];
      if (last && last.file === note.file) last.items.push(note);
      else out.push({ file: note.file, items: [note] });
    }
    return out;
  }, [notes, orphans, filter, currentFile]);

  const shown = groups.reduce((n, g) => n + g.items.length, 0);
  /** 待归位的那几条（在「全部」视图里也要标出来：它的行号是旧的，不可信）。 */
  const orphanIds = useMemo(() => new Set(orphans.map((n) => n.id)), [orphans]);
  // 文件名只带日期：项目名可能含空格 / 路径分隔符，不往文件名里塞
  const stamp = new Date().toISOString().slice(0, 10);

  const doExportMarkdown = () => {
    if (!notes.length) {
      showFlash(t('guide.notes.exportEmpty'));
      return;
    }
    downloadText(`notes-${stamp}.md`, exportMarkdown(projectName || t('app.title')));
    showFlash(t('guide.notes.exportDone', { n: notes.length }));
  };

  const doExportJson = () => {
    if (!projectId) return;
    downloadText(`notes-${stamp}.json`, exportNotesJson(projectId));
    showFlash(t('guide.notes.exportDone', { n: notes.length }));
  };

  return (
    <section className="guide-section">
      <header className="guide-sec-head">
        <h3>{t('guide.notes.title')}</h3>
        <span className="guide-muted">{t('guide.notes.count', { n: notes.length })}</span>
      </header>

      <div className="guide-actions">
        <button
          className={`btn ghost small ${filter === 'all' ? 'active' : ''}`}
          onClick={() => setFilter('all')}
        >
          {t('guide.notes.filter.all')}
        </button>
        <button
          className={`btn ghost small ${filter === 'current' ? 'active' : ''}`}
          onClick={() => setFilter('current')}
          disabled={!currentFile}
          title={currentFile ?? t('guide.notes.noCurrent')}
        >
          {t('guide.notes.filter.current')}
        </button>
        <button
          className={`btn ghost small ${filter === 'orphans' ? 'active' : ''}`}
          onClick={() => setFilter('orphans')}
        >
          {t('guide.notes.filter.orphans', { n: orphans.length })}
        </button>
      </div>

      {filter === 'orphans' && (
        <div className="guide-orphan-note">
          <b>{t('guide.notes.orphansTitle')}</b> {t('guide.notes.orphansNote')}
        </div>
      )}

      {shown === 0 && (
        <div className="guide-empty">
          {filter === 'orphans'
            ? t('guide.notes.orphansEmpty')
            : notes.length === 0
              ? t('guide.notes.empty')
              : t('guide.notes.emptyCurrent')}
        </div>
      )}

      {groups.map((group) => (
        <div className="guide-note-group" key={group.file}>
          <div className="guide-note-file" title={group.file}>
            {group.file}
            <span className="guide-muted"> ({group.items.length})</span>
          </div>
          {group.items.map((note) => {
            // 待归位的行级笔记：原行号已经不可信，跳转只到文件（不把人送到错的一行）
            const lostHere = orphanIds.has(note.id);
            const target = lostHere
              ? { file: note.file, line: undefined, col: undefined }
              : { file: note.file, line: note.line, col: note.col || 1 };
            return (
              <div className="guide-note-row" key={note.id}>
                <button
                  className="guide-note-main"
                  onClick={() => onOpenFile(target.file, target.line, target.col)}
                  title={lostHere ? `${noteSpot(note)}\n${t('guide.notes.orphanJump')}` : noteSpot(note)}
                >
                  <span className="guide-note-spot">
                    {note.level === 'file'
                      ? t('guide.notes.fileLevel')
                      : lostHere
                        ? t('guide.notes.spotOrphan', { line: note.line })
                        : `L${note.line}`}
                  </span>
                  <span className="guide-note-body">{note.body}</span>
                </button>
                <button
                  className="btn ghost small"
                  onClick={() => onOpenFile(target.file, target.line, target.col)}
                  title={lostHere ? t('guide.notes.orphanJump') : t('guide.notes.jump')}
                >
                  →
                </button>
                <button className="btn ghost small" onClick={() => remove(note.id)} title={t('guide.notes.delete')}>
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      ))}

      <div className="guide-note-foot">
        <button className="btn ghost small" onClick={doExportMarkdown}>
          {t('guide.notes.export')}
        </button>
        <button className="btn ghost small" onClick={doExportJson}>
          {t('guide.notes.exportJson')}
        </button>
        <label className="btn ghost small" title={t('guide.notes.importTitle')}>
          {t('guide.notes.import')}
          <input
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              void f.text().then((text) => {
                try {
                  const added = importJson(text);
                  showFlash(added > 0 ? t('guide.notes.importOk', { n: added }) : t('guide.notes.importNone'));
                } catch {
                  showFlash(t('guide.notes.importFail'));
                }
              });
            }}
          />
        </label>
      </div>
      <div className="guide-muted">{t('guide.notes.hint')}</div>
    </section>
  );
}
