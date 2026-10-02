/**
 * 首次使用引导（P16 / 06 §3.2 草图）：空白页 → 5 秒内完成第一次成功操作（填路径 → 看到文件树）。
 *
 * 三步：① 路径输入 + 打开；② 最近项目；③ 索引进度 + 完成摘要（点击「为什么没索引上？」开索引报告）。
 * 落在 Overview 真正可达的空状态位置（未打开项目 / 已打开但无文件），不再留 App 里的死分支。
 */
import { useEffect, useMemo, useState } from 'react';
import type { IndexReport } from '../../shared/types';
import { api } from './api';
import { useI18n, type TFunc } from './i18n';
import { useStore } from './state';

/** 相对时间（与概览页同一口径，避免两处说法不一致）。 */
function relTime(t: TFunc, ms: number, now = Date.now()): string {
  const diff = now - ms;
  const minute = 60_000;
  if (diff < minute) return t('welcome.timeJustNow');
  if (diff < 60 * minute) return t('welcome.timeMinutes', { n: Math.floor(diff / minute) });
  if (diff < 24 * 60 * minute) return t('welcome.timeHours', { n: Math.floor(diff / (60 * minute)) });
  const days = Math.floor(diff / (24 * 60 * minute));
  if (days < 30) return t('welcome.timeDays', { n: days });
  return new Date(ms).toLocaleDateString();
}

export function Welcome({
  /** first = 还没打开任何项目；empty = 项目打开了但没有可读源码文件。 */
  variant,
  onOpenReport,
}: {
  variant: 'first' | 'empty';
  onOpenReport?: () => void;
}) {
  const { t } = useI18n();
  const projects = useStore((s) => s.projects);
  const project = useStore((s) => s.project);
  const status = useStore((s) => s.status);
  const [input, setInput] = useState('');
  const [report, setReport] = useState<IndexReport | null>(null);

  const projectId = project?.id ?? null;

  // 索引摘要（P9）：优先用后端报告（含降级与原因归类），拿不到就退回 status
  useEffect(() => {
    if (!projectId) {
      setReport(null);
      return;
    }
    let cancelled = false;
    api
      .indexReport(projectId)
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch(() => {
        if (!cancelled) setReport(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, status?.indexedAt]);

  const recent = useMemo(
    () =>
      [...projects]
        .sort((a, b) => (b.status?.indexedAt ?? b.createdAt) - (a.status?.indexedAt ?? a.createdAt))
        .slice(0, 6),
    [projects],
  );

  const submit = () => {
    const root = input.trim();
    if (!root) return;
    void useStore.getState().openFolder(root);
    setInput('');
  };

  const indexing = status?.indexing === true;
  const indexed = report?.indexed ?? status?.filesIndexed ?? 0;
  const total = report?.scanned ?? status?.filesTotal ?? 0;
  const skipped = Math.max(0, total - indexed);
  const percent = total > 0 ? Math.round((indexed / total) * 100) : 0;

  return (
    <div className="welcome-panel">
      <h2 className="wp-title">{t('welcome.title')}</h2>
      <p className="wp-lead">{t('welcome.lead')}</p>
      {variant === 'empty' && <p className="wp-note">{t('welcome.noFiles')}</p>}

      <section className="wp-step" aria-labelledby="wp-step1">
        <h3 id="wp-step1">{t('welcome.step1')}</h3>
        <form
          className="wp-open"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            className="text-input wp-path"
            type="text"
            value={input}
            autoFocus={variant === 'first' && !projectId}
            aria-label={t('welcome.pathLabel')}
            placeholder={t('welcome.pathPlaceholder')}
            onChange={(e) => setInput(e.target.value)}
          />
          <button className="btn" type="submit" disabled={!input.trim()}>
            {t('welcome.open')}
          </button>
        </form>
        <div className="hint-row">{t('welcome.lead')}</div>
      </section>

      <section className="wp-step" aria-labelledby="wp-step2">
        <h3 id="wp-step2">{t('welcome.step2')}</h3>
        {recent.length === 0 ? (
          <div className="wp-note">{t('welcome.recentEmpty')}</div>
        ) : (
          <ul className="wp-recent" aria-label={t('welcome.recentAria')}>
            {recent.map((p) => (
              <li key={p.id}>
                <button
                  className="wp-recent-item"
                  onClick={() => void useStore.getState().selectProject(p.id)}
                  title={p.root}
                >
                  <span className="wp-recent-name">{p.name}</span>
                  <span className="wp-recent-root">{p.root}</span>
                  <span className="wp-recent-time">{relTime(t, p.status?.indexedAt ?? p.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="wp-step" aria-labelledby="wp-step3">
        <h3 id="wp-step3">{t('welcome.step3')}</h3>
        {indexing ? (
          <>
            <div className="wp-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
              <span className="wp-progress-bar" style={{ width: `${percent}%` }} />
            </div>
            <div className="wp-note">
              {t('welcome.indexing', { indexed: status?.filesIndexed ?? 0, total: status?.filesTotal ?? '?' })}
            </div>
            <div className="wp-note">{t('welcome.indexUsable')}</div>
          </>
        ) : projectId ? (
          <>
            <div className="wp-summary">
              {t('welcome.indexDone', { files: total, indexed, skipped })}
            </div>
            {onOpenReport && (
              <button className="ov-linklike" onClick={onOpenReport}>
                {t('welcome.whySkipped')}
              </button>
            )}
          </>
        ) : (
          <div className="wp-note">{t('welcome.indexIdle')}</div>
        )}
      </section>

      <div className="wp-privacy">{t('welcome.privacyNote')}</div>
    </div>
  );
}
