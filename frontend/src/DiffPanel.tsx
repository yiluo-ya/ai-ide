/**
 * 只读 diff 视图（04 Guide · W3 / G7.2、G7.5）：全屏浮层，与 `.search-overlay` /
 * `.graph-overlay` 同一形态。
 *
 * 为什么是浮层而不是第二个 pane：diff 是「看完了就关」的一次性视图，塞进分屏会
 * 占掉阅读位；形态上它更接近搜索浮层。
 *
 * 只读承诺：这里只渲染后端 `file-diff` 返回的**原始 diff 文本**（前端不解析、更不应用），
 * 不提供任何写操作；无 git 时如实说「没 git」，并指出可以改用阅读快照对比，
 * 而不是留一个空白面板。
 *
 * 入口（2026-10-03 用户要求）：在变更栏里**点某一行的增删行数**（`+2 -0` 那块）打开；
 * 行末不再单独放一个「差异」按钮。
 */
import { useEffect, useMemo, useState } from 'react';
import type { FileDiffResult } from '../../shared/types';
import { api } from './api';
import { changesApi } from './readSnapshot';
import { useI18n } from './i18n';
import './changes.css';

/** 单行分类：`@@` 行头 / 增 / 删 / 文件头 / 上下文。 */
function lineKind(line: string): string {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) {
    return 'meta';
  }
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

/**
 * diff 正文：只按行着色，不解析、更不应用。
 * 空行给一个不换行空格，否则行高会塌掉。
 */
function DiffLines({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, i) => (
        <div className={`diff-line ${lineKind(line)}`} key={i}>
          {line === '' ? '\u00a0' : line}
        </div>
      ))}
    </>
  );
}

export function DiffPanel({
  projectId,
  file,
  rev = 'HEAD',
  baseRev,
  onClose,
}: {
  projectId: string;
  file: string;
  /** 对比的版本；缺省 HEAD = 工作区 vs HEAD。 */
  rev?: string;
  /** 历史提交 diff 的基点（通常是 rev 的父提交）；传了就走两提交 diff，忽略工作区。 */
  baseRev?: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<FileDiffResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    const req = baseRev
      ? api.gitCommitFileDiff(projectId, rev, file, baseRev)
      : changesApi.fileDiff(projectId, file, rev);
    void req
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, file, rev, baseRev]);

  // Esc 关闭（与其它浮层一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const lines = useMemo(() => (data?.diff ? data.diff.split('\n') : []), [data]);

  /** 拿不到 diff 时的如实说明：无 git 不是错误，是另一种口径。 */
  const reasonText = (): string => {
    if (error) return t('diff.error', { message: error });
    if (!data) return t('diff.loading');
    if (data.reason === 'no-git') return t('diff.noGit');
    if (data.reason) return t('diff.unavailable', { reason: data.reason });
    return t('diff.empty', { rev });
  };

  return (
    <div className="diff-overlay" role="dialog" aria-label={t('diff.title')}>
      <div className="diff-dialog">
        <header className="diff-head">
          <span className="diff-title" title={file}>
            {t('diff.title')} · {file}
          </span>
          <span className="guide-muted">{t('diff.against', { rev })}</span>
          <span className="diff-readonly">{t('diff.readonly')}</span>
          <span className="spacer" />
          <button className="btn ghost small" onClick={onClose} title={t('diff.closeTitle')}>
            {t('diff.close')}
          </button>
        </header>
        <div className="diff-body">
          {loading && <div className="guide-empty">{t('diff.loading')}</div>}
          {!loading && lines.length === 0 && <div className="diff-empty">{reasonText()}</div>}
          {!loading && lines.length > 0 && <DiffLines text={data?.diff ?? ''} />}
        </div>
        {data?.truncated && <div className="diff-foot">{t('diff.truncated')}</div>}
      </div>
    </div>
  );
}
