/**
 * 源码管理面板（2026-10-03 定「以 git 为基础」，2026-10-09 改成 VS Code 源码管理的命令形态）。
 *
 * 顶上一行标题「git」+ 右侧「大按钮 + 下拉箭头」（对齐 VS Code 的 SCM action button）：
 *   · 大按钮 = git commit（点它弹提交说明弹窗，沿用旧有 2000 字限制）；
 *   · 下拉箭头 = 次要命令（add all / pull / push / refresh）。
 *
 * 下面一个 Changes | Commits 切换（默认 Changes）：Changes 视图 = 改动清单（平铺 / 按目录），
 * Commits 视图 = 仓库最近若干条提交（摘要 · 短 sha · 作者 · 相对时间）。
 *
 * 三条不撒谎的规矩（沿用 2026-10-03）：
 * 1) 不是 git 仓库（或没装 git）→ 如实说，不用别的东西凑一份「变更」；
 * 2) 工作区干净 → 说干净，不编数字；
 * 3) 未跟踪 / 二进制文件没有 numstat → 不显示 `+0 -0`（后端给的是 null）。
 */
import { useMemo, useState } from 'react';
import type { GitChangeEntry } from '../../shared/types';
import { statusMeta, useChangesStore } from './changesState';
import { CommitHistory } from './CommitHistory';
import { Dialog } from './Dialog';
import { translate, useI18n } from './i18n';
import './changes.css';

/** 行数增减：拿不到数字（未跟踪 / 二进制）就不显示，不写 +0 -0。 */
function deltaText(entry: GitChangeEntry): string {
  if (entry.binary) return translate('changes.binary');
  if (entry.added == null || entry.removed == null) return '';
  return entry.removed === 0 ? `+${entry.added}` : `+${entry.added} -${entry.removed}`;
}

/** 目录节点：自身直接含的改动文件 + 子目录。 */
interface DirGroup {
  /** 相对项目根的目录路径；'' = 根。 */
  path: string;
  name: string;
  files: GitChangeEntry[];
  dirs: Map<string, DirGroup>;
}

/** 把扁平的文件清单折成目录树（目录在前、文件在后，各自按名排序）。 */
function buildTree(entries: GitChangeEntry[]): DirGroup {
  const root: DirGroup = { path: '', name: '', files: [], dirs: new Map() };
  for (const entry of entries) {
    const parts = entry.file.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const path = parts.slice(0, i + 1).join('/');
      let next = node.dirs.get(path);
      if (!next) {
        next = { path, name: parts[i], files: [], dirs: new Map() };
        node.dirs.set(path, next);
      }
      node = next;
    }
    node.files.push(entry);
  }
  return root;
}

/** 一个目录（含子目录）里的文件数与增删汇总。 */
function summarize(group: DirGroup): { files: number; added: number; removed: number } {
  let files = group.files.length;
  let added = group.files.reduce((n, f) => n + (f.added ?? 0), 0);
  let removed = group.files.reduce((n, f) => n + (f.removed ?? 0), 0);
  for (const child of group.dirs.values()) {
    const sub = summarize(child);
    files += sub.files;
    added += sub.added;
    removed += sub.removed;
  }
  return { files, added, removed };
}

function FileRow({
  entry,
  indent,
  full,
  onOpenDiff,
  onOpenFile,
}: {
  entry: GitChangeEntry;
  /** 缩进层级（按目录展示时跟着目录走）。 */
  indent: number;
  /** 是否显示完整相对路径（平铺视图要，目录视图不必）。 */
  full: boolean;
  /** 点增删行数看差异（只读浮层）。 */
  onOpenDiff: (file: string) => void;
  onOpenFile: (file: string) => void;
}) {
  const { t } = useI18n();
  const shown = full ? entry.file : (entry.file.split('/').pop() ?? entry.file);
  // statusMeta 自带兜底：未知状态（例如旧后端还在发的 untracked）按「新增」显示，不会白屏
  const st = statusMeta(entry.status);
  const delta = deltaText(entry);
  return (
    <div className="changes-row">
      <span className={`changes-badge ${st.cls}`} title={st.hint}>
        {st.label}
      </span>
      <button
        className="changes-file"
        style={{ paddingLeft: indent * 12 }}
        title={t('changesPanel.fileOpenTitle', {
          file: entry.from ? `${entry.file}${t('changesPanel.originalFrom', { from: entry.from })}` : entry.file,
        })}
        onClick={() => onOpenFile(entry.file)}
      >
        {shown}
      </button>
      {delta ? (
        <button
          className="changes-delta changes-delta-btn"
          title={t('changesPanel.fileDiffTitle', { file: entry.file })}
          onClick={() => onOpenDiff(entry.file)}
        >
          {delta}
        </button>
      ) : (
        <span className="changes-delta" />
      )}
    </div>
  );
}

function DirNode({
  group,
  depth,
  expanded,
  onToggle,
  onOpenDiff,
  onOpenFile,
}: {
  group: DirGroup;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onOpenDiff: (file: string) => void;
  onOpenFile: (file: string) => void;
}) {
  const { t } = useI18n();
  const open = expanded.has(group.path);
  const sub = [...group.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const own = [...group.files].sort((a, b) => a.file.localeCompare(b.file));
  const sum = summarize(group);
  return (
    <>
      <div className="changes-dir" style={{ paddingLeft: depth * 12 }} onClick={() => onToggle(group.path)}>
        <span className={`chevron ${open ? 'open' : ''}`}>▸</span>
        <span className="changes-dir-name">{depth === 0 ? t('changesPanel.rootDir') : `${group.name}/`}</span>
        <span className="changes-dir-count">{t('changesPanel.dirCount', { n: sum.files })}</span>
        {(sum.added > 0 || sum.removed > 0) && (
          <span className="changes-delta">
            +{sum.added} -{sum.removed}
          </span>
        )}
      </div>
      {open && (
        <>
          {sub.map((child) => (
            <DirNode
              key={child.path}
              group={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              onOpenDiff={onOpenDiff}
              onOpenFile={onOpenFile}
            />
          ))}
          {own.map((entry) => (
            <FileRow
              key={entry.file}
              entry={entry}
              indent={depth + 1}
              full={false}
              onOpenDiff={onOpenDiff}
              onOpenFile={onOpenFile}
            />
          ))}
        </>
      )}
    </>
  );
}

export function ChangesPanel({
  onOpenFile,
  onOpenDiff,
}: {
  onOpenFile: (file: string) => void;
  /** 打开只读 diff 浮层（点增删行数触发）。 */
  onOpenDiff: (file: string) => void;
}) {
  const { t } = useI18n();
  const projectId = useChangesStore((s) => s.projectId);
  const result = useChangesStore((s) => s.result);
  const busy = useChangesStore((s) => s.busy);
  const running = useChangesStore((s) => s.running);
  const error = useChangesStore((s) => s.error);
  const commits = useChangesStore((s) => s.commits);
  const commitsReason = useChangesStore((s) => s.commitsReason);
  const refresh = useChangesStore((s) => s.refresh);
  const run = useChangesStore((s) => s.run);
  /** SCM 视图：Changes（默认）| Commits。 */
  const [view, setView] = useState<'changes' | 'commits'>('changes');
  /** 默认平铺（一行一个文件、完整路径，像 git status 那样扫）。 */
  const [byDir, setByDir] = useState(false);
  /** 按目录展示时，哪些目录是展开的：根目录默认展开，子目录默认折叠。 */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  /** git commit 的提交说明（点大按钮弹输入框，不是 prompt）。 */
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  /** 大按钮右侧的下拉菜单（add / pull / push / refresh）。 */
  const [menuOpen, setMenuOpen] = useState(false);
  /** git push 对外可见，先确认一次。 */
  const [pushOpen, setPushOpen] = useState(false);

  const entries = result?.entries ?? [];
  const tree = useMemo(() => buildTree(entries), [entries]);
  const flat = useMemo(() => [...entries].sort((a, b) => a.file.localeCompare(b.file)), [entries]);
  const totals = useMemo(() => summarize(tree), [tree]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="changes-panel">
      <div className="changes-head">
        <h3>{t('changesPanel.title')}</h3>
        <div className="changes-head-actions">
          {/* 大按钮 + 下拉箭头（对齐 VS Code SCM action button） */}
          <div className="scm-split">
            <button
              className="scm-primary"
              type="button"
              disabled={running !== null}
              title={t('changesPanel.commitCmdTitle')}
              onClick={() => setCommitOpen(true)}
            >
              {t('changesPanel.commit')}
            </button>
            <button
              className="scm-dropdown"
              type="button"
              disabled={running !== null}
              title={t('changesPanel.more')}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <span className="chevron down">▾</span>
            </button>
          </div>
          {menuOpen && (
            <div className="scm-menu" onMouseLeave={() => setMenuOpen(false)}>
              <button className="scm-menu-item" disabled={running !== null} onClick={() => { setMenuOpen(false); void run('add'); }}>
                {t('changesPanel.add')}
              </button>
              <button className="scm-menu-item" disabled={running !== null} onClick={() => { setMenuOpen(false); void run('pull'); }}>
                {t('changesPanel.pull')}
              </button>
              <button className="scm-menu-item" disabled={running !== null} onClick={() => { setMenuOpen(false); setPushOpen(true); }}>
                {t('changesPanel.push')}
              </button>
              <button className="scm-menu-item" disabled={busy} onClick={() => { setMenuOpen(false); void refresh(); }}>
                {t('changesPanel.refresh')}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* SCM 视图切换：默认 Changes */}
      <div className="scm-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'changes'}
          className={`scm-tab${view === 'changes' ? ' active' : ''}`}
          onClick={() => setView('changes')}
        >
          {t('changesPanel.viewChanges')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'commits'}
          className={`scm-tab${view === 'commits' ? ' active' : ''}`}
          onClick={() => setView('commits')}
        >
          {t('changesPanel.viewCommits')}{commits.length > 0 ? ` (${commits.length})` : ''}
        </button>
      </div>

      {view === 'changes' ? (
        <>
          {result?.isRepo && (
            <div className="changes-counts">
              <span>{t('changesPanel.branch', { branch: result.branch ?? t('changesPanel.noCommit') })}</span>
              <span>·</span>
              <span>{entries.length === 0 ? t('changesPanel.clean') : t('changesPanel.uncommitted', { n: totals.files })}</span>
              {totals.files > 0 && (totals.added > 0 || totals.removed > 0) && (
                <span className="changes-delta">
                  +{totals.added} -{totals.removed}
                </span>
              )}
            </div>
          )}

          {error && (
            <div className="changes-error" role="alert">
              {t('changesPanel.readError', { error })}
            </div>
          )}

          {!error && result && !result.isRepo && <div className="changes-nogit">{t('changesPanel.noGit')}</div>}

          {result?.isRepo && entries.length === 0 && <div className="changes-nobase">{t('changesPanel.cleanDetail')}</div>}

          {entries.length > 0 && (
            <>
              <div className="changes-rows">
                {byDir ? (
                  <DirNode
                    group={tree}
                    depth={0}
                    expanded={expanded}
                    onToggle={toggle}
                    onOpenDiff={onOpenDiff}
                    onOpenFile={onOpenFile}
                  />
                ) : (
                  flat.map((entry) => (
                    <FileRow
                      key={entry.file}
                      entry={entry}
                      indent={0}
                      full
                      onOpenDiff={onOpenDiff}
                      onOpenFile={onOpenFile}
                    />
                  ))
                )}
                {result && result.truncated > 0 && (
                  <div className="changes-note-summary">{t('changesPanel.truncated', { n: result.truncated })}</div>
                )}
              </div>
            </>
          )}

          {/* 平铺 / 按目录切换（保留原来的视图切换） */}
          {entries.length > 0 && (
            <div className="changes-toolbar">
              <button className="btn ghost small" onClick={() => setByDir((v) => !v)} title={t('changesPanel.toggleViewTitle')}>
                {/* 显示「点了会变成的状态」，而不是当前状态 */}
                {byDir ? t('changesPanel.viewFlat') : t('changesPanel.viewByDir')}
              </button>
            </div>
          )}
        </>
      ) : (
        /* Commits 视图：仓库提交历史（graph / ref 徽章 / 展开 / diff / 写操作） */
        projectId ? <CommitHistory projectId={projectId} /> : <>{commitsReason && <div className="changes-nogit">{t('changesPanel.noGit')}</div>}</>
      )}

      {running && <span className="changes-cmd-busy">{t('changesPanel.cmdBusy', { cmd: running })}</span>}

      {commitOpen && (
        <Dialog title={t('changesPanel.commitDialog')} onClose={() => setCommitOpen(false)}>
          <p className="confirm-text">
            {t('changesPanel.commitNoteLead')}
            <code>git commit -m</code>
            {t('changesPanel.commitNoteRest')}
          </p>
          <textarea
            className="changes-commit-input"
            value={commitMessage}
            autoFocus
            rows={4}
            maxLength={2000}
            placeholder={t('changesPanel.commitPlaceholder')}
            onChange={(e) => setCommitMessage(e.target.value)}
          />
          <div className="confirm-actions">
            <button className="btn ghost" onClick={() => setCommitOpen(false)}>
              {t('common.cancel')}
            </button>
            <button
              className="btn"
              disabled={!commitMessage.trim() || running === 'commit'}
              onClick={() => {
                const message = commitMessage;
                setCommitOpen(false);
                setCommitMessage('');
                void run('commit', message);
              }}
            >
              {t('changesPanel.commit')}
            </button>
          </div>
        </Dialog>
      )}

      {pushOpen && (
        <Dialog title={t('changesPanel.pushDialog')} onClose={() => setPushOpen(false)}>
          <p className="confirm-text">{t('changesPanel.pushConfirm')}</p>
          <div className="confirm-actions">
            <button className="btn ghost" onClick={() => setPushOpen(false)}>
              {t('common.cancel')}
            </button>
            <button
              className="btn"
              onClick={() => {
                setPushOpen(false);
                void run('push');
              }}
            >
              {t('changesPanel.push')}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}