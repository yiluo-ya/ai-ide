/**
 * 文件面板里的内联代码搜索（2026-10-03 用户要求：把搜索融进文件面板）。
 *
 * 与面板顶部的「过滤文件名」是两件事：那个筛树，这个搜文件内容。
 * 输入即搜（防抖 300ms，≥2 字），命中按文件分组；点一条直接跳过去。
 * 独立的「搜索」面板保留原样，收在侧栏「更多 ▾」里（要历史 / 目录筛选 / 全屏时用那个）。
 */
import { useEffect, useRef, useState } from 'react';
import { useStore } from './state';
import './filesearch.css';

/** 少于这么长不搜：单字搜索噪音太大（与独立搜索面板同口径）。 */
const MIN_LEN = 2;
/** 结果里最多列多少个文件（其余如实说「还有 N 个文件」）。 */
const MAX_FILES = 30;
/** 每个文件最多列多少条命中。 */
const MAX_HITS_PER_FILE = 5;

export function FileSearch({ onOpen }: { onOpen: (file: string, line: number, col: number) => void }) {
  const hits = useStore((s) => s.searchHits);
  const busy = useStore((s) => s.searchBusy);
  const truncated = useStore((s) => s.searchTruncated);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const onChange = (value: string) => {
    setQuery(value);
    if (timer.current) window.clearTimeout(timer.current);
    const trimmed = value.trim();
    if (trimmed.length < MIN_LEN) {
      setActive(false);
      return;
    }
    timer.current = window.setTimeout(() => {
      void useStore.getState().runSearch(trimmed, {});
      setActive(true);
    }, 300);
  };

  const total = hits.reduce((n, h) => n + h.matches.length, 0);
  const shown = hits.slice(0, MAX_FILES);

  return (
    <div className="file-search">
      <div className="fs-input-row">
        <input
          className="text-input"
          placeholder={`搜索代码内容（≥${MIN_LEN} 字）`}
          value={query}
          aria-label="搜索代码内容"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setQuery('');
              setActive(false);
            }
          }}
        />
        {busy && (
          <button className="btn ghost small" onClick={() => useStore.getState().cancelSearch()} title="停止搜索">
            停止
          </button>
        )}
      </div>

      {active && (
        <div className="fs-result">
          <div className="fs-summary">
            {busy ? '搜索中…' : total === 0 ? '没有命中' : `${total} 处命中 · ${hits.length} 个文件`}
            {truncated && !busy && ' · 已截断'}
          </div>
          {shown.map((hit) => (
            <div key={hit.file} className="fs-file">
              <div className="fs-file-name" title={hit.file}>
                {hit.file}
                {hit.matches.length > MAX_HITS_PER_FILE && (
                  <span className="fs-more">+{hit.matches.length - MAX_HITS_PER_FILE}</span>
                )}
              </div>
              {hit.matches.slice(0, MAX_HITS_PER_FILE).map((m, i) => (
                <button
                  key={`${m.line}:${m.col}:${i}`}
                  className="fs-hit"
                  title={`${hit.file}:${m.line}:${m.col}`}
                  onClick={() => onOpen(hit.file, m.line, m.col)}
                >
                  <span className="fs-line">{m.line}</span>
                  <span className="fs-text">{m.lineText.trim().slice(0, 120)}</span>
                </button>
              ))}
            </div>
          ))}
          {!busy && hits.length > MAX_FILES && (
            <div className="fs-summary">还有 {hits.length - MAX_FILES} 个文件未列出（到「更多 → 搜索」看全部）</div>
          )}
        </div>
      )}
    </div>
  );
}
