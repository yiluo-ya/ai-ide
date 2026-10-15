/**
 * 会话记录的落盘 / 读回 / 列举 / 删除（FR-0013 需求 4）。
 *
 * 落盘目录用 `READER_SESSION_DIR` 指到临时目录（与 `READER_DATA_DIR` 同一种覆盖手法）。
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import {
  findStored,
  listStored,
  piSessionDir,
  projectSessionsDir,
  readSession,
  removeSession,
  sessionFile,
  writeSession,
  type StoredSession,
} from '../src/agent/session-store';

let root = '';

before(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-session-store-'));
  process.env.READER_SESSION_DIR = root;
});

after(async () => {
  delete process.env.READER_SESSION_DIR;
  await fsp.rm(root, { recursive: true, force: true });
});

const record = (over: Partial<StoredSession> & { id: string; projectId: string }): StoredSession => ({
  version: 1,
  name: over.id,
  backend: 'builtin',
  createdAt: 1,
  updatedAt: 1,
  messageCount: 0,
  ...over,
});

test('写 / 读 / 按项目列举：落在 <root>/sessions/<projectId>/<id>.json', async () => {
  const rec = record({
    id: 's-1',
    projectId: 'p-1',
    name: '第一条',
    createdAt: 10,
    messages: [{ role: 'user', content: '你好' }],
    messageCount: 1,
  });
  await writeSession(rec);

  assert.equal(sessionFile('p-1', 's-1'), path.join(projectSessionsDir('p-1'), 's-1.json'));
  const back = await readSession('p-1', 's-1');
  assert.equal(back?.name, '第一条');
  assert.deepEqual(back?.messages, [{ role: 'user', content: '你好' }]);

  // 只给 id 也能找到（路由手上只有 id）
  assert.equal((await findStored('s-1'))?.projectId, 'p-1');

  await writeSession(record({ id: 's-2', projectId: 'p-1', createdAt: 20, name: '第二条' }));
  await writeSession(record({ id: 's-3', projectId: 'p-2', createdAt: 5, name: '别的项目' }));

  const all = await listStored();
  assert.deepEqual(
    all.map((r) => r.id),
    ['s-3', 's-1', 's-2'], // 按 createdAt 升序
  );
  const mine = await listStored('p-1');
  assert.deepEqual(mine.map((r) => r.id), ['s-1', 's-2']);

  // 原子写不留临时文件
  const files = await fsp.readdir(projectSessionsDir('p-1'));
  assert.deepEqual(files.sort(), ['s-1.json', 's-2.json']);
});

test('坏 JSON / 缺字段的记录当不存在（列表少一条，不影响其它会话）', async () => {
  const dir = projectSessionsDir('p-1');
  await fsp.writeFile(path.join(dir, 'broken.json'), '{ 这不是 JSON', 'utf8');
  await fsp.writeFile(path.join(dir, 'partial.json'), JSON.stringify({ version: 1, name: '没有 id' }), 'utf8');
  // 非 .json 一律不认（pi 的会话目录也在同一层）
  await fsp.writeFile(path.join(dir, 'note.txt'), 'x', 'utf8');

  assert.equal(await readSession('p-1', 'broken'), null);
  assert.equal(await readSession('p-1', 'partial'), null);
  const ids = (await listStored('p-1')).map((r) => r.id);
  assert.deepEqual(ids, ['s-1', 's-2']);
});

test('删除会话：记录与 pi 的会话文件一起收走', async () => {
  const rec = record({ id: 's-del', projectId: 'p-3', backend: 'pi' });
  await writeSession(rec);
  // pi 侧：<项目目录>/pi/<cwd 分片>/<时间戳>_<id>.jsonl（按 id 认领）
  const shard = path.join(piSessionDir('p-3'), '--D--proj--');
  await fsp.mkdir(shard, { recursive: true });
  const piFile = path.join(shard, '2026-10-15T10-00-00-000Z_s-del.jsonl');
  await fsp.writeFile(piFile, '{"type":"message"}\n', 'utf8');
  const other = path.join(shard, '2026-10-15T10-00-00-000Z_s-keep.jsonl');
  await fsp.writeFile(other, '{"type":"message"}\n', 'utf8');

  await removeSession('p-3', 's-del');

  assert.equal(await readSession('p-3', 's-del'), null);
  await assert.rejects(() => fsp.stat(piFile), /ENOENT/);
  assert.equal((await fsp.stat(other)).isFile(), true); // 别人的会话文件不动
});
