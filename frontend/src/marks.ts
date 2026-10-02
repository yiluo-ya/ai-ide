/**
 * 已读 / 忽略标记的共享存储层（04 Guide · G3.1）。
 *
 * 从 `mapState.ts` 抽出来，是为了让「地图」与「向导」共用同一份标记：
 * - 键与结构沿用 01 地图既有的 `wcr.map-marks`（`Record<projectId, {read, ignored}>`），
 *   不改名、不改结构，老数据无缝继续用；
 * - `subscribeMarks` 只是本页内的事件（谁改了标记通知谁），不做跨标签页同步；
 * - 所有读写都包 try/catch：隐私模式 / 配额满时静默降级，不影响阅读。
 */

export interface Marks {
  /** file → 标记时间。 */
  read: Record<string, number>;
  ignored: Record<string, number>;
}

export const MARKS_KEY = 'wcr.map-marks';

type Listener = (projectId: string) => void;
const listeners = new Set<Listener>();

function loadAll(): Record<string, Marks> {
  try {
    const raw = window.localStorage.getItem(MARKS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, Marks>) : {};
  } catch {
    return {};
  }
}

function saveAll(all: Record<string, Marks>): void {
  try {
    window.localStorage.setItem(MARKS_KEY, JSON.stringify(all));
  } catch {
    /* 隐私模式写不进去也不影响阅读 */
  }
}

/** 读某个项目的标记（缺失字段一律补成空表）。 */
export function loadMarks(projectId: string): Marks {
  const item = loadAll()[projectId];
  return { read: item?.read ?? {}, ignored: item?.ignored ?? {} };
}

function writeMarks(projectId: string, marks: Marks): void {
  const all = loadAll();
  all[projectId] = marks;
  saveAll(all);
  notify(projectId);
}

function notify(projectId: string): void {
  for (const cb of listeners) cb(projectId);
}

/** 设置某个文件的「已读」标记（`read=false` 即取消）。 */
export function setRead(projectId: string, file: string, read: boolean): void {
  const marks = loadMarks(projectId);
  if (read) marks.read[file] = Date.now();
  else delete marks.read[file];
  writeMarks(projectId, marks);
}

/** 设置某个文件的「忽略」标记（`ignored=false` 即取消）。 */
export function setIgnored(projectId: string, file: string, ignored: boolean): void {
  const marks = loadMarks(projectId);
  if (ignored) marks.ignored[file] = Date.now();
  else delete marks.ignored[file];
  writeMarks(projectId, marks);
}

/** 订阅标记变化（本页内）；返回取消函数。 */
export function subscribeMarks(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
