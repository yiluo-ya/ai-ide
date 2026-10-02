import { beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from './en';
import { zh } from './zh';

/**
 * i18n（P25）：命中 / 回落 / 插值 / 语言切换。
 *
 * translate 的默认 locale 取自 prefs（模块顶层读 localStorage），因此每个用例都重置模块。
 */
async function loadI18n() {
  return await import('./index');
}

describe('i18n', () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
  });

  it('zh / en 两份字典的 key 集合一致（新增文案不会漏翻译）', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });

  it('默认中文：按键命中中文文案', async () => {
    const { translate } = await loadI18n();
    expect(translate('app.title')).toBe('代码阅读器');
    expect(translate('app.title', undefined, 'en')).toBe('Web Code Reader');
  });

  it('缺 key 时回落到 key 本身，而不是空白', async () => {
    const { translate } = await loadI18n();
    expect(translate('does.not.exist')).toBe('does.not.exist');
    expect(translate('does.not.exist', undefined, 'en')).toBe('does.not.exist');
  });

  it('参数插值替换全部占位符', async () => {
    const { translate } = await loadI18n();
    expect(translate('topbar.indexing', { percent: 30, indexed: 3, total: 10 })).toBe('索引中 30%（3/10）');
    expect(translate('welcome.timeMinutes', { n: 5 }, 'en')).toBe('5 minutes ago');
  });

  it('缺参时占位符原样保留（便于发现漏传）', async () => {
    const { translate } = await loadI18n();
    expect(translate('topbar.indexed', {})).toBe('已索引 {n} 个文件');
    expect(translate('topbar.indexing', { percent: 30 })).toBe('索引中 30%（{indexed}/{total}）');
  });

  it('setLocale 改写 prefs 与 <html lang>，后续 translate 默认走新语言', async () => {
    const { translate, setLocale } = await loadI18n();
    const { loadPrefs, PREFS_KEY } = await import('../prefs');
    setLocale('en');
    expect(loadPrefs().locale).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? '{}').locale).toBe('en');
    expect(translate('app.title')).toBe('Web Code Reader'); // 默认 locale 已跟随
    setLocale('zh');
    expect(translate('app.title')).toBe('代码阅读器');
  });
});
