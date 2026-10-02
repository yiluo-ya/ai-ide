/**
 * 索引报告（P9 / P8 的界面出口）：
 * - P9：哪些文件没进索引、按什么原因归类（大文件 / 二进制 / 解析失败 / 读盘失败 / 被忽略 / 非源码）+ 编码分布；
 * - P8：生效的忽略规则来源与命中数（「规则真的生效了」要看得见）。
 *
 * 后端未提供端点（404）时如实说明「当前后端没有这个接口」，不报红、不影响阅读。
 */
import { useEffect, useState } from 'react';
import type { IgnoreInfo, IndexReport } from '../../shared/types';
import { api } from './api';
import { Dialog } from './Dialog';
import { useI18n, type TFunc } from './i18n';

/** 后端 SkipReason → 文案 key（未知原因原样显示，不吞掉事实）。 */
const REASON_KEY: Record<string, string> = {
  'too-large': 'report.reason.too-large',
  binary: 'report.reason.binary',
  'parse-failed': 'report.reason.parse-failed',
  'read-error': 'report.reason.read-error',
  ignored: 'report.reason.ignored',
  'not-source': 'report.reason.not-source',
};

function reasonLabel(t: TFunc, reason: string): string {
  const key = REASON_KEY[reason];
  return key ? t(key) : reason;
}

const FILES_PER_REASON = 8;

export function IndexReportDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { t } = useI18n();
  const [report, setReport] = useState<IndexReport | null>(null);
  const [ignore, setIgnore] = useState<IgnoreInfo | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'unavailable'>('loading');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    api
      .indexReport(projectId)
      .then((r) => {
        if (cancelled) return;
        setReport(r);
        setState('ok');
      })
      .catch(() => {
        if (!cancelled) setState('unavailable');
      });
    api
      .ignoreInfo(projectId)
      .then((info) => {
        if (!cancelled) setIgnore(info);
      })
      .catch(() => {
        /* 忽略规则段拿不到就不显示，不影响报告主体 */
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <Dialog title={t('report.title')} onClose={onClose} wide>
      {state === 'loading' && <p className="wcr-note">{t('report.loading')}</p>}
      {state === 'unavailable' && <p className="wcr-note">{t('report.unavailable')}</p>}

      {state === 'ok' && report && (
        <>
          <p className="report-summary">
            {t('report.summary', {
              scanned: report.scanned,
              indexed: report.indexed,
              degraded: report.degraded,
              sourceFiles: report.sourceFiles,
            })}
          </p>

          <h3 className="wcr-section-title">{t('report.reasonTitle')}</h3>
          {report.byReason.length === 0 && <p className="wcr-note">{t('report.none')}</p>}
          <ul className="report-reasons">
            {report.byReason.map((g) => (
              <li key={g.reason}>
                <details>
                  <summary>
                    <span className="report-reason-name">{reasonLabel(t, g.reason)}</span>
                    <span className="report-reason-count">{g.count}</span>
                  </summary>
                  <ul className="report-files">
                    {g.files.slice(0, FILES_PER_REASON).map((f) => (
                      <li key={f} title={f}>
                        {f}
                      </li>
                    ))}
                  </ul>
                  {g.files.length > FILES_PER_REASON && (
                    <div className="wcr-note">{t('report.filesMore', { n: g.files.length - FILES_PER_REASON })}</div>
                  )}
                </details>
              </li>
            ))}
          </ul>

          <h3 className="wcr-section-title">{t('report.encodings')}</h3>
          <ul className="report-encodings">
            {report.encodings.map((e) => (
              <li key={e.encoding}>
                <code>{e.encoding}</code>
                <span className="report-reason-count">{e.count}</span>
              </li>
            ))}
          </ul>

          <p className="wcr-note">
            {t('report.generatedAt', { at: new Date(report.generatedAt).toLocaleString() })}
          </p>
        </>
      )}

      <h3 className="wcr-section-title">{t('settings.ignore')}</h3>
      {ignore ? (
        <div className="report-ignore">
          {ignore.sources.length === 0 ? (
            <p className="wcr-note">{t('settings.ignoreNone')}</p>
          ) : (
            <ul className="report-files">
              {ignore.sources.map((s) => (
                <li key={s.path}>
                  {s.path} · {s.rules}
                </li>
              ))}
            </ul>
          )}
          <p className="wcr-note">
            {t('settings.ignoreBuiltin', { dirs: ignore.builtinDirs, patterns: ignore.builtinPatterns })} ·{' '}
            {t('settings.ignoreCount', { n: ignore.ignored })}
          </p>
          {ignore.overridden.length > 0 && (
            <p className="wcr-note">
              {t('settings.ignoreOverridden')} {ignore.overridden.join('、')}
            </p>
          )}
        </div>
      ) : (
        <p className="wcr-note">{t('settings.ignoreUnavailable')}</p>
      )}
    </Dialog>
  );
}
