/** 侧栏：大纲（当前文件符号树）与全项目搜索。 */
import { useEffect, useMemo, useState } from 'react';
import type { SymbolInfo } from './api';
import type { RefsState, SearchHit } from './state';
import type { TypeNode } from '../../shared/types';
import { useI18n } from './i18n';

/** 继承关系的中文说法（与层级面板同一套口径）。 */
const RELATION_TEXT: Record<TypeNode['relation'], string> = {
  extends: 'side.relExtends',
  implements: 'side.relImplements',
  embeds: 'side.relEmbeds',
  overrides: 'side.relOverrides',
};

/**
 * 大纲只显示「有结构意义」的符号：类 / 接口 / 结构体 / 枚举（含内部类，即嵌套在类里的类）
 * 与函数 / 方法。变量、字段、属性、导入这些不显示 —— 2026-10-03 用户要求：
 * 「大纲只显示方法和内部类就行，变量不用显示」。
 */
const OUTLINE_KINDS = new Set([
  'class',
  'interface',
  'struct',
  'enum',
  'function',
  'method',
  'constructor',
  'module',
  'namespace',
]);

/** 递归过滤符号树：不在上述集合里的节点被丢掉（其子节点上提一层，不丢失结构）。 */
export function filterOutline(symbols: SymbolInfo[]): SymbolInfo[] {
  const out: SymbolInfo[] = [];
  for (const s of symbols) {
    const children = filterOutline(s.children ?? []);
    if (OUTLINE_KINDS.has(s.kind)) {
      out.push(children.length ? { ...s, children } : { ...s, children: [] });
    } else {
      // 容器本身不显示（如 variable），但它的子节点仍要保留 —— 上提到本层
      out.push(...children);
    }
  }
  return out;
}

const KIND_ICON: Record<string, string> = {
  class: 'C',
  interface: 'I',
  struct: 'S',
  enum: 'E',
  enumMember: 'e',
  function: 'ƒ',
  method: 'm',
  constructor: 'c',
  property: 'p',
  field: 'f',
  variable: 'v',
  constant: 'k',
  type: 't',
  namespace: 'N',
  module: 'M',
  import: 'i',
};

export function KindIcon({ kind }: { kind: string }) {
  return <span className={`kind-icon kind-${kind}`}>{KIND_ICON[kind] ?? '·'}</span>;
}

// ------------------------------------------------------------------ 大纲

/** 大纲节点的稳定键：同一文件里 name + 起始行足够唯一。 */
function outlineKey(symbol: SymbolInfo): string {
  return `${symbol.name}:${symbol.location.range.start.line}`;
}

function OutlineNode({
  symbol,
  depth,
  activeLine,
  onJump,
  overrides,
  cursorPath,
  onToggle,
}: {
  symbol: SymbolInfo;
  depth: number;
  activeLine: number;
  onJump: (s: SymbolInfo) => void;
  /** 用户手动展开 / 折叠的覆盖（键 → 是否展开）。 */
  overrides: Record<string, boolean>;
  /** 光标所在符号链：自动展开，跟着阅读位置走。 */
  cursorPath: Set<string>;
  onToggle: (key: string, open: boolean) => void;
}) {
  const { t } = useI18n();
  const line = symbol.location.range.start.line;
  const key = outlineKey(symbol);
  const kids = symbol.children ?? [];
  // 默认只展开顶层一级与光标所在链 —— 大纲是骨架，不该一打开就铺满整屏。
  const open = overrides[key] ?? (depth === 0 || cursorPath.has(key));
  return (
    <div className="outline-node">
      <div
        className={`outline-row ${activeLine === line ? 'active' : ''}`}
        style={{ paddingLeft: depth * 12 + 6 }}
        onClick={() => onJump(symbol)}
        title={t('side.outlineRowTitle', { name: symbol.name, line })}
      >
        {kids.length > 0 ? (
          <button
            className={`outline-toggle ${open ? 'open' : ''}`}
            title={open ? t('side.collapse') : t('side.expand')}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(key, !open);
            }}
          >
            ▸
          </button>
        ) : (
          <span className="outline-toggle-space" />
        )}
        <KindIcon kind={symbol.kind} />
        <span className="outline-name">{symbol.name}</span>
        {symbol.detail && <span className="outline-detail">{symbol.detail}</span>}
      </div>
      {open &&
        kids.map((c) => (
          <OutlineNode
            key={`${c.name}:${c.location.range.start.line}`}
            symbol={c}
            depth={depth + 1}
            activeLine={activeLine}
            onJump={onJump}
            overrides={overrides}
            cursorPath={cursorPath}
            onToggle={onToggle}
          />
        ))}
    </div>
  );
}

export function OutlinePanel({
  symbols,
  fileName,
  cursorLine,
  onJump,
}: {
  symbols: SymbolInfo[];
  fileName: string | null;
  cursorLine: number;
  onJump: (symbol: SymbolInfo) => void;
}) {
  const { t } = useI18n();
  /** 手动展开 / 折叠的覆盖；缺省时按「顶层一级 + 光标链」展开。 */
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  if (!fileName) return <div className="panel-empty">{t('side.noFile')}</div>;
  // 只留方法与类（含内部类）：变量/字段/导入不进大纲
  const shown = filterOutline(symbols);
  if (!shown.length) return <div className="panel-empty">{t('side.noSymbols')}</div>;
  const cursorPath = new Set(symbolPathAt(shown, cursorLine).map(outlineKey));
  const allKeys: string[] = [];
  const collect = (list: SymbolInfo[]) => {
    for (const s of list) {
      allKeys.push(outlineKey(s));
      if (s.children?.length) collect(s.children);
    }
  };
  collect(shown);
  const setAll = (open: boolean) => setOverrides(Object.fromEntries(allKeys.map((k) => [k, open])));
  return (
    <div className="outline">
      <div className="outline-tools">
        <button className="btn ghost small" onClick={() => setAll(true)}>
          {t('side.expandAll')}
        </button>
        <button className="btn ghost small" onClick={() => setAll(false)}>
          {t('side.collapseAll')}
        </button>
      </div>
      {shown.map((s) => (
        <OutlineNode
          key={`${s.name}:${s.location.range.start.line}`}
          symbol={s}
          depth={0}
          activeLine={cursorLine}
          onJump={onJump}
          overrides={overrides}
          cursorPath={cursorPath}
          onToggle={(key, open) => setOverrides((prev) => ({ ...prev, [key]: open }))}
        />
      ))}
    </div>
  );
}

/** 从符号树里找出光标所在的最内层符号路径（面包屑用）。 */
export function symbolPathAt(symbols: SymbolInfo[], line: number): SymbolInfo[] {
  const walk = (list: SymbolInfo[]): SymbolInfo[] => {
    for (const s of list) {
      const r = s.range ?? s.location.range;
      if (line >= r.start.line && line <= r.end.line) {
        const inner = walk(s.children ?? []);
        return inner.length ? [s, ...inner] : [s];
      }
    }
    return [];
  };
  return walk(symbols);
}

// ------------------------------------------------------------------ 引用面板（N4）

interface RefRow {
  key: string;
  file: string;
  line: number;
  col: number;
  isTest: boolean;
  isDeclaration: boolean;
  isOrigin: boolean;
}

function sameLoc(a: { file: string; line: number; col: number }, b: { file: string; line: number; col: number }) {
  return a.file === b.file && a.line === b.line && a.col === b.col;
}

/**
 * 常驻引用面板：按文件分组、声明单列、测试标注与过滤、键盘上下 + Enter 跳转。
 * 与 Peek 浮层相比，它常驻、能一次走完，Esc 回到出发点。
 */
export function RefsPanel({
  data,
  busy,
  onJump,
  onCopy,
}: {
  data: RefsState | null;
  busy: boolean;
  onJump: (file: string, line: number, col: number) => void;
  /** 判据 6：复制这一行为 `path:line:col`。 */
  onCopy: (file: string, line: number, col: number) => void;
}) {
  const { t } = useI18n();
  const [hideTests, setHideTests] = useState(false);
  const [active, setActive] = useState(0);

  const rows = useMemo<RefRow[]>(() => {
    if (!data) return [];
    const decl = data.declaration;
    return data.locations.map((loc) => {
      const start = loc.range.start;
      const point = { file: loc.file, line: start.line, col: start.col };
      return {
        key: `${loc.file}:${start.line}:${start.col}`,
        file: loc.file,
        line: start.line,
        col: start.col,
        isTest: loc.isTest,
        isDeclaration: decl ? sameLoc(point, { file: decl.file, line: decl.range.start.line, col: decl.range.start.col }) : false,
        isOrigin: data.origin ? sameLoc(point, data.origin) : false,
      };
    });
  }, [data]);

  const visible = useMemo(() => (hideTests ? rows.filter((r) => !r.isTest) : rows), [rows, hideTests]);

  useEffect(() => {
    setActive(0);
  }, [data]);

  if (!data) {
    return (
      <div className="refs-panel">
        <div className="panel-empty">
          {busy ? t('side.querying') : t('side.refsHint')}
        </div>
      </div>
    );
  }
  if (data.reason !== 'resolved') {
    const text =
      data.reason === 'external'
        ? t('side.externalRefs', { name: data.symbol ?? t('side.thisSymbol') })
        : data.reason === 'no-symbol'
          ? t('side.noSymbolAtCursor')
          : t('side.unresolvedRefs', { name: data.symbol ?? t('side.thisSymbol') });
    return (
      <div className="refs-panel">
        <div className="panel-empty">{text}</div>
      </div>
    );
  }

  const groups: Array<{ file: string; items: RefRow[] }> = [];
  for (const row of visible) {
    const last = groups[groups.length - 1];
    if (last && last.file === row.file) last.items.push(row);
    else groups.push({ file: row.file, items: [row] });
  }
  const testFiles = new Set(rows.filter((r) => r.isTest).map((r) => r.file));
  const declCount = rows.filter((r) => r.isDeclaration).length;

  const move = (delta: number) => {
    if (!visible.length) return;
    setActive((i) => Math.min(Math.max(i + delta, 0), visible.length - 1));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = visible[active];
      if (row) onJump(row.file, row.line, row.col);
    } else if (e.key === 'Escape') {
      if (data.origin) onJump(data.origin.file, data.origin.line, data.origin.col);
    } else if (e.key.toLowerCase() === 't') {
      setHideTests((v) => !v);
    }
  };

  let flat = -1;
  return (
    <div className="refs-panel" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="refs-head">
        <div className="refs-title" title={data.symbol ?? ''}>
          {data.symbol ?? '—'}
        </div>
        <div className="refs-summary">
          {t('side.refCount', { n: rows.filter((r) => !r.isDeclaration).length })}
          {declCount > 0 && t('side.declCount', { n: declCount })}
          {testFiles.size > 0 && t('side.testFileCount', { n: testFiles.size })}
        </div>
        <label className="refs-filter">
          <input type="checkbox" checked={hideTests} onChange={(e) => setHideTests(e.target.checked)} />
          {t('side.onlyProject')}
        </label>
      </div>
      {/* 家族：引用列表只说「谁提到它」，这里补「它在继承体系里的位置」 */}
      {(() => {
        const family = data.family;
        if (!family || !(family.bases.length || family.derived.length || family.unresolvedBases.length)) {
          return null;
        }
        const link = (node: TypeNode) => (
          <button
            key={`${node.relation}:${node.file}:${node.location.range.start.line}`}
            className="refs-family-link"
            onClick={() => onJump(node.file, node.location.range.start.line, node.location.range.start.col)}
            title={`${t(RELATION_TEXT[node.relation])} ${node.name} — ${node.file}:${node.location.range.start.line}`}
          >
            {node.name}
          </button>
        );
        return (
          <div className="refs-family">
            <div className="refs-family-title">
              {t('side.family')}
              {family.kind && <span className="refs-family-kind">{family.kind}</span>}
            </div>
            {family.bases.length > 0 && (
              <div className="refs-family-row">
                <span className="refs-family-label">{t('side.basesLabel')}</span>
                {family.bases.map(link)}
              </div>
            )}
            {family.derived.length > 0 && (
              <div className="refs-family-row">
                <span className="refs-family-label">{t('side.derivedLabel', { n: family.derived.length })}</span>
                {family.derived.slice(0, 6).map(link)}
                {family.derived.length > 6 && <span className="refs-note">{t('side.moreCount', { n: family.derived.length })}</span>}
              </div>
            )}
            {family.unresolvedBases.length > 0 && (
              <div className="refs-note">{t('side.unresolvedBases', { list: family.unresolvedBases.join('、') })}</div>
            )}
          </div>
        );
      })()}
      <div className="refs-body">
        {groups.map((g) => (
          <div key={g.file} className="refs-group">
            <div className="refs-file" title={g.file}>
              {testFiles.has(g.file) && <span className="refs-badge">{t('explain.tagTest')}</span>}
              {g.file} <span className="muted">({g.items.length})</span>
            </div>
            {g.items.map((row) => {
              flat += 1;
              const index = flat;
              return (
                <div
                  key={row.key}
                  className={`refs-row ${index === active ? 'active' : ''}`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => onJump(row.file, row.line, row.col)}
                  title={`${row.file}:${row.line}:${row.col}`}
                >
                  <span className="line-num">{row.line}</span>
                  {row.isDeclaration && <span className="refs-badge decl">{t('side.badgeDecl')}</span>}
                  {row.isOrigin && <span className="refs-origin">{t('side.originMarker')}</span>}
                  <button
                    className="copy-btn"
                    title={t('side.copyLocationTitle')}
                    onClick={(e) => {
                      e.stopPropagation();
                      onCopy(row.file, row.line, row.col);
                    }}
                  >
                    ⧉
                  </button>
                </div>
              );
            })}
          </div>
        ))}
        {!visible.length && <div className="panel-empty">{t('side.noVisibleRefs')}</div>}
      </div>
      <div className="refs-foot">{t('side.refsFoot')}</div>
    </div>
  );
}

// ------------------------------------------------------------------ 搜索

export function SearchPanel({
  hits,
  busy,
  truncated,
  onSearch,
  onOpen,
  query,
  history = [],
  dirs = [],
  selectedDirs = [],
  onDirsChange,
  onCancel,
  fullscreen = false,
  onToggleFullscreen,
  onQueue,
}: {
  hits: SearchHit[];
  busy: boolean;
  truncated: boolean;
  onSearch: (query: string, options: Record<string, unknown>) => void;
  onOpen: (file: string, line: number, col: number) => void;
  query: string;
  /** N13：搜索历史（本机持久化）。 */
  history?: string[];
  /** N14：可选的目录胶囊。 */
  dirs?: string[];
  selectedDirs?: string[];
  onDirsChange?: (dirs: string[]) => void;
  /** N12：停止进行中的搜索。 */
  onCancel?: () => void;
  /** N11：独立全屏面板形态。 */
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
  /** G3.5：把这条命中位置加入待读（与向导面板共用同一份队列）。 */
  onQueue?: (file: string, line: number, col: number) => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(query);
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [filePattern, setFilePattern] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [hideTests, setHideTests] = useState(false);

  useEffect(() => setText(query), [query]);
  useEffect(() => {
    if (query)
      onSearch(query, {
        regex,
        caseSensitive,
        wholeWord,
        filePattern: filePattern || undefined,
        dirs: selectedDirs.length ? selectedDirs : undefined,
      });
    // 选项 / 范围变化时自动重跑上一次查询
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regex, caseSensitive, wholeWord, filePattern, selectedDirs.join('\u0000')]);

  const total = useMemo(() => hits.reduce((n, h) => n + h.matches.length, 0), [hits]);
  // N11：按测试过滤（isTest 由后端标注，口径与 01 地图同源）
  const shown = useMemo(() => (hideTests ? hits.filter((h) => !h.isTest) : hits), [hits, hideTests]);
  // N11：按目录归类（与按文件分组并存：目录标题下再按文件分组）
  const byDir = useMemo(() => {
    const out: Array<{ dir: string; groups: SearchHit[] }> = [];
    for (const g of shown) {
      const dir = g.file.includes('/') ? g.file.slice(0, g.file.lastIndexOf('/')) : '.';
      const last = out[out.length - 1];
      if (last && last.dir === dir) last.groups.push(g);
      else out.push({ dir, groups: [g] });
    }
    return out;
  }, [shown]);

  const submit = () =>
    onSearch(text, {
      regex,
      caseSensitive,
      wholeWord,
      filePattern: filePattern || undefined,
      dirs: selectedDirs.length ? selectedDirs : undefined,
    });

  const toggleDir = (dir: string) => {
    const next = selectedDirs.includes(dir)
      ? selectedDirs.filter((d) => d !== dir)
      : [...selectedDirs, dir];
    onDirsChange?.(next);
  };

  return (
    <div className={`search-panel ${fullscreen ? 'fullscreen' : ''}`}>
      <div className="search-inputs">
        <div className="search-input-row">
          <input
            className="text-input"
            placeholder={t('side.searchPlaceholder')}
            value={text}
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setShowHistory(history.length > 0)}
            onBlur={() => setTimeout(() => setShowHistory(false), 150)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
            }}
          />
          {busy ? (
            <button className="btn small" onClick={() => onCancel?.()} title={t('side.stopSearchTitle')}>
              {t('side.stop')}
            </button>
          ) : (
            <button className="btn ghost small" onClick={submit}>
              {t('app.tab.search')}
            </button>
          )}
          {onToggleFullscreen && (
            <button
              className="btn ghost small"
              onClick={onToggleFullscreen}
              title={fullscreen ? t('side.backToSidebar') : t('side.fullscreenTitle')}
            >
              {fullscreen ? t('side.exitFullscreen') : t('side.fullscreen')}
            </button>
          )}
        </div>
        <div className="search-input-row">
          <input
            className="text-input small"
            placeholder={t('side.filePatternPlaceholder')}
            value={filePattern}
            onChange={(e) => setFilePattern(e.target.value)}
          />
        </div>
        {showHistory && history.length > 0 && (
          <div className="search-history">
            {history.map((h) => (
              <div
                key={h}
                className="search-history-item"
                onMouseDown={() => {
                  setText(h);
                  setShowHistory(false);
                  onSearch(h, {
                    regex,
                    caseSensitive,
                    wholeWord,
                    filePattern: filePattern || undefined,
                    dirs: selectedDirs.length ? selectedDirs : undefined,
                  });
                }}
              >
                {h}
              </div>
            ))}
          </div>
        )}
      </div>
      {dirs.length > 0 && (
        <div className="search-scopes">
          <span className="muted">{t('explain.scopeTitle')}</span>
          {dirs.slice(0, 12).map((d) => (
            <button
              key={d}
              className={`scope-pill ${selectedDirs.includes(d) ? 'active' : ''}`}
              onClick={() => toggleDir(d)}
              title={selectedDirs.includes(d) ? t('side.unlimit') : t('side.searchInDir', { dir: d })}
            >
              {d}/
            </button>
          ))}
          {selectedDirs.length > 0 && (
            <button className="scope-pill clear" onClick={() => onDirsChange?.([])}>
              {t('side.clear')}
            </button>
          )}
        </div>
      )}
      <div className="search-toggles">
        <label>
          <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} /> {t('side.regex')}
        </label>
        <label>
          <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} /> {t('side.caseSensitive')}
        </label>
        <label>
          <input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} /> {t('side.wholeWord')}
        </label>
        <label>
          <input type="checkbox" checked={hideTests} onChange={(e) => setHideTests(e.target.checked)} /> {t('side.excludeTests')}
        </label>
      </div>
      <div className="search-summary">
        {busy
          ? t('side.searching')
          : hits.length
            ? `${t('side.hitsSummary', { total, files: hits.length })}${hideTests ? t('side.hitsShown', { n: shown.length }) : ''}`
            : text.trim() && text.trim() !== query.trim()
              ? // 输入了但还没提交：别说「无命中」——那会让人以为搜过了
                t('side.startHint')
              : text
                ? t('side.noHits')
                : ''}
        {truncated && <span className="warn">{t('side.truncated')}</span>}
      </div>
      <div className="search-results">
        {byDir.map((dir) => (
          <div key={dir.dir} className="search-dir">
            <div className="search-dir-head">{dir.dir}</div>
            {dir.groups.map((group) => (
              <div key={group.file} className="search-group">
                <div className="search-file" title={group.file}>
                  {group.file} <span className="muted">({group.matches.length})</span>
                </div>
                {group.matches.map((m, i) => (
                  <div
                    key={`${m.line}:${m.col}:${i}`}
                    className="search-hit"
                    onClick={() => onOpen(group.file, m.line, m.col)}
                    title={t('side.lineTitle', { line: m.line })}
                  >
                    <span className="line-num">{m.line}</span>
                    <span className="preview">
                      {m.lineText.slice(0, Math.max(m.col - 1, 0))}
                      <mark>{m.lineText.slice(m.col - 1, m.endCol - 1)}</mark>
                      {m.lineText.slice(m.endCol - 1)}
                    </span>
                    {onQueue && (
                      <button
                        className="search-queue"
                        title={t('guide.nav.queue')}
                        onClick={(e) => {
                          e.stopPropagation();
                          onQueue(group.file, m.line, m.col);
                        }}
                      >
                        +
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
