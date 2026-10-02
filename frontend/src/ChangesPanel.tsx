/**
 * 变更面板（04 Guide · W3 / G8.1–G8.4）：侧栏 `changes` tab。
 *
 * 形态对齐 `docs/04-guide.md` §3.4：先给「变了几个文件 / 多少行」，再逐条给
 * 状态（M/A/D）+ 文件 + 行数增减 + 来源徽标 + 笔记关联，每条三个动作
 * （看差异 / 重新读 / 已读跳过）；顶部一条「只看我笔记过期的文件」。
 *
 * 三条不撒谎的规矩：
 * 1) 没有基线（还没记录快照）→ 整块换成「记录当前为阅读基线」，不用假数字占位；
 * 2) 后端 `source === 'snapshot'`（无 git）→ 头部写明「未检测到 git，仅按行数对比」
 *    （`git === 'no-head'` 时写成「是仓库但还没有提交」—— 刚 git init 的项目别被说成「没有 git」），
 *    并且**不显示** addedLines / removedLines（后端给的是 null，界面不编 `+0 -0`）；
 * 3) 会话内变更（SSE）只报「刚刚有 N 个文件变更」，不假装知道变了什么 ——
 *    变了什么只有重新比对后的结果才算数。
 */
import { useMemo } from 'react';
import type { ChangeFile } from '../../shared/types';
import { staleFileCount, staleNoteCount, useChangesStore, visibleChanges } from './changesState';
import { snapshotAge } from './readSnapshot';
import { timeAgoMs } from './timeAgo';
import { useMapStore } from './mapState';
import type { TFunc } from './i18n';
import { useI18n } from './i18n';
import './changes.css';

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString();
}

/** 行数增减：二进制标「二进制」，拿不到数字（快照模式）就不显示。 */
function deltaText(file: ChangeFile, t: TFunc): string {
  if (file.binary) return t('changes.binary');
  const added = file.addedLines;
  const removed = file.removedLines;
  if (added == null || removed == null) return '';
  return removed === 0 ? `+${added}` : `+${added} -${removed}`;
}

function OriginBadge({ file }: { file: ChangeFile }) {
  const { t } = useI18n();
  if (file.origin === 'agent') {
    return (
      <span className="changes-origin agent" title={t('changes.originAgentTitle')}>
        {t('changes.originAgent')}
      </span>
    );
  }
  return (
    <span className="changes-origin inferred" title={t('changes.originInferredTitle')}>
      {t('changes.originInferred')}
    </span>
  );
}

export function ChangesPanel({
  onOpenFile,
  onOpenDiff,
}: {
  /** 打开文件（「重新读 / 开始读」）。 */
  onOpenFile: (file: string) => void;
  /** 打开只读 diff 浮层（「看差异」）。 */
  onOpenDiff: (file: string) => void;
}) {
  const { t } = useI18n();
  const projectId = useChangesStore((s) => s.projectId);
  const summary = useChangesStore((s) => s.summary);
  const snapshot = useChangesStore((s) => s.snapshot);
  const hasSnapshot = useChangesStore((s) => s.hasSnapshot);
  const busy = useChangesStore((s) => s.busy);
  const error = useChangesStore((s) => s.error);
  const dismissed = useChangesStore((s) => s.dismissed);
  const onlyStale = useChangesStore((s) => s.onlyStale);
  const setOnlyStale = useChangesStore((s) => s.setOnlyStale);
  const refresh = useChangesStore((s) => s.refresh);
  const recordBaseline = useChangesStore((s) => s.recordBaseline);
  const dismissFile = useChangesStore((s) => s.dismissFile);
  /** M9.3：SSE 报过的文件（20 秒后自动消失）——只用来提示「刚刚有变更」，不描述内容。 */
  const pulse = useMapStore((s) => s.pulse);

  const rows = useMemo(
    () => visibleChanges({ summary, dismissed, onlyStale }),
    [summary, dismissed, onlyStale],
  );
  const pulseCount = Object.keys(pulse).length;
  const age = snapshotAge(snapshot);
  const staleNotes = staleNoteCount(summary);
  const staleFiles = staleFileCount(summary);

  return (
    <div className="changes-panel">
      {pulseCount > 0 && (
        <div className="changes-live" role="status">
          <span>{t('changes.live', { n: pulseCount })}</span>
          <button className="btn ghost small" onClick={() => void refresh()} disabled={!hasSnapshot || busy}>
            {t('changes.refresh')}
          </button>
        </div>
      )}

      <section className="changes-section">
        <header className="changes-head">
          <h3>
            {snapshot
              ? t('changes.titleRange', { from: fmtDate(snapshot.at), to: t('changes.today') })
              : t('changes.title')}
          </h3>
          {snapshot && age != null && (
            <span className="guide-muted">
              {t('changes.baselineAge', { age: timeAgoMs(age, t) })}
            </span>
          )}
        </header>

        {!hasSnapshot ? (
          <div className="changes-nobase">
            <div className="guide-empty">{t('changes.noBaseline')}</div>
            <button className="btn ghost small" onClick={() => void recordBaseline()} disabled={!projectId || busy}>
              {t('changes.record')}
            </button>
          </div>
        ) : (
          <>
            {summary && (
              <div className="changes-counts">
                {t('changes.counts', {
                  files: summary.files.length,
                  added: summary.counts.added,
                  modified: summary.counts.modified,
                  deleted: summary.counts.deleted,
                })}
                {summary.source === 'git' && (
                  <span className="changes-lines">
                    {t('changes.lines', {
                      added: summary.counts.addedLines,
                      removed: summary.counts.removedLines,
                    })}
                  </span>
                )}
              </div>
            )}
            {summary?.source === 'snapshot' && (
              <div className="changes-nogit" role="note">
                {summary.git === 'no-head' ? t('changes.noGitHead') : t('changes.noGit')}
              </div>
            )}
            {summary && staleNotes > 0 && (
              <div className="changes-note-summary">
                {t('changes.notesSummary', { files: staleFiles, notes: staleNotes })}
              </div>
            )}
            <div className="changes-toolbar">
              <label title={t('changes.onlyStaleTitle')}>
                <input
                  type="checkbox"
                  checked={onlyStale}
                  onChange={(e) => setOnlyStale(e.target.checked)}
                />
                {t('changes.onlyStale')}
              </label>
              <span className="spacer" />
              <button className="btn ghost small" onClick={() => void refresh()} disabled={busy}>
                {t('changes.refresh')}
              </button>
              <button
                className="btn ghost small"
                onClick={() => void recordBaseline()}
                disabled={busy}
                title={t('changes.recordTitle')}
              >
                {t('changes.record')}
              </button>
            </div>

            {error && (
              <div className="changes-error">
                {error === 'baseline-failed'
                  ? t('changes.baselineFailed')
                  : t('changes.error', { message: error })}
              </div>
            )}
            {busy && !summary && <div className="guide-empty">{t('changes.loading')}</div>}

            {summary && rows.length === 0 && (
              <div className="guide-empty">
                {onlyStale ? t('changes.emptyStale') : t('changes.empty')}
              </div>
            )}

            <div className="changes-rows">
              {rows.map((file) => {
                const delta = deltaText(file, t);
                return (
                  <div className={`changes-row s-${file.status}`} key={file.file}>
                    <span className={`changes-status ${file.status}`} title={t(`changes.status.${file.status}`)}>
                      {file.status}
                    </span>
                    <button className="changes-file" onClick={() => onOpenFile(file.file)} title={file.file}>
                      {file.file}
                    </button>
                    {delta && <span className="changes-delta">{delta}</span>}
                    <OriginBadge file={file} />
                    {file.notes > 0 && (
                      <span className="changes-note-count" title={t('changes.notesTitle')}>
                        {t('changes.notes', { n: file.notes })}
                      </span>
                    )}
                    {file.noteStale && <span className="changes-stale">{t('changes.noteStale')}</span>}
                    <span className="changes-row-actions">
                      <button className="btn ghost small" onClick={() => onOpenDiff(file.file)}>
                        {t('changes.diff')}
                      </button>
                      <button className="btn ghost small" onClick={() => onOpenFile(file.file)}>
                        {file.status === 'A' ? t('changes.startRead') : t('changes.reRead')}
                      </button>
                      <button className="btn ghost small" onClick={() => dismissFile(file.file)}>
                        {t('changes.dismiss')}
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>

      <div className="nav-foot">{t('changes.foot')}</div>
    </div>
  );
}
