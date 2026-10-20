import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * prefs（P24 / Q14）：容错读 + 单键写 + 主题解析 + 版本迁移。
 *
 * prefs.ts 在模块顶层读一次 localStorage，所以每个用例都 `vi.resetModules()` 后重新 import，
 * 才能验证「存量数据 → 首次读取」的回落 / 迁移行为。
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
    delete document.documentElement.dataset.tone;
  });

  it('没有存量数据时给出默认偏好', async () => {
    const { loadPrefs, DEFAULT_PREFS } = await loadPrefsModule();
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('坏 JSON 回落默认值而不抛异常，也不回写（不覆盖可能还能救的原文）', async () => {
    window.localStorage.setItem('wcr:prefs', '{ not json');
    const { loadPrefs, DEFAULT_PREFS } = await loadPrefsModule();
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
    expect(window.localStorage.getItem('wcr:prefs')).toBe('{ not json');
  });

  it('合法值生效；越界数字与未知枚举被收敛', async () => {
    window.localStorage.setItem(
      'wcr:prefs',
      JSON.stringify({ theme: 'light', fontSize: 99, sidebarWidth: -5, locale: 'fr' }),
    );
    const { loadPrefs, PREFS_VERSION } = await loadPrefsModule();
    expect(loadPrefs()).toEqual({
      version: PREFS_VERSION,
      theme: 'light',
      fontSize: 18,
      sidebarWidth: 240,
      locale: 'zh',
      wrap: false,
      tabSize: 4,
      minimap: true,
      whitespace: false,
      reduceMotion: false,
      changesOpen: true,
      keymap: 'idea',
      pythonPath: '',
      autoReveal: true,
    });
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

  it('存的是数组 / 字符串等非对象值时回落默认，并作为 v0 数据迁移回写', async () => {
    window.localStorage.setItem('wcr:prefs', JSON.stringify(['light', 20]));
    const { loadPrefs, DEFAULT_PREFS, PREFS_KEY } = await loadPrefsModule();
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
    expect(JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? 'null')).toEqual(DEFAULT_PREFS);
  });

  it('savePrefs 只合并 patch，其它字段不动，并只写一个 localStorage 键', async () => {
    const { loadPrefs, savePrefs, DEFAULT_PREFS, PREFS_KEY } = await loadPrefsModule();
    savePrefs({ fontSize: 16 });
    expect(loadPrefs()).toEqual({ ...DEFAULT_PREFS, fontSize: 16 });
    expect(window.localStorage.length).toBe(1);
    expect(JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? 'null')).toEqual(loadPrefs());
  });

  it('savePrefs 的 patch 同样经过收敛（越界 / 未知值不会写进去）', async () => {
    const { loadPrefs, savePrefs, DEFAULT_PREFS } = await loadPrefsModule();
    savePrefs({ fontSize: 100, locale: 'de' as never, theme: 'neon' as never });
    expect(loadPrefs()).toEqual({ ...DEFAULT_PREFS, fontSize: 18 });
  });

  it('编辑器 / 界面细项：合法值生效，越界与非法值回落默认', async () => {
    window.localStorage.setItem(
      'wcr:prefs',
      JSON.stringify({ wrap: true, tabSize: 2, minimap: false, whitespace: true, reduceMotion: true, changesOpen: false }),
    );
    let mod = await loadPrefsModule();
    expect(mod.loadPrefs()).toMatchObject({
      wrap: true,
      tabSize: 2,
      minimap: false,
      whitespace: true,
      reduceMotion: true,
      changesOpen: false,
    });

    vi.resetModules();
    window.localStorage.setItem('wcr:prefs', JSON.stringify({ tabSize: 99, wrap: 'yes' }));
    mod = await loadPrefsModule();
    expect(mod.loadPrefs().tabSize).toBe(8); // 夹到上限
    expect(mod.loadPrefs().wrap).toBe(false); // 非布尔一律回落默认
  });

  it('theme=system 时跟随系统，其余模式按字面值', async () => {
    const { resolvedTheme } = await loadPrefsModule();
    stubMatchMedia(true);
    expect(resolvedTheme('system')).toBe('light');
    stubMatchMedia(false);
    expect(resolvedTheme('system')).toBe('dark');
    expect(resolvedTheme('light')).toBe('light');
    expect(resolvedTheme('dark')).toBe('dark');
    expect(resolvedTheme('one-dark')).toBe('one-dark'); // 具体配色原样返回
  });

  it('未知主题 id 收敛回默认主题（多套配色不认脏值）', async () => {
    window.localStorage.setItem('wcr:prefs', JSON.stringify({ theme: 'solarized' }));
    const { loadPrefs, DEFAULT_PREFS } = await loadPrefsModule();
    expect(loadPrefs().theme).toBe(DEFAULT_PREFS.theme);
  });

  it('默认主题是 IDEA New UI Dark（2026-10-20 用户拍板）', async () => {
    const { loadPrefs, DEFAULT_PREFS } = await loadPrefsModule();
    expect(DEFAULT_PREFS.theme).toBe('new-ui-dark');
    expect(loadPrefs().theme).toBe('new-ui-dark');
  });

  it('applyPrefs 把主题 / 明暗基调 / 字号 / 侧栏宽 / 语言 / 动效写到 :root', async () => {
    const { savePrefs } = await loadPrefsModule();
    savePrefs({ theme: 'light', fontSize: 15, sidebarWidth: 400, locale: 'en', reduceMotion: true });
    const root = document.documentElement;
    expect(root.dataset.theme).toBe('light');
    expect(root.dataset.tone).toBe('light'); // 浅色基线靠它生效
    expect(root.style.getPropertyValue('--ui-font-size')).toBe('15px');
    expect(root.style.getPropertyValue('--sidebar-width')).toBe('400px');
    expect(root.dataset.motion).toBe('reduced');
    expect(root.lang).toBe('en');
    expect(document.title).toBe('ai-ide');
  });

  it('切到深色系配色时 data-tone 跟着回 dark', async () => {
    const { savePrefs } = await loadPrefsModule();
    savePrefs({ theme: 'nord' });
    expect(document.documentElement.dataset.theme).toBe('nord');
    expect(document.documentElement.dataset.tone).toBe('dark');
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

  // ---- 版本迁移（Prefs.version / MIGRATIONS）----

  it('无 version 的存量数据按 0 迁移到当前版本，并回写 localStorage', async () => {
    window.localStorage.setItem('wcr:prefs', JSON.stringify({ theme: 'light', fontSize: 16 }));
    const { loadPrefs, PREFS_VERSION, PREFS_KEY } = await loadPrefsModule();

    expect(loadPrefs().version).toBe(PREFS_VERSION);
    expect(loadPrefs().theme).toBe('light'); // 迁移不动老字段
    const stored = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? 'null');
    expect(stored).toMatchObject({ version: PREFS_VERSION, theme: 'light', fontSize: 16 });
  });

  it('已是最新版本的数据不再迁移，也不回写 localStorage', async () => {
    const { PREFS_VERSION } = await loadPrefsModule();
    vi.resetModules();
    // unknownField 只存在于 raw 里，一旦被回写就会被 coerce 丢掉 —— 拿它当「是否回写」的探针
    const stored = { version: PREFS_VERSION, theme: 'light', unknownField: 'keep-me' };
    window.localStorage.setItem('wcr:prefs', JSON.stringify(stored));

    const { loadPrefs } = await loadPrefsModule();
    expect(loadPrefs().version).toBe(PREFS_VERSION);
    expect(loadPrefs().theme).toBe('light');
    expect(JSON.parse(window.localStorage.getItem('wcr:prefs') ?? 'null')).toEqual(stored);
  });

  it('比当前版本更新的数据原样读取（不降级、不重写）', async () => {
    const stored = { version: 99, theme: 'light', unknownField: 'x' };
    window.localStorage.setItem('wcr:prefs', JSON.stringify(stored));

    const { loadPrefs } = await loadPrefsModule();
    expect(loadPrefs().theme).toBe('light');
    expect(JSON.parse(window.localStorage.getItem('wcr:prefs') ?? 'null')).toEqual(stored);
  });

  it('字段类型全不对的存量数据迁移后仍回落默认（coerce 兜住）', async () => {
    window.localStorage.setItem(
      'wcr:prefs',
      JSON.stringify({ theme: 42, fontSize: {}, wrap: 'yes', tabSize: 'big', minimap: 'no' }),
    );
    const { loadPrefs, DEFAULT_PREFS } = await loadPrefsModule();
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('迁移后 coerce 仍能补齐缺失字段（老数据只存了一个 theme）', async () => {
    window.localStorage.setItem('wcr:prefs', JSON.stringify({ theme: 'light' }));
    const { loadPrefs, DEFAULT_PREFS, PREFS_VERSION } = await loadPrefsModule();
    expect(loadPrefs()).toEqual({ ...DEFAULT_PREFS, theme: 'light' });
    expect(loadPrefs().version).toBe(PREFS_VERSION);
  });

  it('迁移回写失败（配额满 / 隐私模式）不抛异常，内存值仍是迁移后的结果', async () => {
    window.localStorage.setItem('wcr:prefs', JSON.stringify({ theme: 'light' })); // 无 version → 会尝试回写
    let attempts = 0;
    const setItem = vi.spyOn(window.Storage.prototype, 'setItem').mockImplementation(() => {
      attempts += 1;
      throw new Error('QuotaExceededError');
    });
    try {
      const { loadPrefs, PREFS_VERSION } = await loadPrefsModule();
      expect(attempts).toBe(1); // 确实尝试过回写
      expect(loadPrefs().version).toBe(PREFS_VERSION);
      expect(loadPrefs().theme).toBe('light');
    } finally {
      setItem.mockRestore();
    }
  });
});
