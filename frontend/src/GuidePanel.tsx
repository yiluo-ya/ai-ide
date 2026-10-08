/**
 * 侧栏向导面板（04 Guide · W1/W2）：阅读路线 + 继续阅读。
 *
 * 形态对齐 `docs/04-guide.md` §3.2：路线是一张可执行的清单 —— 每一步一个文件，
 * 带序号、一句理由；底部是行进控制。
 * 2026-10-08 用户要求清除「已读 / 待读」：步骤状态点、进度计数与待读清单随之移除。
 * 文案全部走 i18n（`guide.*`），状态与存储都在 `guideState.ts` / `guide.ts`。
 */
import { useMemo, useState } from 'react';
import { ROUTE_KINDS } from './guide';
import { useGuideStore, visibleSteps } from './guideState';
import { useStore } from './state';
import { useI18n } from './i18n';
import './guide.css';

export function GuidePanel({
  onOpenFile,
}: {
  onOpenFile: (file: string, line?: number, col?: number) => void;
}) {
  const { t } = useI18n();
  const openFile = useStore((s) => s.openFile);

  const routes = useGuideStore((s) => s.routes);
  const busy = useGuideStore((s) => s.busy);
  const partial = useGuideStore((s) => s.partial);
  const kind = useGuideStore((s) => s.kind);
  const custom = useGuideStore((s) => s.custom);
  const readstate = useGuideStore((s) => s.readstate);
  const setKind = useGuideStore((s) => s.setKind);
  const moveStep = useGuideStore((s) => s.moveStep);
  const saveCustom = useGuideStore((s) => s.saveCustom);
  const resetCustom = useGuideStore((s) => s.resetCustom);

  /** 「重排」开关：打开后每一步显示上移 / 下移（不做拖拽）。 */
  const [reorder, setReorder] = useState(false);

  const route = routes?.routes.find((r) => r.kind === kind) ?? null;
  const steps = useMemo(() => visibleSteps({ routes, kind, custom }), [routes, kind, custom]);
  const hereIndex = steps.findIndex((s) => s.file === openFile);
  const currentFile = openFile && hereIndex >= 0 ? openFile : null;
  const nextFile = useGuideStore((s) => s.nextStepOf(currentFile));
  const prevFile = hereIndex > 0 ? steps[hereIndex - 1].file : null;

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
              const isHere = step.file === openFile;
              return (
                <div key={step.file} className={`guide-step ${isHere ? 'here' : ''}`}>
                  <span className="guide-step-order">{step.order}</span>
                  <button
                    className="guide-step-main"
                    onClick={() => onOpenFile(step.file, step.line ?? 1)}
                    title={`${step.file}:${step.line ?? 1}\n${step.reason}${
                      step.hints?.length
                        ? t('guide.hints.title', {
                            list: step.hints
                              .map((h) => t('guide.hints.item', { name: h.name, line: h.line }))
                              .join(t('guide.hints.sep')),
                          })
                        : ''
                    }`}
                  >
                    <span className="guide-step-file">{step.file}</span>
                    <span className="guide-step-reason">{step.reason}</span>
                    {/* 说到「打开哪一行、看什么」才叫向导：只给文件名，人还得自己在文件里找入口 */}
                    {step.hints?.length ? (
                      <span className="guide-step-hints">
                        {t('guide.hints.preview', { line: step.line ?? 1, names: step.hints.map((h) => h.name).join(' / ') })}
                      </span>
                    ) : null}
                  </button>
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
        </div>
      </section>

      {/* ------------------------------------------------------------ 继续阅读（G3.4） */}
      {readstate && (
        <section className="guide-section">
          <h3>{t('guide.start.continue')}</h3>
          <div className="guide-muted">
            {t('guide.progress.lastRead', { file: readstate.file, line: readstate.line })}
          </div>
        </section>
      )}
    </div>
  );
}
