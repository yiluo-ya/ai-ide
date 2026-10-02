/**
 * 编码探测（P12 / Q11）：BOM → 严格 UTF-8 → GBK 启发式 → 宽松 UTF-8 → latin1。
 *
 * 索引与正文必须用同一份解码文本，否则符号坐标会错位（Q11）。
 * TextDecoder 实例按 (编码, fatal) 缓存（模块级），不每次新建。
 */

export type TextEncoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'gbk' | 'latin1';

export interface DecodeResult {
  text: string;
  encoding: TextEncoding;
  hadBom: boolean;
}

const decoderCache = new Map<string, DecoderLike>();

interface DecoderLike {
  decode(input: Uint8Array): string;
}

function getDecoder(encoding: string, fatal: boolean): DecoderLike | null {
  const key = `${encoding}:${fatal ? 'strict' : 'loose'}`;
  const cached = decoderCache.get(key);
  if (cached) return cached;
  try {
    const decoder = new TextDecoder(encoding, { fatal });
    decoderCache.set(key, decoder);
    return decoder;
  } catch {
    return null; // 运行环境没有该编码（如精简 ICU 构建）
  }
}

/**
 * GBK 启发式：解码结果里必须有中文（CJK）且不能夹带控制字符。
 * 纯 ASCII 字节不会走到这里（严格 UTF-8 已经成功），所以这里要求至少 1 个 CJK、
 * 且 CJK 占非 ASCII 字符的 30% 以上 —— 宁可回落 latin1，也不把乱码当 GBK。
 */
function gbkPlausible(text: string): boolean {
  let cjk = 0;
  let nonAscii = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x80) continue;
    nonAscii++;
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3000 && code <= 0x30ff)) cjk++;
  }
  if (!cjk || !nonAscii) return false;
  return cjk / nonAscii >= 0.3;
}

/** 字节 → 文本 + 编码（索引与正文共用同一份结果）。 */
export function decodeBuffer(buf: Buffer): DecodeResult {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf8-bom', hadBom: true };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    const decoder = getDecoder('utf-16le', false);
    return {
      text: decoder ? decoder.decode(buf.subarray(2)) : buf.subarray(2).toString('utf16le'),
      encoding: 'utf16le',
      hadBom: true,
    };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = buf.subarray(2);
    const decoder = getDecoder('utf-16be', false);
    if (decoder) return { text: decoder.decode(body), encoding: 'utf16be', hadBom: true };
    // 兜底：手工换字节序后按 utf16le 解码
    const swapped = Buffer.from(body);
    swapped.swap16();
    return { text: swapped.toString('utf16le'), encoding: 'utf16be', hadBom: true };
  }

  const strictUtf8 = getDecoder('utf-8', true);
  if (strictUtf8) {
    try {
      return { text: strictUtf8.decode(buf), encoding: 'utf8', hadBom: false };
    } catch {
      /* 不是合法 UTF-8，继续探测 */
    }
  }

  const gbk = getDecoder('gbk', true);
  if (gbk) {
    try {
      const text = gbk.decode(buf);
      if (gbkPlausible(text)) return { text, encoding: 'gbk', hadBom: false };
    } catch {
      /* 不是 GBK（或环境不支持），继续 */
    }
  }

  const looseUtf8 = getDecoder('utf-8', false);
  const loose = looseUtf8 ? looseUtf8.decode(buf) : buf.toString('utf8');
  if (!loose.includes('\ufffd')) return { text: loose, encoding: 'utf8', hadBom: false };

  // 最后兜底：逐字节保真，至少不产生 U+FFFD 假字符
  const latin1 = getDecoder('latin1', false);
  return { text: latin1 ? latin1.decode(buf) : buf.toString('latin1'), encoding: 'latin1', hadBom: false };
}

/** 是否文本（供「按需查看」判定二进制）：有 BOM 的 UTF-16 也算文本。 */
export function looksBinary(buf: Buffer): boolean {
  if (buf.length >= 2) {
    const b0 = buf[0];
    const b1 = buf[1];
    if ((b0 === 0xff && b1 === 0xfe) || (b0 === 0xfe && b1 === 0xff)) return false;
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return false;
  return buf.subarray(0, Math.min(buf.length, 8192)).includes(0);
}
