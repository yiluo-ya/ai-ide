/**
 * 变更状态（2026-10-03 用户要求：**以 git 为基础，不自己记录变更**）。
 *
 * 只做一件事：向 `/projects/:id/git-changes` 要「工作区相对 HEAD 的改动」。
 * 原来的「阅读基线快照 / compareSnapshot / 笔记过期」那套已删除：
 * git 说改了才算改了，不让阅读器自己存一份去比对（也就没有「还没记录基线」这种死路）。
 */
import { create } from 'zustand';
import type { GitChangesResult } from '../../shared/types';
import { api } from './api';

interface ChangesState {
  projectId: string | null;
  /** 最近一次拿到的 git 变更；null = 还没拿过。 */
  result: GitChangesResult | null;
  busy: boolean;
  error: string | null;

  load: (projectId: string) => Promise<void>;
  /** 手动刷新（面板顶部「刷新」按钮走它）。 */
  refresh: () => Promise<void>;
  reset: () => void;
}

export const useChangesStore = create<ChangesState>((set, get) => ({
  projectId: null,
  result: null,
  busy: false,
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

  reset() {
    set({ projectId: null, result: null, busy: false, error: null });
  },
}));
