/**
 * 04 W1：首屏起步的原料 —— 四条阅读路线的关键顺序、文件级结构性摘要的数值，
 * 以及 `GET /routes` / `GET /file-summary` 的 200 / 400 / 404。
 *
 * 夹具依赖关系：
 *   main.ts → a.ts、b.ts → util.ts（helper 被 a / b 各引用一次）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { makeProject, locate } from './helpers';
import { buildRoutes } from '../src/indexer/guide';
import { fileSummary } from '../src/indexer/summary';
import { ProjectRegistry } from '../src/registry';
import { createApp } from '../src/api/routes';

const FILES = {
  'src/util.ts': 'export function helper(v: string): string {\n  return v;\n}\n',
  'src/a.ts': "import { helper } from './util';\n\nexport const a = helper('a');\n",
  'src/b.ts': "import { helper } from './util';\n\nexport const b = helper('b');\n",
  'src/main.ts': "import { a } from './a';\nimport { b } from './b';\n\nconsole.log(a, b);\n",
};

test('guide-w1: 四条路线的关键顺序（entry / hot / fresh）', async () => {
  const fx = await makeProject(FILES);
  try {
    // 给新鲜度序一个确定答案：main 最新 → util 最旧
    const base = Date.now() - 10 * 60_000;
    const stamp = async (file: string, offset: number) => {
      const at = new Date(base + offset);
      await fsp.utimes(path.join(fx.root, ...file.split('/')), at, at);
    };
    await stamp('src/util.ts', 1000);
    await stamp('src/b.ts', 2000);
    await stamp('src/a.ts', 3000);
    await stamp('src/main.ts', 4000);
    await fx.project.reindexAll();

    const routes = buildRoutes(fx.project);
    const routeOf = (kind: string) => {
      const hit = routes.routes.find((r) => r.kind === kind);
      assert.ok(hit, `缺少 ${kind} 路线`);
      return hit;
    };

    const entry = routeOf('entry');
    assert.equal(entry.steps[0].file, 'src/main.ts', '入口向下从 main.ts 开始');

    const hot = routeOf('hot');
    assert.deepEqual(
      hot.steps.map((s) => s.file),
      ['src/util.ts', 'src/a.ts', 'src/b.ts', 'src/main.ts'],
      '热度序按被引用数降序（同为 1 的按文件名升序）',
    );
    assert.match(hot.steps[0].reason, /被 2 个文件引用/);

    const fresh = routeOf('fresh');
    assert.deepEqual(
      fresh.steps.map((s) => s.file),
      ['src/main.ts', 'src/a.ts', 'src/b.ts', 'src/util.ts'],
      '新鲜度序按 mtimeMs 降序',
    );

    assert.equal(routeOf('dep').steps.length, 4);
    assert.equal(routes.sourceFiles, 4, '分母排除测试与文档 / 配置');
    assert.equal(routes.partial, false);
  } finally {
    await fx.cleanup();
  }
});

test('guide-w1: fileSummary 的 exports / imports / inbound / sentence 数值', async () => {
  const fx = await makeProject(FILES);
  try {
    const helperLine = locate(fx.project, 'src/util.ts', 'helper');
    const util = fileSummary(fx.project, 'src/util.ts');
    assert.ok(util, 'util.ts 应能出摘要');
    assert.deepEqual(
      util.exports.map((e) => [e.name, e.kind, e.line]),
      [['helper', 'function', helperLine.line]],
    );
    assert.deepEqual(util.imports, { project: 0, external: 0 });
    assert.equal(util.inbound.files.length, 2, 'a.ts 与 b.ts 各引用 util 一次');
    assert.deepEqual(
      util.inbound.files.map((f) => f.file).sort(),
      ['src/a.ts', 'src/b.ts'],
    );
    assert.equal(util.inbound.tests, 0);
    assert.equal(util.inbound.total, 4, '每条 import + 每处 helper 调用各算 1');
    assert.match(util.sentence, /导出 1 个符号（1 函数）/);
    assert.match(util.sentence, /不依赖其它模块/);
    assert.match(util.sentence, /被 4 处引用/);

    const main = fileSummary(fx.project, 'src/main.ts');
    assert.ok(main, 'main.ts 应能出摘要');
    assert.equal(main.imports.project, 2);
    assert.equal(main.imports.external, 0);
    assert.equal(main.exports.length, 0, 'main.ts 只有调用，没有顶层导出');

    assert.equal(fileSummary(fx.project, 'src/nope.ts'), null, '不存在的文件返回 null');
    assert.equal(fileSummary(fx.project, 'README.md'), null, '非源码文件返回 null');
  } finally {
    await fx.cleanup();
  }
});

test('guide-w1: /routes 与 /file-summary 端点（200 / 400 / 404）', async () => {
  const fx = await makeProject(FILES);
  const dataDir = path.join(fx.root, '..', `wcr-guide-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const registry = new ProjectRegistry(dataDir);
  const app = createApp(registry);
  try {
    const created = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: fx.root, name: 'guide-demo' }),
    });
    assert.equal(created.status, 201);
    const { project } = (await created.json()) as { project: { id: string } };
    const index = registry.get(project.id)!;
    for (let i = 0; i < 100 && index.status.indexing; i++) {
      await new Promise((r) => setTimeout(r, 30));
    }

    const routesRes = await app.request(`/api/projects/${project.id}/routes`);
    assert.equal(routesRes.status, 200);
    const routesBody = (await routesRes.json()) as { routes: Array<{ kind: string }>; sourceFiles: number };
    assert.equal(routesBody.routes.length, 4);
    assert.deepEqual(
      routesBody.routes.map((r) => r.kind),
      ['dep', 'entry', 'hot', 'fresh'],
    );

    const okRes = await app.request(`/api/projects/${project.id}/file-summary?file=src/util.ts`);
    assert.equal(okRes.status, 200);
    const summary = (await okRes.json()) as { sentence: string };
    assert.match(summary.sentence, /导出 1 个符号/);

    const badRes = await app.request(`/api/projects/${project.id}/file-summary`);
    assert.equal(badRes.status, 400, '缺 file → 400');

    const escapeRes = await app.request(
      `/api/projects/${project.id}/file-summary?file=${encodeURIComponent('../outside.ts')}`,
    );
    assert.equal(escapeRes.status, 400, '路径越界 → 400');

    const missingRes = await app.request(`/api/projects/${project.id}/file-summary?file=src/nope.ts`);
    assert.equal(missingRes.status, 404, '不在符号索引内的文件 → 404');
  } finally {
    registry.closeAll();
    await fx.cleanup();
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});
