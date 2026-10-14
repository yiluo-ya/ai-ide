/**
 * 键盘映射抽象层（keymap）：把「按键手势」解析成「动作」，App 的全局 keydown 只查映射、不再散落一串 if。
 *
 * 两套方案：
 * - vscode：沿用原快捷键（Ctrl/Cmd+P 打开文件、Ctrl/Cmd+T 打开符号、Ctrl/Cmd+, 设置、Ctrl/Cmd+1..9 面板 …）。
 * - idea：IntelliJ IDEA 习惯（Ctrl+Shift+N / Ctrl+Alt+Shift+N / Ctrl+Alt+S / Alt+1..9 …），默认这套。
 *
 * 纪律：手势只描述「按了哪些修饰键 + 哪个键」，不绑定动作语义；动作语义由 ACTIONS 统一收口，
 * 这样加一套新 keymap 只加一张映射表，App 的按键处理逻辑无需再动。
 */

/** 动作 id：全局导航类快捷键的收口（其余编辑器内快捷键由 Monaco 自己管，见 monaco-setup）。 */
export type KeyAction =
  | 'openFile' // 打开文件（文件搜索浮层）
  | 'openSymbol' // 打开符号（符号搜索浮层）
  | 'settings' // 打开设置
  | 'searchPanel' // 项目搜索面板
  | 'outlinePanel' // 大纲面板
  | 'filesPanel' // 文件面板
  | 'continueReading' // 继续上次阅读位置
  | 'runFile' // 在终端中运行当前文件（FR-0011）
  | 'back' // 后退到上一个光标/编辑位置
  | 'forward' // 前进到下一个光标/编辑位置
  | 'revealInFiles' // FR-0012：把当前打开文件定位到文件树里
  | 'collapseAll' // FR-0012：收拢文件树里所有文件夹
  | 'sidePanel'; // 切到某个侧栏 tab（具体是哪个由 1..9/0 数字决定）

export type KeymapId = 'vscode' | 'idea';

/**
 * 修饰键组合：布尔位描述。meta 在 macOS 上 = Cmd，在其它平台等价 ctrl。
 * 用结构化对象而非字符串，避免手写 'ctrl+shift+n' 解析歧义。
 */
export interface Gesture {
  key: string; // 已小写的键盘主键（'n'、','、'f3'、'1'、'arrowleft' …）
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

/** 单套 keymap：手势 → 动作。数组顺序即匹配顺序（先精确命中后面不再继续）。 */
export type Keymap = Array<{ gesture: Gesture; action: KeyAction }>;

// prettier 之外的手动对齐方式：用同一套 Gesture 字面量构造器，保持可读。
const g = (key: string, mods: Partial<Omit<Gesture, 'key'>> = {}): Gesture => ({
  key: key.toLowerCase(),
  ctrl: false,
  shift: false,
  alt: false,
  meta: false,
  ...mods,
});

/** VS Code 键位：保留原语义（mod = Ctrl 或 Cmd）。 */
const VSCODE_KEYMAP: Keymap = [
  { gesture: g(',', { ctrl: true, meta: true }), action: 'settings' },
  { gesture: g('p', { ctrl: true, meta: true }), action: 'openFile' },
  { gesture: g('t', { ctrl: true, meta: true }), action: 'openSymbol' },
  { gesture: g('f', { ctrl: true, meta: true, shift: true }), action: 'searchPanel' },
  { gesture: g('o', { ctrl: true, meta: true, shift: true }), action: 'outlinePanel' },
  { gesture: g('e', { ctrl: true, meta: true, shift: true }), action: 'filesPanel' },
  { gesture: g('r', { ctrl: true, meta: true, shift: true }), action: 'continueReading' },
  // 在终端中运行当前文件（FR-0011）：沿用 VS Code 的 Ctrl+F5 位置语义（这里不做 debug）
  { gesture: g('f5', { ctrl: true }), action: 'runFile' },
  // 后退/前进：VS Code 沿用项目原习惯 Alt+←/→（浏览器/通用习惯）。
  { gesture: g('arrowleft', { alt: true }), action: 'back' },
  { gesture: g('arrowright', { alt: true }), action: 'forward' },
  // FR-0012：定位当前文件（Alt+F，两套 keymap 一致）+ 收拢所有文件夹
  { gesture: g('f', { alt: true }), action: 'revealInFiles' },
  { gesture: g('-', { ctrl: true, shift: true }), action: 'collapseAll' },
];

/**
 * IntelliJ IDEA 键位（Windows/Linux，默认）：
 * - 打开文件 = Ctrl+Shift+N（IDea 的 File / 类搜索是两次 Shift 或 Ctrl+N，这里选确定性最强、冲突最少的 Ctrl+Shift+N）
 * - 打开符号 = Ctrl+Alt+Shift+N
 * - 设置 = Ctrl+Alt+S
 * - 项目搜索 / 大纲 / 文件面板沿用 Ctrl+Shift+F/O/E（IDea 用户对 Ctrl+Shift+F 全局查找的肌肉记忆一致）
 */
const IDEA_KEYMAP: Keymap = [
  { gesture: g('s', { ctrl: true, alt: true }), action: 'settings' },
  { gesture: g('n', { ctrl: true, shift: true }), action: 'openFile' },
  { gesture: g('n', { ctrl: true, alt: true, shift: true }), action: 'openSymbol' },
  { gesture: g('f', { ctrl: true, shift: true }), action: 'searchPanel' },
  { gesture: g('o', { ctrl: true, shift: true }), action: 'outlinePanel' },
  { gesture: g('e', { ctrl: true, shift: true }), action: 'filesPanel' },
  { gesture: g('r', { ctrl: true, shift: true }), action: 'continueReading' },
  { gesture: g('f5', { ctrl: true }), action: 'runFile' },
  // 后退/前进：IDEA 用 Ctrl+Alt+←/→（Navigate Back/Forward）。
  { gesture: g('arrowleft', { ctrl: true, alt: true }), action: 'back' },
  { gesture: g('arrowright', { ctrl: true, alt: true }), action: 'forward' },
  // FR-0012：定位当前文件（与 VS Code 方案一致）+ 收拢所有文件夹
  { gesture: g('f', { alt: true }), action: 'revealInFiles' },
  { gesture: g('-', { ctrl: true, alt: true }), action: 'collapseAll' },
];

const KEYMAPS: Record<KeymapId, Keymap> = {
  vscode: VSCODE_KEYMAP,
  idea: IDEA_KEYMAP,
};

/** 把一个原生 KeyboardEvent 折叠成规范手势。 */
export function eventToGesture(e: KeyboardEvent): Gesture {
  return {
    key: e.key.toLowerCase(),
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
    meta: e.metaKey,
  };
}

/** 手势相等判断（忽略修饰键的 ctrl/meta 区分，二者都当作「主修饰键 mod」）。 */
function gestureMatches(actual: Gesture, want: Gesture): boolean {
  if (actual.key !== want.key) return false;
  const wantMod = want.ctrl || want.meta;
  const actualMod = actual.ctrl || actual.meta;
  return (
    actualMod === wantMod &&
    actual.shift === want.shift &&
    actual.alt === want.alt &&
    // meta 与 ctrl 在非 macOS 上对浏览器而言互斥，这里已归并到 mod，不再单独比较。
    true
  );
}

/** 按当前 keymap 把手势解析成动作；找不到返回 null（表示不拦截、让事件继续流到别处）。 */
export function resolveAction(gesture: Gesture, keymap: KeymapId): KeyAction | null {
  const table = KEYMAPS[keymap] ?? IDEA_KEYMAP;
  for (const entry of table) {
    if (gestureMatches(gesture, entry.gesture)) return entry.action;
  }
  return null;
}

/** 侧栏面板数字键：Ctrl/Cmd+1..9/0（vsCode）或 Alt+1..9/0（IDea）。 */
export function sidePanelModifier(keymap: KeymapId): 'ctrl' | 'alt' {
  return keymap === 'idea' ? 'alt' : 'ctrl';
}