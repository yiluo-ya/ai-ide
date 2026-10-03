/**
 * UI 用例共用的「打开侧栏面板」动作。
 *
 * 侧栏现在分两组：常驻（文件 / 大纲 / 搜索）直接点；其余收在「更多 ▾」菜单里。
 * 用例只关心「我要打开哪个面板」，不该各自记着哪个面板藏在菜单里 ——
 * 之前三套脚本各写一份点击逻辑，收敛 tab 时有 5 条用例直接超时 30 秒。
 */

/** 打开侧栏面板（按 tab id）。常驻的直接点，辅助的先展开「更多」菜单。 */
export async function openPanel(page, id) {
  const direct = page.locator(`#wcr-tab-${id}`).first();
  if (await direct.count()) {
    await direct.click();
    return;
  }
  await page.locator('.panel-more > button').click();
  const item = page.locator(`.panel-more-menu #wcr-tab-${id}`).first();
  if (!(await item.count())) {
    // 菜单开着却不认识这个 id：先把菜单关掉（不然遮罩会挡住后面每一条用例的点击，
    // 变成一连串超时，把真正的失败原因埋掉），再报错。
    await page.locator('.panel-more > button').click().catch(() => {});
    await page.locator('.panel-more-backdrop').click({ timeout: 1000 }).catch(() => {});
    throw new Error(`侧栏没有这个面板：${id}（既不在常驻组，也不在「更多」菜单里）`);
  }
  await item.click();
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
