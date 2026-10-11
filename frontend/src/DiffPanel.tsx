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
 *
 * 结构化跳转（2026-10-11）：渲染方式与截断提示不变，仍逐行画 div、仍不引入 Monaco diff；
 * 只是额外用 `parseDiffHunks`（diffHunks.ts）把 `@@` 行头解析成 hunk 区间，
 * 支撑「第 k / 共 n 处变更」计数与上一处 / 下一处跳转。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { FileDiffResult } from '../../shared/types';
import { api } from './api';
import { changesApi } from './readSnapshot';
import { useI18n } from './i18n';
import { parseDiffHunks, stepHunk } from './diffHunks';
import type { DiffHunk } from './diffHunks';
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
 * `data-line` 供跳转时按行号找回元素；`current` 覆盖的行额外加高亮 class。
 */
function DiffLines({ text, current }: { text: string; current: DiffHunk | null }) {
  return (
    <>
      {text.split('\n').map((line, i) => {
        const inCurrent = current !== null && i >= current.startLine && i < current.endLine;
        return (
          <div
            className={`diff-line ${lineKind(line)}${inCurrent ? ' hunk-current' : ''}`}
            data-line={i}
            key={i}
          >
            {line === '' ? '\u00a0' : line}
          </div>
        );
      })}
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
  /** 当前定位到的 hunk 下标；-1 = 尚未定位（计数显示 0）。 */
  const [active, setActive] = useState(-1);
  const dialogRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    setActive(-1);
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

  // 打开即把焦点收到浮层内，这样 F3 只作用于本面板（不抢编辑器/全局快捷键）
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const lines = useMemo(() => (data?.diff ? data.diff.split('\n') : []), [data]);
  const hunks = useMemo(() => parseDiffHunks(data?.diff), [data]);

  /** 滚到某个 hunk 的起始行：目标行顶到容器上方留一点空隙。 */
  const scrollToHunk = (idx: number) => {
    const body = bodyRef.current;
    const hunk = hunks[idx];
    if (!body || !hunk) return;
    const el = body.querySelector<HTMLElement>(`[data-line="${hunk.startLine}"]`);
    if (!el) return;
    // 不用 scrollIntoView：它会连带滚动外层浮层 / 页面，这里只动正文容器自己的 scrollTop
    const bodyRect = body.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    body.scrollTop += elRect.top - bodyRect.top - 8;
  };

  /** 上一处 / 下一处：到边界即停（不环绕）。 */
  const go = (delta: number) => {
    const next = stepHunk(active, hunks.length, delta);
    if (next < 0) return;
    setActive(next);
    scrollToHunk(next);
  };

  /**
   * 键盘跳转选 F3 / Shift+F3（不用 n / N）：F3 是「跳到下一处匹配」的通行惯例，
   * 且单字母键将来会被面板内的输入 / 搜索占用。监听挂在浮层本身（不是 window），
   * 所以只有面板聚焦时才生效，不会和编辑器的全局快捷键打架。
   */
  const onPanelKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'F3') return;
    e.preventDefault();
    go(e.shiftKey ? -1 : 1);
  };

  const total = hunks.length;
  const current = active >= 0 && active < total ? active : -1;

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
      <div className="diff-dialog" ref={dialogRef} tabIndex={-1} onKeyDown={onPanelKeyDown}>
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
        {/* 变更跳转工具条：计数口径 = 当前 hunk 下标 + 1，未定位 / 无 hunk 时为 0 */}
        <div className="diff-toolbar">
          <span className="diff-count">{t('diff.count', { k: current + 1, n: total })}</span>
          <button
            className="btn ghost small"
            onClick={() => go(-1)}
            disabled={total === 0}
            title={t('diff.prevTitle')}
          >
            {t('diff.prev')}
          </button>
          <button className="btn ghost small" onClick={() => go(1)} disabled={total === 0} title={t('diff.nextTitle')}>
            {t('diff.next')}
          </button>
          <span className="spacer" />
          <span className="diff-keys">{t('diff.keysHint')}</span>
        </div>
        <div className="diff-body" ref={bodyRef}>
          {loading && <div className="guide-empty">{t('diff.loading')}</div>}
          {!loading && lines.length === 0 && <div className="diff-empty">{reasonText()}</div>}
          {!loading && lines.length > 0 && (
            <DiffLines text={data?.diff ?? ''} current={current >= 0 ? hunks[current] : null} />
          )}
        </div>
        {data?.truncated && <div className="diff-foot">{t('diff.truncated')}</div>}
      </div>
    </div>
  );
}
