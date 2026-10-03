/**
 * 04 向导 UI 回归（W1–W5 主链路）：正式产物 + 真实浏览器。
 *
 * 用例：
 * 1. G1/G2：首屏「从这里开始」给出推荐路线与步骤（不是静态说明页）；
 * 2. G2.5：点「开始阅读」直接进入路线第 1 步；
 * 3. G2.5：向导面板里每一步带理由，「下一步」能前进；
 * 4. G3.1/G3.2：打开即已读，进度计数跨刷新保留；
 * 5. G3.5：待读队列加入后跨刷新仍在（本机持久化）；
 * 6. G8.2：记录阅读基线后报「没有变化」——没有变化时不许编数字；
 * 7. G5.1/G5.2：编辑器里发起「解释这段」→ 面板给出结构性解释（未使用模型）；
 * 8. G9.1：层级面板「展开为图」出调用流节点；
 * 9. 全程无 console error。
 *
 * 跑法：npm run build && npm run test:ui（run.mjs 会先跑 navigator.mjs，再跑本脚本）。
 */
import { chromium } from 'playwright-core';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { openPanel, useFastTimeouts, withStepTimeout } from './panel.mjs';

const PORT = process.env.PORT ?? '8799';
const BASE = `http://127.0.0.1:${PORT}`;
const PROJECT = process.argv[2];
if (!PROJECT) {
  console.error('用法：node tests/ui/guide.mjs <projectId>（由 run.mjs 传夹具 id）');
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
  console.log(`\n向导 UI 回归：${passed}/${results.length} 通过`);
  if (errors.length) {
    console.log(`\n控制台错误 ${errors.length} 条：`);
    for (const e of errors.slice(0, 10)) console.log(`  - ${e.slice(0, 200)}`);
  }
  if (passed !== results.length || errors.length) process.exitCode = 1;
}

/** 当前 URL 里的 file 参数（打开文件 = 写进深链，比读 DOM 稳）。 */
const openedFile = (page) => new URL(page.url()).searchParams.get('file');

/** 回到向导面板（刷新 / 关浮层后都要先回来）。 */
// 2026-10-03：向导面板已移除，「回到向导面板」这个 helper 没用了 —— 删掉，
// 免得留着一段只会失败的代码误导后来的人（首屏卡片由下面的用例直接断言）。

async function main() {
  const executablePath = findChromium();
  const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  // 失败要快：默认 30 秒的等待会把一条超时放大成半分钟（需要长等的步骤各自写了显式 timeout）
  useFastTimeouts(page);
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  // 干净起点：向导数据（基线 / 已读 / 待读 / 笔记）全在本机 localStorage，先清掉
  await page.goto(`${BASE}/?project=${PROJECT}`);
  await page.evaluate(() => {
    try {
      window.localStorage.clear();
    } catch {
      /* 隐私模式：清不掉也不影响后续断言 */
    }
  });
  await page.reload();
  await page.waitForSelector('.tree-row, .file-tree', { timeout: 30000 });

  await step('G1/G2 首屏「从这里开始」给出推荐路线与步骤', async () => {
    await page.waitForSelector('.guide-start-card', { timeout: 20000 });
    const steps = page.locator('.guide-start-steps .guide-start-step');
    await steps.first().waitFor({ timeout: 15000 });
    const n = await steps.count();
    assert(n >= 2, `推荐路线步骤太少：${n}`);
    const first = (await steps.first().innerText()).trim();
    assert(/\.(ts|tsx|js|jsx|py|go|java)\b/.test(first) || first.includes('/'), `首步不像文件：${first}`);
    return `${n} 步，首步 ${first}`;
  });

  await step('G2.5 点「开始阅读」直接进入路线第 1 步', async () => {
    const begin = page.locator('.guide-start-card button', { hasText: '开始阅读' }).first();
    await begin.click();
    await page.waitForFunction(() => Boolean(new URL(location.href).searchParams.get('file')), null, {
      timeout: 15000,
    });
    await page.waitForSelector('.view-lines', { timeout: 15000 });
    const file = openedFile(page);
    assert(file, '没有打开任何文件');
    return file;
  });

  // 2026-10-03 用户要求移除「向导」面板：面板级用例（G2.5 步骤条 / G2.5b 行级指引 /
  // G3.1/G3.2 进度 / G3.5 待读队列）随之删除 —— 界面上一已经没有这个面板。
  // 首屏「从这里开始」（路线的入口）仍保留在上面的 G1/G2 用例里。

  await step('W：变更栏常驻在右侧，能报「没有变化」', async () => {
    // 2026-10-03：变更面板从侧栏 tab 改成右侧常驻栏（.dock-changes），用例跟着搬家。
    await page.waitForSelector('.dock-changes .changes-panel', { timeout: 15_000 });
    const record = page.locator('.changes-panel button', { hasText: '记录当前为阅读基线' }).first();
    if (await record.count()) await record.click();
    const refresh = page.locator('.changes-panel button', { hasText: '重新比对' }).first();
    if (await refresh.count()) await refresh.click();
    await page.waitForSelector('.changes-panel >> text=没有变化', { timeout: 20000 });
    const counts = await page.locator('.changes-panel').innerText();
    assert(!/变了\s*[1-9]/.test(counts), `刚记完基线却说有变化：${counts.slice(0, 80)}`);
    return '无变化（未编造数字）';
  });

  await step('G5.1/G5.2 解释这段给出结构性解释（未使用模型）', async () => {
    await openPanel(page, 'files').catch(() => {});
    await page.locator('.tabbar .tab').first().click().catch(() => {});
    await page.waitForSelector('.monaco-editor .view-lines', { timeout: 15000 });
    // 光标落在有符号的行上，再发起「解释这段」
    const lines = page.locator('.monaco-editor .view-line');
    await lines.nth(Math.min(4, Math.max(1, (await lines.count()) - 1))).click();
    await page.keyboard.press('Control+Alt+E');
    await page.waitForSelector('.explain-panel', { timeout: 20000 });
    const note = await page.locator('.ex-static-note').first().innerText();
    assert(note.includes('未使用模型') || note.includes('结构性'), `解释面板缺少结构性说明：${note}`);
    const title = await page.locator('.ex-target-name, .ex-name').first().innerText().catch(() => '');
    return `${title.trim() || '已出解释'} · ${note.trim()}`;
  });

  // G9.1（层级面板「展开为图」）随「层级」面板一起移除（2026-10-03）；调用流浮层组件保留。

  report();
  await browser.close();
}

main().catch((e) => {
  errors.push(String(e));
  report();
  process.exitCode = 1;
});
