# TOC 树 + 本地 Jev 判定：证据定位验证设计

日期：2026-09-26
修订：2026-09-26（路线 C —— 树源由 PDF 目录改为 QASPER 节结构，详见「修订说明」）
分支：`feat/jev`（本设计与后续全部实现、实验代码只留在该分支，不合入 main）

## 修订说明

初版以「PDF 自带目录」为树源，用 pdfjs `getOutline()` 提取；据此写出的实施计划在自审中逐条核对数据通路时发现**前提不成立**：

bench 的 QASPER 通路**从不打开 PDF**。`bench/src/datasets/qasper.ts` 的 `sectionsToPages` 把 `full_text` 的「节标题 + 段落」按 3000 字符打包成**伪页**，`EvalSample.pages` 是伪页文本，`evidencePages` 是**伪页下标**。全仓只有 `bench/datasets/smoke/`（5 篇真实 PDF）走 pdfjs；`bench/cache/` 里 2938 个文件全是 LLM 响应缓存，零个 PDF；`qasper.jsonl` 不含 arXiv id 或任何 PDF 引用。

真实 PDF 页码与伪页下标之间**没有对应关系**——`paragraphToPage` 只在构建伪页时存在于内存，落库后已压平。因此 TOC 臂无法与 `passage-hybrid` 等既有基线落在同一把尺子上（§3.3 要求 `evidenceMappingVersion='page-evidence-v1'`，而真实 PDF 页空间是另一套映射）。

**修订后的路线 C**：改用 QASPER 自带的 `section_name` 建树，全程留在伪页空间，与冻结基线可比。代价见「非目标」与「风险与未决」。

## 目标

验证「用论文的章节结构建一棵树，检索时用本地决策模型 Jev 逐层判定『这一节是否为当前问题的证据』，命中后再由 LLM 依据原文作答」这条链路，相对现有检索路径**是否带来可复现的收益**。

**验证的层次是管线层，不是模型层。** 结论要回答的是「这条链路值不值得做」，而不是「Jev 单点判定准确率是多少」。单点准确率作为诊断指标顺带记录，不作为验收依据。

## 非目标

- 不改产品默认检索路径。本轮只在 bench 中验证，产品侧沿用 `passageRetrieval`。
- **不验证「从 PDF 抽目录」这一步。** 路线 C 的树源是 QASPER 数据集自己标的节标签，比真实 PDF outline 干净得多（无页码解析失败、无缺页、无同页兄弟）。本轮的结论**不能外推**到产品里从 PDF 建树的可信度；那一环若将来要做，须单独实测。
- 不做 Laya 的微调或再训练。
- 不实现产品后台调度、UI 状态或数据库表。
- 不做 ONNX 移植（见「运行时」一节）。

## 已确认的实测事实

以下全部由探针实测得出，是本设计的依据，不是估计。

### 为什么放弃 PDF 目录路线

本地 6 篇真实论文中 4 篇自带 PDF 目录（attention / deep-sets / llm-survey / gpt3），**2 篇没有**（BERT、smoke 样本）。BERT 这样的高引论文没有目录，说明覆盖率缺口不是边缘情况。用 pdfjs 解析目录时 attention 22/22、llm-survey 115/115 条目全部解析出页码——**但 outline 只给起始页，不给结束页**。

`reconstructTextLines` + 正则还原章节标题的回落方案**已实测不可用**：BERT（双栏排版）扫出的 10 个「边界」全是误报。根因在上游的行重建，不是正则可调。

以上事实支持「不做 PDF 目录」的判断，记录备查。

### QASPER 节结构（路线 C 的树源）

对 HF `allenai/qasper` validation split 前 100 篇实测：

| 指标 | 结果 |
|---|---|
| 有 `section_name` 的论文 | **100/100** |
| 完全扁平（深度 1，无 `:::`） | 68 篇 |
| 深度 2 | 17 篇 |
| 深度 3 | 15 篇 |
| 节数 | min 4 / 中位 13 / max 36 |
| 同篇内重名节 | 0 篇 |
| 空 `section_name` | 0 篇 |

`section_name` 是**每节一个字符串**（长度等于 `paragraphs` 的外层长度，而 `paragraphs` 是 list-of-lists）。层级用 ` ::: ` 显式编码，父节点自身通常也作为独立条目出现：

```
Approach                                              ← 父节点自带条目
Approach ::: Masked and Translation Language Model Pretraining
Approach ::: Bridge Language Model Pretraining
Experiments ::: Setup
Experiments ::: Setup ::: Datasets.
```

**关键后果：三分之二的论文是单层树**，`traverseWithJudge` 在它们上退化为「对一列节打分 → 阈值 → top-N」，**不会发生层级下探**。层级机制只在 32% 的论文上被真正执行。这一条必须体现在结果报告里（§3.4），不能只报总体均值。

### Jev 的运行与判定行为

本地权重 `models/laya/laya-mlx/`（源 `convaiinnovations/laya` 英文 base，rev `c5d78730f3493e4fe16d61507ef4b78eef7318cf`），经 `laya-mlx` 0.2.0 + Python 3.13 加载：

- 加载耗时 0.3s；单次判定 17–26ms；22 个节点全量打分 0.4–0.6s。`batch_size=16`，可批处理。
- 返回结构化概率，如 `{"type":"noul","confidence":0.7445,"noul":0.7445}`；`output_tokens: 0`，确认非自回归。
- 输入形态：`state` 支持具名变量字典，`instructions` 用反引号引用（``Does `section` contain evidence that answers `question`?``）。**传裸字符串且不引用时模型看不到该文本**——这是必须写死的调用约定。

**区分度实测（22 个真实章节标题，两个问题）：**

| 问题 | 第 1 名 | 第 2 名 | 该节点在另一问题的位置 |
|---|---|---|---|
| 注意力头数/每头维度 | `Model Architecture > Attention > Multi-Head Attention` 0.1490 | `Attention` 0.0994 | 掉出前八 |
| 优化器与学习率调度 | `Training > Optimizer` 0.3930 | `Training` 0.2124 | 倒数第三 0.0282 |

同一节点在两个问题间落到分布两端，说明模型同时读了「问题」与「章节标题」，不是在复读输入。**信号是真实的。**

**但绝对概率整体压在 0.03–0.39 区间，最高 0.393。** 加载时 `laya-mlx` 抛出警告：该 checkpoint 温度参数超出 `[0.5, 5]`，置信度会被 clamp，受影响的桶「视为未校准」。因此**绝对阈值不可用**（详见 §2.2）。

### 已知的模型局限

- 这是**零样本 base checkpoint**，其自身 README 明确其定位为「适合微调的底座」，`typed-decisions` 才持有 0.766 那类指标。本设计不假设它在该任务上表现良好——**这正待本实验回答**。
- 总上下文 512 token，由「状态文本 + 问题 + 选项」共享。送入的一节标题加父路径通常只有几十 token，**容量在这里不是约束**（这一点与 PDF 路线不同：那里要面对 115 个条目的批量打分）。

## §1 架构与模块边界

方案为「判定逻辑与运行时解耦」，进一步按「数据集无关」与「bench 专属」切一刀：

```
src/utils/tocTree.ts            纯函数，零运行时依赖，数据集无关
  interface TocNode { id; title; path; depth; pages: number[]; children }
  traverseWithJudge(tree, query, judge, opts) → TocSelection
  tocSelectionToContextGroups(selected, pages) → ContextGroup[]

src/utils/evidenceJudge.ts      纯接口
  interface EvidenceJudge { judge(input: JudgeInput): Promise<number[]> }
  interface JudgeInput { query: string; nodes: { id; title; path }[] }

bench/src/toc/qasperTree.ts     bench 专属：QASPER 节结构 → TocNode[]
bench/src/jev/                  实验专属，不入产品
  mlxJudge.ts   EvidenceJudge 的 MLX 实现（stdio JSON-lines 客户端）
  sidecar.py    常驻 Python 进程，持有 Agent 实例
```

**边界理由：**

- `tocTree.ts` 只认识 `TocNode` 与概率数组，**不认识 QASPER、不认识 PDF、不认识 LLM**。给定一棵树和一个 `EvidenceJudge` 即可测试。
- 树的**构造器**放 bench：它读的是 QASPER 的 `section_name` 与伪页布局，是数据集专属物。产品若将来要用，会配一个从 PDF 目录构造的兄弟模块，`tocTree.ts` 一行不改。
- `EvidenceJudge.judge` **是批量的**。这是必须而非优化：逐节点调用会把侧车往返开销放大一个数量级。批量大小由实现方决定。
- MLX 侧车是 bench 私有物，**产品永不含 Python 依赖**。

## §2 数据流

### 2.1 建树（零 LLM）

**建树阶段零 LLM 调用**，这是本设计相对现有 `semanticTree`（每篇一次 LLM 调用）的核心差异。

树源是 `full_text.section_name`（每节一个字符串，` ::: ` 分隔层级）与 `full_text.paragraphs`（每节的段落数组）。规则逐条定死：

| 规则 | 理由 |
|---|---|
| 节点 `title` = 节名按 ` ::: ` 切分后的**末段**，`path` = 之前的各段，各段 `trim()` | ` ::: ` 是 QASPER 的层级编码；trim 是必要的——实测存在 `'Dogmatism in the Reddit Community '`（尾随空格）这类脏值 |
| 按 `path` 前缀还原父子关系；**父节点缺条目时合成一个**（`pages` 为空） | 实测父节点通常自带条目，但不保证每篇都如此。合成的父节点只作导航，不携带正文 |
| 节点 `pages` = **该节内容实际落到的伪页号**，升序 | 见下 |
| 节无任何内容（标题空且无段落）→ 整条丢弃 | 它不会进入任何一次判定 |

**`pages` 必须由 `sectionsToPages` 的同一段打包循环产出，不得另写一套。** 这是本设计最容易出错的地方：`bench/src/datasets/qasper.ts` 的 `sectionsToPages` 决定了伪页边界，`evidencePages` 由它产出；节区间若用另一个实现算，两边会在边界上错开一页，而指标照常输出数字，**静默失真**。做法是给 `sectionsToPages` 增加一个返回值 `sectionPageRanges`，在原循环里顺手记录，**不改动它已产出的 `pages` 与 `paragraphToPage`**（改那两者会让全部缓存与既有结果失效）。

由此得到两个与原设计相反的结论：

- **不需要推导区间。** PDF 路线只给起始页，所以必须用「下一个非后代节点起始页 − 1」硬凑 `endPage`，才有同页兄弟、负区间那一整套规则。QASPER 的节内容落在哪些伪页是打包时**已知**的，量出来即可。因此 `TocNode` 存 **`pages: number[]`** 而不是 `startPage`/`endPage`——空区间、负区间、`max(自身 startPage, 子节点 endPage)` 这些规则**全部消失**。
- **兄弟节点可以共用伪页，区间会重叠。** 打包按 3000 字符 flush，不在节边界切。这不是缺陷：`materializeContext` 的 `pageOrder` 用 `seen` 去重、以首次出现为准，重叠不会污染四个检索指标。父子之间的 `pages` 同样会重叠（父节的引导正文与其子节落在同一页），这是真实的文档形态。

### 2.2 阈值语义：层内相对阈值

因绝对概率最高仅 0.393，固定绝对阈值（如 0.5）会滤掉全部节点。阈值机制保留，基准改为层内相对：

```
θ_层 = α × max(该层所有候选概率)        α ∈ (0, 1]
```

- `α → 0` 退化为「纯 top-N，无阈值」
- `α = 1` 退化为「每层只保留并列最高者」
- **优点**：对未校准概率免疫（正好对症 temperature clamp 那条警告），且不需要任何标注数据
- **缺点**：该层最高分若本身是噪声，噪声也被放大保留，靠 top-N 兜底
- **推论（必须写死）**：`α ≤ 1` 且分数 `≥ 0` 时，取得本层最高分的节点恒满足 `score ≥ α × max`，因此**「阈值把整层滤光」在算术上不可达**（全零分时 `θ = 0`，亦然）。这条推论删掉了初版设计里「阈值滤光 → 取 top-1」的回落路径：它不可能被触发，是死代码。

`α` 与 `N` 都是实验扫描旋钮，在设计中不拍死具体值。

### 2.3 遍历

每层：`judge(批量)` → 计算层内相对阈值 → 存活节点 → 超过 N 则取 top-N → 有子节点则下探，是叶子则收为证据。

**父节点何时成为证据，必须按以下规则定死**（否则会出现两种实现）：

- 存活且**有子节点** → 下探，父节点本身**不**直接收为证据（它只是导航；其页区间会通过子节点间接进入上下文）
- 存活且**无子节点** → 收为证据
- 存活、有子节点，但**下探颗粒无收** → 父节点兜底收为证据

第三条的触发条件被 `pages` 表示法大幅收窄：`pages` 为空的节点（无内容的合成父节点、或内容全被丢弃的节）在阈值上仍可存活，但下探必然无果。因此兜底仍需保留，但它由 **`pages` 为空**触发，而非初版设想的「子节点全被阈值滤光」（按 §2.2 不可能）。

**`pages` 为空的节点绝不可收为证据**——它不携带任何页内容。收集阶段一律跳过并计数。若最终一个节点都没收到，回落文档顺序里第一个 `pages` 非空的节点（该节点必然存在，除非整篇无内容），并置 `emptySelectionFallback: true`。

收集阶段**不设独立预算**：所有存活叶节点的原文交给 `materializeContext`，由其按统一 token 预算裁剪。这样预算只有一个来源，不会出现「收集时截一次、物化时再截一次」的双重口径。

### 2.4 与现有管线的契约

产出必须满足现有 `RetrievalResult` 接口，使 `ragPipeline.ts:245` 的第四路分派可零改动接入。诊断字段（§4 表格中的各字段）沿用 `semantic?` / `hybrid?` 的既有模式，作为结果对象上的**可选**字段附加，不改变 `RetrievalResult` 的必填契约。

特别地 `contextGroups` 必须满足 `ContextPiece` 的逐页无损分区不变量。

**这条是硬约束**：bench 的四个检索指标建立在物化器从最终上下文**同源**产出的 `pageOrder` 上（`metricSchemaVersion: 2` / `mrrDefinition: 'context-page-v1'`）。若自行拼接上下文，指标口径与现有基线不同源，跑出的数字无法比较。重叠页组经 `seen` 去重后仍满足该不变量。

## §3 实验设计

### 3.1 对照臂

| 臂 | 树 | 打分器 | 作用 |
|---|---|---|---|
| A `toc-bm25` | QASPER 节树 | BM25 over `title+path` | **主对照**：同一棵树、同一份输入文字、同一套遍历，**仅打分器不同** |
| B `toc-jev` | QASPER 节树 | Jev | 实验主体 |
| C `passage-hybrid` | — | 段落 BM25+向量+RRF | 现有产品默认，引用已入库历史结果 |
| D `flat-global-bm25` | — | 全文档 BM25 | 地板，确认不是「随便做点什么就赢」 |

**A vs B 是核心比较**：单变量、输入逐字相同。若 B 打不过 A，则「用 Jev 做结构检索」的增量价值为零，该结论无法靠调参规避。

可选第二期加 `toc-jev-flat`（不遍历、全节点一次打分），分离「层级遍历有用」与「Jev 有用」。因批处理成本极低，该消融代价很小。

### 3.2 扫描旋钮与防过拟合纪律

扫描 `α × N` 网格。**纪律**：QASPER 切 dev/test 两半，`α`/`N` **只在 dev 上调整**，test 只跑最终选定格点。索引输入只含论文，不含问题与标准答案。

### 3.3 契约对齐

四个检索指标（`contextPageMrr` / `evidenceRecall` / `evidenceHit` / `contextPrecision`）只有在同一份 `EvaluationContract` 下才可比：`metricSchemaVersion=2`、`mrrDefinition='context-page-v1'`、`CONTEXT_BUDGET_TOKENS=4096`、BGE-M3 tokenizer、`evidenceMappingVersion='page-evidence-v1'`、同一 `datasetFingerprint` 与 `eligibleRetrievalQuestionIdsHash`。**任一不同，禁止与现有基线做差值。**

路线 C 全程使用伪页空间，**保持 `page-evidence-v1` 不变**，这是它相对 PDF 路线的决定性优势。

主表切片按 `bench/CLAUDE.md` 的冻结纪律：**前 60 篇 / 179 题**。其他切片只能作为独立的规模泛化实验，禁止与主表混排。

### 3.4 必须同时报告的分组口径

只报总体均值会掩盖本节最重要的发现（68% 的论文是单层树、层级机制在它们上不生效）。必须分开报：

1. **深度 1 子集**（68%）：退化为「对一列节打分 → 阈值 → top-N」，测的是判定器的**选择能力**
2. **深度 ≥ 2 子集**（32%）：层级下探真正发生，测的是**路由能力**
3. **全体**：可推广效果

三个数字都报。只报一个必然失真——只报深度 ≥ 2 是高估，混着报会低估层级机制本身的表现。

### 3.5 验收口径

不设「必须提升 X%」的硬门槛（Q-score 的已知局限：词法 F1、仅 QASPER、P95 噪声，小差距不定胜负）。判据为：

1. **方向性是否稳定**：B 优于 A 是否在 dev/test 及 α/N 网格的**多数格点**上成立。
2. **效应量是否越过噪声带**：被噪声吃掉的差值不计为收益。
3. **B 打不过 A 即为有效结论**：如实记录「Jev 在此任务无增量价值」，**不追加调参抢救**。

### 3.6 必须写明的诚实披露

- Jev 臂与 `passage-hybrid` 一样是**回答前零 LLM 调用**。因此相对现有默认路径，本方案**没有任何成本优势**，它能主张的只有质量或可解释性。此句须保留，避免日后被误读为「省钱的优化」。
- 路线 C 的树源是**数据集标注**，不是 PDF 目录。结论对「产品里从 PDF 建树」的可信度**零证据**。

## §4 错误处理与回落

本方案比现有三条路径**多一个全新失败面**：Python 侧车。回落粒度是**「篇」而非「整个查询」**，沿用既有「单篇失败不影响其余论文」的口径。

| 失败点 | 触发 | 回落 | 诊断字段 |
|---|---|---|---|
| 无节结构 | `section_name` 为空 | 该篇 → `passage-hybrid` | `tocUnavailable:'no-sections'` |
| 节结构非法 | 空标题 / 层级过深（> `MAX_TOC_DEPTH`）/ 自嵌套 | 该篇 → `passage-hybrid`（整棵作废，不修补） | `tocUnavailable:'invalid-sections'` |
| 父节点缺条目 | `A ::: B` 存在但 `A` 无独立条目 | 合成父节点（`pages` 为空），**保留树**，只作导航 | `synthesizedParents:n` |
| 节无内容 | 标题空且无段落 | 丢弃该节点 | `droppedSections:n` |
| 侧车不可用 | 启动失败 / 崩溃 / 超时 | 该篇 → `passage-hybrid` | `judgeUnavailable:true` |
| Jev 返回异常 | NaN / 越界 / 批量长度不匹配 | 该篇 → `passage-hybrid`（不拿垃圾概率继续跑） | `judgeDegraded:'invalid-output'` |
| 空选择 | 存活节点全无 `pages` | 回落文档顺序首个 `pages` 非空的节点 | `emptySelectionFallback:true` |
| 预算截断 | 选中节点超预算 | 保留能进入的部分，`truncated` 如实置位（沿用 `materializeContext`） | 既有字段 |

三条纪律：**绝不静默**（每次回落写结构化诊断，bench 统计回落率作为一类结果）、**不修补**、**侧车崩溃按篇隔离**（一次崩溃不得拖垮整轮实验；判定无副作用，重启后可重试）。

## §5 测试策略

| 文件 | 覆盖 | 关键点 |
|---|---|---|
| `src/tests/tocTree.test.ts` | 遍历纯函数 | `pages` 为空的节点绝不收为证据；下探的父节点不作为证据；下探无果时父节点兜底；空选择回落首个非空节点；相对阈值两个退化端点（`α=0` / `α=1`）；最高分节点在任意 `α∈[0,1]` 下恒存活（钉死「阈值滤光不可达」）；top-N 截断与同分稳定序；纯函数不 import pdfjs / 网络 |
| `src/tests/evidenceJudge.test.ts` | 接口契约（注入假实现） | 批量语义、返回长度校验、NaN 与越界拒绝 |
| `bench/src/tests/qasperTree.test.ts` | QASPER 节 → 树 | ` ::: ` 层级还原；父节点缺条目时合成；空标题丢弃；同篇重名不误判为自嵌套；**`sectionPageRanges` 与 `pages`/`paragraphToPage` 由同一次打包产出**（改 `sectionsToPages` 后 `evidencePages` 不变，用既有 fixture 钉死） |
| `bench/src/tests/jevSidecar.test.ts` | 侧车协议 | JSON-lines 往返、崩溃、超时、并发不串线——**全部用假侧车** |

**硬纪律：遍历与建树的测试绝不依赖 Python 或 MLX 权重，也不依赖网络。** 这是 §1 解耦设计的直接回报——CI 与其他机器上均可运行。真实推理只由探针与实验负责，沿用现有 `transformersEmbedder` 的做法（单测中 mock 掉外部依赖）。

交付前 `npm test` 与 `npm run typecheck` 必须全绿。

## 风险与未决

| 风险 | 状态 |
|---|---|
| base checkpoint 零样本在该任务上可能整体偏弱 | 已知，这正是实验要回答的；若偏弱则结论为「需微调后才谈得上价值」 |
| 概率未校准，相对阈值可能仍不稳定 | 已用层内相对阈值规避绝对基准问题；残余风险由 α/N 网格扫描暴露 |
| **68% 论文是单层树，层级机制在它们上不生效** | 已量化。靠 §3.4 的分组报告暴露，不靠调参掩盖 |
| **结论不能外推到「从 PDF 建目录」** | 路线 C 的固有局限，须在报告与 README 中重复声明 |
| QASPER 节标签本身的质量（脏值、非节标题的疑问句作节名） | 实测见 `'Dogmatism in the Reddit Community '`、`'What subreddits have...? (R1)'`。前者由 trim 处理，后者如实送入判定器——它确实是原文的一个节 |
| 侧车进程管理（僵尸、超时、并发） | 设计已按篇隔离；具体实现细节见实施计划 |
| `sectionsToPages` 被改动可能波及既有结果 | 只增加返回值、不改 `pages` / `paragraphToPage`；用既有 fixture 钉死（§5） |

## 交付物

1. `src/utils/tocTree.ts`、`src/utils/evidenceJudge.ts` 及各自单测
2. `bench/src/toc/qasperTree.ts` + `sectionsToPages` 的 `sectionPageRanges` 扩展及单测
3. `bench/src/jev/`（MLX 实现 + Python 侧车）及协议测试
4. bench 配置：`toc-bm25` / `toc-jev`（必要时含 `toc-jev-flat`）
5. 带**深度分组**、四指标、成本与时延的对照报告；回落率与诊断分布
6. 无论正向或负向，如实记录的结论
