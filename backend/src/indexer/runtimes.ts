/**
 * 运行时探测（2026-10-20，运行上下文装配的第一层）。
 *
 * 解决的问题：IDE 后端自己是从哪启动的，`process.env.PATH` 就是哪一套 —— 从桌面图标、
 * 开始菜单或另一个 shell 起来时，`java` / `mvn` 往往根本不在 PATH 上（实测本机就是这样：
 * JDK 与 Maven 装在 `toolchains/` 下，bash 里 `java` 是 not found）。
 * 所以这里**不信任 PATH**，按可信度依次找：
 *
 *   1. `env`        环境变量（JAVA_HOME / MAVEN_HOME / M2_HOME / GRADLE_HOME / GOROOT / NVM_*）
 *   2. `project`    项目内自带（`.venv`、`conda-meta`、`mvnw`、`gradlew`）
 *   3. `convention` 约定安装目录（IDEA 的 `~/.jdks`、sdkman、`~/.gradle/jdks`、Program Files 各家发行版…）
 *   4. `path`       PATH 上的（兜底）
 *
 * 返回的是**候选列表**而不是单个答案：界面上要能让人看到「你机器上有哪几个 JDK」并锁定一个。
 *
 * 纪律：
 * - 版本尽量读**文件**（`<jdk>/release`、`pyvenv.cfg`、`<goroot>/VERSION`、jar 文件名），
 *   读不到才起一次进程（3 秒上限），结果按「路径 + mtime」缓存 —— 探测是 UI 入口级操作，不能慢。
 * - 读不到就 `version: null`，**不编造**。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { RuntimeCandidate as SharedCandidate, RuntimeId, RuntimeSource } from '../../../shared/types';

/** 支持的运行时（本轮四门语言 + 两个 Java 构建工具）。 */
export type { RuntimeId, RuntimeSource } from '../../../shared/types';

/** 与前后端共享的契约同一份类型（后端内部按 id 校验取值）。 */
export type RuntimeCandidate = SharedCandidate;

/** 合法的运行时 id（路由入参校验用）。 */
export const RUNTIME_IDS: readonly RuntimeId[] = ['java', 'maven', 'gradle', 'python', 'node', 'go'];

const isWin = process.platform === 'win32';
const EXE = isWin ? '.exe' : '';

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

/** 读文本文件（读不到给 null，不抛）。 */
function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** 列目录（读不到给空数组）。 */
function listDir(p: string): string[] {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

/** 按 PATH 找可执行文件（Windows 补 PATHEXT）。 */
function whichOnPath(name: string): string | null {
  const exts = isWin ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      if (isFile(full)) return full;
    }
  }
  return null;
}

// ---------------------------------------------------------------- 版本（文件优先，进程兜底）

interface VersionCacheEntry {
  version: string | null;
  at: number;
}

const versionCache = new Map<string, VersionCacheEntry>();
/** 起进程读版本的缓存时长：探测是入口级操作，10 分钟内不重复起进程。 */
const VERSION_TTL_MS = 10 * 60 * 1000;

function cachedVersion(key: string): string | null | undefined {
  const hit = versionCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > VERSION_TTL_MS) {
    versionCache.delete(key);
    return undefined;
  }
  return hit.version;
}

function rememberVersion(key: string, version: string | null): string | null {
  versionCache.set(key, { version, at: Date.now() });
  return version;
}

/** 起一次进程读版本号（3 秒上限；失败给 null）。 */
function execVersion(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const done = (value: string | null): void => resolve(value);
    try {
      execFile(
        file,
        args,
        { timeout: 3000, windowsHide: true, env: process.env },
        (error, stdout) => {
          if (error) {
            done(null);
            return;
          }
          const text = String(stdout).trim();
          done(text || null);
        },
      ).on?.('error', () => done(null));
    } catch {
      // spawn 本身抛（EFTYPE：文件不可执行；ENOENT：探测到的路径其实坏了）——一律当读不到版本
      done(null);
    }
  });
}

/** JDK 的 `<home>/release` 里 `JAVA_VERSION="21.0.1"`。 */
function javaHomeVersion(home: string): string | null {
  const text = readText(path.join(home, 'release'));
  if (!text) return null;
  const m = /^JAVA_VERSION="([^"]+)"/m.exec(text);
  return m ? m[1] : null;
}

/** Maven 的 `<home>/lib/maven-core-3.9.16.jar`。 */
function libVersion(home: string, prefix: string): string | null {
  const dir = path.join(home, 'lib');
  for (const name of listDir(dir)) {
    const m = new RegExp(`^${prefix}-(\\d[\\w.\\-]*)\\.jar$`).exec(name);
    if (m) return m[1].replace(/\.jar$/, '');
  }
  return null;
}

/** venv 的 `pyvenv.cfg` 里 `version = 3.12.4`（或 `version_info`）。 */
function venvVersion(venvRoot: string): string | null {
  const text = readText(path.join(venvRoot, 'pyvenv.cfg'));
  if (!text) return null;
  const m = /^version(?:_info)?\s*=\s*(\S+)/m.exec(text);
  return m ? m[1] : null;
}

/** Go 的 `<goroot>/VERSION` 首行 `go1.23.4`。 */
function goRootVersion(goroot: string): string | null {
  const text = readText(path.join(goroot, 'VERSION'));
  if (!text) return null;
  const first = text.split(/\r?\n/)[0]?.trim();
  return first && /^go\S+/.test(first) ? first.slice(2) : null;
}

// ---------------------------------------------------------------- 用户指定的工具链根

/**
 * 在用户指定的工具链根目录里找安装根（根本身或子目录里有 `bin/<exe>` 就算）。
 *
 * 为什么需要它：`JAVA_HOME` 不设、PATH 里也没有、安装目录也不是官方位置时，任何白名单
 * 都扫不到 —— 本机就是 `D:\...\toolchains\{jdk\jdk21, maven\apache-maven-3.9.16}` 这种布局。
 * 这时只能让用户指一个根，下面最多再看两层（`toolchains/jdk/jdk21`）。
 */
function homesUnder(roots: readonly string[], exeNames: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const consider = (dir: string): void => {
    if (!isDir(dir)) return;
    const hit = exeNames.some(
      (name) => isFile(path.join(dir, 'bin', name)) || isFile(path.join(dir, 'bin', `${name}${EXE}`)),
    );
    if (!hit) return;
    const key = dir.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(dir);
  };
  for (const root of roots) {
    const base = root.trim();
    if (!base) continue;
    consider(base);
    for (const child of listDir(base)) {
      consider(path.join(base, child));
      for (const grand of listDir(path.join(base, child))) consider(path.join(base, child, grand));
    }
  }
  return out;
}

// ---------------------------------------------------------------- 各语言的候选

/** Java 候选：JAVA_HOME → 用户工具链根 → 约定目录 → PATH。 */
function javaCandidates(extraRoots: readonly string[]): Array<Omit<RuntimeCandidate, 'id'>> {
  const out: Array<Omit<RuntimeCandidate, 'id'>> = [];
  const seen = new Set<string>();
  const push = (home: string, source: RuntimeSource, detail: string): void => {
    const exe = path.join(home, 'bin', `java${EXE}`);
    if (!isFile(exe)) return;
    const key = home.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path: exe, home, version: javaHomeVersion(home), source, detail });
  };

  const javaHome = process.env.JAVA_HOME?.trim();
  if (javaHome) push(javaHome, 'env', 'JAVA_HOME');

  // 用户指的工具链根（本机就是 toolchains/{jdk/jdk21, maven/…} 这种）
  for (const home of homesUnder(extraRoots, ['java'])) push(home, 'env', '工具链根目录');

  // 同一个 jdk 可能被多个约定目录覆盖，先收集目录再统一去掉重复
  const homes = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  for (const p of listDir(path.join(homes, '.jdks'))) push(path.join(homes, '.jdks', p), 'convention', '~/.jdks');
  for (const p of listDir(path.join(homes, '.sdkman', 'candidates', 'java'))) {
    push(path.join(homes, '.sdkman', 'candidates', 'java', p), 'convention', '~/.sdkman');
  }
  for (const p of listDir(path.join(homes, '.gradle', 'jdks'))) {
    for (const inner of listDir(path.join(homes, '.gradle', 'jdks', p))) {
      push(path.join(homes, '.gradle', 'jdks', p, inner), 'convention', '~/.gradle/jdks');
    }
  }
  if (isWin) {
    const roots = [
      'C:\\Program Files\\Java',
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Microsoft',
      'C:\\Program Files\\Amazon Corretto',
      'C:\\Program Files\\Zulu',
      'C:\\Program Files (x86)\\Java',
    ];
    for (const base of roots) {
      for (const p of listDir(base)) {
        const home = path.join(base, p);
        if (isDir(home)) push(home, 'convention', base);
      }
    }
  }

  const onPath = whichOnPath('java');
  if (onPath) {
    // PATH 上的 java.exe 通常在 <home>/bin 下；git-bash 常见 <home>/bin/java.exe 的软链，按 parent 推
    const home = path.dirname(path.dirname(onPath));
    push(home, 'path', 'PATH');
    if (!out.some((c) => c.path.toLowerCase() === onPath.toLowerCase())) {
      // 推不出 home（例如被包装成 shim）时，仍然把可执行文件本身作为候选
      out.push({ path: onPath, home, version: null, source: 'path', detail: 'PATH' });
    }
  }
  return out;
}

/** Maven 候选：MAVEN_HOME / M2_HOME → 项目内 mvnw → 用户工具链根 → 约定目录 → PATH。 */
function mavenCandidates(root: string, extraRoots: readonly string[]): Array<Omit<RuntimeCandidate, 'id'>> {
  const out: Array<Omit<RuntimeCandidate, 'id'>> = [];
  const seen = new Set<string>();
  const pushHome = (home: string, source: RuntimeSource, detail: string): void => {
    const exe = path.join(home, 'bin', isWin ? 'mvn.cmd' : 'mvn');
    if (!isFile(exe)) return;
    const key = home.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path: exe, home, version: libVersion(home, 'maven-core'), source, detail });
  };

  for (const key of ['MAVEN_HOME', 'M2_HOME'] as const) {
    const value = process.env[key]?.trim();
    if (value) pushHome(value, 'env', key);
  }

  // 项目内的 wrapper：最可靠的那条（版本跟着仓库走）
  const wrapper = path.join(root, isWin ? 'mvnw.cmd' : 'mvnw');
  if (isFile(wrapper)) {
    const props = readText(path.join(root, '.mvn', 'wrapper', 'maven-wrapper.properties'));
    const m = props ? /distributionUrl=.*apache-maven-([\w.\-]+)-bin/.exec(props) : null;
    out.unshift({
      path: wrapper,
      home: root,
      version: m ? m[1] : null,
      source: 'project',
      detail: '.mvn/wrapper（项目自带）',
    });
  }

  const homes = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  for (const p of listDir(path.join(homes, '.sdkman', 'candidates', 'maven'))) {
    pushHome(path.join(homes, '.sdkman', 'candidates', 'maven', p), 'convention', '~/.sdkman');
  }
  // 用户指的工具链根（mvn.cmd 在 <home>/bin 下，所以 home 直接就是 apache-maven-x.y.z）
  for (const home of homesUnder(extraRoots, ['mvn'])) pushHome(home, 'env', '工具链根目录');
  if (isWin) {
    for (const base of ['C:\\Program Files\\apache-maven-*', 'C:\\ProgramData\\chocolatey\\lib\\maven']) {
      // 通配要自己展开（fs 不认 *）
      if (base.includes('*')) {
        const dir = path.dirname(base);
        const glob = path.basename(base).replace('*', '');
        for (const p of listDir(dir)) if (p.startsWith(glob)) pushHome(path.join(dir, p), 'convention', dir);
      } else {
        for (const p of listDir(base)) pushHome(path.join(base, p), 'convention', base);
      }
    }
  }

  const onPath = whichOnPath('mvn');
  if (onPath) {
    const dir = path.dirname(onPath);
    // mvn.cmd 在 <home>/bin 下 → home 是上一级；某些 shim 只给一个文件，home 记作它的目录
    const home = path.basename(dir).toLowerCase() === 'bin' ? path.dirname(dir) : dir;
    pushHome(home, 'path', 'PATH');
  }
  return out;
}

/** Gradle 候选：GRADLE_HOME → 项目内 gradlew → 用户工具链根 → 约定目录 → PATH。 */
function gradleCandidates(root: string, extraRoots: readonly string[]): Array<Omit<RuntimeCandidate, 'id'>> {
  const out: Array<Omit<RuntimeCandidate, 'id'>> = [];
  const seen = new Set<string>();
  const pushHome = (home: string, source: RuntimeSource, detail: string): void => {
    const exe = path.join(home, 'bin', isWin ? 'gradle.bat' : 'gradle');
    if (!isFile(exe)) return;
    const key = home.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path: exe, home, version: libVersion(home, 'gradle-core'), source, detail });
  };

  const gradleHome = process.env.GRADLE_HOME?.trim();
  if (gradleHome) pushHome(gradleHome, 'env', 'GRADLE_HOME');

  const wrapper = path.join(root, isWin ? 'gradlew.bat' : 'gradlew');
  if (isFile(wrapper)) {
    const props = readText(path.join(root, 'gradle', 'wrapper', 'gradle-wrapper.properties'));
    const m = props ? /gradle-([\w.\-]+)-(bin|all)\.zip/.exec(props) : null;
    out.unshift({
      path: wrapper,
      home: root,
      version: m ? m[1] : null,
      source: 'project',
      detail: 'gradle/wrapper（项目自带）',
    });
  }

  const homes = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  for (const p of listDir(path.join(homes, '.sdkman', 'candidates', 'gradle'))) {
    pushHome(path.join(homes, '.sdkman', 'candidates', 'gradle', p), 'convention', '~/.sdkman');
  }
  for (const home of homesUnder(extraRoots, ['gradle'])) pushHome(home, 'env', '工具链根目录');
  if (isWin) {
    const base = 'C:\\Program Files\\Gradle';
    for (const p of listDir(base)) pushHome(path.join(base, p), 'convention', base);
  }

  const onPath = whichOnPath('gradle');
  if (onPath) {
    const dir = path.dirname(onPath);
    pushHome(path.basename(dir).toLowerCase() === 'bin' ? path.dirname(dir) : dir, 'path', 'PATH');
  }
  // 只有 wrapper 命中时也该出现在列表顶部（已 unshift 过）；这里去重后返回
  return out;
}

/** Python 候选：项目内 venv → `.python-version` 提示 → conda → 约定目录 → PATH。 */
async function pythonCandidates(root: string): Promise<Array<Omit<RuntimeCandidate, 'id'>>> {
  const out: Array<Omit<RuntimeCandidate, 'id'>> = [];
  const seen = new Set<string>();
  const pushExe = (exe: string, home: string, source: RuntimeSource, detail: string): void => {
    if (!isFile(exe)) return;
    const key = exe.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path: exe, home, version: null, source, detail });
  };

  for (const dir of ['.venv', 'venv', 'env']) {
    const base = path.join(root, dir);
    const exe = isWin
      ? path.join(base, 'Scripts', 'python.exe')
      : (isFile(path.join(base, 'bin', 'python')) ? path.join(base, 'bin', 'python') : path.join(base, 'bin', 'python3'));
    pushExe(exe, base, 'project', `项目内 ${dir}`);
  }
  // 项目根自己就是 conda 环境
  if (isDir(path.join(root, 'conda-meta'))) {
    const exe = isWin ? path.join(root, 'python.exe') : path.join(root, 'bin', 'python');
    pushExe(exe, root, 'project', '项目根是 conda 环境');
  }

  // 已激活的 conda 环境（CONDA_PREFIX 由 activate 脚本设置）
  const condaPrefix = process.env.CONDA_PREFIX?.trim();
  if (condaPrefix) {
    pushExe(isWin ? path.join(condaPrefix, 'python.exe') : path.join(condaPrefix, 'bin', 'python'), condaPrefix, 'env', 'CONDA_PREFIX');
  }
  const virtualEnv = process.env.VIRTUAL_ENV?.trim();
  if (virtualEnv) {
    pushExe(isWin ? path.join(virtualEnv, 'Scripts', 'python.exe') : path.join(virtualEnv, 'bin', 'python'), virtualEnv, 'env', 'VIRTUAL_ENV');
  }

  const homes = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  for (const p of listDir(path.join(homes, '.pyenv', 'versions'))) {
    const base = path.join(homes, '.pyenv', 'versions', p);
    pushExe(isWin ? path.join(base, 'python.exe') : path.join(base, 'bin', 'python'), base, 'convention', '~/.pyenv');
  }
  if (isWin) {
    const base = path.join(process.env.LOCALAPPDATA ?? path.join(homes, 'AppData', 'Local'), 'Programs', 'Python');
    for (const p of listDir(base)) {
      const dir = path.join(base, p);
      pushExe(path.join(dir, 'python.exe'), dir, 'convention', 'LocalAppData\\Programs\\Python');
    }
    for (const p of listDir('C:\\Python313')) pushExe(path.join('C:\\Python313', p), 'C:\\Python313', 'convention', 'C:\\Python313');
  }

  const onPath = whichOnPath(isWin ? 'python' : 'python3') ?? whichOnPath('python');
  if (onPath) pushExe(onPath, path.dirname(onPath), 'path', 'PATH');

  // 版本：venv 读 pyvenv.cfg；其余起一次进程（带缓存）
  for (const cand of out) {
    if (cand.version) continue;
    const fromCfg = venvVersion(cand.home);
    if (fromCfg) {
      cand.version = fromCfg;
      continue;
    }
    const key = `py:${cand.path}`;
    const cached = cachedVersion(key);
    if (cached !== undefined) {
      cand.version = cached;
      continue;
    }
    const text = await execVersion(cand.path, ['-V']);
    // stdout/stderr 都可能是 "Python 3.12.4"
    const m = text ? /(\d+\.\d+\.\d+\S*)/.exec(text) : null;
    cand.version = rememberVersion(key, m ? m[1] : null);
  }
  return out;
}

/** Node 候选：NVM_SYMLINK / NVM_HOME → 约定目录 → PATH。 */
async function nodeCandidates(): Promise<Array<Omit<RuntimeCandidate, 'id'>>> {
  const out: Array<Omit<RuntimeCandidate, 'id'>> = [];
  const seen = new Set<string>();
  const pushExe = (exe: string, home: string, source: RuntimeSource, detail: string): void => {
    if (!isFile(exe)) return;
    const key = exe.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path: exe, home, version: null, source, detail });
  };
  const exeName = isWin ? 'node.exe' : 'node';

  const symlink = process.env.NVM_SYMLINK?.trim();
  if (symlink) pushExe(path.join(symlink, exeName), symlink, 'env', 'NVM_SYMLINK');
  const nvmHome = process.env.NVM_HOME?.trim();
  if (nvmHome) {
    for (const p of listDir(nvmHome)) pushExe(path.join(nvmHome, p, exeName), path.join(nvmHome, p), 'env', 'NVM_HOME');
  }

  const homes = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  for (const p of listDir(path.join(homes, 'AppData', 'Roaming', 'nvm'))) {
    pushExe(path.join(homes, 'AppData', 'Roaming', 'nvm', p, exeName), path.join(homes, 'AppData', 'Roaming', 'nvm', p), 'convention', '%APPDATA%\\nvm');
  }
  for (const p of listDir(path.join(homes, '.nvm', 'versions', 'node'))) {
    const base = path.join(homes, '.nvm', 'versions', 'node', p);
    pushExe(isWin ? path.join(base, exeName) : path.join(base, 'bin', 'node'), base, 'convention', '~/.nvm');
  }
  if (isWin) {
    pushExe('C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files\\nodejs', 'convention', 'C:\\Program Files\\nodejs');
  }

  const onPath = whichOnPath('node');
  if (onPath) pushExe(onPath, path.dirname(onPath), 'path', 'PATH');

  for (const cand of out) {
    const key = `node:${cand.path}`;
    const cached = cachedVersion(key);
    if (cached !== undefined) {
      cand.version = cached;
      continue;
    }
    const text = await execVersion(cand.path, ['--version']);
    const m = text ? /v?(\d[^\s]*)/.exec(text) : null;
    cand.version = rememberVersion(key, m ? m[1] : null);
  }
  return out;
}

/** Go 候选：GOROOT → 用户工具链根 → 约定目录 → PATH（版本读 `<goroot>/VERSION`）。 */
function goCandidates(extraRoots: readonly string[]): Array<Omit<RuntimeCandidate, 'id'>> {
  const out: Array<Omit<RuntimeCandidate, 'id'>> = [];
  const seen = new Set<string>();
  const pushHome = (home: string, source: RuntimeSource, detail: string): void => {
    const exe = path.join(home, 'bin', `go${EXE}`);
    if (!isFile(exe)) return;
    const key = home.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path: exe, home, version: goRootVersion(home), source, detail });
  };

  const goroot = process.env.GOROOT?.trim();
  if (goroot) pushHome(goroot, 'env', 'GOROOT');
  for (const home of homesUnder(extraRoots, ['go'])) pushHome(home, 'env', '工具链根目录');
  if (isWin) {
    pushHome('C:\\Program Files\\Go', 'convention', 'C:\\Program Files\\Go');
    const local = process.env.LOCALAPPDATA ?? '';
    if (local) {
      for (const p of listDir(path.join(local, 'Programs', 'Go'))) pushHome(path.join(local, 'Programs', 'Go', p), 'convention', 'LocalAppData\\Programs\\Go');
    }
  } else {
    pushHome('/usr/local/go', 'convention', '/usr/local/go');
    pushHome('/usr/lib/go', 'convention', '/usr/lib/go');
  }

  const onPath = whichOnPath('go');
  if (onPath) {
    const dir = path.dirname(onPath);
    pushHome(path.basename(dir).toLowerCase() === 'bin' ? path.dirname(dir) : dir, 'path', 'PATH');
  }
  return out;
}

// ---------------------------------------------------------------- 对外

export interface DetectOptions {
  /** 只探某几个（缺省全探）。 */
  only?: readonly RuntimeId[];
  /**
   * 用户自定义的工具链根目录（设置里填的，见 `run-config.ts` 的 `toolchainRoots`）。
   * 这类布局任何白名单都扫不到：本机就是 `D:\...\toolchains\{jdk\jdk21, maven\apache-maven-3.9.16}`。
   */
  extraRoots?: readonly string[];
}

/** 探测缓存：同一项目 + 同一组工具链根 5 秒内复用（UI 入口级调用，避免连点反复扫目录）。 */
const detectCache = new Map<string, { at: number; value: RuntimeCandidate[] }>();
const DETECT_TTL_MS = 5_000;

/**
 * 探测一个项目可用的运行时，按语言分组（同语言内可信度从高到低）。
 * 找不到的语言在结果里出现空数组 —— 不省略 key，界面据此显示「没找到」。
 */
export async function detectRuntimes(root: string, opts: DetectOptions = {}): Promise<RuntimeCandidate[]> {
  const extraRoots = opts.extraRoots ?? [];
  const cacheKey = `${root}\u0000${extraRoots.join('\u0000')}`;
  const cached = detectCache.get(cacheKey);
  if (cached && Date.now() - cached.at < DETECT_TTL_MS) {
    const value = cached.value;
    return opts.only ? value.filter((c) => opts.only!.includes(c.id)) : value;
  }

  const only = opts.only;
  const want = (id: RuntimeId): boolean => !only || only.includes(id);

  const out: RuntimeCandidate[] = [];
  const add = (id: RuntimeId, list: Array<Omit<RuntimeCandidate, 'id'>>): void => {
    for (const c of list) out.push({ id, ...c });
  };

  if (want('java')) add('java', javaCandidates(extraRoots));
  if (want('maven')) add('maven', mavenCandidates(root, extraRoots));
  if (want('gradle')) add('gradle', gradleCandidates(root, extraRoots));
  if (want('python')) add('python', await pythonCandidates(root));
  if (want('node')) add('node', await nodeCandidates());
  if (want('go')) add('go', goCandidates(extraRoots));

  detectCache.set(cacheKey, { at: Date.now(), value: out });
  return out;
}

/** 按 id 分组（界面直接用）。 */
export function groupCandidates(list: RuntimeCandidate[]): Record<RuntimeId, RuntimeCandidate[]> {
  const out = { java: [], maven: [], gradle: [], python: [], node: [], go: [] } as Record<RuntimeId, RuntimeCandidate[]>;
  for (const c of list) out[c.id].push(c);
  return out;
}

/** 仅供测试：清掉探测与版本缓存。 */
export function resetRuntimeCacheForTest(): void {
  detectCache.clear();
  versionCache.clear();
}
