/** 测试夹具：在系统临时目录里造一个项目并建索引。 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectIndex } from '../src/indexer/store';
import {
  gotoDefinition,
  findReferences,
  documentSymbols,
  workspaceSymbols,
  highlightSpans,
  hover,
  fileDensity,
} from '../src/indexer/resolver';
import type { Position } from '../../shared/types';

export interface Fixture {
  project: ProjectIndex;
  root: string;
  cleanup: () => Promise<void>;
}

export interface FixtureOptions {
  /** 是否写索引快照（默认 false：测试不污染 data/）。 */
  persist?: boolean;
  /** 快照 / 索引缓存落盘目录（persist=true 时必填）。 */
  dataDir?: string;
  /** 并行解析 worker 数（默认 0 = 串行，测试更快更稳）。 */
  workers?: number;
}

/**
 * 在临时目录里造一个项目并建索引。
 * 默认 persist:false / workers:0，避免测试写盘与起 worker（需要时显式传）。
 */
export async function makeProject(
  files: Record<string, string | Buffer>,
  opts: FixtureOptions = {},
): Promise<Fixture> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
  }
  const project = new ProjectIndex('test', 'test', root.split(path.sep).join('/'), Date.now(), {
    persist: opts.persist ?? false,
    dataDir: opts.dataDir,
    workers: opts.workers ?? 0,
  });
  await project.reindexAll();
  return {
    project,
    root,
    cleanup: async () => {
      project.dispose();
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

/** 临时快照目录（测试用；调用方负责清理）。 */
export async function makeDataDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-data-'));
}

/** 找到文件里某个子串首次出现的 1-based 行列。 */
export function locate(project: ProjectIndex, file: string, needle: string, occurrence = 0): Position {
  const fi = project.files.get(file);
  if (!fi) throw new Error(`not indexed: ${file}`);
  let from = 0;
  let idx = -1;
  for (let i = 0; i <= occurrence; i++) {
    idx = fi.source.indexOf(needle, from);
    if (idx < 0) throw new Error(`not found in ${file}: ${needle} (#${occurrence})`);
    from = idx + 1;
  }
  return fi.text.position(idx);
}

export {
  gotoDefinition,
  findReferences,
  documentSymbols,
  workspaceSymbols,
  highlightSpans,
  hover,
  fileDensity,
};

export const loc = (file: string, line: number, col: number) => ({ file, line, col });
