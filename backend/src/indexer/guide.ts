/**
 * 阅读路线（04 Guide · W1）：把索引里已有的文件级事实，排成「先读谁、后读谁」的四条清单。
 *
 * G2.1 依赖序：沿项目内 import 边建图，Tarjan SCC 缩点后按 DAG 层序展开（环内文件相邻）。
 * G2.2 入口向下：从 looksLikeEntry 的文件出发，沿 import 边 BFS。
 * G2.3 热度序：按「被项目内不同文件引用数」降序（口径直接取 01 地图的 FileFacts.inDegree）。
 * G2.4 新鲜度序：按文件 mtimeMs 降序。
 *
 * 三条纪律（与 01 / 03 一致）：
 * 1) 只复述索引里能确认的事实（import 边、引用计数、mtime），不做「重要性」裁决；
 * 2) 每一步都带一句「为什么是它 / 为什么在这个位置」，让顺序可核对；
 * 3) 只读 —— 不执行构建、不调模型；路线只是建议，任何一步都能被用户改掉。
 */
import type { GuideRoute, GuideRouteKind, GuideRouteStep, GuideRoutesResult, LangId } from '../types';
import { findCycles, isDocOrConfig, isTestFile, looksLikeEntry, projectMap, type FileFacts } from './insight';
import type { FileIndex, ImportRecord } from './model';
import { documentSymbols, moduleFiles } from './resolver';
import type { ProjectIndex } from './store';

/** 每条路线最多给多少步：阅读者不会按 300 步走（04-guide-plan §6 风险处置）。 */
export const GUIDE_ROUTE_LIMIT = 40;

/** 路线中文名（前端「换一条」按这个顺序展示）。 */
export const ROUTE_LABEL: Record<GuideRouteKind, string> = {
  dep: '依赖序',
  entry: '入口向下',
  hot: '热度序',
  fresh: '新鲜度序',
};

// ---------------------------------------------------------------- import 边

/**
 * 一条 import 指向的项目内文件。
 * 优先用 `ImportRecord.resolvedFile` 这个解析缓存，缺失时回落到 resolver 的 `moduleFiles`；
 * `dir/` 形式的包目录按前缀展开（与 01 地图的文件级 import 边同口径），`./` 表示整仓、不建边。
 */
export function importTargets(project: ProjectIndex, fi: FileIndex, imp: ImportRecord): string[] {
  const raws: string[] = imp.resolvedFile ? [imp.resolvedFile] : moduleFiles(project, fi, imp);
  const out: string[] = [];
  for (const raw of raws) {
    if (!raw || raw === './') continue;
    if (raw.endsWith('/')) {
      const prefix = raw.replace(/\/+$/, '');
      for (const rel of project.files.keys()) {
        if (rel !== fi.file && rel.startsWith(`${prefix}/`)) out.push(rel);
      }
      continue;
    }
    if (raw !== fi.file && project.files.has(raw)) out.push(raw);
  }
  return [...new Set(out)];
}

/** 文件级 import 依赖图：`out` 的键是本项目文件，值是它 import 到的项目内文件（去重）。 */
type ImportGraph = Map<string, Map<string, true>>;

function importGraph(project: ProjectIndex): ImportGraph {
  const graph: ImportGraph = new Map();
  for (const fi of project.files.values()) {
    let row = graph.get(fi.file);
    if (!row) {
      row = new Map();
      graph.set(fi.file, row);
    }
    for (const scope of fi.importsByScope.values()) {
      for (const imp of scope.values()) {
        for (const target of importTargets(project, fi, imp)) row.set(target, true);
      }
    }
  }
  return graph;
}

const depsOf = (graph: ImportGraph, file: string): string[] =>
  [...(graph.get(file)?.keys() ?? [])].filter((d) => d !== file).sort();

// ---------------------------------------------------------------- 装配

interface Pending {
  file: string;
  reason: string;
}

/** 取 map 里的一组文件事实（三档着色 / 热度 / 测试判定都与 01 地图同源）。 */
type FactsMap = Map<string, FileFacts>;

function toRoute(kind: GuideRouteKind, facts: FactsMap, pending: Pending[]): GuideRoute {
  const steps: GuideRouteStep[] = pending.slice(0, GUIDE_ROUTE_LIMIT).map((item, i) => {
    const fact = facts.get(item.file);
    return {
      order: i + 1,
      file: item.file,
      reason: item.reason,
      lang: (fact?.lang ?? 'plaintext') as LangId,
      lines: fact?.lines ?? 0,
      test: fact?.test ?? isTestFile(item.file),
      // 行级指引由 buildRoutes 里的 withHints 统一填（这里给安全默认值）
      line: 1,
      hints: [],
    };
  });
  return {
    kind,
    label: ROUTE_LABEL[kind],
    total: pending.length,
    truncated: pending.length > steps.length,
    steps,
  };
}

/** 「a.ts、b.ts」或「a.ts 等 3 个文件」——理由句里的文件罗列。 */
function listNames(files: string[]): string {
  if (files.length <= 2) return files.join('、');
  return `${files[0]} 等 ${files.length} 个文件`;
}

// ---------------------------------------------------------------- G2.1 依赖序

function depReason(file: string, group: string[], deps: string[], orderOf: Map<string, number>): string {
  // 环内共享一句理由：不假装解开了环，只说明它们是一组
  if (group.length > 1) {
    const others = group.filter((x) => x !== file).sort();
    return `与 ${others.join('、')} 互相依赖（循环依赖组）`;
  }
  if (!deps.length) return '不依赖项目内其它文件，可先读';
  const steps = deps
    .map((d) => orderOf.get(d))
    .filter((n): n is number => typeof n === 'number')
    .sort((a, b) => a - b);
  const at = steps.length ? `第 ${steps.join('、')} 步，已排在前` : '已排在前';
  return `依赖 ${listNames(deps)}（${at}）`;
}

/**
 * 依赖序：SCC 缩点 → 组间 DAG 分层 → 层内 / 组内按文件名字典序。
 * 环（size>1）压成一个「组」当作一层，成员连续排列并共享一句 reason。
 */
function depRoute(files: string[], graph: ImportGraph, facts: FactsMap): GuideRoute {
  const cycles = findCycles(files, graph);
  const groupOf = new Map<string, number>();
  const groups: string[][] = [];
  for (const comp of cycles) {
    const id = groups.length;
    groups.push(comp);
    for (const f of comp) groupOf.set(f, id);
  }
  for (const f of files) {
    if (groupOf.has(f)) continue;
    groupOf.set(f, groups.length);
    groups.push([f]);
  }

  // 组间边（组内边不参与分层，否则 DAG 会自指）
  const gdeps = new Map<number, Set<number>>();
  const grev = new Map<number, Set<number>>();
  for (const f of files) {
    const gf = groupOf.get(f)!;
    for (const dep of depsOf(graph, f)) {
      const gd = groupOf.get(dep);
      if (gd === undefined || gd === gf) continue;
      let deps = gdeps.get(gf);
      if (!deps) {
        deps = new Set();
        gdeps.set(gf, deps);
      }
      deps.add(gd);
      let rev = grev.get(gd);
      if (!rev) {
        rev = new Set();
        grev.set(gd, rev);
      }
      rev.add(gf);
    }
  }

  // Kahn 分层：level = 依赖链上的最长路（保证「被依赖者在前」，且同一层内可比）
  const indeg = new Map<number, number>();
  for (let g = 0; g < groups.length; g++) indeg.set(g, gdeps.get(g)?.size ?? 0);
  const level = new Map<number, number>();
  const queue: number[] = [];
  for (let g = 0; g < groups.length; g++) {
    if ((indeg.get(g) ?? 0) === 0) {
      level.set(g, 0);
      queue.push(g);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const g = queue[i];
    const lv = level.get(g) ?? 0;
    for (const next of grev.get(g) ?? []) {
      level.set(next, Math.max(level.get(next) ?? 0, lv + 1));
      const left = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, left);
      if (left === 0) queue.push(next);
    }
  }

  const gorder = groups
    .map((_, g) => g)
    .sort((a, b) => (level.get(a) ?? 0) - (level.get(b) ?? 0) || groups[a][0].localeCompare(groups[b][0]));

  const pending: Pending[] = [];
  const orderOf = new Map<string, number>();
  for (const g of gorder) {
    for (const f of groups[g]) {
      orderOf.set(f, pending.length + 1);
      pending.push({ file: f, reason: '' });
    }
  }
  for (const item of pending) {
    item.reason = depReason(item.file, groups[groupOf.get(item.file)!], depsOf(graph, item.file), orderOf);
  }
  return toRoute('dep', facts, pending);
}

// ---------------------------------------------------------------- G2.2 入口向下

function entryReason(fact: FileFacts | undefined): string {
  const reasons = fact?.entryReasons ?? [];
  return reasons.length ? `入口候选：${reasons.join('；')}` : '文件名像入口';
}

/** 入口向下：起点是入口候选（按被引用数降序），沿 import 边 BFS，同层按出度降序。 */
function entryRoute(files: string[], graph: ImportGraph, facts: FactsMap, depOrder: string[]): GuideRoute {
  const inDeg = (f: string) => facts.get(f)?.inDegree ?? 0;
  const outDeg = (f: string) => graph.get(f)?.size ?? 0;

  const pending: Pending[] = [];
  const seen = new Set<string>();
  const orderOf = new Map<string, number>();
  const take = (file: string, reason: string) => {
    seen.add(file);
    orderOf.set(file, pending.length + 1);
    pending.push({ file, reason });
  };

  let frontier = files
    .filter((f) => looksLikeEntry(f))
    .sort((a, b) => inDeg(b) - inDeg(a) || a.localeCompare(b));
  if (!frontier.length) {
    // 没有入口候选时不编造入口，退化为依赖序的第 1 步
    const first = depOrder[0];
    frontier = first ? [first] : [];
    if (first) take(first, '没有识别到入口候选，退化为依赖序的第 1 步');
  } else {
    for (const f of frontier) take(f, entryReason(facts.get(f)));
  }

  while (frontier.length) {
    const next: string[] = [];
    for (const parent of frontier) {
      const children = depsOf(graph, parent)
        .filter((c) => !seen.has(c))
        .sort((a, b) => outDeg(b) - outDeg(a) || a.localeCompare(b));
      for (const c of children) {
        if (seen.has(c)) continue;
        take(c, `由第 ${orderOf.get(parent)} 步的 ${parent} 引入`);
        next.push(c);
      }
    }
    frontier = next;
  }

  // 入口够不到的（可能是被裁剪掉的分支）：仍列出来，但如实说明它没被引到
  const rest = files
    .filter((f) => !seen.has(f))
    .sort((a, b) => inDeg(b) - inDeg(a) || a.localeCompare(b));
  for (const f of rest) {
    const n = inDeg(f);
    take(f, n > 0 ? `未被入口文件引到，按被引用数排（被 ${n} 个文件引用）` : '未被入口文件引到，也没有项目内引用');
  }
  return toRoute('entry', facts, pending);
}

// ---------------------------------------------------------------- G2.3 热度序

/** 热度序：按「被项目内不同文件引用数」降序；口径来自 01 地图，不另起一套。 */
function hotRoute(files: string[], facts: FactsMap): GuideRoute {
  const hot = (f: string) => facts.get(f)?.inDegree ?? 0;
  const sorted = [...files].sort((a, b) => hot(b) - hot(a) || a.localeCompare(b));
  const pending: Pending[] = sorted.map((file) => {
    const n = hot(file);
    if (n > 0) return { file, reason: `被 ${n} 个文件引用，是热点` };
    if (facts.get(file)?.entry) return { file, reason: '未被项目内文件引用（入口候选）' };
    return { file, reason: '未被项目内文件引用' };
  });
  return toRoute('hot', facts, pending);
}

// ---------------------------------------------------------------- G2.4 新鲜度序

function freshReason(mtimeMs: number, now: number): string {
  if (!mtimeMs) return '改动时间未知';
  const diff = now - mtimeMs;
  if (diff <= 0) return '刚刚改动';
  if (diff < 60 * 60_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前改动`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前改动`;
  return `${Math.floor(diff / 86_400_000)} 天前改动`;
}

/** 新鲜度序：按 mtimeMs 降序（优先取扫描时的 entries.mtimeMs，回落到索引里的 mtimeMs）。 */
function freshRoute(project: ProjectIndex, files: string[], facts: FactsMap): GuideRoute {
  const mtimeOf = (f: string) => project.entries.get(f)?.mtimeMs ?? project.files.get(f)?.mtimeMs ?? 0;
  const now = Date.now();
  const sorted = [...files].sort((a, b) => mtimeOf(b) - mtimeOf(a) || a.localeCompare(b));
  return toRoute('fresh', facts, sorted.map((file) => ({ file, reason: freshReason(mtimeOf(file), now) })));
}

// ---------------------------------------------------------------- 入口

/**
 * 给每一步补「先看哪一行、关注哪几个符号」。
 * 路线只说「读哪个文件」不够用：打开一个 800 行的文件，人还得自己找入口。
 * 符号取不到（未索引 / 解析失败）时退回 line=1、hints=[]，不影响路线本身。
 */
function withHints(project: ProjectIndex, route: GuideRoute): GuideRoute {
  return {
    ...route,
    steps: route.steps.map((step) => {
      let hints: GuideRouteStep['hints'] = [];
      try {
        hints = documentSymbols(project, step.file)
          .slice(0, 3)
          .map((s) => ({ name: s.name, line: s.location.range.start.line, kind: s.kind }));
      } catch {
        hints = [];
      }
      return { ...step, hints, line: hints[0]?.line ?? 1 };
    }),
  };
}

/**
 * 四条路线一次算全（顺序固定：依赖序 / 入口向下 / 热度序 / 新鲜度序）。
 * 索引未跑完时 `partial: true`，只基于当前已索引文件给结果，不报错。
 */
export function buildRoutes(project: ProjectIndex): GuideRoutesResult {
  const facts = projectMap(project).facts;
  // 文档 / 配置（README、ini 这类）不进路线：路线回答「该读哪些代码」，
  // 与下面的进度分母（sourceFiles）同一口径，否则分母 5 而步骤 7，进度永远到不了 100%。
  const files = [...facts.keys()].filter((f) => !isDocOrConfig(f)).sort();
  const graph = importGraph(project);
  const dep = depRoute(files, graph, facts);
  const entry = entryRoute(files, graph, facts, dep.steps.map((s) => s.file));
  const hot = hotRoute(files, facts);
  const fresh = freshRoute(project, files, facts);
  // G3.2 进度分母：只数源码文件，测试与文档 / 配置不算「该读完的代码」
  const sourceFiles = files.filter((f) => !isTestFile(f) && !isDocOrConfig(f)).length;
  const routes = [dep, entry, hot, fresh].map((route) => withHints(project, route));
  return { routes, partial: project.status.indexing, sourceFiles };
}
