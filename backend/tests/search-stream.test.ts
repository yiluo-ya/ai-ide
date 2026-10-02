/**
 * N12 流式搜索：按文件分组推 chunk，最后仍返回完整结果。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject } from './helpers';
import type { SearchMatch } from '../src/types';

test('N12: searchText 的 onFile 回调按文件推结果，最后仍返回完整结果', async () => {
  const fx = await makeProject({
    'a.ts': `export const alpha = 1;\nexport const beta = 2;\n`,
    'b.ts': `export const alpha = 3;\n`,
    'c/nested.ts': `export const alpha = 4;\n`,
  });
  try {
    const chunks: Array<{ files: string[]; matches: SearchMatch[] }> = [];
    const result = await fx.project.searchText('alpha', {}, undefined, (matches) => {
      chunks.push({ files: [...new Set(matches.map((m) => m.file))], matches });
    });
    assert.equal(result.matches.length, 3);
    assert.ok(chunks.length >= 3, `chunk 数=${chunks.length}`);
    // 每个 chunk 只含一个文件的命中
    for (const c of chunks) assert.equal(c.files.length, 1);
    // chunk 累加起来等于最终结果
    const total = chunks.reduce((n, c) => n + c.matches.length, 0);
    assert.equal(total, result.matches.length);
  } finally {
    await fx.cleanup();
  }
});
