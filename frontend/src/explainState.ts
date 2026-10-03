/**
 * 向导（04 Guide · W4）结构性解释的状态与请求（G5.1–G5.4 / Q1-A）。
 *
 * 两条纪律：
 * 1. **纯静态**：解释全部来自后端的定义 / 引用 / 调用索引，不使用任何模型；
 *    界面与文案里只说「结构性解释」，不出现 AI 字样（`04-guide-plan.md` Q1 选了 A 档）。
 * 2. **404 不当错误弹窗**：`no-symbol`（光标处没有可解释的项目内符号）只给状态栏
 *    一句轻提示，不弹空面板 —— 与 03 的 Q1 口径一致。
 *
 * 为什么不并入 `state.ts`：那个文件正被其它主题持续改写；解释的状态自成一体。
 * 请求不走 `api.ts` 的 `request`，因为要区分 404 `no-symbol` 与其它失败
 * （`request` 只抛出人话 message，丢掉了错误码）。
 */
import { create } from 'zustand';
import type { ExplainResult, ExplainScope } from '../../shared/types';
import { translate } from './i18n';
import { showFlash } from './state';

/** 解释的发起位置（编辑器光标或面板上的符号）。 */
export interface ExplainTarget {
  file: string;
  /** 1-based。 */
  line: number;
  /** 1-based。 */
  col: number;
}

/** 解释范围三档（G5.3）：选中一段 / 所在符号（默认）/ 连带调用方。 */
export const EXPLAIN_SCOPES: ExplainScope[] = ['selection', 'symbol', 'callers'];

/** 请求结果：区分「没有符号」与「真的失败」，两者给用户的反应完全不同。 */
type ExplainResponse =
  | { ok: true; result: ExplainResult }
  | { ok: false; noSymbol: boolean; message: string };

/** `POST /explain`（后端已落地；这里自己解析错误码，见文件头注释）。 */
async function postExplain(projectId: string, target: ExplainTarget, scope: ExplainScope): Promise<ExplainResponse> {
  try {
    const res = await fetch(`/api/projects/${projectId}/explain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: target.file, line: target.line, col: target.col, scope }),
    });
    const body = (await res.json().catch(() => null)) as
      | (ExplainResult & { error?: string; message?: string })
      | null;
    if (!res.ok) {
      return {
        ok: false,
        noSymbol: body?.error === 'no-symbol',
        message: body?.message ?? body?.error ?? `${res.status} ${res.statusText}`,
      };
    }
    return { ok: true, result: body as ExplainResult };
  } catch (e) {
    return { ok: false, noSymbol: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** 符号种类的人话（i18n 里没有的 kind 原样回落，不猜）。 */
export function kindText(kind: string): string {
  const key = `kind.${kind}`;
  const text = translate(key);
  return text === key ? kind : text;
}

interface ExplainState {
  projectId: string | null;
  /** 当前解释的目标；null = 面板关闭。 */
  target: ExplainTarget | null;
  scope: ExplainScope;
  result: ExplainResult | null;
  busy: boolean;
  error: string | null;

  /** 打开面板并请求（默认范围档 `symbol`）。 */
  open: (projectId: string, target: ExplainTarget, scope?: ExplainScope) => void;
  /** 切换范围档 → 用同一目标重新请求（G5.3）。 */
  setScope: (scope: ExplainScope) => void;
  /** 失败后重试。 */
  retry: () => void;
  close: () => void;
  /** 切项目 / 退出时清空。 */
  reset: () => void;
}

async function load(
  projectId: string,
  target: ExplainTarget,
  scope: ExplainScope,
  set: (patch: Partial<ExplainState>) => void,
  isCurrent: () => boolean,
): Promise<void> {
  set({ busy: true, error: null, result: null });
  const res = await postExplain(projectId, target, scope);
  // 请求期间用户换了目标 / 关了面板 / 切了项目：丢弃这次结果
  if (!isCurrent()) return;
  if (res.ok) {
    set({ result: res.result, busy: false });
    return;
  }
  if (res.noSymbol) {
    // 空面板没有信息量：关掉面板，只在状态栏说一句
    showFlash(translate('explain.noSymbol'));
    set({ target: null, result: null, busy: false, error: null });
    return;
  }
  set({ busy: false, error: res.message });
}

export const useExplainStore = create<ExplainState>((set, get) => ({
  projectId: null,
  target: null,
  scope: 'symbol',
  result: null,
  busy: false,
  error: null,

  open(projectId, target, scope = 'symbol') {
    set({ projectId, target, scope, result: null, error: null });
    void load(projectId, target, scope, set, () => {
      const s = get();
      return (
        s.projectId === projectId &&
        !!s.target &&
        s.target.file === target.file &&
        s.target.line === target.line &&
        s.target.col === target.col &&
        s.scope === scope
      );
    });
  },

  setScope(scope) {
    const { projectId, target } = get();
    if (!projectId || !target || scope === get().scope) return;
    set({ scope });
    void load(projectId, target, scope, set, () => {
      const s = get();
      return (
        s.projectId === projectId &&
        !!s.target &&
        s.target.file === target.file &&
        s.target.line === target.line &&
        s.scope === scope
      );
    });
  },

  retry() {
    const { projectId, target, scope } = get();
    if (!projectId || !target) return;
    void load(projectId, target, scope, set, () => get().projectId === projectId && !!get().target);
  },

  close() {
    set({ target: null, result: null, busy: false, error: null });
  },

  reset() {
    set({ projectId: null, target: null, scope: 'symbol', result: null, busy: false, error: null });
  },
}));
