# 08 语言插件标准（全功能）

> 目标：**一门语言的全部阅读能力都能由插件提供** —— 高亮、大纲、跳转定义、查找引用、Hover、符号搜索、
> 密度条、文件树色点。插件在一个**独立项目**里开发，完成后导入阅读器即用，不改本仓库任何源码。
>
> 本文是编写插件的唯一标准；配套实现见 `backend/src/languages/plugin.ts`（契约）、
> `backend/src/languages/loader.ts`（发现与加载）、`frontend/src/languages.ts`（前端消费）。
> 背景与实施进度见 `docs/07-languages-plugin-plan.md`。

---

## 一、能力矩阵（「全功能」的判定标准）

这是验收一门语言插件是否达标的唯一表格。**每一行都要能实测通过**。

| # | 能力 | 入口 | 由谁决定 | 达标判据 |
|---|---|---|---|---|
| C1 | **语法高亮** | 打开文件 | 插件 `monaco` 贡献（Monaco 内置的语言可省略） | 关键字 / 字符串 / 注释 / 数字着色与语言习惯一致，不是一片白 |
| C2 | **文件树色点** | 左侧文件树 | `spec.color`（或 `meta.color`） | 该语言的文件左侧有明显色点 |
| C3 | **文件大纲** | `Ctrl/Cmd+Shift+O` | `spec.scopes` + `spec.handlers`（或 `spec.lineSymbols`） | 列出函数 / 类 / 结构等，层级正确 |
| C4 | **符号搜索** | `Ctrl/Cmd+T` | 同 C3（顶层符号） | 能搜到该语言文件里的顶层定义，跳过去定位准确 |
| C5 | **跳转到定义** | `F12` / `Ctrl+Click` | `spec.handlers` + `spec.identifierTypes` + `spec.resolveModule`（行式语言用 `spec.lineRefs`） | 从调用点跳到定义处；跨文件也要能跳 |
| C6 | **查找引用** | `Shift+F12` | 同 C5（引用提取） | 列出项目内所有引用点，含跨文件 |
| C7 | **Hover** | 鼠标悬停 | 同 C5（定义）+ `spec.literalTypes` / `valueContainers` / `indexAccess` | 悬停符号给出签名与出处；悬停字面量给出绑定值 |
| C8 | **不可跳转时的解释** | 同上触发失败 | `spec.builtins` / `resolveModule` 返回 `null` | 提示条区分「外部依赖 / 解析不了 / 索引中」，不出现「什么都没发生」 |
| C9 | **密度条** | 文件摘要条 | `spec.commentPrefixes` | 代码 / 注释 / 空白三档占比合理 |
| C10 | **签名展示** | Hover 卡片 / 大纲 | `spec.signatureStyle` / `signatureColon` | 多行签名压平成一行，参数类型（若有）不丢 |

**分档**（插件可以只做前几档，但要自己声明）：

| 档位 | 覆盖 | 说明 |
|---|---|---|
| 预览级 | C1 + C2 | 只着色与标记（`preview` 条目即可，无 `spec`） |
| 索引级 | 预览级 + C3 + C4 + C9 | 有 `spec`，行式扫描也算 |
| **全功能级** | 全部 C1–C10 | 需要引用提取与模块解析（`resolveModule`） |

> 插件的实际档位由 `GET /api/languages` 的 `refs` 字段体现：`refs: true` 表示 C5–C8 可用。

### 高亮的两种范围（先选一个再动手）

高亮（C1）是唯一受 Monaco 影响的能力，且只有两种做法：

| 范围 | 插件要写什么 | 覆盖 | 代价 |
|---|---|---|---|
| **A. Monaco 内置范围**（默认、推荐） | 只填 `monaco: '<内置语言 id>'` | Monaco 自带 **81 种**：`cpp csharp dart lua php perl r powershell solidity kotlin ruby swift scala julia graphql protobuf objective-c fsharp vb clojure elixir pascal tcl twig …` | 零额外工作；语法质量由 Monaco 保证 |
| **B. 超出 Monaco 范围**（可选） | A + 自带 `monaco.monarch`（Monarch 词法定义） | 任意语言（Zig / Haskell / Erlang / OCaml / Nim / Groovy…） | 要自己写并维护 Monarch 语法 |

**同一语法族可以借**（已验证的先例）：**C → `cpp`**（Monaco 没有独立的 `c`）、`gomod` → `go`、
`groovy` → `java`、`toml` / `pip` → `ini`、`makefile` → `shell`。借的目标在同一族里时效果与正牌语法一致。

**结论**：

- **只做 A 完全够用** —— Monaco 的 81 种覆盖了绝大多数常见语言，且没有任何额外负担；
- 选 A 时**不要**给 `monaco.monarch`，直接把 `monaco` 指向内置 id 即可；
- 选 B 时插件多写一份 Monarch（纯 JSON），阅读器会在启动时运行时注册（`monaco-setup.ts` 的
  `applyMonacoContributions`）—— **同样不需要改前端源码或重新构建**；
- 无论 A 还是 B，**C2–C10 全部照常要做**（大纲 / 跳转 / 引用 / Hover / 密度都不经过 Monaco）。

不在 A 覆盖内、又不想写 Monarch 的语言，可以按「索引级」交付：有色彩上的退让（正文退 plaintext），
但大纲、跳转、引用、Hover、密度条**照常可用**。

---

## 二、插件项目结构

一个插件就是一个 **ESM 包**。它可以住在任何地方（独立 Git 仓库、同事的目录、npm 上）。

```
wcr-lang-zig/                    # 项目根（独立仓库，与阅读器无关）
  package.json                   # 关键：type:module + wcr.lang 指向入口
  index.ts                       # 导出 plugin（下面「导出契约」）
  monaco/zig.monarch.json        # 可选：自带 Monarch 语法（Monaco 没有该语言时必需）
  tsconfig.json                  # 可选
  test/selfcheck.mjs             # 可选但强烈建议：自测脚本（第三节）
```

`package.json` 的最小形态：

```json
{
  "name": "wcr-lang-zig",
  "version": "1.0.0",
  "type": "module",
  "wcr": { "lang": "./index.ts" },
  "dependencies": { "tree-sitter-zig": "^0.2.0" }
}
```

- **`type` 必须是 `module`** —— tsx 按「最近 package.json 的 type」判 ESM/CJS，落成 CJS 会直接
  `TransformError`（实测踩过）。
- **`wcr.lang` 是插件的唯一标识**：加载器靠它识别一个目录/包是不是语言插件。
- 入口可以是 `.ts`（开发期最省事）也可以是编译好的 `.mjs`/`.js`。

---

## 三、导出契约

入口文件导出 `plugin`（或 `default`）：

```ts
import type { LanguagePlugin } from '../../ide/backend/src/languages/plugin'; // 类型来源见第五节
import Zig from 'tree-sitter-zig';
import monarch from './monaco/zig.monarch.json' with { type: 'json' };

export const plugin: LanguagePlugin = {
  // ① 后端实现（决定 C3–C10）
  spec: {
    id: 'zig',                       // 唯一 id（与 wcr.lang 无关，用于 lang 字段）
    label: 'Zig',
    extensions: ['.zig'],
    grammar: Zig,                    // tree-sitter 语法（或用 lineSymbols 行式扫描）
    scopes: { /* 节点类型 → 作用域规则 */ },
    handlers: { /* 节点类型 → 定义 / 引用提取 */ },
    identifierTypes: ['identifier'], // 默认算「引用」的节点
    commentTypes: ['comment'],
    // —— 下面是元数据与能力位（对应第一节的 C1/C2/C9/C10 与 refs）——
    monaco: 'zig',                   // Monaco 语言 id
    fence: 'zig',                    // Markdown 围栏标记
    color: '#f7a41d',                // 文件树色点 / 语言分布色带
    refs: true,                      // 声明有 C5–C8（跳转 / 引用 / hover）
    commentPrefixes: ['//'],
    signatureStyle: 'colon',         // 或 'go' | 'java'
    // —— 跨文件解析（C5/C6 跨文件必需）——
    resolveModule: (specifier, fromFile, hint) => { /* 见第六节示例 */ },
  },

  // ② 前端高亮（决定 C1）：Monaco 没有该语法时必需
  monaco: {
    id: 'zig',
    extensions: ['.zig'],
    monarch,                         // Monarch 词法定义（纯 JSON）
    configuration: {                 // 注释 / 括号 / 自动闭合
      comments: { lineComment: '//' },
      brackets: [['{', '}'], ['[', ']'], ['(', ')']],
      autoClosingPairs: [
        { open: '{', close: '}' }, { open: '[', close: ']' },
        { open: '(', close: ')' }, { open: '"', close: '"' },
      ],
    },
  },
};
```

**字段速查**（`LanguageSpec` 完整定义在 `backend/src/indexer/walker.ts`）：

| 字段 | 必要性 | 作用 |
|---|---|---|
| `id` / `label` / `extensions` | 必需 | 语言身份与文件识别（`filenames` 用于无扩展名文件） |
| `grammar` **或** `lineSymbols` | 二选一 | AST 解析 / 行式扫描（无可用语法包时） |
| `lineRefs` | 行式语言可选 | 行式扫描的引用提取：只写了 `lineSymbols` 的语言也能上 C5–C7（参考 `sql.ts`） |
| `scopes` / `handlers` / `identifierTypes` | 索引级必需 | 作用域与定义 / 引用提取（C3–C6） |
| `resolveModule` | 跨文件跳转必需 | 模块说明符 → 候选文件；`null` = 外部依赖（C5/C6/C8） |
| `commentPrefixes` | 建议 | 密度条（C9） |
| `signatureStyle` / `signatureColon` | 建议 | 签名类型提取 / 压平（C10） |
| `literalTypes` / `valueContainers` / `indexAccess` | 可选 | 字面量 hover 与配置键溯源（C7） |
| `entryPatterns` | 可选 | 「从这里开始」的入口识别 |
| `refs` | 全功能级必需 | 声明 C5–C8 可用（前端据此注册 Provider） |
| `monaco` / `fence` / `color` | 建议 | 前端高亮 / 围栏 / 色点（C1/C2） |
| `doc` | 可选 | 标记为文档/配置类（不计入死代码分析） |

---

## 四、开发 → 导入流程

```
① wcr lang new my-lang --dir ../wcr-lang-zig     # 生成独立项目骨架
② 在插件项目里实现 + 自测（node test/selfcheck.mjs）
③ wcr lang link ../wcr-lang-zig                  # 软链到插件目录（开发态）
④ 重启阅读器（页面顶栏或 POST /api/service/restart）
⑤ 打开一个该语言的文件：按第一节的 C1–C10 逐条验收
⑥ 稳定后：wcr lang add ../wcr-lang-zig           #（可选）正式安装，或直接发布 npm 包
```

要点：

- **不需要改阅读器源码，也不需要重新构建前端** —— 语言元数据（含 Monaco 语法）由后端
  `GET /api/languages` 下发，前端运行时注册。
- **装 / 卸 / 改插件后必须重启阅读器**：语言集在启动时确定（不做热加载），重启时索引会自动重建
  （快照带语言集合签名，语言集变了就丢弃快照全量重扫）。
- **`link` 与 `add` 的区别**：`link` 建软链（改代码后重启即生效，适合开发）；`add` 走 npm 安装（适合交付）。

---

## 五、类型从哪来（两种用法）

插件项目要写出 `LanguagePlugin` / `LanguageSpec` 的类型，两种方式：

| 方式 | 写法 | 适用 |
|---|---|---|
| **同仓库（当前）** | `import type { LanguagePlugin } from '<阅读器路径>/backend/src/languages/plugin'` | 在本机与阅读器并存，最快 |
| **独立仓库（推荐发布前）** | 依赖抽出的 `@wcr/lang-sdk` 包（类型唯一来源） | 插件要发布 / 给同事用 |

> `@wcr/lang-sdk` 尚未落地（见 `docs/07-languages-plugin-plan.md` §8 的 P4 决策）。落地前，
> 独立仓库可用 `paths` 映射到本机阅读器的类型，或临时 `import type { ... } from 'wcr'`。

**运行时零依赖**：插件**不需要** import 阅读器的任何运行时代码 —— 契约是纯数据结构，
只有类型是共享的。所以插件项目可以独立构建、独立版本、独立发布。

---

## 六、跨文件跳转与 Hover（全功能档的关键）

这三件事决定 C5–C8，写法与内置语言完全一致（可对照 `backend/src/languages/go.ts` / `python.ts`）：

```ts
// 1) 模块说明符 → 候选文件（跨文件跳转的唯一入口）
resolveModule(specifier, fromFile, hint) {
  if (specifier.startsWith('@std/')) return null;            // 标准库 → 外部依赖
  const base = path.dirname(fromFile);
  const rel = normalize(path.join(base, specifier));          // './util' → 'src/util'
  const candidates: ModuleCandidate[] = [];
  for (const ext of ['.zig', '/index.zig']) {
    if (hint.exists(rel + ext)) candidates.push({ path: rel + ext, kind: 'file' });
  }
  return candidates.length ? candidates : null;               // null = 外部依赖
}
```

- **返回 `null`** 表示「这是外部依赖」→ 提示条会说「跳到 import 行」而不是「解析不了」（C8）。
- **`spec.builtins`**（`Set<string>`）用来把内置符号（如 `@import`、`std.debug.print`）归入外部依赖，避免误报。
- **Hover 的签名**取自已提取的定义 `detail`；多行签名由 `signatureStyle` / `signatureColon` 控制压平与类型提取（C10）。

---

## 七、自测清单（插件侧的验收）

在插件项目里跑一条命令就能自测（`wcr lang new` 生成的骨架自带）：

```bash
node test/selfcheck.mjs            # 1) 契约自检：导出合法、id/扩展名不冲突、grammar 可解析
npm --prefix <阅读器> test         # 2) 阅读器侧回归不受影响
```

然后人工过一遍第一节的表格：

```
[ ] C1 高亮：关键字/字符串/注释/数字各有颜色（不是全白）
[ ] C2 文件树：该语言文件左侧有色点
[ ] C3 大纲：Ctrl+Shift+O 列出函数/类，层级正确
[ ] C4 符号搜索：Ctrl+T 能搜到顶层定义
[ ] C5 跳转：F12 从调用跳到定义（含跨文件）
[ ] C6 引用：Shift+F12 列出所有引用（含跨文件）
[ ] C7 Hover：悬停符号有签名与出处
[ ] C8 失败解释：「跳到 import 行」/「搜 xxx」而不是静默
[ ] C9 密度条：代码/注释/空白占比合理
[ ] C10 签名：多行签名压平一行、参数不丢
```

---

## 八、反面清单（会静默失效的写法）

| 写法 | 后果 | 正确做法 |
|---|---|---|
| 插件目录没有 `"type": "module"` | `TransformError`，插件完全不加载 | 必须有 |
| `package.json` 缺 `wcr.lang` | 被当作普通目录跳过，无任何提示 | 必须有（`wcr lang list` 也靠它列出来） |
| Monaco 没有该语言却不给 `monaco.monarch` | 高亮退化为纯文本（其它能力正常） | 自带 Monarch（范围 B），或明确接受「索引级」交付
| 引用提取只写 `identifierTypes` 不看上下文 | 把属性名、关键字全当引用，引用列表噪声大 | 在 `handlers` 里按节点类型精确提取 |
| `resolveModule` 一律返回空数组 | 跨文件跳转全部失败，且提示成「解析不了」 | 认不出时才返回 `null`（= 外部依赖） |
| 插件里 `import` 阅读器的运行时代码 | 升级阅读器可能崩插件 | 只 `import type` |
| Monarch 正则写 JS 字面量 | 加载器会自动转成字符串（见下），不会失败 | 直接写正则字面量即可；若把 Monarch 放在 `.monarch.json` 里，则只能写成 `'/\\d+/'` 字符串 |

---

## 九、参考实现

| 位置 | 用途 |
|---|---|
| `backend/src/languages/go.ts` | 跨包跳转（`resolveModule` + `fileMeta` + `siblings`）的完整写法 |
| `backend/src/languages/python.ts` | `signatureStyle: 'colon'` + 入口识别 + 子模块回退 |
| `backend/src/languages/sql.ts` | 无语法包时的行式扫描：`lineSymbols` 提定义 + `lineRefs` 提引用（关键词后面的对象名），于是 SQL 也有跳定义 / 查引用 / Hover |
| `tmp/langdir/demo-lang/` | 最小可跑插件（行式扫描 + 元数据），端到端验证脚本 `tmp/p3verify.mjs` |
| **C / C++ 插件（独立仓库示例）** | 全功能档参考实现：`D:/01_code/02_work_code/wcr-lang-cpp/index.ts`（一个包出两门语言、`#include` → 星号导入、namespace `localDefs: false`、内置符号表）；验收脚本 `tmp/cppverify.mjs`（C1–C10）与 `tmp/cppui.mjs`（C1 的前端验证） |
