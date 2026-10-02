/** L10 整文件密度：固定 20 行分段、代码 / 注释 / 空白占比、段内主要符号。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, fileDensity } from './helpers';
import { DENSITY_SEGMENT_SIZE } from '../src/indexer/resolver';

/** 占比是浮点数，比较留一个极小容差。 */
const closeTo = (actual: number, expected: number, label: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);

const D = {
  'd.py': `# 文件说明
# 第二行注释

def alpha():
    """doc"""
    return 1


def beta():
    return 2

# 一段注释
# 又一段注释
x = 1
`,
};

test('density: 分段数 / 三类占比 / 段内主要符号', async () => {
  const fx = await makeProject(D);
  try {
    const result = fileDensity(fx.project, 'd.py');

    assert.equal(result.file, 'd.py');
    assert.equal(result.totalLines, 15);
    assert.equal(result.segmentSize, 20);
    assert.equal(result.segmentSize, DENSITY_SEGMENT_SIZE);
    assert.equal(result.segments.length, 1);
    assert.equal(result.revision, String(fx.project.indexVersion));

    const seg = result.segments[0];
    assert.deepEqual({ startLine: seg.startLine, endLine: seg.endLine }, { startLine: 1, endLine: 15 });
    // 注释 4 行（# 开头）、空白 5 行、其余 6 行算代码（含 docstring 那一行）
    closeTo(seg.comment, 4 / 15, 'comment');
    closeTo(seg.blank, 5 / 15, 'blank');
    closeTo(seg.code, 6 / 15, 'code');
    assert.deepEqual(seg.symbols, ['alpha', 'beta', 'x'], '按行序取前 3 个非局部定义名');
  } finally {
    await fx.cleanup();
  }
});
