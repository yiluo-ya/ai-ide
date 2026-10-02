import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * prefs（P24 / Q14）：容错读 + 单键写 + 主题解析。
 *
 * prefs.ts 在模块顶层读一次 localStorage，所以每个用例都 `vi.resetModules()` 后重新 import，
 * 才能验证「存量数据 → 首次读取」的回落行为。
 */
async function loadPrefsModule() {
  return await import('./prefs');
}

function stubMatchMedia(matches: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

describe('prefs', () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('没有存量数据时给出默认偏好', async () => {
    const { loadPrefs, DEFAULT_PREFS } = await loadPrefsModule();
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('坏 JSON 回落默认值而不抛异常', async () => {
    window.localStorage.setItem('wcr:prefs', '{ not json');
    const { loadPrefs, DEFAULT_PREFS } = await loadPrefsModule();
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('合法值生效；越界数字与未知枚举被收敛', async () => {
    window.localStorage.setItem(
      'wcr:prefs',
      JSON.stringify({ theme: 'light', fontSize: 99, sidebarWidth: -5, locale: 'fr' }),
    );
    const { loadPrefs } = await loadPrefsModule();
    expect(loadPrefs()).toEqual({ theme: 'light', fontSize: 18, sidebarWidth: 240, locale: 'zh' });
  });

  it('字号夹取到 12–18，非有限数回落默认值', async () => {
    window.localStorage.setItem('wcr:prefs', JSON.stringify({ fontSize: 1 }));
    let mod = await loadPrefsModule();
    expect(mod.loadPrefs().fontSize).toBe(12);

    vi.resetModules();
    window.localStorage.setItem('wcr:prefs', JSON.stringify({ fontSize: 14.6 }));
    mod = await loadPrefsModule();
    expect(mod.loadPrefs().fontSize).toBe(15); // 四舍五入到整数

    vi.resetModules();
    window.localStorage.setItem('wcr:prefs', JSON.stringify({ fontSize: 'abc' }));
    mod = await loadPrefsModule();
    expect(mod.loadPrefs().fontSize).toBe(13); // 非数字 → 默认 13

    vi.resetModules();
    window.localStorage.setItem('wcr:prefs', JSON.stringify({ fontSize: null }));
    mod = await loadPrefsModule();
    expect(mod.loadPrefs().fontSize).toBe(12); // Number(null) = 0 → 夹到下限
  });

  it('存的是数组 / 字符串等非对象值时也回落默认', async () => {
    window.localStorage.setItem('wcr:prefs', JSON.stringify(['light', 20]));
    const { loadPrefs, DEFAULT_PREFS } = await loadPrefsModule();
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('savePrefs 只合并 patch，其它字段不动，并只写一个 localStorage 键', async () => {
    const { loadPrefs, savePrefs, DEFAULT_PREFS, PREFS_KEY } = await loadPrefsModule();
    savePrefs({ fontSize: 16 });
    expect(loadPrefs()).toEqual({ ...DEFAULT_PREFS, fontSize: 16 });
    expect(window.localStorage.length).toBe(1);
    expect(JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? 'null')).toEqual(loadPrefs());
  });

  it('savePrefs 的 patch 同样经过收敛（越界 / 未知值不会写进去）', async () => {
    const { loadPrefs, savePrefs } = await loadPrefsModule();
    savePrefs({ fontSize: 100, locale: 'de' as never, theme: 'neon' as never });
    expect(loadPrefs()).toEqual({ theme: 'dark', fontSize: 18, sidebarWidth: 320, locale: 'zh' });
  });

  it('theme=system 时跟随系统，其余模式按字面值', async () => {
    const { resolvedTheme } = await loadPrefsModule();
    stubMatchMedia(true);
    expect(resolvedTheme('system')).toBe('light');
    stubMatchMedia(false);
    expect(resolvedTheme('system')).toBe('dark');
    expect(resolvedTheme('light')).toBe('light');
    expect(resolvedTheme('dark')).toBe('dark');
  });

  it('applyPrefs 把主题 / 字号 / 侧栏宽 / 语言写到 :root', async () => {
    const { savePrefs } = await loadPrefsModule();
    savePrefs({ theme: 'light', fontSize: 15, sidebarWidth: 400, locale: 'en' });
    const root = document.documentElement;
    expect(root.dataset.theme).toBe('light');
    expect(root.style.getPropertyValue('--ui-font-size')).toBe('15px');
    expect(root.style.getPropertyValue('--sidebar-width')).toBe('400px');
    expect(root.lang).toBe('en');
    expect(document.title).toBe('Web Code Reader');
  });

  it('订阅者在 savePrefs 后收到一次最新值，取消订阅后不再收到', async () => {
    const { savePrefs, subscribePrefs } = await loadPrefsModule();
    const seen: number[] = [];
    const off = subscribePrefs((p) => seen.push(p.fontSize));
    savePrefs({ fontSize: 14 });
    expect(seen).toEqual([14]);
    off();
    savePrefs({ fontSize: 15 });
    expect(seen).toEqual([14]);
  });
});
