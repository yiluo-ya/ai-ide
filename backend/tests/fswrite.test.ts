/**
 * FR-0008（2026-10-10）：编辑器写文件 + 文件树删除（系统回收站）。
 *
 * 四条断言方向：
 * 1) 写：真的落到磁盘（读回来复核），且回执带新的 mtime；
 * 2) 冲突：`baseMtimeMs` 与磁盘不一致 → 409，且**没有**写进去（原内容还在）；
 * 3) 边界：越界 400、目录 400、超限 413；
 * 4) 删：文件与目录都从源路径消失；越界 400；根目录 400。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/api/routes';
import type { Hono } from 'hono';
import { ProjectRegistry } from '../src/registry';
import type { ProjectIndex } from '../src/indexer/store';
import { makeProject, type Fixture } from './helpers';
import { MAX_WRITE_BYTES, trashEntry, writeProjectFile } from '../src/indexer/fswrite';

const WIN = process.platform === 'win32';

interface Boot {
  fx: Fixture;
  app: Hono;
  id: string;
  index: ProjectIndex;
  cleanup: () => Promise<void>;
}

async function boot(): Promise<Boot> {
  const fx = await makeProject({
    'src/a.ts': 'export const a = 1;\n',
    'src/sub/b.ts': 'export const b = 2;\n',
    'notes.txt': 'hello\n',
  });
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-fswrite-data-'));
  const registry = new ProjectRegistry(dataDir);
  const app = createApp(registry);
  const created = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: fx.root, name: 'fswrite-demo' }),
  });
  const { project } = (await created.json()) as { project: { id: string } };
  const index = registry.get(project.id)!;
  for (let i = 0; i < 200 && index.status.indexing; i++) await new Promise((r) => setTimeout(r, 20));
  return {
    fx,
    app,
    id: project.id,
    index,
    cleanup: async () => {
      registry.closeAll();
      fx.project.dispose();
      await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
      await fx.cleanup();
    },
  };
}

const absOf = (fx: Fixture, rel: string) => path.join(fx.root, ...rel.split('/'));

function put(app: Hono, id: string, body: Record<string, unknown>) {
  return app.request(`/api/projects/${id}/file`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('fswrite: 写文件真的落盘，回执带新 mtime，GET 也跟着变', async () => {
  const b = await boot();
  try {
    const before = (await (await b.app.request(`/api/projects/${b.id}/file?path=notes.txt`)).json()) as {
      text: string;
      mtimeMs: number | null;
    };
    assert.equal(before.text, 'hello\n');
    assert.equal(typeof before.mtimeMs, 'number');

    const res = await put(b.app, b.id, {
      path: 'notes.txt',
      text: 'hello\nworld\n',
      baseMtimeMs: before.mtimeMs,
    });
    assert.equal(res.status, 200, await res.clone().text());
    const body = (await res.json()) as { ok: true; size: number; mtimeMs: number };
    assert.equal(body.ok, true);
    assert.equal(body.size, Buffer.byteLength('hello\nworld\n', 'utf8'));

    // 不信回执自说自话：读磁盘复核
    assert.equal(await fsp.readFile(absOf(b.fx, 'notes.txt'), 'utf8'), 'hello\nworld\n');
    // 接口读的是**索引缓存**：写后要等索引刷新一步才看得到新正文（生产里由 watcher 推）。
    // 测试环境的 watcher 附着与写入有竞态，这里直接推一次索引，验「新正文能进接口」。
    await b.index.onFileChanged('notes.txt');
    const after = (await (await b.app.request(`/api/projects/${b.id}/file?path=notes.txt`)).json()) as {
      text: string;
      mtimeMs: number;
    };
    assert.equal(after.text, 'hello\nworld\n');
    assert.equal(after.mtimeMs, body.mtimeMs);
  } finally {
    await b.cleanup();
  }
});

test('fswrite: baseMtimeMs 不一致 → 409，且磁盘内容一点没动', async () => {
  const b = await boot();
  try {
    const before = (await (await b.app.request(`/api/projects/${b.id}/file?path=src/a.ts`)).json()) as {
      mtimeMs: number;
    };
    const res = await put(b.app, b.id, {
      path: 'src/a.ts',
      text: 'export const a = 999;\n',
      baseMtimeMs: before.mtimeMs - 5000, // 假装编辑器看到的是旧版本
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string; mtimeMs: number };
    assert.equal(body.error, 'file_conflict');
    assert.equal(typeof body.mtimeMs, 'number');
    assert.equal(await fsp.readFile(absOf(b.fx, 'src/a.ts'), 'utf8'), 'export const a = 1;\n');
  } finally {
    await b.cleanup();
  }
});

test('fswrite: 越界 / 目录 / 超大内容三类拒绝', async () => {
  const b = await boot();
  try {
    assert.equal((await put(b.app, b.id, { path: '../evil.txt', text: 'x' })).status, 400);
    assert.equal((await put(b.app, b.id, { path: 'src', text: 'x' })).status, 400);
    const huge = await put(b.app, b.id, { path: 'notes.txt', text: 'x'.repeat(MAX_WRITE_BYTES + 1) });
    assert.equal(huge.status, 413);
    // 目录没被当成文件写坏
    assert.equal(await fsp.readFile(absOf(b.fx, 'notes.txt'), 'utf8'), 'hello\n');
    assert.equal((await put(b.app, b.id, { text: 'no path' })).status, 400);
  } finally {
    await b.cleanup();
  }
});

test('fswrite: 删除文件与目录都从源路径消失（回收站不可用时如实 500）', async (t) => {
  const b = await boot();
  try {
    const fileRes = await b.app.request(`/api/projects/${b.id}/file?path=notes.txt`, { method: 'DELETE' });
    if (!WIN) {
      // 非 Windows 本版没有回收站实现：必须如实报错，而不是偷偷永久删
      assert.equal(fileRes.status, 500);
      const body = (await fileRes.json()) as { error: string };
      assert.equal(body.error, 'recycle_unsupported');
      t.diagnostic('非 Windows：回收站未实现，跳过真实删除断言');
      return;
    }
    assert.equal(fileRes.status, 200, await fileRes.clone().text());
    await assert.rejects(() => fsp.stat(absOf(b.fx, 'notes.txt')));

    const dirRes = await b.app.request(`/api/projects/${b.id}/file?path=src/sub`, { method: 'DELETE' });
    assert.equal(dirRes.status, 200, await dirRes.clone().text());
    await assert.rejects(() => fsp.stat(absOf(b.fx, 'src/sub')));
    // 目录之下的文件也不在了
    assert.equal(await fsp.readdir(absOf(b.fx, 'src')).then((r) => r.includes('sub')), false);
  } finally {
    await b.cleanup();
  }
});

test('fswrite: 删除的边界（越界 / 空路径 / 项目根）', async () => {
  const b = await boot();
  try {
    assert.equal((await b.app.request(`/api/projects/${b.id}/file?path=../evil`, { method: 'DELETE' })).status, 400);
    assert.equal((await b.app.request(`/api/projects/${b.id}/file`, { method: 'DELETE' })).status, 400);
    assert.equal((await b.app.request(`/api/projects/${b.id}/file?path=.`, { method: 'DELETE' })).status, 400);
  } finally {
    await b.cleanup();
  }
});

test('fswrite: 模块级 —— 不存在的路径写/删都如实失败', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-fswrite-'));
  try {
    const write = await writeProjectFile(path.join(root, 'nope.ts'), 'x');
    assert.equal(write.ok, false);
    assert.equal(write.ok === false && write.error, 'not_found');

    const trash = await trashEntry(path.join(root, 'nope.ts'));
    assert.equal(trash.ok, false);
    assert.equal(trash.ok === false && trash.error, 'not_found');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
