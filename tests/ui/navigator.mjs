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
import { openPanel, useFastTimeouts, withStepTimeout } from './panel.mjs';

const PORT = process.env.PORT ?? '8799';
const BASE = `http://127.0.0.1:${PORT}`;
/** 文件节点算「贴着自己父目录」的纵向容差（泳道半高 + 展开时的纵向浮动余量）。 */
const LANE_TOLERANCE = 200;

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

/**
 * 跨平台查找本机 Chromium（Windows / Linux / macOS 的 playwright 缓存）；找不到返回 null，
 * 交给 playwright-core 自己按默认规则找（CI 用 `npx playwright install --with-deps chromium` 装的就在这里）。
 */
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
  const executablePath = findChromium();
  const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  // 失败要快：默认 30 秒的等待会把一条超时放大成半分钟（需要长等的步骤各自写了显式 timeout）
  useFastTimeouts(page);
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  // setup 显式放宽到 60 秒：首次索引是外部过程（磁盘 + tree-sitter），不是「用例该多等一秒」的问题
  await step('setup：打开夹具项目并等文件树就绪', async () => {
    // 每一步都给显式超时：靠默认 30 秒的话，卡住时既看不出卡在哪、也拖很久
    await page.goto(`${BASE}/?project=${PROJECT}`, { waitUntil: 'networkidle', timeout: 30_000 });
    // 复制位置用例会用到剪贴板（只在 127.0.0.1 这个安全上下文中生效）
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    // 干净起步：清掉上一轮遗留的位置记忆
    await page.evaluate(() => window.localStorage.clear());
    await page.reload({ waitUntil: 'networkidle', timeout: 30_000 });
    // 等文件树就绪（索引 / 地图数据加载完）
    await openPanel(page, 'files');
    await page.waitForFunction(() => document.querySelectorAll('.tree-row').length > 0, null, { timeout: 60_000 });
    return `${await page.locator('.tree-row').count()} 行文件树`;
  }, 60_000);

  // setup 失败时，后面每条用例都只会重复同一个错误（各等一次超时）。
  // 先把已有结果打印出来再退出 —— 以前 setup 失败是抛个栈直接结束，一条结果都看不到。
  if (results.some((r) => !r.pass && r.name.startsWith('setup'))) {
    await browser.close();
    report();
    process.exitCode = 1;
    return;
  }

  await step('T：文件树默认折叠、目录与文件两色', async () => {
    await openPanel(page, 'files');
    await page.waitForSelector('.tree-row.dir', { timeout: 15_000 });
    // 2026-10-03 用户要求「文件夹默认折叠」：一进来只该看到目录行
    const fileRows = await page.locator('.tree-row.file').count();
    assert(fileRows === 0, `默认应折叠，却直接显示了 ${fileRows} 个文件行`);
    const dirColor = await page.$eval('.tree-row.dir .tree-name', (el) => getComputedStyle(el).color);
    const dirWeight = await page.$eval('.tree-row.dir .tree-name', (el) => getComputedStyle(el).fontWeight);
    // 展开第一个目录，看文件行是否出现、颜色是否与目录不同
    await page.locator('.tree-row.dir').first().click();
    await page.waitForSelector('.tree-row.file', { timeout: 15_000 });
    const fileColor = await page.$eval('.tree-row.file .tree-name', (el) => getComputedStyle(el).color);
    assert(
      dirColor !== fileColor,
      `目录与文件颜色相同（都是 ${dirColor}）：用户要求区分这两者`,
    );
    return `目录 ${dirColor} / 粗 ${dirWeight}，文件 ${fileColor}`;
  });

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

  const sidebar = async (id) => {
    await openPanel(page, id);
    await page.waitForTimeout(600);
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

  // 2026-10-03 用户要求移除「引用 / 层级」面板：原来的 N4（引用）、N（家族）、N16（调用层级）
  // 三条用例随之删除 —— 面板已不在界面上，测它等于测不存在的东西。
  // 后端接口与组件保留（见 docs/03-navigator.md 的变更记录），日后恢复入口时再把用例接回来。

  await step('N11/N12：搜索面板（全屏入口 / 停止按钮 / 目录归类）', async () => {
    await openPanel(page, 'search');
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
    await sidebar('outline');
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

  await step('CMD：右侧栏「命令」tab 看得到服务状态（不点重启）', async () => {
    // 2026-10-03 用户要求：命令面板从侧栏 tab 搬到右侧常驻栏，与「变更」并排（默认变更）。
    const dockTab = page.locator('.dock-changes .dock-tab', { hasText: '命令' }).first();
    await dockTab.waitFor({ timeout: 15_000 });
    await dockTab.click();
    await page.waitForSelector('.service-panel .sv-facts', { timeout: 15_000 });
    const text = await page.locator('.service-panel').innerText();
    assert(/pid\s*\d+/.test(text), `没显示进程 pid：${text.slice(0, 120)}`);
    assert(/运行时长/.test(text), `没显示运行时长：${text.slice(0, 120)}`);
    assert(/重启服务/.test(text) && /停止服务/.test(text), '缺少重启 / 停止按钮');
    // 注意：这里**不点**重启与停止 —— 那会真的把跑测试的服务杀掉。
    // 真实重启路径由 bin/restart-worker.mjs 承担，人工验证时点一次即可。
    return text.replace(/\s+/g, ' ').slice(0, 90);
  });

  // 这条用例要「开图 + 点开一个目录（触发一次后端重算）」再断言布局，
  // 内部等待本身就超过默认 20 秒上限，所以显式放宽到 40 秒（其余用例仍守 20 秒）。
  await step('M：依赖图里文件节点贴着自己所属的目录', async () => {
    // 用深链直接开图：主区的「看依赖图」按钮只在项目地图页出现，依赖当前主区视图，太脆。
    const url = new URL(page.url());
    url.searchParams.set('graph', '1');
    await page.goto(url.toString(), { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForSelector('.gv-node', { timeout: 20_000 });
    // 2026-10-03：默认目录级视图不再混入文件节点（更干净）；
    // 先确认默认就是纯目录，再点一个目录展开，看文件是否贴着自己的父目录。
    const defaultKinds = await page.$$eval('.gv-node', (els) =>
      els.map((e) => e.getAttribute('data-kind')),
    );
    assert(
      !defaultKinds.includes('file'),
      `默认依赖图里混进了文件节点（应只有目录）：${JSON.stringify(defaultKinds)}`,
    );
    // 要展开的是「真有文件的目录」：根目录 './' 下没有直接文件，点它等于没变化
    // （夹具的文件都在 src/ 与 tests/ 里）—— 这是用例自身的坑，不是产品的问题。
    const dirNode = page.locator('.gv-node[data-kind="dir"]:not([data-id="./"])').first();
    // 图是 SVG + 力导向布局，节点常落在视口外或与图例重叠；这里只关心「点它会展开」，
    // 所以跳过可点性检查直接派发点击（真实浏览器里是这个 onClick 在展开目录）。
    await dirNode.click({ force: true });
    await page.waitForSelector('.gv-node[data-kind="file"]', { timeout: 20_000 });
    const nodes = await page.$$eval('.gv-node', (els) =>
      els.map((e) => {
        const m = /translate\((-?[\d.]+) (-?[\d.]+)\)/.exec(e.getAttribute('transform') ?? '');
        return {
          id: e.getAttribute('data-id') ?? '',
          kind: e.getAttribute('data-kind') ?? '',
          y: Number(m?.[2] ?? NaN),
        };
      }),
    );
    const dirs = nodes.filter((n) => n.kind === 'dir');
    const files = nodes.filter((n) => n.kind === 'file' && Number.isFinite(n.y));
    assert(dirs.length >= 1, '依赖图没有目录节点');
    assert(files.length >= 1, `依赖图没有文件级节点：${JSON.stringify(nodes.slice(0, 6))}`);
    const yOf = new Map(nodes.map((n) => [n.id, n.y]));
    /** 文件所属目录的 y（逐级向上找图上存在的目录）。 */
    const parentY = (id) => {
      const parts = id.split('/');
      for (let i = parts.length - 1; i > 0; i -= 1) {
        const dir = `${parts.slice(0, i).join('/')}/`;
        if (yOf.has(dir)) return yOf.get(dir);
      }
      return yOf.get('./');
    };
    const anchored = files.filter((f) => {
      const py = parentY(f.id);
      return py !== undefined && Math.abs(py - f.y) <= LANE_TOLERANCE;
    });
    assert(
      anchored.length >= 1,
      `文件节点都没贴着自己所属的目录（会被统一下沉成一行）：${JSON.stringify(files.slice(0, 6))}`,
    );
    const bands = new Set(files.map((f) => Math.round(f.y / 100))).size;
    await page.keyboard.press('Escape');
    return `${files.length} 个文件节点，贴住父目录 ${anchored.length} 个，y 分 ${bands} 档`;
  }, 40_000);

  await browser.close();

  report();
}

await main();
