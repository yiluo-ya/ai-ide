/**
 * 04 W3：变更对比（G8.2–G8.4）。
 *
 * 覆盖两套口径：
 * - 无 git：只做快照对比 —— M / A / D 判定、笔记过期标记、`source='snapshot'`
 *   且**不给** addedLines / removedLines（不编造）；
 * - 有 git：按 `diff --numstat` 报增删行，未跟踪新文件按 A 处理。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeProject } from './helpers';
import { compareSnapshot } from '../src/indexer/changes';

const run = promisify(execFile);

const FILES = {
  'src/a.ts': 'export const a = 1;\n',
  'src/b.ts': 'export const b = 2;\n',
  'src/c.ts': 'export const c = 3;\n',
};

const fileOf = (summary: Awaited<ReturnType<typeof compareSnapshot>>, file: string) => {
  const hit = summary.files.find((f) => f.file === file);
  assert.ok(hit, `清单里应有 ${file}；实际：${summary.files.map((f) => `${f.status} ${f.file}`).join(', ')}`);
  return hit;
};

test('changes: 改文件 → M（笔记过期）、删文件 → D、新文件 → A；无 git 时不报增删行', async () => {
  const fx = await makeProject(FILES);
  try {
    // 「上次阅读」的快照：a / b / c 在里面；a / b 上各有一条笔记。
    // c 用真实 mtime/size（表示没动过），a 故意给旧值（表示上次读过之后改过）。
    const snapSide = (file: string) => {
      const info = fx.project.entries.get(file)!;
      const fi = fx.project.files.get(file)!;
      return { mtimeMs: info.mtimeMs, size: info.size, lines: fi.source.split('\n').length };
    };
    const snapshot = {
      at: Date.now() - 60_000,
      files: {
        'src/a.ts': { mtimeMs: 0, size: 0, lines: 2 },
        'src/b.ts': { mtimeMs: 0, size: 0, lines: 2 },
        'src/c.ts': snapSide('src/c.ts'),
      },
      noteLocs: {
        n1: { file: 'src/a.ts', line: 1 },
        n2: { file: 'src/b.ts', line: 1 },
      },
    };

    // 改 a（mtime + size 都变）、删 b、新增 d（走 watcher 的 onFileCreated 进索引）
    await fsp.writeFile(
      path.join(fx.root, 'src', 'a.ts'),
      'export const a = 11;\nexport const extra = 1;\n',
    );
    await fsp.rm(path.join(fx.root, 'src', 'b.ts'));
    await fsp.writeFile(path.join(fx.root, 'src', 'd.ts'), 'export const d = 4;\n');
    await fx.project.onFileCreated('src/d.ts');

    const summary = await compareSnapshot(fx.project, snapshot);

    assert.equal(summary.source, 'snapshot', '临时目录非 git → 只做快照对比');
    assert.equal(summary.at, snapshot.at);

    const a = fileOf(summary, 'src/a.ts');
    assert.equal(a.status, 'M');
    assert.equal(a.notes, 1);
    assert.equal(a.noteStale, true, '有笔记且文件被改动 → 笔记可能过期');
    assert.ok(a.before, '快照里有 before');
    assert.ok(a.after, '磁盘还在 → 有 after');

    const b = fileOf(summary, 'src/b.ts');
    assert.equal(b.status, 'D');
    assert.equal(b.noteStale, true);
    assert.ok(b.before && !b.after, '删除的文件只有 before、没有 after');

    const d = fileOf(summary, 'src/d.ts');
    assert.equal(d.status, 'A');
    assert.equal(d.notes, 0);
    assert.equal(d.noteStale, false);

    // 无 git：不编造增删行
    for (const file of summary.files) {
      assert.equal(file.addedLines, null, `${file.file} 不应有 addedLines`);
      assert.equal(file.removedLines, null, `${file.file} 不应有 removedLines`);
    }
    assert.equal(summary.counts.addedLines, 0);
    assert.equal(summary.counts.removedLines, 0);
    assert.equal(summary.counts.deleted, 1);
    assert.equal(summary.counts.added, 1);
    assert.equal(summary.counts.modified, 1);
    assert.equal(summary.counts.noteStale, 2);
    assert.deepEqual(
      summary.files.map((f) => `${f.status} ${f.file}`).sort(),
      ['A src/d.ts', 'D src/b.ts', 'M src/a.ts'],
      '没动过的 c.ts 不应出现在清单里',
    );
  } finally {
    await fx.cleanup();
  }
});

test('changes: git 可用时按 numstat 报增删行，未跟踪新文件按 A', async (t) => {
  const fx = await makeProject(FILES);
  try {
    let usable = true;
    try {
      await run('git', ['-C', fx.root, 'init'], { windowsHide: true });
      await run('git', ['-C', fx.root, 'add', '.'], { windowsHide: true });
      await run(
        'git',
        ['-C', fx.root, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-m', 'init'],
        { windowsHide: true },
      );
    } catch {
      usable = false;
    }
    if (!usable) {
      t.skip('本机 git 不可用，跳过 git 路径');
      return;
    }

    await fsp.appendFile(path.join(fx.root, 'src', 'a.ts'), 'export const a2 = 2;\n');
    await fsp.writeFile(path.join(fx.root, 'src', 'e.ts'), 'export const e = 5;\n');
    await fx.project.onFileCreated('src/e.ts');

    const summary = await compareSnapshot(fx.project, { at: Date.now(), files: {} });
    assert.equal(summary.source, 'git');

    const a = fileOf(summary, 'src/a.ts');
    assert.equal(a.status, 'M');
    assert.equal(a.addedLines, 1, '追加一行 → +1');
    assert.equal(a.removedLines, 0);

    const e = fileOf(summary, 'src/e.ts');
    assert.equal(e.status, 'A', '未跟踪文件按新增');
    assert.equal(e.removedLines, 0);
    assert.ok((e.addedLines ?? 0) >= 1, '新文件的增行取文件行数');
    assert.ok(summary.counts.addedLines >= 1);
  } finally {
    await fx.cleanup();
  }
});
