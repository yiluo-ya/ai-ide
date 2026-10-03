/**
 * P4 快照单测：NDJSON + gzip 流式写读往返、派生表重建、指纹一致/不一致的分支、
 * schema 不符与损坏回落，以及「数千条记录逐行写入不拼整串」的大 payload 路径。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { indexSource } from '../src/indexer/parser';
import { specForFile } from '../src/languages';
import { SourceText } from '../src/indexer/source-text';
import { ProjectIndex } from '../src/indexer/store';
import {
  SNAPSHOT_SCHEMA,
  decodeEntries,
  fingerprintEntries,
  fromFileRecord,
  readSnapshotStream,
  snapshotPath,
  toFileRecord,
  writeSnapshot,
  type SnapshotHeaderInput,
  type SnapshotLine,
} from '../src/indexer/snapshot';

async function tmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-snap-'));
}

async function makeRepo(files: Record<string, string>): Promise<{ root: string; dataDir: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-snap-repo-'));
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-snap-data-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, text, 'utf8');
  }
  return { root, dataDir };
}

const posix = (p: string): string => p.split(path.sep).join('/');

/** 计数 spy：拦住 indexTargets，统计「本次真正重解析了多少个文件」。 */
function spyReparse(project: ProjectIndex): { count: number } {
  const box = { count: 0 };
  const target = project as unknown as { indexTargets(targets: string[]): Promise<void> };
  const original = target.indexTargets.bind(project);
  target.indexTargets = async (targets: string[]) => {
    box.count += targets.length;
    return original(targets);
  };
  return box;
}

test('snapshot: 写入 → 读取往返（含派生表重建与懒 text）', async (t) => {
  const dir = await tmpDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'snapshot.ndjson.gz');

  const src = [
    "import { helper } from './util';",
    'export function alpha(x: number): number {',
    '  const label = "alpha";',
    '  return helper(x) + label.length;',
    '}',
    '',
  ].join('\n');
  const spec = specForFile('a.ts');
  if (!spec) throw new Error('typescript spec 未注册');
  const fi = indexSource('a.ts', src, spec, { mtimeMs: 111, size: Buffer.byteLength(src) });
  fi.encoding = 'utf8';

  const header: SnapshotHeaderInput = {
    schema: SNAPSHOT_SCHEMA,
    projectId: 'p1',
    root: '/root',
    savedAt: 42,
    indexVersion: 3,
    fingerprint: 'fp-abc',
    entries: [['a.ts', Buffer.byteLength(src), 111, 0]],
    encodings: { utf8: 1 },
    skips: { 'b.bin': { reason: 'binary' } },
  };
  await writeSnapshot(file, header, [toFileRecord(fi)]);

  const seen: SnapshotLine[] = [];
  let headerSeen: string | null = null;
  const result = await readSnapshotStream(file, {
    onHeader: (h) => {
      headerSeen = h.fingerprint;
    },
    onFile: (rec) => seen.push(rec),
  });

  assert.ok(result);
  assert.equal(result.files, 1);
  assert.equal(headerSeen, 'fp-abc');
  assert.equal(result.header.savedAt, 42);
  assert.equal(result.header.indexVersion, 3);
  assert.deepEqual(decodeEntries(result.header.entries).get('a.ts'), {
    dir: false,
    size: Buffer.byteLength(src),
    mtimeMs: 111,
  });
  assert.equal(result.header.encodings?.utf8, 1);
  assert.equal(result.header.skips?.['b.bin']?.reason, 'binary');

  // JSON 往返的语义：值为 undefined 的可选字段不会落盘（其余字段必须完全一致）
  const json = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
  const back = fromFileRecord(seen[0]);
  assert.equal(back.file, 'a.ts');
  assert.equal(back.lang, 'typescript');
  assert.equal(back.mtimeMs, 111);
  assert.equal(back.indexed, true);
  assert.equal(back.encoding, 'utf8');
  assert.equal(back.tree, null, 'AST 不落盘');
  assert.deepEqual(json(back.definitions), json(fi.definitions));
  assert.deepEqual(json(back.references), json(fi.references));
  assert.deepEqual(json(back.imports), json(fi.imports));
  assert.deepEqual(json(back.literals), json(fi.literals));
  assert.deepEqual(json([...back.scopes.values()]), json([...fi.scopes.values()]));

  // defsByScope / importsByScope 不落盘，但读回后必须与解析期同一口径
  assert.deepEqual([...back.defsByScope.keys()].sort(), [...fi.defsByScope.keys()].sort());
  for (const [scope, inner] of fi.defsByScope) {
    assert.deepEqual(
      [...(back.defsByScope.get(scope)?.keys() ?? [])].sort(),
      [...inner.keys()].sort(),
      `scope ${scope} 的 defsByScope 应重建一致`,
    );
  }
  for (const [scope, inner] of fi.importsByScope) {
    assert.deepEqual([...(back.importsByScope.get(scope)?.keys() ?? [])].sort(), [...inner.keys()].sort());
  }

  // text 懒构造，但对读取方透明可用
  assert.ok(back.text instanceof SourceText);
  assert.equal(back.text.lineText(2), 'export function alpha(x: number): number {');
  assert.equal(back.text.position(back.source.indexOf('helper(x)')).line, 4);
  assert.equal(back.text, back.text, '懒构造只做一次（缓存实例）');
});

test('snapshot: 指纹一致 → 不重解析也不重写快照', async (t) => {
  const { root, dataDir } = await makeRepo({
    'src/a.ts': 'export function alpha(): number {\n  return 1;\n}\n',
    'src/b.ts': 'export function beta(): number {\n  return 2;\n}\n',
  });
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));

  const first = new ProjectIndex('p', 'p', posix(root), Date.now(), { dataDir, persist: true, workers: 0 });
  await first.reindexAll();
  assert.equal(first.files.size, 2);
  first.dispose();
  const file = snapshotPath(dataDir, 'p');
  const before = await fsp.stat(file);

  const second = new ProjectIndex('p', 'p', posix(root), Date.now(), { dataDir, persist: true, workers: 0 });
  const spy = spyReparse(second);
  await second.reindexAll();
  second.dispose();

  assert.equal(spy.count, 0, '指纹一致时不应重解析任何文件');
  assert.equal(second.files.size, 2);
  assert.equal(second.snapshotStatus().fresh, true);
  const after = await fsp.stat(file);
  assert.equal(after.mtimeMs, before.mtimeMs, '指纹一致时不应重写快照');
});

test('snapshot: 指纹不一致 → 只重解析变化的文件', async (t) => {
  const { root, dataDir } = await makeRepo({
    'src/a.ts': 'export function alpha(): number {\n  return 1;\n}\n',
    'src/b.ts': 'export function beta(): number {\n  return 2;\n}\n',
    'src/c.ts': 'export function gamma(): number {\n  return 3;\n}\n',
  });
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));

  const first = new ProjectIndex('p', 'p', posix(root), Date.now(), { dataDir, persist: true, workers: 0 });
  await first.reindexAll();
  first.dispose();

  // 只改 b.ts（size / mtime 都变）
  await fsp.writeFile(
    path.join(root, 'src', 'b.ts'),
    'export function betaRenamed(): number {\n  return 20;\n}\n',
    'utf8',
  );

  const second = new ProjectIndex('p', 'p', posix(root), Date.now(), { dataDir, persist: true, workers: 0 });
  const spy = spyReparse(second);
  await second.reindexAll();
  second.dispose();

  assert.equal(spy.count, 1, '只有变化的 b.ts 需要重解析');
  assert.equal(second.files.size, 3);
  assert.equal(second.snapshotStatus().fresh, true);
  assert.ok(second.defsByName.has('betaRenamed'), '新符号已进索引');
  assert.ok(!second.defsByName.has('beta'), '旧符号已移除');
  assert.ok(second.defsByName.has('alpha') && second.defsByName.has('gamma'), '未变化文件的符号仍在');
});

test('snapshot: schema 不符 / 文件损坏 → 视为没有快照（回落全量重建）', async (t) => {
  const dir = await tmpDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const goodHeader: SnapshotHeaderInput = {
    schema: SNAPSHOT_SCHEMA,
    projectId: 'p',
    root: '/root',
    savedAt: 1,
    indexVersion: 1,
    fingerprint: 'fp',
    entries: [],
  };
  const badSchema = path.join(dir, 'bad-schema.ndjson.gz');
  await writeSnapshot(badSchema, { ...goodHeader, schema: 999 }, []);
  assert.equal(await readSnapshotStream(badSchema), null, 'schema 不符 → null');

  const broken = path.join(dir, 'broken.ndjson.gz');
  await fsp.writeFile(broken, Buffer.from([0x1f, 0x8b, 0x00, 0x01, 0x02]));
  assert.equal(await readSnapshotStream(broken), null, '损坏的 gzip → null');

  const missing = await readSnapshotStream(path.join(dir, 'nope.ndjson.gz'));
  assert.equal(missing, null, '不存在 → null');
});

test('snapshot: 损坏快照不会让索引不可用（store 层回落全量）', async (t) => {
  const { root, dataDir } = await makeRepo({
    'src/a.ts': 'export function alpha(): number {\n  return 1;\n}\n',
  });
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));

  const first = new ProjectIndex('p', 'p', posix(root), Date.now(), { dataDir, persist: true, workers: 0 });
  await first.reindexAll();
  first.dispose();

  // 把快照截断
  const file = snapshotPath(dataDir, 'p');
  await fsp.writeFile(file, Buffer.from([0x1f, 0x8b, 0x08, 0x00]));

  const second = new ProjectIndex('p', 'p', posix(root), Date.now(), { dataDir, persist: true, workers: 0 });
  await second.reindexAll();
  second.dispose();

  assert.equal(second.files.size, 1, '回落全量重建后索引仍完整');
  assert.equal(second.status.error, null);
  assert.ok(second.defsByName.has('alpha'));
});

// 同类压测：默认关闭（用户 2026-10-03：压测我自己跑）；要跑加 READER_PERF=1。
const PERF_ON = process.env.READER_PERF === '1';
(PERF_ON ? test : test.skip)(
  'snapshot: 数千条记录逐行流式写入 / 读回（模拟百 MB 量级 payload）',
  { timeout: 240_000 },
  async (t) => {
  const dir = await tmpDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'big.ndjson.gz');

  const RECORDS = 5000;
  const source = 'x'.repeat(24 * 1024); // 同一实例复用，避免测试自身撑爆内存
  const header: SnapshotHeaderInput = {
    schema: SNAPSHOT_SCHEMA,
    projectId: 'big',
    root: '/root',
    savedAt: 1,
    indexVersion: 1,
    fingerprint: 'fp',
    entries: [[`src/f0.ts`, source.length, 1, 0] as [string, number, number, number]],
  };

  let yielded = 0;
  await writeSnapshot(file, header, function* () {
    for (let i = 0; i < RECORDS; i++) {
      yielded++;
      yield {
        t: 'f',
        file: `src/f${i}.ts`,
        lang: 'typescript',
        mtimeMs: i,
        size: source.length,
        indexed: true,
        error: null,
        degraded: null,
        source,
        scopes: [],
        definitions: [],
        references: [],
        imports: [],
        literals: [],
      } satisfies SnapshotLine;
    }
  });
  assert.equal(yielded, RECORDS, '写入走生成器逐行产出（不先拼一个巨型字符串 / 数组）');

  let read = 0;
  const result = await readSnapshotStream(file, { onFile: () => void read++ });
  assert.ok(result);
  assert.equal(result.files, RECORDS);
  assert.equal(read, RECORDS);
  const st = await fsp.stat(file);
  assert.ok(st.size > 0 && st.size < source.length * RECORDS, 'gzip 应真的压缩了');
  },
);

test('snapshot: 指纹函数对 size / mtime / dir 敏感（Q8 判据）', () => {
  const a = fingerprintEntries([
    ['src/a.ts', { dir: false, size: 10, mtimeMs: 100.4 }],
    ['src', { dir: true, size: 0, mtimeMs: 0 }],
  ]);
  const b = fingerprintEntries([
    ['src', { dir: true, size: 0, mtimeMs: 0 }],
    ['src/a.ts', { dir: false, size: 10, mtimeMs: 100.4 }],
  ]);
  assert.equal(a, b, '指纹与插入顺序无关');
  const c = fingerprintEntries([['src/a.ts', { dir: false, size: 11, mtimeMs: 100.4 }]]);
  assert.notEqual(a, c);
  const d = fingerprintEntries([['src/a.ts', { dir: false, size: 10, mtimeMs: 101.4 }]]);
  assert.notEqual(a, d);
});
