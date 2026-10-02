/**
 * 快照瘦身（不落正文）+ 懒读正文的行为守护：
 * 1. 恢复期一次盘都不读（文件树 / 符号跳转纯内存），首次访问 `fi.source` / `fi.text` 才读；
 * 2. 同一文件只读一次（source 与 text 共用同一份缓存），坐标语义与解析期一致；
 * 3. 读盘失败（文件被删）返回空串、记 read-error、不抛，恢复后可重试；
 * 4. 快照文件里不含正文；
 * 5. 旧格式（行里带正文）快照恢复后自动重写为瘦身版。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ProjectIndex } from '../src/indexer/store';
import { gotoDefinition } from '../src/indexer/resolver';
import { readSnapshotStream, snapshotPath, writeSnapshot, type SnapshotLine } from '../src/indexer/snapshot';

/** 只出现在注释里的独特标记：正文落盘会让它出现在快照里。 */
const MARKER = 'lazy-probe-marker-7c1e';

const posix = (p: string): string => p.split(path.sep).join('/');

const A_SRC = [
  "import { beta } from './b';",
  '',
  'export function alpha(value: number): number {',
  '  return beta(value) + 1;',
  '}',
  '',
  '',
  `// ${MARKER}`,
  '',
].join('\n');
const B_SRC = ['export function beta(value: number): number {', '  return value * 2;', '}', ''].join('\n');
const C_SRC = ['export function gamma(value: number): number {', '  return value - 3;', '}', ''].join('\n');

const FILES: Record<string, string> = { 'src/a.ts': A_SRC, 'src/b.ts': B_SRC, 'src/c.ts': C_SRC };

interface IoProbe {
  reads: number;
  /** 读过的路径（失败时用于诊断）。 */
  paths: string[];
  stop(): void;
}

/** 统计 `fs.readFileSync` + `fs/promises.readFile` 的调用次数（读盘探针）。 */
function startIoProbe(): IoProbe {
  const realSync = fs.readFileSync;
  const realAsync = fsp.readFile;
  const paths: string[] = [];
  const note = (args: unknown[]): void => {
    const first = args[0];
    paths.push(typeof first === 'string' ? first : String(first));
  };
  (fs as unknown as { readFileSync: unknown }).readFileSync = (...args: unknown[]) => {
    note(args);
    return (realSync as (...a: unknown[]) => unknown)(...args);
  };
  (fsp as unknown as { readFile: unknown }).readFile = (...args: unknown[]) => {
    note(args);
    return (realAsync as (...a: unknown[]) => unknown).apply(fsp, args);
  };
  return {
    get reads() {
      return paths.length;
    },
    paths,
    stop() {
      (fs as unknown as { readFileSync: unknown }).readFileSync = realSync;
      (fsp as unknown as { readFile: unknown }).readFile = realAsync;
    },
  };
}

async function makeRepo(): Promise<{ root: string; dataDir: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-lazy-root-'));
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-lazy-data-'));
  for (const [rel, text] of Object.entries(FILES)) {
    const abs = path.join(root, ...rel.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, text, 'utf8');
  }
  return { root, dataDir };
}

const abs = (root: string, rel: string): string => path.join(root, ...rel.split('/'));

const normalize = (p: string): string => p.replace(/\\/g, '/').toLowerCase();

/**
 * 「读正文」口径：排除忽略规则文件（`.gitignore` / `.wcrignore` 是 scan 阶段读的，
 * 属于文件树构建，不是正文）与项目根以外的路径（如 tsx 自身的模块加载）。
 */
function bodyReads(probe: IoProbe, root: string): string[] {
  return probe.paths
    .map((raw) => ({ raw, norm: normalize(raw) }))
    .filter((p) => !/(^|\/)\.(git|wcr)ignore$/i.test(p.norm))
    .filter((p) => p.norm.startsWith(normalize(root)))
    .map((p) => p.raw);
}

const snapshotText = async (dataDir: string): Promise<string> =>
  gunzipSync(await fsp.readFile(snapshotPath(dataDir, 'lazy'))).toString('utf8');

test('snapshot: 恢复期零读盘 + 正文懒读（缓存一次、失败可重试）', { timeout: 120_000 }, async (t) => {
  const { root, dataDir } = await makeRepo();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));

  const first = new ProjectIndex('lazy', 'lazy', posix(root), Date.now(), { dataDir, persist: true, workers: 0 });
  await first.reindexAll();
  first.dispose();

  // 快照文件里不应有正文（注释里的 MARKER 只可能来自 source）
  const snap = await snapshotText(dataDir);
  assert.ok(!snap.includes(MARKER), '快照里不应出现正文内容');

  const warm = new ProjectIndex('lazy', 'lazy', posix(root), Date.now(), { dataDir, persist: true, workers: 0 });
  try {
    const probe = startIoProbe();
    await warm.reindexAll();
    probe.stop();
    assert.equal(warm.files.size, 3, '恢复后索引完整');
    const restoredReads = bodyReads(probe, root);
    assert.equal(restoredReads.length, 0, `恢复期（含文件树与符号表）不应读任何文件正文：${restoredReads.join(', ')}`);

    // 对照：探针确实能统计到正文读盘（否则上面的 0 是假绿）
    const fi = warm.files.get('src/a.ts');
    assert.ok(fi);
    const p1 = startIoProbe();
    assert.equal(fi.source, A_SRC, '懒读正文应与磁盘一致');
    p1.stop();
    assert.equal(bodyReads(p1, root).length, 1, '首次访问 source 应正好读盘一次');

    // text 与 source 共用同一份缓存：再访问一次不产生读盘，且坐标语义正确
    const p2 = startIoProbe();
    assert.equal(fi.text.lineText(3), 'export function alpha(value: number): number {');
    assert.equal(fi.text.position(fi.source.indexOf('beta(value)')).line, 4);
    p2.stop();
    assert.equal(bodyReads(p2, root).length, 0, '第二次访问不应再次读盘');

    // 读失败（该文件此前从未被懒读过）：返回空串、记 read-error、不抛；文件回来后重试成功
    const bRel = 'src/b.ts';
    const bAbs = abs(root, bRel);
    await fsp.rm(bAbs);
    const fb = warm.files.get(bRel);
    assert.ok(fb);
    assert.equal(fb.source, '');
    assert.equal(warm.skipLog.get(bRel)?.reason, 'read-error', '读失败应记进 P9 skipLog');
    await fsp.writeFile(bAbs, B_SRC, 'utf8');
    assert.equal(fb.source, B_SRC, '失败不缓存：文件回来后重试应读到内容');

    // 懒读不能使查询退化：查看正文 / 文本搜索 / 符号跳转都走同一份懒读结果
    const read = await warm.readText('src/a.ts');
    assert.equal(read?.text, A_SRC, 'readText 应拿到懒读正文');
    const found = await warm.searchText('alpha', { maxResults: 10 });
    assert.ok(found.matches.length > 0, '恢复后文本搜索应能搜到正文');
    const jump = gotoDefinition(warm, 'src/a.ts', 4, 10);
    assert.equal(jump.reason, 'resolved', '恢复后 goto 应能解析');
    assert.equal(jump.locations[0]?.file, 'src/b.ts', '应跳到被 import 的 beta 定义');
  } finally {
    warm.dispose();
  }
});

test('snapshot: 旧格式（行内带正文）快照 → 恢复后自动重写为瘦身版', { timeout: 120_000 }, async (t) => {
  const { root, dataDir } = await makeRepo();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));

  const first = new ProjectIndex('lazy', 'lazy', posix(root), Date.now(), { dataDir, persist: true, workers: 0 });
  await first.reindexAll();
  first.dispose();

  // 模拟旧格式：把行里的 source 字段补回来（=瘦身前的快照）
  const lines: SnapshotLine[] = [];
  let header = null as Awaited<ReturnType<typeof readSnapshotStream>>;
  header = await readSnapshotStream(snapshotPath(dataDir, 'lazy'), {
    onFile: (rec) => {
      lines.push({ ...rec, source: fs.readFileSync(abs(root, rec.file), 'utf8') });
    },
  });
  assert.ok(header && lines.length === 3);
  await writeSnapshot(snapshotPath(dataDir, 'lazy'), header.header, lines);
  assert.ok((await snapshotText(dataDir)).includes(MARKER), '旧格式快照里确实带正文');

  const second = new ProjectIndex('lazy', 'lazy', posix(root), Date.now(), { dataDir, persist: true, workers: 0 });
  try {
    const probe = startIoProbe();
    await second.reindexAll();
    probe.stop();
    assert.equal(second.files.size, 3);
    assert.equal(second.snapshotStatus().fresh, true);
    const restoredReads = bodyReads(probe, root);
    assert.equal(restoredReads.length, 0, `旧格式恢复同样不读正文：${restoredReads.join(', ')}`);
    assert.ok(!(await snapshotText(dataDir)).includes(MARKER), '恢复后应重写为不落正文的瘦身快照');
    assert.equal(second.files.get('src/a.ts')?.source, A_SRC, '重写后正文仍能按需读到');
  } finally {
    second.dispose();
  }
});
