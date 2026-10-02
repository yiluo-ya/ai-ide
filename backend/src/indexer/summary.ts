/**
 * 文件级结构性摘要（04 Guide · G6.1 / G6.3 / G6.4）：把索引里已有的
 * 导出 / import / 引用 / 行数事实拼成一段中文摘要句，**不调模型**。
 *
 * 口径全部复用、不另起一套：
 * - 「被谁引用」来自 01 地图的 `projectMap().edges`（与热点榜同一个文件级引用口径）；
 * - 「是不是测试文件」来自 `insight.isTestFile`；
 * - 「import 落在项目内还是外部」来自 `guide.importTargets`（与依赖序同一条边）。
 * 拿不到的关系一律不出现在结果里，绝不编造。
 */
import type { FileSummary, LangId, SymbolKind } from '../types';
import { importTargets } from './guide';
import { isTestFile, projectMap } from './insight';
import type { ProjectIndex } from './store';

/** 摘要句里的 kind 中文名；没列到的 kind 如实回落到原值。 */
const KIND_LABEL: Partial<Record<SymbolKind, string>> = {
  class: '类',
  struct: '结构体',
  interface: '接口',
  enum: '枚举',
  enumMember: '枚举成员',
  type: '类型',
  function: '函数',
  method: '方法',
  constructor: '构造函数',
  property: '属性',
  field: '字段',
  variable: '变量',
  constant: '常量',
  module: '模块',
  namespace: '命名空间',
  package: '包',
};

/** 「2 类 1 函数」——按出现次数降序、同数量按名字字典序，保证同一文件句子稳定。 */
function kindBreakdown(items: Array<{ kind: SymbolKind }>): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const label = KIND_LABEL[item.kind] ?? item.kind;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, n]) => `${n} ${label}`)
    .join(' ');
}

/** 模板化摘要句：凑不出事实的部分自然降级，不写「未知来源」这类占位。 */
function sentenceOf(
  exports: Array<{ kind: SymbolKind }>,
  imports: { project: number; external: number },
  inbound: { total: number; tests: number },
): string {
  const parts: string[] = [];
  parts.push(exports.length ? `导出 ${exports.length} 个符号（${kindBreakdown(exports)}）` : '无导出符号');

  if (imports.project && imports.external) {
    parts.push(`依赖 ${imports.project} 个项目内模块与 ${imports.external} 个外部模块`);
  } else if (imports.project) {
    parts.push(`依赖 ${imports.project} 个项目内模块`);
  } else if (imports.external) {
    parts.push(`依赖 ${imports.external} 个外部模块`);
  } else {
    parts.push('不依赖其它模块');
  }

  if (inbound.total) {
    const fromTests = inbound.tests ? `（其中 ${inbound.tests} 处来自测试）` : '';
    parts.push(`被 ${inbound.total} 处引用${fromTests}`);
  } else {
    parts.push('未被项目内引用');
  }
  return `${parts.join('，')}。`;
}

/**
 * 单个文件的结构性摘要。文件不在符号索引内（非源码 / 过大 / 不存在）返回 null。
 */
export function fileSummary(project: ProjectIndex, file: string): FileSummary | null {
  const fi = project.files.get(file);
  if (!fi) return null;
  const map = projectMap(project);
  const fact = map.facts.get(file);

  // 顶层定义：挂在「文件顶层作用域」上的非局部定义
  const rootScope = [...fi.scopes.values()].find((s) => s.kind === 'file' && s.parent === null);
  const rootId = rootScope?.id ?? `${fi.file}#s0`;
  const exports = fi.definitions
    .filter((d) => !d.local && d.scopeId === rootId)
    .sort((a, b) => a.nameRange.start.line - b.nameRange.start.line || a.name.localeCompare(b.name))
    .map((d) => ({ name: d.name, kind: d.kind, line: d.nameRange.start.line }));

  // import：解析到项目内文件 vs 外部（后者含未解析出来的模块说明符）
  let projectImports = 0;
  let externalImports = 0;
  for (const scope of fi.importsByScope.values()) {
    for (const imp of scope.values()) {
      if (importTargets(project, fi, imp).length) projectImports++;
      else externalImports++;
    }
  }

  // inbound：谁引用了本文件（排除自身）；条目数 = 01 地图边上的 import + ref 计数
  const files: Array<{ file: string; count: number }> = [];
  let total = 0;
  let tests = 0;
  for (const [from, row] of map.edges) {
    if (from === file) continue;
    const cell = row.get(file);
    if (!cell) continue;
    const count = cell.import + cell.ref;
    files.push({ file: from, count });
    total += count;
    if (isTestFile(from)) tests += count;
  }
  files.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));

  const inbound = { total, files, tests };
  return {
    exports,
    imports: { project: projectImports, external: externalImports },
    inbound,
    outbound: fact?.outDegree ?? map.edges.get(file)?.size ?? 0,
    longestFunction: fact?.longestFunction ?? 0,
    lines: fact?.lines ?? 0,
    lang: (fact?.lang ?? fi.lang) as LangId,
    revision: String(project.indexVersion),
    sentence: sentenceOf(exports, { project: projectImports, external: externalImports }, inbound),
  };
}
