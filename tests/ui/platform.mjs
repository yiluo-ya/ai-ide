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
 * 7. 全程无 console error。
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

  await step('P17 顶栏常驻隐私承诺', async () => {
    const badge = page.locator('.privacy-badge');
    await badge.waitFor({ state: 'visible', timeout: 10_000 });
    const text = (await badge.innerText()).trim();
    assert(text.includes('代码不出本机'), `角标文案不符：${text}`);
    return text;
  });

  await step('P17 隐私面板是可追证的（读/写/传/谁在用 + 可自证）', async () => {
    await page.evaluate(() => document.querySelector('.privacy-badge')?.click());
    await page.waitForTimeout(400);
    const text = await page.locator('body').innerText();
    for (const key of ['隐私与数据', '读什么', '写什么', '传什么', '谁在用', '可自证']) {
      assert(text.includes(key), `面板缺「${key}」`);
    }
    await page.evaluate(() => document.querySelector('.wcr-dialog-head button')?.click());
    await page.waitForTimeout(400);
    const open = await page.evaluate(() => !!document.querySelector('.wcr-dialog-backdrop'));
    assert(!open, '面板没能关闭');
    return '六个小节齐全，关闭正常';
  });

  await step('P9 索引报告入口可用', async () => {
    await page.evaluate(() => {
      [...document.querySelectorAll('header button')].find((b) => b.innerText.trim() === '索引报告')?.click();
    });
    await page.waitForTimeout(800);
    const title = await page.evaluate(() => document.querySelector('.wcr-dialog-title')?.textContent ?? null);
    assert(title !== null, '索引报告面板没打开');
    const text = await page.locator('.wcr-dialog-body').innerText();
    assert(/索引|文件/.test(text), `报告内容可疑：${text.slice(0, 80)}`);
    await page.evaluate(() => document.querySelector('.wcr-dialog-head button')?.click());
    await page.waitForTimeout(400);
    return `面板标题「${title}」`;
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
