/**
 * 笔记存储与锚定（04 Guide · W2 / G4.1 / Q9）：三层兜底 + 导出 / 导入去重。
 *
 * 这两块是纯逻辑里最容易错的部分（锚点找回的位置错了比没有笔记更糟；导入去重错了会
 * 把笔记弄丢或弄脏），因此用单测钉住，UI 交互仍归 `npm run test:ui`。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addNote,
  anchorOf,
  exportJson,
  exportMarkdown,
  importJson,
  loadNotes,
  noteCountByFile,
  notesOf,
  readNotes,
  removeNote,
  resolveNotes,
  updateNote,
  type Note,
} from './notes';

const NOTE = (over: Partial<Note> = {}): Note => ({
  id: 'id1',
  file: 'src/util.ts',
  line: 3,
  col: 1,
  anchor: 'const x = 1;',
  body: '这里是为了处理 X',
  level: 'line',
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('notes', () => {
  beforeEach(() => window.localStorage.clear());

  it('anchorOf：去首尾空白 + 截 120', () => {
    expect(anchorOf('a\n   const x = 1;  \nb', 2)).toBe('const x = 1;');
    expect(anchorOf('x'.repeat(200), 1).length).toBe(120);
    expect(anchorOf('a', 9)).toBe('');
  });

  it('三层兜底：命中 / ±30 行找回 / 待归位', () => {
    const note = NOTE();
    // ① 行号命中且 anchor 一致
    const ok = resolveNotes([note], 'l1\nl2\nconst x = 1;\nl4');
    expect(ok.located[0].resolvedLine).toBe(3);
    expect(ok.located[0].moved).toBe(false);
    expect(ok.orphans.length).toBe(0);

    // ② 上面插了一行 → 该行 anchor 不匹配，往下搜到第 4 行
    const moved = resolveNotes([note], 'new\nl1\nl2\nconst x = 1;');
    expect(moved.located[0].resolvedLine).toBe(4);
    expect(moved.located[0].moved).toBe(true);

    // ③ 整段被改写 → 待归位（不猜位置）
    const lost = resolveNotes([note], 'a\nb\nc');
    expect(lost.located.length).toBe(0);
    expect(lost.orphans.map((n) => n.id)).toEqual(['id1']);

    // 超出 ±30 行也算丢
    const far = resolveNotes([note], [...Array(40).fill('pad'), 'const x = 1;'].join('\n'));
    expect(far.orphans.length).toBe(1);
  });

  it('文件级笔记不参与行定位', () => {
    const fileNote = NOTE({ id: 'f1', level: 'file', line: 0, col: 0, anchor: '' });
    const r = resolveNotes([fileNote], 'whatever');
    expect(r.located[0].resolvedLine).toBe(0);
    expect(r.orphans.length).toBe(0);
  });

  it('增删改查 + 计数', () => {
    const a = addNote('p', { file: 'a.ts', line: 2, col: 1, anchor: 'x', body: 'one' });
    addNote('p', { file: 'a.ts', line: 5, col: 1, anchor: 'y', body: 'two' });
    addNote('p', { file: 'b.ts', line: 0, col: 0, anchor: '', body: '文件印象', level: 'file' });
    expect(loadNotes('p').length).toBe(3);
    expect(notesOf('p', 'a.ts').length).toBe(2);
    expect(noteCountByFile('p')).toEqual({ 'a.ts': 2, 'b.ts': 1 });

    updateNote('p', a.id, '改了');
    expect(loadNotes('p').find((n) => n.id === a.id)?.body).toBe('改了');
    expect(removeNote('p', a.id)).toBe(true);
    expect(readNotes('p').length).toBe(2);
  });

  it('导出 Markdown 带 path:line，文件级不带行号', () => {
    window.localStorage.setItem(
      'wcr:notes:p',
      JSON.stringify([
        NOTE(),
        NOTE({ id: 'f1', level: 'file', line: 0, col: 0, anchor: '', body: '老代码，别照抄' }),
      ]),
    );
    const md = exportMarkdown(loadNotes('p'), 'demo');
    expect(md).toContain('- src/util.ts:3 — 这里是为了处理 X');
    expect(md).toContain('- src/util.ts — 老代码，别照抄');
  });

  it('导出 / 导入 JSON：按 id 与 file+line 去重', () => {
    addNote('p', { file: 'a.ts', line: 2, col: 1, anchor: 'x', body: 'one' });
    const json = exportJson('p');
    expect(importJson('p', json)).toBe(0); // 自己导自己：没有新增
    // 另一台机器加了一条同位置、不同 id 的
    const other = {
      version: 1,
      notes: [
        { id: 'zzz', file: 'a.ts', line: 2, col: 1, anchor: 'x', body: 'one', level: 'line', createdAt: 1, updatedAt: 1 },
        { id: 'yyy', file: 'c.ts', line: 9, col: 1, anchor: 'q', body: 'three', level: 'line', createdAt: 2, updatedAt: 2 },
      ],
    };
    expect(importJson('p', JSON.stringify(other))).toBe(1);
    expect(loadNotes('p').length).toBe(2);
    expect(() => importJson('p', '{"nope":1}')).toThrow();
  });
});
