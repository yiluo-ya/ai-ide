# 功能与实现细节（web-code-reader）

> 快速上手（安装 / 启动 / 加项目）见 [README](../README.zh-CN.md)。
> 本文是功能清单、API、快捷键与已知限制的完整版 —— 从 README 搬出来，让 README 保持简短。

## 阅读与导航

- 以「本机目录」为单位打开项目（`POST /api/projects`，同一路径复用同一 id）
- 文件树列出**项目全部文件**（含未索引的二进制与资源），目录在前、文件在后、**默认折叠**，
  目录与文件两色；可按时间过滤（全部 / 今天 / 3 天内 / 7 天内）与「孤立」筛选
- 文件树叠加标记：`●` 刚变更（实时闪 20 秒）、热力色块（越亮越新）、`◌` 最近改动、`★` 热点、`?` 孤立
  （2026-10-08 用户要求：去除「加入待读」右键项与「已读 / 待读」标记）
- Monaco 语法高亮、大纲（Ctrl/Cmd+Shift+O）
  （2026-10-08 用户要求：编辑器上方的导航条与面包屑已移除，符号路径改看大纲 / 摘要条）
- 跳转到定义（`F12` / `Ctrl+F12` / Ctrl+Click）、查找引用（`Shift+F12`）、
  **跳不动时不会「什么都没发生」**：提示条给出人话解释 + 下一步动作
  （外部依赖可「跳到 import 行」；解析不了可「搜 xxx」；索引中只解释）
- 搜索：`Ctrl/Cmd+P` 文件、`Ctrl/Cmd+T` 工作区符号、`Ctrl/Cmd+Shift+F` 全项目文本
  （正则 / 大小写 / 整词 / 目录限定 / **流式边出边看**、可随时停止）；「文件」面板的输入框
  同时过滤文件名，输入 ≥4 字会一并搜文件内容（按文件分组）
- 标签页（上限 8，中键或「旁边打开」分屏）、最近打开（Ctrl+P 空查询）、
  位置记忆（切回文件回到上次的行与滚动位置）、前进 / 后退（`Alt+←` / `Alt+→`）
- 编辑器周边：文件摘要条（导出数 / 依赖数 / 被引用数 + 提交历史）、
  三档密度条（代码 / 注释 / 空白，点击跳段）、行级 blame 视图（`Ctrl/Cmd+Alt+B`）、
  只读 diff 浮层（工作区 vs HEAD 或指定 rev）
- 编辑器右键：复制位置（`Ctrl/Cmd+Alt+C`）、复制选中代码（带出处）、
  解释这段（`Ctrl/Cmd+Alt+E`）、调用流图
- **结构解释**（未使用模型）：选中 / 所在符号 / 连带调用方三档范围，给出「它调用了谁 / 谁调用它 /
  引用了本项目哪些定义 / 依赖哪些外部模块」+ 覆盖率，固定标注「结构性解释 · 未使用模型」
- **调用流视图**：从一个符号展开调用链（正向 / 反向 / 数据流）、深度 1~3；
  数据流只做**名字级近似**（虚线 + 「近似」标注），不做类型推断

## 项目地图（概览 / 依赖图 / 时间与来源）

打开项目且未选文件时，主区就是**项目地图**（主区顶行「总览」按钮、右栏「总览」tab 也能进）：

| 区域 | 内容 | 口径 |
|---|---|---|
| 它是什么 | 语言分布、文件 / 目录 / 字节 / 行数、包名与脚本、README 原文折叠 | 索引与文件系统的实际计数；**每个数字点开就能列出构成**，悬浮可看口径 |
| 从哪看起 | 入口候选（命名启发 + `__main__` / Go main 包 / Java main 方法 / 包清单声明的入口，**每条附命中依据**）+ 热点榜 | 热点六档口径：被引用文件数 / 被引用条目数 / 符号被引用数 / 定义数 / 独有依赖 / 新近度；测试与示例默认降噪 |
| 结构 | 循环依赖（Tarjan SCC）、孤立文件（入度为 0 且非入口 / 非文档 / 非测试）、最大文件、目录职责与分层、复杂度 | 分层按职责（入口 / 领域 / 基础设施 / 工具）+ 依赖方向判，每条附依据；职责只截原文，拿不到就给事实句（不生成） |
| 最近 | 今天 / 3 天 / 7 天改动计数、最近文件、git 提交批次 | 时间来自文件 mtime；批次来自只读 `git log` |

**索引没跑完也不阻塞**：此时显示「这是部分地图 + 进度」，并说明此刻能信什么、什么还在长；
绝不把「还没索引到」显示成 0。

**依赖图**（概览右上「看依赖图 →」）：默认**目录级聚合 + 职责泳道**（可切自由力导向），
单击目录节点展开到文件级；被提到文件级的入口 / 热点始终可见；外部依赖作为聚合节点（默认 Top 20）；
环上的边与节点高亮。右侧面板随选中对象切换：**目录** → 职责一句话 + 目录级反向依赖
（谁依赖它 / 它依赖谁 / 传递上游 / 关键文件）+ 分层依据；**文件** → 顶层符号（点符号定位到该行）
+ 反向依赖（直接引用 / 传递上游 / 覆盖它的测试）；**外部依赖** → 只说明不跳转。

**地图可以被带走**：视图会写进 URL（`view` / `tab` / `hot` / `denoise` / `graph` / `glevel` /
`gexpand` / `glayout` / `gext`），导航栏有「复制地图链接」，打开即复原。

**时间与来源**：只读 git（最近提交 / 未提交改动）+ 文件 mtime 热力叠加在文件树上。
宿主仍可用 `POST /api/projects/:id/origin` 上报「本轮 agent 产出的文件（及行范围）」、
用 `GET /api/projects/:id/agent-lines` 取回 —— 但**当前界面不再画 agent 产出标记**
（2026-10-03 用户要求去掉），接口保留给宿主集成使用。

## 右栏 dock：变更 / 命令 / 总览

**变更**（默认 tab）——以 git 为准，不做自记录的基线对比：

- 数据来自只读 `git status --porcelain -uall` + `git diff --numstat HEAD`（上限 500 条）
- 文件行显示状态徽标（M / A / D / R / C）+ 增删行数，点文件名打开、点行数开只读 diff；
  可「平铺 ↔ 按目录」
- 写操作四个（**仅本机可用**，不经 shell、60s 超时）：`git add -A`、`git commit -m`、
  `git pull --ff-only`、`git push`（push 需二次确认）
- 非 git 仓库：整块如实降级，不伪造

**命令** —— 只讲**当前打开的项目**自己的事（2026-10-03 晚收敛）：

- 「当前项目」：索引状态 + git 分支与未提交改动（每行独立容错，**拿不到的行不出现**）
- 「项目命令」：说一句话（默认提示词已内置）→ 后端起一条**只读** Code Agent 会话读项目，
  得出**编译 / 后台启动 / 后台停止 / 测试**命令（仓库里没有的只给建议，不写文件），
  落盘 `~/.ide/commands/plans/<projectId>.json`，可「重新分析」覆盖；分析过程能在 Agent 面板看那条会话
- 每条命令点「运行 / 后台运行」即**真执行**：一律在项目根、走确认对话框；
  `warn` 级（`rm -rf` / `git push` / `npm publish` / `sudo`…）要在框里额外勾选；
  `block` 级（`rm -rf /`、`mkfs`、fork 炸弹…）按钮禁用且后端直接拒绝
- 前台执行 60s / 200KB 截断；后台交给独立 worker（`bin/run-with-log.mjs`）托管，
  日志实时落 `~/.ide/commands/logs/<runId>.log`
- 「当前项目的后台任务」只列**从面板启动**且仍在跑的进程（pid / 状态 / 耗时 / 日志 / 停止）；
  命令行自己起的服务后端拿不到，如实不显示
- **只在监听本机时可用**（共享模式 403）；运行记录只在内存，后端重启后看不到也停不掉（后台进程本身可能还在跑）

**总览**：项目地图的主要数字（身份卡、语言分布、入口候选与热点、孤立与环、目录职责），
点条目直接在编辑器打开文件。

## Code Agent（可选）

工具条左栏「code 会话」把主区切成 Agent 模式 —— **左栏管会话、中间看内容**，
说人话让它读 / 改 / 生成代码；点「回到代码」即切回阅读模式（同一个页面，不是新窗口）。
不进这个模式就不会有任何模型请求。

- 内置一个**最简** agent：**一个循环 + 一个工具包**（不放 skill、不接 MCP、无沙箱），
  参考 pi 的最核心部分；循环就是「调模型 → 有工具就执行 → 结果回灌 → 再调」，事件流式推给界面
- 工具分两类：**索引类**（`find_symbol` / `goto_definition` / `find_references` /
  `file_outline` / `search_text`）复用 `/api/agent` 的同实现 —— agent 查「定义在哪 / 谁在调用」
  用的是 tree-sitter 索引，不是 grep 猜；**文件类**（`read_file` / `write_file` / `edit_file` /
  `list_dir` / `glob` / `grep`）让它真能改代码。所有文件路径必须落在项目根内，越界直接拒绝
- 会话新建时可挑后端：**内置 agent** / **pi**（本机 `pi --mode rpc --no-session`）/ **OpenHands**
  （占位，调用时给出「怎么接」的指引）；只有内置后端能切模型
- **pi 从哪来**（FR-0007）：源码里不含 pi，按 **设置 → Code Agent 后端** 里填的路径 →
  落点 `~/.ide/agents/pi/` → `PATH` 的顺序找（环境变量 `READER_PI_COMMAND` 优先级最高）；
  两种装法二选一：`npm install -g @earendil-works/pi-coding-agent`（进 PATH），或
  `npm install --prefix ~/.ide/agents/pi @earendil-works/pi-coding-agent`（进落点，不用改 PATH）；
  都找不到时，新建 pi 会话会把落点路径与这两条命令直接写在报错里（OpenHands 只留位置
  `~/.ide/agents/openhands/`，适配器未接入）
- **适配层**：`backend/src/agent/types.ts` 定接口与归一化事件（事件名沿用 pi 的
  `agent_start` / `message_*` / `tool_execution_*` / `agent_settled`），`adapter.ts` 是工厂；
  接自己的 agent（pi / OpenHands / 自研）只需写一个 `AgentAdapter` 实现 + 在工厂注册，**前端不用改**
- 模型在顶栏「模型」里配（OpenAI 兼容 base URL + API key + 模型 id，可设默认模型）；
  明文 key 只落 `~/.ide/model-config.json`（权限 0o600），界面只回显打码值
- 一轮最多 `READER_AGENT_MAX_STEPS`（默认 24）次工具调用；会话历史只在内存，重启即清
- **会话内容按 Markdown 渲染**（助手正文 + 工具结果；工具结果只在带 Markdown 结构或 HTML 文档时渲染，
  其余原样，一键切回源码）：代码块带语言标签与复制按钮；```html 块与 HTML 文档用**沙箱 iframe** 预览
  （`sandbox` 不给 `allow-scripts`，agent 写的脚本不会执行）；顶行「导出 ▾」把当前会话存成 .md 或 .html

## 分享与导出（信使）

主区顶行「分享 ▾」是一个收口，不往工具栏继续堆按钮：

| 做什么 | 怎么用 | 带走的是什么 |
|---|---|---|
| 分享一个位置 | 「复制分享链接」或 `Ctrl/Cmd+Alt+C` | `http://…/?project=…&file=…&line=…&col=…`，打开就落在同一行 |
| 贴一段代码 | 编辑器里选中 → 右键「复制选中代码（带出处）」 | 第一行 `path:行范围`，随后是带语言围栏的代码块 |
| 贴一个接口 | 大纲行尾 ⧉ | `name (kind) path:line:col` + 签名，不贴整段实现 |
| 给同事一份理解 | 「Markdown：当前文件 / 当前搜索结果 / 项目概览」 | 大纲 + **带行号正文** + 着色结论（本项目 vs 外部） |
| 贴进文档 / PR | 「截图 PNG」或「截图并复制到剪贴板」 | 自绘 canvas：行号栏 + 语法色 + 三档语义色 + 底部出处条 |
| 评审前存档 | 「打印 / 存 PDF」 | 打印视图只留代码与页眉（`path:line` + 项目名），黑白可辨 |
| 发给同事 | 「分享给同事」（可访问地址） | 同一台机器 / 局域网内的可访问链接 |
| 给 agent 用 | 「给 agent 用」 | `/api/agent/tools` 工具清单地址，让 agent 查符号而不是 grep 猜 |

**导出不降级**：报告与截图都会保留「哪是本项目符号、哪是外部依赖」这个结论。

## 语义着色（本项目 vs 依赖）

编辑器里按「符号归属」分三档着色，让本项目的代码先跳出来：

| 档位 | 覆盖对象 | 默认色 |
|---|---|---|
| **本项目** | 项目内定义的函数 / 类 / 方法 / 属性 / 常量，以及它们的引用 | `#ffffff` 白色 + 加粗 + 微光 |
| **局部变量** | 函数内的局部变量与参数 | `#cfe2ff` 浅蓝 |
| **外部依赖** | 标准库 / 第三方包 / 内置函数（`os.path.*`、`print`、`process`…） | `#9aa7b6` 灰蓝 |

- 判定依据是后端解析结果（`GET /api/projects/:id/highlights?file=`），不是正则猜的
- **解析不出的成员访问不着色**（如 `obj.method()` 中的 `method`，需要类型推断才能确定），
  保持编辑器语法色 —— 宁可不着色，也不标错；`self` / `this` 保持原色
- 三档颜色是 CSS 变量（`frontend/src/styles.css` 顶部 `--hl-project` / `--hl-local` / `--hl-external`）
- 打开项目后若索引尚未跑完，页面会在收到 `index-ready` 事件时自动补上着色，不需要刷新

## 语言支持（实现细节）

内置语言清单与 `wcr lang` 命令见 [README](../README.zh-CN.md#语言支持)；本节是实现上的约定。

一个插件就是一个 ESM 包：`package.json` 里用 `wcr.lang` 指向入口，入口导出 `spec`（与内置语言同一套
`LanguageSpec`，见 `backend/src/languages/plugin.ts`）。三条发现规则：手放的目录 → `<插件目录>/node_modules`
→ 本仓库 `node_modules`（官方预装包走这条）；同 id 不覆盖，先到先得。**插件加载失败只记错误、不影响启动**
（错误会出现在 `GET /api/languages` 的 `errors` 里）。
前端不再硬编码「扩展名 → 语言 / 语言 → Monaco 语法 · 颜色」：这些由后端 `/api/languages` 下发，
所以新增语言不需要动 `frontend/`（Monaco 自带 81 种语法已随构建产物打包）。快照里有语言集合签名，
语言集变了会自动全量重建索引。

写一个插件时，所有语言按同一把尺子验收 —— 十项能力（高亮、色点、大纲、符号搜索、跳转定义、
查找引用、Hover、跳不动时的人话解释、密度条、签名压平）、三档交付（预览级 / 索引级 / 全功能级）、
自测清单与反面清单，见 [`08-language-plugin-spec.md`](08-language-plugin-spec.md)。
独立仓库 `wcr-lang-cpp` 里的 C / C++ 插件是全功能档的参考实现。

## 底座（性能 / 可靠性）

- **二次打开秒开**：索引快照（NDJSON + gzip，**只存符号事实、不存正文**）落 `~/.ide/index/<id>/`；
  指纹一致时**不重解析、不重写**。实测 1000 文件合成仓：二次打开文件树 **71ms**、符号可跳转 **1.0s**
- **正文按需读盘**：hover / 密度 / 搜索时才读源码，恢复期**零读盘**（懒读带 LRU 缓存）
- **并行解析**：多 worker 解析（`READER_PARSE_WORKERS`，0 = 串行），worker 不可用自动回落串行
- **忽略规则可配置**：内置黑名单 < `.gitignore` < `.wcrignore`（`!` 取反、`**`、`/` 锚定）
  < 设置里的全局自定义规则；`node_modules` / `.git` 不可被打开
- **大文件降级索引**：1–5MB 的源码走「顶层符号模式」（只取顶层定义与导入），仍出现在大纲 / 符号搜索；
  超过 5MB 只做文本查看与文本搜索
- **非 UTF-8 编码**：BOM / UTF-8 / UTF-16 / GBK 探测解码，GBK 中文注释不乱码、符号位置正确
- **一致性对账**：默认每 10 分钟比对索引与磁盘（`READER_VERIFY_MS`），监听漏事件可自愈；`POST /verify` 手动触发
- **增量更新**：chokidar 监听（防抖 300ms），文件改动即时反映到索引与界面
- **monorepo**：tsconfig `paths`/`baseUrl`、`go.work`、Python src 布局 / `package-dir` 都能跨包解析
- **一键启动 / 单实例**：`wcr [目录]` —— 端口被占用自动让位，重复启动复用已有实例
- **设置与 i18n**：顶栏「模型」与「设置」并列；设置分 外观（主题 / 字号 / 侧栏宽 / 语言）、
  编辑器（自动换行 / 缩进 / minimap / 空白字符）、界面（动效减弱 / 变更栏默认展开）、
  索引（自定义忽略规则）、关于（版本 + 快捷键表）。「字号」管到全站，
  **含 code agent 与会话区（左栏会话列表、中间会话内容、Markdown 排版、HTML 预览）**。
  **界面文案全量**走 `frontend/src/i18n/`
  （zh / en 各 1000+ key，默认中文，`<html lang>` 与窗口标题跟随）：加文案 = 往 `zh.ts` / `en.ts`
  各加一条同名 key（组件用 `useI18n().t()`，非组件模块用 `translate()`），
  `npm run test:unit` 会拦两件事 —— 两份词典 key 集合不一致、界面代码里出现硬编码中文文案
- **工程化**：`npm run lint`（ESLint 9，0 error）、`npm run format`、`npm run test:unit`（vitest 38 例 / 6 文件）、
  `.github/workflows/ci.yml`（类型检查 + lint + 后端 / 前端测试 + 构建 + Chromium UI 回归）

## 目录结构

```
backend/src/
  indexer/     parser(tree-sitter 封装) / walker(通用 AST 遍历) / resolver(符号解析) / store(项目索引)
  indexer/insight.ts   项目地图聚合（概览 / 热点 / 孤立 / 环 / 复杂度 / 目录职责分层）
  indexer/graph.ts     依赖图与反向依赖（目录聚合、展开、Tarjan SCC、泳道）
  indexer/timeline.ts  时间与来源（只读 git + mtime）
  indexer/callgraph.ts 调用层级 / 类型层级 / 实现
  indexer/flow.ts / explain.ts / summary.ts   调用流图 / 结构解释 / 文件摘要
  indexer/gitread.ts / gitwrite.ts           只读 git 读数 / 四个写动作
  indexer/ignore.ts / encoding.ts / snapshot.ts / parse-pool.ts / parse-worker.ts   底座
  languages/   python / typescript / go / java / rust（内置核心）
               + loader.ts / plugin.ts（语言插件：发现 · 加载 · 契约）
               markdown / css / html（AST）+ dockerfile / ini / sql（行式扫描）
               manifests.ts（包依赖 / 构建清单 → 只高亮预览，不索引）
  agent/       types.ts(接口与事件) / adapter.ts(工厂) / builtin.ts(内置循环) /
               tools.ts(工具包) / pi.ts(pi 后端) / runtime.ts(pi 定位链) /
               runtime-config.ts(后端路径配置) / openai.ts / model-config.ts / sessions.ts
  commands.ts  命令发现 / 危险分级 / 前台执行 / 后台 worker 托管
  services.ts  阅读器自身的重启 / 停止（独立 worker 代劳）
  api/routes.ts        HTTP 路由
  api/agent.ts         只读 agent 工具（查符号 / 定义 / 引用 / 大纲 / 文本 / 读行范围）
  api/agent-session.ts Code Agent 会话与模型配置路由
  registry.ts / watcher.ts / bootstrap.ts / cli.ts / config.ts / log.ts
frontend/src/
  App.tsx          外壳（顶栏 / 左栏 / 主区 / 右栏 dock 编排）+ 全局快捷键
  TopBar.tsx       顶栏（项目 / 添加项目 / 索引状态 / 模型 / 设置 / 帮助）
  Editor.tsx       Monaco 封装（model 池、只读、定位、位置上报、右键动作、语义着色）
  monaco-setup.ts  worker 环境 + Definition/Reference/DocumentSymbol/Hover/Link Provider
  SidePanel.tsx    大纲 + 引用面板（引用面板已无界面入口）
  FileTree.tsx / FileSearch.tsx / QuickOpen.tsx   文件树 / 文件+内容搜索 / 快速打开
  Overview.tsx / GraphView.tsx / mapApi.ts / mapState.ts   项目地图 / 依赖图 / 地图数据
  ChangesPanel.tsx / changesState.ts                       右栏「变更」（git）
  CommandPanel.tsx / service.css                           右栏「命令」（FR-0005）
  AgentView.tsx / AgentSessions.tsx / agentStore.ts / agentApi.ts   Code Agent
  RichText.tsx / markdown.ts / agentExport.ts                       会话内容渲染（md / html）与会话导出
  ShareMenu.tsx / share.ts / report.ts / snapshot.ts / bridge.ts    分享 / 导出 / 宿主桥
  SettingsPanel.tsx / ModelSettings.tsx / ModelDialog.tsx / prefs.ts  设置 / 模型 / 偏好
  Dialog.tsx / Notice.tsx / Welcome.tsx / FolderBrowser.tsx           对话框 / 提示条 / 首屏 / 目录选择
  i18n/            zh.ts / en.ts / index.ts（中英文文案）
shared/types.ts    前后端共享的 API 契约（位置统一 1-based、列按 UTF-16）
```

## API

`GET /api/integration/manifest` 是能力自述（含深链模板与端点清单），宿主可据此自协商。
所有路径都按项目根校验，越界请求返回 400。标 **本机** 的路由在共享模式下返回 403。

### 基础 / 设置

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 存活检查（版本、是否共享模式、分享提示） |
| GET | `/api/integration/manifest` | 能力自述（端点表 / agentTools / 深链模板） |
| GET / POST | `/api/settings/ignore` | 读 / 写全局自定义忽略规则 |
| GET / POST | `/api/settings/agent` | 读 / 写 Code Agent 后端（pi 路径、来源、版本、落点与安装命令）；POST 共享模式 403 |

### 项目与文件

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/projects` | 项目列表 |
| POST | `/api/projects` | `{ root, name?, id? }` 打开 / 注册本机目录（同一 root 复用同一 id） |
| GET | `/api/projects/lookup?root=` | 按本机路径查项目（宿主集成用） |
| GET | `/api/projects/:id` | 项目信息 |
| DELETE | `/api/projects/:id` | 从列表移除（**不删磁盘文件**） |
| POST | `/api/projects/:id/reindex` | 全量重建索引 |
| GET | `/api/projects/:id/status` | 索引状态 |
| GET | `/api/projects/:id/ignore` | 生效的忽略规则与命中统计 |
| GET | `/api/projects/:id/snapshot` | 索引快照状态（是否存在 / 指纹是否命中 / 落盘目录） |
| POST | `/api/projects/:id/verify` | 立即对账并自愈（added / changed / deleted） |
| GET | `/api/projects/:id/files` | 可索引文件的文件树 |
| GET | `/api/projects/:id/all-files` | 全部文件树（含二进制 / 资源 / 被忽略） |
| GET | `/api/projects/:id/file?path=` | 文件正文（二进制 415、过大 413） |
| GET | `/api/fs/dirs?path=` | 目录选择器（**本机**，共享模式 403） |

### 代码智能（导航）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/projects/:id/goto-definition` | `{ file, line, col }` → `{ locations, reason, symbol, external? }` |
| POST | `/api/projects/:id/find-references` | `{ file, line, col, includeDeclaration? }` → 引用列表（含 `isTest` 标注） |
| GET | `/api/projects/:id/document-symbols?file=` | 文件内符号树 |
| GET | `/api/projects/:id/workspace-symbols?q=&kind=&limit=` | 工作区符号搜索 |
| POST | `/api/projects/:id/search` | 文本搜索（`options.dirs` 可限定目录） |
| POST | `/api/projects/:id/search-stream` | 同 search，SSE 按文件推 chunk（可中断） |
| POST | `/api/projects/:id/call-hierarchy` | `{ file, line, col, direction: 'in' \| 'out', depth: 1~3 }` |
| POST | `/api/projects/:id/type-hierarchy` | 显式继承 / 实现双向 + 无法定位的基名 |
| POST | `/api/projects/:id/implementations` | 接口 / 抽象方法的实现清单 |
| POST | `/api/projects/:id/hover` | 悬停解释（定义 / 字面量 / 失败态） |
| GET | `/api/projects/:id/density?file=` | 整文件密度（每 20 行的代码 / 注释 / 空白占比） |
| GET | `/api/projects/:id/highlights?file=` | 三档语义着色数据（`revision` = 索引版本） |
| POST | `/api/projects/:id/explain` | 结构性解释（定位不到 404 `no-symbol`） |
| POST | `/api/projects/:id/flow` | `{ kind: 'calls' \| 'callers' \| 'data', depth }` 调用流 |

`reason` 取值：`resolved`（已解析）/ `external`（外部依赖或内置符号，不跳转）/
`unresolved`（未能解析，通常是类型推断才能确定的调用）/ `no-symbol`（光标处没有符号）。

### 项目地图 / 依赖图

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/projects/:id/overview` | `?hot=files\|refs\|symbols\|defined\|unique\|recent&denoise&limit&files=1` 概览 |
| GET | `/api/projects/:id/graph` | `?level=dir\|file&expand=<目录>&external=<n>&focus=` 依赖图 |
| GET | `/api/projects/:id/dir-dependents` | `?dir=&depth=` 目录级反向依赖 |
| GET | `/api/projects/:id/dependents` | `?file=&depth=` 文件级反向依赖 + 传递上游 + 覆盖测试 |
| GET | `/api/projects/:id/routes` | 四条阅读路线（依赖序 / 入口向下 / 热度序 / 新鲜序） |
| GET | `/api/projects/:id/file-summary?file=` | 文件级结构摘要 |
| GET | `/api/projects/:id/readmap` | 阅读快照数据源（mtime / size / 行数） |

### 变更 / git

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/projects/:id/git-changes` | `git status` + `git diff --numstat HEAD`（上限 500） |
| POST | `/api/projects/:id/git-write` | `{ action: add \| commit \| pull \| push }`（**本机**；push 需 `?confirm=1`） |
| GET | `/api/projects/:id/file-diff?path=&rev=` | 只读 diff（缺省工作区 vs HEAD） |
| GET | `/api/projects/:id/blame?path=` | 行级 blame（>5000 行 / >8MB 截断） |
| GET | `/api/projects/:id/file-history?path=&limit=` | 提交历史（`--follow`） |
| GET | `/api/projects/:id/git-show?rev=&path=` | 历史版本正文 |
| POST | `/api/projects/:id/changes` | `{ at, files }` → 变更清单（M / A / D） |
| GET | `/api/projects/:id/timeline` | `?window=<分钟>` 时间与来源（git 批次 + mtime 分组） |
| POST | `/api/projects/:id/origin` | 宿主上报「本轮 agent 产出的文件 / 行范围」 |
| GET | `/api/projects/:id/agent-lines?file=` | 该文件被宿主声明的 agent 变更行 |

### 命令与服务（**本机专用**）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/projects/:id/commands` | 该项目已存的命令清单（没分析过为 null） |
| POST | `/api/projects/:id/commands/discover` | `{ prompt }` 只读 agent 读项目得出命令（默认 180s） |
| POST | `/api/projects/:id/commands/run?confirm=1` | `{ command, kind?, background? }` 在项目根执行 |
| POST | `/api/projects/:id/commands/stop` | `{ runId }` 停掉一条后台运行 |
| GET | `/api/projects/:id/commands/runs` | 运行记录（运行中的后台任务带日志尾部） |
| GET | `/api/projects/:id/commands/risk?command=` | 危险级别（`none` / `warn` / `block`）与原因 |
| GET | `/api/service/status` | 阅读器自身的 pid / 端口 / 运行时长 |
| POST | `/api/service/restart` / `/api/service/stop` | 重启 / 停止阅读器（`?confirm=1`，独立 worker 代劳） |

### Code Agent 与只读工具

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/agent/tools` | 只读工具清单（名字 / 说明 / 参数 schema / 端点） |
| POST | `/api/agent/:id/call` | `{ tool, args }` 统一调用（全局工具把 `:id` 传 `_`） |
| GET | `/api/agent/:id/symbols?q=&kind=&limit=` | 便捷入口：按名字找符号定义 |
| GET | `/api/agent/:id/outline?file=` | 便捷入口：文件大纲 |
| GET | `/api/agent/:id/file?path=&start=&end=` | 便捷入口：读行范围（默认上限 400 行） |
| GET / POST | `/api/agent/model-config` | 模型 provider 列表（key 打码）/ 新增或更新 |
| POST | `/api/agent/model-config/remove` | 删除 provider |
| POST | `/api/agent/model-config/default` | 设 / 清默认模型 |
| GET / POST | `/api/agent/sessions` | 会话列表 / 新建（`{ projectId, name?, backend?, provider?, modelId?, readOnly? }`） |
| GET / DELETE | `/api/agent/sessions/:id` | 会话详情 / 删除 |
| GET | `/api/agent/sessions/:id/messages` | 会话历史 |
| POST | `/api/agent/sessions/:id/prompt` | 发一条消息（进度走 SSE） |
| POST | `/api/agent/sessions/:id/abort` / `/model` / `/rename` | 中止本轮 / 换模型 / 重命名 |
| GET | `/api/agent/sessions/:id/events` | SSE：`session_state`、`agent_start`、`message_*`、`tool_execution_*`、`agent_settled` |

### 生命周期

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/projects/:id/events` | SSE：`status` / `file-changed` / `file-deleted` / `index-ready` |
| GET | `/api/projects/:id/resources` | 资源视图 `{ watcher, streams, indexed, filesIndexed }` |
| POST | `/api/projects/:id/dispose` | 释放资源：关 watcher、断 SSE、释放内存索引；**保留注册表条目**、不碰磁盘（幂等） |

## 接入（给 xchen 等项目列表宿主）

1. **打开项目**：`POST /api/projects { root }`，或 `GET /api/projects/lookup?root=` 先查；
   同一目录永远得到同一个 id，宿主可以把 id 存进自己的项目列表。
2. **跳到某个位置**：内嵌 `/?project=<id>&file=<相对路径>&line=<n>&col=<n>`，
   或向 iframe 发 `postMessage({ type: 'wcr:open', root, file, line, col })`。
3. **双向握手**（阅读器回发时 `targetOrigin` 用具体来源，不是 `*`）：

   | 方向 | 消息 | 时机 / 内容 |
   |---|---|---|
   | 阅读器 → 宿主 | `wcr:ready` | 项目就绪或索引进度变化：`{ projectId, projectName, status }` |
   | 阅读器 → 宿主 | `wcr:state` | 换文件**立即**发、光标后防抖发：`{ projectId, file, line, col, selection? }` |
   | 阅读器 → 宿主 | `wcr:bye` | 已按宿主要求释放资源：`{ projectId, stoppedWatcher, releasedIndex, closedStreams, kept }` |
   | 宿主 → 阅读器 | `wcr:dispose` | 收起面板：阅读器调 `POST /api/projects/:id/dispose`，然后回 `wcr:bye` |

   释放语义：关 watcher、断该项目 SSE、释放内存索引，**保留注册表条目**（宿主再打开不用重新注册，
   索引会自动重建）；被读目录里的文件一个都不动。资源清得干不干净用
   `GET /api/projects/:id/resources` 核对。
4. **信任边界（默认收紧）**：只处理来源在**白名单**里的消息，白名单 = 同源 +
   iframe URL 上的 `?hostOrigin=https://host.example`（可逗号分隔）+ 阅读器里登记过的宿主源；
   调试需要完全放开时用 `?hostOrigin=*`（显式选择，不是默认）。
5. **CORS** 默认放开；收紧时设 `READER_CORS_ORIGIN=a.com,b.com`。
6. **agent 工具**：`GET /api/agent/tools` 拿清单，`POST /api/agent/<projectId>/call { tool, args }` 调用；
   返回的是**符号级**答案（`file` / `line` / 解析 `reason`），解析不出如实返回 `unresolved`，不会编造。
7. 页面内可通过 `window.__wcrMonaco` 拿到 Monaco 实例（调试与深度集成用）。

## 快捷键

| 键 | 作用 |
|---|---|
| `F12` / `Ctrl+F12` / Ctrl+Click | 跳转到定义 |
| `Shift+F12` | 查找引用 |
| `Ctrl/Cmd+P` | 快速打开文件（空查询先给最近打开） |
| `Ctrl/Cmd+T` | 工作区符号搜索 |
| `Ctrl/Cmd+Shift+F` | 全项目文本搜索（聚焦搜索面板） |
| `Ctrl/Cmd+Shift+O` | 文件大纲 |
| `Ctrl/Cmd+Shift+E` | 聚焦「文件」面板 |
| `Ctrl/Cmd+Shift+R` | 继续阅读（回到上次离开的文件与行列） |
| `Ctrl/Cmd+1..4` / `Ctrl/Cmd+0` | 切左栏面板（文件 / 大纲 / 搜索 / code 会话）；`0` = 最后一个 |
| `Alt+←` / `Alt+→` | 后退 / 前进 |
| `Ctrl/Cmd+Alt+C` | 复制当前位置 `path:line:col` |
| `Ctrl/Cmd+Alt+E` | 解释光标处的符号（结构性解释，不用模型） |
| `Ctrl/Cmd+Alt+B` | 切换整文件 blame 视图 |
| `Ctrl/Cmd+,` | 打开设置 |
| `Ctrl/Cmd+F12` / 编辑器右键 | 部分浏览器会占用 `F12` / `Shift+F12`，可用等价路径 |
| 标签条中键 | 在旁边分屏打开 |

`Ctrl/Cmd+F`（文件内查找）与 `Ctrl/Cmd+G`（跳到行）是 Monaco 内建行为。
页面右上角 `?` 里有完整清单与三档着色说明。

## 已知限制

- **不做类型推断**：`obj.method()` 里的 `obj` 是局部变量时无法确定其类型，只有模块 / 包 / 类限定名
  （`os.path.join`、`pkg.Func`、`Foo.bar`、`self.x` / `this.x`）能跨文件解析。真实项目抽样中约
  **53% 的引用能精确跳转，31% 被正确标为外部依赖**，其余 16% 属于上述需要类型推断的情形。
- 依赖包内部（node_modules / site-packages 等）不建索引，命中即标 `external`。
- `require('...')` 形式的 CommonJS 导入不解析（ESM `import` 正常）。
- 超过 1MB（且 ≤5MB）的源码文件走**降级索引**：只取顶层定义与导入（没有引用与字面量）；
  超过 5MB 只做文本查看与文本搜索。降级与跳过的理由都在索引报告里可见。
- 索引**有快照但不落正文**（`~/.ide/index/<id>/snapshot.ndjson.gz`），正文按需读盘。
  二次打开实测（1000 文件合成仓）：文件树 71ms、符号可跳转 1.0s；
  **万级文件**（10k 实测）文件树 0.48s、符号可跳转 11.5s —— 瓶颈是 18 万条记录的 JSON 解析，
  下一步用列式二进制格式（见 `docs/06-platform-plan.md` §8）。
- **首次 `overview` 约 2~3 秒**（191 文件真实仓库实测 3.1s）：概览要把全项目引用解析一遍，
  结果按索引版本缓存，之后同版本的 `overview` / `graph` / `dependents` 都是毫秒级；
  任何文件改动会让缓存失效、下次重新计算。
- **git 的边界**：读数只用六个**只读**命令（`log` / `status` / `rev-parse` / `diff` / `blame` / `show`，
  数组传参、不经 shell、带超时）；写操作只有变更栏那四个（`add` / `commit` / `pull --ff-only` / `push`，
  本机专用、push 再确认）。不是 git 仓库时自动降级：时间看文件 mtime，变更栏整块不出现。
- **导航的范围边界**：调用层级的完整性上限 = 引用解析率；类型层级只看源码里**显式写出**的
  `extends` / `implements` / 嵌入字段，动态注册与鸭子类型不覆盖（界面上如实标注，不伪造边）。
- **本机数据只写两处**：浏览器 `localStorage`（偏好 `wcr:prefs`、按项目分片的位置记忆、搜索历史、
  宿主白名单）与 `~/.ide/`（项目列表、索引快照、模型配置、命令计划与日志）。
  代价是换机器就丢偏好。（2026-10-08 用户要求清除「已读 / 待读」：旧标记与待读队列已不再读写）
- **已移除的界面入口（组件与后端接口保留）**：向导、引用面板、调用层级 / 类型层级 ——
  2026-10-03 用户要求「只删界面入口与 tab」；对应能力仍可通过 API 使用
  （`/routes`、`/find-references`、`/call-hierarchy`、`/type-hierarchy`、`/explain`、`/flow`）。
  文件树也不再显示「已读 / 未读 / agent 产出」标记（`POST /origin` 与 `/agent-lines` 接口保留）。
  **2026-10-08 用户要求清除「已读 / 待读」**：不再判断「打开即已读」、不再有已读进度与「标记已读 / 全标已读」、
  不再有「加入待读」入口与待读清单（相关 localStorage 旧数据启动时一并清掉）。
- **Code Agent 的范围边界**：
  - 它会**写项目文件** —— 这是工具里会写被读目录的入口之一；所有写路径必须落在项目根内，
    越界直接拒绝（400 `path_escape`）。
  - **内置 agent 不执行命令**（工具包里没有 bash）；要跑测试 / 装依赖用命令面板，或选 pi 后端
    （pi 的能力边界 = pi 自己的能力边界，它会执行命令、按需读写文件）。
  - **会话历史只在内存**：重启后端即清，也不跨项目共享。
  - **明文 key 落盘**：`~/.ide/model-config.json`（0o600；Windows 上 chmod 基本无效，靠目录权限）。
  - 助手正文按 Markdown 渲染、工具结果按需渲染（可切回源码）；thinking 与工具调用可折叠；一个会话同一时刻只跑一轮。
  - HTML 只在**沙箱 iframe** 里预览（不给 `allow-scripts`），导出的 .html 也先清洗 —— 会话里的脚本一概不执行。
  - 没做：权限询问、沙箱、token 预算控制（只有「一轮最多 N 次工具调用」的硬上限）。
- **命令面板的范围边界**：
  - 「分析」发起的是**只读** code agent 会话（工具集里没有 `write_file` / `edit_file`），
    「仓库里没有的命令」只会给建议、不会往仓库写文件。
  - 点「运行 / 后台运行」是**真执行**（项目根 + 二次确认）；warn 级要额外勾选，block 级后端直接拒绝。
  - 只在监听本机时可用（共享模式 403）；**运行记录只在内存**，后端重启后既看不到也停不掉
    （后台进程本身可能还在跑）。
  - 面板只讲**当前打开的项目**：拿不到的行直接不出现，不留空占位。
- **分享的范围边界**：只做「同一台机器 / 同一目录」；截图与打印覆盖**当前可见范围**，
  不是整文件分页导出；对外的 `/api/agent/tools` 仍**只读**（不开改文件、执行命令）。
- **服务命令**：`POST /api/service/restart|stop` 于重启 / 停止**阅读器自身**，只有接口没有界面入口
  （2026-10-03 从命令面板移除，避免把「工具的进程」混进项目视图）；仅本机可用。

## 测试与工程化

```bash
npm test              # 后端全部用例（node:test + tsx，40 个文件）
npm run typecheck     # 前后端类型检查
npm run lint          # ESLint 9（要求 0 error）
npm run format:check  # Prettier 格式检查
npm run test:unit     # 前端单测（vitest，8 文件 / 56 例）
npm run test:ui       # 浏览器 UI 回归（真 Chromium；自建/自删夹具项目，默认端口 8799）
npm run bench         # 性能基准：合成仓首开 / 索引 / 二次打开 / 查询 P50-P95 / 增量
```

UI 回归用例在 `tests/ui/`，由 `run.mjs` 统一起夹具项目与后端：`navigator.mjs`（导航与信使：
文件树默认折叠与两色、Ctrl+P 打开文件与标签条、搜索面板（全屏 / 停止 / 目录归类）、
外部依赖按 F12 的提示条、复制位置、**复制选中代码（带出处）**、**分享深链**、打印视图页眉、
右侧「命令」tab 显示的是当前项目状态、依赖图里文件节点归属目录）、`guide.mjs`（首屏推荐路线、
点「开始阅读」进第 1 步、**变更栏常驻右侧且以 git 为准**（点行尾增删数弹差异）、
解释这段给出结构性解释）、`platform.mjs`（顶栏「模型」与设置并列、设置面板五个分组、
切亮色真的换主题、字号落 `wcr:prefs` 并即时生效、切 English、左栏四个常驻 tab 与右栏
「总览」和变更 / 命令并排、**code 会话区字号跟随「字号」缩放**、「添加项目」弹窗选目录、
全程无 console error）、
`panel.mjs`（左栏四个常驻面板的打开动作）。

后端另有专用用例：`dispose.test.ts`（资源视图 / 释放 / 幂等 / 断 SSE）、
`agent.test.ts`（只读工具清单与各工具）、`agent-builtin.test.ts`（Code Agent：模型配置打码 /
循环真执行工具并写出文件 / 结果回灌 / 错误路径 / 路径越界 / glob 语义，
用本地假的 OpenAI 端点，不需要任何真实 key）、`commands.test.ts`（命令发现 / 风险分级 / 执行）。
CI（`.github/workflows/ci.yml`）在每次 push 与 PR 跑类型检查、lint、后端 / 前端测试、构建与 UI 回归；
`bench` 故意不进 CI（以分钟计），本地或夜间跑。
