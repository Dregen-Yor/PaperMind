# TOC 树 + 本地 Jev 判定：证据定位验证设计

日期：2026-09-26
分支：`feat/jev`（本设计与后续全部实现、实验代码只留在该分支，不合入 main）

## 目标

验证「用论文自带目录建一棵树，检索时用本地决策模型 Jev 逐层判定『这一节是否为当前问题的证据』，命中后再由 LLM 依据原文作答」这条链路，相对现有检索路径**是否带来可复现的收益**。

**验证的层次是管线层，不是模型层。** 结论要回答的是「这条链路值不值得做」，而不是「Jev 单点判定准确率是多少」。单点准确率作为诊断指标顺带记录，不作为验收依据。

## 非目标

- 不改产品默认检索路径。本轮只在 bench 中验证，产品侧沿用 `passageRetrieval`。
- 不做 Laya 的微调或再训练。
- 不实现产品后台调度、UI 状态或数据库表。
- 不追求 100% 目录覆盖率（见「覆盖率」一节）。
- 不做 ONNX 移植（见「运行时」一节）。

## 已确认的实测事实

以下全部由 2026-09-26 的探针实测得出，是本设计的依据，不是估计。

### 目录覆盖率与页码解析

本地 6 篇真实论文中 **4 篇自带 PDF 目录**（attention / deep-sets / llm-survey / gpt3），**2 篇没有**（BERT、smoke 样本）。BERT 这样的高引论文没有目录，说明覆盖率缺口不是边缘情况。

用 pdfjs（产品实际使用的库）解析目录：attention 22/22 条目、llm-survey 115/115 条目**全部解析出页码**，路径为 `getOutline()` → `getDestination()` → `getPageIndex()`。

**但 outline 只给起始页，不给结束页**，且同页多兄弟是常态：

```
Introduction        p2
Background          p2    ← 与 Introduction 同页
Model Architecture  p2    ← 三个顶层兄弟挤在同一页
  Encoder and Decoder Stacks  p3
```

`reconstructTextLines` + 正则还原章节标题的回落方案**已实测不可用**：BERT（双栏排版）扫出的 10 个「边界」全是误报（正文片段、页眉、图表文字），无一真节标题；有目录的论文也大量混入 `Figure 1:`、`Model Name n params` 一类噪声。根因在上游的行重建（双栏被拼成同一行），不是正则可调。因此本设计**不为无目录论文重建目录**。

### Jev 的运行与判定行为

本地权重 `models/laya/laya-mlx/`（源 `convaiinnovations/laya` 英文 base，rev `c5d78730f3493e4fe16d61507ef4b78eef7318cf`），经 `laya-mlx` 0.2.0 + Python 3.13 加载：

- 加载耗时 0.3s；单次判定 17–26ms；22 个节点全量打分 0.4–0.6s。`batch_size=16`，可批处理。
- 返回结构化概率，如 `{"type":"noul","confidence":0.7445,"noul":0.7445}`；`output_tokens: 0`，确认非自回归。
- 输入形态：`state` 支持具名变量字典，`instructions` 用反引号引用（``Does `section` contain evidence that answers `question`?``）。**传裸字符串且不引用时模型看不到该文本**——这是必须写死的调用约定。

**区分度实测（22 个真实目录标题，两个问题）：**

| 问题 | 第 1 名 | 第 2 名 | 该节点在另一问题的位置 |
|---|---|---|---|
| 注意力头数/每头维度 | `Model Architecture > Attention > Multi-Head Attention` 0.1490 | `Attention` 0.0994 | 掉出前八 |
| 优化器与学习率调度 | `Training > Optimizer` 0.3930 | `Training` 0.2124 | 倒数第三 0.0282 |

同一节点在两个问题间落到分布两端，说明模型同时读了「问题」与「章节标题」，不是在复读输入。**信号是真实的。**

**但绝对概率整体压在 0.03–0.39 区间，最高 0.393。** 加载时 `laya-mlx` 抛出警告：该 checkpoint 温度参数超出 `[0.5, 5]`，置信度会被 clamp，受影响的桶「视为未校准」。因此**绝对阈值不可用**（详见「阈值语义」）。

### 已知的模型局限

- 这是**零样本 base checkpoint**，其自身 README 明确其定位为「适合微调的底座」，`typed-decisions` 才持有 0.766 那类指标。本设计不假设它在该任务上表现良好——**这正待本实验回答**。
- 总上下文 512 token，且由「状态文本 + 问题 + 选项」共享。论文一节动辄数千 token，**Jev 看不到整节内文**。

## §1 架构与模块边界

方案为「判定逻辑与运行时解耦」：遍历逻辑是运行时无关的纯函数，单次判定抽象为接口，MLX 实现只存在于 bench。

```
src/utils/tocTree.ts           纯函数，零运行时依赖
  buildTocTree(pages, outline) → TocNode[]
  traverseWithJudge(tree, judge, opts) → SelectionResult

src/utils/evidenceJudge.ts     纯接口
  interface EvidenceJudge { judge(input: JudgeInput): Promise<number[]> }
  interface JudgeInput { query: string; nodes: { id; title; path }[] }

bench/src/jev/                 实验专属，不入产品
  mlxJudge.ts   EvidenceJudge 的 MLX 实现（stdio JSON-lines 客户端）
  sidecar.py    常驻 Python 进程，持有 Agent 实例
```

**边界理由：**

- `tocTree.ts` 不 import pdfjs、不 import 网络、不 import LLM。给定 `(outline, pages)` 即可测试，与现有 `pageIndex.ts` / `semanticRoute.ts` 的纯函数风格一致。
- `EvidenceJudge.judge` **是批量的**。这是必须而非优化：实测 22 节点 0.5s，逐节点调用会把侧车往返开销放大 22 倍。批量大小由实现方决定。
- MLX 侧车是 bench 私有物，**产品永不含 Python 依赖**。将来换 ONNX 实现时，`tocTree.ts` 与 `evidenceJudge.ts` 一行不改。

`tocTree.ts` 放 `src/utils/` 而非 `bench/src/`：它是无副作用纯函数且有单测覆盖，进入产品目录风险极低；而放 bench 再搬家是真实浪费。

## §2 数据流

### 2.1 建树（零 LLM）

复用现有 `extractPages` 取逐页文本，新增 outline 提取。**建树阶段零 LLM 调用**，这是本设计相对现有 `semanticTree`（每篇一次 LLM 调用）的核心差异。

页区间必须**派生**，规则逐条定死：

| 规则 | 理由 |
|---|---|
| 叶节点 `endPage` = 下一个「非自己后代」节点的 `startPage − 1`；最后一个节点取文档末页 | 不能用 min/max 猜跨度 |
| **同页兄弟产出零宽区间，必须显式容忍为空区间** | `Introduction p2 → Background p2` 会算出 `endPage < startPage`。负区间喂给 `pages.slice` 会**静默返回错页**，是最隐蔽的一类缺陷 |
| 父节点 `endPage` = `max(自身 startPage, 所有子节点 endPage)` | **不能简单并集子节点**，否则父节点在第一个子节点之前那段引导正文会丢失 |
| 深度上限截断、空标题、outline 成环 → 校验不过则整棵作废 | 沿用 `validateSemanticTree` 的「整份作废、不修补」口径 |

### 2.2 阈值语义：层内相对阈值

因绝对概率最高仅 0.393，固定绝对阈值（如 0.5）会滤掉全部节点。阈值机制保留，基准改为层内相对：

```
θ_层 = α × max(该层所有候选概率)        α ∈ (0, 1]
```

- `α → 0` 退化为「纯 top-N，无阈值」
- `α = 1` 退化为「每层只保留并列最高者」
- **优点**：对未校准概率免疫（正好对症 temperature clamp 那条警告），且不需要任何标注数据
- **缺点**：该层最高分若本身是噪声，噪声也被放大保留，靠 top-N 兜底

`α` 与 `N` 都是实验扫描旋钮，在设计中不拍死具体值。

### 2.3 遍历

每层：`judge(批量)` → 计算层内相对阈值 → 存活节点 → 超过 N 则取 top-N → 有子节点则下探，是叶子则收为证据。

**父节点何时成为证据，必须按以下规则定死**（否则会出现两种实现）：

- 存活且**有子节点** → 下探，父节点本身**不**直接收为证据（它只是导航；其页区间会通过子节点间接进入上下文）
- 存活且**无子节点** → 收为证据
- 存活、有子节点，但**所有子节点均被阈值滤光** → 父节点兜底收为证据，避免「下探后颗粒无收」

收集阶段**不设独立预算**：所有存活叶节点的原文交给 `materializeContext`，由其按统一 token 预算裁剪。这样预算只有一个来源，不会出现「收集时截一次、物化时再截一次」的双重口径。

### 2.4 与现有管线的契约

产出必须满足现有 `RetrievalResult` 接口，使 `ragPipeline.ts:245` 的第四路分派可零改动接入。诊断字段（§4 表格中的各字段）沿用 `semantic?` / `hybrid?` 的既有模式，作为结果对象上的**可选**字段附加，不改变 `RetrievalResult` 的必填契约。

特别地 `contextGroups` 必须满足 `ContextPiece` 的逐页无损分区不变量。

**这条是硬约束**：bench 的四个检索指标建立在物化器从最终上下文**同源**产出的 `pageOrder` 上（`metricSchemaVersion: 2` / `mrrDefinition: 'context-page-v1'`）。若自行拼接上下文，指标口径与现有基线不同源，跑出的数字无法比较。

## §3 实验设计

### 3.1 对照臂

| 臂 | 树 | 打分器 | 作用 |
|---|---|---|---|
| A `toc-bm25` | outline 树 | BM25 over `title+path` | **主对照**：同一棵树、同一份输入文字、同一套遍历，**仅打分器不同** |
| B `toc-jev` | outline 树 | Jev | 实验主体 |
| C `passage-hybrid` | — | 段落 BM25+向量+RRF | 现有产品默认，引用已入库历史结果 |
| D `flat-global-bm25` | — | 全文档 BM25 | 地板，确认不是「随便做点什么就赢」 |

**A vs B 是核心比较**：单变量、输入逐字相同。若 B 打不过 A，则「用 Jev 做结构检索」的增量价值为零，该结论无法靠调参规避。

可选第二期加 `toc-jev-flat`（不遍历、全节点一次打分），分离「层级遍历有用」与「Jev 有用」。因批处理成本极低，该消融代价很小。

### 3.2 扫描旋钮与防过拟合纪律

扫描 `α × N` 网格。**纪律**：QASPER 切 dev/test 两半，`α`/`N` **只在 dev 上调整**，test 只跑最终选定格点。索引输入只含论文，不含问题与标准答案。

### 3.3 契约对齐

四个检索指标（`contextPageMrr` / `evidenceRecall` / `evidenceHit` / `contextPrecision`）只有在同一份 `EvaluationContract` 下才可比：`metricSchemaVersion=2`、`mrrDefinition='context-page-v1'`、`CONTEXT_BUDGET_TOKENS=4096`、BGE-M3 tokenizer、`evidenceMappingVersion='page-evidence-v1'`、同一 `datasetFingerprint` 与 `eligibleRetrievalQuestionIdsHash`。**任一不同，禁止与现有基线做差值。**

### 3.4 覆盖率是第零类结果

必须同时报告三个数字：

1. **覆盖率实测**：QASPER 全量（180 篇量级）中有目录的论文数。本地 6 篇为 4/6，仅为参考。
2. **全题口径**：无目录论文走回落，衡量**可推广**效果。
3. **有目录子集口径**：衡量 Jev 能力的**上界**。

只报一个必然失真——只报子集是高估，混着报是低估。

### 3.5 验收口径

不设「必须提升 X%」的硬门槛（Q-score 的已知局限：词法 F1、仅 QASPER、P95 噪声，小差距不定胜负）。判据为：

1. **方向性是否稳定**：B 优于 A 是否在 dev/test 及 α/N 网格的**多数格点**上成立。
2. **效应量是否越过噪声带**：被噪声吃掉的差值不计为收益。
3. **B 打不过 A 即为有效结论**：如实记录「Jev 在此任务无增量价值」，**不追加调参抢救**。

### 3.6 必须写明的诚实披露

Jev 臂与 `passage-hybrid` 一样是**回答前零 LLM 调用**。因此相对现有默认路径，本方案**没有任何成本优势**，它能主张的只有质量或可解释性。此句须保留，避免日后被误读为「省钱的优化」。

## §4 错误处理与回落

本方案比现有三条路径**多一个全新失败面**：Python 侧车。回落粒度是**「篇」而非「整个查询」**，沿用既有「单篇失败不影响其余论文」的口径。

| 失败点 | 触发 | 回落 | 诊断字段 |
|---|---|---|---|
| 无 outline | `getOutline()` 返回 null | 该篇 → `passage-hybrid` | `tocUnavailable:'no-outline'` |
| outline 非法 | 空标题 / 成环 / 深度超限 | 该篇 → `passage-hybrid`（整棵作废，不修补） | `tocUnavailable:'invalid-outline'` |
| 页码部分解析失败 | 部分条目 dest 解析不出 | 该条目标记不可用但**保留树**；顶层全失败则等同「无 outline」 | `unresolvedEntries:n` |
| 侧车不可用 | 启动失败 / 崩溃 / 超时 | 该篇 → `passage-hybrid` | `judgeUnavailable:true` |
| Jev 返回异常 | NaN / 越界 / 批量长度不匹配 | 该篇 → `passage-hybrid`（不拿垃圾概率继续跑） | `judgeDegraded:'invalid-output'` |
| 阈值滤光 | 所有节点被阈值滤掉 | 取 top-1 兜底（对齐 `scoreAndSelect` 解析失败取首节点的既有行为） | `emptySelectionFallback:true` |
| 预算截断 | 选中节点超预算 | 保留能进入的部分，`truncated` 如实置位（沿用 `materializeContext`） | 既有字段 |

三条纪律：**绝不静默**（每次回落写结构化诊断，bench 统计回落率作为一类结果）、**不修补**、**侧车崩溃按篇隔离**（一次崩溃不得拖垮整轮实验；判定无副作用，重启后可重试）。

## §5 测试策略

| 文件 | 覆盖 | 关键点 |
|---|---|---|
| `src/tests/tocTree.test.ts` | 建树 + 遍历纯函数 | 同页兄弟绝不产出负区间；父节点区间含引导正文；末节点延伸到文末；成环 / 空标题 / 深度超限；无 outline 返回空树而非抛错；相对阈值两个退化端点（`α=0` / `α=1`）；top-N 截断；**父节点下探时不作为证据**；**子节点全被滤光时父节点兜底**；空选择兜底 |
| `src/tests/evidenceJudge.test.ts` | 接口契约（注入假实现） | 批量语义、返回长度校验、NaN 拒绝 |
| `bench/src/tests/jevSidecar.test.ts` | 侧车协议 | JSON-lines 往返、崩溃重启、超时——**全部用假侧车** |

**硬纪律：遍历与建树的测试绝不依赖 Python 或 MLX 权重。** 这是 §1 解耦设计的直接回报——CI 与其他机器上均可运行。真实推理只由探针与实验负责，沿用现有 `transformersEmbedder` 的做法（单测中 mock 掉外部依赖）。

交付前 `npm test` 与 `npm run typecheck` 必须全绿。

## 风险与未决

| 风险 | 状态 |
|---|---|
| base checkpoint 零样本在该任务上可能整体偏弱 | 已知，这正是实验要回答的；若偏弱则结论为「需微调后才谈得上价值」 |
| 概率未校准，相对阈值可能仍不稳定 | 已用层内相对阈值规避绝对基准问题；残余风险由 α/N 网格扫描暴露 |
| QASPER 目录覆盖率未知 | 实现前须先实测；若显著低于 2/3，实验结论的可推广性相应收窄 |
| 侧车进程管理（僵尸、超时、并发） | 设计已按篇隔离；具体实现细节留待实施计划 |
| 双栏论文的 outline 页码是否精确 | 实测 attention（单栏）与 llm-survey（双栏）均 100% 解析出页码；未在全部 QASPER 上验证 |

## 交付物

1. `src/utils/tocTree.ts`、`src/utils/evidenceJudge.ts` 及各自单测
2. `bench/src/jev/`（MLX 实现 + Python 侧车）及协议测试
3. bench 配置：`toc-bm25` / `toc-jev`（必要时含 `toc-jev-flat`）
4. 带覆盖率、四指标、成本与时延的对照报告；回落率与诊断分布
5. 无论正向或负向，如实记录的结论
