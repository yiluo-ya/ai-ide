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
import type { GitChangeEntry, GitChangesResult, GitWriteAction } from '../../shared/types';
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
  busy: boolean;
  /** 正在跑的写命令（null = 没有）；四个按钮据此一起禁用。 */
  running: GitWriteAction | null;
  error: string | null;

  load: (projectId: string) => Promise<void>;
  /** 手动刷新（面板顶部「刷新」按钮走它）。 */
  refresh: () => Promise<void>;
  /** 跑一个 git 写命令：结果（成 / 败都算）冒泡，成功则顺手刷新清单。 */
  run: (action: GitWriteAction, message?: string) => Promise<void>;
  reset: () => void;
}

export const useChangesStore = create<ChangesState>((set, get) => ({
  projectId: null,
  result: null,
  busy: false,
  running: null,
  error: null,

  async load(projectId) {
    set({ projectId, result: null, error: null });
    await get().refresh();
  },

  async refresh() {
    const id = get().projectId;
    if (!id) return;
    set({ busy: true, error: null });
    try {
      const result = await api.gitChanges(id);
      if (get().projectId !== id) return; // 期间切了项目
      set({ result, busy: false });
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
    set({ projectId: null, result: null, busy: false, running: null, error: null });
  },
}));
