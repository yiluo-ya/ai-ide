import { defineConfig } from 'vitest/config';

/**
 * 前端单测（P19）。
 *
 * - 环境用 jsdom：prefs / state 的 localStorage 与 document 直接可用，不必每个用例手写 stub；
 * - 只收 `src/**` 下的 `*.test.ts`（组件级交互仍归 `npm run test:ui` 的浏览器回归）。
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
