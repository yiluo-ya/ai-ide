/**
 * 变更面板（2026-10-03 用户要求：**以 git 为基础**，不自己记录变更）。
 *
 * 显示 `git status` 的改动清单 + `git diff --numstat HEAD` 的增删行数。
 *
 * 展示形态（用户 2026-10-03 追问「git status 可以按目录来展示吗」）：
 * **默认按目录树分组**（目录可折叠、每个目录给出文件数与增删汇总、目录在前文件在后），
 * 这样一眼能看出「哪些目录在动」；需要逐条扫的时候可切到「平铺」。
 *
 * 三条不撒谎的规矩：
 * 1) 不是 git 仓库（或没装 git）→ 如实说，不用别的东西凑一份「变更」；
 * 2) 工作区干净 → 说干净，不编数字；
 * 3) 未跟踪 / 二进制文件没有 numstat → 不显示 `+0 -0`（后端给的是 null）。
 */
import { useMemo, useState } from 'react';
import type { GitChangeEntry } from '../../shared/types';
import { useChangesStore } from './changesState';
import './changes.css';

/** 状态徽标：一个字母 + 一句人话（悬浮提示）。 */
const STATUS_TEXT: Record<GitChangeEntry['status'], { mark: string; label: string }> = {
  modified: { mark: 'M', label: '已修改（未提交）' },
  added: { mark: 'A', label: '新增（已暂存）' },
  deleted: { mark: 'D', label: '已删除' },
  renamed: { mark: 'R', label: '重命名' },
  untracked: { mark: '?', label: '未跟踪（新文件，尚未 add）' },
  conflicted: { mark: 'U', label: '冲突（需要解决）' },
};

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
  onOpenFile,
  onOpenDiff,
  indent,
}: {
  entry: GitChangeEntry;
  onOpenFile: (file: string) => void;
  onOpenDiff: (file: string) => void;
  /** 缩进层级（按目录展示时跟着目录走）。 */
  indent: number;
}) {
  const short = entry.file.split('/').pop() ?? entry.file;
  return (
    <div className="changes-row">
      <span
        className={`changes-status ${STATUS_TEXT[entry.status].mark}`}
        title={STATUS_TEXT[entry.status].label}
      >
        {STATUS_TEXT[entry.status].mark}
      </span>
      <button
        className="changes-file"
        style={{ paddingLeft: indent * 12 }}
        title={`${entry.file}${entry.from ? `（原 ${entry.from}）` : ''} — 打开`}
        onClick={() => onOpenFile(entry.file)}
      >
        {short}
      </button>
      <span className="changes-delta">{deltaText(entry)}</span>
      <button className="btn ghost small" onClick={() => onOpenDiff(entry.file)} title="看差异（git diff）">
        差异
      </button>
    </div>
  );
}

function DirNode({
  group,
  depth,
  expanded,
  onToggle,
  onOpenFile,
  onOpenDiff,
}: {
  group: DirGroup;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onOpenFile: (file: string) => void;
  onOpenDiff: (file: string) => void;
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
              onOpenFile={onOpenFile}
              onOpenDiff={onOpenDiff}
            />
          ))}
          {own.map((entry) => (
            <FileRow
              key={entry.file}
              entry={entry}
              onOpenFile={onOpenFile}
              onOpenDiff={onOpenDiff}
              indent={depth + 1}
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
  /** 打开只读 diff 浮层（「差异」）。 */
  onOpenDiff: (file: string) => void;
}) {
  const result = useChangesStore((s) => s.result);
  const busy = useChangesStore((s) => s.busy);
  const error = useChangesStore((s) => s.error);
  const refresh = useChangesStore((s) => s.refresh);
  /** 按目录展示时，哪些目录是展开的（默认全折叠，与文件树同口径）。 */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [byDir, setByDir] = useState(true);

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
        <button className="btn ghost small" onClick={() => setByDir((v) => !v)} title="切换按目录 / 平铺">
          {byDir ? '按目录' : '平铺'}
        </button>
        <button className="btn ghost small" onClick={() => void refresh()} disabled={busy}>
          {busy ? '读取中…' : '刷新'}
        </button>
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
              onOpenFile={onOpenFile}
              onOpenDiff={onOpenDiff}
            />
          ) : (
            flat.map((entry) => (
              <FileRow
                key={entry.file}
                entry={entry}
                onOpenFile={onOpenFile}
                onOpenDiff={onOpenDiff}
                indent={0}
              />
            ))
          )}
          {result && result.truncated > 0 && (
            <div className="changes-note-summary">另有 {result.truncated} 个改动未列出（太多）。</div>
          )}
        </div>
      )}
    </div>
  );
}
