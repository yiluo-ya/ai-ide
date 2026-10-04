/**
 * FR-0007 定位链单测：候选顺序（手填 > 落点 > PATH）、目录型路径展开候选名、
 * Windows 上 `.cmd` / `.exe` 的启动方式、「一个都没找到」的文案。
 *
 * 不真跑 pi：候选文件都是临时目录里的空文件；测「找不到」时先把 PATH 掐掉
 * （本机装着真 pi，不掐掉这一条在开发机上不成立）。
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const WIN = process.platform === 'win32';
/** 落点 / 手填目录里那个候选文件名（按平台）。 */
const PI_NAME = WIN ? 'pi.cmd' : 'pi';

let dataDir = '';
let manualDir = '';
// 必须先把 READER_DATA_DIR 定好再导入（config 在模块加载时求值），所以动态导入
let rt!: typeof import('../src/agent/runtime');
let cfg!: typeof import('../src/agent/runtime-config');

before(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-agent-runtime-'));
  manualDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-agent-manual-'));
  process.env.READER_DATA_DIR = dataDir;
  delete process.env.READER_PI_COMMAND;
  rt = await import('../src/agent/runtime');
  cfg = await import('../src/agent/runtime-config');
});

after(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true });
  await fsp.rm(manualDir, { recursive: true, force: true });
});

/** 在某个目录下造一个空文件（当作「装在这儿的 pi」），返回绝对路径。 */
async function put(dir: string, rel: string): Promise<string> {
  const file = path.join(dir, ...rel.split('/'));
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, '');
  return file;
}

/** 清掉落点目录（用例之间互不串味）。 */
async function clearAgentsDir(): Promise<void> {
  await fsp.rm(rt.piAgentsDir(), { recursive: true, force: true });
}

/** 临时把 PATH 掐掉再跑 fn。 */
function withoutPath<T>(fn: () => T): T {
  const saved = process.env.PATH;
  process.env.PATH = '';
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
  }
}

test('候选顺序：手填路径 > 落点目录 > PATH', async () => {
  await clearAgentsDir();
  const manual = await put(manualDir, PI_NAME);
  const landed = await put(rt.piAgentsDir(), PI_NAME);

  const chosen = rt.resolvePiRuntime({ piPath: manualDir });
  assert.equal(chosen.source, 'config');
  assert.equal(chosen.target, manual);

  // 不填路径时用落点（A2 的判定逻辑：放进去就认，不用改配置）
  const fromAgents = rt.resolvePiRuntime({ piPath: '' });
  assert.equal(fromAgents.source, 'agents');
  assert.equal(fromAgents.target, landed);
});

test('手填目录：按落点候选名展开（含 npm 前缀安装的 node_modules/.bin）', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-agent-prefix-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const direct = await put(dir, PI_NAME);
  const shim = await put(dir, `node_modules/.bin/${PI_NAME}`);

  const targets = rt
    .piCandidates({ piPath: dir })
    .filter((c) => c.source === 'config')
    .map((c) => c.target);
  assert.deepEqual(targets, [direct, shim]);
});

test('Windows：.cmd 走 cmd.exe（/d /s /c），.exe 直启', async (t) => {
  if (!WIN) {
    t.skip('只在 Windows 上有意义');
    return;
  }
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-agent-win-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const cmd = await put(dir, 'pi.cmd');
  const exe = await put(dir, 'pi.exe');

  const viaCmd = rt.resolvePiRuntime({ piPath: cmd }, ['--version']);
  assert.equal(viaCmd.verbatim, true);
  assert.equal(path.basename(viaCmd.command).toLowerCase(), 'cmd.exe');
  assert.deepEqual(viaCmd.prefixArgs.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(viaCmd.prefixArgs[3], `""${cmd}" --version"`);

  // 含空格的路径要「外层引号 + 路径引号」，否则 cmd 会在空格处断开（2026-10-03 实测）
  const spaced = await put(dir, 'pi home/pi.cmd');
  const viaSpaced = rt.resolvePiRuntime({ piPath: spaced });
  assert.equal(viaSpaced.prefixArgs[3], `""${spaced}""`);

  const viaExe = rt.resolvePiRuntime({ piPath: exe }, ['--version']);
  assert.equal(viaExe.command, exe);
  assert.deepEqual(viaExe.prefixArgs, ['--version']);
  assert.equal(viaExe.verbatim, false);
});

test('一个都找不到：文案含落点绝对路径与两条安装命令（A4 的判定逻辑）', async () => {
  await clearAgentsDir();
  const runtime = withoutPath(() => rt.resolvePiRuntime({ piPath: path.join(dataDir, 'no-such-pi') }));
  assert.equal(runtime.resolved, false);
  assert.equal(runtime.target, 'pi'); // 兜底裸名，交给系统碰运气（行为与 FR 之前一致）

  const hint = rt.piInstallHint();
  const message = rt.piNotFoundMessage();
  assert.ok(message.includes(hint.dir), '文案要含落点绝对路径');
  assert.ok(message.includes(hint.globalCommand), '文案要含全局安装命令');
  assert.ok(message.includes(hint.prefixCommand), '文案要含落点安装命令');
  assert.ok(!message.includes('\n'), '单行：错误会经 HTTP 消息直接显示在界面上');
});

test('环境变量 READER_PI_COMMAND 优先级最高（D1）', async () => {
  await clearAgentsDir();
  await put(manualDir, PI_NAME);
  process.env.READER_PI_COMMAND = 'my-pi';
  try {
    const chosen = rt.resolvePiRuntime({ piPath: manualDir });
    assert.equal(chosen.source, 'env');
    assert.equal(chosen.target, 'my-pi');
  } finally {
    delete process.env.READER_PI_COMMAND;
  }
});

test('配置读写：非法 JSON 当空配置', async (t) => {
  const file = path.join(dataDir, 'agent-runtime.json');
  process.env.READER_AGENT_RUNTIME = file;
  t.after(() => {
    delete process.env.READER_AGENT_RUNTIME;
    return fsp.rm(file, { force: true });
  });

  assert.deepEqual(await cfg.readAgentRuntimeConfig(), { piPath: '' });
  await cfg.writeAgentRuntimeConfig({ piPath: `  ${manualDir}  ` });
  assert.deepEqual(await cfg.readAgentRuntimeConfig(), { piPath: manualDir });

  await fsp.writeFile(file, '{ 不是合法 JSON');
  assert.deepEqual(await cfg.readAgentRuntimeConfig(), { piPath: '' });
});
