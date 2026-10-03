# 网页版代码阅读器（web-code-reader）

浏览器里的代码阅读器：后端用 tree-sitter 建索引，前端用 Monaco 只做渲染与查询，
F12 / Shift+F12 / Ctrl+Shift+O 等 VS Code 习惯的导航全部可用。

定位见 `FR/FR-0002-fr.md`：面向阅读，不做编译、运行、调试、重构与类型检查。

> **2026-10-03 新增：可选的 code-agent。** 阅读器本身不改动磁盘；新增的 **Code Agent 模式**
> （工具条「Agent 对话」）会按你的要求读代码 / 改代码 / 生成代码 —— 这是用户显式要的能力。
> 后端可选：**内置 agent**（用你自己配的 provider，顶栏「模型」里填）或 **本机 pi**
> （`pi --mode rpc`，用 pi 自己的凭证与工具集）。不进这个模式就不会有任何模型请求。
> 下面「能力」与「已知限制」都按这个口径描述。

## 能力

- 以「本机目录」为单位打开项目（不改动磁盘任何文件）
- 文件树 + 文件过滤、Monaco 语法高亮、面包屑、大纲
- 跳转到定义（F12）、查找引用（Shift+F12）、文件大纲（Ctrl+Shift+O）
- 文件搜索（Ctrl+P）、工作区符号搜索（Ctrl+T）、全项目文本搜索（Ctrl+Shift+F，支持正则 / 大小写 / 整词 / 文件名 glob）
- 前进后退（Alt+← / Alt+→）、深链分享（`?project=&file=&line=&col=`）
- 索引进度（SSE 推送）、文件变更增量更新（chokidar 监听）
- **项目地图**：打开项目先看概览（语言分布 / 规模 / 入口候选 + 热点榜 / 孤立文件 / 循环依赖 / 改动热力），
  每个数字都能点开看到构成；条目点一下直接打开文件
- **依赖图**：目录级聚合（默认）与展开到文件级、循环依赖高亮、外部依赖节点；点文件节点看**反向依赖**
  （谁引用了它 / 传递上游 / 覆盖它的测试）
- **时间与来源**：只读 git（最近提交 / 未提交改动）+ 文件 mtime 热力，叠加在文件树上；
  宿主可上报「本轮 agent 产出的文件」（`POST /origin`），树上一眼区分 agent 产出与项目原有
- 语言：Python、TypeScript/TSX、JavaScript/JSX、Go、Java、Rust（每种语言模块独立，加语言 = 加一个 spec 文件）
- **常用文件**（2026-10-03）：Shell（`.sh/.bash/.zsh`）、JSON、YAML、TOML、INI / `.env`、Dockerfile、
  Markdown、CSS / SCSS / Less、HTML、SQL —— 同样有语法高亮、文件大纲（Ctrl+Shift+O）与符号搜索；
  Shell 还能跳转（函数 / 变量、`source` 依赖）。这些格式没有 tree-sitter 语法包的走
  `LanguageSpec.lineSymbols` 行式扫描（Dockerfile / ini·env / SQL），其余走 AST
- **包依赖 / 构建清单**（2026-10-03 追加，**只做高亮与预览**，不进符号索引）：`go.mod`/`go.sum`、
  `requirements*.txt`/`constraints*.txt`、`Pipfile`(`.lock`)、`poetry.lock`/`uv.lock`、`pom.xml`/`*.csproj`/`*.props`/`NuGet.config`、
  `build.gradle`/`*.gradle.kts`/`*.sbt`、`Gemfile`/`*.gemspec`/`*.podspec`、`mix.exs`/`mix.lock`、`Package.swift`、
  `Cargo.lock`/`composer.lock`/`pubspec.lock`、`.npmrc`/`.yarnrc`、`Makefile` —— 语言识别在
  `languages/manifests.ts`（与「可索引的语言」的 `specForFile` 分开），文件树可见、点开即高亮预览，
  不产生符号、不进语言分布与阅读路线
- **导航（03 Navigator）**：
  - 按 F12 **永远不会「什么都没发生」**：跳不动时提示条给出人话解释 + 下一步动作
    （外部依赖可「跳到 import 行」；解析不了可「搜 xxx」；索引中只解释）
  - **引用面板**（侧栏常驻）：按文件分组、声明行与测试文件单独标注、键盘 ↑/↓ + Enter 走完、Esc 回到原点
  - **调用层级**：谁调用我 / 我调用了谁双向、深度 1~3、入口候选标记，底部如实显示覆盖率
  - **类型层级 / 跳到实现**：显式 `extends` / `implements` / Go 嵌入字段双向可见；接口方法 → 实现类
  - 搜索：结果**边出边看**（流式）、可随时停止、按目录归类、可限定目录范围、排除测试、历史下拉
  - 正文里的 `src/api/client.ts` 与反引号符号名**可直接点**（路径先校验存在，避免误跳）
  - **标签页 + 分屏对照**（上限 8，中键 /「旁边打开」分屏）、
    **最近打开**（Ctrl+P 空查询）、**位置记忆**（切回文件回到上次读到的行与滚动位置）、
    **复制位置**（Ctrl/Cmd+Alt+C 或面板行尾 ⧉ → `path:line:col`）
- **信使（05 Share）**：
  - **带得走**：顶栏「分享 ▾」一个下拉收口 —— 复制**带行号的分享链接**、复制**选中代码（带出处）**
    （出处行 + 围栏代码块）、大纲行尾 ⧉ 复制**符号摘要**（名字 + 种类 + 签名 + 位置）
  - **导出**：Markdown 报告（当前文件 / 当前搜索结果 / 项目概览，含大纲、带行号正文、着色结论）、
    截图 PNG（自绘 canvas，保语法色与三档语义色，底部带出处，可复制到剪贴板）、打印友好视图（带页眉）
  - **接得上宿主**：`wcr:open`（跳转）/ `wcr:dispose`（收起面板）→ 回发 `wcr:ready`（就绪 + 索引进度）、
    `wcr:state`（在读哪一行 / 选区）、`wcr:bye`（资源已释放）；消息按**来源白名单**校验
  - **接得上 agent**：只读 HTTP 工具（`/api/agent/tools`）—— 让 agent 查符号 / 定义 / 引用，而不是 grep 猜
- **Code Agent（2026-10-03）**：工具条「Agent 对话」把主区切成 Agent 模式 —— **左栏管会话、中间看内容**，
  说人话让它读 / 改 / 生成代码；点「回到代码」就切回阅读模式（同一个页面，不是新窗口）。
  - 内置一个**最简** agent：**一个循环 + 一个工具包**（不放 skill、不接 MCP、无沙箱），参考 pi 的最核心部分；
    循环就是「调模型 → 有工具就执行 → 结果回灌 → 再调」，事件流式推给界面
  - 工具分两类：**索引类**（`find_symbol` / `goto_definition` / `find_references` / `file_outline` / `search_text`）
    直接复用本项目已有的 `/api/agent` 工具 —— agent 查「定义在哪 / 谁在调用」用的是 tree-sitter 索引，
    不是 grep 猜；**文件类**（`read_file` / `write_file` / `edit_file` / `list_dir` / `glob` / `grep`）让它真能改代码
  - **适配层**：`backend/src/agent/types.ts` 定接口与归一化事件（事件名沿用 pi 的
    `agent_start` / `message_*` / `tool_execution_*` / `agent_settled`），`adapter.ts` 是工厂；
    接自己的 agent（pi / OpenHands / 自研）只需写一个 `AgentAdapter` 实现 + 在工厂注册，**前端不用改**
  - 模型在「设置 → 模型」里配（OpenAI 兼容 base URL + API key + 模型 id，可设默认模型）；
    明文 key 只落 `~/.ide/model-config.json`（权限 0o600），界面只回显打码值
- **向导（04 Guide）**：
  - **第一分钟不空转**：没选文件时的首屏就是项目地图 + 「从这里开始」（入口候选 / 推荐路线 / 继续阅读），
    点「开始阅读」直接进入路线第 1 步
  - **阅读路线**：依赖序（默认，环上文件相邻并标注「互相依赖」）/ 入口向下 / 热度序 / 新鲜序四种，
    每步带一句「为什么是它」；可「上一步 / 下一步」行进、手动重排并存成「我的路线」
  - **读到哪了**：打开即已读（可手动改）、`已读 N / M 个源码文件`进度、待读队列（文件树右键 / 搜索结果行尾 /
    编辑器右键）、`Ctrl/Cmd+Shift+R` 回到上次位置
  - **变更有感**：`自上次阅读以来`对比基线（本机快照；在 git 仓库里叠加 `git diff --numstat` 的增删行），
    标出「你的笔记可能已过期」；只读 diff 浮层、行级 blame（`Ctrl/Cmd+Alt+B`）、文件历史与历史版本只读快照
  - **解释这段（纯静态）**：选中 / 所在符号 / 连带调用方三档范围，给出「它调用了谁 / 谁调用它 / 引用了本项目哪些
    定义 / 依赖哪些外部模块」+ 覆盖率；固定标注「结构性解释 · 未使用模型」
  - **文件摘要条**：导出数 / 依赖数 / 被引用数 + 模板化一句话摘要，标出「基于索引版本 <rev>」
  - **调用流视图**：从一个符号展开调用链（正向 / 反向 / 数据流）、深度 1~3、外部依赖可折叠；
    数据流只做**名字级近似**（虚线 + 「近似」标注），不做类型推断
- **底座（06 Platform）**：
  - **二次打开秒开**：索引快照（NDJSON + gzip，**只存符号事实、不存正文**）落 `~/.ide/index/<id>/`；
    指纹一致时**不重解析、不重写**。实测 1000 文件合成仓：二次打开文件树 **71ms**、符号可跳转 **1.0s**
  - **正文按需读盘**：hover / 密度 / 搜索时才读源码，恢复期**零读盘**（`files/<rel>` 懒读带缓存）
  - **并行解析**：多 worker 解析（`READER_PARSE_WORKERS`，0 = 串行），worker 不可用自动回落串行
  - **忽略规则可配置**：`.gitignore` + `.wcrignore`（`!` 取反、`**`、`/` 锚定；`node_modules` / `.git` 不可被打开）；
    设置面板里还能写一份**全局自定义规则**（对所有项目生效，存 `~/.ide/ignore-user.txt`），保存后重建索引生效
  - **大文件降级索引**：1–5MB 的源码走「顶层符号模式」（只取顶层定义与导入），仍出现在大纲 / 符号搜索里
  - **非 UTF-8 编码**：BOM / UTF-8 / UTF-16 / GBK 探测解码，GBK 中文注释不乱码、符号位置正确
  - **一致性对账**：默认每 10 分钟比对索引与磁盘（`READER_VERIFY_MS`），监听漏事件可自愈；`POST /verify` 手动触发
  - **一键启动 / 单实例**：`wcr [目录]`（或 `npm run cli -- [目录]`）—— 端口被占用自动让位，重复启动复用已有实例
  - **交付两条路径**：`npm pack` 产物可 `npx ./web-code-reader-0.1.0.tgz [目录]`；`Dockerfile` 一条命令起服务
  - **首次引导**：未打开项目时首屏为三步引导（填路径 / 最近项目 / 索引进度）
  - **设置与模型**：顶栏「模型」与「设置」两个入口并列 —— 「模型」里配 code-agent 的 provider；
    「设置」里分 外观（主题 / 字号 / 侧栏宽 / 语言）、编辑器（自动换行 / 缩进宽度 / minimap / 空白字符与参考线）、
    界面（动效减弱 / 变更栏默认展开）、索引（自定义忽略规则）、关于（版本 + 快捷键表）；
    中英文切换；键盘可走完主流程，关键控件带 `aria-*` 与可见焦点
  - **monorepo**：tsconfig `paths`/`baseUrl`、`go.work`、Python src 布局 / `package-dir` 都能跨包解析（不再落 external）
  - **工程化**：`npm run lint`（ESLint 9，0 error）、`npm run format`（Prettier）、`npm run test:unit`（vitest 42 例）、
    `npm run bench`（性能基准对照预算）、`.github/workflows/ci.yml`

## 快速开始

```bash
# 1) 安装依赖（根目录一次装完）
npm run install:all

# 2) 构建前端（后端会直接托管 frontend/dist）
npm run build

# 3) 启动（默认 http://127.0.0.1:8787）
npm start
```

一键启动（自动选端口、重复启动复用已有实例、自动开浏览器）：

```bash
npm run cli -- <本机目录>     # 等价于 npx tsx backend/src/cli.ts <本机目录>
npm run cli -- --help        # 全部选项（--port / --no-open / --no-watch / --workers）
```

### 交付给别人（两条路径，见 `docs/06-platform.md`）

**A. npx / tarball（对方装了 Node）**

```bash
npm run build && npm pack              # 产出 web-code-reader-0.1.0.tgz
npx ./web-code-reader-0.1.0.tgz D:/code/my-project
```

**B. Docker（对方不需要 Node；容器内只读挂载最硬）**

```bash
docker build -t web-code-reader .
docker run --rm -p 8787:8787 -v D:/code:/work:ro web-code-reader
# 浏览器打开 http://127.0.0.1:8787，项目路径填 /work/my-project
```

容器内监听 `0.0.0.0`（否则宿主访问不到），但挂载是 `ro` —— **物理上写不了被读目录**；
`/data` 是容器内的可写卷，只放项目列表与索引快照。

开发模式（前端热更新，`/api` 自动代理到 8787）：

```bash
npm run dev:backend    # 终端 1
npm run dev:frontend   # 终端 2 → http://127.0.0.1:5173
```

打开页面后点「打开本机目录」，填一个绝对路径（如 `D:/code/my-project`）即可。
也可以用深链直接进入某个位置：

```
http://127.0.0.1:8787/?project=<项目id>&file=src/app.py&line=42&col=5
```

环境变量：`PORT`、`HOST`、`READER_DATA_DIR`（项目列表、模型配置、索引快照、命令清单的存放目录，默认用户主目录下的 `.ide/`；老版本的 `<仓库根>/data` 会在启动时自动复制过去，只复制不删）、
`READER_CORS_ORIGIN`（默认 `*`，可写逗号分隔白名单）、`READER_WATCH=0`（关闭文件监听）、
`READER_PERSIST=0`（关闭索引快照持久化）、`READER_PARSE_WORKERS`（解析 worker 数，0 = 串行）、
`READER_VERIFY_MS`（索引对账间隔，0 = 关闭）、`READER_IGNORE_BUILTIN=0`（关闭内置忽略黑名单）、
`READER_USER_IGNORE`（自定义忽略规则文件路径，默认 `~/.ide/ignore-user.txt`）、
`READER_LOG_LEVEL=error|warn|info|debug`、`READER_LOG_FILE=<路径>`（可选，同时落日志文件）。

**同机同目录分享（S5a）**：默认只监听 `127.0.0.1`（只有本机能开）。想让同一台机器上的同事也能读，
用 `HOST=0.0.0.0 npm start` 重启 —— 启动日志会打印可分享地址（`http://<本机IP>:8787/?project=<id>`），
同一局域网内的人打开链接即可阅读；担心来源时用 `READER_CORS_ORIGIN=https://host-a,https://host-b` 收紧。

## 目录结构

```
backend/src/
  indexer/     parser(tree-sitter 封装) / walker(通用 AST 遍历) / scope 与 resolver(符号解析) / store(项目索引)
  indexer/insight.ts   项目地图聚合（概览 / 热点 / 孤立 / 环 / 复杂度）
  indexer/graph.ts     依赖图与反向依赖（目录聚合、展开、Tarjan SCC）
  indexer/timeline.ts  时间与来源（只读 git + mtime + 宿主上报）
  languages/   python.ts / typescript.ts / go.ts / java.ts / rust.ts（每语言：定义·引用提取 + 模块说明符解析）
               shell.ts / json.ts / yaml.ts / toml.ts / markdown.ts / css.ts / html.ts / ini.ts / dockerfile.ts / sql.ts
               （常用文件；后三者用 lineSymbols 行式扫描）
               manifests.ts（包依赖 / 构建清单 → 着色语言，只高亮预览不索引）
  indexer/ignore.ts / encoding.ts / snapshot.ts / parse-pool.ts / parse-worker.ts / index-report.ts
               底座（06）：忽略规则 / 编码探测 / 索引快照（NDJSON+gzip，不含正文）/ 并行解析 / 索引报告
  cli.ts / bootstrap.ts  一键启动、自动选端口、单实例复用、浏览器唤起
  log.ts        结构化日志（key=value；READER_LOG_LEVEL / READER_LOG_FILE）
  api/routes.ts HTTP 路由
  api/agent.ts  agent 只读工具（find_symbol / goto_definition / find_references / file_outline / search_text / read_file / list_projects / index_project）
  registry.ts  项目注册表（以本机目录为单位，持久化到 ~/.ide/projects.json；含 dispose 资源释放）
  watcher.ts   文件监听 + 防抖 + 增量更新
frontend/src/
  Editor.tsx        Monaco 封装（model 池、只读、定位、位置上报）
  monaco-setup.ts   worker 环境 + Definition/Reference/DocumentSymbol/Hover/Link Provider 注册
  SidePanel.tsx     大纲 + 引用面板 + 搜索面板（容器无关：侧栏 / 全屏）
  NavPanels.tsx     调用层级 / 类型层级 + 实现清单（N16/N17/N15）
  Notice.tsx        跳转失败提示条（N2：解释 + 动作）
  state.ts          zustand 状态（项目、文件、标签、位置记忆、流式搜索、引用/层级）
  Overview.tsx      项目地图首页 + 「总览」面板（右侧常驻栏，含 overview.css）
  GraphView.tsx     依赖图画布（d3-force 静态布局 + 反向依赖面板，含 graph.css）
  mapApi.ts / mapState.ts  地图的请求与状态（含已读 / 忽略标记，localStorage）
  FileTree.tsx / QuickOpen.tsx / TopBar.tsx
  share.ts / report.ts / snapshot.ts  信使（05）：位置·片段格式化 / Markdown 报告 / 自绘代码截图
  bridge.ts / ShareMenu.tsx  宿主双向桥（wcr:* 消息、来源白名单）+ 分享菜单
  state.ts          zustand 状态（项目、文件、符号、历史、搜索）
shared/types.ts     前后端共享的 API 契约（位置统一 1-based、列按 UTF-16）
```

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 存活检查 |
| GET | `/api/integration/manifest` | 能力自述（含深链模板与端点清单） |
| GET | `/api/projects` | 项目列表 |
| POST | `/api/projects` | `{ root, name?, id? }` 打开/注册本机目录（同一 root 复用同一 id） |
| GET | `/api/projects/lookup?root=<绝对路径>` | 按本机路径查项目（宿主集成用） |
| DELETE | `/api/projects/:id` | 从列表移除（**不删磁盘文件**） |
| POST | `/api/projects/:id/reindex` | 全量重建索引 |
| GET | `/api/projects/:id/status` | 索引状态 |
| GET | `/api/projects/:id/files` | 文件树 |
| GET | `/api/projects/:id/file?path=<相对路径>` | 文件正文（含语言 id） |
| POST | `/api/projects/:id/goto-definition` | `{ file, line, col }` → `{ locations, reason, symbol, external? }`（`external` 给模块名与 import 位置） |
| POST | `/api/projects/:id/find-references` | `{ file, line, col, includeDeclaration? }` → 引用列表（含 `isTest` 标注与 `declaration`） |
| GET | `/api/projects/:id/document-symbols?file=` | 文件内符号树 |
| GET | `/api/projects/:id/workspace-symbols?q=&kind=&limit=` | 工作区符号搜索 |
| POST | `/api/projects/:id/search` | `{ query, options }` 文本搜索（`options.dirs` 可限定目录） |
| POST | `/api/projects/:id/search-stream` | 同 search，但 SSE 按文件推 chunk（结果边出边看，可中断） |
| POST | `/api/projects/:id/call-hierarchy` | `{ file, line, col, direction: 'in'\|'out', depth: 1~3 }` → 调用层级树 + 覆盖率 |
| POST | `/api/projects/:id/type-hierarchy` | `{ file, line, col }` → 显式继承 / 实现双向 + 无法定位的基名 |
| POST | `/api/projects/:id/implementations` | `{ file, line, col }` → 接口 / 抽象方法的实现清单 |
| GET | `/api/projects/:id/overview` | 项目概览：`?hot=files\|refs\|symbols\|defined\|unique\|recent&denoise=0\|1&limit=&files=1` → 身份卡 / 语言分布 / 入口候选 + 热点 / 孤立 / 环 / 目录职责 / 口径表 / 索引进度（`files=1` 时附全量文件事实，供「点数字列构成」） |
| GET | `/api/projects/:id/graph` | 依赖图：`?level=dir|file&expand=<目录,目录>&external=<n>`（目录级默认，`expand` 展开到文件级，`external` 是外部依赖节点数） |
| GET | `/api/projects/:id/dependents` | 反向依赖：`?file=&depth=` → 谁直接引用了它 / 传递上游 / 覆盖它的测试 |
| GET | `/api/projects/:id/dir-dependents` | 目录级反向依赖：`?dir=&depth=` → 谁依赖这个目录 / 它依赖谁 / 传递上游 / 关键文件 |
| GET | `/api/projects/:id/timeline` | 时间与来源：`?window=<分钟>` → 只读 git 批次 + mtime 分组 + 每文件 origin 与置信度 |
| POST | `/api/projects/:id/origin` | `{ files: [路径] \| [{ file, lines: [[起,止]] }], clear? }` 宿主上报「本轮 agent 产出的文件（及行范围）」——唯一可信的 AI 标记来源 |
| GET | `/api/projects/:id/agent-lines` | `?file=` → 该文件被宿主声明的 agent 变更行（编辑器据此画行标记；没上报就是空） |
| POST | `/api/projects/:id/hover` | `{ file, line, col }` → 悬停解释（定义 / 字面量 / 失败态） |
| GET | `/api/projects/:id/density?file=<相对路径>` | 整文件密度（每 20 行一段的代码 / 注释 / 空白占比） |
| GET | `/api/projects/:id/events` | SSE：`status` / `file-changed` / `file-deleted` / `index-ready` |
| GET | `/api/projects/:id/ignore` | 忽略规则（P8）：生效的 `.gitignore` / `.wcrignore`、规则数、命中数、被 `!` 找回的路径 |
| GET | `/api/settings/ignore` | 自定义忽略规则（全局）：读 `~/.ide/ignore-user.txt` 的文本 |
| POST | `/api/settings/ignore` | `{ text }` 保存自定义忽略规则（对所有项目生效，需重建索引） |
| GET | `/api/projects/:id/snapshot` | 索引快照状态（P4）：是否存在 / 写入时间 / 文件数 / schema / 指纹是否命中 / 落盘目录 |
| POST | `/api/projects/:id/verify` | 对账（P7）：重新比对索引与磁盘，返回 added / changed / deleted 并自动修复 |
| GET | `/api/projects/:id/resources` | S9c：资源视图 `{ watcher, streams, indexed, filesIndexed }`（宿主自证「没有残留」） |
| POST | `/api/projects/:id/dispose` | S9c：收起面板时释放资源 —— 关 watcher、断该项目的 SSE、释放内存索引；**保留注册表条目**、不碰磁盘（幂等） |
| GET | `/api/agent/tools` | S8：agent 工具清单（名字 / 说明 / 参数 schema / 端点） |
| POST | `/api/agent/:id/call` | S8：`{ tool, args }` 统一调用（全局工具把 `:id` 传 `_`）；未知工具 400 |
| GET | `/api/agent/:id/symbols?q=&kind=&limit=` | S8 便捷入口：按名字找符号定义 |
| GET | `/api/agent/:id/outline?file=` | S8 便捷入口：文件大纲 |
| GET | `/api/agent/:id/file?path=&start=&end=` | S8 便捷入口：读指定行范围（默认上限 400 行，超出置 `truncated`） |
| GET | `/api/agent/model-config` | Code Agent 的模型 provider 列表（key 打码）+ 默认模型 |
| POST | `/api/agent/model-config` | `{ id?, name?, baseUrl, apiKey?, models? }` 新增 / 更新 provider（不传 `apiKey` 就沿用原值） |
| POST | `/api/agent/model-config/remove` | `{ id }` 删除 provider |
| POST | `/api/agent/model-config/default` | `{ provider, modelId }` 设默认模型；`{ clear: true }` 取消 |
| GET | `/api/agent/sessions` | Code Agent 会话列表 |
| POST | `/api/agent/sessions` | `{ projectId, name?, backend?, provider?, modelId? }` 起一个会话（当前只实现 `backend: 'builtin'`） |
| DELETE | `/api/agent/sessions/:id` | 结束并移除会话 |
| GET | `/api/agent/sessions/:id/messages` | 会话历史（`user` / `assistant` / `toolResult`） |
| POST | `/api/agent/sessions/:id/prompt` | `{ message }` 发一条消息（进度走 SSE，不等整轮跑完） |
| POST | `/api/agent/sessions/:id/abort` | 中止当前一轮 |
| POST | `/api/agent/sessions/:id/model` | `{ provider, modelId }` 换这个会话的模型 |
| GET | `/api/agent/sessions/:id/events` | SSE：`session_state` 起手一发，随后 `agent_start` / `message_start\|update\|end` / `tool_execution_start\|end` / `agent_settled` |
| GET | `/api/projects/:id/commands` | 命令面板：该项目已存的命令清单（没分析过为 null） |
| POST | `/api/projects/:id/commands/discover` | `{ prompt }` 让**只读**的 code agent 读项目，得出编译 / 启动 / 停止 / 测试命令（默认 180s 上限） |
| POST | `/api/projects/:id/commands/run?confirm=1` | `{ command, kind?, background? }` 在项目根执行；自毁级命令 400 拒绝 |
| POST | `/api/projects/:id/commands/stop` | `{ runId }` 停掉一条后台运行 |
| GET | `/api/projects/:id/commands/runs` | 运行记录（运行中的后台任务带日志尾部） |
| GET | `/api/projects/:id/commands/risk?command=` | 危险级别（`none` / `warn` / `block`）与原因 |

`reason` 取值：`resolved`（已解析）/ `external`（外部依赖或内置符号，不跳转）/
`unresolved`（未能解析，通常是类型推断才能确定的调用）/ `no-symbol`（光标处没有符号）。

所有路径都按项目根校验，越界请求返回 400。

## 接入（给 xchen 等项目列表宿主）

1. **打开项目**：`POST /api/projects { root }`，或 `GET /api/projects/lookup?root=` 先查；
   同一目录永远得到同一个 id，宿主可以把 id 存进自己的项目列表。
2. **跳到某个位置**：内嵌 `/?project=<id>&file=<相对路径>&line=<n>&col=<n>`，
   或向 iframe 发 `postMessage({ type: 'wcr:open', root, file, line, col })`。
3. **双向握手（S7/S9）**：阅读器向宿主回发三条消息，`targetOrigin` 用具体来源（不是 `*`）：

   | 方向 | 消息 | 时机 / 内容 |
   |---|---|---|
   | 阅读器 → 宿主 | `wcr:ready` | 项目就绪或索引进度变化：`{ projectId, projectName, status }` |
   | 阅读器 → 宿主 | `wcr:state` | 换文件**立即**发、光标后防抖发：`{ projectId, file, line, col, selection? }` |
   | 阅读器 → 宿主 | `wcr:bye` | 已按宿主要求释放资源：`{ projectId, stoppedWatcher, releasedIndex, closedStreams, kept }` |
   | 宿主 → 阅读器 | `wcr:dispose` | 收起面板：阅读器调 `POST /api/projects/:id/dispose`，然后回 `wcr:bye` |

   释放语义：关 watcher、断该项目 SSE、释放内存索引，**保留注册表条目**（宿主再打开不用重新注册，索引会自动重建）；
   被读目录里的文件一个都不动。资源清得干不干净用 `GET /api/projects/:id/resources` 核对。
4. **信任边界（默认收紧）**：只处理来源在**白名单**里的消息，白名单 = 同源 + iframe URL 上的
   `?hostOrigin=https://host.example`（可逗号分隔多个）+ 阅读器里登记过的宿主源；`postMessage` 回发也只发给白名单来源。
   调试需要完全放开时用 `?hostOrigin=*`（显式选择，不是默认）。
5. **CORS** 默认放开；需要收紧时设 `READER_CORS_ORIGIN=a.com,b.com`（逐个回显命中的 Origin）。
6. **agent 工具**：`GET /api/agent/tools` 拿到清单，`POST /api/agent/<projectId>/call { tool, args }` 调用；
   返回的是**符号级**答案（`file` / `line` / 解析 `reason`），解析不出如实返回 `unresolved`，不会编造。
7. 前端 `state.ts` 导出了 `openProjectByRoot(root, file?, line?, col?)` 供宿主直接复用；
   页面内可通过 `window.__wcrMonaco` 拿到 Monaco 实例（调试与深度集成用）。

## 语义着色（本项目 vs 依赖）

编辑器里按「符号归属」分三档着色，让本项目的代码先跳出来：

| 档位 | 覆盖对象 | 默认色 |
|---|---|---|
| **本项目** | 项目内定义的函数 / 类 / 方法 / 属性 / 常量，以及它们的引用 | `#ffffff` 白色 + 加粗 + 微光 |
| **局部变量** | 函数内的局部变量与参数 | `#cfe2ff` 浅蓝 |
| **外部依赖** | 标准库 / 第三方包 / 内置函数（`os.path.*`、`print`、`process`…） | `#9aa7b6` 灰蓝 |

- 判定依据是后端解析结果（`GET /api/projects/:id/highlights?file=`），不是正则猜的。
- **解析不出的成员访问不着色**（如 `obj.method()` 中的 `method`，需要类型推断才能确定），保持编辑器语法色 —— 宁可不着色，也不标错。
- `self` / `this` 这类语法成分保持原色。
- 三档颜色都是 CSS 变量（`frontend/src/styles.css` 顶部 `--hl-project` / `--hl-local` / `--hl-external`），改一处即可调对比。
- 打开项目后若索引尚未跑完，页面会在收到 `index-ready` 事件时自动补上着色，不需要刷新。

## 项目地图（概览 / 依赖图 / 时间与来源）

打开项目时如果还没选文件，主区就是**项目地图**（侧栏也有「总览」入口）：

| 区域 | 内容 | 口径 |
|---|---|---|
| 它是什么 | 语言分布、文件/目录/字节/行数、包名与脚本、README 原文折叠 | 索引与文件系统的实际计数；**每个数字点开就能列出构成**，悬浮可看口径（是否含测试） |
| 从哪看起 | 入口候选（命名启发 + `__main__` / Go main 包 / Java main 方法 / 包清单声明的入口，**每条附命中依据**）+ 热点榜 | 热点有**六档口径**：被引用文件数 / 被引用条目数 / 符号被引用数 / 定义数 / 独有依赖 / 新近度；测试与示例默认降噪 |
| 结构 | 循环依赖（Tarjan SCC）、孤立文件（入度为 0 且非入口/非文档/非测试）、最大文件、**目录职责与分层**、复杂度 | 分层按职责（入口/领域/基础设施/工具）+ 依赖方向判，每条附依据；职责**只截原文**，拿不到原文就给事实句（不生成） |
| 最近 | 今天 / 3 天 / 7 天改动计数、最近文件、git 提交批次、宿主上报的 agent 产出 | 时间来自文件 mtime；批次来自只读 `git log`；产出由宿主上报（不是推断） |

**索引没跑完也不阻塞**：此时显示「这是部分地图 + 进度」，并说明此刻能信什么、什么还在长；绝不把「还没索引到」显示成 0。

依赖图（概览右上「看依赖图 →」）：默认**目录级聚合 + 职责泳道**（可切自由力导向），单击目录节点展开到文件级；被提到文件级的入口/热点始终可见（两级并存）；
外部依赖作为聚合节点出现（默认 Top 20，点它不给假跳转）；环上的边与节点会高亮。
右侧面板随选中对象切换：**目录** → 职责一句话 + 目录级反向依赖（谁依赖它 / 它依赖谁 / 传递上游 / 关键文件）+ 分层依据；
**文件** → 顶层符号（点符号直接定位到该符号那行）+ 反向依赖（直接引用 / 传递上游 / 覆盖它的测试）；**外部依赖** → 只说明不跳转。

**地图可以被带走**：视图会写进 URL（`view` / `tab` / `hot` / `denoise` / `graph` / `glevel` / `gexpand` / `glayout` / `gext`），
导航栏有「复制地图链接」——「看这个模块的依赖图」可以贴给同事，打开即复原。

**行级 agent 标记**：宿主可以用 `POST /api/projects/:id/origin` 上报「哪些文件的哪些行是本轮 agent 改的」，
编辑器会把那些行整行高亮并在左侧画色条；**没上报行范围就不画** —— 工具不会把「这个文件被动过」当成「这些行都改了」。

文件树叠加层（右键行 = 标记已读；Alt+右键 = 标记忽略，都存 localStorage）：

```
▣ = 宿主上报的 agent 产出      ◌ = 最近改动（启发式，带置信度）      ★ = 热点骨架
? = 孤立/无人引用             ✓ = 已读                              ∅ = 已忽略
● = 刚变更（阅读时 agent 还在写，实时闪 20 秒）
▓▓▓ = 改动热力（越亮越新，今天 > 3 天 > 7 天 > 更早）
```

视图过滤：时间范围 / agent 产出 / 孤立 / 未读 / 隐藏已忽略，五个条件可叠加——勾上「agent 产出」就是一份本轮交付清单。

**「AI 生成」不靠猜**：只有宿主（xchen 等）上调 `POST /api/projects/:id/origin` 才会被打上 ▣（置信度 1）；
其余只是「最近改动」的启发式判断，界面上会明确标为推断。

## 信使（05 Share）：把读到的东西带走、交出去

顶栏「分享 ▾」是一个收口，不往工具栏继续堆按钮：

| 做什么 | 怎么用 | 带走的是什么 |
|---|---|---|
| 分享一个位置 | 「复制分享链接」（含 `line`/`col`）或 `Ctrl/Cmd+Alt+C` | `http://…/?project=…&file=…&line=…&col=…`，打开就落在同一行 |
| 贴一段代码 | 编辑器里选中 → 右键「复制选中代码（带出处）」 | 第一行是 `path:行范围`，随后是带语言围栏的代码块 |
| 贴一个接口 | 大纲行尾 ⧉（或顶栏「复制符号」） | `name (kind) path:line:col` + 签名，不贴整段实现 |
| 给同事一份理解 | 「Markdown：当前文件 / 当前搜索结果 / 项目概览」 | 大纲 + **带行号正文** + 着色结论（本项目 vs 外部）；纯文本环境仍可读、位置可核对 |
| 贴进文档 / PR | 「截图 PNG」（或截图并复制到剪贴板） | 自绘 canvas：行号栏 + 语法色 + 三档语义色 + 底部出处条 |
| 评审前存档 | 「打印 / 存 PDF」 | 打印视图只留代码与页眉（`path:line` + 项目名），黑白可辨 |

- **导出不降级**：报告与截图都会保留「哪是本项目符号、哪是外部依赖」这个结论 —— 否则导出等于退化成纯文本。
- **给 agent 用**：`GET /api/agent/tools` 是给 agent（或 xchen 宿主）的可调用清单；它只查代码，改代码仍由 agent 自己完成。

## 快捷键补充说明

`F12` / `Shift+F12` 在部分浏览器会被开发者工具占用。等价的替代路径：
**Ctrl/Cmd+Click**（跳定义）、编辑器**右键菜单**（Go to Definition / Go to References）、
`Ctrl+F12`。页面右上角「?」里有完整清单。

导航（03）新增的键：`Ctrl/Cmd+1..9` 切侧栏面板（总览/文件/大纲/搜索…，顺序就是侧栏里看到的顺序）、
`Ctrl/Cmd+Alt+C` 复制当前位置为 `path:line:col`
（编辑器右键菜单里也有）；引用面板里 `↑`/`↓` 移动、`Enter` 跳过去、`Esc` 回到原点、`T` 只看测试；
标签条中键 = 在旁边打开（分屏）。

## 已知限制

- **不做类型推断**：`obj.method()` 里的 `obj` 是局部变量时无法确定其类型，只有模块/包/类限定名
  （`os.path.join`、`pkg.Func`、`Foo.bar`、`self.x` / `this.x`）能跨文件解析。真实项目抽样中约
  53% 的引用能精确跳转，31% 被正确标为外部依赖，其余 16% 属于上述需要类型推断的情形。
- 依赖包内部（node_modules / site-packages 等）不建索引，命中即标 `external`。
- `require('...')` 形式的 CommonJS 导入不解析（ESM `import` 正常）。
- 超过 1MB（且 ≤5MB）的源码文件走**降级索引**：只取顶层定义与导入（没有引用与字面量），
  仍能出现在大纲 / 符号搜索里；超过 5MB 只做文本查看与文本搜索。降级与跳过的理由都在索引报告里可见。
- 索引**有快照但不落正文**：符号事实与文件条目落 `~/.ide/index/<id>/snapshot.ndjson.gz`，正文按需从磁盘读
  （懒读带缓存）。二次打开实测（1000 文件合成仓）：文件树 71ms、符号可跳转 1.0s、恢复期零读盘；
  **万级文件**（10k 实测）文件树 0.48s、符号可跳转 11.5s —— 瓶颈是 18 万条记录的 JSON 解析，
  下一步用列式二进制格式（见 `docs/06-platform-plan.md` §8）。旧格式快照升级后第一次打开会重写一遍。
- **首次 `overview` 约 2~3 秒**（191 文件真实仓库实测 3.1s；1000 文件合成仓约 8s）：概览需要把全项目引用解析一遍，
  结果按索引版本缓存，之后同版本的 `overview` / `graph` / `dependents` 都是毫秒级；任何文件改动会让缓存失效、
  下次重新计算（属 01 主题的既有项，与索引快照无关）。
- `git` 只用于「读懂」需要的读数，且只用 `git log` / `git status` / `git rev-parse` / `git diff` /
  `git blame` / `git show` 六个**只读**命令（数组传参、不经 shell、带超时；任何写操作一律不做）；
  不是 git 仓库时自动降级：时间看文件 mtime、变更看阅读快照对比（只报行数增减，不给增删行，界面如实标注）。
- **导航（03）的范围边界**：调用层级的完整性上限 = 引用解析率；类型层级只看源码里**显式写出**的
  `extends` / `implements` / 嵌入字段，动态注册与鸭子类型不覆盖（界面上如实标注，不伪造边）；
  搜索中止的最坏延迟 = 单个文件的最大扫描耗时。
- **本机数据**：位置记忆 / 搜索历史 / 阅读路线 / 待读 / 阅读基线只写浏览器
  `localStorage`（按项目 id 分片），不写被读目录 —— 代价是换机器就没了
  （04 的决策：数据与 03 同一层，口径单一）。
- **向导（04）的范围边界**：**不引入模型** ——「解释这段」是结构性解释（定义 / 调用 / 引用 + 覆盖率），
  摘要是模板化句子，都固定标注「未使用模型」；数据流只做名字级近似（匹配不上不画边）；
  「已读」只表示「打开过」这一事实，不代表读懂；`自上次阅读以来`的基线会被「打开文件」刷新，
  语义是「最近一次翻文件的时间」，且面板不自动重比对（有「重新比对」按钮）。
- **信使（05）的范围边界**：
  - 分享只做「**同一台机器 / 同一目录**」（S5a）；「把源码打包随阅读器交付」（S5b）尚未做。
  - 截图是 canvas 自绘，**覆盖当前可见范围**，不是整文件分页；超宽 / 超 400 行会截断并在底部注明。
  - 打印视图受 Monaco 限制，只能打当前渲染出来的视口，不是「整文件导出 PDF」。
  - **对外的 agent 工具仍只读**（S8）：`/api/agent/tools` 只开放「查」（符号 / 定义 / 引用 / 大纲 / 文本搜索 / 读行范围），
    不开改文件、执行命令、跑测试。**内置的 Code Agent 是另一层**（见下一条），它按用户要求改文件。
  - 宿主消息默认**只认白名单来源**（同源或 `?hostOrigin=` 声明 / 登记过的宿主源）；
    被忽略的来源会在**控制台**留一条说明，不在界面上打断阅读。

- **Code Agent（2026-10-03）的范围边界**：
  - 它会**写项目文件** —— 这是本工具唯一会写被读目录的入口；所有写路径必须落在项目根内，越界直接拒绝（400 `path_escape`）。
  - **不执行命令**：工具包里没有 bash，所以它不是完整的 shell agent（要跑测试 / 装依赖得你自己来）。
  - **会话历史只在内存**：重启后端即清（不落盘）；会话也不跨项目共享（一个会话绑一个项目）。
  - **后端可选**（`backend/src/agent/adapter.ts`）：`builtin` 用本项目配置的 OpenAI 兼容端点；
    `pi` 起本机 `pi --mode rpc --no-session` 子进程（JSONL 协议；凭证与工具集都由 pi 自己管，历史不落盘）；
    界面上在左栏选后端（内置 agent / pi / OpenHands（占位，调用时给出「怎么接」的指引））。
  - **pi 后端的能力边界 = pi 自己的能力边界**：它会执行命令、按需读写文件，比内置 agent（不带 bash）更宽。
  - **明文 key 落盘**：`~/.ide/model-config.json`（0o600；Windows 上 chmod 基本无效，靠目录权限）。
  - 消息按纯文本渲染，没有 markdown / 代码高亮；一个会话同一时刻只跑一轮（连发会被拒，先停止或等它结束）。
  - 没做：权限询问、沙箱、token 预算控制（只有「一轮最多 N 次工具调用」的硬上限，`READER_AGENT_MAX_STEPS`，默认 24）。

- **命令面板（FR-0005，2026-10-03）：一句话拿本项目命令，点一下真跑**：
  - 「分析」发起的是**只读** code agent 会话（工具集里没有 `write_file` / `edit_file`），所以「仓库里没有的命令」
    只会给建议、不会往仓库写文件；分析过程可以在 Agent 面板打开那条会话（名字「命令分析 · <项目名>」）看。
  - 结果落 `~/.ide/commands/plans/<projectId>.json`，刷新 / 重启后还在，可「重新分析」覆盖。
  - 点「运行 / 后台运行」是**真执行**：一律在项目根、二次确认；`warn` 级（`rm -rf` / `git push` /
    `npm publish` / `sudo`…）要在确认框里额外勾选；自毁级（`rm -rf /`、`mkfs`、fork 炸弹…）后端直接拒绝。
  - **只在监听本机时可用**（共享模式 403），与「命令 · 服务」同一道门槛。
  - 后台运行交给独立 worker（`bin/run-with-log.mjs`）托管，日志实时落 `~/.ide/commands/logs/<runId>.log`
    （Windows 下 `cmd` 的文件重定向会丢输出、stdio 直给文件句柄会全缓冲，所以由 worker 收 pipe 自己写）。
  - **不跨 IDE 后端重启**：运行列表只在内存里，重启后既看不到也停不掉（后台进程本身可能还在跑）。

## 测试

```bash
npm test              # 后端全部用例（node:test + tsx）：语言解析 / 存储层 / 地图 / 导航 / 透镜 / 底座（快照·忽略·编码·并行）
npm run typecheck     # 前后端类型检查
npm run lint          # ESLint 9（要求 0 error）
npm run format:check  # Prettier 格式检查
npm run test:unit     # 前端单测（vitest）
npm run test:ui       # 浏览器 UI 回归（真 Chromium；自建/自删夹具项目，默认端口 8799）
npm run bench         # 性能基准：合成仓首开 / 索引 / 二次打开 / 查询 P50-P95 / 增量，对照 06 的预算表
```

UI 回归用例在 `tests/ui/`，三套都由 `run.mjs` 统一起夹具项目与后端：`navigator.mjs` 是导航·信使断言主体
（跳转失败提示、引用面板、调用/类型层级、搜索、复制位置、**复制选中代码（带出处）**、**复制符号摘要**、
**分享深链**、**打印视图样式**），`guide.mjs` 是向导断言主体
（首屏起点与推荐路线、开始阅读进第 1 步、「下一步」前进、打开即已读与进度跨刷新、待读跨刷新、
阅读基线报「没有变化」、解释这段出结构性解释、层级面板展开为调用流图），`platform.mjs` 是底座断言主体
（顶栏「模型」入口、设置面板五个分组、切亮色真的换主题、字号落 `wcr:prefs` 并即时生效、切 English、Agent 会话摊在主界面）。
后端另有 `tests/dispose.test.ts`（S9c 资源视图 / 释放 / 幂等 / 断 SSE）、
`tests/agent.test.ts`（S8 工具清单与各工具）与 `tests/agent-builtin.test.ts`
（Code Agent：模型配置打码 / 循环真执行工具并写出文件 / 结果回灌 / 错误路径 / 路径越界 / glob 语义）
三份专用用例；`agent-builtin` 用本地假的 OpenAI 端点，不需要任何真实 key。
