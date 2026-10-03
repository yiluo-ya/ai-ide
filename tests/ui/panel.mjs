/**
 * UI 用例共用的「打开侧栏面板」动作。
 *
 * 左栏四个 tab（文件 / 大纲 / 搜索 / code会话）都并排常驻、直接点。
 * 2026-10-03 起没有「更多 ▾」二级菜单 —— 辅助面板只剩「总览」，它已搬去右栏 dock。
 */

/** 打开侧栏面板（按 tab id）。 */
export async function openPanel(page, id) {
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
