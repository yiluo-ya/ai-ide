/** 透镜（悬停）：定义悬停的名字 / 种类 / 容器 / 位置 / 签名 / 引用数（L3a-L3e）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, locate, hover } from './helpers';
import type { ProjectIndex } from '../src/indexer/store';
import type { HoverResult } from '../../shared/types';

/** 在某个子串（可加列偏移）处悬停。 */
function hoverAt(
  project: ProjectIndex,
  file: string,
  needle: string,
  dCol = 0,
  occ = 0,
): HoverResult {
  const pos = locate(project, file, needle, occ);
  return hover(project, file, pos.line, pos.col + dCol);
}

const PY = {
  'service.py': `import os
from util import helper


@cache
def handle_user(user):
    """按用户处理。"""
    print(helper(user))
    path = os.path.join(user, "x")
    return path


def plain():
    obj = helper("60", 2)
    return obj.compute(1)


# 直接上方的说明
def commented():
    return 1


# 隔了空行

def spaced():
    return 2
`,
  'util.py': `def helper(value: str, n: int = 1) -> bool:
    """helper 的说明。"""
    return True
`,
};

test('hover: 定义悬停给出名字 / 种类 / 容器 / 位置 / 签名 / 引用数（L3a-L3e）', async () => {
  const fx = await makeProject(PY);
  try {
    const at = locate(fx.project, 'service.py', 'handle_user');
    const r = hoverAt(fx.project, 'service.py', 'handle_user');

    assert.equal(r.reason, 'resolved');
    assert.equal(r.symbol, 'handle_user');
    assert.equal(r.message, null);
    assert.equal(r.definitions?.length, 1);

    const d = r.definitions![0];
    assert.equal(d.name, 'handle_user');
    assert.equal(d.kind, 'function');
    assert.equal(d.containerName, null);
    assert.equal(d.signature, 'def handle_user(user)');
    assert.equal(d.location.file, 'service.py');
    assert.equal(d.location.range.start.line, at.line);
    assert.equal(d.location.range.start.col, at.col);
    assert.equal(d.location.range.end.col - d.location.range.start.col, 'handle_user'.length);
    assert.equal(d.local, false);
    assert.equal(d.refCount, 0);
  } finally {
    await fx.cleanup();
  }
});
