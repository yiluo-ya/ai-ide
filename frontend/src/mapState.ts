/**
 * 项目地图（01-map）的前端状态：概览 / 时间轴 / 本地标记（忽略）。
 *
 * 为什么不并入 `state.ts`：那个文件正被其它主题（02 透镜 / 03 导航）持续改写，
 * 地图的状态自成一体，放这里既不需要改动它，也不会被它的改动打断。
 * 刷新时机由 App 决定（项目切换、索引就绪、文件树变化）。
 */
import { create } from 'zustand';
import { subscribeEvents } from './api';
import { translate } from './i18n';
import { mapApi } from './mapApi';
import { loadMarks, setIgnored, subscribeMarks } from './marks';
import type { HotMetric, ProjectOverview, ProjectTimeline } from './mapApi';

// 标记类型与读写已抽到 marks.ts（向导与地图共用），这里只做类型转出，保持对外 API 不变
export type { Marks } from './marks';

/** 概览的展示口径（M3.2 口径可切换 / M3.4 降噪）。 */
export interface OverviewOptions {
  hot: HotMetric;
  denoise: boolean;
}

interface MapState {
  projectId: string | null;
  overview: ProjectOverview | null;
  timeline: ProjectTimeline | null;
  busy: boolean;
  error: string | null;
  options: OverviewOptions;
  ignored: Record<string, number>;
  /** M9.3：刚被外部改动过的文件（file → 时间），供文件树打「刚变更」脉冲标记。 */
  pulse: Record<string, number>;

  load: (projectId: string) => Promise<void>;
  reset: () => void;
  setOptions: (patch: Partial<OverviewOptions>) => void;
  toggleIgnored: (file: string) => void;
  /** 按需取全量文件事实（「点数字列出构成」用）。 */
  loadFileFacts: () => Promise<ProjectOverview['files']>;
  markPulse: (file: string) => void;
}

export const useMapStore = create<MapState>((set, get) => ({
  projectId: null,
  overview: null,
  timeline: null,
  busy: false,
  error: null,
  options: { hot: 'files', denoise: true },
  ignored: {},
  pulse: {},

  async load(projectId) {
    if (get().projectId !== projectId) {
      const marks = loadMarks(projectId);
      set({ projectId, overview: null, timeline: null, ignored: marks.ignored, pulse: {} });
      watchEvents(projectId, set, get);
      watchMarks(projectId, set, get);
    }
    set({ busy: true });
    const { hot, denoise } = get().options;
    const [overview, timeline] = await Promise.all([
      mapApi.overview(projectId, { hot, denoise }).catch(() => null),
      mapApi.timeline(projectId).catch(() => null),
    ]);
    if (get().projectId !== projectId) return; // 请求期间切走了项目
    set({
      overview,
      timeline,
      busy: false,
      error: overview ? null : translate('map.unavailable'),
    });
  },

  reset() {
    set({ projectId: null, overview: null, timeline: null, busy: false, error: null, ignored: {}, pulse: {} });
    stopWatching();
  },

  setOptions(patch) {
    const id = get().projectId;
    set({ options: { ...get().options, ...patch } });
    if (id) void get().load(id);
  },

  async loadFileFacts() {
    const id = get().projectId;
    if (!id) return undefined;
    const { hot, denoise } = get().options;
    const data = await mapApi.overview(id, { hot, denoise, files: true }).catch(() => null);
    return data?.files;
  },

  markPulse(file) {
    set({ pulse: { ...get().pulse, [file]: Date.now() } });
  },

  toggleIgnored(file) {
    const id = get().projectId;
    if (!id) return;
    setIgnored(id, file, !get().ignored[file]);
  },
}));

/** 脉冲保留时长（M9.3「刚变更」标记）：足够看到，又不会一直碍眼。 */
const PULSE_MS = 20_000;

let stopEvents: (() => void) | null = null;
let stopMarks: (() => void) | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
let pulseTimers = new Set<ReturnType<typeof setTimeout>>();

/**
 * 自己订阅一次 SSE（M9.3）：
 * 文件变更 → 给该文件打脉冲标记，并把地图数据重拉一次（防抖），
 * 这样阅读时 agent 仍在写也能立刻看到。
 */
function watchEvents(
  projectId: string,
  set: (patch: Partial<MapState>) => void,
  get: () => MapState,
): void {
  stopWatching();
  stopEvents = subscribeEvents(projectId, (event) => {
    if (event.type !== 'file-changed' && event.type !== 'file-deleted') return;
    const file = typeof event.file === 'string' ? event.file : null;
    if (file && get().projectId === projectId) {
      set({ pulse: { ...get().pulse, [file]: Date.now() } });
      const timer = setTimeout(() => {
        pulseTimers.delete(timer);
        const next = { ...get().pulse };
        delete next[file];
        set({ pulse: next });
      }, PULSE_MS);
      pulseTimers.add(timer);
    }
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void get().load(projectId), 500);
  });
}

/**
 * 订阅标记变化（marks.ts 的本页事件）：忽略标记改动后同步到地图内存态。
 */
function watchMarks(
  projectId: string,
  set: (patch: Partial<MapState>) => void,
  get: () => MapState,
): void {
  stopMarks?.();
  stopMarks = subscribeMarks((changed) => {
    if (changed !== projectId || get().projectId !== projectId) return;
    const marks = loadMarks(projectId);
    set({ ignored: marks.ignored });
  });
}

function stopWatching(): void {
  stopEvents?.();
  stopEvents = null;
  stopMarks?.();
  stopMarks = null;
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = null;
  for (const t of pulseTimers) clearTimeout(t);
  pulseTimers = new Set();
}

/** 文件 → 热力档位（0 最旧 … 4 最新），供文件树着色。 */
export function heatLevel(mtimeMs: number | undefined, now = Date.now()): number {
  if (!mtimeMs) return -1;
  const day = 86_400_000;
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (mtimeMs >= startOfToday) return 4;
  if (mtimeMs >= now - 3 * day) return 3;
  if (mtimeMs >= now - 7 * day) return 2;
  if (mtimeMs >= now - 30 * day) return 1;
  return 0;
}
