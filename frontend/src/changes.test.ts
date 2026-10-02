/**
 * 04 W3 的纯逻辑（G8.2–G8.4 / G7.3）：阅读快照组装、快照年龄、面板筛选与
 * 「笔记过期」的口径。
 *
 * 这几处最容易悄悄说错话，所以钉在单测里：
 * - `buildSnapshot` 只收索引内文件（否则快照里会混进已被删 / 被忽略的路径）；
 * - 「其中 M 条笔记所在的行已被改动」必须是**笔记条数**，不是文件数
 *   （后端 `counts.noteStale` 是文件数，口径不同，不能在界面上混用）；
 * - 浏览器存储 / 请求相关的部分不在这里测（`readSnapshot` 写盘走 try/catch，
 *   UI 交互归 `npm run test:ui`）。
 */
import { describe, expect, it } from 'vitest';
import type { ChangeSummary, ReadmapResult } from '../../shared/types';
import { buildSnapshot, snapshotAge } from './readSnapshot';
import { staleFileCount, staleNoteCount, visibleChanges } from './changesState';
import { blameAt, shortAuthor } from './blame';
import type { Note } from './notes';

const readmap: ReadmapResult = {
  at: 1_700_000_000_000,
  files: [
    { file: 'src/a.ts', mtimeMs: 100, size: 10, lines: 2 },
    { file: 'src/b.ts', mtimeMs: 200, size: 20, lines: 3 },
  ],
};

const note = (over: Partial<Note>): Note => ({
  id: 'n1',
  file: 'src/a.ts',
  line: 1,
  col: 1,
  anchor: 'x',
  body: 'x',
  level: 'line',
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('readSnapshot / buildSnapshot', () => {
  it('只把索引内的文件与笔记写进快照', () => {
    const snap = buildSnapshot('p1', readmap, [
      note({ id: 'n1' }),
      note({ id: 'n2', file: 'src/b.ts', line: 3 }),
      // 笔记指向一个不在索引内的文件（已被删 / 被忽略）：不进快照
      note({ id: 'n3', file: 'src/gone.ts', line: 1 }),
    ]);
    expect(Object.keys(snap.files).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(snap.files['src/a.ts']).toEqual({ mtimeMs: 100, size: 10, lines: 2 });
    expect(Object.keys(snap.noteLocs).sort()).toEqual(['n1', 'n2']);
    expect(snap.noteLocs.n2).toEqual({ file: 'src/b.ts', line: 3 });
    expect(Number.isFinite(snap.at)).toBe(true);
  });

  it('没有项目 id 就不生成快照（归属守卫）', () => {
    const snap = buildSnapshot('', readmap, [note({})]);
    expect(snap.files).toEqual({});
    expect(snap.noteLocs).toEqual({});
  });
});

describe('snapshotAge', () => {
  it('没有快照返回 null；有快照返回毫秒差，未来时间归 0', () => {
    expect(snapshotAge(null)).toBeNull();
    const now = 1_000_000;
    expect(snapshotAge({ at: now - 3000, files: {}, noteLocs: {} }, now)).toBe(3000);
    expect(snapshotAge({ at: now + 5000, files: {}, noteLocs: {} }, now)).toBe(0);
  });
});

describe('visibleChanges / 笔记过期口径', () => {
  const summary = (): ChangeSummary => ({
    at: 1,
    now: 2,
    source: 'snapshot',
    git: 'no-repo',
    files: [
      {
        file: 'src/a.ts',
        status: 'M',
        origin: 'recent',
        originConfidence: 0.5,
        notes: 3,
        noteStale: true,
      },
      {
        file: 'src/b.ts',
        status: 'M',
        origin: 'project',
        originConfidence: 0.2,
        notes: 2,
        noteStale: true,
      },
      { file: 'src/c.ts', status: 'A', origin: 'agent', originConfidence: 1, notes: 0, noteStale: false },
    ],
    counts: { added: 1, modified: 2, deleted: 0, addedLines: 0, removedLines: 0, noteStale: 2 },
  });

  it('「已读，跳过」的文件不再出现在列表里', () => {
    const rows = visibleChanges({ summary: summary(), dismissed: { 'src/c.ts': true }, onlyStale: false });
    expect(rows.map((r) => r.file)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('「只看笔记过期」按 noteStale 筛', () => {
    const rows = visibleChanges({ summary: summary(), dismissed: {}, onlyStale: true });
    expect(rows.map((r) => r.file)).toEqual(['src/a.ts', 'src/b.ts']);
    const none = visibleChanges({ summary: null, dismissed: {}, onlyStale: true });
    expect(none).toEqual([]);
  });

  it('笔记过期数按「笔记条数」累加（不是文件数 2）', () => {
    expect(staleFileCount(summary())).toBe(2);
    expect(staleNoteCount(summary())).toBe(5);
    expect(staleNoteCount(null)).toBe(0);
  });
});

describe('blame 的一行摘要', () => {
  it('作者短名过长时截断；找不到那一行返回 null（不猜）', () => {
    expect(shortAuthor('  张三  ')).toBe('张三');
    expect(shortAuthor('a'.repeat(20))).toHaveLength(13); // 12 + 省略号
    expect(shortAuthor('')).toBe('?');

    const result = {
      file: 'src/a.ts',
      lines: [
        { line: 2, rev: 'r'.repeat(40), author: '张三', email: 'z@x', at: 1, summary: 'init' },
      ],
    };
    expect(blameAt(result, 2)?.author).toBe('张三');
    expect(blameAt(result, 3)).toBeNull();
    expect(blameAt(null, 2)).toBeNull();
  });
});
