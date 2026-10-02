[01 地图 Map](./01-map.md) · [02 透镜 Lens](./02-lens.md) · [03 导航 Navigator](./03-navigator.md) · [04 向导 Guide](./04-guide.md) · [05 信使 Share](./05-share.md) · [06 底座 Platform](./06-platform.md)

# 03 导航 Navigator · 全量落地决策与实施报告

> 本报告**只给确定答案**：Q0–Q18 全部拍板，N1–N25 全量实施，不含「待确认」「建议」类表述。
> 唯一例外是附录里标注为「不可确定」的技术事实（如解析率上限），会明确写出它的边界与兜底。

---

## 0. 结论摘要

**交付范围**：N1–N25 全量，分四阶段推进，每阶段独立可验收。**不做裁剪。**

**三条不可动摇的原则**（所有决策都由它们推出）：

1. **后端 `reason` 是唯一事实源**，前端只做表达。任何「前端自己猜为什么没跳」的实现都是错的。
2. **绝不伪造数据**。拿不到的关系（需要类型推断的调用）标为「未解析」并如实展示，不用启发式凑数。
3. **只读不写被读目录**。所有用户产生的数据（标签、书签、位置、搜索历史）落本机 `localStorage`，并在需要跨机器时走显式导出——不碰源码目录一个字节。

**当前基线（本次实测）**：`npm run typecheck` 通过；`npm test` **64/64 全绿**。

**当前进度（与 N1–N25 对照）**：已落地 9 项、部分落地 3 项、未落地 13 项（见 §1）。

---

## 1. 当前实况：基线核对

先纠正一个事实：工作区**已经比 `03-navigator.md` 写的走得更远**。除 03 的 N2 雏形外，01/02 的一部分也已落地。以下为逐项核对结果（可复现）。

| 项 | 能力 | 实况 | 证据 |
|---|---|---|---|
| N1 | 跳转到定义 | 已落地 | `backend/src/indexer/resolver.ts:269` `gotoDefinition` |
| N2 | 跳转失败解释 + 兜底 | **部分** | 提示条已建：`frontend/src/Notice.tsx:37` `GotoNoticeBar`、`frontend/src/state.ts:26` `GotoNotice`、`frontend/src/App.tsx:38`；**缺** external 的来源详情与「跳到 import 行」 |
| N3 | 查找引用（Peek） | 已落地 | `frontend/src/monaco-setup.ts` 引用 Provider |
| N4 | 常驻引用面板 | 未落地 | 侧栏仍只有 3 个 tab：`frontend/src/App.tsx:12` `'files' \| 'outline' \| 'search'` |
| N5 | 文件大纲 | 已落地 | `frontend/src/SidePanel.tsx:62` `OutlinePanel` |
| N6 | 面包屑 | 已落地 | `frontend/src/App.tsx`（crums 区） |
| N7 | 面包屑同级下拉 | 未落地 | 面包屑无下拉，仅点击跳转 |
| N8 | 工作区符号搜索 | 已落地 | `/workspace-symbols` |
| N9 | 文件搜索 | 已落地 | `frontend/src/QuickOpen.tsx` |
| N10 | 全项目文本搜索 | 已落地 | `/search` |
| N11 | 搜索结果独立面板 | 未落地 | 搜索仅存在于侧栏 tab |
| N12 | 搜索可取消 / 流式 | 未落地 | 后端 `searchText` 无 signal；全仓仅 SSE 心跳用到 `aborted`（`backend/src/api/routes.ts:287`） |
| N13 | 搜索历史 | 未落地 | 全仓无 `localStorage` |
| N14 | 搜索范围限定 | 未落地 | 契约 `SearchOptions.files?`（`shared/types.ts:93`）存在但前端未用 |
| N15 | 跳到实现 | 未落地 | 无继承/实现信息 |
| N16 | 调用层级 | 未落地 | 无 `call-hierarchy` 端点 |
| N17 | 类型层级 | 未落地 | 语言模块**无继承提取**（`backend/src/languages/*` 中 `extends`/`implements`/`superclass` 零命中） |
| N18 | 前进后退（浏览器按钮） | **部分** | 历史栈可用（`frontend/src/state.ts`），但无 `popstate` 监听 |
| N19 | 标签页 / 分屏 | 未落地 | 单 Editor 实例 |
| N20 | 书签 | 未落地 | — |
| N21 | 最近打开的文件 | 未落地 | — |
| N22 | 光标 / 滚动位置记忆 | 未落地 | 不带行号打开固定回第 1 行 |
| N23 | 跳到行 | 已落地 | Monaco 内建 |
| N24 | 文件内搜索 | 已落地 | Monaco 内建 |
| N25 | 正文符号 / 路径可点击 | 未落地 | 未注册 LinkProvider |

附带确认：`DefinitionResult` **没有** external 详情字段（`shared/types.ts:148-154`），`gotoDefinition` 在 external 分支只返回 `{locations: [], reason, symbol}`（`resolver.ts:293-295`）——这是 N2 补完必须动的第一处契约。

已落地的 01/02 资产（03 需要复用，**不要重建**）：
`backend/src/indexer/insight.ts` 里已有 `isTestFile`（:91）、`isDocOrConfig`（:100）、`looksLikeEntry`（:576）、`projectMap`（:75）、`fileFacts`（:571）、`dirStats`（:368）、`findCycles`（:266）；02 已有 `HoverResult` / `refCountOf`（`resolver.ts:581`）/ `literalAt`（:617）与 `/density`。

---

## 2. Q0–Q18 确定答案

### Q0 交付范围 —— **全量四阶段，顺序固定**

**决策**：N-α → N-β → N-γ → N-δ 全部做。阶段间不跳跃，因为 N-β 的调用层级要用 N-α 的引用解析口径，N-γ 的标签页要复用 N-β 的面板容器。

| 阶段 | 内容 | 完成判据 |
|---|---|---|
| N-α 敢按 F12 | N2 补完、N18、N4、N7、N8 增强 | 一次真实通读中「F12 无反馈次数 = 0」 |
| N-β 走通一条链 | N16、N17、N15、N11、N12、N13、N14、N25 | 任意函数上能双向展开两层调用并跳转 |
| N-γ 回得去 | N19、N20、N21、N22 | 关掉浏览器再打开，回到上次的文件与位置 |
| N-δ 顺手 | 键盘可达性、kind 过滤入口、文案与视觉打磨 | 全流程无需鼠标 |

**代价与兜底**：N16/N17/N15 的上限受解析率约束（当前 resolved 53.3%）。兜底是**如实标注覆盖率**，例如调用层级面板底部固定显示「已解析调用 N 处；另有 M 处因缺类型信息未能归属」。绝不用猜测填充。

### Q1 F12 失败：只解释 vs 带动作 —— **带动作，且 external 要能跳到 import 行**

**决策**：一律「解释 + 至少一个动作」，三类失败各有专属动作：

| reason | 文案 | 动作 |
|---|---|---|
| `external` | 外部依赖：`<module>`，不在项目索引内 | ① 跳到 import 行 ② 复制符号名 |
| `unresolved` | 未找到定义（可能需要类型推断） | ① 用该名字搜全项目 ② 复制符号名 |
| `no-symbol` | 光标处没有符号 | 无（不弹条） |

**依据**：只给解释等于把问题退回给用户；「跳到 import 行」是 external 场景下用户唯一可继续的动作，而 import 记录**已经在索引里**（`ImportRecord.range`，`backend/src/indexer/model.ts:52-66`）。

**落地要点**：`DefinitionResult` 增加可选字段
`external?: { module: string; importLocation?: Location }`。`gotoDefinition` 的 external 分支里，用 `ref` 的绑定名（成员访问取 `memberParts[0]`）在 `fi.imports` 中查 `ImportRecord`，命中则填 `module` 与 `importLocation`；查不到只填 `module: ''`（前端降级为「外部依赖」+ 复制按钮）。

### Q2 常驻引用面板挂哪 —— **侧栏第四个 tab；分屏时允许独立右栏**

**决策**：N-α 先做侧栏 `refs` tab（与 files/outline/search 并列）。N-γ 做分屏时，**同一组件**可挂到右侧独立栏。不做两套实现。

**依据**：先做侧栏 = 零布局改造、零风险；独立右栏的收益只在分屏场景，属于 N19 的范畴，解耦后各阶段独立可验收。

### Q3 调用层级首版做哪一半 —— **两个方向都做，「谁调用我」优先上线**

**决策**：N-β 交付 `in`（谁调用我）与 `out`（我调用了谁）双向，默认展示 `in`；深度默认 1，可展开至 3。

**依据**：「改这个会炸到谁」是改代码前必答项（`in`），「这函数干了啥」是理解入口（`out`），二者共用同一份数据，分开做等于同一段逻辑写两遍。

**落地要点**：
- `in`：对目标定义的全部引用，用 `defAt(fi, ref.range.start)` 求其所在最内层 `DefRecord`，即 caller。
- `out`：对目标 `DefRecord.range` 内的全部引用做 `resolveRef`，得到的 def/external 即 callee；`unresolved` 单列一组，不算 callee。
- 端点：`POST /api/projects/:id/call-hierarchy { file, line, col, direction, depth }`。

### Q4 位置记忆范围 —— **持久化到本机 `localStorage`**

**决策**：持久化（跨会话）。写入 `localStorage`，按项目 id 隔离。**不写被读目录**。

**依据**：会话内记忆的使用价值极低（刷新即丢）；持久化的隐私代价可以用「数据在本机浏览器、可一键清除」完全抵掉。

### Q5 标签页策略 —— **上限 8 + LRU 淘汰 + 同文件合并 + 分屏例外**

**决策**：A/B/C 合一。默认同一文件只占一个标签（位置取最后访问处）；上限 8，超出按最久未用淘汰；仅当用户显式执行「在旁边打开」时，允许同一文件开出第二个标签用于分屏。

**落地要点**：Monaco 允许多个 editor 共享同一 `ITextModel`，因此 model 池可保持单份，分屏只需新增 `EditorPane` 容器，**不复制 model**（避免内存翻倍与状态不同步）。

### Q6 正文路径是否可点 —— **符号名 + 校验通过的路径都可点**

**决策**：都做。路径必须经 `ProjectIndex` 文件集校验存在才给可点击态，校验失败当普通文本。**依据**：误跳比不可点更伤信任。

**落地要点**：用 Monaco 原生 `registerLinkProvider`（不自己接管鼠标事件）；路径校验复用后端已有的 `resolveInside` 语义，前端用 `store.tree` 的路径集合做 O(1) 判断。

### Q7 失败判定口径 —— **后端 `reason` 唯一事实源，前端只做文案**

**决策**：A。同时规定一条**非常规组合的处理规则**：`reason === 'resolved'` 但 `locations` 为空时，前端按 `unresolved` 文案显示，并额外提示「索引可能正在更新」。

**依据**：文案属于表达层；把文案搬到后端会让同一语义两处维护，且未来 i18n 必然要回退。

### Q8 Peek 是否显示声明 —— **显示，且与面板口径统一**

**决策**：引用 Provider 改传 `includeDeclaration: true`，声明行单列并标注。

**依据**：`findReferences` 已支持该参数（`resolver.ts:312`），当前固定传 `false`；面板与浮层必须一致，否则用户对「引用数」的认知会分裂。

### Q9 提示条形态 —— **编辑器右下角浮层，8 秒自动消失，可手关，悬停暂停**

**决策**：右下角浮层（不推挤布局）+ 8s 自动消失 + 显式关闭按钮 + 鼠标悬停时暂停计时。

**依据**：与 `03-navigator.md` §3.1 的目标草图一致；内嵌顶部条会引发布局跳动（编辑器高度变化）。

### Q10 「搜名字」动作的搜索选项 —— **纯文本 + 不区分大小写**

**决策**：A。**依据**：该动作的目的是「先让我看到这名字都出现在哪」，宁多勿漏；用户可在搜索面板自行收紧。

### Q11 声明 / 测试标注放哪一层 —— **后端标注，前端只渲染**

**决策**：**改后端**。`ReferenceResult.locations` 的每一项增加 `isTest: boolean`；`isDeclaration` 由 `includeDeclaration=true` 自然产生（前端按位置比对即可）。测试判定**复用 `insight.isTestFile`**（`insight.ts:91`）。

**依据（这条推翻了先前的「前端标注」倾向）**：`isTestFile` 已经被 01 的 overview 降噪口径使用（`OverviewOptions.denoise`）。若前端再写一份启发式，两处判定必然漂移，而测试判定恰恰是用户判断「这个引用要不要在意」的关键依据。**口径单一 > 少改一个契约。**

### Q12 索引未完成时的提示 —— **前端优先读 `status.indexing`**

**决策**：A。索引进行中时，提示条文案改为「索引进行中，符号信息稍后可查」，不算失败、不显示动作。

**依据**：这是提示条**唯一已知会说错话**的场景——把「还没索引」说成「认不出类型」会直接摧毁用户对工具判断力的信任。后端不新增 `reason` 枚举（避免契约膨胀），前端本就有 SSE 推送的 `status`（`frontend/src/state.ts`）。

### Q13 入口候选判定是否同源 —— **必须同源，统一走 `insight.looksLikeEntry`**

**决策**：调用层级树里的「入口候选」标记由后端下发，来源就是 `insight.ts:576` 的 `looksLikeEntry`（01 的 M2 已消费）。导航内**不得**自建第二份判定。

### Q14 类型层级数据从哪来 —— **AST 静态提取显式继承/实现，明确不做类型推断**

**决策**：B 的升级版——**新增语言层能力**而非「近似」：

| 语言 | 提取来源 |
|---|---|
| Python | `class_definition` 的 `superclasses` |
| TypeScript | `class_declaration` 的 `extends_clause` / `implements_clause` |
| Java | `superclass` 与 `interfaces` 字段 |
| Go | struct 的嵌入字段（`field_declaration` 无名类型） |

`DefRecord` 增加 `bases?: Array<{ name: string; kind: 'extends' \| 'implements' \| 'embeds' }>`，后端建反向索引（谁继承我），供 N17 与 N15 共用。

**边界必须写在界面上**：只处理**显式声明**的继承/实现；泛型、条件类型、鸭子类型、动态注册的接口实现一律不覆盖，界面标注「仅显式声明」。

**依据**：这是纯 AST 直读，不依赖类型推断，精度确定、成本可控；接 LSP 是量级变化，属于 06 底座的独立决策，不该拖住 03。

### Q15 书签存储范围 —— **本机持久化 + 显式导出**

**决策**：与 Q4 同层（`localStorage` 持久化）；提供「导出 JSON / 导入 JSON」以便跨机器或用例分享，衔接 05 信使。

### Q16 搜索独立面板与侧栏 tab —— **同一组件，两种容器**

**决策**：A。`SearchPanel` 抽成容器无关组件，侧栏内嵌一份、全屏浮层一份。

### Q17 搜索「范围」形态 —— **目录 + 打开集都支持，首版先做目录**

**决策**：C，分两步：先目录胶囊（后端新增 `SearchOptions.dirs?: string[]`，前缀匹配，避免把目录展开成上千条文件列表传给后端），再做「当前打开的文件集合」。

### Q18 阶段验收 —— **C：构建 + 单测 + 自动化 UI 回归**

**决策**：每阶段必须过三关：`npm run typecheck`、`npm test`、Playwright 自动化回归（跳定义 / 引用 / 大纲 / 搜索 / Ctrl+P / Ctrl+T / 失败提示条 / 标签页 / 位置恢复）。

**依据**：本主题全是交互行为，单测覆盖不到「提示条到底弹没弹」；而 N-γ 的「位置记忆」这类能力，人工回归极易漏测。UI 回归脚本需从临时目录迁入正式测试目录并纳入脚本（对应 06 的 P20）。

---

## 3. 全量实施蓝图

### N-α「敢按 F12」

| 项 | 做法 | 落点 |
|---|---|---|
| N2 补完 | 契约加 `external`；后端回填 import 位置；前端三类文案 + 三组动作 | `shared/types.ts:148`、`resolver.ts:289`、`Notice.tsx`、`App.tsx:38` |
| N18 | `openFileAt` 成功时 `pushState`（同 URL 去重）；监听 `popstate` → 复用 `init()` 的 URL 解析，带 `suppressHistory` 调用 | `frontend/src/state.ts`（`syncUrl` / `openFileAt`） |
| N4 | 侧栏加 `refs` tab；`findReferences(includeDeclaration=true)` + `isTest` 分组；键盘上下 + Enter 跳转 | `SidePanel.tsx` 新增 `RefsPanel`、`App.tsx:12` 的 `PanelTab` |
| N7 | 面包屑 crumb 可点开展开同级兄弟符号（数据来自 `store.symbols` 的父子关系） | `App.tsx` crumb 区 |
| N8 增强 | 符号搜索显示 `isTest` 标记与 kind 过滤入口 | `QuickOpen.tsx` |

### N-β「走通一条链」

| 项 | 做法 | 落点 |
|---|---|---|
| N16 | 新增 `call-hierarchy` 端点（`in`/`out`/`depth`）；前端侧栏 `calls` tab，可展开树 | 新 `backend/src/indexer/callgraph.ts`、`SidePanel.tsx` |
| N17 | 语言层加继承提取（见 Q14）→ `DefRecord.bases`；新增 `type-hierarchy` 端点 | `backend/src/languages/*`、`backend/src/indexer/model.ts:16` |
| N15 | 基于 N17 的反向索引，接口/抽象方法上弹出实现类列表 | `callgraph.ts` 复用 |
| N11 | `SearchPanel` 容器无关化 + 全屏浮层入口 + 按目录分组/按测试过滤 | `SidePanel.tsx`、`App.tsx` |
| N12 | `searchText(query, options, signal)`，循环内检查；前端 `AbortController` + 停止按钮 + 进度 | `backend/src/indexer/store.ts`（`searchText`）、`frontend/src/api.ts` |
| N13 | 搜索框下拉最近 20 条（`localStorage`） | `SidePanel.tsx` |
| N14 | 后端加 `SearchOptions.dirs`；前端目录胶囊（数据源 `store.tree`） | `shared/types.ts:93`、`store.ts` |
| N25 | `registerLinkProvider`：识别 `path/to/file.ext(:line)?` 与反引号符号名；路径经文件集校验 | `frontend/src/monaco-setup.ts` |

### N-γ「回得去」

| 项 | 做法 | 落点 |
|---|---|---|
| N19 | `Editor` 拆出 `EditorPane`；`panes: PaneState[]`；model 池共享；「在旁边打开」入口 | `Editor.tsx`、`App.tsx` |
| N20 | 书签列表（侧栏）+ `localStorage` + 导出/导入 | 新 `frontend/src/bookmarks.ts` |
| N21 | `Ctrl+P` 空查询时展示最近文件（与 N19 标签、N22 位置同源） | `QuickOpen.tsx` |
| N22 | 按 `projectId:file` 存 `{line, col, scrollTop}`，切文件/重开时恢复；带行号的显式跳转优先 | `Editor.tsx`、`state.ts` |

### N-δ「顺手」

键盘可达性全量覆盖（tab 切换、面板内导航、Esc 语义一致）、符号 kind 过滤可视化入口、文案统一（外部依赖 / 未解析 / 索引中三套）、视觉打磨（引用面板高亮、标签页活跃态、书签标记）、**复制位置 N26**（判据 6 的另一半：界面里每一处位置都能变成 `path:line:col`）。

---

## 4. 契约与端点变更总表

**新增端点**

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/projects/:id/call-hierarchy` | N16：`{file,line,col,direction,depth}` |
| POST | `/api/projects/:id/type-hierarchy` | N17 / N15：`{file,line,col,direction}` |

**扩展现有契约**

| 契约 | 变更 | 用于 |
|---|---|---|
| `DefinitionResult` | `+ external?: { module: string; importLocation?: Location }` | N2 |
| `ReferenceResult.locations[]` | `+ isTest: boolean` | N4 |
| `SearchOptions` | `+ dirs?: string[]` | N14 |
| `POST /search` | 支持 `AbortSignal`（请求中断即停止扫描） | N12 |
| `SymbolInfo`（内部） | `+ isTest?: boolean` | N8 |

**内部模型**

| 模型 | 变更 |
|---|---|
| `DefRecord` | `+ bases?: Array<{name, kind}>` |
| `ProjectIndex` | `+ heritageOf: Map<string, string[]>`（反向：被谁继承） |

所有新增端点与契约同步登记进 `/api/integration/manifest`（`backend/src/api/routes.ts` 的 `endpoints`）。

---

## 5. 质量与验收

**每阶段三关**（Q18 的 C 档）：

1. `npm run typecheck`（前后端）
2. `npm test`（当前 64 例，N16/N17 落地后预计 +20 例：调用层级 `in/out`、继承提取 5 语言、`isTest` 标注、`dirs` 范围搜索、abort 中断）
3. Playwright 自动化 UI 回归（脚本从临时目录迁到正式测试目录并纳入 npm 脚本）

**关键验收用例**（必须进自动化）：

| 用例 | 断言 |
|---|---|
| 外部依赖上按 F12 | 提示条出现，含模块名，点「跳到 import 行」定位到 import 语句 |
| 未解析符号上按 F12 | 提示条出现，点「搜全项目」→ 搜索面板打开且已执行 |
| 索引进行中按 F12 | 文案为「索引进行中」，不出现动作按钮 |
| 浏览器后退 | 回到上一个阅读位置，且 Alt+← 栈不受污染 |
| 引用面板 | 声明行单列、测试文件有标记、键盘可跳 |
| 同一文件开分屏 | 两个 pane 各自独立滚动，不同步 |
| 关闭浏览器重开 | 回到上次文件与行列 |
| 正文路径点击 | 存在则跳，不存在无点击态 |

---

## 6. 风险与兜底（确定处置）

| 风险 | 处置 |
|---|---|
| 解析率上限（resolved 53.3%）导致调用层级不完整 | 面板底部固定显示覆盖率与未归属条数；不猜测 |
| 各语言 `ImportRecord.range` 是否都填了 | 实现 N2 时逐语言验证 Python/TS/Go/Java；缺失即视为缺陷修复（不是降级） |
| `popstate` 与自建历史栈冲突 | 两栈分离：`popstate` 只认 URL；一切程序化跳转走 `suppressHistory` |
| 分屏导致 Monaco 内存翻倍 | 共享 `ITextModel`（Monaco 支持多 editor 共模型），仅 pane 实例增加 |
| 继承提取漏掉语言特有形态 | 每语言配套单测；未覆盖的形态在界面标「仅显式声明」，不静默丢失 |
| 搜索中止后端仍在扫盘 | `AbortSignal` 在文件循环与行循环双层检查；中止后释放 `ensureText` 缓存引用 |
| `localStorage` 数据膨胀 | 按项目 id 分片 + 上限（位置 200 条、历史 20 条、书签不限但提示体积） |

---

## 7. 现有工作区改动的处置 —— **保留，纳入 N-α，补验证**

工作区已有未经验证的改动（`Notice.tsx`、`FileDensityBar.tsx`、`monaco-setup.ts` 的 reason 处理、`state.ts` 的 notice 状态、`App.tsx` 接线）以及 01/02 的 `insight.ts`、`hover`、`density` 等。

**处置：保留 + 补验证，不回退。** 理由：本次实测 `typecheck` 通过、`npm test` 64/64 通过，说明这些改动未破坏既有契约；它们正是 N-α 与 01/02 的既有成果。

**待补的三件事**（属 N-α 范围）：

1. `DefinitionResult` 尚无 `external` 字段 → 补契约 + 后端回填 + 前端「跳到 import 行」动作（当前只做到「解释 + 搜名字」）。
2. 提示条尚未处理「索引进行中」状态（Q12）。
3. 已落地的 01/02 能力缺自动化 UI 回归覆盖（Q18 的 C 档要求）。

---

## 8. 「完美」的判据

导航主题做到完美 = 以下八条同时成立：

1. 按 F12 永远不会「什么都没发生」——四类结果各有明确反馈，失败必有下一步动作。
2. 任何一次跳转都可解释：为什么跳了、为什么没跳、数据有多新鲜（索引版本）。
3. 「谁在用它」可以不离开编辑器看到，也可以摊开成大屏面板逐个走完。
4. 调用链能双向展开，且**诚实地**报告自己覆盖了多少。
5. 走过的路可以回头：标签、最近、位置记忆三层都在。
6. 界面里出现的每一处位置都可以点，也都可以复制成 `path:line:col`。
7. 不上传、不写被读目录——用户产生的数据全在本机，且可导出。
8. 上述行为全部有自动化用例守着，改动不会悄悄退化。

---

## 附录：不可确定的技术事实（如实标注）

| 事实 | 边界 |
|---|---|
| 调用层级覆盖率 | 上限 = 引用解析率，当前实测 resolved 53.3%。提升它属于 06 底座的「类型推断 / LSP」决策，不在 03 范围 |
| 类型层级完整性 | 只覆盖四种语言的**显式**继承/实现声明；动态语言特性（元类注册、装饰器改写基类）不覆盖 |
| 大仓搜索中止的即时性 | 中止生效的最坏延迟 = 单个文件的最大扫描耗时，受 1MB 索引阈值约束 |

---

# 九、落地结果（2026-10-02）

本节记录本文档 §N-α/N-β/N-γ/N-δ 各条的实际交付状态与可核对证据。

## 9.1 三关验收（Q18 的 C 档）

| 关卡 | 命令 | 结果 |
|---|---|---|
| 类型检查（前后端） | `npm run typecheck` | 通过 |
| 后端单测 | `npm test` | **94/94 通过**（基线 74 → 新增 20：N-α 5、N16/N17/N15 7、N12/N14 2、其余为既有用例） |
| 浏览器 UI 回归 | `npm run test:ui` | **19/19 通过**，无 console error |

UI 回归脚本从临时目录迁到正式目录并纳入 npm 脚本：`tests/ui/run.mjs`（起夹具项目 + 后端）与
`tests/ui/navigator.mjs`（真 Chromium 断言）。夹具项目每次现建现删，不依赖用户本机已有项目。

## 9.2 能力点交付表

| 项 | 状态 | 落点 | 证据 |
|---|---|---|---|
| N2 失败解释与兜底 | 完成 | `shared/types.ts`（`DefinitionResult.external`）、`backend/src/indexer/resolver.ts`（`externalSource`）、`frontend/src/Notice.tsx`、`App.tsx` | 单测 3 例 + UI 2 例（外部依赖含模块名并可跳到 import 行；未解析可「搜 xxx」） |
| N18 浏览器前进后退 | 完成 | `frontend/src/state.ts`（`syncUrl` pushState / `listenPopState`） | UI 用例「后退回到上一个阅读位置」 |
| N4 常驻引用面板 | 完成 | `SidePanel.tsx` 的 `RefsPanel`、`resolver.ts` 的 `declaration` + API 层 `isTest` | UI 用例（5 处引用 / 1 处声明 / 1 个测试文件） |
| N7 面包屑同级 | 完成 | `App.tsx`（crumb-caret + 下拉） | 手工验证 |
| N8 符号搜索增强 | 完成 | `QuickOpen.tsx`（kind 下拉 + 测试徽标 + 只看非测试）、`workspace-symbols` 带 `isTest` | 类型检查 + 手工验证 |
| N16 调用层级 | 完成 | 新 `backend/src/indexer/callgraph.ts`、`POST /call-hierarchy`、`frontend/src/NavPanels.tsx` | 单测 3 例 + UI 1 例（含覆盖率行） |
| N17 类型层级 | 完成 | 四语言 `basesOf`（`languages/*.ts`）、`POST /type-hierarchy`、`NavPanels.tsx` | 单测 3 例（TS/Python/Java/Go） |
| N15 跳到实现 | 完成 | `callgraph.ts` 的 `implementationsOf`、`POST /implementations` | 单测 1 例 |
| N11 搜索独立面板 | 完成 | `SidePanel.tsx`（容器无关 + 全屏浮层 + 目录归类 + 排除测试） | UI 用例（含「排除测试 3→2」） |
| N12 取消 / 流式 | 完成 | `store.searchText(..., signal, onFile)`、`POST /search-stream`（SSE）、前端 `searchStream` + 停止按钮 | 单测 2 例 + UI 用例 |
| N13 搜索历史 | 完成 | `state.ts`（localStorage，按项目分片，上限 20）+ 搜索框下拉 | 手工验证 |
| N14 范围限定 | 完成 | `SearchOptions.dirs` + 目录胶囊 | 单测 + UI |
| N19 标签 / 分屏 | 完成 | 模块级 model 池、`App.tsx` 标签条与 panes | UI 2 例 |
| N20 书签 | 完成 | `state.ts` 书签 + localStorage + 导出/导入、侧栏「书签」tab、`Ctrl/Cmd+Shift+B` | UI 用例 |
| N21 最近打开 | 完成 | `QuickOpen.tsx`（空查询展示最近 + 「最近」徽标） | 手工验证 |
| N22 位置记忆 | 完成 | 每文件 `{line,col,scrollTop}`（localStorage，上限 200）、`Editor.onPosition`、无行号打开时恢复 | UI 用例（切回回到第 11 行） |
| N25 正文可点击 | 完成 | `monaco-setup.ts` 的 `registerLinkProviders` + link opener | UI 用例（悬停路径出现链接） |
| N26 复制位置 | 完成 | `Editor.tsx` 的 `wcr.copyLocation` action、`state.ts` 的 `copyLocation` + 状态栏回显、引用/层级面板行尾 ⧉ | UI 用例（状态栏回显 `已复制 src/util.ts:12:1`） |
| N-δ 顺手打磨 | 完成 | `Ctrl/Cmd+1..7` 切面板、引用面板 Esc/T、kind 过滤、三套文案统一 | UI 用例（键盘路径即走这些快捷键） |

## 9.3 契约与端点变更（实际落地）

**新增端点**（均已登记进 `/api/integration/manifest`）：

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/projects/:id/call-hierarchy` | N16：`{file,line,col,direction,depth}` |
| POST | `/api/projects/:id/type-hierarchy` | N17：显式继承 / 实现双向 |
| POST | `/api/projects/:id/implementations` | N15：接口 / 抽象方法 → 实现 |
| POST | `/api/projects/:id/search-stream` | N12：SSE 按文件推 chunk，可中断 |

**扩展现有契约**：`DefinitionResult.external`、`ReferenceResult.declaration`、`ReferenceLocation.isTest`、
`SearchMatch.isTest`、`SearchOptions.dirs`、`SymbolInfo.isTest`。
**内部模型**：`DefRecord.bases`、`ProjectIndex.defsById` / `heritageOf`。

## 9.4 实现中发现并修掉的两个缺陷（如实记录）

1. **正文链接正则捕获组错位**：`PATH_RE` 只有一段非捕获前缀，取 `m[2]/m[3]` 会拿到 `undefined`，
   导致 N25 静默失效（provider 被调用但从不产出链接）。已改为 `m[1]/m[2]`，并由 UI 用例守住。
   教训：这类"provider 被调用了所以看起来没问题"的失败，必须有端到端断言（悬停出 `.detected-link`）。
2. **光标停在行首时面板全空**：`goto-definition` / `find-references` 以光标命中的词为准，
   而用户常把光标停在行首。面板改为先用符号树把光标**就近吸附**到该行的符号（`state.ts` 的 `snapToSymbol`），
   不猜语义、只做位置翻译。

## 9.5 与 §8「完美判据」的逐条核对

| 判据 | 核对 |
|---|---|
| 1. F12 永远不沉默、失败必有下一步 | ✔ 四类结论各有文案；external 给「跳到 import 行」、unresolved 给「搜 xxx」、no-symbol 走状态栏轻提示、indexing 只解释 |
| 2. 每次跳转可解释 | ✔ 为什么跳/没跳、外部依赖是谁引入的、索引是否在跑，都在提示条或状态栏给出 |
| 3. 引用不离编辑器 / 可摊开走完 | ✔ 侧栏常驻面板 + 键盘上下/Enter/Esc/T |
| 4. 调用链双向且诚实报告覆盖 | ✔ in/out 双向、深度 1~3、底部固定显示「已解析/未归属/外部」 |
| 5. 标签、最近、位置记忆三层都在 | ✔ |
| 6. 每处位置可点（含复制 `path:line:col`） | ✔ 可点已具备；光标处与面板每一行都有「复制位置」（编辑器内 `Ctrl/Cmd+Alt+C`，行尾 ⧉），状态栏回显 |
| 7. 不上传、不写被读目录、可导出 | ✔ 书签/位置/历史只写 `localStorage`；书签可导出 JSON |
| 8. 自动化守着 | ✔ 94 单测 + 19 UI 用例（`npm run test:ui` 已入脚本：跳转失败提示、引用面板、调用/类型层级、分屏、书签、位置记忆、后退、正文链接、面包屑同级、搜索历史、最近打开、复制位置） |

## 9.6 明确不做（与 `03-navigator.md` §6 边界同源）

导航范围内能想到但**不做**的事，都与 §6 边界表一一对应；不在文档里留「待办」形式的遗留。

| 不做 | 理由 |
|---|---|
| 类继承里的方法级重写/覆盖 | N15 已给「接口方法 → 实现类的方法」；谁重写了谁、虚方法分派必须做类型推断（底座边界） |
| 位置记忆的跨设备同步 | 引入账号/上传，违反只读与本机承诺 |
| 搜索进度百分比 | 验收信号「能停 + 边出边看」已满足；百分比需后端逐文件发事件，成本高于收益 |
| 提示条展示索引版本号 | 内部实现细节；用户要的「索引中/就绪」已在状态栏 |
| 「你可能想去哪」式推荐 | 属向导（04）主题 |

## 9.7 复现方式

```bash
npm run typecheck   # 类型检查（前后端）
npm test            # 后端单测 94/94
npm run build       # 前端产物
npm run test:ui     # 浏览器 UI 回归 19/19（自动建/删夹具项目，端口 8799）
```
