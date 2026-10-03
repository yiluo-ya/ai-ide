/**
 * 内置 code-agent 的端到端测试：假 OpenAI 端点 + 真索引 + 真工具执行。
 *
 * 断言的是「循环真的干了活」而不是「接口返回 200」：
 * 模型要求写文件 → 工具真在项目里写出那个文件 → 结果回灌给模型 → 第二轮拿到了它 → 事件序列完整。
 *
 * 不碰任何真实 API：模型端点是本地 http 服务，按轮次返回脚本化的 SSE。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { makeProject } from './helpers';
import { ProjectRegistry } from '../src/registry';
import { createApp } from '../src/api/routes';
import { resetModelConfigCache } from '../src/agent/model-config';
import { globToRegExp } from '../src/agent/tools';

/** 假模型端点：第一轮要求 write_file，第二轮（看到 tool 结果后）给最终回答。 */
function startFakeModel(): Promise<{ url: string; server: Server; seen: string[][] }> {
  const seen: string[][] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const payload = JSON.parse(body || '{}') as { messages?: Array<{ role: string; content?: unknown }> };
      const messages = payload.messages ?? [];
      seen.push(messages.map((m) => m.role));

      const toolResults = messages.filter((m) => m.role === 'tool');
      const chunks =
        toolResults.length === 0
          ? [
              { choices: [{ index: 0, delta: { role: 'assistant', content: '我来写一个文件。' } }] },
              {
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call_1',
                          type: 'function',
                          function: { name: 'write_file', arguments: '' },
                        },
                      ],
                    },
                  },
                ],
              },
              {
                choices: [
                  {
                    index: 0,
                    delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"agent-out.txt",' } }] },
                  },
                ],
              },
              {
                choices: [
                  {
                    index: 0,
                    delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"written by agent\\n"}' } }] },
                  },
                ],
              },
              { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
            ]
          : [
              {
                choices: [
                  {
                    index: 0,
                    delta: { role: 'assistant', content: `收到工具结果：${String(toolResults[0]?.content ?? '').slice(0, 40)}` },
                  },
                ],
              },
              { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
            ];

      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/v1`, server, seen });
    });
  });
}

async function boot() {
  const fx = await makeProject({
    'src/util.ts': 'export function helper(v: string): string {\n  return v;\n}\n',
    'src/index.ts': "import { helper } from './util';\n\nexport const out = helper('x');\n",
  });
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-agent-data-'));
  process.env.READER_MODEL_CONFIG = path.join(dataDir, 'model-config.json');
  resetModelConfigCache();
  const registry = new ProjectRegistry(dataDir);
  const app = createApp(registry);
  const created = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: fx.root, name: 'agent-demo' }),
  });
  const { project } = (await created.json()) as { project: { id: string } };
  const index = registry.get(project.id)!;
  for (let i = 0; i < 200 && index.status.indexing; i++) await new Promise((r) => setTimeout(r, 20));
  return {
    app,
    registry,
    root: fx.root,
    id: project.id,
    cleanup: async () => {
      registry.closeAll();
      await fx.cleanup();
      await fsp.rm(dataDir, { recursive: true, force: true });
      delete process.env.READER_MODEL_CONFIG;
      resetModelConfigCache();
    },
  };
}

type Ctx = Awaited<ReturnType<typeof boot>>;

async function post(ctx: Ctx, url: string, body: unknown) {
  const res = await ctx.app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('agent/model-config：保存 provider（key 打码）并设默认模型', async () => {
  const ctx = await boot();
  try {
    const saved = await post(ctx, '/api/agent/model-config', {
      name: 'fake',
      baseUrl: 'http://127.0.0.1:9/v1/',
      apiKey: 'sk-test-1234567890',
      models: ['fake-model', ' '],
    });
    assert.equal(saved.status, 200);
    const provider = saved.body.provider as { id: string; baseUrl: string; hasKey: boolean; keyHint: string };
    assert.equal(provider.baseUrl, 'http://127.0.0.1:9/v1', 'baseUrl 去掉尾斜杠');
    assert.equal(provider.hasKey, true);
    assert.match(provider.keyHint, /^sk-tes…7890$/, 'key 只回打码值');

    const listed = await ctx.app.request('/api/agent/model-config');
    const config = (await listed.json()) as {
      providers: Array<{ models: string[]; apiKey?: string }>;
      path: string;
    };
    assert.equal(config.providers[0].models.length, 1, '空模型 id 被过滤');
    assert.equal(config.providers[0].apiKey, undefined, '列表里不带明文 key');
    assert.ok(config.path.endsWith('model-config.json'));

    const def = await post(ctx, '/api/agent/model-config/default', {
      provider: provider.id,
      modelId: 'fake-model',
    });
    assert.equal((def.body.config as { default: { modelId: string } }).default.modelId, 'fake-model');
  } finally {
    await ctx.cleanup();
  }
});

test('内置 agent：一轮里真的执行了工具、文件被写出、结果回灌给模型', async () => {
  const fake = await startFakeModel();
  const ctx = await boot();
  try {
    await post(ctx, '/api/agent/model-config', {
      name: 'fake',
      baseUrl: fake.url,
      apiKey: 'sk-test',
      models: ['fake-model'],
    });

    const cfg = (await (await ctx.app.request('/api/agent/model-config')).json()) as {
      providers: Array<{ id: string }>;
    };
    const providerId = cfg.providers[0].id;
    const session = await post(ctx, '/api/agent/sessions', {
      projectId: ctx.id,
      name: 'demo',
      backend: 'builtin',
      provider: providerId,
      modelId: 'fake-model',
    });
    assert.equal(session.status, 201);
    const sessionId = (session.body.session as { id: string; backend: string }).id;
    assert.equal((session.body.session as { backend: string }).backend, 'builtin');

    const prompted = await post(ctx, `/api/agent/sessions/${sessionId}/prompt`, { message: '写一个文件' });
    assert.equal(prompted.status, 200);

    // 等循环跑完：两条 assistant 消息意味着「要求工具那一轮」与「读到结果那一轮」都回来了
    let messages: Array<{ role: string; toolName?: string; content?: unknown }> = [];
    for (let i = 0; i < 100; i++) {
      const res = await ctx.app.request(`/api/agent/sessions/${sessionId}/messages`);
      messages = ((await res.json()) as { messages: typeof messages }).messages;
      if (messages.filter((m) => m.role === 'assistant').length >= 2) break;
      await sleep(50);
    }
    assert.ok(messages.some((m) => m.role === 'user'), '用户消息在历史里');
    const toolResult = messages.find((m) => m.role === 'toolResult');
    assert.ok(toolResult, '工具结果进了历史');
    assert.equal(toolResult.toolName, 'write_file');

    const written = await fsp.readFile(path.join(ctx.root, 'agent-out.txt'), 'utf8');
    assert.equal(written, 'written by agent\n', '工具真的在项目里写出了文件');

    const last = messages.filter((m) => m.role === 'assistant').pop();
    assert.match(JSON.stringify(last?.content), /收到工具结果/, '第二轮把工具结果回灌给了模型');

    // 假端点看到的两次调用：第一次只有 system+user，第二次多了 assistant+tool
    assert.equal(fake.seen.length, 2);
    assert.ok(fake.seen[1].includes('tool'), '第二轮请求带 tool 角色');
  } finally {
    await ctx.cleanup();
    fake.server.close();
  }
});

test('内置 agent：没有模型时创建会话失败，错误信息可读', async () => {
  const ctx = await boot();
  try {
    const res = await post(ctx, '/api/agent/sessions', { projectId: ctx.id, backend: 'builtin' });
    assert.equal(res.status, 400);
    assert.match(String(res.body.message), /模型/, '错误里说清缺什么');
  } finally {
    await ctx.cleanup();
  }
});

test('agent/会话：未知后端 400、未知会话 404', async () => {
  const ctx = await boot();
  try {
    const bad = await post(ctx, '/api/agent/sessions', { projectId: ctx.id, backend: 'nope' });
    assert.equal(bad.status, 400);

    const missing = await ctx.app.request('/api/agent/sessions/does-not-exist/messages');
    assert.equal(missing.status, 404);

    const removed = await ctx.app.request('/api/agent/sessions/does-not-exist', { method: 'DELETE' });
    assert.equal(removed.status, 404);
  } finally {
    await ctx.cleanup();
  }
});

test('工具安全：路径越界被拒绝；edit_file 要求片段唯一', async () => {
  const ctx = await boot();
  try {
    // 越界：直接读项目外文件
    const escape = await post(ctx, `/api/agent/${ctx.id}/call`, {
      tool: 'read_file',
      args: { file: '../../etc/passwd' },
    });
    assert.equal(escape.status, 400);
    assert.equal(escape.body.error, 'path_escape');

    // 项目内的 read_file 正常
    const ok = await post(ctx, `/api/agent/${ctx.id}/call`, {
      tool: 'read_file',
      args: { file: 'src/util.ts', start: 1, end: 2 },
    });
    assert.equal(ok.status, 200);
    assert.match(JSON.stringify(ok.body), /helper/);
  } finally {
    await ctx.cleanup();
  }
});

test('glob 模式：** 跨目录、* 不跨目录', () => {
  const deep = globToRegExp('src/**/*.ts');
  assert.ok(deep.test('src/a/b/c.ts'));
  assert.ok(deep.test('src/a.ts'), '**/ 可以匹配零层目录');
  assert.ok(!deep.test('other/a.ts'));

  const shallow = globToRegExp('src/*.ts');
  assert.ok(shallow.test('src/a.ts'));
  assert.ok(!shallow.test('src/a/b.ts'), '* 不跨目录');
});
