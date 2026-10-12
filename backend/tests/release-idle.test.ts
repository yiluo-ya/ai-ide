/** 内存索引自动回收：空闲释放 / 活跃上限淘汰 / SSE 持有保护（2026-10-12）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { makeProject } from './helpers';
import { ProjectRegistry, type RegistryOptions } from '../src/registry';
import { createApp } from '../src/api/routes';

const FILES = {
  'src/a.ts': `export function a(): number {
  return 1;
}
`,
  'src/b.ts': 'export const b = 2;\n',
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

type App = ReturnType<typeof createApp>;

async function waitIndexed(app: App, id: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const res = await app.request(`/api/projects/${id}/status`);
    const { status } = (await res.json()) as { status: { indexing: boolean; filesIndexed: number } };
    if (!status.indexing && status.filesIndexed > 0) return;
    await delay(20);
  }
  throw new Error('index timeout');
}

/** 走 /resources（内部是 peek，不刷新访问时间），只看内存占用。 */
async function resourcesOf(app: App, id: string) {
  const res = await app.request(`/api/projects/${id}/resources`);
  assert.equal(res.status, 200);
  return (await res.json()) as { indexed: boolean; filesIndexed: number; watcher: boolean; streams: number };
}

/** 造一个注册表并打开 count 个项目（名字 one/two），返回它们的 id。 */
async function boot(opts: RegistryOptions, count: 1 | 2) {
  const fixtures = [await makeProject(FILES)];
  if (count === 2) fixtures.push(await makeProject(FILES));
  const dataDir = path.join(fixtures[0].root, '..', `wcr-release-${Date.now()}`);
  const registry = new ProjectRegistry(dataDir, opts);
  const app = createApp(registry);
  const ids: string[] = [];
  for (const [i, fx] of fixtures.entries()) {
    const res = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: fx.root, name: i === 0 ? 'one' : 'two' }),
    });
    const { project } = (await res.json()) as { project: { id: string } };
    await waitIndexed(app, project.id);
    ids.push(project.id);
  }
  return {
    app,
    registry,
    ids,
    cleanup: async () => {
      registry.closeAll();
      for (const fx of fixtures) await fx.cleanup();
      await fsp.rm(dataDir, { recursive: true, force: true });
    },
  };
}

test('自动回收: 空闲超过阈值后释放内存索引，注册表条目保留、再访问可重建', async () => {
  const ctx = await boot({ idleReleaseMs: 60, sweepMs: 10, maxActiveProjects: 0 }, 1);
  try {
    assert.equal((await resourcesOf(ctx.app, ctx.ids[0])).indexed, true);
    await delay(250);
    const after = await resourcesOf(ctx.app, ctx.ids[0]);
    assert.equal(after.indexed, false, '空闲超时后索引应被释放');
    assert.equal(after.filesIndexed, 0);
    assert.equal(after.watcher, false, 'watcher 也一并停掉');

    // 注册表条目还在（宿主不必重新注册），再次请求文件即后台重建
    const list = (await (await ctx.app.request('/api/projects')).json()) as { projects: Array<{ id: string }> };
    assert.ok(list.projects.some((p) => p.id === ctx.ids[0]));
    await ctx.app.request(`/api/projects/${ctx.ids[0]}/file?path=src/a.ts`);
    await waitIndexed(ctx.app, ctx.ids[0]);
    assert.equal((await resourcesOf(ctx.app, ctx.ids[0])).indexed, true, '再次访问应自动重建索引');
  } finally {
    await ctx.cleanup();
  }
});

test('自动回收: 活跃项目数超上限时，淘汰最久未访问的那个', async () => {
  const ctx = await boot({ maxActiveProjects: 1, idleReleaseMs: 0, sweepMs: 10 }, 2);
  try {
    await delay(250);
    const first = await resourcesOf(ctx.app, ctx.ids[0]);
    const second = await resourcesOf(ctx.app, ctx.ids[1]);
    assert.equal(first.indexed, false, '最近访问之外的最旧项目应被淘汰');
    assert.equal(second.indexed, true, '最近访问的项目要留着');
  } finally {
    await ctx.cleanup();
  }
});

test('自动回收: 有活跃 SSE 连接的项目不被释放，流关闭后解除持有', async () => {
  const ctx = await boot({ idleReleaseMs: 40, sweepMs: 10, maxActiveProjects: 0 }, 1);
  const stream = await ctx.app.request(`/api/projects/${ctx.ids[0]}/events`);
  const reader = stream.body!.getReader();
  try {
    await reader.read(); // 等首帧，确认连接已建立并登记
    assert.equal((await resourcesOf(ctx.app, ctx.ids[0])).streams, 1);
    // 远超空闲阈值：有连接在，索引不该被回收
    await delay(200);
    assert.equal((await resourcesOf(ctx.app, ctx.ids[0])).indexed, true, '有 SSE 连接时不应释放');

    // 走真实关流路径（dispose 会 close 该项目的 SSE）：关闭后应解除持有，
    // 于是重建的索引在空闲超时后能再次被回收。
    await ctx.app.request(`/api/projects/${ctx.ids[0]}/dispose`, { method: 'POST' });
    await delay(100);
    assert.equal((await resourcesOf(ctx.app, ctx.ids[0])).streams, 0, 'dispose 后流应已关闭并解除持有');
    await ctx.app.request(`/api/projects/${ctx.ids[0]}/file?path=src/a.ts`);
    await waitIndexed(ctx.app, ctx.ids[0]);
    await delay(250);
    assert.equal((await resourcesOf(ctx.app, ctx.ids[0])).indexed, false, '无持有残留时应恢复可回收');
  } finally {
    await reader.cancel().catch(() => {});
    await ctx.cleanup();
  }
});
