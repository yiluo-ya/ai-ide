/**
 * 运行环境探测（FR-0011）：给「在终端中运行」挑 Python 解释器。
 *
 * 只看**项目根**，不递归、不向上找（与 FR 的 D9 一致）：
 * - `.venv` / `venv` / `env` 目录 → Windows 取 `Scripts/python.exe`，其它平台取 `bin/python`（退回 `python3`）；
 * - `conda-meta` 目录 → 说明根就是某个 conda 环境，交给 PATH（该环境已在终端里生效）；
 * - 都没有 → 交给 PATH 上的 `python`。
 *
 * 返回 null 路径时**不代表失败**：前端会写裸 `python`，由终端会话的 PATH 决定用哪个解释器。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface PythonEnv {
  /** 解释器绝对路径；null = 用 PATH 上的 python。 */
  path: string | null;
  /** 来源：项目内虚拟环境 / conda 环境根 / PATH。 */
  source: 'venv' | 'conda' | 'path';
}

/** 探测顺序（前者优先）。 */
const VENV_DIRS = ['.venv', 'venv', 'env'];

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 探测项目根的 Python 环境。root 可用正斜杠（registry 存的形态）。 */
export function detectPythonEnv(root: string): PythonEnv {
  for (const dir of VENV_DIRS) {
    const base = path.join(root, dir);
    if (!isDir(base)) continue;
    const candidates =
      process.platform === 'win32'
        ? [path.join(base, 'Scripts', 'python.exe')]
        : [path.join(base, 'bin', 'python'), path.join(base, 'bin', 'python3')];
    for (const candidate of candidates) {
      if (isFile(candidate)) return { path: candidate, source: 'venv' };
    }
  }
  if (isDir(path.join(root, 'conda-meta'))) return { path: null, source: 'conda' };
  return { path: null, source: 'path' };
}
