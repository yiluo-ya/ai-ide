/**
 * 提交历史视图（SCM Commits，2026-10-09 按 openvscode-server 的 git 历史视图做的精简贴近版）。
 *
 * 列表每一行 = ref 徽章（分支/标签/远程）+ subject + 作者 · 短 sha · 时间（2026-10-10 去掉 graph 泳道，只留平铺列表）。
 * 点某行展开：message 全文 + 增删统计 + 该提交改动的文件清单；点文件 = 打开「父提交 vs 该提交」的只读 diff（DiffPanel）。
 * 展开区操作：复制 sha / 复制提交信息 / 切到该提交 / cherry-pick / 建分支 / 建标签；ref 徽章点开可切到该 ref 或删除。
 * 所有写操作（checkout / cherry-pick / 建删分支标签）一律二次确认弹窗。
 *
 * 只读纪律：展开 / diff / 复制都不改工作区；只有明确勾选确认的写操作才动仓库。
 */
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { CommitChange, GitRefName, RepoLogEntry } from '../../shared/types';
import { api } from './api';
import { useChangesStore } from './changesState';
import { Dialog } from './Dialog';
import { DiffPanel } from './DiffPanel';
import { useI18n } from './i18n';
import { useLayout } from './layout';
import { mdToHtml } from './markdown';
import { showToast } from './state';
import { timeAgo } from './timeAgo';
import './changes.css';

type HistoryWrite = 'checkout' | 'cherry-pick' | 'create-branch' | 'create-tag' | 'delete-branch' | 'delete-tag';

// ---------------------------------------------------------------- ref 徽章

/** ref 类型对应的内联小图标（线性 SVG，跟随 Theme）。 */
function RefIcon({ type }: { type: GitRefName['type'] }) {
  if (type === 'branch') {
    return (
      <svg className="cg-ref-icon" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
        <circle cx="6" cy="5" r="2.4" />
        <circle cx="6" cy="19" r="2.4" />
        <path d="M6 7.4v9.2M6 5c3.4 2.4 6.4 3.4 8.6 6.6" />
      </svg>
    );
  }
  if (type === 'tag') {
    return (
      <svg className="cg-ref-icon" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
        <path d="M4 6a2 2 0 0 1 2-2h4.6l9.4 9.4-6 6L4.6 10 4 6z" />
        <circle cx="9.4" cy="9.4" r="1.3" />
      </svg>
    );
  }
  return (
    <svg className="cg-ref-icon" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <path d="M4.8 12h14.4M8.4 7.6c1.4 2.8 1.4 6 0 8.8M15.6 7.6c-1.4 2.8-1.4 6 0 8.8" />
    </svg>
  );
}

function RefBadges({ refs, onRef }: { refs: GitRefName[]; onRef: (r: GitRefName) => void }) {
  return (
    <span className="cg-refs">
      {refs.map((r, i) => (
        <button
          key={`${r.type}:${r.name}:${i}`}
          className={`cg-ref cg-ref-${r.type}${r.isHead ? ' head' : ''}`}
          title={`${r.type === 'branch' ? 'branch' : r.type === 'tag' ? 'tag' : 'remote'} ${r.name}${r.isHead ? ' (HEAD)' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onRef(r);
          }}
        >
          <RefIcon type={r.type} />
        </button>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------- 单条提交行 + 展开

function CommitRow({
  entry,
  expanded,
  onToggle,
  onOpenFileDiff,
  onWrite,
}: {
  entry: RepoLogEntry;
  expanded: boolean;
  onToggle: (rev: string) => void;
  onOpenFileDiff: (rev: string, base: string | undefined, file: string) => void;
  onWrite: (action: HistoryWrite, rev: string, name?: string) => void;
}) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<{
    body: string;
    email: string;
    author: string;
    at: number;
    stats: { files: number; added: number | null; removed: number | null };
  } | null>(null);
  const [changes, setChanges] = useState<CommitChange[] | null>(null);
  const [refPick, setRefPick] = useState<GitRefName | null>(null);
  /** hover 浮层：悬停即展示完整提交信息（对齐 openvscode 的 commit hover），带 300ms 防抖。 */
  const [hovering, setHovering] = useState(false);
  /** 触发 hover 时的鼠标视口坐标：浮层用 fixed 定位跟随，脱离 overflow 容器不被裁。 */
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectId = useChangesStore((s) => s.projectId);
  /** git 面板在哪一侧：hover 浮层向相反侧弹出（git 在右 → 浮层在左，反之）。 */
  const gitSide = useLayout().sides.git;

  useEffect(() => {
    if (expanded && projectId) {
      let cancelled = false;
      void api.gitCommit(projectId, entry.rev).then((info) => {
        if (!cancelled) setDetail({ body: info.body, email: info.email, author: info.author, at: info.at, stats: info.stats });
      });
      void api.gitCommitChanges(projectId, entry.rev).then((res) => {
        if (!cancelled) setChanges(res.changes);
      });
      return () => {
        cancelled = true;
      };
    }
  }, [expanded, projectId, entry.rev]);

  // 悬停防抖：移入 300ms 后才真正置 hovering（触发展开区外的 hover 浮层），移出立即清；
  // 只拉一次 commit 详情（detail 有缓存），不拉 change list（那是展开区的）。
  const onMouseEnter = (e: ReactMouseEvent) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setHoverPos({ x: e.clientX, y: e.clientY });
    hoverTimer.current = setTimeout(() => setHovering(true), 300);
  };
  const onMouseLeave = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setHovering(false);
    setHoverPos(null);
  };

  useEffect(() => {
    if (hovering && projectId && !detail) {
      void api.gitCommit(projectId, entry.rev).then((info) => {
        setDetail({ body: info.body, email: info.email, author: info.author, at: info.at, stats: info.stats });
      });
    }
  }, [hovering, projectId, entry.rev, detail]);

  const copy = (text: string, what: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => showToast(t('commits.copied', { what }), true),
      () => showToast(t('commits.copyFailed'), false),
    );
  };

  const base = entry.parentIds?.[0];

  /** ref 徽章点击：弹一个「切到 / 删除」二选一确认（remote 只切到，不可删）。 */
  const onRefClick = (r: GitRefName) => setRefPick(r);

  return (
    <div className={`cg-row${expanded ? ' cg-row-open' : ''}`} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <div className="cg-row-main">
        <button className="cg-row-head" onClick={() => onToggle(entry.rev)}>
          <span className="cg-dot" aria-hidden="true" />
          <span className="cg-subject">{entry.summary}</span>
          <RefBadges refs={entry.refs ?? []} onRef={onRefClick} />
          <span className="cg-when">{timeAgo(entry.at, t)}</span>
        </button>
        <div className="cg-meta">
          {t('commits.meta', {
            author: entry.author,
            rev: entry.shortRev,
          })}
        </div>

        {hovering && !expanded && detail && hoverPos && (
          <div
            className={`cg-hover cg-hover-${gitSide === 'right' ? 'left' : 'right'}`}
            style={{
              left: gitSide === 'right' ? hoverPos.x - 340 : hoverPos.x + 12,
              top: hoverPos.y - 8,
            }}
          >
            <div className="cg-hover-subject">{entry.summary}</div>
            {detail.body && (
              <div className="cg-hover-body" dangerouslySetInnerHTML={{ __html: mdToHtml(detail.body) }} />
            )}
            {detail.stats.files > 0 && (
              <div className="cg-hover-stats">
                {detail.stats.files} file{detail.stats.files === 1 ? '' : 's'} changed
                {detail.stats.added != null && detail.stats.added > 0 && (
                  <span className="cg-hover-add">, +{detail.stats.added}</span>
                )}
                {detail.stats.removed != null && detail.stats.removed > 0 && (
                  <span className="cg-hover-del">, -{detail.stats.removed}</span>
                )}
              </div>
            )}
            <div className="cg-hover-author">
              {detail.author}
              {detail.email && ` <${detail.email}>`} · {new Date(detail.at).toLocaleString()}
            </div>
          </div>
        )}

        {expanded && (
          <div className="cg-detail">
            {detail && detail.stats.files > 0 && (
              <div className="cg-stats">
                {t('commits.stats', {
                  files: detail.stats.files,
                  added: detail.stats.added ?? 0,
                  removed: detail.stats.removed ?? 0,
                })}
              </div>
            )}

            <div className="cg-actions">
              <button className="btn ghost small" onClick={() => copy(entry.rev, t('commits.sha'))}>
                {t('commits.copySha')}
              </button>
              <button className="btn ghost small" onClick={() => copy(entry.summary, t('commits.message'))}>
                {t('commits.copyMessage')}
              </button>
              <button className="btn ghost small" onClick={() => onWrite('checkout', entry.rev)}>
                {t('commits.checkout')}
              </button>
              <button className="btn ghost small" onClick={() => onWrite('cherry-pick', entry.rev)}>
                {t('commits.cherryPick')}
              </button>
              <button className="btn ghost small" onClick={() => onWrite('create-branch', entry.rev)}>
                {t('commits.createBranch')}
              </button>
              <button className="btn ghost small" onClick={() => onWrite('create-tag', entry.rev)}>
                {t('commits.createTag')}
              </button>
            </div>

            {changes && changes.length > 0 && (
              <div className="cg-changes">
                {changes.map((c) => (
                  <button
                    key={c.path}
                    className="cg-change"
                    onClick={() => onOpenFileDiff(entry.rev, base, c.path)}
                    title={c.path}
                  >
                    <span className={`cg-change-badge ${c.status.toLowerCase()}`}>{c.status}</span>
                    <span className="cg-change-path">{c.path}</span>
                    {!c.binary && c.added != null && c.removed != null && (
                      <span className="cg-change-delta">
                        +{c.added} -{c.removed}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {refPick && (
        <Dialog
          title={`${refPick.type === 'tag' ? 'tag' : 'branch'} · ${refPick.name}`}
          onClose={() => setRefPick(null)}
        >
          <p className="confirm-text">{refPick.name}</p>
          <div className="confirm-actions">
            {refPick.type !== 'remote' && (
              <button
                className="btn ghost"
                onClick={() => {
                  onWrite(refPick.type === 'tag' ? 'delete-tag' : 'delete-branch', entry.rev, refPick.name);
                  setRefPick(null);
                }}
              >
                {t('commits.deleteRef')}
              </button>
            )}
            <button
              className="btn"
              onClick={() => {
                onWrite('checkout', entry.rev, refPick.name);
                setRefPick(null);
              }}
            >
              {t('commits.checkoutRef')}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 主组件

export function CommitHistory({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const commits = useChangesStore((s) => s.commits);
  const commitsReason = useChangesStore((s) => s.commitsReason);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [diff, setDiff] = useState<{ rev: string; base?: string; file: string } | null>(null);
  const [confirm, setConfirm] = useState<{ action: HistoryWrite; rev: string; name?: string } | null>(null);
  const [nameInput, setNameInput] = useState('');

  const toggle = (rev: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rev)) next.delete(rev);
      else next.add(rev);
      return next;
    });

  const openWrite = (action: HistoryWrite, rev: string, name?: string) => {
    setNameInput(name ?? '');
    setConfirm({ action, rev, name });
  };

  const doWrite = async () => {
    if (!confirm) return;
    const { action, rev } = confirm;
    const needName = action === 'create-branch' || action === 'create-tag' || action === 'delete-branch' || action === 'delete-tag';
    const name = needName ? nameInput : (confirm.name ?? rev);
    try {
      const res = await api.gitHistoryWrite(projectId, { action, rev, name });
      showToast(res.summary, res.ok);
      if (res.ok) await useChangesStore.getState().refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), false);
    }
    setConfirm(null);
  };

  const confirmTitle = (): string => {
    if (!confirm) return '';
    switch (confirm.action) {
      case 'checkout': return t('commits.confirmCheckout');
      case 'cherry-pick': return t('commits.confirmCherryPick');
      case 'create-branch': return t('commits.confirmCreateBranch');
      case 'create-tag': return t('commits.confirmCreateTag');
      case 'delete-branch': return t('commits.confirmDeleteBranch');
      case 'delete-tag': return t('commits.confirmDeleteTag');
    }
  };
  const needName = (): boolean =>
    confirm?.action === 'create-branch' || confirm?.action === 'create-tag' || confirm?.action === 'delete-branch' || confirm?.action === 'delete-tag';

  return (
    <div className="cg">
      {commitsReason && <div className="changes-nogit">{t('changesPanel.noGit')}</div>}
      {!commitsReason && commits.length === 0 && <div className="changes-nobase">{t('changesPanel.commitsEmpty')}</div>}
      {commits.length > 0 && (
        <div className="cg-list">
          {commits.map((c) => (
            <CommitRow
              key={c.rev}
              entry={c}
              expanded={expanded.has(c.rev)}
              onToggle={toggle}
              onOpenFileDiff={(rev, base, file) => setDiff({ rev, base, file })}
              onWrite={openWrite}
            />
          ))}
        </div>
      )}

      {diff && (
        <DiffPanel projectId={projectId} file={diff.file} rev={diff.rev} baseRev={diff.base} onClose={() => setDiff(null)} />
      )}

      {confirm && (
        <Dialog title={confirmTitle()} onClose={() => setConfirm(null)}>
          <p className="confirm-text">{confirmTitle()}</p>
          {confirm.action === 'checkout' && (
            <p className="confirm-text">{t('commits.checkoutHint', { target: (confirm.name ?? confirm.rev).slice(0, 20) })}</p>
          )}
          {confirm.action === 'cherry-pick' && (
            <p className="confirm-text">{t('commits.cherryPickHint', { rev: confirm.rev.slice(0, 7) })}</p>
          )}
          {needName() && (
            <input
              className="changes-commit-input"
              value={nameInput}
              autoFocus
              placeholder={t('commits.namePlaceholder')}
              onChange={(e) => setNameInput(e.target.value)}
            />
          )}
          <div className="confirm-actions">
            <button className="btn ghost" onClick={() => setConfirm(null)}>
              {t('common.cancel')}
            </button>
            <button className="btn" disabled={needName() && !nameInput.trim()} onClick={() => void doWrite()}>
              {t('commits.confirmAction')}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}