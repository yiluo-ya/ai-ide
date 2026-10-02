/** 语义着色：项目内定义与跨文件调用的符号提亮。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, highlightSpans, locate } from './helpers';
import type { ProjectIndex } from '../src/indexer/store';

const FILES = {
  'service.py': `import os
from util import helper


def handle_user(user):
    print(helper(user))
    return os.path.join(user, "x")
`,
  'util.py': `def helper(value):
    return value
`,
};

/** 扁平数组 → 可读的着色条目。 */
const KIND_NAME = ['project', 'external', 'local'] as const;
type KindName = (typeof KIND_NAME)[number];

function spansOf(project: ProjectIndex, file: string) {
  const data = highlightSpans(project, file);
  const out: Array<{ line: number; col: number; len: number; kind: KindName }> = [];
  for (let i = 0; i + 3 < data.length; i += 4) {
    out.push({
      line: data[i],
      col: data[i + 1],
      len: data[i + 2],
      kind: KIND_NAME[data[i + 3]],
    });
  }
  return out;
}

/** 在着色结果里找覆盖某位置的条目。 */
function kindAt(
  spans: ReturnType<typeof spansOf>,
  line: number,
  col: number,
): KindName | undefined {
  return spans.find((s) => s.line === line && col >= s.col && col < s.col + s.len)?.kind;
}

test('highlight: 项目内定义与跨文件调用的符号提亮', async () => {
  const fx = await makeProject(FILES);
  try {
    const spans = spansOf(fx.project, 'service.py');

    // 本文件定义的函数 handle_user
    const def = locate(fx.project, 'service.py', 'handle_user');
    assert.equal(kindAt(spans, def.line, def.col), 'project', '本项目定义应提亮');

    // 从 util 导入的 helper 的调用点
    const call = locate(fx.project, 'service.py', 'helper(user)');
    assert.equal(kindAt(spans, call.line, call.col), 'project', '项目内跨文件调用应提亮');
  } finally {
    await fx.cleanup();
  }
});
