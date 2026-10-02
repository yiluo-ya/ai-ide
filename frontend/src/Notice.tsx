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
      ? '这里没有可识别的符号（可能是注释、字符串或纯文本）'
      : '这里没有可识别的符号，无法查找引用';
  }
  if (f.reason === 'external') {
    const mod = f.external?.module;
    const what = name ?? '该符号';
    if (mod) {
      return f.kind === 'definition'
        ? `未跳转：${what} 来自外部依赖 ${mod}，本项目不索引其源码`
        : `未找到引用：${what} 来自外部依赖 ${mod}，它的使用处不在本项目内`;
    }
    return f.kind === 'definition'
      ? `未跳转：${what} 是外部依赖 / 语言内置符号，本项目不索引其源码`
      : `未找到引用：${what} 是外部依赖 / 语言内置符号，不参与项目内引用`;
  }
  return f.kind === 'definition'
    ? `未跳转：无法解析 ${name ?? '光标处的符号'}（通常需要类型推断，当前不做）`
    : `未找到引用：${name ?? '该符号'} 解析不到定义，无法列出引用`;
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
            title={`跳到 import 行 ${importLoc.file}:${importLoc.range.start.line}`}
            onClick={() => {
              onJump(importLoc.file, importLoc.range.start.line, importLoc.range.start.col);
              onDismiss();
            }}
          >
            跳到 import 行
          </button>
        )}
        {name && notice.reason === 'unresolved' && (
          <button
            className="btn ghost small"
            title={`在项目里全文搜索 ${name}`}
            onClick={() => {
              onSearch(name);
              onDismiss();
            }}
          >
            搜 {name}
          </button>
        )}
        {name && (
          <button
            className="btn ghost small"
            title="把符号名复制到剪贴板"
            onClick={() => void navigator.clipboard?.writeText(name)}
          >
            复制符号名
          </button>
        )}
        <button className="btn ghost small" onClick={onDismiss}>
          知道就好
        </button>
      </span>
    </div>
  );
}
