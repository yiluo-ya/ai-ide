/**
 * 文件树灰色（被忽略）分组：纯函数口径（2026-10-21 用户要求）。
 *
 * 规则三条：
 * - `splitIgnored` 把一层拆成正常项与被忽略项，各自保持传入顺序（目录在前、文件在后）；
 * - `shouldFoldIgnored` 只在「本层有正常项且灰色项 > 1」时折 —— 全灰层不折（否则套娃），
 *   只有 1 个灰色项不折（为了一个条目多点一次不值）。
 *
 * 渲染与交互（折叠行、双击收起）归真机脚本 `tmp/verify-tree-ui.mjs`。
 */
import { describe, expect, it } from 'vitest';
import { shouldFoldIgnored, splitIgnored } from './FileTree';
import type { FileNode } from '../../shared/types';

const dir = (path: string, ignored = false): FileNode => ({ name: path, path, type: 'directory', ignored });
const file = (path: string, ignored = false): FileNode => ({ name: path, path, type: 'file', ignored });

describe('splitIgnored', () => {
  it('按 ignored 拆成两份，组内顺序不变', () => {
    const list = [dir('src'), dir('dist', true), file('main.ts'), file('app.log', true)];
    const { normal, ignored } = splitIgnored(list);
    expect(normal.map((n) => n.path)).toEqual(['src', 'main.ts']);
    expect(ignored.map((n) => n.path)).toEqual(['dist', 'app.log']);
  });

  it('没有灰色项时全归正常项', () => {
    const { normal, ignored } = splitIgnored([dir('src'), file('main.ts')]);
    expect(normal).toHaveLength(2);
    expect(ignored).toHaveLength(0);
  });
});

describe('shouldFoldIgnored', () => {
  it('有正常项且灰色项 > 1 → 折', () => {
    expect(shouldFoldIgnored(3, 2)).toBe(true);
    expect(shouldFoldIgnored(1, 9)).toBe(true);
  });

  it('只有 1 个灰色项 → 不折（文件 / 目录同一口径）', () => {
    expect(shouldFoldIgnored(3, 1)).toBe(false);
    expect(shouldFoldIgnored(0, 1)).toBe(false);
  });

  it('全灰层 → 不折（node_modules 内部直接平铺）', () => {
    expect(shouldFoldIgnored(0, 126)).toBe(false);
  });
});
