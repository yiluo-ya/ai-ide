/**
 * 04 W3：阅读快照的数据源（G8.2）—— `GET /api/projects/:id/readmap`。
 *
 * 两个必须成立的点：
 * 1) 只列索引内的源码文件（README / package.json 这类非源码不进快照，否则快照会虚胖）；
 * 2) 用它写出的快照拿回 `compareSnapshot` 必须报「没有变化」——
 *    这是 readmap 与变更对比共用同一行数口径的自证，口径一偏就会立刻误报 M。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { makeProject } from './helpers';
import { ProjectRegistry } from '../src/registry';
import { createApp } from '../src/api/routes';
import { compareSnapshot } from '../src/indexer/changes';
import type { ReadmapResult } from '../../shared/types';

const FILES = {
  'package.json': `${JSON.stringify({ name: 'readmap-demo' }, null, 2)}\n`,
  'README.md': '# readmap demo\n\n非源码文件不该进阅读快照。\n',
  'src/a.ts': 'export const a = 1;\n',
  'src/b.py': 'b = 2\n',
};

async function boot() {
  const fx = await makeProject(FILES);
  const dataDir = path.join(fx.root, '..', `wcr-readmap-${Date.now()}`);
  const registry = new ProjectRegistry(dataDir);
  const app = createApp(registry);
  const created = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: fx.root, name: 'readmap-demo' }),
  });
  const { project } = (await created.json()) as { project: { id: string } };
  const index = registry.get(project.id)!;
  for (let i = 0; i < 100 && index.status.indexing; i++) {
    await new Promise((r) => setTimeout(r, 30));
  }
  return {
    app,
    id: project.id,
    root: index.root,
    project: index,
    cleanup: async () => {
      registry.closeAll();
      await fx.cleanup();
      await fsp.rm(dataDir, { recursive: true, force: true });
    },
  };
}

test('readmap: 只列索引内源码文件，且字段齐全', async () => {
  const ctx = await boot();
  try {
    const res = await ctx.app.request(`/api/projects/${ctx.id}/readmap`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as ReadmapResult;
    assert.ok(Number.isFinite(body.at) && body.at > 0, 'at 是取数时间');

    const names = body.files.map((f) => f.file);
    assert.deepEqual(names, ['src/a.ts', 'src/b.py'], '只有源码文件，且按路径排序');
    assert.ok(!names.includes('package.json') && !names.includes('README.md'), '非源码文件不进快照');

    const a = body.files.find((f) => f.file === 'src/a.ts')!;
    assert.ok(a.mtimeMs > 0 && a.size > 0);
    assert.equal(a.lines, 2, '单行文件按 \\n 切分算 2 行（与变更对比同一口径）');
  } finally {
    await ctx.cleanup();
  }
});

test('readmap: 用它写的快照对比报「没有变化」，改过之后能报出来', async () => {
  const ctx = await boot();
  try {
    const res = await ctx.app.request(`/api/projects/${ctx.id}/readmap`);
    const body = (await res.json()) as ReadmapResult;
    const snapshot = {
      at: body.at,
      files: Object.fromEntries(
        body.files.map((f) => [f.file, { mtimeMs: f.mtimeMs, size: f.size, lines: f.lines }]),
      ),
    };

    const same = await compareSnapshot(ctx.project, snapshot);
    assert.equal(same.source, 'snapshot', '临时目录非 git');
    assert.deepEqual(
      same.files.map((f) => `${f.status} ${f.file}`),
      [],
      '刚写完快照就对比，不应报任何变更（口径一致的证明）',
    );

    // 真改一个文件后必须报出来，证明上一个断言不是「恒空」
    await fsp.appendFile(path.join(ctx.root, 'src', 'a.ts'), 'export const a2 = 2;\n');
    const changed = await compareSnapshot(ctx.project, snapshot);
    const a = changed.files.find((f) => f.file === 'src/a.ts');
    assert.ok(a, '改过的文件必须出现在变更清单里');
    assert.equal(a.status, 'M');
  } finally {
    await ctx.cleanup();
  }
});
