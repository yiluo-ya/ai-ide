/**
 * 快速打开（QuickOpen）的模糊匹配打分：档位 + 修正项。
 *
 * 打分最容易悄悄退化（一个系数改大就把精确匹配挤下去），所以钉在单测里：
 * - 档位次序不变量：精确 > 文件名前缀 > 路径前缀 > 文件名子串 > 路径子串，
 *   所有修正项之和都跨不过档距（100）；
 * - 三项修正各自生效：basename 命中、路径深度惩罚、邻近（同目录 / 同目录树）、最近使用；
 * - 排序稳定：同分按路径字典序，条数上限 60。
 *
 * 组件交互（键盘、快捷键、渲染）仍归 `npm run test:ui`，这里只测纯函数。
 */
import { describe, expect, it } from 'vitest';
import { QUICKOPEN_LIMIT, QUICKOPEN_WEIGHTS, rankFiles, score } from './QuickOpen';

describe('score：基础档位', () => {
  it('精确匹配 > 文件名前缀 > 整路径前缀 > 文件名子串 > 路径子串', () => {
    const exact = score('src/gateway.ts', 'src/gateway.ts');
    const namePrefix = score('src/gateway.ts', 'gate');
    const pathPrefix = score('gateway/handler.ts', 'gateway/');
    const nameSubstr = score('src/my-gateway.ts', 'gateway');
    const pathSubstr = score('my-gateway/x.ts', 'gateway/');
    expect(exact).toBeGreaterThan(namePrefix);
    expect(namePrefix).toBeGreaterThan(pathPrefix);
    expect(pathPrefix).toBeGreaterThan(nameSubstr);
    expect(nameSubstr).toBeGreaterThan(pathSubstr);
  });

  it('不匹配返回 0；空查询不做过滤（返回 1）', () => {
    expect(score('src/a.ts', 'zzz')).toBe(0);
    expect(score('src/a.ts', '')).toBe(1);
  });

  it('不变量：全部正修正之和跨不过最小档距，且精确档下界仍高于文件名前缀档上界', () => {
    const maxPositive =
      QUICKOPEN_WEIGHTS.basenameHit +
      QUICKOPEN_WEIGHTS.maxSharedPrefixLevels * QUICKOPEN_WEIGHTS.sharedPrefixPerLevel +
      QUICKOPEN_WEIGHTS.sameDir +
      QUICKOPEN_WEIGHTS.recent;
    const minTierGap = QUICKOPEN_WEIGHTS.basenamePrefix - QUICKOPEN_WEIGHTS.pathPrefix;
    expect(maxPositive).toBeLessThan(minTierGap);
    // 精确档的最小值（被深度惩罚到封顶）仍高于「文件名前缀 + 吃满正修正」
    const exactFloor = QUICKOPEN_WEIGHTS.exact - QUICKOPEN_WEIGHTS.maxDepthLevels * QUICKOPEN_WEIGHTS.depthPerLevel;
    const namePrefixCeil = QUICKOPEN_WEIGHTS.basenamePrefix + maxPositive;
    expect(exactFloor).toBeGreaterThan(namePrefixCeil);
  });
});

describe('score：(a) basename 命中 vs 目录段命中', () => {
  it('深路径里的文件名命中仍压过浅路径的目录段命中', () => {
    const deepBasename = score('a/b/c/d/e/feature.ts', 'feature');
    const shallowDir = score('feature/x.ts', 'feature');
    expect(deepBasename).toBeGreaterThan(shallowDir);
  });

  it('同深度同长度时，命中落在 basename 比落在目录段更靠前', () => {
    const nameHit = score('src/ab/gatewayx.ts', 'gateway');
    const dirHit = score('src/ab/gateway/xzzzz.ts', 'gateway');
    expect(nameHit).toBeGreaterThan(dirHit);
  });
});

describe('score：(b) 路径深度惩罚', () => {
  it('同档同 basename，浅路径得分更高', () => {
    const shallow = score('m.ts', 'm.ts');
    const deep = score('a/b/c/d/e/m.ts', 'm.ts');
    expect(shallow).toBeGreaterThan(deep);
  });

  it('惩罚逐层累加且封顶（不超过 maxDepthLevels 层）', () => {
    const one = score('a/m.ts', 'm.ts');
    const two = score('a/b/m.ts', 'm.ts');
    expect(one - two).toBeCloseTo(QUICKOPEN_WEIGHTS.depthPerLevel, 5);
    // 超过封顶层数的两条路径，惩罚相同
    const deepA = score(`${'a/'.repeat(20)}m.ts`, 'm.ts');
    const deepB = score(`${'a/'.repeat(30)}m.ts`, 'm.ts');
    expect(deepA).toBeCloseTo(deepB, 5);
  });

  it('深度惩罚（小系数）不会淹没文件名前缀这样的强命中', () => {
    const veryDeepButNamed = score(`${'d/'.repeat(12)}gateway.ts`, 'gateway');
    const shallowDirHit = score('gateway/x.ts', 'gateway');
    expect(veryDeepButNamed).toBeGreaterThan(shallowDirHit);
  });
});

describe('score：(c) 邻近加成', () => {
  const ctx = { currentFile: 'src/core/gateway.ts' };

  it('同目录候选优先于邻目录候选', () => {
    const sameDir = score('src/core/handler.ts', 'andler', ctx);
    const otherDir = score('src/util/handler.ts', 'andler', ctx);
    expect(sameDir).toBeGreaterThan(otherDir);
  });

  it('同目录树共享更长前缀的候选也更靠前，但弱于同目录（深度一致，排除深度惩罚干扰）', () => {
    const sameDir = score('src/core/sub/x-handler.ts', 'andler', ctx);
    const sameTree = score('src/other/sub/x-handler.ts', 'andler', ctx);
    const unrelated = score('lib/other/sub/x-handler.ts', 'andler', ctx);
    expect(sameDir).toBeGreaterThan(sameTree);
    expect(sameTree).toBeGreaterThan(unrelated);
  });

  it('没有 currentFile 时不做邻近加成（行为与旧版一致）', () => {
    expect(score('src/core/handler.ts', 'andler', {})).toBeLessThan(score('src/core/handler.ts', 'andler', ctx));
  });
});

describe('score：(d) 最近使用加成', () => {
  const recent = ['src/zeta.ts', 'src/eta.ts'];

  it('recent 命中加固定分', () => {
    const withRecent = score('src/zeta.ts', 'zeta', { recent });
    const without = score('src/zeta.ts', 'zeta');
    expect(withRecent - without).toBeCloseTo(QUICKOPEN_WEIGHTS.recent, 5);
  });

  it('recent 加成压不过精确匹配', () => {
    // 非精确档吃满正修正（recent + 同目录 + 共享前缀 + basename 命中）也越不过精确档下界
    const exact = score('a/b/c/match.ts', 'a/b/c/match.ts', {
      recent: ['src/target.ts'],
      currentFile: 'src/target.ts',
    });
    const boosted = score('src/target.ts', 'target', { recent: ['src/target.ts'], currentFile: 'src/target.ts' });
    expect(exact).toBeGreaterThan(boosted);
  });
});

describe('rankFiles：排序与上限', () => {
  it('分数相同按路径字典序（结果不随输入顺序抖动）', () => {
    const a = rankFiles(['b/x.ts', 'a/x.ts', 'c/x.ts'], 'x.ts');
    const b = rankFiles(['c/x.ts', 'a/x.ts', 'b/x.ts'], 'x.ts');
    expect(a).toEqual(['a/x.ts', 'b/x.ts', 'c/x.ts']);
    expect(b).toEqual(a);
  });

  it('过滤不匹配项，条数上限保持 60', () => {
    const files = Array.from({ length: 100 }, (_, i) => `dir/f${String(i).padStart(3, '0')}.ts`);
    expect(rankFiles(files, 'f').length).toBe(QUICKOPEN_LIMIT);
    expect(rankFiles(['src/a.ts', 'src/b.ts'], 'zzz')).toEqual([]);
  });

  it('最近用过的非精确匹配排在其它非精确匹配之前', () => {
    const out = rankFiles(['src/other-target.ts', 'src/target.ts'], 'target', { recent: ['src/target.ts'] });
    expect(out).toEqual(['src/target.ts', 'src/other-target.ts']);
  });
});
