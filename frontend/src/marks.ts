/**
 * 「忽略」标记的共享存储层（01 地图 M8.2）。
 *
 * 键与结构沿用 01 地图既有的 `wcr.map-marks`（`Record<projectId, {ignored}>`），
 * 不改名、不改结构，老数据无缝继续用。
 * 2026-10-08 用户要求清除「已读 / 待读」：相关旧数据（`read` 子集、`wcr:queue:*` 键、
 * 路线里的 `done` 完成表）由 `purgeLegacyReadState()` 在启动时一并清掉，此后不再读写。
 * - `subscribeMarks` 只是本页内的事件（谁改了标记通知谁），不做跨标签页同步；
 * - 所有读写都包 try/catch：隐私模式 / 配额满时静默降级，不影响阅读。
 */

export interface Marks {
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
  return { ignored: item?.ignored ?? {} };
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

/**
 * 清掉已废除的「已读 / 待读」旧数据（2026-10-08 用户要求，启动时跑一次）：
 * - 待读队列的旧键 `wcr:queue:<projectId>`；
 * - `wcr.map-marks` 里各项目的 `read` 子集（保留 `ignored`）；
 * - 阅读路线 `wcr:routes:<projectId>` 里的 `done` 完成表（手动「已读」的另一处落点）。
 */
export function purgeLegacyReadState(): void {
  try {
    const queueKeys: string[] = [];
    const routesKeys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key) continue;
      if (key.startsWith('wcr:queue:')) queueKeys.push(key);
      else if (key.startsWith('wcr:routes:')) routesKeys.push(key);
    }
    for (const key of queueKeys) window.localStorage.removeItem(key);

    for (const key of routesKeys) {
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      const state = JSON.parse(raw) as Record<string, unknown>;
      if (state && typeof state === 'object' && 'done' in state) {
        delete state.done;
        window.localStorage.setItem(key, JSON.stringify(state));
      }
    }

    const raw = window.localStorage.getItem(MARKS_KEY);
    if (!raw) return;
    const all = JSON.parse(raw) as Record<string, { ignored?: Record<string, number> } | null>;
    const next: Record<string, Marks> = {};
    for (const [projectId, marks] of Object.entries(all)) {
      const ignored = marks?.ignored ?? {};
      if (Object.keys(ignored).length) next[projectId] = { ignored };
    }
    window.localStorage.setItem(MARKS_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式 / 脏数据：清不掉也不影响阅读 */
  }
}
