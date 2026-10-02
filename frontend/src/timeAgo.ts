/**
 * 相对时间文案（04 Guide · W3）：变更面板的「3 天前看过」与 blame 的「什么时候写的」
 * 必须是同一套口径 —— 两处各写一份，用户会看到「2 天前」与「48 小时前」并存。
 */
import type { TFunc } from './i18n';

const MINUTE = 60_000;

/** 把「距今多少毫秒」写成一句人话；超过 30 天回落具体日期。 */
export function timeAgoMs(ms: number, t: TFunc, now = Date.now()): string {
  if (!Number.isFinite(ms) || ms < MINUTE) return t('time.now');
  if (ms < 60 * MINUTE) return t('time.minutes', { n: Math.floor(ms / MINUTE) });
  if (ms < 24 * 60 * MINUTE) return t('time.hours', { n: Math.floor(ms / (60 * MINUTE)) });
  const days = Math.floor(ms / (24 * 60 * MINUTE));
  if (days < 30) return t('time.days', { n: days });
  return new Date(now - ms).toLocaleDateString();
}

/** 同一个东西按时间戳说。 */
export function timeAgo(at: number, t: TFunc, now = Date.now()): string {
  return timeAgoMs(Math.max(0, now - at), t, now);
}
