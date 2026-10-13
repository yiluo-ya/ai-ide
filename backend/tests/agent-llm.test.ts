/**
 * LLM 协议分派 + 「测试连接」的测试（2026-10-13 加多 API 类型时补）。
 *
 * 每组用一个本地 http 端点：断言我们**发出去的 URL / 头 / body 形状**对不对，
 * 以及各家的 SSE 都能被解析成同一份归一化结果（文本 + 工具调用）。不碰真实 API。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { streamChat } from '../src/agent/llm';
import { joinApiUrl } from '../src/agent/llm-util';
import { probeLlm } from '../src/agent/probe';
import { createApp } from '../src/api/routes';
import { ProjectRegistry } from '../src/registry';
import { resetModelConfigCache } from '../src/agent/model-config';
import type { ChatMessage } from '../src/agent/openai';
import type { ToolDefinition } from '../src/agent/types';

interface Capture {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

/** 假端点：记下收到的请求，用脚本回响应（SSE 就拼 frame）。 */
function startServer(
  respond: (capture: Capture) => { status?: number; body: string },
): Promise<{ url: string; server: Server; seen: Capture[] }> {
  const seen: Capture[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const capture: Capture = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: JSON.parse(raw || '{}') as Record<string, unknown>,
      };
      seen.push(capture);
      const out = respond(capture);
      res.writeHead(out.status ?? 200, { 'content-type': 'text/event-stream' });
      res.end(out.body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, server, seen });
    });
  });
}

const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

const TOOL: ToolDefinition = {
  name: 'read_file',
  description: '读一个文件',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: '路径' } },
    required: ['path'],
    additionalProperties: false,
  },
};

const USER: ChatMessage[] = [{ role: 'user', content: 'hi' }];

test('llm/openai：走 /chat/completions，能解析文本与流式工具参数', async () => {
  const fake = await startServer(() => ({
    body:
      sse({ choices: [{ delta: { content: '你好' } }] }) +
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":' } }] } }] }) +
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } }] }) +
      'data: [DONE]\n\n',
  }));
  try {
    const result = await streamChat({
      apiType: 'openai',
      baseUrl: `${fake.url}/v1`,
      apiKey: 'sk-x',
      model: 'm1',
      messages: USER,
      tools: [TOOL],
    });
    assert.equal(result.text, '你好');
    assert.deepEqual(result.toolCalls, [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' }]);

    const sent = fake.seen[0]!;
    assert.equal(sent.method, 'POST');
    assert.equal(sent.url, '/v1/chat/completions');
    assert.equal(sent.headers.authorization, 'Bearer sk-x');
    assert.equal(sent.body.model, 'm1');
    assert.equal(sent.body.stream, true);
    assert.equal((sent.body.tools as Array<{ type: string }>)[0]?.type, 'function');
  } finally {
    fake.server.close();
  }
});

test('llm/anthropic：走 /v1/messages，system 上顶层、tool_result 并进 user 消息', async () => {
  const fake = await startServer(() => ({
    body:
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好的' } }) +
      sse({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' } }) +
      sse({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' } }) +
      sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
  }));
  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'ok',
        tool_calls: [
          { id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
          { id: 't2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.ts"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 't1', content: 'r1' },
      { role: 'tool', tool_call_id: 't2', content: 'r2' },
    ];
    const result = await streamChat({
      apiType: 'anthropic',
      baseUrl: fake.url,
      apiKey: 'sk-ant',
      model: 'claude-x',
      messages,
      tools: [TOOL],
    });
    assert.equal(result.text, '好的');
    assert.equal(result.finishReason, 'tool_use');
    assert.deepEqual(result.toolCalls, [{ id: 'toolu_1', name: 'read_file', arguments: '{"path":"a.ts"}' }]);

    const sent = fake.seen[0]!;
    assert.equal(sent.url, '/v1/messages');
    assert.equal(sent.headers['x-api-key'], 'sk-ant');
    assert.equal(sent.headers['anthropic-version'], '2023-06-01');
    assert.equal(sent.body.system, '你是助手', 'system 不进 messages，走顶层');
    assert.equal(typeof sent.body.max_tokens, 'number', 'max_tokens 必填');

    const sentMessages = sent.body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    assert.equal(sentMessages.length, 3, 'user / assistant / user(两个 tool_result)');
    assert.equal(sentMessages[1]!.content[1]!.type, 'tool_use');
    assert.deepEqual(sentMessages[1]!.content[1]!.input, { path: 'a.ts' });
    const toolResults = sentMessages[2]!.content;
    assert.equal(toolResults.length, 2, '两条 tool 结果并进同一条 user 消息');
    assert.deepEqual(
      toolResults.map((block) => block.tool_use_id),
      ['t1', 't2'],
    );

    const tools = sent.body.tools as Array<{ name: string; input_schema: Record<string, unknown> }>;
    assert.equal(tools[0]!.name, 'read_file');
    assert.ok(tools[0]!.input_schema, 'Anthropic 用 input_schema');
  } finally {
    fake.server.close();
  }
});

test('llm/openai-responses：走 /responses，工具用 call_id 回灌', async () => {
  const fake = await startServer(() => ({
    body:
      sse({ type: 'response.output_text.delta', delta: '嗨' }) +
      sse({
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'read_file', arguments: '' },
      }) +
      sse({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":"a.ts"}' }) +
      sse({ type: 'response.completed', response: { status: 'completed' } }),
  }));
  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'ok',
        tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_9', content: 'r1' },
    ];
    const result = await streamChat({
      apiType: 'openai-responses',
      baseUrl: `${fake.url}/v1`,
      apiKey: 'sk-x',
      model: 'gpt-5',
      messages,
      tools: [TOOL],
    });
    assert.equal(result.text, '嗨');
    assert.deepEqual(result.toolCalls, [{ id: 'call_9', name: 'read_file', arguments: '{"path":"a.ts"}' }]);

    const sent = fake.seen[0]!;
    assert.equal(sent.url, '/v1/responses');
    const input = sent.body.input as Array<Record<string, unknown>>;
    assert.deepEqual(input[0], { role: 'system', content: [{ type: 'input_text', text: 'sys' }] });
    assert.deepEqual(input[2], { role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] });
    assert.equal(input[3]!.type, 'function_call');
    assert.equal(input[3]!.call_id, 'call_9');
    assert.deepEqual(input[4], { type: 'function_call_output', call_id: 'call_9', output: 'r1' });
    const tools = sent.body.tools as Array<Record<string, unknown>>;
    assert.equal(tools[0]!.type, 'function', 'Responses 的工具是扁平形状');
    assert.equal(tools[0]!.name, 'read_file');
  } finally {
    fake.server.close();
  }
});

test('llm/gemini：走 :streamGenerateContent，system 走 systemInstruction、schema 剥掉不认的关键字', async () => {
  const fake = await startServer(() => ({
    body:
      sse({ candidates: [{ content: { parts: [{ text: '嘿' }] } }] }) +
      sse({ candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'a.ts' } } }] }, finishReason: 'STOP' }] }),
  }));
  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'ok',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
    ];
    const result = await streamChat({
      apiType: 'gemini',
      baseUrl: fake.url,
      apiKey: 'AIza-x',
      model: 'gemini-2.0-flash',
      messages,
      tools: [TOOL],
    });
    assert.equal(result.text, '嘿');
    assert.equal(result.finishReason, 'STOP');
    assert.equal(result.toolCalls[0]!.name, 'read_file');
    assert.deepEqual(JSON.parse(result.toolCalls[0]!.arguments), { path: 'a.ts' });

    const sent = fake.seen[0]!;
    assert.equal(sent.url, '/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=AIza-x');
    assert.deepEqual(sent.body.systemInstruction, { parts: [{ text: 'sys' }] });
    const contents = sent.body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    assert.deepEqual(
      contents.map((item) => item.role),
      ['user', 'model', 'user'],
    );
    assert.deepEqual(contents[2]!.parts[0]!.functionResponse, { name: 'read_file', response: { result: 'r1' } });
    const declarations = (sent.body.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>)[0]!
      .functionDeclarations;
    assert.equal(declarations[0]!.name, 'read_file');
    assert.equal(
      (declarations[0]!.parameters as Record<string, unknown>).additionalProperties,
      undefined,
      'Gemini 不认 additionalProperties，要剥掉',
    );
  } finally {
    fake.server.close();
  }
});

test('probe：200 摘出回复，401 摘出可读错误', async () => {
  const okServer = await startServer(() => ({
    body: JSON.stringify({ choices: [{ message: { content: 'pong' } }] }),
  }));
  const badServer = await startServer(() => ({
    status: 401,
    body: JSON.stringify({ error: { message: 'invalid api key' } }),
  }));
  try {
    const ok = await probeLlm({ apiType: 'openai', baseUrl: `${okServer.url}/v1`, apiKey: 'sk', modelId: 'm1' });
    assert.equal(ok.ok, true);
    assert.equal(ok.status, 200);
    assert.equal(ok.reply, 'pong');
    assert.equal(okServer.seen[0]!.url, '/v1/chat/completions');
    assert.equal(okServer.seen[0]!.body.stream, false, '测试走非流式，省 token');

    const bad = await probeLlm({ apiType: 'openai', baseUrl: `${badServer.url}/v1`, apiKey: 'sk-bad', modelId: 'm1' });
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 401);
    assert.match(bad.error ?? '', /invalid api key/);
  } finally {
    okServer.server.close();
    badServer.server.close();
  }
});

test('probe：anthropic / gemini 的地址与认证形状各自正确', async () => {
  const anthropic = await startServer(() => ({ body: JSON.stringify({ content: [{ type: 'text', text: 'pong' }] }) }));
  const gemini = await startServer(() => ({
    body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'pong' }] } }] }),
  }));
  try {
    const a = await probeLlm({ apiType: 'anthropic', baseUrl: anthropic.url, apiKey: 'sk-ant', modelId: 'claude-x' });
    assert.equal(a.ok, true);
    assert.equal(a.reply, 'pong');
    assert.equal(anthropic.seen[0]!.url, '/v1/messages');
    assert.equal(anthropic.seen[0]!.headers['x-api-key'], 'sk-ant');
    assert.equal(a.status, 200);

    const g = await probeLlm({ apiType: 'gemini', baseUrl: gemini.url, apiKey: 'AIza', modelId: 'gemini-2.0-flash' });
    assert.equal(g.ok, true);
    assert.equal(g.reply, 'pong');
    assert.equal(gemini.seen[0]!.url, '/v1beta/models/gemini-2.0-flash:generateContent?key=AIza');
  } finally {
    anthropic.server.close();
    gemini.server.close();
  }
});

test('joinApiUrl：baseUrl 已经带版本段时不重复拼', () => {
  assert.equal(joinApiUrl('https://api.openai.com/v1/', '/chat/completions'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(joinApiUrl('https://api.anthropic.com', '/v1/messages'), 'https://api.anthropic.com/v1/messages');
  assert.equal(joinApiUrl('https://api.anthropic.com/v1', '/v1/messages'), 'https://api.anthropic.com/v1/messages');
  assert.equal(
    joinApiUrl('https://generativelanguage.googleapis.com/v1beta', '/v1beta/models/x:generateContent'),
    'https://generativelanguage.googleapis.com/v1beta/models/x:generateContent',
  );
});

test('model-config 路由：apiType 能存能读，缺省与未知值都按 openai 算；测试连接用已存 key 兜底', async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-llm-data-'));
  process.env.READER_MODEL_CONFIG = path.join(dataDir, 'model-config.json');
  resetModelConfigCache();
  const registry = new ProjectRegistry(dataDir);
  const app = createApp(registry);
  const post = async (url: string, body: unknown) => {
    const res = await app.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const fake = await startServer(() => ({
    // 两种形状都带上：这一步只验「key 兜底」，与 apiType 无关
    body: JSON.stringify({ choices: [{ message: { content: 'pong' } }], content: [{ type: 'text', text: 'pong' }] }),
  }));
  try {
    // 1) 带 apiType 保存 → 回读一致
    const saved = await post('/api/agent/model-config', {
      name: 'claude',
      apiType: 'anthropic',
      baseUrl: fake.url,
      apiKey: 'sk-test-1234567890',
      models: ['claude-x'],
    });
    assert.equal(saved.status, 200);
    assert.equal((saved.body.provider as { apiType: string }).apiType, 'anthropic');

    // 2) 不带 apiType 保存 → 回落 openai 兼容
    const plain = await post('/api/agent/model-config', {
      name: 'plain',
      baseUrl: fake.url,
      apiKey: 'sk-test-1234567890',
      models: ['m1'],
    });
    assert.equal((plain.body.provider as { apiType: string }).apiType, 'openai');

    // 3) 未知 apiType → 也按 openai（不写坏配置）
    const weird = await post('/api/agent/model-config', {
      name: 'weird',
      apiType: 'telepathy',
      baseUrl: fake.url,
      apiKey: 'sk-test-1234567890',
      models: ['m1'],
    });
    assert.equal((weird.body.provider as { apiType: string }).apiType, 'openai');

    // 4) 测试连接：不传 apiKey 时用已保存 provider 的 key（编辑表单不回填 key 的场景）
    const providerId = (saved.body.provider as { id: string }).id;
    const tested = await post('/api/agent/model-config/test', {
      id: providerId,
      apiType: 'anthropic',
      baseUrl: fake.url,
      models: ['claude-x'],
    });
    assert.equal(tested.status, 200);
    assert.equal(tested.body.ok, true);
    const results = tested.body.results as Array<{ modelId: string; ok: boolean; status: number; reply?: string; ms: number }>;
    assert.equal(results.length, 1);
    assert.equal(results[0]!.modelId, 'claude-x');
    assert.equal(results[0]!.ok, true);
    assert.equal(results[0]!.status, 200);
    assert.equal(results[0]!.reply, 'pong');
    assert.equal(typeof results[0]!.ms, 'number');

    // 5) 没有 key、也没有可回退的 id → 400 且给出理由
    const noKey = await post('/api/agent/model-config/test', { baseUrl: fake.url, models: ['m1'] });
    assert.equal(noKey.status, 400);
    assert.match(String(noKey.body.message), /API key/);
  } finally {
    fake.server.close();
    registry.closeAll();
    await fsp.rm(dataDir, { recursive: true, force: true });
    delete process.env.READER_MODEL_CONFIG;
    resetModelConfigCache();
  }
});
