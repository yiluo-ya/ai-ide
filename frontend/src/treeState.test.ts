import { beforeEach, describe, expect, it } from 'vitest';
import type { FileNode } from './api';
import { allDirPaths, ancestorDirs, readTreeState, treeStateKey, writeTreeState } from './treeState';

/**
 * FR-0012：文件树「展开 / 折叠」状态的持久化 + 两个树上的小工具。
 * 容错是这里的重点：坏 JSON / 脏字段绝不能把文件树卡住。
 */
const dir = (path: string, children: FileNode[] = []): FileNode => ({
  name: path.split('/').pop() ?? path,
  path,
  type: 'directory',
  count: 0,
  children,
});
const file = (path: string): FileNode => ({ name: path.split('/').pop() ?? path, path, type: 'file' });

/** 夹具树：src/{a.ts, lib/{b.ts}}、docs/、根下的 README.md */
const TREE = dir('', [
  dir('src', [file('src/a.ts'), dir('src/lib', [file('src/lib/b.ts')])]),
  dir('docs'),
  file('README.md'),
]);

describe('treeState', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('没有项目 id 时不落盘（读回空集）', () => {
    expect(treeStateKey(null)).toBeNull();
    expect(readTreeState(null)).toEqual({ expanded: [], collapsed: [] });
    writeTreeState(undefined, { expanded: ['src'], collapsed: [] });
    expect(window.localStorage.length).toBe(0);
  });

  it('写入后能读回，且按项目分键互不影响', () => {
    writeTreeState('p1', { expanded: ['src', 'src/lib'], collapsed: ['docs'] });
    writeTreeState('p2', { expanded: [], collapsed: ['src'] });
    expect(readTreeState('p1')).toEqual({ expanded: ['src', 'src/lib'], collapsed: ['docs'] });
    expect(readTreeState('p2')).toEqual({ expanded: [], collapsed: ['src'] });
    expect(readTreeState('p3')).toEqual({ expanded: [], collapsed: [] });
  });

  it('坏 JSON / 非对象 / 脏字段一律回落空集', () => {
    window.localStorage.setItem('wcr:tree:bad', '{ not json');
    window.localStorage.setItem('wcr:tree:arr', '[1,2]');
    window.localStorage.setItem('wcr:tree:dirty', JSON.stringify({ expanded: ['ok', 7, null], collapsed: 'no' }));
    expect(readTreeState('bad')).toEqual({ expanded: [], collapsed: [] });
    expect(readTreeState('arr')).toEqual({ expanded: [], collapsed: [] });
    expect(readTreeState('dirty')).toEqual({ expanded: ['ok'], collapsed: [] });
  });

  it('ancestorDirs：由外向内的祖先目录链', () => {
    expect(ancestorDirs('src/lib/b.ts')).toEqual(['src', 'src/lib']);
    expect(ancestorDirs('a/b/c/d.ts')).toEqual(['a', 'a/b', 'a/b/c']);
    expect(ancestorDirs('README.md')).toEqual([]);
  });

  it('allDirPaths：只收目录（含嵌套），不含项目根与文件', () => {
    expect(allDirPaths(TREE).sort()).toEqual(['docs', 'src', 'src/lib']);
    expect(allDirPaths(null)).toEqual([]);
  });
});
