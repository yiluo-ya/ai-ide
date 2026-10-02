/**
 * P9 索引报告单测：未索引 / 降级 / 编码统计归类，byReason 的 count 与 files 截断，
 * degraded 计入（P11）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject } from './helpers';
import { MAX_REPORT_FILES, buildIndexReport } from '../src/indexer/index-report';

const BIG_DEGRADED = `export function huge() {}\n${' '.repeat(1020)}\n`.repeat(1200); // ≈1.2MB → 顶层符号降级
const TOO_LARGE = `export function enormous() {}\n${'\n'.repeat(5_100_000)}`; // >5MB → 只留正文

test('index-report: 未索引 / 降级 / 编码分布归类正确', async (t) => {
  const files: Record<string, string> = {
    'src/a.ts': 'export function alpha(): number { return 1; }\n',
    'src/README.md': '# 说明\n',
    'big/huge.ts': BIG_DEGRADED,
    'big/enormous.ts': TOO_LARGE,
  };
  for (let i = 0; i < 3; i++) files[`blobs/blob${i}.ts`] = `const x${i} = 1;\n\u0000\u0000`;
  const { project, cleanup } = await makeProject(files);
  t.after(cleanup);

  const report = buildIndexReport(project);

  assert.equal(report.degraded, 1, '1MB~5MB 的文件应走顶层符号降级并计入 degraded');
  assert.equal(project.files.get('big/huge.ts')?.degraded, 'top-level');
  assert.ok(report.indexed >= 2, '普通文件与降级文件都算已索引');

  const byReason = new Map(report.byReason.map((r) => [r.reason, r]));
  assert.equal(byReason.get('binary')?.count, 3, '含 NUL 的文件归 binary');
  assert.equal(byReason.get('too-large')?.count, 1, '>5MB 的文件归 too-large（连顶层符号都不取）');
  assert.equal(byReason.get('not-source')?.count, 1, 'README.md 非源码');
  assert.deepEqual(byReason.get('not-source')?.files, [], 'not-source 不给文件清单（避免上千行噪音）');

  // scanned = 非目录条目总数（源码 + 非源码）
  assert.equal(report.scanned, Object.keys(files).length);
  assert.equal(report.sourceFiles, Object.keys(files).filter((f) => f.endsWith('.ts')).length);

  const utf8 = report.encodings.find((e) => e.encoding === 'utf8');
  assert.ok(utf8 && utf8.count > 0, '编码分布应统计到 utf8');
  assert.ok(report.generatedAt > 0);
});

test('index-report: byReason.files 截断到 50，count 仍为真实值', async (t) => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 60; i++) files[`blobs/blob${i}.ts`] = `\u0000\u0000binary ${i}\n`;
  const { project, cleanup } = await makeProject(files);
  t.after(cleanup);

  const report = buildIndexReport(project);
  const binary = report.byReason.find((r) => r.reason === 'binary');
  assert.ok(binary);
  assert.equal(binary.count, 60, 'count 是真实值');
  assert.equal(binary.files.length, MAX_REPORT_FILES, `files 截断到 ${MAX_REPORT_FILES}`);
});
