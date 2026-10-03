/**
 * 浮层骨架（P25 无障碍）：role=dialog + aria-modal + Esc 关闭 + 焦点进出可控。
 *
 * 所有设置 / 模型浮层共用它，保证键盘行为一致：
 * 打开时焦点移入浮层，Esc 关闭，Tab 在浮层内循环，遮罩点击关闭。
 */
import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useI18n } from './i18n';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const { t } = useI18n();
  const boxRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useEffect(() => {
    boxRef.current?.focus();
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const nodes = Array.from(boxRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="wcr-dialog-backdrop" onMouseDown={onClose}>
      <div
        className={`wcr-dialog${wide ? ' wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={boxRef}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="wcr-dialog-head">
          <h2 className="wcr-dialog-title" id={titleId}>
            {title}
          </h2>
          <button className="btn ghost small" onClick={onClose} aria-label={t('dialog.close')}>
            {t('dialog.close')}
          </button>
        </div>
        <div className="wcr-dialog-body">{children}</div>
      </div>
    </div>
  );
}
