# 07 语言插件化（按需安装 · 重启生效）实施方案

> 目标读者：后续实施者（Builder/人）。每个阶段都能独立验证，**前一阶段验收不过就不要进下一阶段**。
> 决策前提（已与用户确认，2026-10-03）：
> ① 保留核心 6 门内置（Python / TypeScript·TSX·JS·JSX / Go / Java / Rust），其余拆成插件；
> ② 插件来源本地目录与 npm 包**都要**（本地优先）；
> ③ 插件允许 TS 源码与编译好的 JS 两种形态；
> ④ **不做**运行时 Monarch 注册 —— 只支持 Monaco 内置的那 81 种语言；
> ⑤ CLI 提供 `wcr lang list / add / remove`。

---

## 一、目标与验收标准

**目标**：新增一门语言 = 安装一个包（或往插件目录里放一个目录）+ 重启后端，**不需要改本仓库源码、不需要重新构建前端**。

**验收标准**（全部可检查）：

| # | 验收点 | 检查方式 |
|---|---|---|
| A1 | 插件目录里放一个语言实现，重启后该语言文件被索引 | 文件树出现色点、Ctrl+Shift+O 有符号、Ctrl+T 能搜到 |
| A2 | 插件语言能高亮（限 Monaco 内置 81 种） | 编辑器正常着色，非内置语法退 plaintext 且不报错 |
| A3 | 插件加载失败不影响服务启动 | 放一个语法错误的插件，服务照常起，`/api/languages` 里能看到 errors |
| A4 | 关闭插件后行为与本方案实施前一致 | `READER_PLUGINS=0` + 现有测试全绿 |
| A5 | 装卸语言后索引自动重建，新扩展名文件可见 | 老项目（已有快照）加语言后重启，新语言文件出现在树上 |
| A6 | 前端零硬编码：语言元数据来自 `/api/languages` | 前端源码中不再有扩展名→语言的全表（除离线兜底） |
| A7 | CLI 可用 | `wcr lang list / add <pkg> / remove <name>` 实测通过 |

**非目标**（明确不做）：插件的热加载（必须重启）、Monaco 非内置语法的运行时注册、插件的沙箱隔离、插件市场/自动更新。

---

## 二、已实测的可行性证据与硬约束

以下结论均为 2026-10-03 在本机实测（不是推测），实施时**不要重新试错**：

| 结论 | 证据 |
|---|---|
| tsx 可动态 `import()` 四种形态的插件：相对路径 `.ts`、绝对路径 `.ts`、纯 `.mjs`、`node_modules` 里的 TS 包 | 四种均在 `npx tsx` 下加载成功并取到导出 |
| 顶层 await 在 `languages/index.ts` 里做插件发现是可行的：引用方拿到的是**填充后**的数组 | `export const LANGUAGE_SPECS = specs`（在 `await` 之后）被另一模块 import 后内容完整 |
| 单个插件加载失败可被捕获跳过，不拖垮进程 | `try/catch` 包住动态 import，`ERR_MODULE_NOT_FOUND` 被吞并继续 |
| **插件目录必须自带 `{"type":"module"}`** | 不加时 tsx 按最近 `package.json` 的 `type` 判成 CJS，ESM/顶层 await 直接 `TransformError` |
| 前端**不需要重新构建**即可支持 Monaco 内置语言 | `frontend/dist/assets` 里已有全部 Monaco 内置语言 chunk（`abap/cpp/csharp/dart/lua/php/perl/powershell/protobuf/solidity/…`），因为 `monaco-editor/esm/vs/basic-languages/monaco.contribution` 被全量 import |
| worker 侧无需传 spec 对象 | `parse-pool.ts:76` 与 `parse-worker.ts:42` 只用 `langId` 字符串 + `specById()`，**worker 进程会自己跑一遍 `languages/index.ts`** → 插件自动生效（前提：worker 不绕过该模块） |

**硬约束**：
1. 插件目录/包必须 `"type": "module"`（或入口用 `.mjs`）。
2. 后端全程 ESM（`backend/package.json` 有 `"type":"module"`）—— 插件加载器的 TLA 依赖这一点，**不要**把 `languages/index.ts` 改成 CJS。
3. 插件里的 tree-sitter 语法包是原生模块，安装时按平台下载 prebuild（无 prebuild 的包会现场编译，需要 make/g++）。

---

## 三、设计

### 3.1 三层解耦

现状是「一个语言」被抄了 7 份（`shared/types.ts` 的 `LangId`、后端 spec、前端 `MONACO_LANG`/`PROVIDER_LANGUAGES`/`SYMBOL_LANGUAGES`/`App.langForFile`/`share.fenceLang`、两处 CSS 色标）。只拆后端解决不了问题 —— 加一门语言仍要改前端源码并重建。所以拆三层：

```
L0 元数据层   声明式描述：id / 扩展名 / Monaco 语言 id / 颜色 / 能力位     → 通过 /api/languages 下发
L1 实现层     后端 spec（AST 提取规则）或行式扫描                        → 插件导出
L2 分发层     插件目录 / npm 包 / 内置预装                               → 加载器发现
```

### 3.2 插件契约与目录布局

**插件根目录**：`<DATA_DIR>/languages/`（`DATA_DIR` 默认 `~/.ide`，见 `backend/src/config.ts:20`）

```
~/.ide/languages/
  package.json              # {"type":"module","private":true}
  node_modules/             # `wcr lang add` 装的 npm 插件落这里
  wcr-lang-zig/             # 手放的本地插件（目录名随意）
    package.json            # {"type":"module","wcr":{"lang":"./index.ts"}}
    index.ts
```

**发现规则**（三条，顺序即优先级）：

| # | 位置 | 用途 |
|---|---|---|
| 1 | `<DATA_DIR>/languages/*/` 且 `package.json` 含 `wcr.lang` | 本地插件（手放） |
| 2 | `<DATA_DIR>/languages/node_modules/*/` 且含 `wcr.lang` | `wcr lang add` 装的 |
| 3 | 本仓库自身 `node_modules/*/` 且含 `wcr.lang` | 官方插件包（默认预装，P4 引入） |

后发现的同 id 语言**不覆盖**先前注册的（先到先得），并记一条 warning —— 这样「本地覆盖 npm」不符合直觉，改为**本地优先**：规则 1 先扫，注册时 `if (byId.has(id)) continue`。

**插件入口契约**（`@wcr/lang-sdk`，P3 建，随后内置语言包也依赖它）：

```ts
// 插件模块必须导出 plugin（或 default）
export interface LanguagePlugin {
  /** 可索引的语言实现。与 preview 至少有一个。 */
  spec?: LanguageSpec;
  /** 只着色的清单条目（文件名/扩展名 → 已有语言 id）。可选，用于 go.mod → go 这类。 */
  preview?: PreviewLanguage[];
  /** 元数据（前端用）。spec 存在时通常从 spec 上取，preview-only 插件在这里给。 */
  meta?: LanguageMeta;
}

export interface LanguageMeta {
  monaco?: string;                  // Monaco 语言 id；缺省 = id 同名；不在内置 81 种里就别写
  fence?: string;                   // Markdown 围栏语言标记；缺省 = monaco ?? id
  color?: string;                   // 文件树色点 / 语言分布色带（缺省用内置调色板轮转）
}
```

`LanguageSpec` 现有的语言相关分支要**下沉成字段**（否则插件语言静默退化，见 §4 清单 F 项）：
`commentPrefixes?: string[]`（替代 `resolver.ts:1242` 的 `COMMENT_PREFIXES` 表）、`signatureTypes?: string[]`（替代 `resolver.ts:1224` 的按 lang 分支）、`entryPatterns?`（替代 `insight.ts:197` 的 python/go/java 分支）。

### 3.3 加载时序与失败隔离

`backend/src/languages/index.ts` 结构改为：

```ts
const specs: LanguageSpec[] = [...BUILTIN_SPECS];       // 6 门核心，静态 import
const previews: PreviewLanguage[] = [...BUILTIN_PREVIEWS]; // 现有 manifests.ts 的表
const loadErrors: PluginLoadError[] = [];

if (PLUGINS_ENABLED) await loadLanguagePlugins({ specs, previews, loadErrors }); // 顶层 await

// 之后照旧构建 byExtension / byFilename / patterns 与 specForFile / specById / langForFile
export const LANGUAGE_SPECS: LanguageSpec[] = specs;
export function pluginStatus() { return { loaded: [...], errors: loadErrors }; }
```

- 逐个 `try { const m = await import(pathToFileURL(entry).href); ... } catch (e) { loadErrors.push(...); logWarn(...) }` —— **任何插件失败都不得抛出**（A3）。
- 加载器独立成 `backend/src/languages/loader.ts`，可被 server / worker / CLI 复用（三处都要能单独跑）。
- **worker 一致性**：`parse-worker.ts:38` 已经 `await import('../languages/index')`，保持这个写法；**禁止**在 worker 里改成静态内置列表。每个 worker 会各自加载一遍插件（成本可接受，写进风险）。
- 环境开关：`READER_PLUGINS=0` → 只加载规则 3（内置预装）；`READER_NO_PLUGINS=1` → 一个插件都不加载（排障用）。

### 3.4 语言元数据 API（L0）

`backend/src/api/routes.ts` 新增：

```
GET /api/languages
{
  "languages": [ { "id":"zig", "label":"Zig", "extensions":[".zig"], "filenames":[],
                   "monaco":"zig", "fence":"zig", "color":"#f7a41d",
                   "symbols":true, "refs":false, "indexed":true } ],
  "previews":  [ { "id":"gomod", "monaco":"go", "filenames":["go.mod","go.sum"] } ],
  "errors":    [ { "source":"~/.ide/languages/bad", "message":"..." } ]
}
```

`symbols` = 有符号索引（对应今天前端 `SYMBOL_LANGUAGES`），`refs` = 有引用能力（对应 `PROVIDER_LANGUAGES`）。这两个能力位由 spec 决定：`refs` ⇔ 该语言实现了 `resolveModule`/作用域引用提取中的至少一项（实施时在 loader 里推导，避免让插件作者手填）。

**前端**新增 `frontend/src/languages.ts`（单例）：
- `ensureLanguages()`：应用启动时 await 一次 `/api/languages`，把三张表建好（扩展名索引、文件名索引、模式索引）。
- 导出 `monacoLangFor(lang)` / `guessLangFor(file)` / `fenceLang(lang)` / `isRefLang(lang)` / `isSymbolLang(lang)` / `langColor(lang)`。
- 调用点替换（清单见 §4 G 项），删除 `monaco-setup.ts:57-116`、`App.tsx:124-261`、`share.ts:18-41` 的硬编码表。
- 失败兜底：请求失败时全部退 `plaintext` + 顶栏一条提示（**不保留旧表**，避免双份维护；本地工具场景下 API 必达）。

### 3.5 内置瘦身与默认预装

保留内置（`backend/src/languages/builtin/`）：`python`、`typescript`(+tsx/jsx/javascript)、`go`、`java`、`rust`。
拆出的官方插件包（`packages/`，npm workspaces）：

| 包 | 出哪些语言 id | 依赖的语法包 |
|---|---|---|
| `@wcr/lang-shell` | shell | tree-sitter-bash |
| `@wcr/lang-json` | json | tree-sitter-json |
| `@wcr/lang-yaml` | yaml | @tree-sitter-grammars/tree-sitter-yaml |
| `@wcr/lang-toml` | toml | @tree-sitter-grammars/tree-sitter-toml |
| `@wcr/lang-markdown` | markdown | @tree-sitter-grammars/tree-sitter-markdown |
| `@wcr/lang-css` | css / scss / less | tree-sitter-css（一个语法出三个 id，与现状一致） |
| `@wcr/lang-html` | html | tree-sitter-html |
| `@wcr/lang-ini` | ini / .env | 无（lineSymbols 行扫描） |
| `@wcr/lang-dockerfile` | dockerfile | 无（行扫描） |
| `@wcr/lang-sql` | sql | 无（行扫描） |
| `@wcr/lang-sdk` | —— | 契约类型 + `defineLanguage()` |
| `@wcr/lang-python`(等 6 个) | 核心语言 | 由 P6 决定是否也迁出（默认不迁，见风险 R6） |

**默认预装**：以上官方包全部列进根 `package.json` 的 `dependencies` → 装完行为与今天**完全一致**（A4 的对照基线）。用户 `wcr lang remove` 掉才是真瘦身。

**workspaces**：根 `package.json` 加 `"workspaces": ["backend", "frontend", "shared", "packages/*"]`。
副作用（必须一并处理）：根 `package.json` 的 `files` / `bin` / `prepack` 语义、`Dockerfile` 的 COPY 与 `npm run install:all`、`bin/wcr.mjs` 的 tsx 解析路径（`bin/wcr.mjs:32` 的 `paths` 兜底）。
**顺带收益**：现在「根 node_modules 与 backend/node_modules 重复装同一批包（实测约 134M）」会被 hoist 消掉。

### 3.6 CLI

`backend/src/cli.ts` 增加子命令分支（`argv[0] === 'lang'` 时交给 `backend/src/lang-cli.ts`）：

```
wcr lang list                                   # 已加载语言：来源 + 能力位 + 加载失败（表格式输出）
wcr lang add wcr-lang-zig                       # 在 <DATA_DIR>/languages 下 npm install 该包
wcr lang add D:/my/langs/wcr-lang-zig           # 本地目录：写进 languages/package.json 的 file: 依赖并 install
wcr lang remove zig                             # 从 languages/package.json 移除对应包 + npm prune
```

- 所有 add/remove 结束后**提示「重启服务后生效」**（不做热加载）。
- `list` 需要真跑一次加载器（起一次 `loader.ts`，不起 HTTP）。
- `bin/wcr.mjs` 无需改（它把参数原样透传给 `cli.ts`）；只需更新 `cli.ts:16` 的 USAGE 文案。

### 3.7 索引重建（加语言后必须重扫）

老快照里根本没有新扩展名的 `entries`，直接恢复会「看不到新语言文件」。

- `backend/src/indexer/snapshot.ts` 的 header 增加 `langSignature`：由「所有 spec 的 id + 扩展名」排序后 hash 得到（复用现有 `fingerprintEntries` 的思路）。
- `store.ts` 恢复快照时比对；不一致 → 丢弃快照走全量 `reindexAll()`（会重新 `readDir`，新扩展名自然进 `entries`）。
- 兼容老快照：缺 `langSignature` 字段视为不一致（即一次性全量重建，可接受）。
- 不递增 `SNAPSHOT_SCHEMA`（那个留给「文件级记录格式变化」）。

---

## 四、改动清单（按文件，含现有行号）

**A. 后端注册表与契约**
- `backend/src/languages/index.ts:22-77` → 拆为 `builtin/index.ts`（6 门核心）+ `registry.ts`（装配/查找）+ `loader.ts`（发现与加载，TLA 入口）。
- `backend/src/languages/walker.ts:78-131` → `LanguageSpec` 增 `monaco?/fence?/color?/commentPrefixes?/signatureTypes?/entryPatterns?`；`lineSymbols`/`grammar` 的既有语义不动。
- 新增 `packages/lang-sdk/`（`LanguagePlugin`、`LanguageMeta`、`defineLanguage()`）。
- `backend/src/languages/manifests.ts:25` → `PREVIEW_LANGUAGES` 变成可追加的数组（内置 + 插件 `preview`）。
- `backend/src/api/routes.ts` → 新增 `GET /api/languages`（放在现有只读端点附近，如 `routes.ts:583` 前）。
- `backend/src/config.ts:20` 附近 → 新增 `PLUGINS_DIR`（`<DATA_DIR>/languages`）、`PLUGINS_ENABLED`。

**B. 内置语言迁出**（P4）
- `backend/src/languages/{shell,json,yaml,toml,markdown,css,html,ini,dockerfile,sql}.ts` → 迁进对应 `packages/lang-*/src/index.ts`；把 spec 包成 `{ spec, meta }` 导出。
- 删除这些文件在 `languages/index.ts` 的静态 import。

**C. 语言分支下沉为字段**（否则插件语言静默退化）
- `backend/src/indexer/resolver.ts:1242-1257` `COMMENT_PREFIXES` → 读 `spec.commentPrefixes`。
- `backend/src/indexer/resolver.ts:1224-1233` `signatureTypes()` → 读 `spec.signatureTypes`。
- `backend/src/indexer/walker.ts:248` `lang === 'python'` → 用 spec 字段（如 `signatureTerminator` 或复用 `signatureTypes`）。
- `backend/src/indexer/insight.ts:197-203` 入口判定 `fi.lang === 'python'|'go'|'java'` → 读 `spec.entryPatterns`。
- `backend/src/indexer/insight.ts:113-127` `DOC_EXT_RE`/`DOC_BASE_RE`/`isDocOrConfig` → 保留（文档/配置是**跨语言**概念，不属于语言插件）；但要让插件能声明「我的扩展名算不算 doc」，通过 `meta.doc?: boolean`。
- `backend/src/indexer/insight.ts:946-952` `META_KINDS`（marker 文件）→ 保留 + 可被插件 `meta.projectMarkers` 追加。

**D. worker**
- `backend/src/indexer/parse-worker.ts:38` 保持动态 import `../languages/index`；补一条注释说明「这里必须走注册表，不能写死内置列表」。

**E. 快照**
- `backend/src/indexer/snapshot.ts:38` 附近加 `langSignature` 计算与写入；`store.ts` 恢复路径加比对（恢复失败即全量重建）。

**F. CLI**
- `backend/src/cli.ts:16`（USAGE）、`:48`（parseArgs 支持子命令）、新增 `backend/src/lang-cli.ts`。

**G. 前端去硬编码**
- `frontend/src/monaco-setup.ts:57-93` `MONACO_LANG`/`monacoLangFor` → 改为 `languages.ts` 提供（保留 `monacoLangFor` 的导出名，调用点不动）。
- `frontend/src/monaco-setup.ts:96` `PROVIDER_LANGUAGES` → `isRefLang(lang)` 动态判断；`:624`、`:701`、`:793` 的注册循环改用「对任意语言注册一个 provider，内部查 isRefLang/isSymbolLang 提前返回」——**这一步要注意 Monaco 要求注册时给具体语言 id**，故改为：注册时遍历 `/api/languages` 的 id 列表（启动后注册，语言元数据先到后注册）。`:102` `SYMBOL_LANGUAGES` 同理。
- `frontend/src/App.tsx:124-167` `LANGS_BY_NAME`、`:170` `REQUIREMENTS_RE`、`:176-261` `langForFile` → 删除，改用 `languages.ts` 的 `guessLangFor`。
- `frontend/src/share.ts:18-41` `fenceLang` → 改查元数据（`report.ts:92-94` 自动跟随）。
- `frontend/src/styles.css:842-880` 的 31 个 `.lang-*`、`frontend/src/overview.css:220-239` 的 `[data-lang=…]` → 改为内联 `style={{ '--lang-color': langColor(lang) }}`，CSS 保留调色板变量与 `.lang-dot` 的几何样式。
- `frontend/src/Overview.tsx:563-593` 语言分布：`{l.lang}` 改为显示 `label`（元数据里的 `label`，缺省用 id）。
- `frontend/src/Editor.tsx:97`、`snapshot.ts:167`、`state.ts:581` 无需改（都通过 `monacoLangFor`）。

**H. 测试**
- 新增 `backend/tests/plugins.test.ts`：临时插件目录 + 一个 lineSymbols 插件（不依赖语法包，跑得快）→ 断言注册、索引、失败隔离、`READER_PLUGINS=0` 时回退。
- 新增 `backend/tests/languages-api.test.ts`：`/api/languages` 结构与 previews。
- 改造脆弱断言（P4 落地即红的）：`backend/tests/plainfiles.test.ts:90-105,113,266-275`（12 个语言迁出）、`backend/tests/manifests.test.ts:38-76`、`backend/tests/parse-pool.test.ts:14-17,75`、`backend/tests/insight.test.ts:48-54`（若 JSON 等不再计入，需重算分母）、`backend/tests/map-acceptance.test.ts:41-57`。
- 忠实迁移：`python.test.ts`/`typescript.test.ts`/`go.test.ts`/`java.test.ts`/`rust.test.ts`/`highlight.test.ts`/`density.test.ts` 走内置 6 门，**不改**。

---

## 五、分阶段实施（每阶段独立验证）

### P0 冒烟：确认插件在「项目外目录」也能被 tsx 加载
- 实验：在 `%TEMP%/wcr-plug-smoke/` 放 `package.json {"type":"module"}` + `index.ts`，从仓库内用 `file://` 绝对路径动态 import。顺带在 worker 里试一次。
- **verify**：两条命令均打印出插件导出。
- 失败则整个方案降级为「插件必须放在仓库内」（需回头找用户重议）。

### P1 后端注册表重构 + 能力位 + `/api/languages`（行为不变）
- 做 §4 的 A、C 项（C 先做，避免后面插件语言退化）；此时**还没有插件加载器**。
- **verify**：`npm --prefix backend test` 全绿；`npm run typecheck` 通过；`curl /api/languages` 返回 20 个可索引语言 + 10 个 preview，能力位与今天的 6 门 refs 语言一致。

### P2 前端消费元数据（行为不变）
- 做 §4 的 G 项。
- **verify**：手工回归 —— 打开 py/ts/go/json/md/sql 文件：高亮、大纲、F12、Shift+F12、分享围栏、语言分布色带、文件树色点，全部与改动前一致；`npm run build` 通过（dist 体积不应变化）。

### P3 插件加载器（核心）
- 做 §4 的 A（loader）、D、H（plugins 测试）。
- **verify**：A1/A2/A3 三条验收点逐条实测（用一个真实语言更佳，如 `tree-sitter-zig`，顺带验证原生语法包在插件位置可用）。

### P4 内置瘦身：拆 12 个语言为 workspace 包
- 做 §4 的 B + 根 `package.json` workspaces + Dockerfile + `files` 字段 + H 的脆弱断言改造。
- **verify**：A4 —— 全新 `npm install` 后跑全量测试 + 手工抽查「默认行为与 P3 结束时逐项一致」；`npm pack` 产物仍能 `npx wcr` 起服务。

### P5 CLI
- 做 §4 的 F。
- **verify**：A7 —— `wcr lang add tree-sitter-zig 的封装包` → 重启 → 语言生效；`list` 显示来源；`remove` 后重启语言消失。

### P6 收尾
- 快照 `langSignature`（§4 E，若 P3 已顺手加则此处只补老快照兼容）→ A5 验证。
- 文档：`README.md`（语言清单与「加语言」小节）、`docs/07-*` 补「如何写一个语言插件」教程（含 SDK 用法与 tree-sitter 包选型两条硬条件：ABI ≥ 14、优先 `@tree-sitter-grammars`）。
- 设置页显示插件状态（读取 `/api/languages` 的 errors，可选）。
- 沉淀记忆：`.xchen/memory/`。

---

## 六、测试与回归策略

- **单测**：plugins / languages-api（新增）；改造后的脆弱断言从注册表推导（例如断言 `specForFile('.sql')?.id === 'sql'` 而非断言总数）。
- **全量**：`npm --prefix backend test`（41 个文件）、`npm --prefix frontend run test`、`npm run typecheck`、`npm run build`。
- **手工回归表**（P2/P4 各跑一次）：py / tsx / go / java / rust / sh / json / yaml / toml / ini / dockerfile / md / css / html / sql 各开一个文件，检查：色点、高亮、大纲、可跳转、悬停、密度条、分享围栏。
- **性能**：P4 后跑 `npm --prefix backend run bench`，确认索引耗时不因「worker 各自加载插件」而退化。

---

## 七、风险与未决点

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 插件在项目外目录的 tsx 加载（P0 未过） | P0 优先验证；不过则降级方案需用户重议 |
| R2 | 引入 workspaces 影响 `npm pack`/Dockerfile/`bin/wcr.mjs` | P4 单独一段，先本地验证 `npx wcr` 与 `docker build`；出问题退回 `file:` 依赖或把包放 `backend/plugins/` |
| R3 | 插件是任意代码执行 | `READER_NO_PLUGINS=1` 开关 + 文档写明「只装可信来源」；`HOST=0.0.0.0` 共享模式下插件对所有访问者生效 |
| R4 | 每个 parse worker 各加载一遍插件（N 倍成本） | 插件很小；bench 里确认；必要时把 worker 数调小 |
| R5 | Monaco 非内置语言（Haskell/Zig 等）没有高亮 | 已确认不接受运行时 Monarch；文档里明说「只高亮 Monaco 内置 81 种」，其余退 plaintext 但索引/大纲照常可用 |
| R6 | 核心 6 门也迁出会更彻底但风险大 | 本方案不迁；留作后续可选（若要迁，P4 的模式可复用） |
| R7 | 前端元数据未到位时的首屏 | 启动 await 一次（本地工具必达）；失败则 plaintext + 顶栏提示 |
| R8 | 语言分支下沉（C 项）会改动解析语义 | 用现有测试兜底；`SNAPSHOT_SCHEMA` 不动，但 C 项若改变了解析结果，需按 §3.7 触发一次重建 |

---

## 八、实施进度（2026-10-04）

| 阶段 | 状态 | 证据 |
|---|---|---|
| P0 冒烟（项目外插件加载） | ✅ | 主线程 + worker 均通过（相对/绝对路径 `.ts`、`.mjs`、`node_modules` 内 TS 包四种形态） |
| P1 后端注册表 + 能力位 + `/api/languages` | ✅ | 语言分支（`COMMENT_PREFIXES` / `signatureTypes` / `entryPatterns` / `signatureColon`）已下沉为 spec 字段；backend 125 测试通过 |
| P2 前端消费元数据 | ✅ | 新增 `frontend/src/languages.ts`；删掉 `MONACO_LANG` / `PROVIDER_LANGUAGES` / `SYMBOL_LANGUAGES` / `App.langForFile` / `share.fenceLang` 与两处 CSS 色表；typecheck + 前端 56 测试通过 |
| P3 插件加载器 | ✅ | `languages/loader.ts` + `plugin.ts`；`plugins.test.ts`（4 例）+ `plugins-off.test.ts`（1 例）；端到端实测全通过 |
| P5 CLI | ✅ | `wcr lang list / add / remove`（`backend/src/lang-cli.ts`） |
| P6 快照 `langSignature` | ✅ | 装 / 卸语言包后自动全量重建（`snapshot.languageSignatureOf`） |
| P4 12 门语言拆 workspace 包 | ⏸ 待定 | 见下「P4 的两个方案」——需先定插件包的类型共享方式 |
| P7 全功能标准 + 前端高亮 + 脚手架 + C/C++ 样例 | ✅ | 新增 `docs/08-language-plugin-spec.md`（C1–C10 标准）；插件可自带 Monarch 并由前端运行时注册；`wcr lang new / link`；C/C++ 插件（独立仓库）十项全通 |

### 实测记录（端到端）

隔离的插件目录（`tmp/langdir`：一个好插件 `wcr-lang-demo` + 一个坏插件 `wcr-lang-broken`），
起服务（`PORT=8899`）后跑 `tmp/p3verify.mjs`，11 项全部通过：

- 插件语言进 `/api/languages`，`monaco` / `color` 元数据生效（`{id:'demolang', monaco:'go', color:'#ff8800'}`）；
- 坏插件只进 `errors`，不影响服务与好插件；
- 真索引：`.demo` 文件进文件树且 `lang=demolang`，`document-symbols` 取到插件声明的符号（`alpha` / `beta`）。

### P4 的两个方案（需拍板）

拆包的难点只有一处：**插件包要能拿到 `LanguageSpec` 类型**。两条路：

1. **类型留在 backend，插件包相对路径引用**（`import type { LanguageSpec } from '../../../backend/src/indexer/walker'`）：
   改动最小、类型唯一来源；代价是这些包**只能在本仓库内用**，不能发布给别人装。
2. **抽出 `wcr-lang-sdk`**：把 `LanguageSpec` / `ScopeRule` / `LineSymbol` 等类型搬进 sdk，backend 从 sdk
   重新导出。类型体验与可发布性最好；代价是要处理 `WalkContext`（运行时类）与类型的分层，改动面大于方案 1。

只有方案 2 能兑现「同事 `npm i wcr-lang-xxx` 就能用」，也就是当初「拆成一个个单独的包」的本意。

### P7 实测记录（C/C++ 参考插件，2026-10-04）

插件位于**独立仓库** `D:/01_code/02_work_code/wcr-lang-cpp`（一个包出 C 与 C++ 两门语言），
以 `wcr lang link` 接入。验收（`tmp/cppverify.mjs` + `tmp/cppui.mjs`）：

| 能力 | 实测结果 |
|---|---|
| C1 高亮 | 范围 A：C/C++ → Monaco 内置 `cpp`（Monaco 无独立 `c`）；范围 B：自带 Monarch 的示例语言在运行时注册后着色成功 |
| C2 色点 | C `#555555` / C++ `#f34b7d`；`.c/.h` → c、`.cpp/.hpp` → cpp 识别正确 |
| C3 大纲 | util.h → `add, mul`；Widget.hpp → `demo(命名空间) / Widget(类) / id / id_ / twice` |
| C4 符号搜索 | `Ctrl+T` 搜 `twice` 命中 |
| C5 跳转 | `main.c` 的 `add` → `include/util.h:5`；`cpp/main.cpp` 的 `demo::twice` → `cpp/Widget.hpp:14`（跨文件 + 命名空间） |
| C6 引用 | util.h 的 `add` 引用含 `src/main.c`、`include/util.h` |
| C7 Hover | 悬停 `add` → resolved，definitions=[add] |
| C8 失败解释 | `printf` → `external`（不是含糊的 unresolved） |
| C9 密度条 | util.h 认出注释段（commentPrefixes 生效） |
| C10 签名 | `int add(int a, int b)` 压平为一行 |

回归：后端 125/125、前端 56/56、UI 24/24；前端重建后 UI 高亮验收 3/3。

## 九、不做的事

- 不做插件热加载（坚持「重启生效」，符合用户预期且实现简单）。
- 不做 Monaco 运行时 Monarch 注入（用户已确认不需要）。
- 不做插件沙箱/权限模型。
- 不把「包依赖清单语言」（xml/gomod/groovy/kotlin/scala/ruby/elixir/swift/pip/makefile）插件化 —— 它们本质是 `文件名 → Monaco 语法` 的着色别名表，留在核心 `manifests.ts`，只开放插件追加 `preview` 条目。
- 不动 `frontend/dist` 的打包方式（Monaco 全量语言已在 bundle 内，这是「加语言不用重建前端」的前提，别去优化它）。
