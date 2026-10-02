/**
 * 变更感知的前端状态（04 Guide · W3 / G8.1–G8.4）。
 *
 * 为什么不并入 `state.ts`：与 `guideState.ts` / `notesState.ts` 同理由 —— 那个文件
 * 正被其它主题持续改写，W3 的状态自成一体，既不互相踩，也不必往共享文件里堆东西。
 *
 * 两条纪律：
 * 1) **没有快照就没有对比**（`hasSnapshot === false`）——界面整块改成「记录基线」按钮，
 *    不用假数字占位；
 * 2) 后端说 `source === 'snapshot'` 时，`addedLines` / `removedLines` 是 null，
 *    界面就不显示行数增减（不写 `+0 -0`）。
 */
import { create } from 'zustand';
import type { ChangeFile, ChangeSummary } from '../../shared/types';
import { changesApi, flushSnapshot, readSnapshot, type ReadSnapshot } from './readSnapshot';

interface ChangesState {
  projectId: string | null;
  /** 本次比对结果（未比对 / 无快照时为 null）。 */
  summary: ChangeSummary | null;
  /** 上次阅读的基线快照；null = 还没记录过。 */
  snapshot: ReadSnapshot | null;
  /** 有基线（快照存在）——界面据此决定显示清单还是「记录基线」按钮。 */
  hasSnapshot: boolean;
  busy: boolean;
  error: string | null;
  /** 本次会话内「已读，跳过」的文件（不落盘：刷新后就该再提醒一次）。 */
  dismissed: Record<string, true>;
  /** 筛选：只看笔记过期的文件（`04-guide.md` §3.4）。 */
  onlyStale: boolean;

  /** 切项目 / 索引就绪：读本地快照并比对一次。 */
  load: (projectId: string) => Promise<void>;
  reset: () => void;
  /** 重新比对（会话内变更提示的「重新比对」按钮也走它）。 */
  refresh: () => Promise<void>;
  /** 手动「记录当前为阅读基线」：写快照 + 重新比对；写不上返回 false。 */
  recordBaseline: () => Promise<boolean>;
  dismissFile: (file: string) => void;
  setOnlyStale: (value: boolean) => void;
}

export const useChangesStore = create<ChangesState>((set, get) => ({
  projectId: null,
  summary: null,
  snapshot: null,
  hasSnapshot: false,
  busy: false,
  error: null,
  dismissed: {},
  onlyStale: false,

  async load(projectId) {
    const snapshot = readSnapshot(projectId);
    if (get().projectId !== projectId) {
      set({
        projectId,
        snapshot,
        hasSnapshot: snapshot !== null,
        summary: null,
        busy: snapshot !== null,
        error: null,
        dismissed: {},
        onlyStale: false,
      });
    } else {
      set({ snapshot, hasSnapshot: snapshot !== null, error: null });
    }
    if (!snapshot) return;
    const summary = await changesApi
      .changes(projectId, { at: snapshot.at, files: snapshot.files, noteLocs: snapshot.noteLocs })
      .catch((e: unknown) => {
        if (get().projectId === projectId) {
          set({ busy: false, error: e instanceof Error ? e.message : String(e) });
        }
        return null;
      });
    if (get().projectId !== projectId) return;
    set({ summary, busy: false });
  },

  reset() {
    set({
      projectId: null,
      summary: null,
      snapshot: null,
      hasSnapshot: false,
      busy: false,
      error: null,
      dismissed: {},
      onlyStale: false,
    });
  },

  async refresh() {
    const id = get().projectId;
    const snapshot = get().snapshot;
    if (!id || !snapshot) return;
    set({ busy: true, error: null });
    try {
      const summary = await changesApi.changes(id, {
        at: snapshot.at,
        files: snapshot.files,
        noteLocs: snapshot.noteLocs,
      });
      if (get().projectId !== id) return;
      set({ summary, busy: false });
    } catch (e) {
      if (get().projectId !== id) return;
      set({ busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  async recordBaseline() {
    const id = get().projectId;
    if (!id) return false;
    set({ busy: true, error: null });
    const snapshot = await flushSnapshot(id);
    if (get().projectId !== id) return false;
    if (!snapshot) {
      set({ busy: false, error: 'baseline-failed' });
      return false;
    }
    set({ snapshot, hasSnapshot: true, summary: null, dismissed: {} });
    await get().refresh();
    return true;
  },

  dismissFile(file) {
    set({ dismissed: { ...get().dismissed, [file]: true } });
  },

  setOnlyStale(value) {
    set({ onlyStale: value });
  },
}));

/** 面板 / 首屏要展示的条目：已跳过的剔除，需要时只留笔记过期的。 */
export function visibleChanges(
  state: Pick<ChangesState, 'summary' | 'dismissed' | 'onlyStale'>,
): ChangeFile[] {
  const files = state.summary?.files ?? [];
  return files.filter((f) => !state.dismissed[f.file] && (!state.onlyStale || f.noteStale));
}

/**
 * 「其中 M 条笔记所在的行已被改动」。
 *
 * 后端 `counts.noteStale` 是**文件数**，这里要的是**笔记条数**（口径不同，不能混用）：
 * 有笔记的文件按它自己的 `notes` 累加。所以这个数只在界面上算，不借后端的字段充数。
 */
export function staleNoteCount(summary: ChangeSummary | null): number {
  if (!summary) return 0;
  return summary.files.reduce((n, f) => n + (f.noteStale ? f.notes : 0), 0);
}

/** 有笔记且笔记所在文件被改动过的文件数。 */
export function staleFileCount(summary: ChangeSummary | null): number {
  if (!summary) return 0;
  return summary.files.filter((f) => f.noteStale && f.notes > 0).length;
}
