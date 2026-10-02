/**
 * P12 编码探测单测：UTF-8 / BOM / UTF-16LE / UTF-16BE / GBK（环境支持时）/ latin1 兜底 / 二进制探测。
 * 索引与正文共用同一份解码文本（Q11），所以 GBK 还要断言行文本与字节列换算一致。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeBuffer, looksBinary } from '../src/indexer/encoding';
import { SourceText } from '../src/indexer/source-text';

const hasDecoder = (enc: string): boolean => {
  try {
    new TextDecoder(enc, { fatal: true });
    return true;
  } catch {
    return false;
  }
};

test('encoding: UTF-8 与 UTF-8 BOM', () => {
  const plain = decodeBuffer(Buffer.from('const a = 1;\n', 'utf8'));
  assert.equal(plain.encoding, 'utf8');
  assert.equal(plain.text, 'const a = 1;\n');
  assert.equal(plain.hadBom, false);

  const withBom = decodeBuffer(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# 注释\n', 'utf8')]));
  assert.equal(withBom.encoding, 'utf8-bom');
  assert.equal(withBom.text, '# 注释\n', 'BOM 本身不能留在正文里');
  assert.equal(withBom.hadBom, true);
});

test('encoding: UTF-16LE / UTF-16BE（带 BOM）', () => {
  const le = Buffer.from('\ufeffconst a = 1;\n', 'utf16le');
  const dLe = decodeBuffer(le);
  assert.equal(dLe.encoding, 'utf16le');
  assert.equal(dLe.text, 'const a = 1;\n');

  // BE：BOM(0xFE 0xFF) + 每个 UTF-16LE 码元交换字节
  const body = Buffer.from('const a = 1;\n', 'utf16le');
  const beBody = Buffer.from(body);
  beBody.swap16();
  const dBe = decodeBuffer(Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]));
  assert.equal(dBe.encoding, 'utf16be');
  assert.equal(dBe.text, 'const a = 1;\n');
});

test('encoding: GBK 中文注释不乱码且列换算一致（环境不支持时跳过）', (t) => {
  if (!hasDecoder('gbk')) {
    t.skip('本机 TextDecoder 不支持 gbk，跳过（不写假通过）');
    return;
  }
  // `# 中文注释` 的 GBK 字节：23 20 | D6D0 中 | CEC4 文 | D7A2 注 | CACD 释
  const gbk = Buffer.from([0x23, 0x20, 0xd6, 0xd0, 0xce, 0xc4, 0xd7, 0xa2, 0xca, 0xcd, 0x0a]);
  const decoded = decodeBuffer(gbk);
  assert.equal(decoded.encoding, 'gbk');
  assert.equal(decoded.text, '# 中文注释\n', 'GBK 中文注释应解出正确文本');
  assert.ok(!decoded.text.includes('\ufffd'), '不应出现替换字符');

  const text = new SourceText(decoded.text);
  assert.equal(text.lineText(1), '# 中文注释');
  // `# ` 每个 ASCII 1 字节 → '中' 的起始字节列是 2
  assert.equal(text.charColToByteCol(1, 3), 2);
  // '中' 之后是 2 + 3 = 5
  assert.equal(text.charColToByteCol(1, 4), 5);
  // 字节列 → 字符列回程
  assert.equal(text.byteColToCharCol(1, 5), 4);
  assert.equal(text.offset(1, 3), decoded.text.indexOf('中'));
});

test('encoding: 非法 UTF-8 且非 GBK → latin1 兜底（不产生假字符）', () => {
  // 0xFF 在 GBK 里不能作为任何合法序列的尾字节 → gbk 严格解码失败
  const buf = Buffer.from([0x41, 0xff, 0x42]);
  const decoded = decodeBuffer(buf);
  assert.equal(decoded.encoding, 'latin1');
  assert.equal(decoded.text, 'A\u00ffB');
  assert.ok(!decoded.text.includes('\ufffd'));
});

test('encoding: 二进制探测（NUL 判二进制，UTF-16 BOM 例外）', () => {
  assert.equal(looksBinary(Buffer.from([0x00, 0x01, 0x02])), true);
  assert.equal(looksBinary(Buffer.from('plain text\n')), false);
  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a\u0000', 'utf16le')]);
  assert.equal(looksBinary(utf16le), false, '带 BOM 的 UTF-16 是文本');
  const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from([0x00, 0x41])]);
  assert.equal(looksBinary(utf16be), false);
});
