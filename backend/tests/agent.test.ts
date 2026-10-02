/** S8 agent 工具端点冒烟测试：find_symbol 按名字查定义（kind 过滤 / limit）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { makeProject } from './helpers';
import { ProjectRegistry } from '../src/registry';
import { createApp } from '../src/api/routes';

const FILES = {
  'src/util.ts': `export function helper(v: string): string {
  return v;
}
`,
  'src/index.ts': `import { helper } from './util';

export const out = helper('x');
export const odd = missing('y');
`,
  'tests/util.test.ts': `import { helper } from '../src/util';

export const t = helper('t');
`,
  'src/big.ts': `${Array.from({ length: 500 }, (_, i) => `export const v${i} = ${i};`).join('\n')}\n`,
};

async function boot() {
  const fx = await makeProject(FILES);
  const dataDir = path.join(fx.root, '..', `wcr-agent-${Date.now()}`);
  const registry = new ProjectRegistry(dataDir);
  const app = createApp(registry);
  const created = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: fx.root, name: 'agent-demo' }),
  });
  const { project } = (await created.json()) as { project: { id: string } };
  const index = registry.get(project.id)!;
  for (let i = 0; i < 200 && index.status.indexing; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return {
    app,
    registry,
    id: project.id,
    project: index,
    cleanup: async () => {
      registry.closeAll();
      await fx.cleanup();
      await fsp.rm(dataDir, { recursive: true, force: true });
    },
  };
}

type Ctx = Awaited<ReturnType<typeof boot>>;

async function call(ctx: Ctx, tool: string, args: Record<string, unknown>, id = ctx.id) {
  const res = await ctx.app.request(`/api/agent/${id}/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool, args }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test('agent: find_symbol 按名字查定义，支持 kind 过滤与 limit', async () => {
  const ctx = await boot();
  try {
    const out = await call(ctx, 'find_symbol', { name: 'helper' });
    assert.equal(out.status, 200);
    const symbols = out.body.symbols as Array<{
      file: string;
      line: number;
      col: number;
      name: string;
      kind: string;
      container: string | null;
      reason: string;
    }>;
    const hit = symbols.find((s) => s.file === 'src/util.ts');
    assert.ok(hit, '应命中 src/util.ts 的 helper');
    assert.equal(hit.line, 1);
    assert.equal(hit.col, 17, '列按 1-based UTF-16');
    assert.equal(hit.kind, 'function');
    assert.equal(hit.reason, 'resolved');

    const filtered = await call(ctx, 'find_symbol', { name: 'helper', kind: 'class' });
    assert.equal((filtered.body.symbols as unknown[]).length, 0, 'kind 过滤应生效');

    const limited = await call(ctx, 'find_symbol', { name: 'v1', limit: 1 });
    assert.ok((limited.body.symbols as unknown[]).length <= 1, 'limit 应生效');

    // 便捷 GET 入口与 call 走同一实现
    const viaGet = await ctx.app.request(`/api/agent/${ctx.id}/symbols?q=helper&kind=function`);
    assert.equal(viaGet.status, 200);
    const viaGetBody = (await viaGet.json()) as { symbols: Array<{ file: string; name: string }> };
    assert.ok(viaGetBody.symbols.some((s) => s.file === 'src/util.ts' && s.name === 'helper'));

    const missing = await call(ctx, 'find_symbol', {});
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, 'bad_request');
  } finally {
    await ctx.cleanup();
  }
});
