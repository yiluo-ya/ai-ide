/**
 * FR-0008（2026-10-10）：编辑器写文件 + 文件树删除（系统回收站）。
 *
 * 四条断言方向：
 * 1) 写：真的落到磁盘（读回来复核），且回执带新的 mtime；
 * 2) 冲突：`baseMtimeMs` 与磁盘不一致 → 409，且**没有**写进去（原内容还在）；
 * 3) 边界：越界 400、目录 400、超限 413；
 * 4) 删：文件与目录都从源路径消失；越界 400；根目录 400。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/api/routes';
import type { Hono } from 'hono';
import { ProjectRegistry } from '../src/registry';
import type { ProjectIndex } from '../src/indexer/store';
import { makeProject, type Fixture } from './helpers';
import { createFileEntry, createDirEntry, copyEntry, isValidEntryName, MAX_WRITE_BYTES, renameEntry, revealCommand, revealInFileManager, trashEntry, writeProjectFile } from '../src/indexer/fswrite';

const WIN = process.platform === 'win32';

interface Boot {
  fx: Fixture;
  app: Hono;
  id: string;
  index: ProjectIndex;
  cleanup: () => Promise<void>;
}

async function boot(): Promise<Boot> {
  const fx = await makeProject({
    'src/a.ts': 'export const a = 1;\n',
    'src/sub/b.ts': 'export const b = 2;\n',
    'notes.txt': 'hello\n',
  });
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-fswrite-data-'));
  const registry = new ProjectRegistry(dataDir);
  const app = createApp(registry);
  const created = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: fx.root, name: 'fswrite-demo' }),
  });
  const { project } = (await created.json()) as { project: { id: string } };
  const index = registry.get(project.id)!;
  for (let i = 0; i < 200 && index.status.indexing; i++) await new Promise((r) => setTimeout(r, 20));
  return {
    fx,
    app,
    id: project.id,
    index,
    cleanup: async () => {
      registry.closeAll();
      fx.project.dispose();
      await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
      await fx.cleanup();
    },
  };
}

const absOf = (fx: Fixture, rel: string) => path.join(fx.root, ...rel.split('/'));

function put(app: Hono, id: string, body: Record<string, unknown>) {
  return app.request(`/api/projects/${id}/file`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('fswrite: 写文件真的落盘，回执带新 mtime，GET 也跟着变', async () => {
  const b = await boot();
  try {
    const before = (await (await b.app.request(`/api/projects/${b.id}/file?path=notes.txt`)).json()) as {
      text: string;
      mtimeMs: number | null;
    };
    assert.equal(before.text, 'hello\n');
    assert.equal(typeof before.mtimeMs, 'number');

    const res = await put(b.app, b.id, {
      path: 'notes.txt',
      text: 'hello\nworld\n',
      baseMtimeMs: before.mtimeMs,
    });
    assert.equal(res.status, 200, await res.clone().text());
    const body = (await res.json()) as { ok: true; size: number; mtimeMs: number };
    assert.equal(body.ok, true);
    assert.equal(body.size, Buffer.byteLength('hello\nworld\n', 'utf8'));

    // 不信回执自说自话：读磁盘复核
    assert.equal(await fsp.readFile(absOf(b.fx, 'notes.txt'), 'utf8'), 'hello\nworld\n');
    // 接口读的是**索引缓存**：写后要等索引刷新一步才看得到新正文（生产里由 watcher 推）。
    // 测试环境的 watcher 附着与写入有竞态，这里直接推一次索引，验「新正文能进接口」。
    await b.index.onFileChanged('notes.txt');
    const after = (await (await b.app.request(`/api/projects/${b.id}/file?path=notes.txt`)).json()) as {
      text: string;
      mtimeMs: number;
    };
    assert.equal(after.text, 'hello\nworld\n');
    assert.equal(after.mtimeMs, body.mtimeMs);
  } finally {
    await b.cleanup();
  }
});

test('fswrite: baseMtimeMs 不一致 → 409，且磁盘内容一点没动', async () => {
  const b = await boot();
  try {
    const before = (await (await b.app.request(`/api/projects/${b.id}/file?path=src/a.ts`)).json()) as {
      mtimeMs: number;
    };
    const res = await put(b.app, b.id, {
      path: 'src/a.ts',
      text: 'export const a = 999;\n',
      baseMtimeMs: before.mtimeMs - 5000, // 假装编辑器看到的是旧版本
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string; mtimeMs: number };
    assert.equal(body.error, 'file_conflict');
    assert.equal(typeof body.mtimeMs, 'number');
    assert.equal(await fsp.readFile(absOf(b.fx, 'src/a.ts'), 'utf8'), 'export const a = 1;\n');
  } finally {
    await b.cleanup();
  }
});

test('fswrite: 越界 / 目录 / 超大内容三类拒绝', async () => {
  const b = await boot();
  try {
    assert.equal((await put(b.app, b.id, { path: '../evil.txt', text: 'x' })).status, 400);
    assert.equal((await put(b.app, b.id, { path: 'src', text: 'x' })).status, 400);
    const huge = await put(b.app, b.id, { path: 'notes.txt', text: 'x'.repeat(MAX_WRITE_BYTES + 1) });
    assert.equal(huge.status, 413);
    // 目录没被当成文件写坏
    assert.equal(await fsp.readFile(absOf(b.fx, 'notes.txt'), 'utf8'), 'hello\n');
    assert.equal((await put(b.app, b.id, { text: 'no path' })).status, 400);
  } finally {
    await b.cleanup();
  }
});

test('fswrite: 删除文件与目录都从源路径消失（回收站不可用时如实 500）', async (t) => {
  const b = await boot();
  try {
    const fileRes = await b.app.request(`/api/projects/${b.id}/file?path=notes.txt`, { method: 'DELETE' });
    if (!WIN) {
      // 非 Windows 本版没有回收站实现：必须如实报错，而不是偷偷永久删
      assert.equal(fileRes.status, 500);
      const body = (await fileRes.json()) as { error: string };
      assert.equal(body.error, 'recycle_unsupported');
      t.diagnostic('非 Windows：回收站未实现，跳过真实删除断言');
      return;
    }
    assert.equal(fileRes.status, 200, await fileRes.clone().text());
    await assert.rejects(() => fsp.stat(absOf(b.fx, 'notes.txt')));

    const dirRes = await b.app.request(`/api/projects/${b.id}/file?path=src/sub`, { method: 'DELETE' });
    assert.equal(dirRes.status, 200, await dirRes.clone().text());
    await assert.rejects(() => fsp.stat(absOf(b.fx, 'src/sub')));
    // 目录之下的文件也不在了
    assert.equal(await fsp.readdir(absOf(b.fx, 'src')).then((r) => r.includes('sub')), false);
  } finally {
    await b.cleanup();
  }
});

test('fswrite: 删除的边界（越界 / 空路径 / 项目根）', async () => {
  const b = await boot();
  try {
    assert.equal((await b.app.request(`/api/projects/${b.id}/file?path=../evil`, { method: 'DELETE' })).status, 400);
    assert.equal((await b.app.request(`/api/projects/${b.id}/file`, { method: 'DELETE' })).status, 400);
    assert.equal((await b.app.request(`/api/projects/${b.id}/file?path=.`, { method: 'DELETE' })).status, 400);
  } finally {
    await b.cleanup();
  }
});

test('fswrite: 模块级 —— 不存在的路径写/删都如实失败', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-fswrite-'));
  try {
    const write = await writeProjectFile(path.join(root, 'nope.ts'), 'x');
    assert.equal(write.ok, false);
    assert.equal(write.ok === false && write.error, 'not_found');

    const trash = await trashEntry(path.join(root, 'nope.ts'));
    assert.equal(trash.ok, false);
    assert.equal(trash.ok === false && trash.error, 'not_found');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- FR-0009：新建 / 重命名 / 移动 / 复制

function post(app: Hono, id: string, route: string, body: Record<string, unknown>) {
  return app.request(`/api/projects/${id}/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 树里是否出现某条路径（后端返回的是嵌套 FileNode，直接找 path 字段）。 */
async function treeHas(app: Hono, id: string, rel: string): Promise<boolean> {
  const res = await app.request(`/api/projects/${id}/files`);
  const body = (await res.json()) as { tree: unknown };
  return JSON.stringify(body.tree).includes(`"path":"${rel}"`);
}

const maybe = (abs: string) =>
  fsp.stat(abs).then(
    (st) => st,
    () => null,
  );

test('fswrite: 新建文件与多级目录，都落盘且树里可见', async () => {
  const b = await boot();
  try {
    const file = await post(b.app, b.id, 'file', { path: 'src/new.ts' });
    assert.equal(file.status, 200, await file.clone().text());
    assert.equal(await fsp.readFile(absOf(b.fx, 'src/new.ts'), 'utf8'), '');
    assert.equal(await treeHas(b.app, b.id, 'src/new.ts'), true);

    const dir = await post(b.app, b.id, 'dir', { path: 'src/deep/nest' });
    assert.equal(dir.status, 200, await dir.clone().text());
    assert.equal((await fsp.stat(absOf(b.fx, 'src/deep/nest'))).isDirectory(), true);
    assert.equal(await treeHas(b.app, b.id, 'src/deep'), true);
  } finally {
    await b.cleanup();
  }
});

test('fswrite: 重名一律拒绝，已有内容一点不动', async () => {
  const b = await boot();
  try {
    const file = await post(b.app, b.id, 'file', { path: 'src/a.ts', text: 'OVERWRITTEN' });
    assert.equal(file.status, 409, await file.clone().text());
    assert.equal(((await file.json()) as { error: string }).error, 'exists');
    assert.equal(await fsp.readFile(absOf(b.fx, 'src/a.ts'), 'utf8'), 'export const a = 1;\n');

    const dir = await post(b.app, b.id, 'dir', { path: 'src' });
    assert.equal(dir.status, 409);
  } finally {
    await b.cleanup();
  }
});

test('fswrite: 重命名文件与目录（子树跟着搬，不留幽灵目录）', async () => {
  const b = await boot();
  try {
    const file = await post(b.app, b.id, 'rename', { from: 'notes.txt', to: 'notes2.txt' });
    assert.equal(file.status, 200, await file.clone().text());
    assert.equal(await maybe(absOf(b.fx, 'notes.txt')), null);
    assert.equal(await fsp.readFile(absOf(b.fx, 'notes2.txt'), 'utf8'), 'hello\n');

    const dir = await post(b.app, b.id, 'rename', { from: 'src/sub', to: 'src/sub2' });
    assert.equal(dir.status, 200, await dir.clone().text());
    assert.equal(await maybe(absOf(b.fx, 'src/sub')), null);
    assert.equal(await fsp.readFile(absOf(b.fx, 'src/sub2/b.ts'), 'utf8'), 'export const b = 2;\n');
    // 索引与文件树都跟着搬：旧路径不能再出现（否则就是幽灵目录）
    assert.equal(await treeHas(b.app, b.id, 'src/sub2/b.ts'), true);
    assert.equal(await treeHas(b.app, b.id, 'src/sub'), false);
  } finally {
    await b.cleanup();
  }
});

test('fswrite: 移动文件到别的目录 + 复制一份（文件 / 目录）', async () => {
  const b = await boot();
  try {
    const mv = await post(b.app, b.id, 'rename', { from: 'notes.txt', to: 'src/notes.txt' });
    assert.equal(mv.status, 200, await mv.clone().text());
    assert.equal(await maybe(absOf(b.fx, 'notes.txt')), null);
    assert.equal(await fsp.readFile(absOf(b.fx, 'src/notes.txt'), 'utf8'), 'hello\n');

    const cp = await post(b.app, b.id, 'copy', { from: 'src/a.ts', to: 'src/a copy.ts' });
    assert.equal(cp.status, 200, await cp.clone().text());
    assert.equal(await fsp.readFile(absOf(b.fx, 'src/a copy.ts'), 'utf8'), 'export const a = 1;\n');
    assert.equal(await fsp.readFile(absOf(b.fx, 'src/a.ts'), 'utf8'), 'export const a = 1;\n');

    const cpDir = await post(b.app, b.id, 'copy', { from: 'src/sub', to: 'src/sub copy' });
    assert.equal(cpDir.status, 200, await cpDir.clone().text());
    assert.equal(await fsp.readFile(absOf(b.fx, 'src/sub copy/b.ts'), 'utf8'), 'export const b = 2;\n');
  } finally {
    await b.cleanup();
  }
});

test('fswrite: 名字与路径的边界（非法名 / 忽略目录 / 越界 / 移进自身）', async () => {
  const b = await boot();
  try {
    // Windows 禁用字符、保留设备名、结尾点
    for (const bad of ['src/a<b.ts', 'src/bad.', 'src/CON', 'src/aux.txt']) {
      const res = await post(b.app, b.id, 'file', { path: bad });
      assert.equal(res.status, 400, `${bad} → ${await res.clone().text()}`);
      assert.equal(((await res.json()) as { error: string }).error, 'invalid_name');
    }
    // 忽略目录里不许写（包括藏在子目录里的 node_modules）
    const ignored = await post(b.app, b.id, 'file', { path: 'node_modules/x.ts' });
    assert.equal(ignored.status, 400);
    assert.equal(((await ignored.json()) as { error: string }).error, 'ignored_path');
    assert.equal((await post(b.app, b.id, 'dir', { path: 'src/node_modules/sub' })).status, 400);
    // 越界 / 空 / 根 / 缺参
    const escape = await post(b.app, b.id, 'file', { path: '../evil.txt' });
    assert.equal(escape.status, 400);
    assert.equal(((await escape.json()) as { error: string }).error, 'path_escape');
    const escapeRename = await post(b.app, b.id, 'rename', { from: 'notes.txt', to: '../outside.txt' });
    assert.equal(escapeRename.status, 400);
    assert.equal(((await escapeRename.json()) as { error: string }).error, 'path_escape');
    assert.equal(await fsp.readFile(absOf(b.fx, 'notes.txt'), 'utf8'), 'hello\n');
    assert.equal((await post(b.app, b.id, 'dir', { path: '.' })).status, 400);
    assert.equal((await post(b.app, b.id, 'file', {})).status, 400);
    // 移进自己的子树
    const self = await post(b.app, b.id, 'rename', { from: 'src/sub', to: 'src/sub/inner' });
    assert.equal(self.status, 400);
    assert.equal(((await self.json()) as { error: string }).error, 'into_self');
    assert.equal((await fsp.stat(absOf(b.fx, 'src/sub'))).isDirectory(), true);

    // 复制到自身 / 复制进自己的子树：都是 400，但错误码不同（前端要分开说人话）
    const same = await post(b.app, b.id, 'copy', { from: 'notes.txt', to: 'notes.txt' });
    assert.equal(same.status, 400);
    assert.equal(((await same.json()) as { error: string }).error, 'same_path');
    const copySelf = await post(b.app, b.id, 'copy', { from: 'src/sub', to: 'src/sub/inner' });
    assert.equal(copySelf.status, 400);
    assert.equal(((await copySelf.json()) as { error: string }).error, 'into_self');
  } finally {
    await b.cleanup();
  }
});

test('fswrite: Windows 上允许只改大小写（a.ts → A.ts）', async (t) => {
  if (!WIN) {
    t.diagnostic('非 Windows：跳过大小写改名');
    return;
  }
  const b = await boot();
  try {
    const res = await post(b.app, b.id, 'rename', { from: 'src/a.ts', to: 'src/A.ts' });
    assert.equal(res.status, 200, await res.clone().text());
    const names = await fsp.readdir(absOf(b.fx, 'src'));
    assert.equal(names.includes('A.ts'), true);
    assert.equal(names.includes('a.ts'), false);
  } finally {
    await b.cleanup();
  }
});

test('fswrite: 模块级 —— 新建 / 改名 / 复制的失败面与名字规则', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-fswrite2-'));
  try {
    const missingParent = await createFileEntry(path.join(root, 'nope', 'a.txt'));
    assert.equal(missingParent.ok === false && missingParent.error, 'no_parent');

    const made = await createFileEntry(path.join(root, 'a.txt'), 'x');
    assert.equal(made.ok, true);
    const again = await createFileEntry(path.join(root, 'a.txt'));
    assert.equal(again.ok === false && again.error, 'exists');

    const dirs = await createDirEntry(path.join(root, 'd1', 'd2'));
    assert.equal(dirs.ok, true);
    const dirAgain = await createDirEntry(path.join(root, 'd1', 'd2'));
    assert.equal(dirAgain.ok === false && dirAgain.error, 'exists');

    await createFileEntry(path.join(root, 'c.txt'), 'y');
    const ontoExisting = await renameEntry(path.join(root, 'a.txt'), path.join(root, 'c.txt'));
    assert.equal(ontoExisting.ok === false && ontoExisting.error, 'exists');
    const notFound = await renameEntry(path.join(root, 'ghost.txt'), path.join(root, 'z.txt'));
    assert.equal(notFound.ok === false && notFound.error, 'not_found');

    // 目录复制要带整棵子树
    await fsp.mkdir(path.join(root, 'src', 'sub'), { recursive: true });
    await fsp.writeFile(path.join(root, 'src', 'sub', 'f.ts'), 'body');
    const copied = await copyEntry(path.join(root, 'src'), path.join(root, 'src-copy'));
    assert.equal(copied.ok, true);
    assert.equal(await fsp.readFile(path.join(root, 'src-copy', 'sub', 'f.ts'), 'utf8'), 'body');
    const copyOnto = await copyEntry(path.join(root, 'src'), path.join(root, 'src-copy'));
    assert.equal(copyOnto.ok === false && copyOnto.error, 'exists');

    // 名字规则
    assert.equal(isValidEntryName('ok.ts'), true);
    assert.equal(isValidEntryName('.gitignore'), true);
    assert.equal(isValidEntryName('CON'), false);
    assert.equal(isValidEntryName('aux.txt'), false);
    assert.equal(isValidEntryName('a/b'), false);
    assert.equal(isValidEntryName('trailing.'), false);
    assert.equal(isValidEntryName(' pad '), false);
    assert.equal(isValidEntryName('..'), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('reveal: macOS / Linux 的命令形状（Windows 走 PowerShell 脚本，另测）', () => {
  assert.deepEqual(revealCommand('/w/ide/src/a.ts', false, 'darwin'), ['open', ['-R', '/w/ide/src/a.ts']]);
  assert.deepEqual(revealCommand('/w/ide/src', true, 'darwin'), ['open', ['/w/ide/src']]);

  // Linux 没有「选中」入口：目录直接开，文件开父目录
  assert.deepEqual(revealCommand('/w/ide/src', true, 'linux'), ['xdg-open', ['/w/ide/src']]);
  assert.deepEqual(revealCommand('/w/ide/src/a.ts', false, 'linux'), ['xdg-open', ['/w/ide/src']]);
});

test('reveal: 路径不存在时如实报 not_found（不会去叫资源管理器）', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-reveal-'));
  try {
    const ghost = await revealInFileManager(path.join(root, 'ghost.txt'));
    assert.equal(ghost.ok === false && ghost.error, 'not_found');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('reveal 路由: 越界 400、不存在 404（都不弹窗口）', async () => {
  const b = await boot();
  try {
    const escape = await b.app.request(`/api/projects/${b.id}/reveal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '../outside.ts' }),
    });
    assert.equal(escape.status, 400);
    assert.equal(((await escape.json()) as { error: string }).error, 'path_escape');

    const ghost = await b.app.request(`/api/projects/${b.id}/reveal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'no/such/file.ts' }),
    });
    assert.equal(ghost.status, 404);
  } finally {
    await b.cleanup();
  }
});
