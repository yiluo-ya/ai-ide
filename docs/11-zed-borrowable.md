# 11 · 从 Zed 借什么（机制清单与判定）

> 2026-10-11。分析对象：本机 `D:/01_code/02_work_code/community/zed`（Rust，249 crates，
> HEAD `93d7456`，2026-10-10）。**读完的结论：不是「把它的技术搬过来」，而是「逐条判定借它的机制」**——
> 它与本项目的定位不同（原生编辑器 vs 浏览器阅读器），能借的是它在「庞大代码库上做增量、可交互的
> 代码理解」这一层的工程解法。
>
> 本文同时是**判定记录**：每条都给出「做 / 不做」与理由，避免以后再重复讨论。

## 一、判定总表

| # | Zed 的做法（证据在本仓的 `crates/` 下） | 本项目现状 | 判定 |
|---|---|---|---|
| 1 | worktree：不可变快照 + `scan_id/completed_scan_id` + 批量增量条目集，watcher 事件 drain 成批（`worktree/src/worktree.rs:201` `:4067` `:4639`） | watcher 已 300ms 防抖合并，但 **flush 时逐文件 emit**；`indexVersion` 存在却不进事件 | **做**（只取「按批 + 标来源」两项） |
| 2 | 搜索结果可浏览、第 k 个命中 O(log n)（`multi_buffer` 的 Excerpt + `SumTree`；`project/src/project_search.rs:257`） | 结果流式到达，但**没有「上/下一个命中」**，也没有序号 | **做**（命中导航；不做 excerpt 化） |
| 3 | 自适应批量：flush 间隔按条目数 ilog2 拉长（20ms→300ms 封顶，`project/src/project_search.rs:1107` `:1138`） | 搜索 chunk 每文件写一次 SSE，前端每条 chunk 重渲染一次 | **做** |
| 4 | 模糊匹配三维：basename 加成、路径长度惩罚、与当前文件的路径距离（`fuzzy_nucleo/src/paths.rs:180-218`） | QuickOpen 只有五档定值，不看路径深浅、不看当前文件、recent 不参与打分 | **做** |
| 5 | diff 结构化：hunk 作为可求和的 Item，「第 N 行属于哪个 hunk」O(log n)（`buffer_diff/src/buffer_diff.rs:157` `:216`） | DiffPanel 只按行首字符归类，无 hunk 对象、无跳转 | **做**（结构化 + 跳转，渲染方式不变） |
| 6 | 设置：注册式 + 多层 merge + **载入期迁移**（`settings_macros/src/settings_macros.rs:22-152`、`migrator/src/migrations.rs:7`） | prefs 有默认值合并，但**无版本号、无迁移** | **做**（版本 + 迁移链） |
| 7 | 编辑后只重解析脏区、同步预算 1ms、超时转后台并 emit `Reparsed` 让 UI 补拉（`language/src/buffer.rs:1177` `:2034`） | 打开文件时全文解析；已有 `index-ready` → 补拉高亮的等价机制 | **暂不做**（见 §三.2） |
| 8 | 语言能力按层声明、取数收成单一入口（`language_core/src/queries.rs:9-30`、`editor/src/document_symbols.rs:26`） | `frontend/src/languages.ts` 已是唯一入口（`isRefLang` / `symbolLanguageList`…） | **不做**（已达成） |
| 9 | 插件：WASM 沙箱 + manifest 声明 × 用户授予双重校验 + 私有 work dir + 路径逃逸检查（`extension_host/src/capability_granter.rs:23-47`、`wasm_host.rs:742-816`） | 插件是**用户自己装的本地 Node 包**（`~/.ide/languages`），不是从网上拉的第三方产物 | **不做**（攻击面不同，权限系统属过度设计） |
| 10 | Agent 上下文：outline 扩边 → 合并重叠区间 → BM25 / git log 补充（`edit_prediction_context/src/assemble_excerpts.rs:9-84`） | 内置 agent 已有自己的上下文构造 | **不做**（本轮范围外，见 §三.4） |
| 11 | 自研 `rope`（128B 定长块文本模型）+ `sum_tree` 作通用增量结构 | 后端只「读一次 → 解析 → 落索引」；前端 Monaco 自带文本模型与增量 tokenization | **不做**（见 §三.1） |
| 12 | 主题：捕获名编译成数字索引 + 用户覆盖单向 merge + 层级回退（`syntax_theme/src/syntax_theme.rs:16` `:105`） | CSS 变量三档（`--hl-*`）+ `HL_BY_KIND` 已是等价效果 | **不做** |
| 13 | `clippy.toml` 用编译期禁止项固化约定（禁 `std::process` 等，`clippy.toml:8-19`） | 用 eslint；本轮没有新增进程调用面 | **不做**（等真有需要再加） |

## 二、本轮（11 号）已落地

| 落地项 | 改了什么 | 验收 |
|---|---|---|
| **事件按批 + 标来源** | `shared/types.ts` 的 `IndexEvent` 由「逐文件 `file-changed`/`file-deleted`」改为 `changes{origin, version, changes[]}`；`backend/src/indexer/store.ts` 加 30ms 合并窗口（`recordChange`/`flushChanges`）与 `withOrigin`；`api/routes.ts` 的写接口（新建/改名/移动/复制/删除）包 `withOrigin('api')`；前端 `state.ts` 按 `origin` 短路「自己的操作」，`mapState.ts` 打脉冲 | 改名打开中的文件不再被自己的删除事件清空（FR-0009 的根因修复）；一次 `git checkout` 前端只刷一次树 |
| **命中导航** | `state.ts` 新增 `flatSearchHits` / `searchCursor` / `stepSearchHit`；`App.tsx` 绑 `F3` / `Shift+F3`；搜索面板与 `FileSearch` 共用游标并显示「第 k / 共 n 处」 | 面板单测 + UI 冒烟 |
| **搜索批量化** | 后端 `search-stream` 每 ~60ms 合并一次 chunk；前端 `runSearch` 100ms 渲染节流、结束时 `flushNow` | 后端搜索流测试（chunk 累加等于总数） |
| **QuickOpen 打分** | `QuickOpen.tsx`：档位分 + basename 命中 / 邻近（同目录、共享前缀）/ recent 加成 − 深度惩罚；同分按字典序；公式不变量写进注释与单测（正修正之和 < 最小档距，精确匹配永远压过吃满加成的非精确候选） | `frontend/src/QuickOpen.test.ts` 16 例 |
| **Diff hunk 跳转** | 新增 `frontend/src/diffHunks.ts`（`parseDiffHunks` / `stepHunk`）；`DiffPanel.tsx` 加「第 k / 共 n 处变更」与上一处/下一处（F3 / Shift+F3，面板内生效） | `frontend/src/diffHunks.test.ts` 11 例 |
| **prefs 迁移** | `prefs.ts`：`PREFS_VERSION` + `MIGRATIONS` 迁移链 + 坏数据兜底 + 回写失败静默；「加一条迁移 + 版本加一」的纪律写进注释 | `frontend/src/prefs.test.ts` 迁移 6 例 |

## 三、明确不做的，以及为什么

1. **换内核（Rust `rope`/`sum_tree`，或整体重写后端）**：`rope` 的价值是「进程内可变文本的编辑增量」，
   而本项目的文本模型在浏览器（Monaco 自带），后端只做一次性解析；数据要跨进程 + 跨 HTTP，
   O(log n) 在序列化边界直接失效。成本是月级（索引 store、语言 spec、插件契约、agent、打包、全部端点），
   `sum_tree` 里真正可借的「前缀和 + 二分」在 JS 里用 Fenwick / 累积数组 1–2 天即可，收益 90%。
2. **tree-sitter 增量解析**：值得做，但它是**独立一件事**（要有「编辑 → 重解析」的调用面才会兑现），
   与本轮「事件 / 检索 / 设置」不同域。要做时按这个口径验收：改 2000 行文件的一行，
   重解析耗时与索引 diff 范围从 O(文件) 降到 O(脏区)，且后端同步解析开销 <5ms、超出转后台并推事件。
3. **语言能力来源标签（syntax / lsp / builtin）**：当前仓库没有 LSP 实现，标签没有消费方；
   唯一入口 `languages.ts` 已经收敛。等真要接 LSP 时再加（那时它会立刻有用）。
4. **Agent 上下文摘录（assemble_excerpts）**：需要先定「给模型看哪几段」的产品口径；
   现在做等于替未来猜参数。
5. **插件沙箱与权限系统**：插件是用户自己放进 `~/.ide/languages` 的本地包，
   与 zed 面对的「从市场下载第三方 WASM」不是同一个信任模型。

## 四、Zed 侧证据索引（想要细节时按图索骥）

- 快照与增量：`crates/worktree/src/worktree.rs:201`（scan_id）、`:4067`（UpdatedEntriesSet）、`:4639`（drain 成批）、`crates/worktree/src/ignore.rs:85-150`（目录命中即剪枝）
- 通用增量结构：`crates/sum_tree/src/sum_tree.rs:34-59`（Item/Summary/Dimension）、`:642-676`（增量重算 summary）
- 语义着色：`crates/language/src/buffer.rs:1177`（1ms 预算）、`:2034`（Reparsed）、`crates/syntax_theme/src/syntax_theme.rs:16`（捕获名索引）
- 搜索：`crates/project/src/project_search.rs:170`（4 条任务流水线）、`:1107-1138`（AdaptiveBatcher）、`:1022`（反 glob 剪枝）、`crates/search/src/project_search.rs:257`（Excerpt + match_ranges）
- 模糊匹配：`crates/fuzzy_nucleo/src/paths.rs:180-218`、`crates/file_finder/src/file_finder.rs:130`（recent 优先于搜索）
- diff / blame：`crates/buffer_diff/src/buffer_diff.rs:157` `:216`、`crates/editor/src/git/blame.rs:36-56`
- 设置与插件：`crates/settings_macros/src/settings_macros.rs:22-152`、`crates/migrator/src/migrations.rs:7`、`crates/extension_host/src/capability_granter.rs:23-47`、`:742-816`（work dir 逃逸检查）
- 工程化：`CLAUDE.md`/`AGENTS.md`、`clippy.toml:8-19`、`docs/src/development/feature-process.md`（四步立项：为什么做 / 是什么 / 影响谁 / 发布）
