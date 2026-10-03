import { beforeEach, describe, expect, it } from 'vitest';
import { readPositions, readSearchHistory } from './state';

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
