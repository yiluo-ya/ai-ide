/**
 * 视图侧位布局（VS Code 双活动栏，2026-10-08）。
 *
 * 六个视图（files / search / git / agent / overview / outline）各有一个 side（left / right），
 * 由左右两条活动栏分别展示；拖拽图标到另一条活动栏 = 换侧；在同一条活动栏内拖拽 = 上下排序。
 *
 * 纪律（对齐 prefs.ts）：
 * 1) 只写一个 localStorage 键 `wcr:layout`，与项目无关（不分片）。
 * 2) 读取容错：坏 JSON / 未知视图 / 非法 side 全部收敛到默认，绝不因脏数据卡界面。
 * 3) 每个 side 各自记住「当前选中视图」，默认 left=files、right=git。
 */

import { useSyncExternalStore } from 'react';

export type ViewSide = 'left' | 'right';

export type ViewId = 'files' | 'search' | 'git' | 'agent' | 'overview' | 'outline';

export const ALL_VIEWS: ViewId[] = ['files', 'search', 'git', 'agent', 'overview', 'outline'];

/** 默认布局：左边 = 文件 / 搜索 / 大纲 / code会话；右边 = 源码管理(git) / 总览。 */
const DEFAULT_SIDES: Record<ViewId, ViewSide> = {
  files: 'left',
  search: 'left',
  git: 'right',
  agent: 'left',
  overview: 'right',
  outline: 'left',
};

/** 默认每侧顺序。 */
const DEFAULT_ORDER: Record<ViewSide, ViewId[]> = {
  left: ['files', 'search', 'outline', 'agent'],
  right: ['git', 'overview'],
};

const DEFAULT_ACTIVE: Record<ViewSide, ViewId> = { left: 'files', right: 'git' };

export interface LayoutState {
  /** 每个视图在哪一侧。 */
  sides: Record<ViewId, ViewSide>;
  /** 每侧活动栏里视图的上下顺序。 */
  order: Record<ViewSide, ViewId[]>;
  /** 每侧当前选中的视图。 */
  active: Record<ViewSide, ViewId>;
}

const LAYOUT_KEY = 'wcr:layout';

function isViewId(v: unknown): v is ViewId {
  return typeof v === 'string' && (ALL_VIEWS as string[]).includes(v);
}

/** 收敛每侧顺序：去重、只保留合法且属于该侧的视图，缺失的补到末尾，多余剔除。 */
function coerceOrder(side: ViewSide, rawOrder: unknown, sides: Record<ViewId, ViewSide>): ViewId[] {
  const src = Array.isArray(rawOrder) ? (rawOrder as unknown[]).filter(isViewId) : [];
  const seen = new Set<ViewId>();
  const result: ViewId[] = [];
  // 先按存的值排（去重 + 只留本侧）
  for (const v of src) {
    if (!seen.has(v) && sides[v] === side) {
      result.push(v);
      seen.add(v);
    }
  }
  // 该侧但没在存档里的补到末尾
  for (const v of ALL_VIEWS) {
    if (sides[v] === side && !seen.has(v)) {
      result.push(v);
      seen.add(v);
    }
  }
  return result;
}

function coerce(raw: unknown): LayoutState {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const sides = { ...DEFAULT_SIDES };
  if (src.sides && typeof src.sides === 'object') {
    for (const id of ALL_VIEWS) {
      const s = (src.sides as Record<string, unknown>)[id];
      if (s === 'left' || s === 'right') sides[id] = s;
    }
  }
  const order = {
    left: coerceOrder('left', src.order ? (src.order as Record<string, unknown>).left : undefined, sides),
    right: coerceOrder('right', src.order ? (src.order as Record<string, unknown>).right : undefined, sides),
  };
  // active：逐侧收敛；非法则回落到该侧第一个视图
  const active = { ...DEFAULT_ACTIVE };
  if (src.active && typeof src.active === 'object') {
    const a = src.active as Record<string, unknown>;
    for (const side of ['left', 'right'] as ViewSide[]) {
      const v = a[side];
      if (isViewId(v) && sides[v] === side) active[side] = v;
    }
  }
  for (const side of ['left', 'right'] as ViewSide[]) {
    if (sides[active[side]] !== side) {
      active[side] = order[side][0] ?? DEFAULT_ACTIVE[side];
    }
  }
  return { sides, order, active };
}

function readStored(): LayoutState {
  const fallback: LayoutState = {
    sides: { ...DEFAULT_SIDES },
    order: { left: [...DEFAULT_ORDER.left], right: [...DEFAULT_ORDER.right] },
    active: { ...DEFAULT_ACTIVE },
  };
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY);
    if (!raw) return fallback;
    return coerce(JSON.parse(raw) as unknown);
  } catch {
    return fallback;
  }
}

let current: LayoutState =
  typeof window !== 'undefined'
    ? readStored()
    : { sides: { ...DEFAULT_SIDES }, order: { left: [...DEFAULT_ORDER.left], right: [...DEFAULT_ORDER.right] }, active: { ...DEFAULT_ACTIVE } };

type Listener = (s: LayoutState) => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const cb of listeners) cb(current);
}

function persist(): void {
  try {
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(current));
  } catch {
    /* 隐私模式 / 配额满：只用内存值 */
  }
}

/** 当前布局（同步读）。 */
export function loadLayout(): LayoutState {
  return current;
}

/** 某侧的活动栏视图列表（按该侧 order 排好序）。 */
export function viewsOn(side: ViewSide): ViewId[] {
  return current.order[side];
}

/** 选中某侧的视图。 */
export function setActiveView(side: ViewSide, id: ViewId): void {
  if (current.sides[id] !== side) return;
  current = { ...current, active: { ...current.active, [side]: id } };
  persist();
  notify();
}

/** 把某个视图换到目标侧；换侧后目标侧选中它，原侧若因此空掉则回落。 */
export function moveView(id: ViewId, to: ViewSide, toIndex?: number): void {
  if (current.sides[id] === to) return;
  const sides = { ...current.sides, [id]: to };
  const from: ViewSide = to === 'left' ? 'right' : 'left';
  const toList = current.order[to].filter((v) => v !== id);
  const idx = toIndex == null ? toList.length : Math.max(0, Math.min(toList.length, toIndex));
  toList.splice(idx, 0, id);
  const order = {
    ...current.order,
    [from]: current.order[from].filter((v) => v !== id),
    [to]: toList,
  };
  const active = { ...current.active };
  active[to] = id;
  if (active[from] === id) {
    active[from] = order[from][0] ?? DEFAULT_ACTIVE[from];
  }
  current = { sides, order, active };
  persist();
  notify();
}

/** 同侧排序：把某侧的视图插到指定下标位置。 */
export function reorderView(side: ViewSide, id: ViewId, toIndex: number): void {
  const list = current.order[side].filter((v) => v !== id);
  const clamped = Math.max(0, Math.min(list.length, toIndex));
  list.splice(clamped, 0, id);
  current = { ...current, order: { ...current.order, [side]: list } };
  persist();
  notify();
}

/** 订阅布局变化；返回取消函数。 */
export function subscribeLayout(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** 组件里用：订阅整个布局对象。 */
export function useLayout(): LayoutState {
  return useSyncExternalStore(subscribeLayout, loadLayout, loadLayout);
}