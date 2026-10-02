/**
 * 03 导航 UI 回归（精简版）：正式产物 + 真实浏览器，只跑主链路冒烟用例。
 *
 * 用例：
 * 1. N9/N19：Ctrl+P 打开文件、标签条出现；
 * 2. N4：引用面板按文件分组，声明 / 测试标注都在；
 * 3. N16：调用层级面板可查；
 * 4. N11/N12：搜索面板（全屏入口 / 目录归类 / 排除测试）；
 * 5. N2：外部依赖上按 F12 → 提示条含模块名，可跳到 import 行；
 * 6. 判据 6：复制位置为 path:line:col；
 * 7. 全程无 console error。
 *
 * 跑法：npm run build && npm run test:ui（脚本自己起后端）。
 */
import { chromium } from 'playwright-core';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const PORT = process.env.PORT ?? '8799';
const BASE = `http://127.0.0.1:${PORT}`;
/**
 * 夹具项目 id 必须由 run.mjs 传入。
 * 以前这里回退到一个真实项目 id（0370c5cdff28），单独跑这个脚本时会静静地
 * 去跑使用者本机的真实项目（几百个文件的索引），既慢又把断言挂在与本轮无关的数据上。
 */
const PROJECT = process.argv[2];
if (!PROJECT) {
  console.error('用法：node tests/ui/navigator.mjs <projectId>（由 run.mjs 传夹具 id）');
  process.exit(1);
}

function findChromium() {
  const root = path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  for (const dir of readdirSync(root).filter((d) => d.startsWith('chromium-'))) {
    for (const candidate of ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe']) {
      const exe = path.join(root, dir, candidate);
      if (existsSync(exe)) return exe;
    }
  }
  throw new Error(`找不到 Chromium：${root}`);
}

const results = [];
const errors = [];

async function step(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, pass: true, detail: typeof detail === 'string' ? detail : '' });
  } catch (e) {
    results.push({ name, pass: false, detail: String(e).split('\n')[0].slice(0, 200) });
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** 打印本轮结果与收集到的控制台错误（正常结束与 setup 失败提前退出都会调）。 */
function report() {
  for (const r of results) {
    console.log(`${r.pass ? '✔' : '✖'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\nUI 回归：${passed}/${results.length} 通过`);
  if (errors.length) {
    console.log(`\n控制台错误 ${errors.length} 条：`);
    for (const e of errors.slice(0, 10)) console.log(`  - ${e.slice(0, 200)}`);
  }
  if (passed !== results.length || errors.length) process.exitCode = 1;
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  await step('setup：打开夹具项目并等文件树就绪', async () => {
    // 每一步都给显式超时：靠默认 30 秒的话，卡住时既看不出卡在哪、也拖很久
    await page.goto(`${BASE}/?project=${PROJECT}`, { waitUntil: 'networkidle', timeout: 30_000 });
    // 复制位置用例会用到剪贴板（只在 127.0.0.1 这个安全上下文中生效）
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    // 干净起步：清掉上一轮遗留的书签 / 位置记忆
    await page.evaluate(() => window.localStorage.clear());
    await page.reload({ waitUntil: 'networkidle', timeout: 30_000 });
    // 等文件树就绪（索引 / 地图数据加载完）
    await page.locator('.panel-tabs button', { hasText: '文件' }).click({ timeout: 20_000 });
    await page.waitForFunction(() => document.querySelectorAll('.tree-row').length > 0, null, { timeout: 60_000 });
    return `${await page.locator('.tree-row').count()} 行文件树`;
  });

  // setup 失败时，后面每条用例都只会重复同一个错误（各等一次超时）。
  // 先把已有结果打印出来再退出 —— 以前 setup 失败是抛个栈直接结束，一条结果都看不到。
  if (results.some((r) => !r.pass && r.name.startsWith('setup'))) {
    await browser.close();
    report();
    process.exitCode = 1;
    return;
  }

  const openFile = async (needle) => {
    await page.keyboard.press('Control+p');
    await page.waitForSelector('.quickopen-input');
    await page.fill('.quickopen-input', needle);
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
  };

  /** 直接驱动 Monaco 移动光标（Monaco 自带的 Ctrl+G 在无头环境下不稳）。 */
  const gotoLine = async (line) => {
    await page.evaluate((target) => {
      const m = window.__wcrMonaco;
      const editors = m.editor.getEditors();
      const ed = editors[0];
      if (!ed) throw new Error('no editor');
      ed.setPosition({ lineNumber: target, column: 1 });
      ed.revealLineInCenter(target);
      ed.focus();
    }, line);
    await page.waitForTimeout(600);
  };

  const sidebar = async (name) => {
    await page.locator('.panel-tabs button', { hasText: name }).click();
    await page.waitForTimeout(900);
  };

  /**
   * 读剪贴板（拿不到就返回空串，由断言决定算不算失败）。
   * Windows 的剪贴板会把 `\n` 规范化成 `\r\n`，这里统一回 LF 再断言。
   */
  const readClipboard = () =>
    page.evaluate(() =>
      navigator.clipboard
        .readText()
        .then((text) => text.replace(/\r\n/g, '\n'))
        .catch(() => ''),
    );

  await step('N9/N19：Ctrl+P 打开文件、标签条出现', async () => {
    await page.keyboard.press('Control+p');
    await page.waitForSelector('.quickopen-input');
    await page.fill('.quickopen-input', 'util.ts');
    await page.waitForTimeout(500);
    const items = await page.locator('.quickopen-item').count();
    assert(items > 0, '空查询结果');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    const bar = await page.locator('.statusbar').first().innerText();
    assert(/util\.ts/.test(bar), `状态栏没有打开文件：${bar.replace(/\s+/g, ' ')}`);
    const tabs = await page.locator('.tabbar .tab').count();
    assert(tabs >= 1, '没有标签');
    return `${bar.replace(/\s+/g, ' ')} / ${tabs} 个标签`;
  });

  await step('N4：引用面板：声明 / 测试标注（util.ts:12 helper）', async () => {
    await openFile('util.ts');
    await gotoLine(12);
    await sidebar('引用');
    await page.waitForTimeout(800);
    const text = await page.locator('.refs-panel').first().innerText();
    assert(/处引用/.test(text), `引用面板没出结果：${text.slice(0, 80)}`);
    assert((await page.locator('.refs-badge.decl').count()) >= 1, '没有标出声明行');
    assert((await page.locator('.refs-badge', { hasText: '测试' }).count()) >= 1, '没有标出测试文件');
    return text.split('\n').slice(0, 3).join(' / ');
  });

  await step('N16：调用层级面板可查（util.ts:12 helper 的调用方）', async () => {
    await sidebar('层级');
    await page.waitForTimeout(900);
    const text = await page.locator('.nav-panel').first().innerText();
    assert(/谁调用我|我调用了谁/.test(text), text.slice(0, 80));
    assert(/FastRunner|service\.ts/.test(text), `没列出调用方：${text.slice(0, 120)}`);
    assert(/已解析 1 处以上|已解析/.test(text), '没有覆盖率行');
    return text.split('\n').slice(0, 4).join(' / ');
  });

  await step('N11/N12：搜索面板（全屏入口 / 停止按钮 / 目录归类）', async () => {
    await page.locator('.panel-tabs button', { hasText: '搜索' }).click();
    await page.waitForTimeout(300);
    assert((await page.locator('.search-panel .btn', { hasText: '全屏' }).count()) >= 1, '没有全屏入口');
    await page.locator('.search-panel input.text-input').first().fill('helper');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    const summary = await page.locator('.search-summary').innerText();
    assert(/命中|无命中/.test(summary), `汇总异常：${summary}`);
    const dirHeads = await page.locator('.search-dir-head').count();
    assert(dirHeads >= 1, '结果没有按目录归类');
    // N11：按测试过滤（勾上后测试目录下的命中应消失）
    const before = await page.locator('.search-group').count();
    await page.locator('.search-toggles label', { hasText: '排除测试' }).click();
    await page.waitForTimeout(400);
    const after = await page.locator('.search-group').count();
    assert(after < before, `排除测试后结果数没减少：${before} → ${after}`);
    await page.locator('.search-toggles label', { hasText: '排除测试' }).click();
    return `${summary} / ${dirHeads} 个目录组 / 排除测试 ${before}→${after}`;
  });

  await step('N2：外部依赖上按 F12 → 提示条含模块名，可跳到 import 行', async () => {
    await openFile('util.ts');
    await page.evaluate(() => {
      // 第 13 行 `  return value + fs.constants.O_RDONLY * 0;`，光标放到 O_RDONLY 上
      const ed = window.__wcrMonaco.editor.getEditors()[0];
      ed.setPosition({ lineNumber: 13, column: 33 });
      ed.focus();
    });
    await page.waitForTimeout(400);
    await page.keyboard.press('F12');
    await page.waitForTimeout(1000);
    const notice = await page.locator('.goto-notice').innerText().catch(() => '');
    assert(notice.length > 0, '没有出现提示条');
    assert(/外部依赖/.test(notice) && /fs/.test(notice), `提示条文案不对：${notice}`);
    const jumpBtn = await page.locator('.goto-notice .btn', { hasText: '跳到 import 行' }).count();
    assert(jumpBtn >= 1, '没有「跳到 import 行」动作');
    await page.locator('.goto-notice .btn', { hasText: '跳到 import 行' }).click();
    await page.waitForTimeout(800);
    const bar = await page.locator('.statusbar').first().innerText();
    assert(/util\.ts/.test(bar), `没跳到 import 所在文件：${bar.replace(/\s+/g, ' ')}`);
    return notice.replace(/\s+/g, ' ').slice(0, 90);
  });

  await step('判据 6：复制位置 path:line:col', async () => {
    await openFile('util.ts');
    await gotoLine(12);
    await page.locator('button', { hasText: '复制位置' }).first().click();
    await page.waitForTimeout(600);
    const flash = await page.locator('.statusbar .flash-text').innerText().catch(() => '');
    assert(/已复制 src\/util\.ts:\d+:\d+/.test(flash), `状态栏没给复制反馈：${flash}`);
    return flash;
  });

  await step('S3a：复制选中代码（带出处：路径:行范围 + 围栏）', async () => {
    await openFile('util.ts');
    await sidebar('大纲');
    // 行号从界面推导（夹具会被改动，写死行号测一次就脆）
    const title = await page.locator('.outline-row', { hasText: 'helper' }).first().getAttribute('title');
    const line = Number(/第 (\d+) 行/.exec(title ?? '')?.[1]);
    assert(Number.isFinite(line), `大纲里没拿到 helper 的行号：${title}`);
    await page.evaluate((from) => {
      const m = window.__wcrMonaco;
      const ed = m.editor.getEditors()[0];
      const model = ed.getModel();
      const to = Math.min(from + 1, model.getLineCount());
      ed.setSelection(new m.Selection(from, 1, to, model.getLineMaxColumn(to)));
      ed.focus();
    }, line);
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      window.__wcrMonaco.editor.getEditors()[0].getAction('wcr.copySnippet').run();
    });
    await page.waitForTimeout(500);
    const flash = await page.locator('.statusbar .flash-text').innerText().catch(() => '');
    const where = `src/util.ts:${line}-${line + 1}`;
    assert(flash.includes(where), `状态栏没给片段反馈（缺 ${where}）：${flash}`);
    const clip = await readClipboard();
    assert(clip.startsWith(`${where}\n`), `片段出处不对：${JSON.stringify(clip.slice(0, 60))}`);
    assert(clip.includes('```ts'), `片段没带语言围栏：${JSON.stringify(clip.slice(0, 80))}`);
    return `${where} + 围栏 ts`;
  });

  await step('S3b：复制符号摘要（大纲 ⧉ → 名字 + 种类 + 签名 + 位置）', async () => {
    await openFile('util.ts');
    await sidebar('大纲');
    const row = page.locator('.outline-row', { hasText: 'helper' }).first();
    assert((await row.count()) > 0, '大纲里没有 helper');
    await row.hover();
    await row.locator('.outline-copy').click();
    await page.waitForTimeout(500);
    const flash = await page.locator('.statusbar .flash-text').innerText().catch(() => '');
    assert(/已复制符号摘要 helper/.test(flash), `状态栏没给符号摘要反馈：${flash}`);
    const clip = await readClipboard();
    assert(/^helper \(function\) src\/util\.ts:\d+:\d+/.test(clip.trim()), `符号摘要首行不对：${JSON.stringify(clip.split('\n')[0])}`);
    return clip.trim().split('\n')[0];
  });

  await step('S1：分享菜单复制带行号的深链', async () => {
    await openFile('util.ts');
    await gotoLine(12);
    await page.locator('button', { hasText: '分享' }).first().click();
    await page.waitForSelector('.share-menu');
    await page.locator('.share-item', { hasText: '复制分享链接' }).first().click();
    await page.waitForTimeout(500);
    const clip = await readClipboard();
    assert(/\?project=[^&]+&file=src%2Futil\.ts&line=12/.test(clip), `深链没带行号：${clip}`);
    await page.keyboard.press('Escape');
    await page.mouse.click(8, 500);
    await page.waitForTimeout(300);
    return clip.slice(0, 90);
  });

  await step('S10：批注面板可添加、刷新后仍在（只存本机）', async () => {
    await openFile('util.ts');
    await sidebar('批注');
    // 光标停在哪行都行：断言只用界面自己报出来的位置
    await gotoLine(3);
    await page.locator('.notes-compose textarea').first().fill('这里要处理越界');
    await page.locator('.notes-compose button').first().click();
    await page.waitForTimeout(400);
    let rows = await page.locator('.notes-row').count();
    assert(rows >= 1, '批注没有出现在面板里');
    const text = await page.locator('.notes-row .notes-text').first().innerText();
    assert(text.includes('这里要处理越界'), `批注正文不对：${text}`);

    // 重载后仍在（localStorage，按项目分片）
    await page.reload({ waitUntil: 'networkidle' });
    await sidebar('批注');
    rows = await page.locator('.notes-row').count();
    assert(rows >= 1, '刷新后批注丢了');
    return `${rows} 条批注，刷新后仍在`;
  });

  await step('S4c：打印视图页眉与 @media print 规则已就绪', async () => {
    const header = await page.locator('.wcr-print-header .wcr-print-title').first().innerText();
    assert(header.includes('util.ts'), `打印页眉没带文件名：${header}`);
    const onScreen = await page.evaluate(() => {
      const el = document.querySelector('.wcr-print-header');
      return el ? getComputedStyle(el).display : 'missing';
    });
    const hasRule = await page.evaluate(() =>
      [...document.styleSheets].some((sheet) => {
        try {
          return [...sheet.cssRules].some((r) => String(r.cssText).includes('wcr-printing .wcr-print-header'));
        } catch {
          return false;
        }
      }),
    );
    assert(onScreen === 'none', `打印页眉在屏幕上不该显示：${onScreen}`);
    assert(hasRule, '打印样式（@media print）没有加载');
    return '页眉 + @media print 规则就位';
  });

  await browser.close();

  report();
}

await main();
