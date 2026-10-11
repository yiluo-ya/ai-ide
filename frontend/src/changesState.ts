/**
 * 变更状态（2026-10-03 用户要求：**以 git 为基础，不自己记录变更**）。
 *
 * 两件事：
 * 1) 向 `/projects/:id/git-changes` 要「工作区相对 HEAD 的改动」—— 面板默认展示它（就是 git status）；
 * 2) 四个最常用的写命令（add all / commit / pull / push）—— 结果不问 UI，统一走右下角冒泡。
 *
 * 原来的「阅读基线快照 / compareSnapshot / 笔记过期」那套已删除：
 * git 说改了才算改了，不让阅读器自己存一份去比对（也就没有「还没记录基线」这种死路）。
 */
import { create } from 'zustand';
import type { GitChangeEntry, GitChangesResult, GitWriteAction, RepoLogEntry } from '../../shared/types';
import { api } from './api';
import { translate } from './i18n';
import { showToast } from './state';

/**
 * 变更状态 → 徽标元信息（配色档 + 悬浮说明）。
 * label / hint 存的是 i18n key，由 statusMeta() 现取现翻（本模块不在渲染路径里，用纯函数）。
 * 没有「未跟踪」一档：git 不列被忽略的文件，剩下的未跟踪文件就是新增。
 */
export const STATUS_META: Record<GitChangeEntry['status'], { label: string; cls: string; hint: string }> = {
  modified: { label: 'changes.status.M', cls: 'mod', hint: 'changes.hintModified' },
  added: { label: 'changes.status.A', cls: 'add', hint: 'changes.hintAdded' },
  deleted: { label: 'changes.status.D', cls: 'del', hint: 'changes.hintDeleted' },
  renamed: { label: 'changes.status.R', cls: 'ren', hint: 'changes.hintRenamed' },
  conflicted: { label: 'changes.status.C', cls: 'conflict', hint: 'changes.hintConflicted' },
};

/**
 * 取徽标元信息。**必须容错**：后端与前端可能不同版本（旧后端仍会发 `untracked`），
 * 直接 `STATUS_META[status].cls` 会因 undefined 抛错 —— 而这是渲染期异常，
 * 整个 React 树会被卸载，页面直接白屏（2026-10-03 实际踩过这一下）。
 * 未知档位一律按「新增」显示：没被忽略的未跟踪文件本来就是新增。
 */
export function statusMeta(status: GitChangeEntry['status']): { label: string; cls: string; hint: string } {
  const meta = STATUS_META[status] ?? STATUS_META.added;
  return { label: translate(meta.label), cls: meta.cls, hint: translate(meta.hint) };
}

interface ChangesState {
  projectId: string | null;
  /** 最近一次拿到的 git 变更；null = 还没拿过。 */
  result: GitChangesResult | null;
  /** SCM commits 视图：仓库最近提交（空 = 还没拉 / 无 git）。 */
  commits: RepoLogEntry[];
  /** commits 拿不到的原因（无 git 时为 'no-git'）。 */
  commitsReason: string | null;
  busy: boolean;
  /** 正在跑的写命令（null = 没有）；四个按钮据此一起禁用。 */
  running: GitWriteAction | null;
  error: string | null;

  load: (projectId: string) => Promise<void>;
  /**
   * 刷新：手动点「刷新」、写命令成功后、以及文件变更事件触发的自动刷新都走它。
   * `quiet` = 后台自动刷新 —— 不翻 busy，且拉回来与现在一字不差时什么都不写（页面不感知）。
   */
  refresh: (options?: { quiet?: boolean }) => Promise<void>;
  /** 跑一个 git 写命令：结果（成 / 败都算）冒泡，成功则顺手刷新清单。 */
  run: (action: GitWriteAction, message?: string) => Promise<void>;
  reset: () => void;
}

export const useChangesStore = create<ChangesState>((set, get) => ({
  projectId: null,
  result: null,
  commits: [],
  commitsReason: null,
  busy: false,
  running: null,
  error: null,

  /**
   * 载入某个项目：**只有换项目才清空**旧数据（否则上一个仓库的清单会冒充新项目）。
   * 同一项目内的重复调用（App 在文件树变化时也会调它）走静默刷新。
   */
  async load(projectId) {
    const switched = get().projectId !== projectId;
    if (switched) set({ projectId, result: null, commits: [], commitsReason: null, error: null });
    await get().refresh({ quiet: !switched });
  },

  /**
   * 拉一次 git 状态（changes 与 commits 一起），**先拿结果再决定要不要替换**（2026-10-11 用户要求）。
   *
   * 为什么要比：本方法除了手点「刷新」，还会被文件变更事件频繁唤醒 —— 若每次都把拉回来的
   * 新对象塞进状态，即使内容一字不差，`result` / `commits` 的引用也会变，面板跟着重建一遍
   * （列表重算、滚动位丢、白闪一下）。所以内容没变就原样留着，只有真变了才替换。
   */
  async refresh(options = {}) {
    const id = get().projectId;
    if (!id) return;
    if (!options.quiet) set({ busy: true, error: null });
    try {
      const result = await api.gitChanges(id);
      // commits 视图同步拉一次（不阻塞 changes 展示；失败单独记 reason）
      const log = await api.gitLog(id).catch(() => null);
      if (get().projectId !== id) return; // 期间切了项目
      const prev = get();
      const commits = log?.commits ?? [];
      const commitsReason = log === null ? 'load-failed' : (log.reason ?? null);
      const unchanged =
        prev.error === null &&
        prev.result !== null &&
        sameChanges(prev.result, result) &&
        sameCommits(prev.commits, commits) &&
        prev.commitsReason === commitsReason;
      if (unchanged) {
        // 没变化：状态一个字都不动（引用不变 → React 不重渲染，页面无感知）
        if (!options.quiet) set({ busy: false });
        return;
      }
      set({ result, commits, commitsReason, busy: false, error: null });
    } catch (e) {
      if (get().projectId !== id) return;
      set({ error: e instanceof Error ? e.message : String(e), busy: false });
    }
  },

  async run(action, message) {
    const id = get().projectId;
    if (!id || get().running) return;
    set({ running: action });
    try {
      const res = await api.gitWrite(id, action, message);
      showToast(res.summary, res.ok);
      if (res.ok) await get().refresh();
    } catch (e) {
      // 400 / 403 这类「请求本身没通过」也如实说，不假装命令跑过了
      showToast(e instanceof Error ? e.message : String(e), false);
    } finally {
      if (get().projectId === id) set({ running: null });
    }
  },

  reset() {
    set({ projectId: null, result: null, commits: [], commitsReason: null, busy: false, running: null, error: null });
  },
}));

/**
 * 两份变更清单是不是「一字不差」。逐条比字段（而不是 JSON.stringify）：
 * 后端将来往结果里加时间戳之类的字段时，不会把它误当成「有变化」而白白替换一次。
 */
export function sameChanges(a: GitChangesResult | null, b: GitChangesResult | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.isRepo !== b.isRepo || a.branch !== b.branch || a.truncated !== b.truncated) return false;
  if (a.entries.length !== b.entries.length) return false;
  return a.entries.every((x, i) => {
    const y = b.entries[i];
    return (
      x.file === y.file &&
      x.status === y.status &&
      x.from === y.from &&
      x.added === y.added &&
      x.removed === y.removed &&
      x.binary === y.binary &&
      x.isTest === y.isTest
    );
  });
}

/** 两份提交历史是不是「一字不差」（顺序也按 git log 给的原样比）。 */
export function sameCommits(a: RepoLogEntry[], b: RepoLogEntry[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    const xParents = x.parentIds ?? [];
    const yParents = y.parentIds ?? [];
    const xRefs = x.refs ?? [];
    const yRefs = y.refs ?? [];
    return (
      x.rev === y.rev &&
      x.shortRev === y.shortRev &&
      x.at === y.at &&
      x.author === y.author &&
      x.summary === y.summary &&
      xParents.length === yParents.length &&
      xParents.every((p, k) => p === yParents[k]) &&
      xRefs.length === yRefs.length &&
      xRefs.every((r, k) => r.name === yRefs[k].name && r.type === yRefs[k].type && r.isHead === yRefs[k].isHead)
    );
  });
}
