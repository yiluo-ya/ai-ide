/**
 * 会话落盘与续传（FR-0013 需求 4）：重启后仍能列出、消息还在、能接着聊。
 *
 * 「重启」在这里 = 丢掉内存里的 `AgentSessions`，换一个新实例 —— 磁盘不动。
 * pi 那条链路的续传靠 pi 自己的会话文件（真机验收），这里验内置 agent 的回填与记录本身。
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { makeProject, type Fixture } from './helpers';

let dataDir = '';
let sesDir = '';
let fixture: Fixture;
let registry!: import('../src/registry').ProjectRegistry;
let sessionsMod!: typeof import('../src/agent/sessions');
let projectId = '';

before(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-resume-data-'));
  sesDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-resume-sessions-'));
  process.env.READER_DATA_DIR = dataDir;
  process.env.READER_SESSION_DIR = sesDir;
  process.env.READER_MODEL_CONFIG = path.join(dataDir, 'model-config.json');
  await fsp.writeFile(
    process.env.READER_MODEL_CONFIG,
    `${JSON.stringify(
      {
        version: 1,
        providers: [
          {
            id: 'p-1',
            name: 'fake',
            apiType: 'openai',
            baseUrl: 'http://127.0.0.1:9/v1',
            apiKey: 'sk-fake',
            models: ['m-1'],
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  fixture = await makeProject({ 'a.ts': 'export const a = 1;\n' });
  const { ProjectRegistry } = await import('../src/registry');
  const { resetModelConfigCache } = await import('../src/agent/model-config');
  resetModelConfigCache();
  sessionsMod = await import('../src/agent/sessions');
  registry = new ProjectRegistry(dataDir);
  await registry.load();
  const opened = await registry.open(fixture.root, 'demo');
  projectId = opened.project.id;
});

after(async () => {
  registry.closeAll();
  await fixture.cleanup();
  await fsp.rm(dataDir, { recursive: true, force: true });
  await fsp.rm(sesDir, { recursive: true, force: true });
  delete process.env.READER_DATA_DIR;
  delete process.env.READER_SESSION_DIR;
  delete process.env.READER_MODEL_CONFIG;
});

test('新建会话落盘到 <sessions>/<projectId>/<id>.json；被读的项目目录保持干净', async () => {
  const sessions = new sessionsMod.AgentSessions(registry);
  const created = await sessions.create({ projectId, backend: 'builtin', provider: 'p-1', modelId: 'm-1' });
  assert.equal(created.loaded, true);
  assert.equal(created.backend, 'builtin');

  const file = path.join(sesDir, projectId, `${created.id}.json`);
  const record = JSON.parse(await fsp.readFile(file, 'utf8')) as Record<string, unknown>;
  assert.equal(record.backend, 'builtin');
  assert.equal(record.projectId, projectId);
  assert.equal(record.modelId, 'm-1');

  // 会话记录不写进被读的项目（沿用「不把状态写进被阅读的仓库」的口径）
  assert.deepEqual((await fsp.readdir(fixture.root)).sort(), ['a.ts']);
  sessions.closeAll();
});

test('重启后：新实例仍能列出这条会话（loaded=false），resume 后可用且幂等', async () => {
  const sessions = new sessionsMod.AgentSessions(registry);
  const created = await sessions.create({ projectId, backend: 'builtin', provider: 'p-1', modelId: 'm-1' });
  sessions.closeAll(); // 模拟进程退出：内存里的会话全部释放

  const restarted = new sessionsMod.AgentSessions(registry);
  const archived = (await restarted.list()).find((s) => s.id === created.id);
  assert.ok(archived, '重启后会话应该还在列表里');
  assert.equal(archived.loaded, false);
  assert.equal(archived.alive, false);

  const resumed = await restarted.resume(created.id);
  assert.equal(resumed.loaded, true);
  assert.equal(restarted.has(created.id), true);
  // 幂等：再 resume 一次不会重建（也不报错）
  const again = await restarted.resume(created.id);
  assert.equal(again.id, created.id);

  assert.equal(await restarted.remove(created.id), true);
  await assert.rejects(() => fsp.stat(path.join(sesDir, projectId, `${created.id}.json`)), /ENOENT/);
  assert.equal((await restarted.list()).some((s) => s.id === created.id), false);
  restarted.closeAll();
});

test('内置 agent 的历史从磁盘回填：续传后消息还在（能接着聊）', async () => {
  const id = 's-restore';
  const file = path.join(sesDir, projectId, `${id}.json`);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(
    file,
    `${JSON.stringify(
      {
        version: 1,
        id,
        name: '带历史的会话',
        projectId,
        backend: 'builtin',
        createdAt: 100,
        updatedAt: 200,
        provider: 'p-1',
        modelId: 'm-1',
        messageCount: 2,
        messages: [
          { role: 'user', content: '你好', timestamp: 1 },
          { role: 'assistant', content: [{ type: 'text', text: '在的' }], timestamp: 2 },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const sessions = new sessionsMod.AgentSessions(registry);
  // 未 resume 时直接从磁盘读（列表点开前的兜底）
  assert.equal(((await sessions.messages(id)) as unknown[]).length, 2);

  await sessions.resume(id);
  const messages = (await sessions.messages(id)) as Array<Record<string, unknown>>;
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, '你好');
  sessions.closeAll();
});
