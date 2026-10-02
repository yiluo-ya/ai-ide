/** 相对路径（POSIX 分隔符）工具，供语言模块做模块说明符解析。 */

export const dirname = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};

export const basename = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
};

export const extname = (p: string): string => {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i);
};

/** 归一化并拼接相对路径段，解析 `.` / `..`。 */
export function joinRel(...parts: string[]): string {
  const segs: string[] = [];
  for (const part of parts.join('/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (segs.length && segs[segs.length - 1] !== '..') segs.pop();
      else segs.push('..');
      continue;
    }
    segs.push(part);
  }
  return segs.join('/');
}

export const stripExt = (p: string): string => {
  const e = extname(p);
  return e ? p.slice(0, -e.length) : p;
};
