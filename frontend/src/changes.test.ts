/**
 * 04 W3 的纯逻辑（G8.2–G8.4 / G7.3）：阅读快照组装、快照年龄、面板筛选。
 *
 * 这几处最容易悄悄说错话，所以钉在单测里：
 * - `buildSnapshot` 只收索引内文件（否则快照里会混进已被删 / 被忽略的路径）；
 * - 浏览器存储 / 请求相关的部分不在这里测（`readSnapshot` 写盘走 try/catch，
 *   UI 交互归 `npm run test:ui`）。
 */
import { describe, expect, it } from 'vitest';
import type { GitChangeEntry, ReadmapResult } from '../../shared/types';
import { buildSnapshot, snapshotAge } from './readSnapshot';
import { statusMeta } from './changesState';
import { blameAt, shortAuthor } from './blame';

const readmap: ReadmapResult = {
  at: 1_700_000_000_000,
  files: [
    { file: 'src/a.ts', mtimeMs: 100, size: 10, lines: 2 },
    { file: 'src/b.ts', mtimeMs: 200, size: 20, lines: 3 },
  ],
};

describe('readSnapshot / buildSnapshot', () => {
  it('把索引内的文件写进快照', () => {
    const snap = buildSnapshot('p1', readmap);
    expect(Object.keys(snap.files).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(snap.files['src/a.ts']).toEqual({ mtimeMs: 100, size: 10, lines: 2 });
    expect(Number.isFinite(snap.at)).toBe(true);
  });

  it('没有项目 id 就不生成快照（归属守卫）', () => {
    const snap = buildSnapshot('', readmap);
    expect(snap.files).toEqual({});
  });
});

describe('snapshotAge', () => {
  it('没有快照返回 null；有快照返回毫秒差，未来时间归 0', () => {
    expect(snapshotAge(null)).toBeNull();
    const now = 1_000_000;
    expect(snapshotAge({ at: now - 3000, files: {} }, now)).toBe(3000);
    expect(snapshotAge({ at: now + 5000, files: {} }, now)).toBe(0);
  });
});

// 2026-10-03：变更改成「以 git 为准」后，visibleChanges / 笔记过期那套（自记录快照对比）
// 连同实现一起删除，对应的用例也删掉 —— 测已经不存在的功能没有意义。

/**
 * 2026-10-03 实际踩的坑：后端还是旧版本、仍发 `untracked`，而前端已删掉这一档，
 * `STATUS_META[status].cls` 直接抛错 —— 渲染期异常会把整棵 React 树卸载，页面白屏。
 * 所以这里钉住「未知状态不崩，按新增显示」这条承诺。
 */
describe('变更徽标 statusMeta', () => {
  it('已知状态给出对应中文标签', () => {
    expect(statusMeta('modified').label).toBe('修改');
    expect(statusMeta('added').label).toBe('新增');
    expect(statusMeta('deleted').label).toBe('删除');
  });

  it('未知状态（旧后端还在发的 untracked）不崩，按新增显示', () => {
    const meta = statusMeta('untracked' as unknown as GitChangeEntry['status']);
    expect(meta.label).toBe('新增');
    expect(meta.cls).toBe('add');
    expect(typeof meta.hint).toBe('string');
    expect(meta.hint.length).toBeGreaterThan(0);
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
