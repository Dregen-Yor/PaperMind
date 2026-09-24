[根目录](../CLAUDE.md) > **bench/**

# bench/ — 评测 Benchmark

**变更记录**
- 2026-09-23: QASPER 全题质量与速度合成 Q——新增 `answerF1AllQuestions` 固定分母、schema 2 / `query-timeline-v2`、可配置权重的离线 Q 对比及原始输入保留；旧 v1 结果不参与 Q
- 2026-09-15: 语义树评测——新增 `semantic-tree` 配置（`kind: 'semantic-tree'`）与 `runner/semanticTreeQa.ts`（复用 `runQaTask` + 建树 hook，切片与对照组完全一致）；`metrics/treeDiagnostics.ts` 产出建树结构/成本/失败率与 `treeUsedRate` / `treeDegradationRate`；`treeInspect.ts` + `npm run bench:trees` 只建树不答题，输出 Markdown 树结构供人工核对（阶段 E 第 4 步）
- 2026-09-14: 冻结 QA 横向基线切片——主结果表中的所有方法（含后续强基线）必须使用同一 QASPER 60 篇论文 / 179 道题切片；179 篇 / 632 题及其他扩容切片只能作为独立的规模泛化实验，禁止与主表混排或据此跨方法排名
- 2026-09-09: 移除 `pageindex-adapted` 基线——上游 VectifyAI/PageIndex 适配（Python 桥 + 树索引 agentic 检索）端到端实测吞吐过低（推理模型逐题 agentic 检索，179 篇全量预计 >24h），决策放弃该基线：删 `adapters/pageindex/`、`runner/pageindexQa.ts`、配置与校验、`upstreamCommit` meta 透传，强基线组保留 `hybrid-rerank` / `long-section-rag`
- 2026-09-08: 强基线矩阵——`hybrid-rerank`（BM25+BGE-M3→RRF→交叉编码器重排）与 `long-section-rag`（BM25 锚点+章节内连续阅读）runner/原语/配置；`baselines/` 新增 RRF、token 流、章节边界、连续扩展、重排器原语；共享引擎 `runner/strongBaselineQa.ts`；report 增加基线家族/粒度列
- 2026-09-04: 补充使用文档（`README.md`）——CLI 契约、指标速查、缓存口径与已知局限
- 2026-09-02: 初始化——QA（检索 + 答案）与摘要评测，支持配置矩阵消融

---

## 模块职责

Node CLI 评测套件。以 ESM 运行（`bench/package.json` 声明 `type: module`），通过 `tsx` 直接执行 TypeScript，import `src/utils/*` 复用生产管线，**不引入 Electron 与 better-sqlite3**。

使用方式见 [README.md](./README.md)，设计依据见 [设计文档](../docs/superpowers/specs/2026-09-02-benchmark-design.md)。

## 结构

| 路径 | 职责 |
|------|------|
| `src/types.ts` | 全部共享类型：`EvalSample` / `BenchConfig` / `BenchResult` 等 |
| `src/llmClient.ts` | 带磁盘缓存的 LLM 客户端，凭据读 `BENCH_*` 环境变量；cache key 包含生成参数；QA 请求由 `speed/qaOptions.ts` 统一给出 `temperature=0` 等设置 |
| `src/config.ts` | 配置加载 + 矩阵笛卡尔积展开 |
| `src/args.ts` | CLI 参数解析（纯函数，单独测试） |
| `src/paths.ts` | 从 `import.meta.url` 解析 bench 内相对路径（规避 `.pathname` 的百分号转义坑） |
| `src/cli.ts` | 入口，薄编排层 |
| `src/metrics/retrieval.ts` | `contextPageMrr` / `evidenceRecall` / `evidenceHit` / `contextPrecision` / `contextTokens`（四个检索口径只能有一处定义）。两个分母计数**不在本文件**：`contextPageMrrSampleCount` 由 `metrics/aggregate.ts` 的 `emitMetricSampleCounts` 产出，`contextPageMrrEligibleCount` 由 `runner/support.ts` 的 `finalizeQaResult` 写入 |
| `src/metrics/answerF1.ts` | QASPER token 级 F1 + 拒答模式表（`REFUSAL_PATTERN_VERSION`） |
| `src/metrics/qasperQuality.ts`、`src/metrics/qaQuality.ts` | QASPER 官方归一化参考的逐题最佳标注者 F1；`answerF1AllQuestions` 对全部已尝试题固定分母，失败/跳过记 0，与可缺席的 legacy `answerF1` 并存 |
| `src/metrics/rouge.ts` | ROUGE-1/2/L F-measure + 摘要指标 |
| `src/metrics/judge.ts` | LLM-as-judge，rubric 版本化（`RUBRIC_VERSION`） |
| `src/metrics/aggregate.ts` | 逐样本 → 聚合均值、分位数；`emitMetricSampleCounts` 产出四个受控检索指标的分母计数。**缺指标的样本只对「可缺席」指标从分母剔除**（`answerF1`、judge 等可选指标失败即无观测）；四个受控检索指标相反——有效题失败由 `skipSampleRecord` 补 0 观测，必须留在固定分母里，缺席才是违约。`treeUsedRate` / `treeDegradationRate` 由 `treeUsed` / `treeDegraded` 改名而来 |
| `src/metrics/treeDiagnostics.ts` | 语义树 hook 结果 → `PaperTimingRecord` 字段；建树失败率与结构/成本均值（见下方「语义树指标口径」） |
| `src/datasets/qasper.ts` | QASPER 归一化（段落 → 约 3000 字符伪页）与加载；Q 参考答案 `qualityAnswers` / `qualityDefinition` 必须完整，旧数据集需重新生成 |
| `src/datasets/smoke.ts` | 真实 PDF 冒烟集加载（1-based 标注 → 0-based） |
| `src/runner/qa.ts` | QA 编排：建索引 → `retrieveRagContext` → `generateRagAnswer` → 打分（分阶段 API；`runRagPipeline` 仅是二者的向后兼容组合封装） |
| `src/runner/traditionalRagQa.ts` | 传统 RAG QA：固定分块 → 词法/向量检索 → 生成与打分 |
| `src/runner/strongBaselineQa.ts` | 强基线共享 QA 引擎：索引→逐问检索→生成→打分→聚合（hybrid/long-section 复用） |
| `src/runner/hybridRerankQa.ts` | 强基线：BM25+BGE-M3 双路召回 → RRF 融合 → 交叉编码器重排 |
| `src/runner/longSectionQa.ts` | 强基线：确定性章节边界 + BM25 锚点 + 章节内连续扩展阅读 |
| `src/baselines/` | 强基线原语：RRF 融合、带页号 token 流、确定性章节边界、连续区域扩展、交叉编码器 provider |
| `src/runner/semanticTreeQa.ts` | 语义树 QA：`createSemanticTreeHook` 建树并在平面索引上挂 `semantic`，再交给 `runQaTask` |
| `src/runner/fullContextQa.ts` | 无检索全文直投 QA 基线 |
| `src/speed/qaOptions.ts`、`src/speed/contract.ts`、`src/speed/generate.ts` | QA 请求参数、schema 2 / `query-timeline-v2` 比较身份、逐题流式回答时间线；t0 在每题消息组装之前 |
| `src/scoring/qScore.ts`、`src/scoring/qComparison.ts` | 配置校验与相对加权几何分数；严格核对两侧原始题目、参考、质量与速度聚合及协议身份 |
| `src/scoring/qArtifacts.ts`、`src/scoring/qReport.ts` | 离线输出原始输入+字节 SHA-256 的派生 JSON，以及中文 Q 报表 |
| `src/traditionalRag/` | BGE-M3 分块、embedding、cosine/BM25/Jaccard 与上下文选择 |
| `src/runner/summary.ts` | 摘要编排：全文 → `summarizeAcademicText` → ROUGE |
| `src/report.ts` | 结果 → Markdown 表格 / 差异表；含「语义树诊断」小节 |
| `src/treeInspect.ts` | 树结构 → Markdown 大纲 / 人工检查报告（纯函数） |
| `src/treeInspectCli.ts` | `npm run bench:trees` 入口：只建树、不答题，写 `results/trees.md` |
| `configs/*.json` | PaperMind 矩阵与 `rag-cosine` / `rag-bm25` / `rag-jaccard` 传统基线；`semantic-tree.json` 为语义树配置（`kind` + `semanticTree` 参数块） |
| `configs/scoring/q-score.json` | Q schema 1 配置：全文参考、`weighted-geometric-relative-v1` 与可修改的 0.6 / 0.2 / 0.2 权重 |
| `datasets/qasper/fetch.ts` | 一次性拉取脚本（HF datasets-server） |
| `datasets/smoke/` | 冒烟集 manifest / 标注 / 准备指南（PDF 放 `papers/`，git-ignored） |
| `src/tests/*.test.ts` | benchmark 单测，随 `npm test` 一并收集 |
| `results/`、`cache/` | 运行时产物：结果 JSON / LLM 响应缓存（首次运行生成） |

## 语义树评测（`kind: 'semantic-tree'`）

配置 `configs/semantic-tree.json` 的矩阵与 `default.json` 逐项相同，额外挂一个 `semanticTree` 参数块（证据块分块 `targetChars/maxChars/minChars` + `maxInputChars`）。跑法与普通配置一样，`cli.ts` 按 `kind` 分派：

```bash
npm run bench -- --task qa --config semantic-tree --dataset qasper --limit 5

# 只建树、不答题：把树逐层打印出来人工核对（阶段 E 第 4 步）
npm run bench:trees -- --config semantic-tree --dataset qasper --limit 5 --out bench/results/trees.md
```

**为什么复用 `runQaTask` 而不是 `strongBaselineQa`**：方案 §11.2 要比较的是「同一平面上有没有树索引」，所以平面 `scoreAndSelect` 与树路由必须跑在同一条管线上——树索引成为唯一变量。强基线引擎（`strongBaselineQa`）自带冻结的 4096 上下文预算与不同的检索原语，用它会让变量不唯一。

**语义树指标口径**（`metrics/treeDiagnostics.ts`）：

- 建树失败率的分母是**所有尝试过的论文**（失败即该篇回落平面检索，是结果的一部分）；结构/成本均值（节点数、树深、覆盖率、token、时延）只在**建树成功**的论文上平均——把失败样本算进去会稀释结构形态
- `treeUsedRate` = 检索时真的走了树路由的样本占比；`treeDegradationRate` = 未用树 **或** 降级的样本占比。降级有**两个来源，漏记任何一个都会把失败路由统计成成功**：树取证不足（`insufficientEvidence`，已在同一次调用里就地回落平面），以及打分本身失败（`retrieval.degraded`：JSON 非法 / 覆盖不全 / 请求异常）
- **建树失败也要记成本**：模型已返回、只是输出不可用（非法 JSON、结构校验不过）时，那次调用与 token 是真实成本，照记 `treeBuild*`；只有调用前就被拒（无证据块、`input-too-large`）才是零成本
- bench 的建树 hook 与产品内建树走同一份 `buildEvidenceBlocks` / `buildSemanticTree`，但**不写 SQLite**：评测进程不引入 better-sqlite3，因此评测侧不涉及产品的建树缓存键
- **不新增串行调用**：树路由与平面 `scoreAndSelect` 的查询阶段调用次数相同（都是 1 次）——树节点与平面叶节点在**同一次**打分判断里一并评分，树给不出证据时就地改用平面候选（§9 的回落要求因此不花额外调用）；建树的那一次调用发生在索引阶段，计入 `treeBuild*` 列而非回答时延
- **MRR 的固定分母与页序来源**：`contextPageMrr` 的分母恒等于有效题数（`contextPageMrrSampleCount === eligibleRetrievalQuestionCount`，由 `assertContextPageDenominator` 抛错强制），有效题集合见 `isRetrievalEligible`；未命中、索引失败或检索失败一律记 0 观测而**不从分母缺席**。四个检索指标消费的 `pageOrder` 与上下文文本由物化器在**同一次计算**里产出，**绝不**从 `selected` / `sources` / `scores` 反推——旧的 `computeMrr` 与「样本自动从分母缺席」的行为随该口径一并删除

## 报表分区（§9）

`report.ts` 把结果切成三个互斥分区（`partitionResults`）：

- **检索排名**：schema-v2 且 `comparisonEligible !== false` 的结果，按 `contextPageMrr` 排名并加粗最优行；
- **生成上限**：`comparisonEligible === false` 的结果（`full-context` 全文直投），不受 4096 预算约束，不参与检索排名；
- **历史结果**：缺 `mrrDefinition: 'context-page-v1'` 的旧结果。

资格判定必须先于 schema 判定，否则 `full-context`（不带 `mrrDefinition`）会被误归 legacy；单个 if/else if/else 保证每个结果恰好落一个分区。

- **计数行的 `—`**：对比表（`renderComparison`）里的 `contextPageMrrSampleCount` / `contextPageMrrEligibleCount` 是分母计数行，差值**恒渲染 `—`**（`shouldSuppressDelta`）——样本数差异不是质量信号，读成改进就错了；两个数值分别列在 A / B 列，读者自行看。注意**检索主表（`renderRetrievalTable`）根本没有差值列**，它的「有效题数」只渲染数值（缺失时才显示 `—`），计数抑制规则只作用于对比表
- **`mrr` 改名**：legacy 结果的 `mrr` 列在历史表里标为 `Legacy candidate MRR`，与检索主表的 `MRR (context-page-v1)` 明确区分，不会被混读
- **单一归属策略的边界**：「一个指标只由一张表渲染、另一张表排除」只对**检索主表与生成上限表**成立。**历史结果表是刻意的全量倾倒**：legacy 行只要携带耗时/语义树列就照常重复渲染，不再去重——它是旧结果的完整存档，而非当期口径的排名表

## 设计约束

- **必须复用生产代码**：PaperMind 与摘要评测调 `retrieveRagContext` / `generateRagAnswer` / `buildPageIndex` / `summarizeAcademicText`（`runRagPipeline` 仅是前两者的向后兼容组合，供产品调用方使用）。传统 RAG 与强基线是明确的 bench 专用对照组，可在 `src/traditionalRag/`、`src/baselines/` 独立实现，但不得替换产品管线
- **强基线冻结契约**（2026-09-08 计划 §1）：强基线与既有基线共用数据集/原文/原始问题/最终作答模型/指标口径；`generationContext.maxTokens` 恒为 4096（校验器强制）。最终预算由共用物化器施加——允许在预算边界**截断最后一段**（部分进入的页仍计入页序）并以 `truncated` 标记；多段之间用 `\n\n---\n\n` 分隔，「分隔符 + 至少一个内容 token」都放不下时整组不进入。配置 pin 的模型/revision 不得静默更换；Hugging Face 下载走 `HF_ENDPOINT=https://hf-mirror.com`
- **QA 横向比较切片强制冻结**（2026-09-14）：主结果表的唯一 QASPER 切片为**前 60 篇论文、179 道题**。新增或重跑的任何 baseline（包括 `hybrid-rerank`、`long-section-rag`）必须先用该切片运行，且与对照组统一原文归一化/evidence 映射、生成模型与端点、temperature、生成上限、上下文预算和缓存口径。结果 JSON 必须记录数据集文件 SHA-256、论文数、题数及 question-id 集合哈希；缺任一项的结果不得进入横向主表
- **扩容实验不得冒充横向基线**：179 篇 / 632 题或其他 `QASPER_LIMIT` 扩容结果只能在单独的“规模泛化”表中与**同一扩容切片、同一端点、同一代码版本**下的其他方法比较；不得与 60 篇 / 179 题主表混排、加粗跨组最优值或宣称全局排名。若要复用已有大切片结果，必须先按 question id 回切到主表 179 题并重算指标
- **Q 的新固定分母例外**：`answerF1AllQuestions` 使用已尝试的全部 QASPER 题，失败/跳过为 0，缺记录或参考使结果无效；它不继承下文 `answerF1` / judge 可缺席的旧规则。Q 的质量项是词法 F1，不代表语义正确或证据可信。
- **Q 的离线比较契约**：第一份结果必须为 `full-context`，且两侧均为 schema 2 / `query-timeline-v2`、同一数据集及已执行顺序、已完成速度 cohort、模型/端点/prompt framing/生成参数/retry/环境/缓存协议；逐题参考、F1 与聚合指标须能重算一致。不得以成功题交集、旧 `answerF1` 或补 0 填充旧 v1 结果。全文参考仍不参与检索排名及检索 delta，但允许作为 Q 参考。权重来自 `configs/scoring/q-score.json`，改权重须保留新配置与独立输出。
- **MRR 的固定分母不变量**：`contextPageMrr` 的分母恒等于有效题数——`assertContextPageDenominator` 强制 `contextPageMrrSampleCount === eligibleRetrievalQuestionCount`，不相等直接抛错让整轮失效。横向比较额外要求数据集指纹、指标版本、MRR 定义、上下文预算、tokenizer 模型+revision、evidence 映射版本全部一致（`retrievalComparisonIssues`），任一不符即拒绝输出差值。旧的「单候选样本自动从分母排除、比较共同分母」规则已被固定分母取代
- **失败不中断**：单样本失败记入 `errors[]`，报表打印 `completed/total`，流程继续。分母口径分两类：四个受控检索指标的**有效题**失败一律补 0 观测、**留在固定分母**（缺席即违约）；`answerF1`、judge 等**可选指标**没有观测就从各自分母缺席，否则超时会被误读为质量下降——这条对受控检索指标不适用，它们宁可记 0 也不缺席
- **口径必须自证**：`unanswerableMethod`、`cacheMode`、`REFUSAL_PATTERN_VERSION`、`RUBRIC_VERSION`、`gitSha` 都写进结果 JSON，让任何一个数字都能追溯到产生它的口径与代码版本
- **不改生产 prompt**：拒答指令等改进属设计文档第 11 节「待验证改进项」，须先有基线数据

## 常见问题

**Q: 为什么 bench 要单独一个 `package.json`？**
根 `package.json` 不能声明 `type: module`（Electron 主进程需要 CJS），但 bench 需要 ESM 才能 import pdfjs 的 `.mjs` 构建并使用顶层 await。

**Q: 为什么 `evidenceRecall` 是主指标而不是 `answerF1`？**
先划清在哪张表：`evidenceRecall` 是 **legacy 历史结果表**的加粗主指标（`PRIMARY_METRIC.qa`）；新的**检索主表**按 `contextPageMrr` 排名并加粗，两张表口径不同，见 [README 的 MRR 说明](./README.md)。就 legacy 表而言，选 `evidenceRecall` 的理由是：漏检直接导致幻觉，是链路上游的根因；`answerF1` 受生成模型能力影响大，对检索策略改动的敏感度低。

**Q: 单测在 `npm test` 里跑吗？**
是。`vite.config.ts` 的 `test.exclude` 未排除 `bench/`，`bench/src/tests/*.test.ts` 会被一并收集。涉及 `pageIndex` 的测试需 `vi.mock('pdfjs-dist/legacy/build/pdf.mjs')`。

**Q: 已知口径局限有哪些？**
见 [README.md 的「已知局限」](./README.md#已知局限)：中文不分词导致 F1 退化为完全匹配、ROUGE 分词与官方实现不一致、`rewriteRate` 单轮数据集下恒为 0、evidence 反查天花板约 92%、`--no-cache` 只跳过读不覆写等——解读数字前先读。

## 相关文件

- `src/utils/ragPipeline.ts` — 被测的 RAG 主流程
- `src/utils/pageIndex.ts` — `buildPageIndex` / `scoreAndSelect`
- `src/utils/abstractSummarizer.ts` — `summarizeAcademicText`
