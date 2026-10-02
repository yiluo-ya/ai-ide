/** UTF-16(JS 字符串) 与 tree-sitter 的 UTF-8 字节坐标之间的换算，外加行索引。 */
import type { Position } from '../types';

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

export class SourceText {
  readonly source: string;
  /** 每行起始的 UTF-16 偏移。 */
  readonly lineStarts: number[];
  readonly lineCount: number;

  constructor(source: string) {
    this.source = source;
    const starts = [0];
    for (let i = 0; i < source.length; i++) {
      if (source.charCodeAt(i) === 10) starts.push(i + 1);
    }
    this.lineStarts = starts;
    this.lineCount = starts.length;
  }

  /** 行内容，不含换行符，1-based。 */
  lineText(line: number): string {
    const i = line - 1;
    if (i < 0 || i >= this.lineCount) return '';
    const start = this.lineStarts[i];
    let end = i + 1 < this.lineCount ? this.lineStarts[i + 1] : this.source.length;
    if (end > start && this.source.charCodeAt(end - 1) === 10) end--;
    if (end > start && this.source.charCodeAt(end - 1) === 13) end--;
    return this.source.slice(start, end);
  }

  /** UTF-16 列号(1-based) → 行内 UTF-8 字节列号(0-based)。 */
  charColToByteCol(line: number, col: number): number {
    const text = this.lineText(line);
    const upto = Math.min(Math.max(col - 1, 0), text.length);
    return utf8Length(text.slice(0, upto));
  }

  /** 行内 UTF-8 字节列号(0-based) → UTF-16 列号(1-based)。 */
  byteColToCharCol(line: number, byteCol: number): number {
    const text = this.lineText(line);
    if (byteCol <= 0) return 1;
    let bytes = 0;
    let chars = 0;
    while (chars < text.length) {
      const cp = text.codePointAt(chars) as number;
      const b = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      if (bytes + b > byteCol) break;
      bytes += b;
      chars += cp > 0xffff ? 2 : 1;
    }
    return chars + 1;
  }

  /** 1-based 行列 → UTF-16 偏移。 */
  offset(line: number, col: number): number {
    const i = Math.min(Math.max(line - 1, 0), this.lineCount - 1);
    const text = this.lineText(line);
    return this.lineStarts[i] + Math.min(Math.max(col - 1, 0), text.length);
  }

  /** UTF-16 偏移 → 1-based 行列。 */
  position(offset: number): Position {
    let lo = 0;
    let hi = this.lineCount - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - this.lineStarts[lo] + 1 };
  }

  /** 取一行切片（用于搜索预览），列均为 1-based。 */
  sliceLine(line: number, fromCol: number, toCol: number): string {
    const text = this.lineText(line);
    return text.slice(Math.max(fromCol - 1, 0), Math.max(toCol - 1, 0));
  }
}
