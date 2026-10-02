/**
 * P4 端到端持久化单测：`reindexAll` → 新 `ProjectIndex` 实例 → 快照加载 →
 * 跳转 / 符号搜索可用；冷启动路径不重新解析全部文件（indexTargets / indexOne 计数）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectIndex } from '../src/indexer/store';
import { gotoDefinition, workspaceSymbols } from '../src/indexer/resolver';
import { makeProject } from './helpers';

const posix = (p: string): string => p.split(path.sep).join('/');

async function makeRepo(files: Record<string, string>): Promise<{ root: string; dataDir: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-persist-repo-'));
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-persist-data-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, text, 'utf8');
  }
  return { root, dataDir };
}

/** 计数 spy：本次真正重解析（indexTargets）与单文件重解析（indexOne）的次数。 */
function spyReparse(project: ProjectIndex): { targets: number; one: number } {
  const box = { targets: 0, one: 0 };
  const hook = project as unknown as {
    indexTargets(targets: string[]): Promise<void>;
    indexOne(rel: string): Promise<void>;
  };
  const originalTargets = hook.indexTargets.bind(project);
  const originalOne = hook.indexOne.bind(project);
  hook.indexTargets = async (targets: string[]) => {
    box.targets += targets.length;
    return originalTargets(targets);
  };
  hook.indexOne = async (rel: string) => {
    box.one += 1;
    return originalOne(rel);
  };
  return box;
}

test('persist: 进度计数是累计完成数（25+ 文件、跨多批读取）', async (t) => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 30; i++) files[`src/m${i}.ts`] = `export function f${i}(): number {\n  return ${i};\n}\n`;
  const { project, cleanup } = await makeProject(files);
  t.after(cleanup);
  assert.equal(project.status.filesTotal, 30);
  assert.equal(project.status.filesIndexed, project.status.filesTotal, 'filesIndexed 必须是累计值，不能被最后一批的数量覆盖');
  assert.equal(project.status.progress, 1);
});

test('persist: 并行批次下进度计数同样累计', { timeout: 120_000 }, async (t) => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 30; i++) files[`src/p${i}.ts`] = `export function g${i}(): number {\n  return ${i};\n}\n`;
  const { project, cleanup } = await makeProject(files, { workers: 2 });
  t.after(cleanup);
  assert.equal(project.status.filesTotal, 30);
  assert.equal(project.status.filesIndexed, project.status.filesTotal);
  assert.equal(project.status.progress, 1);
});

test('persist: 快照恢复后跳转与符号搜索可用，且不重新解析全部文件', async (t) => {
  const { root, dataDir } = await makeRepo({
    'src/util.ts': 'export function shared(x: number): number {\n  return x + 1;\n}\n',
    'src/app.ts': "import { shared } from './util';\n\nexport function main(): number {\n  return shared(41);\n}\n",
  });
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));

  const cold = new ProjectIndex('p', 'p', posix(root), Date.now(), { dataDir, persist: true, workers: 0 });
  await cold.reindexAll();
  assert.equal(cold.files.size, 2);
  assert.equal(cold.status.filesIndexed, cold.status.filesTotal, '进度计数必须是累计完成数');
  assert.ok(cold.snapshotStatus().exists, '首开应写下快照');
  cold.dispose();

  const warm = new ProjectIndex('p', 'p', posix(root), Date.now(), { dataDir, persist: true, workers: 0 });
  const spy = spyReparse(warm);
  await warm.reindexAll();
  t.after(() => warm.dispose());

  assert.equal(spy.targets, 0, '指纹一致时冷启动不解析任何文件');
  assert.equal(spy.one, 0);
  assert.equal(warm.status.filesIndexed, warm.status.filesTotal);
  assert.equal(warm.snapshotStatus().fresh, true);

  // 跳转：app.ts 里的 shared(...) → util.ts 的定义
  const app = warm.files.get('src/app.ts');
  assert.ok(app);
  const idx = app.source.indexOf('shared(41)');
  const pos = app.text.position(idx);
  const jump = gotoDefinition(warm, 'src/app.ts', pos.line, pos.col);
  assert.equal(jump.reason, 'resolved');
  assert.equal(jump.locations[0]?.file, 'src/util.ts');

  const symbols = workspaceSymbols(warm, 'shared', null, 10);
  assert.ok(symbols.some((s) => s.name === 'shared' && s.location.file === 'src/util.ts'));
});

test('persist: 单文件改动只重解析该文件（indexOne 次数 = 变化数）', async (t) => {
  const { root, dataDir } = await makeRepo({
    'src/a.ts': 'export function alpha(): number {\n  return 1;\n}\n',
    'src/b.ts': 'export function beta(): number {\n  return 2;\n}\n',
  });
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));

  const cold = new ProjectIndex('p', 'p', posix(root), Date.now(), { dataDir, persist: true, workers: 0 });
  await cold.reindexAll();
  cold.dispose();

  // 改一个文件（size 也变）
  await fsp.writeFile(path.join(root, 'src', 'b.ts'), 'export function betaPlus(value: number): number {\n  return value + 2;\n}\n', 'utf8');

  const warm = new ProjectIndex('p', 'p', posix(root), Date.now(), { dataDir, persist: true, workers: 0 });
  const spy = spyReparse(warm);
  await warm.reindexAll();
  t.after(() => warm.dispose());

  assert.equal(spy.targets, 1, '只重解析变化的那一个文件');
  assert.ok(warm.defsByName.has('betaPlus'));
  assert.ok(!warm.defsByName.has('beta'));
  assert.ok(warm.defsByName.has('alpha'), '未变化文件的符号仍来自快照');

  // 增量路径：watcher 单文件变更 → 恰好 1 次 indexOne
  const before = spy.one;
  await fsp.writeFile(path.join(root, 'src', 'a.ts'), 'export function alphaTwo(): number {\n  return 10;\n}\n', 'utf8');
  await warm.onFileChanged('src/a.ts');
  assert.equal(spy.one - before, 1, '单文件变更走一次 indexOne');
  assert.ok(warm.defsByName.has('alphaTwo'));
  assert.ok(workspaceSymbols(warm, 'alphaTwo', null, 5).length > 0, '增量后新符号可查');
});
