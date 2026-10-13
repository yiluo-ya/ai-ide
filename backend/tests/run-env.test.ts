/**
 * FR-0011：Python 运行环境探测（项目根 .venv / venv / env + conda-meta）。
 *
 * 断言方向：
 * 1) 没有虚拟环境 → `path: null`（交给 PATH 上的 python）；
 * 2) 虚拟环境里的解释器 → 返回**绝对**路径，且优先级 .venv > venv > env；
 * 3) 同名目录存在但没有解释器 → 不误报（继续往下找）；
 * 4) conda-meta → `conda`（交给已激活的 conda 环境）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectPythonEnv } from '../src/indexer/run-env';

const WIN = process.platform === 'win32';
/** 当前平台上虚拟环境里解释器的相对位置。 */
const PY = WIN ? 'Scripts/python.exe' : 'bin/python';
const PY3 = 'bin/python3';

const roots: string[] = [];

/** 造一个临时项目根；dirs 建成空目录，files 写成空文件。 */
async function makeRoot(dirs: string[], files: string[]): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-runenv-'));
  roots.push(root);
  for (const rel of dirs) await fsp.mkdir(path.join(root, ...rel.split('/')), { recursive: true });
  for (const rel of files) {
    const abs = path.join(root, ...rel.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, '');
  }
  return root;
}

after(async () => {
  for (const r of roots) await fsp.rm(r, { recursive: true, force: true });
});

test('没有虚拟环境 → 交给 PATH', async () => {
  const root = await makeRoot([], ['app.py', 'README.md']);
  assert.deepEqual(detectPythonEnv(root), { path: null, source: 'path' });
});

test('.venv 里有解释器 → 返回绝对路径', async () => {
  const root = await makeRoot([], [`.venv/${PY}`]);
  const env = detectPythonEnv(root);
  assert.equal(env.source, 'venv');
  assert.ok(env.path, '应给出解释器路径');
  assert.ok(path.isAbsolute(env.path), '必须是绝对路径');
  assert.ok(env.path.endsWith(path.join('.venv', ...PY.split('/'))), `路径不该是别处：${env.path}`);
});

test('venv / env 同样认得（前者优先）', async () => {
  const a = await makeRoot([], [`venv/${PY}`]);
  assert.equal(detectPythonEnv(a).source, 'venv');
  assert.ok(detectPythonEnv(a).path?.endsWith(path.join('venv', ...PY.split('/'))), `应命中 venv：${detectPythonEnv(a).path}`);

  const b = await makeRoot([], [`env/${PY}`]);
  assert.equal(detectPythonEnv(b).source, 'venv');
  assert.ok(detectPythonEnv(b).path?.endsWith(path.join('env', ...PY.split('/'))), `应命中 env：${detectPythonEnv(b).path}`);
});

test('优先级 .venv > venv > env', async () => {
  const root = await makeRoot([], [`.venv/${PY}`, `venv/${PY}`, `env/${PY}`]);
  const env = detectPythonEnv(root);
  assert.ok(env.path?.includes(`${path.sep}.venv${path.sep}`), `应命中 .venv：${env.path}`);
});

test('目录在但里面没有解释器 → 不误报，继续回落', async () => {
  const root = await makeRoot(['.venv', 'venv'], ['app.py']);
  assert.deepEqual(detectPythonEnv(root), { path: null, source: 'path' });
});

test('conda-meta → conda（交给 PATH 上已激活的环境）', async () => {
  const root = await makeRoot(['conda-meta'], []);
  assert.deepEqual(detectPythonEnv(root), { path: null, source: 'conda' });
});

test('venv 优先于 conda-meta', async () => {
  const root = await makeRoot(['conda-meta'], [`.venv/${PY}`]);
  assert.equal(detectPythonEnv(root).source, 'venv');
});

test('.venv 缺解释器时退回 venv 里的那个', async () => {
  const root = await makeRoot(['.venv'], [`venv/${PY}`]);
  const env = detectPythonEnv(root);
  assert.equal(env.source, 'venv');
  assert.ok(env.path?.includes(`${path.sep}venv${path.sep}`), `应命中 venv：${env.path}`);
});

test(
  'POSIX：bin/python 缺失时退回 bin/python3',
  { skip: WIN ? '仅 POSIX 有 python3 这个命名' : false },
  async () => {
    const root = await makeRoot([], [`.venv/${PY3}`]);
    const env = detectPythonEnv(root);
    assert.equal(env.source, 'venv');
    assert.ok(env.path?.endsWith(path.join('.venv', ...PY3.split('/'))), `应命中 python3：${env.path}`);
  },
);
