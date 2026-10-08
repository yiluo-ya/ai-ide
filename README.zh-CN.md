# 网页版代码阅读器（web-code-reader）

[English](README.md) | **中文**

浏览器里的代码阅读器：后端用 tree-sitter 建索引，前端用 Monaco 只做渲染与查询，
F12 / Shift+F12 / Ctrl+Shift+O 等 VS Code 习惯的导航全部可用。

定位见 `FR/FR-0002-fr.md`：**面向阅读** —— 不做编译、调试、重构与类型检查。

阅读本身是只读的：索引与浏览**不改动被读目录里的任何文件**。会写盘的只有四处，
且都要你显式触发：**变更栏的 git 写操作**（add / commit / pull / push）、
**命令面板跑命令**、**Code Agent 改文件**、以及宿主自己调的命令接口。

## 界面速览

| 区域 | 内容 |
|---|---|
| **顶栏** | 项目下拉、添加项目（手输路径或弹目录选择窗）、重建索引、移除、项目根路径、索引进度、复制文件链接、模型、设置、`?`（快捷键与配色说明） |
| **左栏**（常驻 4 个 tab，宽度可拖 240–560） | 文件 / 大纲 / 搜索 / code 会话 |
| **主区**（三态） | 代码 · 项目地图 · Agent；代码区顶条左侧是标签条（上限 8）、右侧是「← → · 分享 ▾」；项目地图开关在右下角竖轨里、布局开关之上 |
| **右栏**（常驻 dock，默认展开，宽度可拖 220–560，可收起） | 变更 / 命令 / 总览 |

2026-10-03 起，侧栏不再有「更多 ▾」二级菜单，也没了向导 / 引用 / 调用层级 / 类型层级
四个面板的界面入口（组件与后端接口保留，见「已知限制」）；辅助信息统一收进右栏 dock。

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
npm run cli -- --help        # 全部选项（--port / --host / --no-open / --no-watch / --workers）
```

开发模式（前端热更新，`/api` 自动代理到 8787）：

```bash
npm run dev:backend    # 终端 1
npm run dev:frontend   # 终端 2 → http://127.0.0.1:5173
```

打开页面后点「添加项目」，手输一个绝对路径（如 `D:/code/my-project`）或点文件夹图标弹目录选择窗。
也可以用深链直接进入某个位置：

```
http://127.0.0.1:8787/?project=<项目id>&file=src/app.py&line=42&col=5
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
`/data` 是容器内的可写卷，只放项目列表、索引快照与命令计划。

### 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` | `8787` | 监听端口（0 = 系统分配） |
| `HOST` | `127.0.0.1` | 监听地址；**不在本机集合即「共享模式」**，命令执行 / 目录浏览 / git 写 / 服务管理一律 403 |
| `READER_DATA_DIR` | `~/.ide` | 数据目录（项目列表、模型配置、索引快照、命令计划与日志）；老的 `<仓库根>/data` 启动时一次性复制迁移（只复制不删） |
| `READER_FRONTEND_DIST` | `<repo>/frontend/dist` | 前端产物目录 |
| `READER_WATCH` | 开 | `0` 关闭文件监听 |
| `READER_PERSIST` | 开 | `0` 关闭索引快照持久化 |
| `READER_PARSE_WORKERS` | `min(4, max(2, cpus-1))` | 并行解析 worker 数，`0` = 串行 |
| `READER_VERIFY_MS` | `600000` | 索引对账间隔，`<=0` 关闭 |
| `READER_IGNORE_BUILTIN` | 开 | `0` 关闭内置忽略黑名单 |
| `READER_USER_IGNORE` | `~/.ide/ignore-user.txt` | 全局自定义忽略规则文件 |
| `READER_CORS_ORIGIN` | `*` | CORS 白名单，逗号分隔 |
| `READER_LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` |
| `READER_LOG_FILE` | 无 | 同时落日志文件 |
| `READER_MODEL_CONFIG` | `~/.ide/model-config.json` | Code Agent 模型配置 |
| `READER_AGENT_MAX_STEPS` | `24` | 内置 agent 单轮最大工具调用数 |
| `READER_PI_COMMAND` / `READER_PI_TIMEOUT_MS` | `pi` / `30000` | pi 后端可执行文件与响应超时（定位链最优先的一环） |
| `READER_AGENT_RUNTIME` | `~/.ide/agent-runtime.json` | Code Agent 后端的路径配置（一般不用设） |
| `READER_COMMAND_TIMEOUT_MS` | `180000` | 命令发现（只读 agent）超时 |
| `READER_COMMAND_DIR` | `~/.ide/commands` | 命令计划与后台日志目录 |
| `READER_PERF` | 未设 | 设 `1` 才跑压测用例 |

### 同机 / 局域网分享

默认只监听 `127.0.0.1`（只有本机能开）。想让同一台机器或局域网里的同事也能读，
用 `HOST=0.0.0.0 npm start` 重启 —— 启动日志与「分享给同事」会给出可访问地址
（`http://<本机IP>:8787/?project=<id>`）；担心来源时用
`READER_CORS_ORIGIN=https://host-a,https://host-b` 收紧。共享模式下命令执行、
目录浏览、git 写操作与阅读器自身的重启 / 停止全部禁用（接口级 403）。

## 语言支持


**可索引语言**（有符号索引、可跳转、进语言分布）内置 20 个 —— 还能以插件包的形式再加，不必改本仓库
（见下「装一门新语言」）：

| 解析方式 | 语言（id） | 扩展名 / 文件名 |
|---|---|---|
| tree-sitter AST | Python、TypeScript（`typescript` / `tsx` / `javascript` / `jsx`）、Go、Java、Rust、Shell（Bash 语法）、JSON、YAML、TOML、Markdown、CSS（`css` / `scss` / `less`）、HTML | `.py`、`.ts/.tsx/.js/.jsx/.mjs/.cjs`、`.go`、`.java`、`.rs`、`.sh/.bash/.zsh`、`.json/.jsonc`、`.yml/.yaml`、`.toml`、`.md`、`.css/.scss/.less`、`.html/.htm` |
| 行式扫描 `lineSymbols`（无 tree-sitter 语法包） | Dockerfile、INI / ENV、SQL | `Dockerfile`/`Containerfile`、`.ini/.cfg/.conf/.properties/.env`、`.sql` |

Shell 另有函数 / 变量跳转与 `source` 依赖。**包依赖 / 构建清单**（`go.mod`/`go.sum`、
`requirements*.txt`、`Pipfile`、`poetry.lock`/`uv.lock`、`pom.xml`/`*.csproj`、`build.gradle`/`*.kts`/`*.sbt`、
`Gemfile`/`*.gemspec`/`*.podspec`、`mix.exs`、`Package.swift`、`Cargo.lock`/`composer.lock`/`pubspec.lock`、
`.npmrc`/`.yarnrc`、`Makefile`…）**只做高亮与预览**，不进符号索引、不进语言分布与阅读路线 ——
语言识别在 `languages/manifests.ts`，与 `specForFile` 分开。


#### 装一门新语言（语言插件）

`wcr` 就是本包的 CLI（`bin/wcr.mjs`，`npm i -g .` 或解包 tarball 后得到）；没全局装的话，
在仓库根用 `npm run cli -- lang <子命令>` 跑同一份代码。语言做成**独立插件包**：装一个 + 重启，
不改本仓库源码、也不重新构建前端。

```bash
wcr lang list                            # 已加载语言 + 来源 + 加载失败
wcr lang add wcr-lang-zig                # 装一个语言包（写到 <数据目录>/languages）
wcr lang add D:/my-langs/demo-lang       # 或本地目录
wcr lang link D:/my-langs/demo-lang      # 软链正在开发的插件（改完重启即生效）
wcr lang new zig --dir ../wcr-lang-zig   # 生成插件项目骨架（含契约自测脚本）
wcr lang remove wcr-lang-zig             # 卸掉（也可以用语言 id）
```

插件目录默认 `<数据目录>/languages`（`READER_PLUGINS_DIR` 可覆盖）；`READER_PLUGINS=0` 一个插件都不加载。
装 / 卸 / 链后**重启服务生效**（语言集变了会自动全量重建索引）。插件怎么写、按什么标准验收见
[`docs/08-language-plugin-spec.md`](docs/08-language-plugin-spec.md)。


## 已知限制

- **不做类型推断**：`obj.method()` 里 `obj` 是局部变量时无法定位类型；依赖包内部不建索引，命中即标 `external`。
- `require('...')` 形式的 CommonJS 导入不解析（ESM `import` 正常）。
- 1–5 MB 的源码文件走**降级索引**（只取顶层定义与导入，没有引用与字面量）；超过 5 MB 只能看文本与文本搜索。
- 首次打开「总览」约 2–3 秒（要把全项目引用解析一遍），之后走缓存。
- 已移除向导 / 引用 / 调用层级 / 类型层级的界面入口（组件与后端接口保留）。

完整清单（含每条的边界与实测口径）见 [`docs/10-features.md`](docs/10-features.md#已知限制)。


## 文档

- [功能与实现细节](docs/10-features.md) —— 能力清单、API、快捷键、已知限制（全量版）
- 主题文档：[01 项目地图](docs/01-map.md) · [02 透镜](docs/02-lens.md) · [03 导航](docs/03-navigator.md) ·
  [04 向导](docs/04-guide.md) · [05 分享与导出](docs/05-share.md) · [06 底座与交付](docs/06-platform.md)
- 语言插件：[07 方案](docs/07-languages-plugin-plan.md) · [08 标准（十项能力）](docs/08-language-plugin-spec.md)
- 需求见 `FR/`；各主题的 `*-plan.md` / `*-decisions.md` / `*-verify.md` 是决策与验收过程文档。


## 许可证

基于 [MIT](LICENSE) 许可发布，© 2026 yiluo-ya
