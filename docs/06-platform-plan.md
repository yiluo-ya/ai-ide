[01 地图 Map](./01-map.md) · [02 透镜 Lens](./02-lens.md) · [03 导航 Navigator](./03-navigator.md) · [04 向导 Guide](./04-guide.md) · [05 信使 Share](./05-share.md) · [06 底座 Platform](./06-platform.md)

# 06 底座 Platform · 全量落地决策与实施计划

> 本报告**只给确定答案**：`06-platform.md` §8 的 6 个待确认问题全部拍板，P1–P25 全量实施，不含「待确认 / 建议」类表述。
> 唯一例外是附录里标注为「不可确定」的技术事实（如解析率上限），会写明边界与兜底。
> 需求口径一律以 `docs/06-platform.md` 为准；本文只在它没写死的地方补决策，且每条决策都给出理由。

---

## 0. 结论摘要

**交付范围**：P1–P25 全量，按 `06-platform.md` §7 的阶段 0→5 推进，每阶段独立可验收。**不做裁剪。**

**三条不可动摇的原则**（所有决策都由它们推出）：

1. **底座的每一项都要能交付给别人**。功能做成什么样是上层主题的事；底座只回答「别人拿得到吗、等多久、敢不敢用、我敢不敢改」。
2. **只读不写被读目录**。用户产生的数据只落两处：本工具自己的数据目录（`data/`）与浏览器 `localStorage`；被读目录一个字节都不写。
3. **性能与隐私都不是优化项，是首次体验本身**。第一次打开的秒数、第一屏那句「代码不出本机」，与功能同等重要。

**六条硬决策**（详见 §1）：

| # | 问题 | 决策 |
|---|---|---|
| 1 | 类型推断 / LSP | **A 不引入**；改用「unresolved 必须说清缺什么」 |
| 2 | 分发形态 | **B npx 一键 + D Docker 只读挂载**；**不做**单文件 exe |
| 3 | 是否服务不装 Node 的同事 | **是**，由 Docker 承担 |
| 4 | 零配置承诺 | **不接受**首次等全量索引 → P4 持久化与 P5 并行本次必做 |
| 5 | 性能预算 | 见 §2 的五个数字，全部由基准守护 |
| 6 | 「代码不出本机」 | **硬承诺**：任何联网能力默认关闭 + 界面显式增量声明 |

---

## 1. 待确认问题拍板（对应 06 §8）

### Q1 是否引入类型推断 / 接入现成 LSP？→ **A：不引入**

- **理由**：① `06-platform.md` §6 已把「自研类型推断引擎」「通用 IDE 服务器 / 完整 LSP 代理」列为不做；② 引入 LSP 意味着每种语言配一个外部进程（安装、版本、启动、崩溃恢复），与 Q2 的「一条命令 / 一个产物」直接冲突——用户拿到的将不再是「双击就能用」的东西；③ P2 的产品要求本身是「要么跳到对的地方，要么明确告诉我跳不了」，15.8% 的未解析率只要**如实解释**就不构成欺骗。
- **落地口径**：`unresolved` 必须带 `detail`（后端给，前端只做表达）：
  `needs-type-info`（`obj.method()`，`obj` 类型需推断）/ `dynamic-member`（动态属性 `getattr`、`obj[name]`）/
  `module-not-found`（说明符解析不到）/ `not-in-project`（指向项目外且非标准库）/ `indexing`（索引未完成，见 Q12）。
  界面上不出现「未解析」这三个字，只说人话（如「这需要类型信息，本工具不做类型推断」）。

### Q2 分发形态选哪种？→ **主：B npx 一键；同步做 D Docker；不做 C 单文件 exe**

- **理由**：
  - B（npx / `npx web-code-reader`）零新增构建管线，复用 Node 生态；与现有 `npm start` 只差一个 `bin` 与发布元数据，是**成本最低、可验证**的路径。
  - D（Docker + `-v <dir>:/work:ro`）面向团队 / 内网，且**只读挂载是 P17 最强的物理表达**（不是承诺，是权限），必须做。
  - C（单文件 exe，Node SEA）需要 Windows 代码签名与杀软白名单维护，体积 60MB+，且覆盖人群与 D 重叠——**明确不做**，写进「不做」清单。若日后确有「无 Node、无 Docker」的同事，再按 §7 的遗留项补。
- **验收口径**：`npx web-code-reader <dir>` 一条命令起服务并自动开浏览器；`docker build -t web-code-reader .` + `docker run --rm -p 8787:8787 -v <dir>:/work:ro web-code-reader` 能打开页面并填 `/work/<name>`。

### Q3 目标用户是否包含不装 Node 的同事？→ **是**

由 D（Docker）承担；文档中「快速开始」给两条并列路径（npx / Docker），不给「先装 Node 再 install 再 build」的三步走。

### Q4 是否需要「打开即用」的零配置承诺？→ **不接受首次等全量索引**

- **理由**：`06-platform.md` §1 把「第一次打开等 20 秒、第二次还要再等」定义为体验失败；一旦按 Q2 分发到别人机器，第一次打开就是**唯一**一次第一印象。故 P4（持久化）与 P5（并行）**本次必做**，并配套 P7（对账）保证长期开着也准。
- **口径**：首开允许后台建索引（文件树与正文先可用），但**二次打开不得再等**。

### Q5 性能预算 → 五个数字（全部进 `npm run bench` 与基准测试）

| 场景 | 预算 | 说明 |
|---|---|---|
| 万级文件仓库·首开可交互（文件树 + 打开文件） | ≤ 2 s | 索引在后台跑，不阻塞阅读 |
| 万级文件仓库·索引完成 | ≤ 60 s | 并行解析 + 单次全量（10k 文件 / 约 1.5M 行 合成仓实测） |
| 二次打开（快照命中、无变更） | 文件树 ≤ 500 ms、符号可跳转 ≤ 1.5 s | 持久化 + 指纹校验 |
| 索引完成后的查询（跳转 / 引用 / 搜索 / 概览） | P50 ≤ 150 ms、P95 ≤ 500 ms | 排除首次概览（其热度缓存见 §7 遗留） |
| 增量更新（单文件改动 → 新符号可查） | ≤ 1 s | 监听 + 单文件重解析 |

### Q6 「代码不出本机」是硬承诺还是现状描述？→ **硬承诺**

- 界面常驻角标 + 可追证面板（写哪里、监听哪里、怎么关）；后端 `GET /api/integration/manifest` 增加 `privacy` 段，`/api/health` 返回 `network: 'none'`。
- 未来任何联网能力（LLM 解释、语义搜索、更新检查）**必须默认关闭 + 用户显式开启 + 隐私面板增量声明**；这条写进本文件与 README 的「不做」清单，作为后续主题（05 信使）的约束。

---

## 2. 补充决策（06 没写死、但落地必须定）

| # | 问题 | 决策 |
|---|---|---|
| Q7 | 快照落盘位置与格式 | `data/index/<projectId>/snapshot.json`（schema 版本号 `v1`，损坏/版本不符即静默回落到全量重建，不报错） |
| Q8 | 快照有效性判据 | 启动时一次轻量 `scan`（只 readdir + stat），把「相对路径 + size + mtimeMs」哈希与快照记录比对；一致 → 直接加载；不一致 → 只重解析变化文件（增量，不 clearIndex） |
| Q9 | 并行度 | 默认 `min(4, max(2, cpus-1))`；`READER_PARSE_WORKERS=0` 关闭并行（测试与排障用）；每个 worker 独立 Parser 实例 |
| Q10 | 忽略规则优先级 | 内置黑名单 < `.gitignore` < `.wcrignore`（后者可 `!` 取反）；**`node_modules` / `.git` 永远忽略**，不可被 `!` 打开；`READER_IGNORE_BUILTIN=0` 可关闭内置黑名单（排障用） |
| Q11 | 编码探测顺序 | BOM（UTF-8 / UTF-16LE / UTF-16BE）→ UTF-8 严格解码 → GBK 启发式（字节范围 + 解码后中文占比）→ latin1 兜底；索引与正文**共用同一份解码文本**，保证坐标一致 |
| Q12 | 大文件降级 | `>1MB` 的源码文件走「顶层符号模式」：只取顶层定义与导入，不进引用/字面量，标记 `degraded: 'top-level'`；`>5MB` 仍只正文不索引；两者都出现在大纲与符号搜索里 |
| Q13 | 日志 | 默认单行 `key=value` 到 stderr；`READER_LOG_LEVEL`（error/warn/info/debug，默认 info）、`READER_LOG_FILE` 可选；请求日志含方法/路径/状态/耗时，慢请求（>500ms）warn |
| Q14 | 主题 / 字号 / 布局偏好 | 主题深/亮/跟随系统、字号 12–18、侧栏宽拖拽，全部存单键 `wcr:prefs`（与项目无关，不分片）；项目相关键（搜索历史/位置/书签）维持现状 |
| Q15 | i18n 范围 | 默认中文 + 英文；文案集中到 `frontend/src/i18n/`；界面语言并入 `wcr:prefs`。P25 的验收含键盘可达（主流程不摸鼠标）+ 焦点可见 + aria 标注 |
| Q16 | CLI 与单实例 | `wcr [dir]`、`--port/--no-open/--no-watch/--workers`；单实例由 `data/runtime.json`（pid+port+startedAt）判定，存活则直接打开已有地址（不起第二个进程） |
| Q17 | CI 范围 | `.github/workflows/ci.yml`：`typecheck` + `lint` + `test` + `build` + `test:ui`（装 Chromium）；bench 不进 CI（耗时长），由 `npm run bench` 本地/夜间跑 |
| Q18 | lint / format 口径 | ESLint 9 flat config（typescript-eslint recommended，风格规则交给 Prettier）+ Prettier（`printWidth 120`、单引号、分号、2 空格，贴合现状）；要求 `npm run lint` **0 error / 0 warning**、`npm run format:check` 通过 |
| Q19 | 验收口径 | `npm run typecheck` + `npm test` + `npm run lint` + `npm run build` + `npm run test:ui` + `npm run bench` 六项全绿，冷启动在真实仓库实测 |
| Q20 | 索引报告契约 | `GET /api/projects/:id/index-report` → 总量 / 已索引 / 降级 / 跳过清单（按原因归类：`too-large` / `binary` / `parse-failed` / `read-error` / `ignored` / `not-source`）/ 编码分布；前端从「已索引」状态处点开 |

---

## 3. 能力对照与阶段推进

阶段沿用 `06-platform.md` §7，完成标志按本文 Q19 的验收口径执行。

| 阶段 | 覆盖能力 | 本次交付的关键动作 | 完成标志（可验证） |
|---|---|---|---|
| 阶段 0 可信 | P18 保持、P20、P21、P22 | UI 回归进 CI；lint/format 落地并零 error；请求/索引日志可查 | `npm run lint` 0 error；`test:ui` 进 CI；跳转失败与索引异常在日志里能定位到文件与原因 |
| 阶段 1 可解释 | P2、P9、P12、P8 | unresolved 原因明细；索引报告（哪些文件没进、为什么）；GBK/UTF-16 解码；`.gitignore` / `.wcrignore` | 未索引文件有可查原因清单；GBK 文件中文不乱码且符号位置正确；忽略规则改配置文件即生效（界面能看到生效结果） |
| 阶段 2 能交付 | P13、P14、P15、P16、P17 | `wcr` CLI + npx + Dockerfile；自动选端口 + 单实例；三步引导；常驻隐私承诺 | 无 Node 的机器上跑 Docker 一条命令打开页面并完成「填路径 → 看到文件树」；端口占用自动让位；重复启动复用实例；界面常驻隐私角标 |
| 阶段 3 撑住规模 | P4、P5、P7、P11、P23 | 快照持久化 + 增量恢复；worker 并行解析；定期对账 + 自愈；大文件顶层符号；基准与预算 | 二次打开不等全量索引；10k 文件合成仓首开/索引时间进预算；快照过期与漏事件可自愈；>1MB 文件在大纲/符号搜索可见 |
| 阶段 4 撑住团队 | P1 扩展、P10、P19、P24、P25 | 新增 Rust（一个模块 + 一行注册）；monorepo 说明符；前端 vitest；主题/字号；中英文案 + 键盘可达 | 加语言只碰 `languages/`；tsconfig paths / go.work / Python src 布局跨包不再落 external；前端单测进 CI；主题与字号可切换并持久化 |
| 阶段 5 精度（按 Q1 决策） | P3 | 不引入 LSP；`unresolved` 一律给缺失原因说明 | 界面不出现无解释的「跳不了」 |

---

## 4. 子任务拆分（文件边界 = 并行边界）

四个子任务，按「不重叠的写文件集合」切分；契约（`shared/types.ts` 新增类型、`log.ts` 接口）在启动前冻结。

### B1 后端 · 索引底座核心（P4 / P5 / P7 / P8 / P9 / P11 / P12 / P2）

- **新增**：`backend/src/indexer/ignore.ts`、`encoding.ts`、`snapshot.ts`、`parse-pool.ts`、`index-report.ts`
- **改动**：`backend/src/indexer/store.ts`（主战场）、`parser.ts`、`resolver.ts`（unresolved 细分）、`backend/src/watcher.ts`、`backend/src/config.ts`、`backend/src/api/routes.ts`、`shared/types.ts`
- **禁止改**：`backend/src/server.ts`（B2 负责）
- **单测**：`backend/tests/{ignore,encoding,snapshot,parse-pool,index-report,persist}.test.ts`
- **验收**：`npm --prefix backend run typecheck` + `npm --prefix backend test`；真实仓库（191 文件）冷启动二次打开 ≤ 1.5s；`data/index/<id>/snapshot.json` 生成且校验通过

### B2 后端 · 语言与交付（P1 / P10 / P13 / P14 / P15 / P16 后端侧 / P22）

- **新增**：`backend/src/languages/rust.ts`、`backend/src/cli.ts`、`backend/src/log.ts`、`backend/src/bootstrap.ts`、`Dockerfile`、`.dockerignore`、`bin/wcr.mjs`（或等价 bin）
- **改动**：`backend/src/languages/{index,typescript,go,python}.ts`、`backend/src/server.ts`、`backend/src/config.ts`（仅追加，冲突时以 B1 为准）、`package.json`（根与 backend）
- **单测**：`backend/tests/rust.test.ts`、`monorepo.test.ts`
- **验收**：`npx tsx backend/src/cli.ts --help` 可用；`READER_PARSE_WORKERS=0 PORT=0 npx tsx backend/src/cli.ts <fixture>` 自动选端口并打印地址；重复启动复用实例；Dockerfile 语法与阶段正确（本机无 Docker 时用 `docker build --check` 或如实验证构建产物）

### B3 前端 · 交付体验（P16 / P17 / P24 / P25 + P9 / P8 的界面出口）

- **新增**：`frontend/src/prefs.ts`（localStorage 统一封装 + 主题/字号/语言）、`frontend/src/i18n/{index,zh,en}.ts`、`frontend/src/Welcome.tsx`（三步引导）、`frontend/src/PrivacyPanel.tsx`
- **改动**：`frontend/src/{App,TopBar,Overview,styles,monaco-setup,Editor,state,api}.tsx|ts`、`frontend/index.html`（`lang` 与 title 随语言）
- **约束**：① 引导落在**实际可达**的位置（`Overview.tsx` 的 `.ov-empty` 分支，`App.tsx` 的 welcome 死分支要清理或复用）；② 改文案不得破坏 `tests/ui/navigator.mjs` 的选择器——改动前先读该文件，选择器依赖的中文文案保持原样或同步改测试（测试文件由 B4 统一维护，B3 只提交「需要同步的文案清单」）；③ 主题必须三处同步（`styles.css` 变量 + `graph.css` / `overview.css` / `filetree.css` 硬编码 + Monaco 主题），**验收要求每个页面无残留深色块**
- **验收**：`npm --prefix frontend run build`（含 tsc）+ 浏览器目视：亮/暗切换、字号 12/14/16 三档、中英文切换、键盘走完「打开项目 → 打开文件 → 跳定义 → 搜索」

### B4 工程化（P19 / P20 / P21 / P23）

- **新增**：`frontend/src/**/*.test.ts`（vitest）、`frontend/vitest.config.ts`、`eslint.config.js`、`.prettierrc.json`、`.prettierignore`、`.github/workflows/ci.yml`、`backend/tests/perf.test.ts`、`backend/bench/bench.ts`（`npm run bench`）
- **改动**：`package.json`（脚本）、`frontend/package.json`（vitest 依赖与脚本）、`tests/ui/*.mjs`（仅在 B3 报告文案变更时同步）
- **顺序约束**：lint / format 必须**最后**执行（`--write` 会全仓改文件，先于其它任务的写操作会打断它们）
- **验收**：`npm run lint` 0 error；`npm run test:unit`（前端）通过；`npm run bench` 输出预算对照表

---

## 5. 新增契约（冻结，前后端共用）

```ts
// shared/types.ts 追加（B1 落地）

/** 未解析的具体缺失原因（P2 / Q1）。 */
export type UnresolvedDetail =
  | 'needs-type-info'    // obj.method()，obj 类型需推断
  | 'dynamic-member'     // getattr / obj[name] / 动态属性
  | 'module-not-found'   // 说明符解析不到任何文件
  | 'not-in-project'     // 指向项目外且非标准库
  | 'indexing';          // 索引未完成（Q12，前端优先读 status.indexing）

export interface IndexReportReason { reason: string; count: number; files: string[] } // files 截断 50
export interface IndexReport {
  total: number;            // 扫描到的文件总数（含非源码）
  indexed: number;          // 已建符号索引
  degraded: number;         // 降级索引（>1MB 的顶层符号模式）
  sourceFiles: number;      // 源码文件数
  byReason: IndexReportReason[];
  encodings: { encoding: string; count: number }[];
  generatedAt: number;
}

export interface IgnoreInfo {
  sources: { path: string; rules: number }[];   // 生效的 .gitignore / .wcrignore
  builtinDirs: number; builtinPatterns: number;
  ignored: number;                              // 被忽略的文件数（相对扫描根）
  overridden: string[];                         // 被 ! 重新纳入的路径（截断 20）
}

export interface PrefsSnapshot {              // 非后端契约，仅前端持久化形状（B3）
  theme: 'dark' | 'light' | 'system';
  fontSize: number;                           // 12–18
  sidebarWidth: number;
  locale: 'zh' | 'en';
}

export interface SnapshotMeta {               // data/index/<id>/snapshot.json（B1）
  schema: 1;
  projectId: string;
  root: string;
  indexedAt: number;
  indexVersion: number;
  fingerprint: string;                        // entries 的相对路径+size+mtime 哈希
  fileCount: number;
}
```

```ts
// backend/src/log.ts 接口（B2 实现；B1 只 import 使用）
export function logInfo(msg: string, fields?: Record<string, unknown>): void;
export function logWarn(msg: string, fields?: Record<string, unknown>): void;
export function logError(msg: string, fields?: Record<string, unknown>): void;
export function logDebug(msg: string, fields?: Record<string, unknown>): void;
export function logTiming(msg: string, ms: number, fields?: Record<string, unknown>): void;
```

新增端点（B1 实现）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/projects/:id/index-report` | P9：未索引 / 降级 / 编码分布 |
| GET | `/api/projects/:id/ignore` | P8：生效的忽略规则与统计 |
| GET | `/api/projects/:id/snapshot` | P4：快照状态（是否存在 / 写入时间 / 指纹是否匹配） |
| POST | `/api/projects/:id/verify` | P7：立即对账一次，返回差异清单（新文件 / 变更 / 已删除） |

---

## 6. 明确不做（06 §6 的落地补充）

| 不做 | 理由 |
|---|---|
| 单文件 exe（Node SEA / pkg） | 见 Q2；签名与杀软成本高，用户群被 Docker 覆盖 |
| 索引 / 分析依赖包内部 | 06 §6 已定；持久化快照只存项目内文件 |
| 为万级文件做分布式索引 | 06 §6 已定；本机靠并行 + 持久化 + 降级 |
| 遥测 / 崩溃上报 / 自动更新检查 | 与 Q6 硬承诺冲突 |
| 云同步偏好（书签 / 位置跨机器） | 05 信使主题的导出 / 导入已覆盖 |
| UI 回归进夜间以外的全量矩阵（多浏览器 / 多分辨率） | 收益低于维护成本；CI 只跑本机 Chromium 的 19+ 条主流程 |

---

## 7. 复现方式

```bash
npm run typecheck    # 前后端类型检查
npm run lint         # ESLint + Prettier check
npm test             # 后端全量单测（node:test + tsx）
npm run test:unit    # 前端单测（vitest）
npm run build        # 前端产物
npm run test:ui      # 浏览器 UI 回归（Chromium，自建夹具项目）
npm run bench        # 性能基准（预算对照）

# 交付形态
npx tsx backend/src/cli.ts <目录>            # 本机一键（等价 npm start 的下一步）
docker build -t web-code-reader . && \
  docker run --rm -p 8787:8787 -v <目录>:/work:ro web-code-reader
```

---

## 8. 遗留与边界（如实说明）

1. **解析率上限**：不做类型推断（Q1），`obj.method()` 类引用永远无法跳转，接口只保证「说得清为什么」。这是产品边界，不是缺陷。
2. **exe 形态缺席**：只有 Node（npx）与 Docker 两条交付路径；「无 Node 且不能用 Docker」的用户本次覆盖不到。
3. **Docker 只读挂载的宿主差异**：Windows 下的 bind mount 权限语义弱于 Linux，`ro` 的「物理写不了」在 Windows 上仅部分成立（面板里如实写「容器内只读」而非「磁盘不可写」）。
4. **快照与符号事实的耦合**：快照只固化 tree-sitter 的解析事实，语法包升级后需靠 `schema` 版本回落重建；这点在 `snapshot.ts` 的注释里写明。
5. **首次概览 2~3 秒**（01 主题遗留）不在本次预算内，靠后续「文件级边落盘」解决。
