/**
 * 模型配置同步到 pi（FR-0013 需求 5）：合并规则、apiType 映射、保留他人条目、幂等、删除收敛。
 *
 * pi 的配置目录与「我们写过哪些 key」的账本都用环境变量指到临时目录，
 * 绝不碰开发机真实的 `~/.pi/agent`。
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { ModelConfig, ModelProvider } from '../src/agent/model-config';
import type { ApiType } from '../src/agent/types';

let dataDir = '';
let piDir = '';
let mod!: typeof import('../src/agent/pi-models');

before(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-pi-sync-data-'));
  piDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-pi-sync-agent-'));
  // 必须在导入前定好（config.ts 的 DATA_DIR 在模块加载时求值）
  process.env.READER_DATA_DIR = dataDir;
  process.env.READER_PI_AGENT_DIR = piDir;
  delete process.env.READER_PI_COMMAND;
  mod = await import('../src/agent/pi-models');
});

after(async () => {
  delete process.env.READER_DATA_DIR;
  delete process.env.READER_PI_AGENT_DIR;
  await fsp.rm(dataDir, { recursive: true, force: true });
  await fsp.rm(piDir, { recursive: true, force: true });
});

const modelsPath = () => path.join(piDir, 'models.json');
const authPath = () => path.join(piDir, 'auth.json');

const read = async (file: string): Promise<Record<string, unknown>> =>
  JSON.parse(await fsp.readFile(file, 'utf8')) as Record<string, unknown>;

async function clear(name: string): Promise<void> {
  await fsp.rm(path.join(piDir, name), { force: true });
}

const provider = (
  id: string,
  name: string,
  apiType: ApiType,
  baseUrl: string,
  apiKey: string,
  models: string[],
): ModelProvider => ({ id, name, apiType, baseUrl, apiKey, models });

const cfg = (...providers: ModelProvider[]): ModelConfig => ({ version: 1, providers });

test('写进 pi：baseUrl / api / models 进 models.json，key 进 auth.json，别人的条目原样保留', async () => {
  await clear('models.json');
  await clear('auth.json');
  await fsp.writeFile(
    modelsPath(),
    `${JSON.stringify(
      {
        providers: {
          openai: { baseUrl: 'https://api.openai.com/v1', api: 'openai-completions', models: [{ id: 'gpt-4o' }] },
        },
        modelOverrides: { 'gpt-4o': { name: 'GPT-4o' } },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await fsp.writeFile(authPath(), `${JSON.stringify({ anthropic: { type: 'api_key', key: 'sk-ant-x' } }, null, 2)}\n`, 'utf8');

  const out = await mod.syncModelsToPi(
    cfg(provider('p-deek', 'deek', 'openai', 'https://api.deepseek.com', 'sk-ds-1', ['deepseek-flash'])),
  );

  assert.equal(out.ok, true);
  assert.deepEqual(out.synced, ['deek']);
  assert.equal(out.changed, true);

  const models = await read(modelsPath());
  const providers = models.providers as Record<string, { baseUrl: string; api: string; models: { id: string }[] }>;
  assert.equal(providers.deek.baseUrl, 'https://api.deepseek.com');
  assert.equal(providers.deek.api, 'openai-completions');
  assert.deepEqual(providers.deek.models, [{ id: 'deepseek-flash' }]);
  // 别人的 provider / 顶层字段不动
  assert.deepEqual(providers.openai.models, [{ id: 'gpt-4o' }]);
  assert.deepEqual(models.modelOverrides, { 'gpt-4o': { name: 'GPT-4o' } });

  const auth = await read(authPath());
  assert.deepEqual(auth.deek, { type: 'api_key', key: 'sk-ds-1' });
  assert.deepEqual(auth.anthropic, { type: 'api_key', key: 'sk-ant-x' });
});

test('幂等：内容没变就不写盘（changed=false，文件字节不变）', async () => {
  const before = await fsp.readFile(modelsPath(), 'utf8');
  const out = await mod.syncModelsToPi(
    cfg(provider('p-deek', 'deek', 'openai', 'https://api.deepseek.com', 'sk-ds-1', ['deepseek-flash'])),
  );
  assert.equal(out.ok, true);
  assert.equal(out.changed, false);
  assert.equal(await fsp.readFile(modelsPath(), 'utf8'), before);
});

test('apiType → pi 的 api 取值', async () => {
  await clear('models.json');
  await clear('auth.json');
  const out = await mod.syncModelsToPi(
    cfg(
      provider('p-a', 'anthropic-custom', 'anthropic', 'https://api.anthropic.com', 'sk-a', ['claude-sonnet-4']),
      provider('p-b', 'responses-custom', 'openai-responses', 'https://api.openai.com/v1', 'sk-b', ['gpt-5']),
      provider('p-c', 'gemini-custom', 'gemini', 'https://generativelanguage.googleapis.com', 'sk-c', ['gemini-3']),
    ),
  );
  assert.equal(out.ok, true);
  const providers = (await read(modelsPath())).providers as Record<string, { api: string }>;
  assert.equal(providers['anthropic-custom'].api, 'anthropic-messages');
  assert.equal(providers['responses-custom'].api, 'openai-responses');
  assert.equal(providers['gemini-custom'].api, 'google-generative-ai');
});

test('provider 改名：key 不变（不在 pi 里留孤儿）', async () => {
  await clear('models.json');
  await clear('auth.json');
  // 先把账本清掉（前面的用例写过 p-deek 等），保证从零开始
  await fsp.rm(mod.piSyncManifestPath(), { force: true });

  await mod.syncModelsToPi(cfg(provider('p-1', 'deek', 'openai', 'https://api.deepseek.com', 'sk-1', ['m1'])));
  let providers = (await read(modelsPath())).providers as Record<string, unknown>;
  assert.deepEqual(Object.keys(providers), ['deek']);

  const out = await mod.syncModelsToPi(
    cfg(provider('p-1', 'deepseek 主号', 'openai', 'https://api.deepseek.com', 'sk-1', ['m1'])),
  );
  assert.deepEqual(out.synced, ['deek']);
  providers = (await read(modelsPath())).providers as Record<string, unknown>;
  assert.deepEqual(Object.keys(providers), ['deek']); // 名字变了，key 还是原来的
});

test('与 pi 已有条目撞名：换一个 key，绝不覆盖别人的', async () => {
  await clear('models.json');
  await clear('auth.json');
  await fsp.rm(mod.piSyncManifestPath(), { force: true });
  await fsp.writeFile(
    modelsPath(),
    `${JSON.stringify({ providers: { deek: { baseUrl: 'http://localhost:1234/v1', api: 'openai-completions', models: [{ id: 'local' }] } } }, null, 2)}\n`,
    'utf8',
  );

  const out = await mod.syncModelsToPi(cfg(provider('p-1', 'deek', 'openai', 'https://api.deepseek.com', 'sk-1', ['m1'])));
  assert.deepEqual(out.synced, ['deek-2']);
  const providers = (await read(modelsPath())).providers as Record<string, { baseUrl: string }>;
  assert.equal(providers.deek.baseUrl, 'http://localhost:1234/v1'); // 别人的原样
  assert.equal(providers['deek-2'].baseUrl, 'https://api.deepseek.com');
});

test('本项目删掉 provider：从 pi 摘掉那一条，别人的不动', async () => {
  await clear('models.json');
  await clear('auth.json');
  await fsp.rm(mod.piSyncManifestPath(), { force: true });
  await fsp.writeFile(authPath(), `${JSON.stringify({ keepme: { type: 'api_key', key: 'sk-keep' } }, null, 2)}\n`, 'utf8');

  await mod.syncModelsToPi(
    cfg(
      provider('p-1', 'deek', 'openai', 'https://api.deepseek.com', 'sk-1', ['m1']),
      provider('p-2', 'zhipu', 'openai', 'https://open.bigmodel.cn/api/paas/v4', 'sk-2', ['glm-5']),
    ),
  );
  const out = await mod.syncModelsToPi(cfg(provider('p-1', 'deek', 'openai', 'https://api.deepseek.com', 'sk-1', ['m1'])));

  assert.deepEqual(out.removed, ['zhipu']);
  const providers = (await read(modelsPath())).providers as Record<string, unknown>;
  assert.deepEqual(Object.keys(providers), ['deek']);
  const auth = await read(authPath());
  assert.equal('zhipu' in auth, false);
  assert.deepEqual(auth.keepme, { type: 'api_key', key: 'sk-keep' });
});

test('本项目一个 provider 都没有、也没同步过：不写盘（不在人家目录里造空文件）', async () => {
  await clear('models.json');
  await fsp.rm(mod.piSyncManifestPath(), { force: true });
  const out = await mod.syncModelsToPi(cfg());
  assert.equal(out.ok, true);
  assert.equal(out.changed, false);
  await assert.rejects(() => fsp.stat(modelsPath()), /ENOENT/);
});

test('没装 pi：给一句能照做的提示，不抛错', async () => {
  const realPath = process.env.PATH;
  const realDir = process.env.READER_PI_AGENT_DIR;
  // 没装 pi = 命令找不到，且它的配置目录也不存在
  process.env.PATH = '';
  process.env.READER_PI_AGENT_DIR = path.join(piDir, 'not-installed');
  try {
    const out = await mod.syncModelsToPi(
      cfg(provider('p-1', 'deek', 'openai', 'https://api.deepseek.com', 'sk-1', ['m1'])),
    );
    assert.equal(out.ok, false);
    assert.match(out.error ?? '', /没找到 pi/);
  } finally {
    process.env.PATH = realPath;
    if (realDir === undefined) delete process.env.READER_PI_AGENT_DIR;
    else process.env.READER_PI_AGENT_DIR = realDir;
  }
});
