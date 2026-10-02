/** S9c 退出清理：资源视图冒烟测试（watcher / streams / 索引占用）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { makeProject } from './helpers';
import { ProjectRegistry } from '../src/registry';
import { createApp } from '../src/api/routes';

const FILES = {
  'src/util.ts': `export function helper(v: number): number {
  return v + 1;
}
`,
  'src/main.ts': `import { helper } from './util';

export const out = helper(1);
`,
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

type App = ReturnType<typeof createApp>;

/**
 * 等索引跑完、且文件监听已挂上（dispose 判据里的「indexed / watcher」都以此为准）。
 * watcher 挂在 reindexAll 完成之后，只看 status.indexing 会撞上「索引已完但 watcher 未挂」的中间态。
 */
async function waitIndexed(app: App, id: string): Promise<{ filesIndexed: number }> {
  for (let i = 0; i < 200; i++) {
    const res = await app.request(`/api/projects/${id}/status`);
    const { status } = (await res.json()) as {
      status: { indexing: boolean; filesIndexed: number };
    };
    if (!status.indexing && status.filesIndexed > 0) {
      const rs = await app.request(`/api/projects/${id}/resources`);
      const { watcher } = (await rs.json()) as { watcher: boolean };
      if (watcher) return status;
    }
    await delay(30);
  }
  throw new Error('index timeout');
}

async function boot() {
  const fx = await makeProject(FILES);
  const dataDir = path.join(fx.root, '..', `wcr-dispose-${Date.now()}`);
  const registry = new ProjectRegistry(dataDir);
  const app = createApp(registry);
  const created = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: fx.root, name: 'dispose-demo' }),
  });
  const { project } = (await created.json()) as { project: { id: string } };
  const id = project.id;
  await waitIndexed(app, id);
  return {
    app,
    registry,
    id,
    root: fx.root,
    cleanup: async () => {
      registry.closeAll();
      await fx.cleanup();
      await fsp.rm(dataDir, { recursive: true, force: true });
    },
  };
}

interface Resources {
  watcher: boolean;
  streams: number;
  indexed: boolean;
  filesIndexed: number;
}

const resourcesOf = async (app: App, id: string): Promise<Resources> => {
  const res = await app.request(`/api/projects/${id}/resources`);
  assert.equal(res.status, 200);
  return (await res.json()) as Resources;
};

test('dispose: 资源视图给出 watcher / streams / 索引的真实占用', async () => {
  const ctx = await boot();
  try {
    const res = await resourcesOf(ctx.app, ctx.id);
    assert.equal(res.watcher, true, '索引完成后应挂着文件监听');
    assert.equal(res.streams, 0, '没有 SSE 连接时 streams 应为 0');
    assert.equal(res.indexed, true);
    assert.ok(res.filesIndexed > 0);
  } finally {
    await ctx.cleanup();
  }
});

test('dispose: 释放后 watcher 停 / 索引释放 / 注册保留，再次请求自动重建', async () => {
  const ctx = await boot();
  try {
    const target = path.join(ctx.root, 'src', 'util.ts');
    const before = await fsp.stat(target);
    const textBefore = await fsp.readFile(target, 'utf8');

    const res = await ctx.app.request(`/api/projects/${ctx.id}/dispose`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      stoppedWatcher: boolean;
      releasedIndex: boolean;
      kept: string;
      closedStreams: number;
    };
    assert.equal(body.ok, true);
    assert.equal(body.stoppedWatcher, true);
    assert.equal(body.releasedIndex, true);
    assert.equal(body.kept, 'registry', '注册表条目要保留，宿主不必重新注册');

    const after = await resourcesOf(ctx.app, ctx.id);
    assert.equal(after.watcher, false, 'watcher 应已停');
    assert.equal(after.indexed, false, '内存索引应已释放');
    assert.equal(after.filesIndexed, 0);

    // 注册表条目还在
    const list = (await (await ctx.app.request('/api/projects')).json()) as {
      projects: Array<{ id: string }>;
    };
    assert.ok(list.projects.some((p) => p.id === ctx.id));

    // 再次请求文件：正文照常读到，并在后台自动重建索引
    const file = await ctx.app.request(`/api/projects/${ctx.id}/file?path=src/util.ts`);
    assert.equal(file.status, 200);
    const fileBody = (await file.json()) as { text: string };
    assert.match(fileBody.text, /export function helper/);
    const rebuilt = await waitIndexed(ctx.app, ctx.id);
    assert.ok(rebuilt.filesIndexed > 0, '再次访问后索引应自行重建');

    // 只读承诺：磁盘文件的内容与 mtime 都没被碰过
    const afterStat = await fsp.stat(target);
    assert.equal(afterStat.mtimeMs, before.mtimeMs, 'dispose 不该改动被读目录里的文件');
    assert.equal(await fsp.readFile(target, 'utf8'), textBefore);
  } finally {
    await ctx.cleanup();
  }
});

test('dispose: 重复调用幂等，未注册项目 404', async () => {
  const ctx = await boot();
  try {
    for (const _ of [1, 2]) {
      const res = await ctx.app.request(`/api/projects/${ctx.id}/dispose`, { method: 'POST' });
      assert.equal(res.status, 200, '重复 dispose 不应报错');
      assert.equal(((await res.json()) as { ok: boolean }).ok, true);
    }

    const missing = await ctx.app.request('/api/projects/nope-dispose/dispose', { method: 'POST' });
    assert.equal(missing.status, 404);
    const missingRes = await ctx.app.request('/api/projects/nope-dispose/resources');
    assert.equal(missingRes.status, 404);
  } finally {
    await ctx.cleanup();
  }
});

test('dispose: 断开该项目的 SSE 连接（宿主收起面板不留连接）', async () => {
  const ctx = await boot();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const stream = await ctx.app.request(`/api/projects/${ctx.id}/events`);
    assert.equal(stream.status, 200);
    assert.ok(stream.body, 'SSE 应有响应体');
    reader = stream.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value ?? new Uint8Array()), /status/);

    // 连接已登记
    assert.equal((await resourcesOf(ctx.app, ctx.id)).streams, 1);

    const res = await ctx.app.request(`/api/projects/${ctx.id}/dispose`, { method: 'POST' });
    const body = (await res.json()) as { closedStreams: number };
    assert.equal(body.closedStreams, 1, 'dispose 应报告断掉了几个 SSE 连接');
    assert.equal((await resourcesOf(ctx.app, ctx.id)).streams, 0, '登记表应清空');
  } finally {
    // 显式取消读取端，避免测试进程被挂着的流拖住（不 await 读到 done，那样会死等）
    await reader?.cancel().catch(() => {});
    await ctx.cleanup();
  }
});

test('dispose: manifest 自述释放端点与生命周期约定', async () => {
  const ctx = await boot();
  try {
    const manifest = (await (await ctx.app.request('/api/integration/manifest')).json()) as {
      disposeEndpoint?: string;
      resourcesEndpoint?: string;
      lifecycleNote?: string;
      endpoints: Record<string, string>;
    };
    assert.equal(manifest.disposeEndpoint, 'POST /api/projects/:id/dispose');
    assert.equal(manifest.resourcesEndpoint, 'GET /api/projects/:id/resources');
    assert.match(manifest.lifecycleNote ?? '', /保留注册表条目/);
    assert.match(manifest.endpoints.dispose ?? '', /dispose/);
  } finally {
    await ctx.cleanup();
  }
});
