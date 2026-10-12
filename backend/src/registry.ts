/** 项目注册表：以「本机目录」为项目单位，持久化到 data/projects.json。 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ProjectInfo } from './types';
import { ProjectIndex } from './indexer/store';
import { snapshotDir, removeSnapshotDir } from './indexer/snapshot';
import { ProjectWatcher } from './watcher';
import {
  IDLE_RELEASE_MS,
  MAX_ACTIVE_PROJECTS,
  PARSE_WORKERS,
  PERSIST_ENABLED,
  RELEASE_SWEEP_MS,
  VERIFY_INTERVAL_MS,
} from './config';
import { logInfo } from './log';

/** 同一目录永远得到同一 id：宿主（如 xchen 项目列表）可自行推导。 */
export function projectIdFor(root: string): string {
  return createHash('sha1').update(normalizeRoot(root).toLowerCase()).digest('hex').slice(0, 12);
}

/** 统一成 POSIX 风格绝对路径（Windows 下 fs 同样接受正斜杠）。 */
export function normalizeRoot(root: string): string {
  return path.resolve(root).split(path.sep).join('/');
}

interface PersistedProject {
  id: string;
  name: string;
  root: string;
  createdAt: number;
}

/** 内存索引自动回收的三个参数（默认取 config；测试用小值注入，不必改 env）。 */
export interface RegistryOptions {
  /** 同时保留的已索引项目上限（`0` = 不限）。 */
  maxActiveProjects?: number;
  /** 空闲多久释放内存索引（毫秒，`0` = 关闭空闲释放）。 */
  idleReleaseMs?: number;
  /** 巡检间隔（毫秒，`0` = 关闭自动回收）。 */
  sweepMs?: number;
}

export class ProjectRegistry {
  private readonly projects = new Map<string, ProjectIndex>();
  private readonly watchers = new Map<string, ProjectWatcher>();
  private readonly started = new Set<string>();
  /** P7：每个项目的定期对账定时器。 */
  private readonly verifyTimers = new Map<string, NodeJS.Timeout>();
  private readonly file: string;

  /** 最近一次访问时间（自动回收判据）。 */
  private readonly lastAccess = new Map<string, number>();
  /** 活跃 SSE 长连接的持有计数：有流向项目不参与回收（用户正看着）。 */
  private readonly streamHolds = new Map<string, number>();
  private readonly maxActiveProjects: number;
  private readonly idleReleaseMs: number;
  private readonly sweepMs: number;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly dataDir: string, opts: RegistryOptions = {}) {
    this.file = path.join(dataDir, 'projects.json');
    this.maxActiveProjects = opts.maxActiveProjects ?? MAX_ACTIVE_PROJECTS;
    this.idleReleaseMs = opts.idleReleaseMs ?? IDLE_RELEASE_MS;
    this.sweepMs = opts.sweepMs ?? RELEASE_SWEEP_MS;
    if (this.sweepMs > 0) {
      this.sweepTimer = setInterval(() => this.sweepIdle(), this.sweepMs);
      this.sweepTimer.unref?.();
    }
  }

  private newProject(id: string, name: string, root: string, createdAt: number): ProjectIndex {
    return new ProjectIndex(id, name, root, createdAt, {
      dataDir: this.dataDir,
      persist: PERSIST_ENABLED,
      workers: PARSE_WORKERS,
    });
  }

  list(): ProjectInfo[] {
    return [...this.projects.values()].map((p) => this.info(p));
  }

  get(id: string): ProjectIndex | undefined {
    const project = this.projects.get(id);
    if (project) {
      this.ensureIndexing(project);
      this.lastAccess.set(id, Date.now());
    }
    return project;
  }

  /**
   * 不触发索引的查表：资源视图与释放端点用它，
   * 否则「看一眼资源」就会把刚释放的项目又拉起来索引一遍。
   */
  peek(id: string): ProjectIndex | undefined {
    return this.projects.get(id);
  }

  find(root: string): ProjectIndex | undefined {
    const normalized = normalizeRoot(root);
    return [...this.projects.values()].find((p) => p.root === normalized);
  }

  info(project: ProjectIndex): ProjectInfo {
    return {
      id: project.id,
      name: project.name,
      root: project.root,
      createdAt: project.createdAt,
      status: { ...project.status },
    };
  }

  /** 打开（必要时注册）一个本机目录；返回项目与是否新建。 */
  async open(root: string, name?: string, id?: string): Promise<{ project: ProjectIndex; created: boolean }> {
    const abs = normalizeRoot(root);
    const existing = this.find(abs);
    if (existing) {
      this.ensureIndexing(existing);
      this.lastAccess.set(existing.id, Date.now());
      return { project: existing, created: false };
    }
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      throw Object.assign(new Error(`not a directory: ${abs}`), { code: 'ENOTDIR' });
    }
    const projectId = id && /^[\w-]{1,64}$/.test(id) ? id : projectIdFor(abs);
    const project = this.newProject(projectId, name?.trim() || path.posix.basename(abs) || abs, abs, Date.now());
    this.projects.set(projectId, project);
    await this.save();
    this.ensureIndexing(project);
    this.lastAccess.set(projectId, Date.now());
    return { project, created: true };
  }

  /** 首次访问 / 冷启动时后台建索引（不阻塞 HTTP 返回，前端通过 SSE 或轮询看进度）。 */
  private ensureIndexing(project: ProjectIndex) {
    if (this.started.has(project.id)) return;
    this.started.add(project.id);
    void project.reindexAll().then(() => {
      // 索引期间可能已被 dispose/forget：此时不能再挂 watcher，否则退出时残留句柄。
      if (!this.started.has(project.id)) return;
      this.watchers.set(project.id, new ProjectWatcher(project));
    });
    // P7：定期对账（监听偶发漏事件时自愈）；READER_VERIFY_MS=0 关闭
    if (VERIFY_INTERVAL_MS > 0 && !this.verifyTimers.has(project.id)) {
      const timer = setInterval(() => {
        void project.verify().catch(() => undefined);
      }, VERIFY_INTERVAL_MS);
      timer.unref?.();
      this.verifyTimers.set(project.id, timer);
    }
  }

  /** 只从项目列表移除（不删除磁盘上的任何文件；本工具自己的索引缓存一并删除）。 */
  async forget(id: string): Promise<boolean> {
    const project = this.projects.get(id);
    if (!project) return false;
    this.stopProject(id, project);
    this.lastAccess.delete(id);
    this.streamHolds.delete(id);
    await removeSnapshotDir(snapshotDir(this.dataDir, id));
    const removed = this.projects.delete(id);
    await this.save();
    return removed;
  }

  /**
   * S9c：释放一个项目的运行资源（watcher / 对账定时器 / 内存索引），
   * 但**保留**注册表条目 —— 宿主再把面板拉起来时 `get()` 会重建索引，不必重新注册。
   * 磁盘上的文件一个都不动（延续只读承诺）；重复调用幂等。
   */
  async dispose(id: string): Promise<{ stoppedWatcher: boolean; releasedIndex: boolean; kept: string }> {
    const project = this.projects.get(id);
    if (!project) return { stoppedWatcher: false, releasedIndex: false, kept: 'none' };
    const hadWatcher = this.watchers.has(id) || this.started.has(id);
    this.stopProject(id, project);
    // stopProject 只停 watcher / 定时器；内存索引要单独释放（否则索引还占着）
    project.release();
    return { stoppedWatcher: hadWatcher, releasedIndex: true, kept: 'registry' };
  }

  /** S9c：资源视图 —— 宿主用来自证「收起面板后没有残留」。 */
  resources(
    id: string,
    streams: number,
  ): { watcher: boolean; streams: number; indexed: boolean; filesIndexed: number } {
    const project = this.projects.get(id);
    return {
      watcher: this.watchers.has(id),
      streams,
      indexed: (project?.status.filesIndexed ?? 0) > 0,
      filesIndexed: project?.status.filesIndexed ?? 0,
    };
  }

  // ---------------------------------------------- 内存索引自动回收（2026-10-12）

  /**
   * SSE 建连 / 断连时增减持有计数：有活跃流的项目在回收巡检里跳过，
   * 否则用户正看着的面板会因为索引被释放而突然空掉。
   */
  holdStream(id: string): void {
    this.streamHolds.set(id, (this.streamHolds.get(id) ?? 0) + 1);
  }

  releaseStream(id: string): void {
    const left = (this.streamHolds.get(id) ?? 0) - 1;
    if (left > 0) this.streamHolds.set(id, left);
    else this.streamHolds.delete(id);
  }

  /** 能否回收：正在索引 / 有活跃 SSE 连接的项目要留着。 */
  private canRelease(id: string): boolean {
    const project = this.projects.get(id);
    if (!project) return false;
    if (project.status.indexing) return false;
    if ((this.streamHolds.get(id) ?? 0) > 0) return false;
    return true;
  }

  /**
   * 回收巡检：把「空闲太久」或「超出活跃上限」的项目内存索引释放掉（`dispose` 语义）。
   * 只丢内存，注册表条目与磁盘快照都不动 —— 再次访问时 `reindexAll()` 从快照恢复。
   */
  private sweepIdle(): void {
    const now = Date.now();
    const active = [...this.started].filter((id) => this.projects.has(id));
    if (!active.length) return;
    // 最久未访问的排前面：上限淘汰与空闲释放都从它开刀
    const byAge = active
      .map((id) => ({ id, at: this.lastAccess.get(id) ?? 0 }))
      .sort((a, b) => a.at - b.at);
    const victims: string[] = [];
    if (this.idleReleaseMs > 0) {
      for (const { id, at } of byAge) {
        if (now - at >= this.idleReleaseMs && this.canRelease(id)) victims.push(id);
      }
    }
    // 上限：即使所有项目都在被轮询（lastAccess 都很新），也要把最近访问之外的最旧者收掉
    if (this.maxActiveProjects > 0) {
      let over = active.length - victims.length - this.maxActiveProjects;
      for (const { id } of byAge) {
        if (over <= 0) break;
        if (victims.includes(id) || !this.canRelease(id)) continue;
        victims.push(id);
        over--;
      }
    }
    for (const id of victims) {
      const project = this.projects.get(id);
      if (!project) continue;
      this.stopProject(id, project);
      this.lastAccess.delete(id);
      logInfo('project.index.released', { project: id, active: active.length - victims.length });
    }
  }

  /** 停掉某个项目的监听 / 定时器 / 定时快照（不删列表项）。 */
  private stopProject(id: string, project: ProjectIndex) {
    const timer = this.verifyTimers.get(id);
    if (timer) clearInterval(timer);
    this.verifyTimers.delete(id);
    this.watchers.get(id)?.close();
    this.watchers.delete(id);
    this.started.delete(id);
    // S9c：宿主收起面板 / 移除项目时，内存索引要真释放（release 内部也会清定时器）；
    // 只调 dispose 会留下 status.filesIndexed，resources 视图会把「已释放」报成仍占用。
    project.release();
  }

  /** 启动时恢复列表（不立即索引，访问时再建）。 */
  async load(): Promise<void> {
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const items = JSON.parse(raw) as PersistedProject[];
      for (const item of items) {
        if (!item?.id || !item?.root) continue;
        const stat = await fsp.stat(item.root).catch(() => null);
        if (!stat?.isDirectory()) continue;
        this.projects.set(item.id, this.newProject(item.id, item.name, item.root, item.createdAt));
      }
      if (items.length) logInfo('registry.loaded', { projects: this.projects.size, dataDir: this.dataDir });
    } catch {
      /* 首次运行没有 projects.json */
    }
  }

  private async save(): Promise<void> {
    const items: PersistedProject[] = [...this.projects.values()].map((p) => ({
      id: p.id,
      name: p.name,
      root: p.root,
      createdAt: p.createdAt,
    }));
    await fsp.mkdir(this.dataDir, { recursive: true });
    await fsp.writeFile(this.file, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
  }

  closeAll() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const [id, project] of this.projects) this.stopProject(id, project);
  }
}
