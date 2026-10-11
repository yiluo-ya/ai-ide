/**
 * 「拉到了但没变化，就别动状态」这条口径的回归位（2026-10-11 用户要求）。
 *
 * 为什么值得钉：它只在「文件变更事件把同一份清单又拉了一次」时生效 —— 手点看不出来，
 * 但判错方向（把「变了」判成「没变」）会让面板一直停在上一次的内容上，比白闪一次严重得多。
 *
 * 这里只 mock 网络（`./api`），store 本体、`sameChanges` / `sameCommits` 都跑真代码。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitChangesResult, RepoLogEntry } from '../../shared/types';

const { gitChanges, gitLog } = vi.hoisted(() => ({ gitChanges: vi.fn(), gitLog: vi.fn() }));
vi.mock('./api', () => ({ api: { gitChanges, gitLog } }));

import { useChangesStore } from './changesState';

/** 一份「工作区里有一个改动文件」的清单。 */
function changes(file = 'src/a.ts'): GitChangesResult {
  return {
    isRepo: true,
    branch: 'main',
    entries: [{ file, status: 'modified', added: 1, removed: 2, binary: false, isTest: false }],
    truncated: 0,
  };
}

function commit(rev = 'a'.repeat(40)): RepoLogEntry {
  return {
    rev,
    shortRev: rev.slice(0, 7),
    at: 1_700_000_000_000,
    author: '张三',
    summary: 'init',
    parentIds: [],
    refs: [{ name: 'main', type: 'branch', isHead: true }],
  };
}

describe('变更状态：先拉结果、没变化不替换', () => {
  beforeEach(() => {
    useChangesStore.getState().reset();
    gitChanges.mockReset();
    gitLog.mockReset();
    gitChanges.mockImplementation(async () => changes());
    gitLog.mockImplementation(async () => ({ commits: [commit()] }));
  });

  it('同一项目重复拉取（文件变更事件唤起的自动刷新）：内容没变就保持原引用', async () => {
    await useChangesStore.getState().load('p1');
    const first = useChangesStore.getState();

    await useChangesStore.getState().load('p1'); // App 在文件树变化时再调一次
    const second = useChangesStore.getState();

    expect(second.result).toBe(first.result);
    expect(second.commits).toBe(first.commits);
    expect(second.busy).toBe(false);
  });

  it('清单真的变了才替换', async () => {
    await useChangesStore.getState().load('p1');
    const before = useChangesStore.getState().result;

    gitChanges.mockImplementation(async () => changes('src/b.ts'));
    await useChangesStore.getState().refresh();

    const after = useChangesStore.getState();
    expect(after.result).not.toBe(before);
    expect(after.result?.entries[0].file).toBe('src/b.ts');
  });

  it('提交历史变了（新提交 / ref 晃动）也算变', async () => {
    await useChangesStore.getState().load('p1');
    const before = useChangesStore.getState().commits;

    gitLog.mockImplementation(async () => ({ commits: [commit('b'.repeat(40))] }));
    await useChangesStore.getState().refresh();

    const after = useChangesStore.getState();
    expect(after.commits).not.toBe(before);
    expect(after.commits[0].rev).toBe('b'.repeat(40));
  });

  it('自动刷新（quiet）不翻 busy：刷新按钮不会闪 disabled', async () => {
    await useChangesStore.getState().load('p1'); // 先把数据就绪（这次换项目 → 非 quiet）
    let release: (() => void) | null = null;
    gitChanges.mockImplementation(
      () =>
        new Promise<GitChangesResult>((resolve) => {
          release = () => resolve(changes());
        }),
    );

    const pending = useChangesStore.getState().load('p1'); // 同项目 = 后台刷新
    expect(useChangesStore.getState().busy).toBe(false);
    release!();
    await pending;
  });

  it('换项目先清空：上一个仓库的清单不冒充新项目', async () => {
    await useChangesStore.getState().load('p1');
    expect(useChangesStore.getState().result?.entries[0].file).toBe('src/a.ts');

    let release: (() => void) | null = null;
    gitChanges.mockImplementation(
      () =>
        new Promise<GitChangesResult>((resolve) => {
          release = () => resolve(changes('src/z.ts'));
        }),
    );
    const pending = useChangesStore.getState().load('p2');
    expect(useChangesStore.getState().projectId).toBe('p2');
    expect(useChangesStore.getState().result).toBeNull();

    release!();
    await pending;
    expect(useChangesStore.getState().result?.entries[0].file).toBe('src/z.ts');
  });
});
