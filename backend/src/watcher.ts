/** 文件监听：项目目录变更 → 增量更新索引，并向订阅者推送事件。 */
import chokidar from 'chokidar';
import type { FSWatcher } from 'chokidar';
import { IGNORE_FILES } from './indexer/ignore';
import type { ProjectIndex } from './indexer/store';

export class ProjectWatcher {
  private watcher: FSWatcher | null = null;
  private readonly pending = new Map<string, 'change' | 'add' | 'unlink'>();
  private timer: NodeJS.Timeout | null = null;
  private readonly root: string;
  private readonly debounceMs: number;

  constructor(private readonly project: ProjectIndex, debounceMs = 300) {
    this.root = project.root;
    this.debounceMs = debounceMs;
    this.start();
  }

  private relOf(absPath: string): string {
    const posix = absPath.split(/[\\/]/).join('/');
    if (posix.length <= this.root.length + 1) return '';
    return posix.slice(this.root.length + 1);
  }

  private start() {
    this.watcher = chokidar.watch(this.root, {
      // P8：忽略判定统一走 IgnoreMatcher（内置黑名单 + .gitignore + .wcrignore）。
      // chokidar 的 ignored 回调拿不到类型时按目录口径剪枝（与改造前的段匹配等价）。
      ignored: (p: string, stats?: { isDirectory?: () => boolean }) => {
        const rel = this.relOf(p);
        if (!rel || rel.startsWith('..')) return false;
        const isDir = stats?.isDirectory ? stats.isDirectory() : true;
        return this.project.ignoresPath(rel, isDir);
      },
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: this.debounceMs, pollInterval: 100 },
      depth: 20,
    });
    this.watcher.on('change', (p: string) => this.queue(p, 'change'));
    this.watcher.on('add', (p: string) => this.queue(p, 'add'));
    this.watcher.on('unlink', (p: string) => this.queue(p, 'unlink'));
  }

  private queue(absPath: string, kind: 'change' | 'add' | 'unlink') {
    const rel = this.relOf(absPath);
    if (!rel || rel.startsWith('..')) return;
    // 同一文件多次事件合并：unlink 优先，其次 add
    const prev = this.pending.get(rel);
    if (prev === 'unlink') return;
    this.pending.set(rel, kind === 'change' && prev === 'add' ? 'add' : kind);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.debounceMs);
  }

  private async flush() {
    const batch = [...this.pending.entries()];
    this.pending.clear();
    if (!batch.length) return;
    let ignoreRulesChanged = false;
    for (const [rel, kind] of batch) {
      try {
        if (isIgnoreRuleFile(rel)) ignoreRulesChanged = true;
        if (kind === 'unlink') await this.project.onFileDeleted(rel);
        else if (kind === 'add') await this.project.onFileCreated(rel);
        else await this.project.onFileChanged(rel);
      } catch {
        /* 单个文件失败不影响其它文件 */
      }
    }
    // P8：忽略规则文件本身变更 → 重新加载规则并全量重索引（规则生效要看得见）
    if (ignoreRulesChanged) {
      try {
        await this.project.reloadIgnore();
        await this.project.reindexAll();
      } catch {
        /* 重索引失败由 project 自己记 status.error */
      }
    }
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    void this.watcher?.close();
    this.watcher = null;
  }
}

function isIgnoreRuleFile(rel: string): boolean {
  const name = rel.split('/').pop() ?? rel;
  return (IGNORE_FILES as readonly string[]).includes(name) && !rel.includes('/');
}
