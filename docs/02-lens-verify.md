[01 地图 Map](./01-map.md) · [02 透镜 Lens](./02-lens.md) · [03 导航 Navigator](./03-navigator.md)

# 02 透镜 Lens · 验收报告

> 验收对象：`02-lens.md`（形态定义）与 `03-decisions.md` 所约束的实现。验收方式：读码 + 后端 API 端到端实测 + Playwright 浏览器回归。全部结论可复现。

**结论：通过。L1–L10 全部落地，15 项子能力中 13 项达标，2 项待收尾（L3e 点击入口失效——已定位根因并实测出修法；L3d 多行签名退化）。另有 2 处与设想不一致、3 处超出设想。**

---

## 一、验收基线

| 项 | 结果 |
|---|---|
| 后端测试 | `npm test` **92/92 通过**（含 `backend/tests/hover.test.ts` 对 L3a–L7 各态的断言） |
| 类型检查 | `npm run typecheck` 通过 |
| 端到端（API） | `hover` 七种结论全部按预期返回（见第三节） |
| 浏览器回归 | 新增 `tmp/uitest/lens.mjs`：**4/4 通过**，页面无 console error / pageerror |
| 只读承诺 | 全部验证脚本只注册目录 + 查询，未写被读目录一个字节 |

---

## 二、逐条对照（对 `02-lens.md` §2 能力清单）

| 编号 | 能力 | 设想 | 实测 | 证据 |
|---|---|---|---|---|
| L1 | 语法高亮 | ✅ | ✅ | 页面渲染正常 |
| L2 | 语义着色三色 | ✅ | ✅ | 既有；DOM 中 `wcr-hl-project/external/local` |
| L3a | 悬停：名字 + 种类 | ✗→做 | ✅ | 卡片 `demand_card` + `function` 徽标 |
| L3b | 悬停：所属容器 | ✗→做 | ✅ | `containerName` 字段；类内成员显示类名 |
| L3c | 悬停：定义位置（可点） | ✗→做 | ✅ | `services/fr_load.py:63`，走 `HOVER_CMD_OPEN` 命令链接 |
| L3d | 悬停：声明首行签名 | ✗→做 | ◐ | Python 完整（`def demand_card(path: str) -> Optional[Dict[str, Any]]:`）；**TS/Java/Go 多行签名只取到首行**（`function resolveRef(`），见第五节 P3 |
| L3e | 悬停：引用处数（可点开） | ✗→做 | ◐ | 数字准确（12 处 / 2 处）；**点击无反应**，见第五节 P1 |
| L4a | docstring | ✗→做 | ✅ | Python 多行 docstring 完整；TS `/** */` 注释生效 |
| L4b | 紧邻注释（隔空行不给） | ✗→做 | ✅ | 实测 `resolver.ts:79` 上方隔空行 → 不给 doc（符合设计，非缺陷） |
| L5 | 类型信息（仅来自注解） | ✗→做 | ✅ | `['path: str', '→ Optional[Dict[str, Any]]']`；TS `['id: string', 'n: number', '→ Promise<string>']` |
| L6 | 常量与字面量溯源 | ✗→做 | ✅ | `值 65_000 / 字面量，无关联定义 / 同值出现 1 处`；绑定到变量时给出变量名、位置与其他引用数 |
| L7 | 装饰器 / 注解 | ✗→做 | ✅ | Python `@cache`；TS `@deprecated` |
| L8 | 折叠 + 缩进参考线 | ✅ | ✅ | 既有 |
| L9 | minimap | ✅ | ✅ | 既有 |
| L10 | 整文件密度概览条 | ✗→做 | ✅ | 1193 行文件 → 60 段渲染；每段 code/comment/blank 占比合计 = 1.000，带 3 个符号名 |

**七种 hover 结论全部可达**（比 `02-lens.md` 设想的多两种）：

| reason | 实测样例 |
|---|---|
| `resolved` | 定义处与引用处均命中，附签名 / 类型 / doc / 引用数 |
| `external` | `hono` → 「外部依赖 · 标准库 / 第三方包，不在项目索引内」 |
| `infer-needed` | `stream.writeSSE` → 「无法确定 stream 的类型，暂不能定位定义」**并附链头 `stream` 的参数定义位置** |
| `unresolved` | 同名多定义 → 「未能确定唯一目标；同名定义 2 处」并全部列出 |
| `no-symbol` | 空白处 → 不弹卡片（保持安静） |
| `indexing` | 「索引进行中，符号信息稍后可查」（`02-lens.md` 未要求，属超出） |
| `literal` | 字面量溯源 |

---

## 三、实际的悬停卡片（实测原文）

**Python（`services/fr_load.py:63` 的 `demand_card`）**——与 `02-lens.md` §3.1 的线框**逐字段一致**：

```
demand_card  function
services/fr_load.py:63
──────────────────────────
def demand_card(path: str) -> Optional[Dict[str, Any]]:
path: str · → Optional[Dict[str, Any]]
单篇需求文档 → 卡片；文件名不是 `FR-<数字>…md` 返回 None
字段与知识页案例卡片同形（docNo/title/status/priority/path/updated/acceptance/resultRuns）…
引用 2 处
```

对应线框：名字+种类 → 定义位置 → 分隔线 → 签名 → 类型 → doc → 引用数。**设想的结构完整落地。**

**TypeScript（`backend/src/indexer/resolver.ts:79` 的 `resolveRef`）**：

```
function resolveRef(project: ProjectIndex, fi: FileIndex, ref: RefRecord): Resolved | null   ← 见 P2
resolveRef  function
backend/src/indexer/resolver.ts:79
function resolveRef(                                                                          ← 见 P3
引用 12 处
```

---

## 四、超出设想的三处

1. **`indexing` 结论**：`02-lens.md` §3.1 只要求「没信息时不弹垃圾」，实现加了一整态——索引未完成时明确说「索引进行中，符号信息稍后可查」，而不是误报「认不出类型」。这正是我在 03 报告 Q12 里提出的坑，02 自己先解决了。
2. **`infer-needed` 给链头定义位置**：`obj.method` 无法定位时，不只给一句人话，还给出 `obj` 本身的定义位置（可点）。这比设想的「只解释」有用。
3. **同名多定义不替用户猜**：`unresolved` 时列出全部候选位置，并在卡片上写明「同名定义 2 处，未替你选择」。设想里没有这一条，但它是「绝不伪造数据」原则的正确延伸。

---

## 五、与设想不一致的地方（3 处，均附修法）

### P1（缺陷，建议立即修）：悬停卡片里「引用 N 处」点了没反应

- **现象**：卡片上「引用 12 处」是可点链接，但点击后不弹出引用面板。
- **根因（已实测定位）**：`frontend/src/monaco-setup.ts:501` 用
  `live.getAction('editor.action.referenceSearch.trigger')?.run()` 触发引用查找，
  但该 action 在当前 Monaco 版本里**不存在**——`editor.getSupportedActions()` 与按 label 检索都返回空。`?.` 把失败静默吞掉，所以既不弹面板也不报错。
- **修法（已实测验证）**：改用 `trigger` 通道即可，peek 面板正常弹出：

  | 调用方式 | 结果 |
  |---|---|
  | `getAction('editor.action.referenceSearch.trigger')?.run()`（现状） | 无任何反应 |
  | `trigger('keyboard', 'editor.action.referenceSearch.trigger', null)` | **peek 弹出（peek 数 0 → 1）** |
  | `trigger('keyboard', 'editor.action.goToReferences', null)` | 无效 |

- **旁证**：Shift+F12 本身是好的（peek 正常，DOM 出现 `reference-zone-widget results-loaded`）。坏的只有卡片上这条入口。

### P2（问题，需你拍板）：TS/JS 上出现两份签名

- **现象**：TS/TSX/JS/JSX 文件悬停时，同一个符号先出现 Monaco 内置 TypeScript 语言服务的签名，再出现我们的卡片；Python 无此问题。
- **证据**：

  | 文件 | 卡片内容 |
  |---|---|
  | Python `fr_load.py` | 只有我们的一份，干净 |
  | TS `resolver.ts` | `function resolveRef(project: ProjectIndex, fi: FileIndex, ref: RefRecord): Resolved \| null` **（内置服务）** + `function resolveRef(` **（我们的）** |
- **根因**：`monaco-setup.ts` 只关了 TS 的诊断项（`noSemanticValidation` / `noSyntaxValidation` / `noSuggestionDiagnostics`），**没有关 hover**，所以 Monaco 的 TS 语言服务仍在为一个 `wcr://` model 提供悬停。
- **风险**：内置服务只看当前 model 文本，跨文件场景给出的可能是**不完整甚至误导**的类型；而它与我们的卡片并列，用户无法分辨哪份可信。
- **建议**：在 `typescriptDefaults` / `javascriptDefaults` 的 `setModeConfiguration` 里关掉 `hover`，悬停信息统一由后端提供（与 `02-lens.md`「只陈述索引里确定的事实」一致）。**这条需要你确认**：若你更看重内置服务的类型提示，也可以反过来——保留它、去掉我们的签名行。

### P3（体验，建议改进）：多行签名退化

- **现象**：签名取「声明首行」。Python 签名通常单行 → 完整；TS/Java/Go 的多行签名首行往往只有 `function resolveRef(`，参数全丢。
- **证据**：同一函数，API 返回 `signature: "function resolveRef("`，而源码是 5 行的参数列表。
- **反衬**：内置 TS 服务恰好补上了这一信息（见 P2），所以「重复」在某种意义上掩盖了「退化」；一旦按 P2 关掉内置 hover，这个退化会立刻显形。
- **建议**：把 `DefRecord.detail` 的生成从「首行」改为「压平签名」——从声明起点读到第一个 `{`（Go/TS）、`:`（Python）、`)` 或行数上限为止，多行合并为一行并限长。既不引入推断（仍只用源码文本），又能让 L3d 真正可用。

---

## 六、未覆盖 / 待确认

| 项 | 说明 |
|---|---|
| L3c 点击跳转的端到端点击 | 命令与载荷路径已核实存在，未单独做「点击 → 跳转」的浏览器断言 |
| 卡片视觉样式 | 截图已生成（`tmp/uitest/shot-lens.png`），但压缩后无法判读配色细节；`styles.css` 中按 `codicon-wcr-hover-*` 前缀定义，与 Monaco 的 DOMPurify 清洗做了适配 |
| 大文件密度条 | 只测了 1193 行的文件；未见 >1MB（不索引）时的表现 |
| P2 的取舍 | 需你决定「关内置 hover」还是「去我们的签名行」 |

---

## 七、复现命令

```bash
cd D:/01_code/02_work_code/ide
npm test && npm run typecheck           # 后端 92/92 + 类型检查

cd backend && npx tsx tmp/verify-lens.ts        # API 端到端：七种 reason + density
cd backend && npx tsx tmp/diag-lens-langs.ts    # L4/L5/L7 在 TS 与 Python 上的覆盖对照

cd tmp/uitest && node lens.mjs           # 浏览器：4 个悬停用例 + 密度条（需 8787 在跑）
cd tmp/uitest && node diag-dup.mjs       # Python 与 TS 卡片内容对照（P2 证据）
cd tmp/uitest && node diag-f12.mjs       # Shift+F12 可用 + 引用入口失效的根因与修法（P1 证据）
cd tmp/uitest && node click-refs.mjs     # 点卡片引用链接的现状（无反应）
```

---

## 八、结论

**与我设想的一致性：结构上完全一致，细节上有 3 处偏差。**

- 设想的核心——「悬停卡片作为 L3/L4/L5/L7 的统一载体，字段按身份→位置→契约→解释→影响排序，没信息时不弹」——**完整落地**，Python 上的实际卡片与 `02-lens.md` §3.1 的线框逐字段吻合。
- 三条纪律（只陈述确定事实、不推断、失败给一句人话）全部遵守：`external` 不假装可跳、`infer-needed` 坦白说「无法确定类型」、同名多定义不替用户选。
- 需要收尾的是 1 个缺陷（P1，修法已验证）、1 个决策（P2）、1 个改进（P3）。**这三点修完，02 才算真正完成**；就当前状态而言，它是「可用且可信，但有一个入口是哑的」。

---

## 九、收尾结论（P1/P2/P3 + 两处遗留的处置）

**已全部收口。** 逐项如下，每条都附实测证据。

### 9.1 P1 引用入口失效 —— 已修

- 改法：`frontend/src/monaco-setup.ts` 的 `revealAndFindReferences` 由
  `getAction('editor.action.referenceSearch.trigger')?.run()` 改为
  `trigger('keyboard', 'editor.action.referenceSearch.trigger', null)`（前者恒为 undefined，被 `?.` 静默吞掉）。
- 实测（`tmp/uitest/click-refs.mjs`）：点击卡片「引用 N 处」后 `.peekview-widget` 数 **0 → 1**，peek 正常弹出。

### 9.2 P2 内置 TS hover 与卡片并列 —— 产品结论：**删**

- 判断依据：`02-lens.md` §6 明写「悬停**不引入 LSP / TS 语言服务**去猜类型，只陈述索引里确定的事实」。
  内置服务只看当前 model 文本，跨文件场景给不出确定信息，与卡片并列时用户无法分辨可信度——它的产出是**重复且更差**的一份。
- 改法：`registerCodeProviders()` 里对 `typescriptDefaults` / `javascriptDefaults` 关掉 `hovers`
  （注意字段名是 `hovers`，且当前 monaco 版本没有 `getModeConfiguration()`，用只读属性 `modeConfiguration` spread 后改一项，避免漏字段误关其它能力）。
- 实测（`tmp/uitest/diag-dup.mjs`）：TS 文件卡片从「内置签名 + 我们的签名」两份 → **只剩我们的一份**；
  Python 卡片不变；`lens.mjs` 4/4 仍通过（我们的 provider 未受影响）。

### 9.3 P3 多行签名退化 —— 已修（并净化排版）

- 改法：`DefRecord.detail` 从「声明首行」改为「压平签名」——从声明起点读到签名结束
  （深度 0 的 `{` / `;`；Python 参数括号闭合后的 `:`），多行合并、限长 160；扫不到终止符时退回原首行（保底）。
- 排版净化：压平后 `f( a, b, )` 这类噪声按上下文折行（开括号之后、闭括号之前不补空格），并去掉紧邻闭括号的尾逗号。
- 实测（`tmp/uitest/lens.mjs`）：
  `function resolveRef(project: ProjectIndex, fi: FileIndex, ref: RefRecord): Resolved | null`（此前只有 `function resolveRef(`）。
- **影响面**（有意变更）：hover 的 `signature`、document-symbols 与 workspace-symbols 的 `detail` 三处同步变为压平版；相关既有断言已更新。

### 9.4 遗留补充：L6 配置键溯源 —— 已补（含一处更深的问题）

- 新增：`cfg["k"]` / `config["k"]` / `m["k"]` / `arr[0]` 这类**下标键字符串**悬停时给出「被索引的对象」
  （Python / TS / JS / Go / Java）；对象是调用或其它复杂表达式时不给（宁可不给，别编）。
- 更深的问题（原报告未覆盖）：**f-string 内的键此前完全不可溯源**——`walk()` 收集字符串字面量后直接 `return`，
  模板串里的表达式从没被遍历过，悬停只会落在外层整条模板串上。已修两处：
  1. 字符串字面量记录后继续遍历子节点（`f"{cfg['k']} {user.name}"` 的键与变量都进索引）；
  2. 悬停改为「**最具体覆盖者胜出**」（同一位置被定义 / 引用 / 字面量多重覆盖时取范围最小者），
     否则外层模板串会反过来遮蔽内部的键与变量。
- 实测（真实项目 `xchen-core`）：
  `data['pid']` → `keyOf=data`；`agent_context['session_id']` → `keyOf=agent_context`；
  `f'{agent_context["context_overflow_retries"]}'` → `keyOf=agent_context`（此前给不出）；`f"comment: {item['comment']}"` → `keyOf=item`。
- 边界（诚实声明）：配置键**不给跳转**——项目里没有「键的定义位置」这一确定事实，只给「它被当作谁的下标用」+ 同值出现处数。

### 9.5 命名消歧 —— 已做

01 地图 M11.4 与本文档 §3.4 各加交叉注记：**「符号密度」（跨文件，每文件定义数）** 与
**「行密度条」（单文件内部，每 20 行的代码/注释/空白占比）** 不是同一概念，文案统一分别称呼。

### 9.6 收尾后的验收基线（可复现）

```bash
cd D:/01_code/02_work_code/ide
npm --prefix backend test        # 104/104 通过（含 f-string / 压平签名 / keyOf 新例）
npm --prefix backend run typecheck
npm --prefix frontend run typecheck && npm --prefix frontend run build
cd tmp/uitest && node lens.mjs   # 4/4，页面无 console error
cd tmp/uitest && node click-refs.mjs   # 点「引用 N 处」→ peekview-widget = 1
cd tmp/uitest && node diag-dup.mjs     # TS 卡片只剩一份签名
cd .. && node verify-keyof.mjs && node verify-fstring.mjs   # 真实项目配置键 / f-string 溯源
```

### 9.7 仍然明确不做的（边界，非遗漏）

| 项 | 理由 |
|---|---|
| 行尾注释作为 doc | 归属歧义大，只取「声明上方紧邻」（宁可少不要错） |
| TS 方法级装饰器 | 首版只采类级装饰器；方法级另开一项 |
| Go 的装饰器/注解 | 语言无此概念，字段缺省、卡片不显示这一行 |
| 密度条的「空壳」严格口径 | 契约缺 declaration 占比，用空白占比近似（已注明） |
| 「键/字面量 → 定义」的假跳转 | 没有确定事实就不给跳转，只给同值/同键计数 |
