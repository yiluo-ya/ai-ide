/**
 * 文件级结构性摘要条（04 Guide · G6.1）：编辑器顶部可折叠的一行。
 *
 * 数据来自 `GET /api/projects/:id/file-summary`（`guideApi.fileSummary`），
 * 内容全部是索引里能确认的事实 —— 导出符号 / 依赖模块 / 被谁引用 / 最长函数，
 * 不做生成式摘要。文件不在索引内或请求失败时整条不渲染（不显示空壳）。
 *
 * W3 追加（G7.4 / G7.5）：展开区底部列出这个文件的最近若干次提交（`file-history`），
 * 点某一次 → 交给 App 用 `git-show` 取正文，在第二窗格以只读历史版本打开。
 * 无 git 时如实写「未检测到 git」，不显示空列表冒充「没有历史」。
 */
import { useEffect, useRef, useState } from 'react';
import type { FileHistoryResult, FileSummary } from '../../shared/types';
import { guideApi } from './guide';
import { changesApi } from './readSnapshot';
import { useI18n } from './i18n';
import './guide.css';

/** 展开区最多列多少次提交（点开看更早的历史不是这个面板的职责）。 */
const HISTORY_LIMIT = 8;

/** 该次提交对这个文件的改动摘要：状态去重 + 重命名后的新路径。 */
function changeText(entry: FileHistoryResult['commits'][number]): string {
  const statuses = [...new Set(entry.changes.map((c) => c.status))].join('/');
  const renamed = entry.changes.find((c) => c.status === 'R')?.path;
  return renamed ? `${statuses} → ${renamed}` : statuses;
}

function SummaryBar({
  projectId,
  file,
  onOpenFile,
  onOpenHistory,
}: {
  projectId: string | null;
  file: string | null;
  onOpenFile?: (file: string, line?: number, col?: number) => void;
  /** G7.5：点某次提交 → 打开它的历史版本（由 App 取正文并放进第二窗格）。 */
  onOpenHistory?: (file: string, rev: string) => void;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<FileSummary | null>(null);
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<FileHistoryResult | null>(null);
  /** 上一次请求对应的文件：同一文件重拉不清展开区，换文件才清。 */
  const loadedFileRef = useRef<string | null>(null);

  useEffect(() => {
    if (!projectId || !file) {
      setData(null);
      return;
    }
    const fileChanged = loadedFileRef.current !== file;
    loadedFileRef.current = file;
    let cancelled = false;
    if (fileChanged) {
      setData(null);
      setOpen(false);
      setHistory(null);
    }
    void guideApi
      .fileSummary(projectId, file)
      .then((res) => {
        if (cancelled) return;
        setData(res);
      })
      .catch(() => {
        // 不在索引内 / 非源码 / 后端旧版本：整条不渲染（重拉失败则保留旧数据）
        if (!cancelled && fileChanged) setData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, file]);

  // G7.4：提交历史只在展开时拉一次（git 调用有成本，不展开就不发）
  useEffect(() => {
    if (!open || !projectId || !file) return;
    let cancelled = false;
    void changesApi
      .fileHistory(projectId, file, HISTORY_LIMIT)
      .then((res) => {
        if (!cancelled) setHistory(res);
      })
      .catch(() => {
        if (!cancelled) setHistory(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId, file]);

  if (!data) return null;

  const parts = [
    t('summary.exported', { n: data.exports.length }),
    t('summary.deps', { project: data.imports.project, external: data.imports.external }),
    t('summary.refs', { total: data.inbound.total, tests: data.inbound.tests }),
    data.longestFunction > 0
      ? t('summary.longest', { n: data.longestFunction })
      : t('summary.noLongest'),
  ];

  return (
    <div className="summary-bar">
      <button
        className="summary-toggle"
        onClick={() => setOpen((v) => !v)}
        title={open ? t('summary.collapse') : t('summary.expand')}
        aria-expanded={open}
      >
        <span className="summary-caret">{open ? '▾' : '▸'}</span>
        <span className="summary-title">{t('summary.title')}</span>
        <span className="summary-line">{parts.join(' · ')}</span>
        <span className="summary-rev" title={t('summary.revTitle')}>
          {t('summary.rev', { rev: data.revision })}
        </span>
      </button>
      {open && (
        <div className="summary-body">
          <div className="summary-block">
            <div className="summary-block-head">{t('summary.exportsTitle', { n: data.exports.length })}</div>
            {data.exports.length === 0 && <div className="guide-empty">{t('summary.noExports')}</div>}
            <div className="summary-chips">
              {data.exports.map((e) => (
                <button
                  key={`${e.name}:${e.line}`}
                  className="summary-chip"
                  onClick={() => onOpenFile?.(file!, e.line)}
                  title={`${e.kind} · ${file}:${e.line}`}
                >
                  <span className="summary-chip-kind">{e.kind}</span>
                  {e.name}
                  <span className="guide-muted">L{e.line}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="summary-block">
            <div className="summary-block-head">{t('summary.inboundTitle', { n: data.inbound.files.length })}</div>
            {data.inbound.files.length === 0 && <div className="guide-empty">{t('summary.noInbound')}</div>}
            {data.inbound.files.map((f) => (
              <button
                key={f.file}
                className="summary-inbound"
                onClick={() => onOpenFile?.(f.file)}
                title={f.file}
              >
                <span className="summary-inbound-file">{f.file}</span>
                <span className="guide-muted">{t('summary.refCount', { n: f.count })}</span>
              </button>
            ))}
          </div>
          <div className="summary-note">{data.sentence}</div>
          {/* G7.4 / G7.5：这个文件的提交历史；点一次 → 只读历史版本开在第二窗格 */}
          <div className="summary-block">
            <div className="summary-block-head">
              {t('history.title', { n: history?.commits.length ?? 0 })}
            </div>
            {history?.reason === 'no-git' && <div className="guide-empty">{t('history.noGit')}</div>}
            {history && !history.reason && history.commits.length === 0 && (
              <div className="guide-empty">{t('history.empty')}</div>
            )}
            {history?.commits.map((c) => (
              <button
                key={c.rev}
                className="summary-history"
                onClick={() => onOpenHistory?.(file!, c.rev)}
                title={t('history.openTitle', { rev: c.rev.slice(0, 7) })}
              >
                <span className="summary-history-rev">{c.rev.slice(0, 7)}</span>
                <span className="summary-history-when">{new Date(c.at).toLocaleDateString()}</span>
                <span className="summary-history-summary">{c.summary}</span>
                <span className="guide-muted">{changeText(c)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export { SummaryBar };