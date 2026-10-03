/**
 * 侧栏向导面板（04 Guide · W1/W2）：路线 / 进度 / 待读。
 *
 * 形态对齐 `docs/04-guide.md` §3.2：路线是一张可执行的清单 —— 每一步一个文件，
 * 带序号、一句理由、状态（已读 / 在读 / 待读），底部是行进控制。
 * 文案全部走 i18n（`guide.*`），状态与存储都在 `guideState.ts` / `guide.ts`。
 */
import { useMemo, useState } from 'react';
import type { FileNode } from '../../shared/types';
import { ROUTE_KINDS } from './guide';
import { useGuideStore, visibleSteps } from './guideState';
import { setRead as setReadMark } from './marks';
import { useMapStore } from './mapState';
import { useStore } from './state';
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
                    onClick={() => onOpenFile(step.file, step.line ?? 1)}
                    title={`${step.file}:${step.line ?? 1}\n${step.reason}${
                      step.hints?.length ? `\n关注点：${step.hints.map((h) => `${h.name}（第 ${h.line} 行）`).join('、')}` : ''
                    }`}
                  >
                    <span className="guide-step-file">{step.file}</span>
                    <span className="guide-step-reason">{step.reason}</span>
                    {/* 说到「打开哪一行、看什么」才叫向导：只给文件名，人还得自己在文件里找入口 */}
                    {step.hints?.length ? (
                      <span className="guide-step-hints">
                        先看第 {step.line ?? 1} 行 · {step.hints.map((h) => h.name).join(' / ')}
                      </span>
                    ) : null}
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

    </div>
  );
}

