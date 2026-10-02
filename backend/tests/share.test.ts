/** S5a 同机同目录分享：CORS 白名单解析（parseCorsOrigins）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCorsOrigins } from '../src/config';

test('cors: parseCorsOrigins 支持逗号分隔白名单，未配置保持放开', () => {
  assert.deepEqual(parseCorsOrigins(undefined), ['*']);
  assert.deepEqual(parseCorsOrigins(null), ['*']);
  assert.deepEqual(parseCorsOrigins(''), ['*']);
  assert.deepEqual(parseCorsOrigins(' , , '), ['*']);
  assert.deepEqual(parseCorsOrigins('*'), ['*']);
  assert.deepEqual(parseCorsOrigins(' https://a.com ,https://b.com '), ['https://a.com', 'https://b.com']);
  assert.deepEqual(parseCorsOrigins('https://a.com'), ['https://a.com']);
});
