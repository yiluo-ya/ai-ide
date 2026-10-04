/**
 * UI 用例共用的「打开侧栏面板」动作。
 *
 * 左栏只剩「文件」与「code会话」（2026-10-03 用户要求）；
 * 「大纲」「搜索」搬到了右栏常驻栏（与变更 / 命令 / 总览并排，共五个入口）。
 */

/** 住在右栏的面板（左栏只剩文件 / code会话）。 */
const DOCK_PANELS = new Set(['outline', 'search']);

/** 打开面板（按 tab id）：文件 / code会话在左栏，大纲 / 搜索在右栏。 */
export async function openPanel(page, id) {
  if (DOCK_PANELS.has(id)) {
    // 右栏可能被收着（收着时只剩一个箭头按钮）：先展开，否则看不到入口
    if (await page.locator('.dock-changes.collapsed').count()) {
      await page.locator('.dock-changes .dock-toggle').click();
    }
    const tab = page.locator(`#wcr-dock-tab-${id}`).first();
    if (!(await tab.count())) throw new Error(`右栏没有这个面板：${id}`);
    if ((await tab.getAttribute('aria-selected')) === 'true') return;
    await tab.click();
    return;
  }

  // 已经是当前面板就不用再点（平白多一次点击与等待）
  const labelledBy = await page.locator('#wcr-side-panel').getAttribute('aria-labelledby').catch(() => null);
  if (labelledBy === `wcr-tab-${id}`) return;

  const direct = page.locator(`#wcr-tab-${id}`).first();
  if (!(await direct.count())) throw new Error(`左栏没有这个面板：${id}`);
  await direct.click();
}

/**
 * 给页面设一个「失败快」的默认超时。
 * Playwright 默认 30 秒：一条用例挂住就要白等半分钟，五条就是几分钟 ——
 * 而真正需要长等的步骤（首次索引、整页加载）都各自写了显式 timeout，不受影响。
 */
export const DEFAULT_TIMEOUT_MS = 8000;

export function useFastTimeouts(page) {
  page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
}

/**
 * 单个用例的硬上限：20 秒（项目规矩）。
 * 20 秒还完不成，先怀疑用例本身（等待过久 / 依赖了别处的状态），再查被测代码是不是真有 bug；
 * 不要靠调大这个数把问题盖过去 —— 要放宽就显式传 timeoutMs 并在调用处写明理由。
 */
export const STEP_TIMEOUT_MS = 20_000;

/** 跑一条用例，超过上限就失败（错误文案直接给出排查方向）。 */
export function withStepTimeout(name, fn, timeoutMs = STEP_TIMEOUT_MS) {
  let timer;
  const run = Promise.resolve().then(fn);
  // 同样给 run 挂一个 noop 处理：超时先到时，run 之后的失败不会变成 unhandled rejection。
  // 注意 race 必须用 run 本身 —— 用被 catch 过的版本会把「用例失败」吞成假通过。
  run.catch(() => {});
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `用例「${name}」超过 ${timeoutMs / 1000} 秒未结束：先怀疑用例是否合理（等待过久 / 依赖了别处的状态），再查被测代码是否有 bug`,
        ),
      );
    }, timeoutMs);
  });
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
}
