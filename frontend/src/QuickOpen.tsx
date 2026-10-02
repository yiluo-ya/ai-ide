/** 快速打开浮层：Ctrl/Cmd+P 文件搜索、Ctrl/Cmd+T 符号搜索。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileNode, SymbolInfo } from './api';
import { api } from './api';
import { KindIcon } from './SidePanel';

export type QuickOpenMode = 'file' | 'symbol' | null;

interface Props {
  mode: QuickOpenMode;
  projectId: string | null;
  tree: FileNode | null;
  /** N21：最近打开的文件（空查询时优先展示）。 */
  recent?: string[];
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

/** 简易打分：前缀 > 子串 > 路径子串。 */
function score(text: string, query: string): number {
  if (!query) return 1;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (t === q) return 1000;
  const base = t.split('/').pop() ?? t;
  if (base.startsWith(q)) return 900 - base.length;
  if (t.startsWith(q)) return 800 - t.length;
  const i = base.indexOf(q);
  if (i >= 0) return 600 - i - base.length * 0.1;
  const j = t.indexOf(q);
  if (j >= 0) return 500 - j - t.length * 0.1;
  return 0;
}

export function QuickOpen({ mode, projectId, tree, recent = [], onClose, onOpenFile }: Props) {
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
    return files
      .map((f) => ({ f, s: score(f, query) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map((x) => x.f);
  }, [mode, files, query, recent]);

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
                ? '按文件名搜索（Ctrl/Cmd+P）· 空查询显示最近打开'
                : '按文件名搜索（Ctrl/Cmd+P）'
              : '按符号名搜索（Ctrl/Cmd+T）'
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
                <option value="">全部类型</option>
                {['function', 'method', 'class', 'interface', 'variable', 'constant', 'type'].map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <label className="quickopen-toggle">
                <input type="checkbox" checked={hideTests} onChange={(e) => setHideTests(e.target.checked)} />
                只看非测试
              </label>
            </>
          )}
        </div>
        <div className="quickopen-list">
          {results.length === 0 && <div className="quickopen-empty">无匹配结果</div>}
          {mode === 'file'
            ? fileResults.map((f, i) => (
                <div
                  key={f}
                  className={`quickopen-item ${i === cursor ? 'active' : ''}`}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => pick(i)}
                >
                  <span className="quickopen-name">{f.split('/').pop()}</span>
                  {!query.trim() && recent.includes(f) && <span className="refs-badge">最近</span>}
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
                  {s.isTest && <span className="refs-badge">测试</span>}
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
