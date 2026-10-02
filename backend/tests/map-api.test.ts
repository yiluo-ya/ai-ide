/** 项目地图 /overview 端点的冒烟测试（用 app.request，走真实路由与序列化，不占端口）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { makeProject } from './helpers';
import { ProjectRegistry } from '../src/registry';
import { createApp } from '../src/api/routes';

const FILES = {
  'package.json': `${JSON.stringify({ name: 'map-demo', main: 'src/index.ts' }, null, 2)}\n`,
  'README.md': '# map demo\n\n用于冒烟测试的项目地图。\n',
  'src/util.ts': `export function helper(v: string): string {
  return v;
}
`,
  'src/index.ts': `import { helper } from './util';

export const out = helper('x');
`,
  'lib/wrap.ts': `import { helper } from '../src/util';

export const wrapped = helper('y');
`,
};

async function boot() {
  const fx = await makeProject(FILES);
  const dataDir = path.join(fx.root, '..', `wcr-map-${Date.now()}`);
  const registry = new ProjectRegistry(dataDir);
  const app = createApp(registry);
  const created = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: fx.root, name: 'map-demo' }),
  });
  const { project } = (await created.json()) as { project: { id: string } };
  const index = registry.get(project.id)!;
  for (let i = 0; i < 100 && index.status.indexing; i++) {
    await new Promise((r) => setTimeout(r, 30));
  }
  return {
    app,
    id: project.id,
    project: index,
    cleanup: async () => {
      registry.closeAll();
      await fx.cleanup();
      await fsp.rm(dataDir, { recursive: true, force: true });
    },
  };
}

test('api: /overview 返回身份卡与从哪看起', async () => {
  const ctx = await boot();
  try {
    const res = await ctx.app.request(`/api/projects/${ctx.id}/overview?hot=refs&denoise=0`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      identity: { files: number };
      meta: { kind: string; name: string | null };
      hotMetric: string;
      entries: Array<{ file: string }>;
      readme: { path: string } | null;
    };
    assert.equal(body.identity.files, 5);
    assert.equal(body.meta.kind, 'npm');
    assert.equal(body.meta.name, 'map-demo');
    assert.equal(body.hotMetric, 'refs', '口径参数应被透传给聚合层');
    assert.ok(body.entries.some((e) => e.file === 'src/index.ts'));
    assert.equal(body.readme?.path, 'README.md');
  } finally {
    await ctx.cleanup();
  }
});
