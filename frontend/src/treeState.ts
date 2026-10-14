/**
 * 文件树「展开 / 折叠」状态的持久化 + 树上的小工具（FR-0012）。
 *
 * 与 prefs.ts 的分工：prefs 是与项目无关的界面偏好（单一键 `wcr:prefs`）；
 * 这里的树状态**与项目相关**，按项目 id 分片（key `wcr:tree:<projectId>`），
 * 与 state.ts 的 `wcr:positions:*` 同规格。读取一律容错：坏 JSON / 脏字段回落空集，
 * 绝不让一条脏数据把文件树卡住。
 */
import type { FileNode } from './api';

export interface TreeState {
  expanded: string[];
  collapsed: string[];
}

const EMPTY: TreeState = { expanded: [], collapsed: [] };

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

/** 项目对应的存储键；没有项目 id 就不持久化（返回 null）。 */
export function treeStateKey(projectId: string | null | undefined): string | null {
  return projectId ? `wcr:tree:${projectId}` : null;
}

/** 读某个项目的树状态（缺省 / 坏数据 → 空集）。 */
export function readTreeState(projectId: string | null | undefined): TreeState {
  const key = treeStateKey(projectId);
  if (!key) return { ...EMPTY };
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...EMPTY };
    const src = parsed as Record<string, unknown>;
    return { expanded: asStrings(src.expanded), collapsed: asStrings(src.collapsed) };
  } catch {
    return { ...EMPTY };
  }
}

/** 写回（失败忽略：隐私模式 / 配额满不该打断阅读）。 */
export function writeTreeState(projectId: string | null | undefined, state: TreeState): void {
  const key = treeStateKey(projectId);
  if (!key) return;
  try {
    window.localStorage.setItem(
      key,
      JSON.stringify({ expanded: [...state.expanded], collapsed: [...state.collapsed] }),
    );
  } catch {
    /* 忽略 */
  }
}

/** 「在树中定位」用：某文件路径的祖先目录链（由外到内）。`a/b/c.ts` → `['a', 'a/b']`。 */
export function ancestorDirs(file: string): string[] {
  const parts = file.split('/').filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i < parts.length; i += 1) out.push(parts.slice(0, i).join('/'));
  return out;
}

/** 「收拢所有文件夹」用：树里全部目录路径（含嵌套；项目根 `''` 不算，它不是一行）。 */
export function allDirPaths(node: FileNode | null): string[] {
  const out: string[] = [];
  const walk = (n: FileNode) => {
    for (const child of n.children ?? []) {
      if (child.type === 'directory') {
        out.push(child.path);
        walk(child);
      }
    }
  };
  if (node) walk(node);
  return out;
}
