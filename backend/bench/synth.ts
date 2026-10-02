/**
 * P23 合成仓库生成器（bench 与 perf 守护共用）。
 *
 * 每个文件约 150 行，TS / Python 按 2:1 混合，文件之间通过相对导入互相引用，
 * 使 goto-definition / find-references 有真实的跨文件目标可跳。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

export const isTs = (i: number): boolean => i % 3 !== 2;

function prevOf(i: number, pred: (n: number) => boolean): number {
  let p = i - 1;
  while (p >= 0 && !pred(p)) p--;
  return p;
}

/** 生成一个约 150 行的 TS 文件（含跨文件 import 与调用）。 */
export function tsFile(i: number): string {
  const prev = prevOf(i, isTs);
  const lines: string[] = [];
  if (prev >= 0) lines.push(`import { helper${prev}_0 } from './mod${prev}';`, '');
  for (let block = 0; block < 6; block++) {
    lines.push(
      `/** 第 ${i} 个模块的第 ${block} 组声明。 */`,
      `export interface Shape${i}_${block} {`,
      '  id: number;',
      '  name: string;',
      '}',
      '',
      `export class Model${i}_${block} {`,
      `  private seed = ${i + block};`,
      '',
      '  constructor(seed: number) {',
      '    this.seed = seed;',
      '  }',
      '',
      '  compute(input: number): number {',
      `    const base = ${prev >= 0 ? `helper${prev}_0(input)` : 'input'};`,
      '    return base + this.seed * 2;',
      '  }',
      '}',
      '',
      `export function helper${i}_${block}(value: number): number {`,
      `  const scaled = value * ${i + block + 1};`,
      `  return scaled + ${prev >= 0 ? `helper${prev}_0(scaled)` : '1'};`,
      '}',
      '',
    );
  }
  return lines.join('\n');
}

/** 生成一个约 150 行的 Python 文件（同样带跨文件 import 与调用）。 */
export function pyFile(i: number): string {
  const prev = prevOf(i, (n) => !isTs(n));
  const lines: string[] = [];
  if (prev >= 0) lines.push(`from mod${prev} import helper${prev}_0`, '');
  for (let block = 0; block < 6; block++) {
    lines.push(
      `class Model${i}_${block}:`,
      `    """第 ${i} 个模块的第 ${block} 组声明。"""`,
      `    seed = ${i + block}`,
      '',
      '    def compute(self, value):',
      `        base = ${prev >= 0 ? `helper${prev}_0(value)` : 'value'}`,
      '        return base + self.seed * 2',
      '',
      '',
      `def helper${i}_${block}(value):`,
      `    scaled = value * ${i + block + 1}`,
      `    return scaled + ${prev >= 0 ? `helper${prev}_0(scaled)` : '1'}`,
      '',
      '',
    );
  }
  return lines.join('\n');
}

export interface SynthPoint {
  file: string;
  line: number;
  col: number;
}

export interface SynthRepo {
  root: string;
  files: number;
  lines: number;
  ts: number;
  py: number;
  /** 跨文件调用点（goto-definition 用）。 */
  gotoPoints: SynthPoint[];
  /** 顶层函数定义点（find-references 用）。 */
  defPoints: SynthPoint[];
  firstFile: string;
}

/**
 * 把合成仓库写到 `root`。
 * @param queryPoints 采集多少个查询点（每个查询点对应一个文件）。
 */
export async function writeSynthRepo(root: string, files: number, queryPoints = 20): Promise<SynthRepo> {
  let lines = 0;
  let ts = 0;
  let py = 0;
  const CHUNK = 64;
  for (let start = 0; start < files; start += CHUNK) {
    const jobs: Promise<void>[] = [];
    for (let i = start; i < Math.min(files, start + CHUNK); i++) {
      const src = isTs(i) ? tsFile(i) : pyFile(i);
      const rel = isTs(i) ? `src/mod${i}.ts` : `pkg/mod${i}.py`;
      lines += src.split('\n').length;
      if (isTs(i)) ts++;
      else py++;
      const abs = path.join(root, ...rel.split('/'));
      jobs.push(fsp.mkdir(path.dirname(abs), { recursive: true }).then(() => fsp.writeFile(abs, src, 'utf8')));
    }
    await Promise.all(jobs);
  }
  const gotoPoints: SynthPoint[] = [];
  const defPoints: SynthPoint[] = [];
  for (let i = 1; i < files && gotoPoints.length < queryPoints; i++) {
    if (!isTs(i)) continue;
    const prev = prevOf(i, isTs);
    if (prev < 0) continue;
    const src = await fsp.readFile(path.join(root, 'src', `mod${i}.ts`), 'utf8');
    const at = (needle: string): { line: number; col: number } => {
      const idx = src.indexOf(needle);
      const before = src.slice(0, idx);
      return { line: before.split('\n').length, col: idx - (before.lastIndexOf('\n') + 1) + 1 };
    };
    const file = `src/mod${i}.ts`;
    gotoPoints.push({ file, ...at(`helper${prev}_0(`) });
    const def = at(`function helper${i}_0(`); // "function " 之后即符号名
    defPoints.push({ file, line: def.line, col: def.col + 9 });
  }
  return { root, files, lines, ts, py, gotoPoints, defPoints, firstFile: 'src/mod0.ts' };
}
