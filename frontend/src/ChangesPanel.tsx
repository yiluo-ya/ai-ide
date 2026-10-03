/**
 * 变更面板（2026-10-03 用户要求：**以 git 为基础**，不自己记录变更）。
 *
 * 显示 `git status` 的改动清单 + `git diff --numstat HEAD` 的增删行数（默认展示，无需点）。
 * 顶上四个最常用的 git 命令（add all / commit / pull / push）直接执行，结果走右下角冒泡。
 *
 * 行的形态与交互（2026-10-03 用户两次澄清后定稿）：
 * 一行 = 状态徽标 + 文件 + 增删行数；**点增删行数（`+2 -0` 那块）弹出差异**（只读浮层，
 * 看完就关 —— 主用途还是看代码，不该让 diff 顶掉阅读位）。行末不再多加一个 `+` 按钮。
 * 点文件名仍然是打开该文件。
 *
 * 默认**平铺**（一行一个文件、完整相对路径，像 git status 那样一眼扫完）；
 * 需要看「哪些目录在动」时可切「按目录」，那时根目录默认展开、子目录默认折叠。
 *
 * 三条不撒谎的规矩：
 * 1) 不是 git 仓库（或没装 git）→ 如实说，不用别的东西凑一份「变更」；
 * 2) 工作区干净 → 说干净，不编数字；
 * 3) 未跟踪 / 二进制文件没有 numstat → 不显示 `+0 -0`（后端给的是 null）。
 */
import { useMemo, useState } from 'react';
import type { GitChangeEntry } from '../../shared/types';
import { statusMeta, useChangesStore } from './changesState';
import { Dialog } from './Dialog';
import './changes.css';

/** 行数增减：拿不到数字（未跟踪 / 二进制）就不显示，不写 +0 -0。 */
function deltaText(entry: GitChangeEntry): string {
  if (entry.binary) return '二进制';
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
        title={`${entry.file}${entry.from ? `（原 ${entry.from}）` : ''} — 打开`}
        onClick={() => onOpenFile(entry.file)}
      >
        {shown}
      </button>
      {delta ? (
        <button
          className="changes-delta changes-delta-btn"
          title={`${entry.file} — 看差异（git diff）`}
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
  const open = expanded.has(group.path);
  const sub = [...group.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const own = [...group.files].sort((a, b) => a.file.localeCompare(b.file));
  const sum = summarize(group);
  return (
    <>
      <div className="changes-dir" style={{ paddingLeft: depth * 12 }} onClick={() => onToggle(group.path)}>
        <span className={`chevron ${open ? 'open' : ''}`}>▸</span>
        <span className="changes-dir-name">{depth === 0 ? '项目根目录' : `${group.name}/`}</span>
        <span className="changes-dir-count">{sum.files} 个</span>
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
  const result = useChangesStore((s) => s.result);
  const busy = useChangesStore((s) => s.busy);
  const running = useChangesStore((s) => s.running);
  const error = useChangesStore((s) => s.error);
  const refresh = useChangesStore((s) => s.refresh);
  const run = useChangesStore((s) => s.run);
  /** 默认平铺（一行一个文件、完整路径，像 git status 那样扫）。 */
  const [byDir, setByDir] = useState(false);
  /** 按目录展示时，哪些目录是展开的：根目录默认展开，子目录默认折叠。 */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  /** git commit 的提交说明（点按钮时弹输入框，不是 prompt）。 */
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
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
        <h3>变更 · git</h3>
        <button className="btn ghost small" onClick={() => setByDir((v) => !v)} title="切换平铺 / 按目录">
          {byDir ? '按目录' : '平铺'}
        </button>
        <button className="btn ghost small" onClick={() => void refresh()} disabled={busy}>
          {busy ? '读取中…' : '刷新'}
        </button>
      </div>

      {/* 四个最常用的写命令（2026-10-03 用户要求）：git status 就是下面的清单，默认已经在那儿了。 */}
      <div className="changes-cmds">
        <button
          className="btn ghost small"
          disabled={running !== null}
          title="git add -A：把所有改动（含新文件）加入暂存区"
          onClick={() => void run('add')}
        >
          git add all
        </button>
        <button
          className="btn ghost small"
          disabled={running !== null}
          title="git commit -m：写一句提交说明再提交"
          onClick={() => setCommitOpen(true)}
        >
          git commit
        </button>
        <button
          className="btn ghost small"
          disabled={running !== null}
          title="git pull --ff-only：只做快进拉取，不产生合并提交"
          onClick={() => void run('pull')}
        >
          git pull
        </button>
        <button
          className="btn ghost small"
          disabled={running !== null}
          title="git push：推到远端（对外可见，会先弹一次确认）"
          onClick={() => setPushOpen(true)}
        >
          git push
        </button>
        {running && <span className="changes-cmd-busy">git {running} 执行中…</span>}
      </div>

      {result?.isRepo && (
        <div className="changes-counts">
          <span>分支 {result.branch ?? '（无提交）'}</span>
          <span>·</span>
          <span>{entries.length === 0 ? '工作区干净' : `${totals.files} 个未提交改动`}</span>
          {totals.files > 0 && (totals.added > 0 || totals.removed > 0) && (
            <span className="changes-delta">
              +{totals.added} -{totals.removed}
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="changes-error" role="alert">
          读取失败：{error}
        </div>
      )}

      {!error && result && !result.isRepo && (
        <div className="changes-nogit">
          这个目录不是 git 仓库（或本机没装 git），所以看不到变更 —— 变更只以 git 为准，不自记录。
        </div>
      )}

      {result?.isRepo && entries.length === 0 && <div className="changes-nobase">工作区干净：没有未提交的改动。</div>}

      {entries.length > 0 && (
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
            <div className="changes-note-summary">另有 {result.truncated} 个改动未列出（太多）。</div>
          )}
        </div>
      )}

      {commitOpen && (
        <Dialog title="提交（git commit）" onClose={() => setCommitOpen(false)}>
          <p className="confirm-text">
            提交说明会原样传给 <code>git commit -m</code>（不经 shell）。暂存区为空、或没有可提交的内容时，
            git 会拒绝 —— 它的原话会冒泡到右下角，不假装成功。
          </p>
          <textarea
            className="changes-commit-input"
            value={commitMessage}
            autoFocus
            rows={4}
            maxLength={2000}
            placeholder="一句话说清这次改了什么"
            onChange={(e) => setCommitMessage(e.target.value)}
          />
          <div className="confirm-actions">
            <button className="btn ghost" onClick={() => setCommitOpen(false)}>
              取消
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
              提交
            </button>
          </div>
        </Dialog>
      )}

      {pushOpen && (
        <Dialog title="推送（git push）？" onClose={() => setPushOpen(false)}>
          <p className="confirm-text">
            会把当前分支的提交推到远端 —— 这一步对别人可见。没有远端 / 需要登录 / 被拒绝都会如实冒泡。
          </p>
          <div className="confirm-actions">
            <button className="btn ghost" onClick={() => setPushOpen(false)}>
              取消
            </button>
            <button
              className="btn"
              onClick={() => {
                setPushOpen(false);
                void run('push');
              }}
            >
              推送
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
