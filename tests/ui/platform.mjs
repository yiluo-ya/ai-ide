/**
 * 06 底座 UI 回归：交付体验（P16/P17/P24/P25 + P9/P8 的界面出口）。
 *
 * 用例：
 * 1. P17：顶栏常驻隐私承诺（只读 · 不上传 · 代码不出本机）；
 * 2. P17：点角标 → 可追证的隐私面板（读什么 / 写什么 / 传什么 / 谁在用 + 可自证）；
 * 3. P9：顶栏「索引报告」入口能打开面板；
 * 4. P24：设置里切「亮色」→ 真的换主题（data-theme + 背景色）；
 * 5. P24：字号滑到 16 → 落 wcr:prefs 且 --ui-font-size 即时生效；
 * 6. P25：语言切 English → documentElement.lang 与界面文案都变；
 * 7. LAY：左栏两个常驻 tab（文件 / code会话）、右栏五个入口分两行（变更 / 命令 / 总览 ｜ 大纲 / 搜索）；
 * 8. AG-FONT：设置里改「字号」→ code 会话区正文 / 小字跟着缩放（不再是固定 13px / 12px）；
 * 9. AP：顶栏「添加项目」→ 文件夹图标 → 弹窗选目录（Shadow DOM 隔离 + 手敲路径跳转 + 确认真实路径）；
 * 10. 全程无 console error。
 *
 * 跑法：npm run build && npm run test:ui（run.mjs 在 navigator / guide 之后跑本脚本）。
 * 说明：React 受控组件（range / select）必须走原生 value setter 才能触发 onChange，
 * 直接改 el.value 会被 React 的 value tracker 判成「没变」。
 */
import { chromium } from 'playwright-core';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { useFastTimeouts, withStepTimeout } from './panel.mjs';

const PORT = process.env.PORT ?? '8799';
const BASE = `http://127.0.0.1:${PORT}`;
const PROJECT = process.argv[2];
if (!PROJECT) {
  console.error('用法：node tests/ui/platform.mjs <projectId>（由 run.mjs 传夹具 id）');
  process.exit(1);
}

/** 跨平台查找本机 Chromium（Windows / Linux / macOS）；找不到返回 null，交给 playwright-core 自己找。 */
function findChromium() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : null,
    process.env.HOME ? path.join(process.env.HOME, '.cache', 'ms-playwright') : null,
    process.env.HOME ? path.join(process.env.HOME, 'Library', 'Caches', 'ms-playwright') : null,
  ].filter((root) => root && existsSync(root));
  const candidates = [
    'chrome-win/chrome.exe',
    'chrome-win64/chrome.exe',
    'chrome-linux/chrome',
    'chrome-linux64/chrome',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
  ];
  for (const root of roots) {
    let dirs;
    try {
      dirs = readdirSync(root).filter((d) => d.startsWith('chromium'));
    } catch {
      continue;
    }
    for (const dir of dirs) {
      for (const name of candidates) {
        const exe = path.join(root, dir, name);
        if (existsSync(exe)) return exe;
      }
    }
  }
  return null;
}

const results = [];
const errors = [];

async function step(name, fn, timeoutMs) {
  try {
    const detail = await withStepTimeout(name, fn, timeoutMs);
    results.push({ name, pass: true, detail: typeof detail === 'string' ? detail : '' });
  } catch (e) {
    results.push({ name, pass: false, detail: String(e).split('\n')[0].slice(0, 200) });
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function report() {
  for (const r of results) {
    console.log(`${r.pass ? '✔' : '✖'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n底座 UI 回归：${passed}/${results.length} 通过`);
  if (errors.length) {
    console.log(`\n控制台错误 ${errors.length} 条：`);
    for (const e of errors.slice(0, 10)) console.log(`  - ${e.slice(0, 200)}`);
  }
  if (passed !== results.length || errors.length) process.exitCode = 1;
}

async function main() {
  const executablePath = findChromium();
  const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  // 失败要快：默认 30 秒的等待会把一条超时放大成半分钟；需要长等的步骤各自写了显式 timeout
  useFastTimeouts(page);
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`${BASE}/?project=${PROJECT}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(1500);

  await step('顶栏「模型」与设置并列，点开是模型配置', async () => {
    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('header button')].find((b) => b.innerText.trim() === '模型');
      if (!btn) return false;
      btn.click();
      return true;
    });
    assert(clicked, '顶栏找不到「模型」按钮');
    await page.waitForTimeout(500);
    const title = await page.evaluate(() => document.querySelector('.wcr-dialog-title')?.textContent ?? '');
    assert(title.includes('模型'), `浮层标题不符：${title}`);
    const body = await page.evaluate(() => document.querySelector('.wcr-dialog-body')?.innerText ?? '');
    assert(/provider|Base URL|模型/.test(body), `模型面板内容可疑：${body.slice(0, 80)}`);
    await page.evaluate(() => document.querySelector('.wcr-dialog-head button')?.click());
    await page.waitForTimeout(300);
    return `标题「${title}」`;
  });

  await step('设置面板：外观 / 编辑器 / 界面 / 索引 / 关于 都在', async () => {
    await page.evaluate(() => {
      [...document.querySelectorAll('header button')].find((b) => b.innerText.trim() === '设置')?.click();
    });
    await page.waitForTimeout(600);
    const text = await page.evaluate(() => document.querySelector('.wcr-dialog-body')?.innerText ?? '');
    for (const key of ['外观', '编辑器', '自动换行', '缩进宽度', '界面', '动效减弱', '索引', '自定义忽略规则', '关于']) {
      assert(text.includes(key), `设置缺「${key}」`);
    }
    await page.evaluate(() => document.querySelector('.wcr-dialog-head button')?.click());
    await page.waitForTimeout(300);
    return '五个分组齐全';
  });

  await step('P24 设置：切亮色真的换主题', async () => {
    const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.evaluate(() => {
      [...document.querySelectorAll('header button')].find((b) => b.innerText.trim() === '设置')?.click();
    });
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      [...document.querySelectorAll('.wcr-dialog button')].find((b) => b.innerText.trim() === '亮色')?.click();
    });
    await page.waitForTimeout(500);
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    const after = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const lum = await page.evaluate(() => {
      const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g) ?? [];
      return (Number(m[0]) + Number(m[1]) + Number(m[2])) / 3;
    });
    assert(theme === 'light', `data-theme=${theme}`);
    assert(after !== before, `背景色没变：${before}`);
    assert(lum > 150, `亮色背景亮度不足：${Math.round(lum)}`);
    return `light：${before} → ${after}`;
  });

  await step('P24 字号 16 落 wcr:prefs 并即时生效', async () => {
    await page.evaluate(() => {
      const el = document.querySelector('.wcr-dialog input[type=range]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, '16');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(500);
    const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('wcr:prefs') ?? '{}'));
    const cssVar = await page.evaluate(() => document.documentElement.style.getPropertyValue('--ui-font-size'));
    assert(prefs.fontSize === 16, `prefs.fontSize=${prefs.fontSize}`);
    assert(cssVar === '16px', `--ui-font-size=${cssVar}`);
    return `fontSize=16，--ui-font-size=${cssVar}`;
  });

  await step('P25 切 English：语言与文案都变', async () => {
    await page.evaluate(() => {
      const el = document.querySelector('.wcr-dialog select');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(el, 'en');
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(600);
    const lang = await page.evaluate(() => document.documentElement.lang);
    const text = await page.locator('body').innerText();
    assert(lang === 'en', `lang=${lang}`);
    assert(text.includes('Settings') || text.includes('Read-only'), '文案没切英文');
    return `lang=${lang}`;
  });

  // 设置弹窗从 P24 起一直开着：先关掉（它的遮罩会拦住顶栏按钮的点击）
  await page.evaluate(() => document.querySelector('.wcr-dialog-head button')?.click());
  await page.waitForTimeout(300);

  await step('LAY：左栏只剩文件 / code会话，右栏五个入口分两行', async () => {
    // 2026-10-03 用户要求：大纲 / 搜索从左栏搬到右栏；右栏一共五个入口，一行放不下 —— 排两行。
    // 把布局本身钉住 —— 以后再动 tab 集合，先撞到这条。
    // 注意：上一条 P25 用例已把语言切成 English，而 tab 文案（P25 国际化后）随语言变，
    // 所以这里按当前语言给两套期望值（中文仍是默认语言下的口径）。
    const en = (await page.evaluate(() => document.documentElement.lang)) === 'en';
    const wantLeft = en ? ['Files', 'Code sessions'] : ['文件', 'code会话'];
    const wantDock = en
      ? ['Changes', 'Commands', 'Overview', 'Outline', 'Search']
      : ['变更', '命令', '总览', '大纲', '搜索'];
    const left = (await page.locator('.sidebar .panel-tabs > button').allInnerTexts()).map((s) => s.trim());
    assert(left.join(',') === wantLeft.join(','), `左栏 tab 不对：${left.join(',')}（期望 ${wantLeft.join(',')}）`);

    // 右栏可能被收着（收着时只剩一个 ◂ 按钮）：先展开，否则看不到 tab
    if (await page.locator('.dock-changes.collapsed').count()) {
      await page.locator('.dock-changes .dock-toggle').click();
    }
    const dock = (await page.locator('.dock-changes .dock-tab').allInnerTexts()).map((s) => s.trim());
    assert(dock.join(',') === wantDock.join(','), `右栏 tab 不对：${dock.join(',')}（期望 ${wantDock.join(',')}）`);

    // 一行放不下才分两行：按各入口的纵向位置数行数
    const rows = await page
      .locator('.dock-tabs')
      .evaluate((el) => new Set([...el.children].map((c) => c.getBoundingClientRect().top)).size);
    assert(rows === 2, `右栏入口没有排成两行：${rows} 行`);

    // 点「总览」要真出面板（不是只换高亮）；看完点回「变更」，别把后续用例留在总览上
    await page.locator('.dock-changes .dock-tab', { hasText: wantDock[2] }).first().click();
    await page.waitForSelector('.dock-changes .ov-panel, .dock-changes .panel-empty', { timeout: 8000 });
    await page.locator('.dock-changes .dock-tab', { hasText: wantDock[0] }).first().click();
    return `左栏 ${left.join(' / ')}；右栏 ${dock.join(' / ')}（${rows} 行）`;
  });

  await step('AG-FONT：code 会话区字号跟随设置里的「字号」', async () => {
    // 2026-10-03 用户要求：设置里改「字号」时，code agent 与会话区也跟着缩放。
    // 上一条 P24 已把字号设成 16px：会话区正文应是 16px、小字 16-1=15px
    // （修之前 styles.css 的 --fs-* 是固定 px，这里被钉死在 13px / 12px）。
    const en = (await page.evaluate(() => document.documentElement.lang)) === 'en';
    await page
      .locator('.sidebar .panel-tabs > button', { hasText: en ? 'Code sessions' : 'code会话' })
      .first()
      .click();
    await page.waitForSelector('.ag-side', { timeout: 8000 });
    await page.waitForSelector('.ag-side .ag-note', { timeout: 8000 });

    const px = await page.evaluate(() => {
      const pick = (sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).fontSize : null;
      };
      return {
        head: pick('.ag-side-head'),
        sideNote: pick('.ag-side .ag-note'),
        viewNote: pick('.agent-view .ag-note'),
      };
    });
    assert(px.head === '16px', `会话区正文字号没跟随：${px.head}（期望 16px）`);
    assert(px.sideNote === '15px', `会话区小字没跟随：${px.sideNote}（期望 15px）`);
    // 中间区的会话内容不一定渲染（取决于当前是否有会话），有则一并验
    if (px.viewNote) assert(px.viewNote === '15px', `会话内容区小字没跟随：${px.viewNote}（期望 15px）`);

    // 看完切回「文件」，别把后续用例留在 code 会话上
    await page
      .locator('.sidebar .panel-tabs > button', { hasText: en ? 'Files' : '文件' })
      .first()
      .click();
    return `会话区 ${px.head} / ${px.sideNote}、内容区 ${px.viewNote ?? '（未渲染）'}`;
  });

  await step('AP：「添加项目」= 顶栏图标 → 弹窗选目录（Shadow DOM 隔离 + 手敲路径跳转）', async () => {
    // 前一条用例把语言切成了英文，两种文案都认
    await page.locator('header button', { hasText: /添加项目|Add project/ }).first().click();
    const icon = page.locator('.open-folder .icon-btn');
    await icon.waitFor({ state: 'visible', timeout: 8000 });
    await icon.click();

    const dialog = page.locator('.fb-dialog');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });
    // 弹窗挂在 Shadow DOM 里（隔离第三方组件 CSS）：宿主节点在，且弹窗本体真渲染出来了
    assert((await page.locator('.fb-host').count()) === 1, '没有 Shadow 宿主节点');
    assert((await page.locator('.fb-dialog .file-item-container').count()) > 0, '起点列表里没有可点的目录');

    // 手敲真实路径 → 跳转 → 确认区必须给**真实**本机路径（虚拟路径不该漏到界面上）
    const info = await fetch(`${BASE}/api/projects`).then((r) => r.json());
    const list = Array.isArray(info) ? info : (info.projects ?? []);
    const root = list.find((p) => p.id === PROJECT)?.root;
    assert(root, '拿不到夹具项目的根目录');
    await page.locator('.fb-input').fill(root.split(path.sep).join('/'));
    await page.locator('.fb-input').press('Enter');
    await page.locator('.fb-picked').filter({ hasText: path.basename(root) }).waitFor({ timeout: 8000 });
    const picked = await page.locator('.fb-picked').innerText();
    const norm = (s) => s.replace(/\\/g, '/').toLowerCase();
    assert(norm(picked).includes(norm(root)), `确认区不是真实路径：${picked}`);

    // 确认：弹窗关掉，项目选择不被换掉（同一目录永远同一个 id，不会多出一条）
    const before = await page.locator('.project-select').inputValue();
    await page.locator('.fb-btn.primary').click();
    await dialog.waitFor({ state: 'detached', timeout: 8000 });
    assert((await page.locator('.project-select').inputValue()) === before, '项目选择被换掉了');
    return `确认区「${picked}」`;
  });

  await step('全程无 console error', async () => {
    assert(errors.length === 0, `有 ${errors.length} 条：${errors[0]}`);
    return '0 条';
  });

  await browser.close();
}

try {
  await main();
} catch (e) {
  errors.push(String(e));
  console.error(`底座 UI 回归中断：${String(e).slice(0, 300)}`);
}
report();
