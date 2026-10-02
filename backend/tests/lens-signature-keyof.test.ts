/** 02-lens 收尾：L3d 压平签名（多行合并一行）。 */
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
): HoverResult {
  const pos = locate(project, file, needle);
  return hover(project, file, pos.line, pos.col + dCol);
}

test('detail: TS 多行函数签名压平为一行且参数齐全（L3d）', async () => {
  const fx = await makeProject({
    'a.ts': `export function resolveRef(
  project: ProjectIndex,
  fi: FileIndex,
  ref: RefRecord,
  seen: Set<string> = new Set(),
  deep = false,
): string {
  return "x";
}

interface Config {
  getTimeout(name: string, fallback: number): number;
}
`,
  });
  try {
    const fn = hoverAt(fx.project, 'a.ts', 'resolveRef');
    assert.equal(fn.reason, 'resolved');
    assert.equal(
      fn.definitions![0].signature,
      'function resolveRef(project: ProjectIndex, fi: FileIndex, ref: RefRecord, ' +
        'seen: Set<string> = new Set(), deep = false): string',
    );
    assert.equal(fn.definitions![0].signature!.includes('\n'), false);

    // interface 方法以 `;` 结束，不吞 body
    const method = hoverAt(fx.project, 'a.ts', 'getTimeout');
    assert.equal(
      method.definitions![0].signature,
      'getTimeout(name: string, fallback: number): number',
    );
  } finally {
    await fx.cleanup();
  }
});
