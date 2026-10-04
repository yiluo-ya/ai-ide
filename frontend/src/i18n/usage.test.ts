/**
 * i18n 使用面校验（P25 补全的收口）：
 * ① 源码里 `t('key')` / `translate('key')` 用到的 key 必须在 zh 中定义
 *    —— 防拼写错导致界面直接显示 key 名；
 * ② UI 层不得再出现硬编码中文文案（注释除外）—— 防新代码把文案写死。
 *
 * 源码文本用 vite 的 `?raw` glob 读入，避免给 tsc 引入 node 类型依赖。
 */
import { describe, expect, it } from 'vitest';
import { zh } from './zh';

const raw = import.meta.glob('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as unknown as Record<string, string>;

/**
 * 只保留 `src/` 下的界面代码：vite 会把 `../i18n/zh.ts` 归一化成 `./zh.ts`，
 * 因此「以 `../` 开头」= src 直属文件，正好排掉 i18n 目录自身（词典 / 本测试）。
 */
const files = Object.entries(raw).filter(
  ([p]) => p.startsWith('../') && !/\.test\.[tj]sx?$/.test(p) && !p.endsWith('.d.ts'),
);

const CJK = /[\u4e00-\u9fff]/;

/** 去掉一行的注释部分（块注释状态由 state 跨行维护）。 */
function stripComments(line: string, state: { inBlock: boolean }): string {
  let rest = line;
  let out = '';
  for (;;) {
    if (state.inBlock) {
      const end = rest.indexOf('*/');
      if (end === -1) return out;
      rest = rest.slice(end + 2);
      state.inBlock = false;
      continue;
    }
    const block = rest.indexOf('/*');
    const lineComment = rest.indexOf('//');
    if (block !== -1 && (lineComment === -1 || block < lineComment)) {
      out += rest.slice(0, block);
      rest = rest.slice(block + 2);
      state.inBlock = true;
      continue;
    }
    out += lineComment === -1 ? rest : rest.slice(0, lineComment);
    return out;
  }
}

describe('i18n 使用面', () => {
  it('源码里用到的 key 都在 zh 中定义', () => {
    const missing = new Map<string, string[]>();
    for (const [file, text] of files) {
      text.split(/\r?\n/).forEach((line, i) => {
        for (const m of line.matchAll(/\b(?:t|translate)\(\s*'([^']+)'/g)) {
          if (zh[m[1]] !== undefined) continue;
          // 拼接出来的 key 无法静态判定，跳过
          if (line.includes('${')) continue;
          const where = `${file.replace('../', 'src/')}:${i + 1}`;
          missing.set(m[1], [...(missing.get(m[1]) ?? []), where]);
        }
      });
    }
    expect([...missing].map(([k, w]) => `${k} ← ${w.join(', ')}`)).toEqual([]);
  });

  it('界面代码里没有硬编码中文文案（注释除外）', () => {
    const hits: string[] = [];
    for (const [file, text] of files) {
      const state = { inBlock: false };
      text.split(/\r?\n/).forEach((line, i) => {
        const code = stripComments(line, state).trim();
        if (CJK.test(code)) hits.push(`${file.replace('../', 'src/')}:${i + 1}: ${code.slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
