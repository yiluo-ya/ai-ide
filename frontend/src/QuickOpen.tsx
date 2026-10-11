/** 快速打开浮层：Ctrl/Cmd+P 文件搜索、Ctrl/Cmd+T 符号搜索。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileNode, SymbolInfo } from './api';
import { api } from './api';
import { KindIcon } from './SidePanel';
import { useI18n } from './i18n';

export type QuickOpenMode = 'file' | 'symbol' | null;

interface Props {
  mode: QuickOpenMode;
  projectId: string | null;
  tree: FileNode | null;
  /** N21：最近打开的文件（空查询时优先展示；非空查询时给命中项加分）。 */
  recent?: string[];
  /** 当前打开的文件（项目内相对路径），用于「邻近」加成（同目录 / 同目录树）。 */
  currentFile?: string | null;
  onClose: () => void;
  onOpenFile: (file: string, line?: number, col?: number, endLine?: number, endCol?: number) => void;
}

function flattenFiles(tree: FileNode | null): string[] {
  const out: string[] = [];
  const walk = (n: FileNode) => {
    if (n.type === 'file') out.push(n.path);
    for (const c of n.children ?? []) walk(c);
  };
  if (tree) walk(tree);
  return out;
}

/**
 * 打分系数。
 *
 * 总式：`score = 基础档位分 + 命中位置修正 + 邻近加成 + 最近使用加成 - 路径深度惩罚`。
 *
 * 基础档位沿用旧实现的五档（精确 1000 / 文件名前缀 900 / 整路径前缀 800 /
 * 文件名子串 600 / 路径子串 500），其余各项都是叠加在档位之上的小修正。
 *
 * **关键不变量**：所有修正项之和的绝对值 < 100（最小档距），所以修正永远不跨档——
 * 精确匹配必然排在非精确之前（最近使用加成压不过它），文件名命中必然排在路径命中之前。
 * 每一项的取值理由见下面逐条注释。
 */
export const QUICKOPEN_WEIGHTS = {
  /** 基础档位分（沿用旧实现，别动：档距 100 是上面不变量成立的前提）。 */
  exact: 1000,
  basenamePrefix: 900,
  pathPrefix: 800,
  basenameSubstr: 600,
  pathSubstr: 500,
  /**
   * (a) 命中落在 basename（最后一个路径段）而非目录段上：+20。
   * 900/600 两档本就只认 basename，这里把它显式化成一项加成，
   * 让「文件名命中」在打分公式里有独立、可解释的权重；
   * 20 远小于档距 100，只够在同档内拉开明显差距，不会翻档。
   */
  basenameHit: 20,
  /**
   * (b) 目录层数惩罚：每层 2 分，最多计 10 层（封顶 -20）。
   * 取小值的原因：深路径里的**强命中**（如文件名前缀）不该被惩罚淹没，
   * 2 分/层只够调整同档内排名，跨不过 100 的档距；封顶则避免超深路径被过度惩罚。
   */
  depthPerLevel: 2,
  maxDepthLevels: 10,
  /**
   * (c1) 与当前打开文件同目录：+12。
   * 比 basenameHit(20) 弱一档——「就在我正看的文件旁边」是弱信号，
   * 不该压过更精确的匹配，只该在同档内把邻居提上来。
   */
  sameDir: 12,
  /**
   * (c2) 同目录树（与当前文件共享更长的目录前缀）：每共享一层 +3，最多 4 层。
   * 比 sameDir 更弱（共享 4 层封顶才 12），因为共享前缀越长信息量越少；
   * 封顶同时防止超长路径靠深度刷分。
   */
  sharedPrefixPerLevel: 3,
  maxSharedPrefixLevels: 4,
  /**
   * (d) 最近打开过：+15，固定加成。
   * 单独加成即可覆盖「刚用过」的偏好；上界核算：
   * 文件名前缀档 900 + 全部正修正 (20+12+12+15=59) = 959 <
   * 精确档下界 1000 - 深度惩罚上界 20 = 980，所以 recent 压不过精确匹配。
   */
  recent: 15,
};

/** 结果条数上限（保持旧实现的 60 不变）。 */
export const QUICKOPEN_LIMIT = 60;

export interface ScoreContext {
  /** 当前打开的文件（项目内相对路径）；缺省时不做邻近加成。 */
  currentFile?: string | null;
  /** 最近打开过的文件（按最近访问倒序）；命中则加 `recent` 分。 */
  recent?: readonly string[];
}

/** 目录段（去掉 basename），统一小写以便比较。 */
function dirsOf(path: string): string[] {
  const segs = path.split('/');
  segs.pop();
  return segs;
}

/**
 * 模糊匹配打分：档位分 + 修正项，分数越高越靠前；0 表示不匹配（会被过滤掉）。
 *
 * 导出是为了单测（组件行为不变）。
 */
export function score(text: string, query: string, ctx: ScoreContext = {}): number {
  if (!query) return 1;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const base = t.split('/').pop() ?? t;
  const baseAt = t.length - base.length; // basename 在整条路径中的起点

  let total: number;
  let hitAt: number;
  if (t === q) {
    total = QUICKOPEN_WEIGHTS.exact;
    hitAt = 0;
  } else if (base.startsWith(q)) {
    total = QUICKOPEN_WEIGHTS.basenamePrefix - base.length;
    hitAt = baseAt;
  } else if (t.startsWith(q)) {
    total = QUICKOPEN_WEIGHTS.pathPrefix - t.length;
    hitAt = 0;
  } else {
    const i = base.indexOf(q);
    if (i >= 0) {
      total = QUICKOPEN_WEIGHTS.basenameSubstr - i - base.length * 0.1;
      hitAt = baseAt + i;
    } else {
      const j = t.indexOf(q);
      if (j < 0) return 0; // 不匹配：过滤掉
      total = QUICKOPEN_WEIGHTS.pathSubstr - j - t.length * 0.1;
      hitAt = j;
    }
  }

  // (a) 命中落在 basename 上（而非目录段）：显式加分
  if (hitAt >= baseAt) total += QUICKOPEN_WEIGHTS.basenameHit;

  // (b) 路径深度惩罚：目录越深扣越多，封顶
  total -= Math.min(dirsOf(t).length, QUICKOPEN_WEIGHTS.maxDepthLevels) * QUICKOPEN_WEIGHTS.depthPerLevel;

  // (c) 邻近加成：相对「当前打开文件」
  if (ctx.currentFile) {
    const cur = ctx.currentFile.toLowerCase();
    const dirs = dirsOf(t);
    const curDirs = dirsOf(cur);
    if (dirs.join('/') === curDirs.join('/')) total += QUICKOPEN_WEIGHTS.sameDir;
    let shared = 0;
    while (shared < dirs.length && shared < curDirs.length && dirs[shared] === curDirs[shared]) shared += 1;
    total += Math.min(shared, QUICKOPEN_WEIGHTS.maxSharedPrefixLevels) * QUICKOPEN_WEIGHTS.sharedPrefixPerLevel;
  }

  // (d) 最近打开过：固定加成
  if (ctx.recent?.length && ctx.recent.some((r) => r.toLowerCase() === t)) total += QUICKOPEN_WEIGHTS.recent;

  return total;
}

/**
 * 候选排序：按分数倒序，分数相同按路径字典序（保证同分不随输入顺序抖动），取前 60 条。
 * 导出是为了单测（组件行为不变）。
 */
export function rankFiles(files: readonly string[], query: string, ctx: ScoreContext = {}): string[] {
  return files
    .map((f) => ({ f, s: score(f, query, ctx) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (a.f < b.f ? -1 : a.f > b.f ? 1 : 0))
    .slice(0, QUICKOPEN_LIMIT)
    .map((x) => x.f);
}

export function QuickOpen({ mode, projectId, tree, recent = [], currentFile = null, onClose, onOpenFile }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [symbols, setSymbols] = useState<SymbolInfo[]>([]);
  const [kind, setKind] = useState('');
  const [hideTests, setHideTests] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const files = useMemo(() => flattenFiles(tree), [tree]);

  useEffect(() => {
    setQuery('');
    setCursor(0);
    inputRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    if (mode !== 'symbol' || !projectId) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void api
        .workspaceSymbols(projectId, query.trim(), kind || undefined)
        .then((list) => {
          if (!cancelled) setSymbols(list);
        })
        .catch(() => {
          if (!cancelled) setSymbols([]);
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mode, projectId, query, kind]);

  const fileResults = useMemo(() => {
    if (mode !== 'file') return [];
    // N21：空查询时先给「最近打开」（按最近访问倒序）
    if (!query.trim() && recent.length) {
      return recent.filter((f) => files.includes(f));
    }
    return rankFiles(files, query, { currentFile, recent });
  }, [mode, files, query, recent, currentFile]);

  if (!mode) return null;

  // N8：测试文件来源的符号单独标注，可过滤（"这个符号只有测试在用"）
  const shown = hideTests ? symbols.filter((s) => !s.isTest) : symbols;
  const results = mode === 'file' ? fileResults : shown;

  const pick = (index: number) => {
    if (mode === 'file') {
      const file = fileResults[index];
      // 不带行号：交给位置记忆（N22）决定回到哪里，而不是硬回第 1 行
      if (file) onOpenFile(file);
    } else {
      const sym = shown[index];
      if (sym) {
        onOpenFile(
          sym.location.file,
          sym.location.range.start.line,
          sym.location.range.start.col,
          sym.location.range.end.line,
          sym.location.range.end.col,
        );
      }
    }
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(cursor);
    }
  };

  return (
    <div className="quickopen-backdrop" onClick={onClose}>
      <div className="quickopen" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="quickopen-input"
          placeholder={
            mode === 'file'
              ? recent.length
                ? t('quickopen.placeholderFileRecent')
                : t('quickopen.placeholderFile')
              : t('quickopen.placeholderSymbol')
          }
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="quickopen-filters">
          {mode === 'symbol' && (
            <>
              <select className="ov-select" value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="">{t('quickopen.allKinds')}</option>
                {['function', 'method', 'class', 'interface', 'variable', 'constant', 'type'].map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <label className="quickopen-toggle">
                <input type="checkbox" checked={hideTests} onChange={(e) => setHideTests(e.target.checked)} />
                {t('quickopen.onlyNonTest')}
              </label>
            </>
          )}
        </div>
        <div className="quickopen-list">
          {results.length === 0 && <div className="quickopen-empty">{t('quickopen.empty')}</div>}
          {mode === 'file'
            ? fileResults.map((f, i) => (
                <div
                  key={f}
                  className={`quickopen-item ${i === cursor ? 'active' : ''}`}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => pick(i)}
                >
                  <span className="quickopen-name">{f.split('/').pop()}</span>
                  {!query.trim() && recent.includes(f) && <span className="refs-badge">{t('quickopen.recent')}</span>}
                  <span className="quickopen-path">{f}</span>
                </div>
              ))
            : shown.map((s, i) => (
                <div
                  key={`${s.name}:${s.location.file}:${s.location.range.start.line}`}
                  className={`quickopen-item ${i === cursor ? 'active' : ''}`}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => pick(i)}
                >
                  <KindIcon kind={s.kind} />
                  <span className="quickopen-name">{s.name}</span>
                  {s.isTest && <span className="refs-badge">{t('quickopen.test')}</span>}
                  <span className="quickopen-path">
                    {s.location.file}:{s.location.range.start.line}
                    {s.containerName ? ` · ${s.containerName}` : ''}
                  </span>
                </div>
              ))}
        </div>
      </div>
    </div>
  );
}
