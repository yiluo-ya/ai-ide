import { beforeEach, describe, expect, it } from 'vitest';
import { useStore, readPositions, readSearchHistory } from './state';

/**
 * state 里的本机持久化读取（N13 / N20 / N22，Q4：只落 localStorage、按项目分片）。
 * 这些是纯读函数，脏数据一律回落空值 —— 这条容错承诺值得钉住。
 */
describe('state 本机持久化', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('没有当前项目时一律返回空值', () => {
    expect(readSearchHistory(null)).toEqual([]);
    expect(readPositions(null)).toEqual({});
  });

  it('搜索历史：坏 JSON 回落空数组，非字符串项被过滤', () => {
    window.localStorage.setItem('wcr:search-history:p1', '{oops');
    expect(readSearchHistory('p1')).toEqual([]);

    window.localStorage.setItem('wcr:search-history:p1', JSON.stringify(['foo', 3, null, 'bar']));
    expect(readSearchHistory('p1')).toEqual(['foo', 'bar']);
  });

  it('位置记忆：按项目隔离，坏 JSON / 非对象回落空对象', () => {
    window.localStorage.setItem('wcr:positions:p1', JSON.stringify({ 'src/a.ts': { line: 3, col: 1, scrollTop: 10 } }));
    expect(readPositions('p1')['src/a.ts']).toEqual({ line: 3, col: 1, scrollTop: 10 });
    expect(readPositions('p2')).toEqual({});

    window.localStorage.setItem('wcr:positions:p2', 'not json');
    expect(readPositions('p2')).toEqual({});
  });
});

/**
 * 导航历史（N18）：「打开文件」与「编辑器内点击光标位置」共用同一条栈。
 * 点击不推 URL、不改打开的文件，只在栈里留一个回退点；同一个位置不重复压。
 */
describe('导航历史压栈（noteCursorAt）', () => {
  beforeEach(() => {
    useStore.setState({ projectId: 'p1', history: [], historyIndex: -1 });
  });

  it('点击位置按顺序入栈，同一位置不重复压', () => {
    const { noteCursorAt } = useStore.getState();
    noteCursorAt('src/a.ts', 10, 1);
    noteCursorAt('src/a.ts', 42, 5);
    noteCursorAt('src/a.ts', 42, 5);
    expect(useStore.getState().history).toEqual([
      { file: 'src/a.ts', line: 10, col: 1 },
      { file: 'src/a.ts', line: 42, col: 5 },
    ]);
    expect(useStore.getState().historyIndex).toBe(1);
  });

  it('后退过之后再点新位置：截掉前进分支', () => {
    const { noteCursorAt } = useStore.getState();
    noteCursorAt('a.ts', 1, 1);
    noteCursorAt('a.ts', 2, 1);
    noteCursorAt('a.ts', 3, 1);
    useStore.setState({ historyIndex: 0 }); // 模拟「已经后退过」
    noteCursorAt('a.ts', 9, 1);
    expect(useStore.getState().history).toEqual([
      { file: 'a.ts', line: 1, col: 1 },
      { file: 'a.ts', line: 9, col: 1 },
    ]);
  });

  it('没有当前项目时不压栈', () => {
    useStore.setState({ projectId: null });
    useStore.getState().noteCursorAt('a.ts', 5, 1);
    expect(useStore.getState().history).toEqual([]);
    expect(useStore.getState().historyIndex).toBe(-1);
  });
});
