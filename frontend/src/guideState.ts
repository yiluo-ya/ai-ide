/**
 * 向导（04 Guide · W1）的前端状态：路线 / 进度 / 继续阅读 / 待读队列。
 *
 * 为什么不并入 `state.ts`：那个文件正被其它主题（02 透镜 / 03 导航）持续改写，
 * 向导的状态自成一体，放这里既不需要改动它，也不会被它的改动打断。
 * 刷新时机由 App 决定（切项目时 reset + load，与地图同一套做法）。
 */
import { create } from 'zustand';
import type { GuideRouteStep, GuideRoutesResult } from '../../shared/types';
import {
  QUEUE_LIMIT,
  guideApi,
  loadQueue,
  loadReadState,
  loadRouteState,
  saveQueue,
  saveReadState,
  saveRouteState,
  type QueueItem,
  type ReadState,
  type RouteKind,
} from './guide';

interface GuideState {
  projectId: string | null;
  /** 后端返回的四条路线（未取到为 null）。 */
  routes: GuideRoutesResult | null;
  /** 索引未跑完（后端 partial）：路线可能不完整。 */
  partial: boolean;
  /** 当前选中的路线。 */
  kind: RouteKind;
  /** 当前路线的自定义顺序（G2.6）；空数组 = 用后端顺序。 */
  custom: string[];
  /** 手动标记的路线完成态（file → 时间）。 */
  done: Record<string, number>;
  busy: boolean;
  /** 继续阅读（G3.4）。 */
  readstate: ReadState | null;
  /** 待读队列（G3.5）。 */
  queue: QueueItem[];
  /** 源码文件数（分母，G3.2）；后端字段暂缺时为 null。 */
  sourceFiles: number | null;

  load: (projectId: string) => Promise<void>;
  reset: () => void;
  setKind: (kind: RouteKind) => void;
  markDone: (file: string, done: boolean) => void;
  /** 在当前路线里把某文件上移 / 下移一位（G2.6「重排」，不做拖拽）。 */
  moveStep: (file: string, delta: -1 | 1) => void;
  /** 把当前顺序存成「我的路线」。 */
  saveCustom: () => void;
  /** 丢掉自定义顺序，回到后端给的顺序。 */
  resetCustom: () => void;
  /** 打开文件时记「继续阅读」（G3.4）；projectId 缺省用当前项目。 */
  rememberRead: (file: string, line: number, col: number, projectId?: string) => void;
  loadReadstate: () => void;
  addQueue: (item: { file: string; line: number; col: number; note?: string }) => void;
  removeQueue: (file: string, line: number) => void;
  clearQueue: () => void;
  /** 当前路线上该文件的下一步文件（没有下一步返回 null）。 */
  nextStepOf: (file: string | null) => string | null;
}

/**
 * 当前路线的展示顺序：自定义顺序优先，后端给但没被自定义覆盖的步骤补在后面。
 * 序号按展示顺序重排，这样「重排」之后列表序号与「第 N 步」的理由仍然自洽。
 */
export function visibleSteps(state: Pick<GuideState, 'routes' | 'kind' | 'custom'>): GuideRouteStep[] {
  const route = state.routes?.routes.find((r) => r.kind === state.kind);
  if (!route) return [];
  const byFile = new Map(route.steps.map((s) => [s.file, s]));
  const order = state.custom.length ? state.custom : route.steps.map((s) => s.file);
  const out: GuideRouteStep[] = [];
  let n = 0;
  for (const file of order) {
    const step = byFile.get(file);
    if (!step) continue;
    out.push({ ...step, order: ++n });
  }
  for (const step of route.steps) {
    if (order.includes(step.file)) continue;
    out.push({ ...step, order: ++n });
  }
  return out;
}

/** 持久化「当前路线状态」（kind / custom / done 三件一起写，避免半截数据）。 */
function persist(state: GuideState): void {
  if (!state.projectId) return;
  saveRouteState(state.projectId, {
    kind: state.kind,
    ...(state.custom.length ? { custom: state.custom } : {}),
    done: state.done,
  });
}

export const useGuideStore = create<GuideState>((set, get) => ({
  projectId: null,
  routes: null,
  partial: false,
  kind: 'dep',
  custom: [],
  done: {},
  busy: false,
  readstate: null,
  queue: [],
  sourceFiles: null,

  async load(projectId) {
    if (get().projectId !== projectId) {
      const local = loadRouteState(projectId);
      set({
        projectId,
        routes: null,
        partial: false,
        kind: local.kind,
        custom: local.custom ?? [],
        done: local.done,
        busy: true,
        readstate: loadReadState(projectId),
        queue: loadQueue(projectId),
        sourceFiles: null,
      });
    } else {
      set({ busy: true });
    }
    const data = await guideApi.routes(projectId).catch(() => null);
    if (get().projectId !== projectId) return; // 请求期间切走了项目
    set({
      routes: data,
      partial: data?.partial ?? false,
      sourceFiles: data?.sourceFiles ?? null,
      busy: false,
    });
  },

  reset() {
    set({
      projectId: null,
      routes: null,
      partial: false,
      kind: 'dep',
      custom: [],
      done: {},
      busy: false,
      readstate: null,
      queue: [],
      sourceFiles: null,
    });
  },

  setKind(kind) {
    // 自定义顺序属于某一条路线，换路时清掉（后端顺序本来就在，不丢文件）
    const next: GuideState = { ...get(), kind, custom: [] };
    persist(next);
    set({ kind, custom: [] });
  },

  markDone(file, done) {
    const next = { ...get().done };
    if (done) next[file] = Date.now();
    else delete next[file];
    set({ done: next });
    persist(get());
  },

  moveStep(file, delta) {
    const order = visibleSteps(get()).map((s) => s.file);
    const i = order.indexOf(file);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    set({ custom: order });
    persist(get());
  },

  saveCustom() {
    const order = visibleSteps(get()).map((s) => s.file);
    if (!order.length) return;
    set({ custom: order });
    persist(get());
  },

  resetCustom() {
    set({ custom: [] });
    persist(get());
  },

  rememberRead(file, line, col, projectId) {
    const id = projectId ?? get().projectId;
    if (!id) return;
    const next: ReadState = { file, line, col, at: Date.now() };
    saveReadState(id, next);
    if (get().projectId === id) set({ readstate: next });
  },

  loadReadstate() {
    const id = get().projectId;
    if (!id) return;
    set({ readstate: loadReadState(id) });
  },

  addQueue(item) {
    const id = get().projectId;
    if (!id) return;
    // 同文件同行去重；新发现的放最前（刚看到的最急着回看）
    const next: QueueItem[] = [
      { ...item, at: Date.now() },
      ...get().queue.filter((q) => !(q.file === item.file && q.line === item.line)),
    ].slice(0, QUEUE_LIMIT);
    saveQueue(id, next);
    set({ queue: next });
  },

  removeQueue(file, line) {
    const id = get().projectId;
    if (!id) return;
    const next = get().queue.filter((q) => !(q.file === file && q.line === line));
    saveQueue(id, next);
    set({ queue: next });
  },

  clearQueue() {
    const id = get().projectId;
    if (!id) return;
    saveQueue(id, []);
    set({ queue: [] });
  },

  nextStepOf(file) {
    const order = visibleSteps(get()).map((s) => s.file);
    if (!order.length) return null;
    if (!file) return order[0];
    const i = order.indexOf(file);
    // 不在当前路线上（用户自由探索到了别处）：回到路线第 1 步，而不是没有答案
    if (i < 0) return order[0];
    return order[i + 1] ?? null;
  },
}));
