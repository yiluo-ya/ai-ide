/**
 * 变更面板（2026-10-03 用户要求：**以 git 为基础**，不自己记录变更）。
 *
 * 显示的就是 `git status` 的改动清单 + `git diff --numstat HEAD` 的增删行数：
 * 状态徽标（M 修改 / A 新增 / D 删除 / R 重命名 / ? 未跟踪 / U 冲突）+ 文件 + 行数。
 *
 * 三条不撒谎的规矩（沿用原来的口径）：
 * 1) 不是 git 仓库（或没装 git）→ 如实说，不用别的东西凑一份「变更」；
 * 2) 工作区干净 → 说干净，不编数字；
 * 3) 未跟踪 / 二进制文件没有 numstat → 不显示 `+0 -0`（后端给的是 null）。
 */
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

  const entries = result?.entries ?? [];

  return (
    <div className="changes-panel">
      <div className="changes-head">
        <h3>变更 · git</h3>
        <span className="changes-live">git status</span>
        <button className="btn ghost small" onClick={() => void refresh()} disabled={busy}>
          {busy ? '读取中…' : '刷新'}
        </button>
      </div>

      {result?.isRepo && (
        <div className="changes-counts">
          <span>分支 {result.branch ?? '（无提交）'}</span>
          <span>·</span>
          <span>{entries.length === 0 ? '工作区干净' : `${entries.length} 个未提交改动`}</span>
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
          {entries.map((entry) => (
            <div className="changes-row" key={`${entry.status}:${entry.file}`}>
              <span
                className={`changes-status ${STATUS_TEXT[entry.status].mark}`}
                title={STATUS_TEXT[entry.status].label}
              >
                {STATUS_TEXT[entry.status].mark}
              </span>
              <button
                className="changes-file"
                title={`${entry.file}${entry.from ? `（原 ${entry.from}）` : ''} — 打开`}
                onClick={() => onOpenFile(entry.file)}
              >
                {entry.file}
                {entry.isTest && <span className="changes-origin">测试</span>}
              </button>
              <span className="changes-delta">{deltaText(entry)}</span>
              <button className="btn ghost small" onClick={() => onOpenDiff(entry.file)} title="看差异（git diff）">
                差异
              </button>
            </div>
          ))}
          {result && result.truncated > 0 && (
            <div className="changes-note-summary">另有 {result.truncated} 个改动未列出（太多）。</div>
          )}
        </div>
      )}
    </div>
  );
}
