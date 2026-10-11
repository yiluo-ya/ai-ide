/**
 * Diff 面板的结构化解析与跳转步进（2026-10-11）。
 *
 * 钉住三件容易悄悄错的事：
 * - hunk 的行区间只由 `@@` 行头与文件头 `---`/`+++` 划界，hunk 内容里以 `--…` 开头的删除行
 *   不能被当成文件头（否则区间被腰斩、计数虚高）；
 * - `@@ -1 +1 @@` 这种省略行数的写法按 1 处理，`-0,0` 这类显式 0 要保留；
 * - 上一处 / 下一处到边界即停（第一处再点上一处、最后一处再点下一处都不越界）。
 */
import { describe, expect, it } from 'vitest';
import { parseDiffHunks, stepHunk } from './diffHunks';

describe('parseDiffHunks 解析 hunk 头', () => {
  it('多 hunk：起始行 / 行数 / 行区间都各归各位', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,4 @@ function a() {',
      ' ctx1',
      '+add',
      ' ctx2',
      '-del',
      ' ctx3',
      '@@ -10,2 +11,3 @@',
      ' tail',
      '+x',
      ' tail2',
    ].join('\n');

    const hunks = parseDiffHunks(diff);
    expect(hunks).toHaveLength(2);

    expect(hunks[0]).toEqual({
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 4,
      startLine: 4, // `@@` 行头本身
      endLine: 10, // 下一个 `@@` 行头之前
    });
    expect(hunks[1]).toEqual({
      oldStart: 10,
      oldLines: 2,
      newStart: 11,
      newLines: 3,
      startLine: 10,
      endLine: 14, // 文件末尾
    });
  });

  it('省略行数的 `@@ -1 +1 @@` 按 1 行处理', () => {
    const hunks = parseDiffHunks('@@ -1 +1 @@\n-old\n+new');
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, startLine: 0, endLine: 3 });
  });

  it('显式的 `-0,0`（新增文件）保留 0，不塌成 1', () => {
    const hunks = parseDiffHunks('@@ -0,0 +1,2 @@\n+a\n+b');
    expect(hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 });
  });

  it('文件头 `---`/`+++` 不给 hunk 收边错误：多文件 diff 各归各段', () => {
    const diff = [
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -2,2 +2,2 @@',
      ' x',
      ' y',
    ].join('\n');

    const hunks = parseDiffHunks(diff);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ startLine: 2, endLine: 5 });
    expect(hunks[1]).toMatchObject({ startLine: 7, endLine: 10 });
  });

  it('hunk 内容里以 `---` 开头的删除行不会把 hunk 切断', () => {
    const hunks = parseDiffHunks('@@ -1,2 +1,1 @@\n---foo\n ctx');
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ startLine: 0, endLine: 3 });
  });

  it('空 diff / null / 只有文件头 → 空列表', () => {
    expect(parseDiffHunks('')).toEqual([]);
    expect(parseDiffHunks(null)).toEqual([]);
    expect(parseDiffHunks(undefined)).toEqual([]);
    expect(parseDiffHunks('--- a/a.ts\n+++ b/a.ts')).toEqual([]);
  });
});

describe('stepHunk 的 k / n 推进与边界', () => {
  it('没有 hunk 时返回 -1', () => {
    expect(stepHunk(-1, 0, 1)).toBe(-1);
    expect(stepHunk(0, 0, -1)).toBe(-1);
  });

  it('尚未定位（-1）时：下一处落到第一处，上一处也停在第一处', () => {
    expect(stepHunk(-1, 3, 1)).toBe(0);
    expect(stepHunk(-1, 3, -1)).toBe(0);
  });

  it('中间正常前进 / 后退', () => {
    expect(stepHunk(0, 3, 1)).toBe(1);
    expect(stepHunk(2, 3, -1)).toBe(1);
    expect(stepHunk(1, 3, 1)).toBe(2);
  });

  it('边界不越界也不环绕：第一处再上一处、最后一处再下一处都停住', () => {
    expect(stepHunk(0, 3, -1)).toBe(0);
    expect(stepHunk(2, 3, 1)).toBe(2);
    expect(stepHunk(0, 1, -1)).toBe(0);
    expect(stepHunk(0, 1, 1)).toBe(0);
  });

  it('计数口径：下标 + 1 即「第 k 处」', () => {
    let k = -1;
    for (let i = 0; i < 3; i++) k = stepHunk(k, 3, 1);
    expect(k + 1).toBe(3);
    expect(stepHunk(k, 3, 1) + 1).toBe(3); // 到最后一处后仍报 3
  });
});
