/**
 * 「没有跳转」提示条（03-navigator §3.1 / N2 / Q1 / Q9 / Q12）。
 *
 * 原则：不跳转必须有一句人话 + 至少一个可继续的动作。
 * 三类失败各有专属动作：
 * - external   → 跳到 import 行、复制符号名
 * - unresolved → 用该名字搜全项目、复制符号名
 * - indexing   → 只解释（索引进行中，不算失败）
 * no-symbol 不弹条（Q1），改由状态栏一行轻提示承担（避免误按 F12 就被打扰）。
 */
import { useEffect, useRef } from 'react';
import { translate, useI18n } from './i18n';
import type { GotoNotice } from './state';

export interface GotoFailureLike {
  kind: 'definition' | 'references';
  reason: 'external' | 'unresolved' | 'no-symbol';
  symbol: string | null;
  external?: { module: string; importLocation?: { file: string; range: { start: { line: number; col: number } } } };
}

const AUTO_DISMISS_MS = 8000;

/** 把后端结论翻译成用户能懂的一句话。 */
export function gotoFailureMessage(f: GotoFailureLike): string {
  const name = f.symbol?.trim();
  if (f.reason === 'no-symbol') {
    return f.kind === 'definition'
      ? translate('notice.noSymbolDefinition')
      : translate('notice.noSymbolReferences');
  }
  if (f.reason === 'external') {
    const mod = f.external?.module;
    const what = name ?? translate('notice.thisSymbol');
    if (mod) {
      return f.kind === 'definition'
        ? translate('notice.externalDefinition', { what, mod })
        : translate('notice.externalReferences', { what, mod });
    }
    return f.kind === 'definition'
      ? translate('notice.builtinDefinition', { what })
      : translate('notice.builtinReferences', { what });
  }
  return f.kind === 'definition'
    ? translate('notice.unresolvedDefinition', { what: name ?? translate('notice.cursorSymbol') })
    : translate('notice.unresolvedReferences', { what: name ?? translate('notice.thisSymbol') });
}

export function GotoNoticeBar({
  notice,
  onDismiss,
  onSearch,
  onJump,
}: {
  notice: GotoNotice | null;
  onDismiss: () => void;
  onSearch: (name: string) => void;
  onJump: (file: string, line: number, col: number) => void;
}) {
  const { t } = useI18n();
  const pauseRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!notice) return;
    const tick = () => {
      timerRef.current = window.setTimeout(() => {
        if (pauseRef.current) tick();
        else onDismiss();
      }, AUTO_DISMISS_MS);
    };
    tick();
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [notice, onDismiss]);

  if (!notice || notice.reason === 'no-symbol' || notice.reason === 'indexing') return null;
  const name = notice.symbol?.trim() || null;
  const importLoc = notice.external?.importLocation;

  return (
    <div
      className="goto-notice"
      role="status"
      onMouseEnter={() => {
        pauseRef.current = true;
      }}
      onMouseLeave={() => {
        pauseRef.current = false;
      }}
    >
      <span className="notice-dot" />
      <span className="notice-text">{notice.message}</span>
      <span className="notice-actions">
        {importLoc && (
          <button
            className="btn ghost small"
            title={t('notice.jumpToImportTitle', { file: importLoc.file, line: importLoc.range.start.line })}
            onClick={() => {
              onJump(importLoc.file, importLoc.range.start.line, importLoc.range.start.col);
              onDismiss();
            }}
          >
            {t('notice.jumpToImport')}
          </button>
        )}
        {name && notice.reason === 'unresolved' && (
          <button
            className="btn ghost small"
            title={t('notice.searchInProjectTitle', { name })}
            onClick={() => {
              onSearch(name);
              onDismiss();
            }}
          >
            {t('notice.searchName', { name })}
          </button>
        )}
        {name && (
          <button
            className="btn ghost small"
            title={t('notice.copySymbolTitle')}
            onClick={() => void navigator.clipboard?.writeText(name)}
          >
            {t('notice.copySymbol')}
          </button>
        )}
        <button className="btn ghost small" onClick={onDismiss}>
          {t('notice.dismiss')}
        </button>
      </span>
    </div>
  );
}
