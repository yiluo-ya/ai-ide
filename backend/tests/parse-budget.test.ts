/**
 * 解析预算的截断判定（回归守护）：tree-sitter 的 `endIndex` 是**字符**下标，
 * 必须与 `source.length` 比较。此前拿 `Buffer.byteLength(source)`（字节数）比，
 * 含多字节字符（中文注释）的 ≥64KB 文件会被误判「超预算截断」而整份丢弃符号索引。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexSource, parseBudgetMs, PARSE_BUDGET_MIN_BYTES } from '../src/indexer/parser';
import { specForFile } from '../src/languages';

test('parse budget: 含多字节字符的大文件不应被误判超预算（endIndex 按字符比）', () => {
  // 用中文注释把字节数抬到字符数之上，并跨过「启用限时」的门槛（64KB）
  const comment = '    # 中文注释：这里放很多多字节字符，把字节数抬高到字符数之上\n';
  let source = '';
  while (Buffer.byteLength(source) < PARSE_BUDGET_MIN_BYTES + 20_000) source += comment;
  source += '\ndef work(path):\n    return path\n';

  const size = Buffer.byteLength(source);
  assert.ok(size >= PARSE_BUDGET_MIN_BYTES, `前提：文件要够大（${size}B）才会启用限时`);
  assert.ok(size > source.length, '前提：字节数必须大于字符数（含多字节字符）');

  const spec = specForFile('sample.py');
  assert.ok(spec, 'python 规格应存在');
  const fi = indexSource('sample.py', source, spec!, { mtimeMs: 1, size }, { budgetMs: parseBudgetMs(size) });

  assert.equal(fi.indexed, true, `含中文的 ${size}B 文件应被索引，实际 error=${fi.error}`);
  assert.ok(
    fi.definitions.some((d) => d.name === 'work'),
    '函数定义应被索引出来',
  );
});
