/**
 * 文件面板里的内容搜索（2026-10-03 用户要求：搜索和文件名过滤共用一个输入框，不再是两件事）。
 *
 * 输入框本身在 App 里（就是面板顶部那个「过滤文件名」），这里只负责结果块：
 * 输入 ≥MIN_LEN 字才真的去搜内容 —— 太短的词命中太多、等于噪音，此时只用它过滤文件名；
 * 命中按文件分组（防抖 300ms），点一条直接跳过去。
 * 独立的「搜索」面板保留原样，收在侧栏「更多 ▾」里（要历史 / 目录筛选 / 全屏时用那个）。
 */
import { useEffect, useState } from 'react';
import { useStore } from './state';
import { useI18n } from './i18n';
import './filesearch.css';

/** 少于这么长不搜内容：只按文件名过滤（2026-10-03 用户要求，从 2 提到 4）。 */
export const MIN_LEN = 4;
/** 结果里最多列多少个文件（其余如实说「还有 N 个文件」）。 */
const MAX_FILES = 30;
/** 每个文件最多列多少条命中。 */
const MAX_HITS_PER_FILE = 5;

export function FileSearch({
  query,
  onOpen,
}: {
  query: string;
  onOpen: (file: string, line: number, col: number) => void;
}) {
  const { t } = useI18n();
  const hits = useStore((s) => s.searchHits);
  const busy = useStore((s) => s.searchBusy);
  const truncated = useStore((s) => s.searchTruncated);
  /** 已经发出去检索的那个词；null = 还没搜（输入不足长或刚清空）。 */
  const [searched, setSearched] = useState<string | null>(null);
  const trimmed = query.trim();

  useEffect(() => {
    if (trimmed.length < MIN_LEN) {
      setSearched(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void useStore.getState().runSearch(trimmed, {});
      setSearched(trimmed);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [trimmed]);

  // 输入不足长 / 还没搜过：不占地方（下一次 effect 跑完前就立刻收回）
  if (searched === null || trimmed.length < MIN_LEN) return null;

  const total = hits.reduce((n, h) => n + h.matches.length, 0);
  const shown = hits.slice(0, MAX_FILES);

  return (
    <div className="file-search">
      <div className="fs-result">
        <div className="fs-summary">
          <span>
            {busy ? t('search.busy') : total === 0 ? t('search.noHit') : t('search.hits', { total, files: hits.length })}
            {truncated && !busy && t('search.truncated')}
          </span>
          {busy && (
            <button className="btn ghost small" onClick={() => useStore.getState().cancelSearch()} title={t('search.stopTitle')}>
              {t('search.stop')}
            </button>
          )}
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
          <div className="fs-summary">{t('search.moreFiles', { n: hits.length - MAX_FILES })}</div>
        )}
      </div>
    </div>
  );
}
