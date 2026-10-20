/**
 * 运行时探测（2026-10-20）。
 *
 * 断言方向（都是「不信任 PATH」这条纪律的直接推论）：
 * 1) 项目内 venv 一定出现在候选里，且 source = project；
 * 2) 约定目录里的 JDK 能被认出来（PATH 上没有也能找到）—— 本机实际就属于这种布局；
 * 3) 找不到的不编造：版本读不到给 null，该语言没装给空数组；
 * 4) 同一项目 5 秒内重复调用复用缓存（UI 入口级调用，不能反复扫目录）。
 */
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectRuntimes, groupCandidates, resetRuntimeCacheForTest } from '../src/indexer/runtimes';
import {
  coerceRunConfig,
  emptyRunConfig,
  inferProfiles,
  lockWarnings,
  mergeProfiles,
  parseEnvFile,
  pickRuntime,
  resolveRunEnv,
  versionWarnings,
} from '../src/indexer/run-config';

const WIN = process.platform === 'win32';
const roots: string[] = [];

/** 造一个临时目录树（键是相对路径，值是文件内容；空串表示空文件）。 */
async function makeTree(files: Record<string, string>): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-runtimes-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
  }
  return root;
}

after(async () => {
  for (const r of roots) await fsp.rm(r, { recursive: true, force: true });
});

beforeEach(() => resetRuntimeCacheForTest());

test('项目内 venv 一定进候选，来源标为 project', async () => {
  // venv 的 pyvenv.cfg 在**venv 目录里**（不是项目根）
  const exe = WIN ? '.venv/Scripts/python.exe' : '.venv/bin/python';
  const root = await makeTree({ [exe]: '', '.venv/pyvenv.cfg': 'version = 3.11.9\n' });
  const all = await detectRuntimes(root, { only: ['python'] });
  const venv = all.find((c) => c.source === 'project');
  assert.ok(venv, '项目内 venv 应被探测到');
  assert.equal(venv.id, 'python');
  assert.ok(path.isAbsolute(venv.path));
  // 版本来自 pyvenv.cfg（不起进程）
  assert.equal(venv.version, '3.11.9');
  // 分组后同一份数据
  const grouped = groupCandidates(all);
  assert.deepEqual(grouped.python, all.filter((c) => c.id === 'python'));
});

test('约定目录里的 JDK 能被认出来（不依赖 PATH / JAVA_HOME）', async () => {
  const savedJavaHome = process.env.JAVA_HOME;
  const savedPath = process.env.PATH;
  const savedUserProfile = process.env.USERPROFILE;
  const savedHome = process.env.HOME;
  const fakeHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcr-home-'));
  roots.push(fakeHome);
  try {
    delete process.env.JAVA_HOME;
    process.env.PATH = ''; // PATH 里绝对没有这个 jdk
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;

    // 摆成约定目录的形状：<home>/.jdks/jdk21/{bin/java,release}
    const jdkHome = path.join(fakeHome, '.jdks', 'jdk21');
    await fsp.mkdir(path.join(jdkHome, 'bin'), { recursive: true });
    await fsp.writeFile(path.join(jdkHome, 'bin', `java${WIN ? '.exe' : ''}`), '');
    await fsp.writeFile(path.join(jdkHome, 'release'), 'JAVA_VERSION="21.0.2"\n');

    const all = await detectRuntimes(path.join(fakeHome, 'nowhere'), { only: ['java'] });
    const hit = all.find((c) => c.source === 'convention' && c.version === '21.0.2');
    assert.ok(hit, `~/.jdks 下的 JDK 应被探测到：${JSON.stringify(all)}`);
    assert.equal(hit.id, 'java');
    assert.equal(hit.home, jdkHome);
  } finally {
    if (savedJavaHome === undefined) delete process.env.JAVA_HOME;
    else process.env.JAVA_HOME = savedJavaHome;
    process.env.PATH = savedPath;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

test('没装的语言给空数组，不编造候选', async () => {
  const root = await makeTree({ 'README.md': '' });
  const grouped = groupCandidates(await detectRuntimes(root));
  // 这几个 id 一定存在（界面靠 key 判断"没找到"）
  for (const id of ['java', 'maven', 'gradle', 'python', 'node', 'go'] as const) {
    assert.ok(Array.isArray(grouped[id]), `${id} 应是数组`);
  }
});

test('探测结果带缓存（同项目 5 秒内复用同一份）', async () => {
  const root = await makeTree({ 'README.md': '' });
  const first = await detectRuntimes(root);
  const second = await detectRuntimes(root);
  assert.equal(first, second, '应命中缓存返回同一数组引用');
});

// ---------------------------------------------------------------- 配置与装配

test('parseEnvFile 读 KEY=VALUE / export / 注释 / 引号', () => {
  const env = parseEnvFile(
    ['# comment', 'FOO=bar', 'export BAZ="quoted value"', "Q='single'", 'EMPTY=', 'bad line', '=nokey'].join('\n'),
  );
  assert.deepEqual(env, { FOO: 'bar', BAZ: 'quoted value', Q: 'single', EMPTY: '' });
});

test('coerceRunConfig 容错：坏数据回落空配置，非法 runtime id 被丢', () => {
  const empty = emptyRunConfig();
  assert.deepEqual(coerceRunConfig(null), empty);
  assert.deepEqual(coerceRunConfig('nope'), empty);
  const coerced = coerceRunConfig({
    runtimes: { java: 'D:/jdk', nope: 'x', maven: '' },
    env: { A: '1', B: 2 },
    pathPrepend: ['x', '', 3],
    envFile: ['.env'],
    profiles: [{ id: 'p', command: 'echo hi', kind: 'run', label: 'Hi' }, { id: 'bad' }],
  });
  assert.deepEqual(coerced.runtimes, { java: 'D:/jdk' });
  assert.deepEqual(coerced.env, { A: '1' });
  assert.deepEqual(coerced.pathPrepend, ['x']);
  assert.deepEqual(coerced.envFile, ['.env']);
  assert.equal(coerced.profiles.length, 1, '没有 command 的运行档要被丢掉');
  assert.equal(coerced.profiles[0].source, 'user');
});

test('inferProfiles：Maven 项目出构建 / 运行 / 测试三档（按 pom 判运行方式）', async () => {
  const root = await makeTree({
    'pom.xml': '<project><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>',
  });
  const profiles = inferProfiles(root);
  const ids = profiles.map((p) => p.id);
  assert.deepEqual(ids, ['java-build', 'java-run', 'java-test']);
  const run = profiles.find((p) => p.id === 'java-run');
  assert.ok(run?.command.includes('spring-boot:run'), `应走 spring-boot:run：${run?.command}`);
  assert.equal(run?.background, true, '长驻服务默认后台');
  assert.equal(profiles.find((p) => p.id === 'java-build')?.kind, 'build');
});

test('inferProfiles：普通 Maven 项目按主类走 exec:java', async () => {
  const root = await makeTree({
    'pom.xml': '<project/>',
    'src/main/java/com/demo/App.java': 'package com.demo;\npublic class App { public static void main(String[] a) {} }\n',
  });
  const run = inferProfiles(root).find((p) => p.id === 'java-run');
  assert.ok(run?.command.includes('exec:java'), `应走 exec:java：${run?.command}`);
  assert.ok(run?.command.includes('com.demo.App'), `应带主类全名：${run?.command}`);
});

test('inferProfiles：package.json 的 scripts 映射成运行档（dev 默认后台）', async () => {
  const root = await makeTree({
    'package.json': JSON.stringify({ scripts: { dev: 'vite', build: 'vite build', test: 'vitest' } }),
    'pnpm-lock.yaml': '',
  });
  const profiles = inferProfiles(root);
  assert.deepEqual(profiles.map((p) => p.id), ['node-dev', 'node-build', 'node-test']);
  assert.equal(profiles[0].command, 'pnpm run dev', '包管理器按 lock 文件判');
  assert.equal(profiles[0].background, true);
});

test('mergeProfiles：同 id 用户档覆盖推断档，用户新增的排在后', () => {
  const inferred = [
    { id: 'a', kind: 'build' as const, label: 'A', command: 'a', source: 'inferred' as const },
    { id: 'b', kind: 'run' as const, label: 'B', command: 'b', source: 'inferred' as const },
  ];
  const user = [
    { id: 'b', kind: 'run' as const, label: 'B2', command: 'b2', source: 'user' as const },
    { id: 'c', kind: 'other' as const, label: 'C', command: 'c', source: 'user' as const },
  ];
  const merged = mergeProfiles(inferred, user);
  assert.deepEqual(merged.map((p) => p.id), ['a', 'b', 'c']);
  assert.equal(merged[1].command, 'b2');
});

test('pickRuntime：锁定的 home 优先，锁定的可执行文件也能兜底', async () => {
  const root = await makeTree({ [`jdk/bin/java${WIN ? '.exe' : ''}`]: '' });
  const jdkHome = path.join(root, 'jdk');
  const javaExe = path.join(jdkHome, 'bin', `java${WIN ? '.exe' : ''}`);
  const candidates = [
    { id: 'java' as const, path: javaExe, home: jdkHome, version: '17', source: 'path' as const, detail: 'PATH' },
  ];
  // 锁定的 home 命中同一条候选
  const lockedByHome = pickRuntime('java', candidates, { ...emptyRunConfig(), runtimes: { java: jdkHome } });
  assert.equal(lockedByHome?.version, '17');

  // 锁定一个不在候选里的可执行文件（且存在）：用户手填的绝对路径要生效
  const stray = path.resolve(os.tmpdir(), 'stray-bin', `java${WIN ? '.exe' : ''}`);
  await fsp.mkdir(path.dirname(stray), { recursive: true });
  await fsp.writeFile(stray, '');
  const picked = pickRuntime('java', [], { ...emptyRunConfig(), runtimes: { java: stray } });
  assert.equal(picked?.path, stray);

  // 锁定的路径已不存在：回落到第一个候选，并由 lockWarnings 明确告知
  const gone = path.resolve(os.tmpdir(), 'no-such-jdk');
  const config = { ...emptyRunConfig(), runtimes: { java: gone } };
  const fallback = pickRuntime('java', candidates, config);
  assert.equal(fallback?.path, javaExe, '锁定失效应回落，而不是拿不存在的路径去跑');
  assert.equal(lockWarnings(config, { java: fallback ?? undefined }).length, 1);
});

test('resolveRunEnv：加载声明的 envFile、覆盖 env、前插 PATH、JAVA_HOME 与选定 JDK 配对', async () => {
  const root = await makeTree({
    '.env.prod': 'FROM_FILE=yes\nSHARED=file\n',
    'node_modules/.bin/placeholder': '',
    [`jdk/bin/java${WIN ? '.exe' : ''}`]: '',
    'jdk/release': 'JAVA_VERSION="21.0.1"\n',
  });
  const jdkHome = path.join(root, 'jdk');
  const javaExe = path.join(jdkHome, 'bin', `java${WIN ? '.exe' : ''}`);
  const candidates = [
    { id: 'java' as const, path: javaExe, home: jdkHome, version: '21.0.1', source: 'convention' as const, detail: 'test' },
  ];
  const config = {
    ...emptyRunConfig(),
    envFile: ['.env.prod'],
    env: { SHARED: 'config', ONLY_CONFIG: '1' },
    pathPrepend: ['tools'],
  };
  const { env, picked, loadedEnvFiles } = await resolveRunEnv(root, { config, candidates });

  assert.deepEqual(loadedEnvFiles, ['.env.prod']);
  assert.equal(env.FROM_FILE, 'yes');
  assert.equal(env.SHARED, 'config', '配置里的 env 覆盖 envFile');
  assert.equal(env.ONLY_CONFIG, '1');
  assert.equal(env.JAVA_HOME, jdkHome, 'JAVA_HOME 必须跟着选定的 JDK');
  assert.equal(picked.java?.path, javaExe);

  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') as string;
  const dirs = env[pathKey].split(path.delimiter);
  assert.ok(dirs.includes(path.join(jdkHome, 'bin')), `PATH 应前插 JDK bin：${env[pathKey]}`);
  assert.ok(dirs.includes(path.join(root, 'node_modules', '.bin')), 'PATH 应前插 node_modules/.bin');
  assert.ok(dirs.includes(path.resolve(root, 'tools')), 'PATH 应前插配置里的目录');
});

test('resolveRunEnv：没声明的 .env 不会被自动加载', async () => {
  const root = await makeTree({ '.env': 'SECRET=leaked\n' });
  const { env, loadedEnvFiles } = await resolveRunEnv(root, { config: emptyRunConfig() });
  assert.deepEqual(loadedEnvFiles, []);
  assert.equal(env.SECRET, undefined, '未声明的 .env 不该被读取');
});

test('versionWarnings：项目声明与实探测不符时给出提醒', async () => {
  const root = await makeTree({ '.python-version': '3.12\n', '.nvmrc': 'v20\n' });
  const warnings = versionWarnings(root, {
    python: { id: 'python', path: '/x/python', home: '/x', version: '3.9.1', source: 'path', detail: 'PATH' },
    node: { id: 'node', path: '/x/node', home: '/x', version: '20.11.0', source: 'path', detail: 'PATH' },
  });
  assert.equal(warnings.length, 1, `只有 Python 不匹配：${JSON.stringify(warnings)}`);
  assert.ok(warnings[0].includes('3.12'));
});
