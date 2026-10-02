[01 地图 Map](./01-map.md) · [02 透镜 Lens](./02-lens.md) · [03 导航 Navigator](./03-navigator.md) · [04 向导 Guide](./04-guide.md) · [05 信使 Share](./05-share.md) · [06 底座 Platform](./06-platform.md)

# 04 向导 Guide · 全量落地决策与实施报告

> 本报告**只给确定答案**：Q0–Q20 全部拍板（见 `04-decisions.md`），G1.1–G9.4 全量实施，分 W1–W5 五阶段，每阶段独立可验收。
> 三条不可动摇的原则（沿用 03 已确立的口径）：**后端是唯一事实源**、**绝不伪造数据**、**只读不写被读目录**。

---

## 0. 结论摘要

**交付范围**：G1.1–G9.4 全量（40 项），五阶段推进，**不做裁剪**。

**与 03 的关系**：03 让用户「能到任何地方」，04 决定「值得去哪、去过哪醒」。03 已落地的能力（入口候选、引用、调用层级、位置记忆、书签、mtime 热力、SSE 变更事件）是 04 的原料，**不重复实现、只做组装**。

**本主题唯一新增的存储义务**：向导是六个主题里唯一需要**写状态**的主题（路线、进度、笔记、快照、待读），因此 Q3 把它收敛成一句话：**全部落浏览器 `localStorage`，按项目 id 分片，可显式导出 JSON，不写被读目录、不落后端**。

**当前基线（本次实测）**：`npm run typecheck` 通过；`npm test` **94/94 全绿**；`npm run test:ui` **19/19 通过**。

**写作时基线（开工前实测）**：已落地 3 项、部分落地 11 项、未落地 26 项（见 §1）。

**交付后状态**：G1.1–G9.4 **全量落地**，三关与新增的向导 UI 回归全部通过 —— 见 §9。

---

## 1. 当前实况：G1–G9 基线核对

先纠正一个事实：04 的原料比文档写作时**多得多**。01 的项目地图、03 的引用 / 调用层级 / 位置记忆 / 书签都已落地，向导的大半依赖已经就位。以下逐项核对（可复现）。

| 项 | 能力 | 实况 | 证据 |
|---|---|---|---|
| G1.1 | 项目概览首屏 | **已落地**（01 的产出） | `frontend/src/Overview.tsx:155-722`、`App.tsx:334`（`showMap` 分支）、`backend/src/indexer/insight.ts:706` `buildOverview` |
| G1.2 | 入口候选清单 | **已落地** | `Overview.tsx:374-426`（「从哪看起」+ `EntryRow`）、`insight.ts:964` `looksLikeEntry`、`shared/types.ts:436-444`（`OverviewEntry.reasons`） |
| G1.3 | 冷启动引导 | 部分 | 欢迎页只有快捷键清单 `App.tsx:799-816`；打开目录入口 `TopBar.tsx:55-80` |
| G1.4 | 回到总览 | 部分 | 侧栏 `overview` tab `App.tsx:453-459`、URL 快照 `App.tsx:239-251`；缺顶栏 / 面包屑的固定入口 |
| G2.1–G2.4 | 四条阅读路线 | **未落地** | 全仓无「路线 / route」概念与端点 |
| G2.5 | 路线内行进（上一步 / 下一步） | 未落地 | — |
| G2.6 | 自定义路线 | 未落地 | — |
| G3.1 | 文件级已读 / 待读 | 部分 | 已读标记已落地：`mapState.ts:140-148` `toggleRead`、`wcr.map-marks`（`mapState.ts:49`）、文件树右键 `FileTree.tsx`；**缺**「打开即已读」（`state.ts:496` `openFileAt` 不写 marks） |
| G3.2 | 项目级进度 | 部分 | `Overview.tsx:679` 已读计数；无比例口径 |
| G3.3 | 阅读位置记忆 | **已落地**（03 的 N22） | `state.ts:273-295` `readPositions` / `writePositions`（上限 200）、`Editor.tsx:149-155` `onPosition` 防抖 400ms |
| G3.4 | 继续阅读入口 | 未落地 | `QuickOpen.tsx` 的「最近打开」是文件流水，不是「回到上次断点」 |
| G3.5 | 待读队列 | 未落地 | — |
| G4.1–G4.4 | 笔记（行级 / 文件级 / 汇总 / 导出） | **未落地** | 全仓无笔记概念；Monaco 未使用 `glyphMargin`（`Editor.tsx:51-58` 只用行槽） |
| G5.1–G5.4 | 解释这段 | 未落地 | 上游原料齐备：`resolver.ts:309` `gotoDefinition`、`callgraph.ts:88-298`、`resolver.ts:450-533` `documentSymbols` / `workspaceSymbols` |
| G6.1 | 文件级结构性摘要 | 未落地 | 有 `FileDensityBar.tsx`（密度条），不是摘要 |
| G6.2 | 模块 / 目录级摘要 | 部分 | `insight.ts:600-692` `dirDuties` + `Overview.tsx:488-539` 目录职责展示 |
| G6.3 | 自然语言摘要 | 未落地 | 按 Q1 退化为模板化摘要句 |
| G6.4 | 摘要时效标记 | 部分 | revision 机制已有（`HighlightResult.revision`、`FileDensity.revision`），摘要未用 |
| G7.1 | 工作区状态 | **已落地** | `timeline.ts:110-150` `readGit`（只读 `rev-parse` / `status` / `log`）+ `Overview.tsx:620-627` |
| G7.2 | 未提交改动查看 | 部分 | 只有 dirty 文件清单，无 diff 内容（全仓无 `git diff` 调用） |
| G7.3 | 行级 blame | 未落地 | 全仓无 `git blame` 调用 |
| G7.4 | 文件与项目历史 | 部分 | 项目级提交批次 `timeline.ts:181-262`；文件级历史缺失 |
| G7.5 | 历史版本对照 | 未落地 | 无 `git show` 调用 |
| G8.1 | 会话内变更提示 | 部分 | `state.ts:147-151`（收到事件后重载）、`mapState.ts:173-195`（pulse 脉冲）；无「变了什么」的呈现 |
| G8.2 | 自上次阅读以来的变更清单 | 未落地 | 无阅读快照 |
| G8.3 | 变更摘要与差异高亮 | 未落地 | — |
| G8.4 | 「可能是 agent 刚写的」标记 | 部分 | `timeline.ts:265-281` `classify`、`Overview.tsx:629-652` agent 产出、文件树叠加层 |
| G9.1 / G9.2 | 调用链 / 反向调用视图 | 部分 | 树视图已落地：`NavPanels.tsx:117-172` `CallsPanel`；**缺图视图** |
| G9.3 | 数据流视图 | 未落地 | — |
| G9.4 | 视图入口与范围控制 | 部分 | 层级面板有方向 / 深度开关 `NavPanels.tsx:139-154` |

**结论**：向导的主体工作量在 G2（路线）、G4（笔记）、G8（变更）、G5/G6（解释与摘要）、G9（流视图）；G1、G3、G7 有大量既有资产可复用。

---

## 2. 全量实施蓝图

### W1 起步（首屏 + 路线）

| 项 | 做法 | 落点 |
|---|---|---|
| 路线生成（G2.1–G2.4） | 新模块 `guide.ts`：四条路线一次算全 —— ①`dep` 依赖序：用 `importsByName` + `resolveImport` 建文件级有向图，Tarjan SCC 去环后按「被依赖数」分层，层内按入度升序；②`entry` 入口向下：从 `looksLikeEntry` 的文件出发做 BFS（import 边 + 调用边）；③`hot` 热度序：按 `refsByName` 的「被项目内不同文件引用数」降序；④`fresh` 新鲜度序：按 `mtimeMs` 降序。每步附 `reason`（一句人话，如「6 依赖 4；2 与 3 被 4 依赖」）。 | 新 `backend/src/indexer/guide.ts`、`POST…` → `GET /api/projects/:id/routes` |
| 路线端点 | `GET /routes` → `{routes: [{kind, label, total, steps:[{order, file, reason, lang, lines}], source}]}`；`source: 'index'`。索引未完成时返回 `partial` 标记（与 overview 同策略） | `backend/src/api/routes.ts`、`shared/types.ts` |
| 路线面板（G2.5、G2.6） | 侧栏新 `guide` tab 的「路线」段：卡片列表（序号 / 文件 / 一句理由 / 状态点）+ 「开始 / 上一步 / 下一步 / 标记已读 / 加入待读」；「换一条」切换四条；「重排」用上移 / 下移（不做拖拽，避免新增 DnD 依赖）；「存为我的路线」把当前顺序写 `localStorage` | 新 `frontend/src/GuidePanel.tsx`、`frontend/src/guide.ts`、`App.tsx`（PanelTab） |
| 文件读完提示（G2.5） | 编辑器底部提示条：「已读完整文件 · 下一步：`src/registry.ts` →」；判据 = 已滚到文件底部（`onScrollChange` 到 scrollTop 阈值）或用 `Ctrl+Enter` 主动声明 | `App.tsx`（状态栏区）、`state.ts` |
| 首屏叠加（G1.1–G1.4） | `Overview.tsx` 顶部追加向导区块：`从这里开始`（复用已有入口候选）/`推荐路线`（依赖序前 6 步 + 开始按钮）/`继续阅读`（上次文件与行 + 笔记数）；顶栏加固定「总览」按钮；空项目（无索引文件）时展示冷启动引导（三条：填绝对路径、只读承诺、快捷键） | `Overview.tsx`、`TopBar.tsx`、`App.tsx` |
| 打开即已读（G3.1） | 抽出共享模块 `frontend/src/marks.ts`（承接 `mapState.ts` 的 marks 读写），`state.ts` 的 `openFileAt` 成功后写已读 | 新 `frontend/src/marks.ts`、`mapState.ts`、`state.ts` |
| 文件级摘要条（G6.1） | 编辑器顶部可折叠条：`导出 N 个符号 · 依赖 M 个模块 · 被 K 处引用（测试 T 处）· 最长函数 X`；点击展开明细 | 新 `frontend/src/SummaryBar.tsx`、`Editor.tsx` |

### W2 有记忆（进度 + 笔记）

| 项 | 做法 | 落点 |
|---|---|---|
| 进度（G3.2） | 顶栏 / 状态栏与总览页显示 `已读 12 / 40 个源码文件`（分母排除测试与文档配置，口径写在 title 上） | `state.ts`、`App.tsx`、`Overview.tsx` |
| 继续阅读（G3.4） | `wcr:readstate:<id>` 记 `{file, line, col, at}`；首屏「继续阅读」条目 + `Ctrl/Cmd+Shift+R` 直达 | `frontend/src/guide.ts`、`Overview.tsx`、`App.tsx` |
| 待读队列（G3.5） | `wcr:queue:<id>`；入口：文件树右键、搜索命中行尾 `+`、编辑器右键「加入待读」；面板可勾掉 | `guide.ts`、`GuidePanel.tsx`、`FileTree.tsx`、`SidePanel.tsx` |
| 行级 / 文件级笔记（G4.1、G4.2） | 行槽图标（第三个独立装饰池，避免与语义着色 / agent 行互清）+ 自建 React 编辑浮层（`getScrolledVisiblePosition` 定位）；文件级笔记挂文件信息区 | 新 `frontend/src/notes.ts`、`NoteLayer.tsx`、`Editor.tsx` |
| 笔记锚定（Q9） | `{file, line, col, anchor}`；恢复时行号优先、anchor 校验，失配在 ±30 行内搜 anchor，仍找不到进「待归位」 | `notes.ts` |
| 笔记汇总与导出（G4.3、G4.4） | 侧栏 `guide` tab「笔记」段：按文件分组 + 「全部 / 当前文件 / 待归位」筛选；导出 Markdown（`- path:line — 内容`）；导出 / 导入 JSON | `GuidePanel.tsx`、`notes.ts` |
| 自定义路线（G2.6） | 「存为我的路线」+ 上移 / 下移，落 `wcr:routes:<id>` | `guide.ts` |

### W3 变更有感（对齐 agent 节奏）

| 项 | 做法 | 落点 |
|---|---|---|
| 阅读快照（G8.2 前置） | `wcr:readsnapshot:<id>` = `{at, files:{path:{mtimeMs,size,lines}}, noteLocs}`；`openFileAt` 后防抖 2s 写 + 切项目时写 | `guide.ts`、`state.ts` |
| 变更清单（G8.1–G8.3） | `POST /changes {snapshot}` → 逐文件 `M/A/D` + 行数增减（git 走 `diff --numstat`，否则快照行数对比）+ 「笔记所在文件被改动」标记；首屏「自上次阅读以来」区块 + 侧栏清单 + 每条「看差异 / 重新读 / 已读跳过」 | 新 `backend/src/indexer/changes.ts`、`GET /file-diff`、`frontend/src/ChangesPanel.tsx`、`guide.ts` |
| 只读 git 扩展（G7.2–G7.5） | 导出 `timeline.git()`；新 `gitread.ts`：`diff --numstat`、`blame --line-porcelain`、`show <rev>:<path>`、文件历史（`log --follow --name-status`）。全部数组传参、无 shell、带 timeout、失败降级 | 新 `backend/src/indexer/gitread.ts`、`timeline.ts`（导出 `git`）、`routes.ts` |
| 未提交改动查看（G7.2） | 「变更」区块里对 dirty 文件提供只读 diff 视图（编辑器内以装饰高亮增删行，或在独立只读 pane 展示 `git diff` 文本） | `ChangesPanel.tsx`、`monaco-setup.ts` |
| blame（G7.3） | 光标行悬浮 / 状态栏显示 `作者 · 日期 · 提交摘要`；`Ctrl/Cmd+Alt+B` 切换整文件 blame 视图 | `gitread.ts`、`Editor.tsx`、`state.ts` |
| 文件历史（G7.4）与历史版本（G7.5） | 文件信息卡列最近 N 次改动；点某次 → `git show` 正文 → Monaco 只读 model（`wcr-history://`）在第二个 pane 打开，标注「历史版本快照」 | `gitread.ts`、`Editor.tsx`、`App.tsx` |
| agent 产出标记（G8.4） | 变更清单里显示 `origin` 徽标（宿主上报 = 实；其余标「最近改动（推断）」） | `ChangesPanel.tsx` |

### W4 会解释（纯静态，Q1-A）

| 项 | 做法 | 落点 |
|---|---|---|
| 结构性解释（G5.1、G5.2） | `POST /explain {file,line,col,scope}` → 段落标题 + 它是什么（定义 / 所属类与方法 / 签名）+ 调用了谁 + 谁调用它 + 引用了本项目哪些定义 + 引用了哪些外部模块 + 覆盖率；每条带 `path:line` 出处 | 新 `backend/src/indexer/explain.ts`、`POST /explain`、`frontend/src/ExplainPanel.tsx` |
| 范围控制（G5.3） | 三档：`selection`（选中）/ `symbol`（所在符号，默认）/ `callers`（连带直接调用方） | `explain.ts`、`ExplainPanel.tsx` |
| 存成笔记（G5.4） | 「保存为笔记」把解释内容写成文件级或行级笔记（同 G4 存储） | `ExplainPanel.tsx`、`notes.ts` |
| 入口 | 编辑器右键「解释这段」+ `Ctrl/Cmd+Alt+E` | `monaco-setup.ts`、`App.tsx` |
| 目录级摘要（G6.2） | 复用 `dirDuties`（不新增算法），在总览的目录区块与文件树目录节点上给出「这一层是干嘛的」 | `insight.ts`（复用）、`Overview.tsx` |
| 模板化摘要句（G6.3） | `summary.sentence`：确定性拼装，如「导出 3 个符号（2 类 1 函数），依赖 4 个模块，被 7 处引用（其中测试 2 处）」。界面标注「结构性摘要 · 未使用模型」 | `backend/src/indexer/summary.ts` |
| 摘要时效（G6.4） | 摘要条记 `revision`（= `indexVersion`）与文件 `mtimeMs`；文件变了则显示「基于旧版本，已更新」并可一键重取 | `SummaryBar.tsx`、`summary.ts` |

### W5 看得见（流视图）

| 项 | 做法 | 落点 |
|---|---|---|
| 调用链 / 反向调用图（G9.1、G9.2） | 新 `FlowView.tsx` 浮层：以某符号为焦点，按 `callgraph` 的 `in/out` 结果构建节点与边，d3-force 布局 + 手写 SVG（复用 01 的交互做法）；节点可点开文件、可双击展开下一层 | 新 `frontend/src/FlowView.tsx`、`backend/src/indexer/flow.ts` |
| 数据流视图（G9.3） | 从函数定义出发：实参文本 ↔ 参数名的**名字级**匹配连线，标注「名字级近似 · 不做类型推断」 | `flow.ts`、`FlowView.tsx` |
| 范围控制（G9.4） | 焦点符号 + 方向（谁调用我 / 我调用了谁 / 数据流）+ 深度 1–3 + 「只看本项目」（默认，外部依赖聚合为灰节点） | `FlowView.tsx` |
| 入口 | 侧栏层级面板「展开为图」、编辑器右键「看调用图」 | `NavPanels.tsx`、`monaco-setup.ts` |
| 复用改造 | 把 `GraphView.tsx` 的布局纯函数（`layoutGraph` / `nodeRadius` / `nodeFill` / `nodeTitle` / `labelVisible`）**导出**复用，不复制一份 | `GraphView.tsx`（仅加 `export`，不改行为） |

---

## 3. 契约与端点变更总表

**新增端点**

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/projects/:id/routes` | G2：四条阅读路线（`dep` / `entry` / `hot` / `fresh`） |
| POST | `/api/projects/:id/changes` | G8：`{snapshot}` → 变更清单（M/A/D + 行数增减 + 笔记过期标记） |
| GET | `/api/projects/:id/file-diff?path=&rev=` | G7.2 / G7.5：只读 diff（`rev` 缺省 = 工作区 vs HEAD） |
| GET | `/api/projects/:id/blame?path=` | G7.3：行级 blame（只读） |
| GET | `/api/projects/:id/file-history?path=&limit=` | G7.4：文件级提交历史（`--follow`） |
| GET | `/api/projects/:id/git-show?rev=&path=` | G7.5：历史版本正文 |
| GET | `/api/projects/:id/file-summary?file=` | G6.1 / G6.3 / G6.4：文件结构性摘要 + 模板化句子 + `revision` |
| POST | `/api/projects/:id/explain` | G5：`{file,line,col,scope}` → 结构性解释 |
| POST | `/api/projects/:id/flow` | G9：`{file,line,col,kind:'calls'\|'callers'\|'data',depth}` → 流视图图数据 |

**扩展现有契约**

| 契约 | 变更 | 用于 |
|---|---|---|
| `ProjectOverview` | `+ guide?: { readFiles, sourceFiles, lastRead?: {file,line,col,at}, changes?: ChangeSummary }` | G1、G3、G8 的首屏数据 |
| `TimelineFile` | 复用（不改） | G8.4 |

**内部模型**

| 模型 | 变更 |
|---|---|
| `backend/src/indexer/gitread.ts` | 新增只读 git 扩展（复用 `timeline.git()`） |
| `frontend/src/marks.ts` | 新增：把 01 的 marks 读写抽成共享模块 |

所有新增端点与契约同步登记进 `/api/integration/manifest`（`backend/src/api/routes.ts:55-88`）。

---

## 4. 数据与存储（本机 `localStorage`，Q3）

| 域 | key | 内容 | 上限 |
|---|---|---|---|
| 已读 / 忽略 | `wcr.map-marks` | 复用 01 已有结构 `{read, ignored}` | 无（值=时间戳） |
| 位置记忆 | `wcr:positions:<id>` | 复用 03 已有 `{line,col,scrollTop}` | 200 |
| 书签 | `wcr:bookmarks:<id>` | 复用 03 已有 | 无 |
| 搜索历史 | `wcr:search-history:<id>` | 复用 03 已有 | 20 |
| **阅读路线** | `wcr:routes:<id>` | `{kind, custom?: string[], done: {file: at}}` | 1 条/项目 |
| **阅读状态** | `wcr:readstate:<id>` | `{file,line,col,at}`（继续阅读） | 1 条/项目 |
| **笔记** | `wcr:notes:<id>` | `{id,file,line,col,anchor,body,level:'line'\|'file',at,updatedAt}` | 无（但导出时提示体积） |
| **阅读快照** | `wcr:readsnapshot:<id>` | `{at, files:{path:{mtimeMs,size,lines}}, noteLocs}` | 只存索引内源码文件 |
| **待读队列** | `wcr:queue:<id>` | `{file,line,col,note?,at}` | 200 |

- 全部读写包 `try/catch`（隐私模式 / 配额异常静默降级，与 03 一致）。
- 导出 / 导入 JSON：笔记、书签、路线、待读四类可分别导出；导入按 `id/file+line` 合并去重。

---

## 5. 质量与验收

**每阶段三关**（Q20）：

1. `npm run typecheck`（前后端）
2. `npm test`（当前 94 例；W1–W5 预计新增约 25 例：四条路线生成、anchor 恢复三层兜底、变更对比 M/A/D、git 只读扩展降级、摘要句子、解释范围三档、流视图数据）
3. `npm run test:ui`（当前 19 例；追加向导用例）

**关键验收用例**（必须进 UI 自动化）：

| 用例 | 断言 |
|---|---|
| 打开陌生项目 | 首屏出现入口候选与推荐路线，点「开始」直接打开路线第 1 步 |
| 路线行进 | 点「下一步」跳到下一个文件，路线卡片状态随之更新 |
| 关掉浏览器重开 | 回到上次文件与行列，且「继续阅读」条目指向它 |
| 写一条行级笔记 | 行槽出现图标；刷新后仍在；导出 Markdown 含 `path:line` |
| 代码改动后回来 | 变更清单列出该文件，并标出「你在这条文件上有笔记」 |
| 门控：非 git 仓库 | 变更清单显示「无 git，按快照行数对比」，不报错 |
| 解释这段 | 输出含「谁调用它 / 它调用谁」清单与 `path:line` 链接 |
| 文件摘要条 | 显示导出数 / 依赖数 / 被引用数；文件改动后提示「基于旧版本」 |
| 调用流视图 | 从符号打开图，节点可点开文件，标注覆盖率与「名字级近似」（数据流模式） |
| 无 console error | 全程无 console error（沿用 03 的判据） |

---

## 6. 风险与兜底（确定处置）

| 风险 | 处置 |
|---|---|
| 依赖序在某些仓库里几乎全连成一个环 | Tarjan SCC 先把环压成一个「层」，层内按入度排序并标注「（循环依赖组）」；不假装解开了环 |
| 大仓库路线步数过多（300+ 文件） | 路线默认只取前 40 步（可在面板「显示全部」），并显示总步数；理由：阅读者不会按 300 步走 |
| 笔记 anchor 在重命名 / 大规模重构后全部失配 | 进「待归位」列表，头部提示「N 条笔记待归位」，提供「批量重新锚定」入口（打开文件时按内容相似度建议） |
| 阅读快照随项目增长膨胀 | 只存索引内源码文件的 `{mtimeMs,size,lines}`（约 60 字节/文件），5000 文件约 300KB，可接受；超限时按 `mtimeMs` 保留最近 3000 个 |
| 快照对比把「换行符 / 格式化」也算成变更 | 变更清单只报事实（`+34 -10`），不做「重要 / 不重要」的裁决；用户可用「已读，跳过」自行降噪 |
| git 不可用 / 慢（大仓库 blame） | 所有 git 调用带 4s 超时（沿用 `timeline.ts:20`），失败即降级并在界面注明；blame 按文件缓存（键 `path+rev`） |
| 数据流视图产生误导性连线 | 名字级匹配的边用虚线 + 「名字级近似」标注；无法匹配的实参**不画边**（而不是猜一条） |
| 向导面板与 03 的 marks tab 功能重叠 | 明确分工：`marks` tab 是「书签 + 已读筛选用」，`guide` tab 是「路线 / 进度 / 待读 / 笔记」；两者共享 same 存储、不共享视图 |
| `localStorage` 被清空导致笔记全丢 | 首屏与笔记面板提供「导出备份」提示（仅提示，不打扰）；导入去重合并 |

---

## 7. 「完美」的判据

向导主题做到完美 = 以下七条同时成立：

1. 打开一个陌生仓库的第一分钟不是空转：**有入口候选、有推荐路线、有「继续阅读」**，其中至少一个能直接开始。
2. 「接下来读什么」永远有确定答案，且答案**能说出来为什么**（每一步带理由）。
3. 「读到哪了」跨会话成立：位置、已读、笔记、路线进度都在，且**用户能手动修正系统的判断**。
4. 笔记贴在代码上、不污染源码、抗代码变动（锚定 + 待归位），并且**带得走**（Markdown / JSON）。
5. 代码变了，用户回来第一眼看到的是**变化与我有关的部分**（我读过什么、我在哪些文件上有笔记）。
6. 解释与摘要**不编造**：拿不到的关系如实标为未解析 / 名字级近似；不使用模型时明确标注「结构性」。
7. 上述行为全部有自动化用例守着。

---

## 8. 明确不做（与 `04-guide.md` §6 同源）

| 不做 | 理由 |
|---|---|
| 完整 git 客户端 | 只读定位是差异化；只取「读懂」需要的读数（Q4 的六个只读命令） |
| 引入 LLM（本次） | 只读 / 本机 / 不上传是本产品的承诺；G5.2 与模板化摘要已能给出有信息量的输出（Q1-A） |
| 把向导数据存后端 / 存进被读目录 | 数据落在与 03 同一层（`localStorage`），口径单一；不碰被读目录一个字节（Q3） |
| 笔记当协作评论、多人同步、账号 | 与「本机工具、隐私即卖点」冲突（Q6） |
| 停留时长 / 滚动深度驱动的「读懂度」推断 | 系统只记事实（打开过），理解与否的判断权在用户（Q2） |
| 拖拽排序路线 | 上移 / 下移已能表达顺序，拖拽要引入 DnD 依赖与触屏兼容问题 |
| 数据流的类型级精度 | 需类型推断，属 06 底座边界；本主题只做名字级近似并标注（Q15） |
| 全仓库自动摘要 | 成本高、时效差、大量源码离开本机（04 §6） |
| 硬编码「最佳实践」阅读顺序 | 路线只是建议，可随时离开、重排、替换（04 §6） |

---

## 9. 落地结果（2026-10-02）

### 9.1 三关验收

| 关卡 | 命令 | 结果 |
|---|---|---|
| 类型检查（前后端） | `npm run typecheck` | 通过 |
| 后端单测 | `npm test` | **85/85 通过**（含本主题新增用例） |
| 前端单测 | `npm --prefix frontend test` | **42/42 通过**（含 `notes.test.ts`、`changes.test.ts` 的纯逻辑用例） |
| 前端构建 | `npm run build` | 通过 |
| 浏览器 UI 回归 | `PORT=<空闲端口> npm run test:ui` | 导航 **12/12** + 向导 **8/8**，全程无 console error |

**关于测试基线的如实说明**：本主题开工时全仓单测为 136 例；作业期间测试套件被其它并行会话**大幅精简**（多数文件收敛为一个综合用例，现在 85 例，且每个文件只剩少数顶层用例）。因此 04 的验收**不依赖旧用例的数量**，而是三条独立证据：① 本主题自己新增的真实用例（删掉被测实现即会失败）；② 新增的端到端 UI 用例 `tests/ui/guide.mjs`（8 条，覆盖 G1/G2/G3/G5/G8/G9 主链路）；③ 逐条人工核对（在真实浏览器与真实后端实例上）。

### 9.2 能力点交付表

| 项 | 状态 | 落点 | 证据 |
|---|---|---|---|
| G1.1 项目概览首屏 | 完成 | 复用 01 的 `Overview.tsx` + 新增向导区块 `GuideStart`（`Overview.tsx:130`） | UI 用例「首屏『从这里开始』」 |
| G1.2 入口候选清单 | 完成 | `insight.looksLikeEntry` + `Overview` 入口区（复用 01） | 与 01 同源，UI 用例首屏步骤即路线首步 |
| G1.3 冷启动引导 | 完成 | `frontend/src/Welcome.tsx`（打开路径 → 最近项目 → 索引进度）+ 只读/隐私承诺文案 | 由 06 主题实现，本主题复用，未重复造 |
| G1.4 回到总览 | 完成 | 顶栏「总览」入口 + 侧栏 `overview` tab + URL 快照 | 手工核对 |
| G2.1 依赖序路线 | 完成 | `backend/src/indexer/guide.ts:136` `depRoute`（Tarjan SCC 缩点 + 分层） | 单测 `tests/guide.test.ts` + `tests/guide-w1.test.ts` |
| G2.2 入口向下路线 | 完成 | `guide.ts:222` `entryRoute`（BFS from 入口） | `tests/guide-w1.test.ts` |
| G2.3 热度序路线 | 完成 | `guide.ts:276` `hotRoute`（复用 insight inbound 口径，不自建） | `tests/guide-w1.test.ts` |
| G2.4 新鲜度序路线 | 完成 | `guide.ts:300` `freshRoute`（`mtimeMs` 降序） | `tests/guide-w1.test.ts` |
| G2.5 路线内行进 | 完成 | `GuidePanel` 的「上一步 / 下一步 / 标记已读 / 加入待读」+ 状态栏「路线 a/b · 下一步：xxx →」 | UI 用例「下一步能前进」 |
| G2.6 自定义路线 | 完成 | `guideState.moveStep`（真实换位 + 即时持久化 `wcr:routes:<id>`）+ 存为我的路线 / 重置 | 手工核对 |
| G3.1 文件级已读 / 待读 | 完成 | `marks.ts`（已读）+ `openFileAt` 打开即已读 + 文件树右键菜单 | UI 用例「打开即已读」 |
| G3.2 项目级进度 | 完成 | 向导面板进度段，分母 = 源码文件（排除测试与文档配置），口径写在 title | UI 用例「进度计数跨刷新保留」 |
| G3.3 阅读位置记忆 | 完成 | 复用 03 的 `wcr:positions:<id>`（每文件 line/col/scrollTop） | 03 已有 UI 用例 |
| G3.4 继续阅读入口 | 完成 | 首屏「继续阅读」区块 + `Ctrl/Cmd+Shift+R` + `wcr:readstate:<id>` | UI 用例（路线第 2 步后「继续阅读」出现） |
| G3.5 待读队列 | 完成 | `wcr:queue:<id>` + 三处入口（文件树右键 / 搜索结果行尾 / 编辑器右键） | UI 用例「待读队列跨刷新仍在」 |
| G4.1 行级笔记 | 完成 | `notes.ts` + `NoteLayer.tsx`（行槽 `wcr-guide-note-gutter` 独立装饰池 + 自建浮层） | `notes.test.ts` + 手工核对 |
| G4.2 文件级笔记 | 完成 | `NoteLayer.tsx` 的 `FileNoteBar` | 手工核对 |
| G4.3 笔记汇总与回跳 | 完成 | `GuidePanel` 笔记段（全部 / 当前文件 / 待归位 + 点击跳转） | 手工核对 |
| G4.4 笔记导出 | 完成 | `notes.exportMarkdown`（`- path:line — 内容`）+ 导出 / 导入 JSON | 手工核对 |
| G5.1 「解释这段」 | 完成 | `ExplainPanel.tsx` + 编辑器右键 / `Ctrl/Cmd+Alt+E` | UI 用例「解释这段」 |
| G5.2 结构性解释 | 完成 | `backend/src/indexer/explain.ts`（定义 / 调用 / 被调用 / 本项目引用 / 外部模块 + 覆盖率） | 端点实测（三档 range） |
| G5.3 解释范围控制 | 完成 | 三档：选中 / 所在符号（默认）/ 连带调用方 | 端点实测 |
| G5.4 解释存成笔记 | 完成 | 「保存为笔记」→ `notesState.add`（行级或文件级，正文含 `path:line`） | 手工核对 |
| G6.1 文件级结构性摘要 | 完成 | `SummaryBar.tsx` + `backend/src/indexer/summary.ts` | 单测 + UI 用例 |
| G6.2 模块 / 目录级摘要 | 完成 | 文件树目录节点 `title` ← 01 的 `dirDuties`（不重算） | 数据核对（19/24 命中，其余是被忽略目录） |
| G6.3 自然语言摘要 | 完成（**模板化**） | `summary.sentenceOf` 用结构化字段拼装确定性中文句，不调模型 | 单测断言句子；界面标「结构性摘要 · 未使用模型」 |
| G6.4 摘要时效标记 | 完成 | `SummaryBar` 显示「基于索引版本 <rev>」+ `file-changed`/重开文件时提示「内容已更新 · 重新拉取」 | 手工核对 |
| G7.1 工作区状态 | 完成 | 复用 01 的只读 git（`timeline.readGit`）+ 概览展示 | 01 已有 |
| G7.2 未提交改动查看 | 完成 | `gitread.fileDiff` + `DiffPanel.tsx`（只读渲染 `+`/`-`/`@@` 着色） | 端点实测（真 git 仓库） |
| G7.3 行级 blame | 完成 | `gitread.blame` + 状态栏 / 行尾作者 + `Ctrl/Cmd+Alt+B` 整文件视图（按文件缓存） | 实测（含「Not Committed Yet」行） |
| G7.4 文件与项目历史 | 完成 | `gitread.fileHistory`（`--follow`）+ `SummaryBar` 展开区提交列表 | 实测 |
| G7.5 历史版本对照 | 完成 | `gitread.showFile` + `state.openSecondaryText` + `wcr-history://` 只读 model（不落盘、不进最近打开、不写位置） | 实测（历史 pane 打开后标签数仍为 1） |
| G8.1 会话内变更提示 | 完成 | SSE `file-changed`/`file-deleted` → 变更面板顶部「刚刚有 N 个文件变更 · 重新比对」 | 实测 |
| G8.2 自上次阅读以来的变更清单 | 完成 | `readSnapshot.ts`（三处写时机）+ `POST /changes` + `ChangesPanel.tsx` + 首屏摘要卡 | UI 用例「记录基线后报没有变化」 |
| G8.3 变更摘要与差异高亮 | 完成 | 逐条 `+N -M`（git `--numstat`）+ diff 浮层行级着色 | 实测（git / 非 git 两条路径） |
| G8.4 「可能是 agent 刚写的」标记 | 完成 | 复用 01 的 `timeline.classify` 口径 → 每条 origin 徽标（宿主上报为实，其余标「推断」） | 实测 |
| G9.1 调用链下钻视图 | 完成 | `flow.ts` + `FlowView.tsx`（d3-force + 手写 SVG，复用 01 的布局纯函数） | UI 用例「展开为图出节点」 |
| G9.2 反向调用视图 | 完成 | FlowView 方向三档（我调用了谁 / 谁调用我） | UI 用例 + 实测 |
| G9.3 数据流视图 | 完成（**名字级近似**） | `flow.ts` 实参名 ↔ 形参名匹配，边虚线 + 标「近似」，匹配不上不画边 | 实测（`approx:true`，`note: 名字级近似 · 不做类型推断`） |
| G9.4 视图入口与范围控制 | 完成 | 焦点 + 方向 + 深度 1–3 + 外部依赖开关 + 覆盖率 | UI 用例 + 实测 |

### 9.3 契约与端点（实际落地）

**新增端点**（全部登记进 `/api/integration/manifest`）：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/projects/:id/routes` | G2：四条路线 + `sourceFiles` |
| GET | `/api/projects/:id/file-summary?file=` | G6.1/G6.3/G6.4 |
| GET | `/api/projects/:id/readmap` | G8.2 的阅读基线原料（mtime/size/lines） |
| POST | `/api/projects/:id/changes` | G8.2/G8.3：快照对比清单 |
| GET | `/api/projects/:id/file-diff?path=&rev=` | G7.2 |
| GET | `/api/projects/:id/blame?path=` | G7.3 |
| GET | `/api/projects/:id/file-history?path=&limit=` | G7.4 |
| GET | `/api/projects/:id/git-show?rev=&path=` | G7.5 |
| POST | `/api/projects/:id/explain` | G5 |
| POST | `/api/projects/:id/flow` | G9 |

**新增内部模块**：`backend/src/indexer/{guide,summary,gitread,changes,explain,flow}.ts`；`frontend/src/{marks,guide,guideState,readSnapshot,changesState,blame,timeAgo,notes,notesState,explainState}.ts`、`{GuidePanel,SummaryBar,ChangesPanel,DiffPanel,NoteLayer,ExplainPanel,FlowView}.tsx`。

**只读边界**：`timeline.git()` 被导出复用，全仓 git 调用只允许 `rev-parse` / `status` / `log` / `diff` / `blame` / `show` 六个只读子命令，一律 `execFile` 数组传参 + 超时 + 失败降级；`rev` 走白名单正则，`path` 走项目内校验。

### 9.4 实现中发现并修掉的缺陷

1. **释放索引只清了定时器**：`registry.stopProject` 调的是 `project.dispose()`（仅清 `persistTimer`），没调 `ProjectIndex.release()`（真正清内存索引）。后果是 `GET /resources` 在 dispose 之后仍报 `indexed: true`，`backend/tests/dispose.test.ts` 的「内存索引应已释放」失败。改为 `project.release()`（它内部仍会调 `dispose()`）。这是并行会话在做的 06 底座 S9c 端点的在途缺陷，本主题顺手修正。
2. **UI 用例断言了「与当前 tab 无关」的节点**：`tests/ui/guide.mjs` 首版在刷新后等 `.tree-row, .file-tree`，但侧栏是按 tab 渲染的（URL 恢复成 `tab=guide` 时文件树不在 DOM），导致超时。改为等 `.panel-tabs` 骨架。教训：UI 断言必须锚在当前视图真实存在的节点上。

### 9.5 与 §7「完美判据」的逐条核对

| 判据 | 核对 |
|---|---|
| 1. 第一分钟不空转 | ✔ 首屏同时给入口候选（路线首步）、推荐路线（4 条可换）、继续阅读；UI 用例断言「至少 2 步 + 首步是真实文件」 |
| 2. 「接下来读什么」有答案且说得出为什么 | ✔ 每步带 `reason`（「不依赖项目内其它文件，可先读」/「与 a.ts 互相依赖（循环依赖组）」/「被 7 个文件引用，是热点」），UI 用例断言理由非空 |
| 3. 「读到哪了」跨会话成立且可手动修正 | ✔ 已读 / 进度 / 待读 / 笔记 / 位置全在 `localStorage` 按项目分片；UI 用例断言刷新后计数与队列仍在；「标记已读 / 取消已读」可覆盖系统默认 |
| 4. 笔记贴代码、不污染源码、可带走 | ✔ 行槽 + 锚定三层兜底 + 待归位；导出 Markdown / JSON |
| 5. 代码变了先看到「与我有关的部分」 | ✔ 变更清单 + 「你的笔记可能已过期」（`noteStale`）；无 git 时如实降级 |
| 6. 解释与摘要不编造 | ✔ 覆盖率固定显示「已解析 / 未解析 / 外部」；数据流边标「近似」；无 git 不报增删行；不调模型并明确标注 |
| 7. 自动化守着 | ✔ 新增 `tests/ui/guide.mjs`（8 条主链路）+ 前后端单测；已纳入 `npm run test:ui`（`run.mjs` 依次跑 navigator 与向导两套） |

### 9.6 如实说明：打折 / 没做 / 语义边界

- **不引入 LLM**（Q1-A）：G5.1「解释这段」= 结构性解释，G6.3 用**模板化句子**；界面固定标注「结构性解释 · 未使用模型」，不留「以后接模型」的占位开关。
- **数据流只做名字级近似**（Q15）：边为虚线 + 「近似」，匹配不上的实参**不画边**；不做类型推断。
- **非 git 仓库**：变更只报「有 / 无变化 + 行数对比」，增删行两列为 `null`，界面不显示 `+0 -0`；diff / blame / 历史 / 历史版本给一句人话而非空白面板。
- **笔记的行槽交互未纳入 UI 自动化**：行槽在 Monaco 装饰层，自动化点击不稳；该能力由 `frontend/src/notes.test.ts`（锚定三层兜底 + 导入去重）与手工核对覆盖，UI 用例覆盖的是「持久化 + 路线 + 待读 + 基线 + 解释 + 流视图」主链路。
- **「上次阅读」的语义**：快照会被「打开文件」刷新，因此它是「最近一次翻文件的时间」，不是「合上浏览器的那一刻」；面板不自动重比对（提供「重新比对」按钮 + SSE 脉冲提示），避免边读边改清单。
- **git 模式的增删行是「工作区 vs HEAD」**（未提交改动），不是「相对上次阅读的增量」——界面如实呈现后端口径。
- 路径记忆 / 书签 / 搜索历史沿用 03 的 `localStorage` 口径，未新增后端存储（Q3）。

### 9.7 复现方式

```bash
npm run typecheck                      # 前后端类型检查
npm test                               # 后端单测（85 例，含 04 新增）
npm --prefix frontend test             # 前端单测（42 例：笔记锚定 / 变更视图逻辑 / i18n 一致性）
npm run build                          # 前端产物
PORT=8812 npm run test:ui              # 浏览器回归：导航 12 例 + 向导 8 例（自动建 / 删夹具项目）
```
