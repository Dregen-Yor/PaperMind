# PaperMind Benchmark

量化衡量论文问答（RAG）与摘要生成性能，支持配置消融对比。

设计文档：[docs/superpowers/specs/2026-09-02-benchmark-design.md](../docs/superpowers/specs/2026-09-02-benchmark-design.md)

## 准备

### 1. 环境变量

```bash
export BENCH_LLM_PROVIDER=openai        # openai | anthropic | ollama，默认 openai
export BENCH_LLM_MODEL=gpt-4o           # 必填
export BENCH_LLM_API_KEY=sk-...
export BENCH_LLM_BASE_URL=https://api.openai.com/v1
export BENCH_JUDGE_MODEL=gpt-4o         # 仅 --judge 时需要
export HF_TOKEN=hf_...                  # 仅摘要任务需要
export HF_MODEL=Bashaarat1/t5-small-arxiv-summarizer  # 可选，覆盖摘要模型（此为默认值）

# Hugging Face 模型/分词器下载（BGE-M3、交叉编码器重排器）走镜像站：
export HF_ENDPOINT=https://hf-mirror.com
# GitHub 克隆等依赖下载走本地代理（只放执行环境，绝不写进提交的配置或源码）：
export HTTP_PROXY=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897
```

评测固定 `temperature=0`，与生产 profile 的 0.7 不同 —— 分数必须可复现。

> **`BENCH_LLM_PROVIDER=anthropic` 注意**：端点形状与生产一致（`POST {baseUrl}/chat/completions` + `x-api-key` 头），仅支持 OpenAI 兼容代理；直接指向 `https://api.anthropic.com` 会 404。原生 Anthropic API 的路径是 `/v1/messages`，与该形状不匹配。

### 2. 数据集

```bash
# QASPER（默认 60 篇，可用 QASPER_LIMIT 调整）
npx tsx bench/datasets/qasper/fetch.ts

# 冒烟集：见 datasets/smoke/README.md 自行准备 PDF 与标注
```

> 端到端评测尚未真实运行过（需要真实凭据）；`bench/datasets/smoke/` 的 PDF（放入 `papers/`，已 git-ignore）与标注需按指南自行准备。

## 运行

```bash
npm run bench -- --task qa      --dataset qasper --config default
npm run bench -- --task summary --dataset smoke  --config default
npm run bench -- --task qa --config ablation-topk         # 跑 topK 消融矩阵
npm run bench -- --task qa --dataset smoke --limit 5      # 快速迭代
npm run bench -- --task qa --judge                        # 加 LLM-as-judge
npm run bench -- --task qa --mode full-context             # 无检索全文直投基线
npm run bench -- --task qa --config rag-bm25               # 传统 BM25 基线
npm run bench -- --task qa --config hybrid-rerank          # 强基线：BM25+BGE-M3 → RRF → 交叉编码器重排
npm run bench -- --task qa --config long-section-rag       # 强基线：BM25 锚点 + 章节内连续阅读
npm run bench -- --task qa --config semantic-tree          # 语义树索引（同一条平面管线，仅多一棵树）
npm run bench:trees -- --config semantic-tree --dataset qasper --limit 5 --out bench/results/trees.md
                                                           # 只建树不答题：把树逐层打印供人工核对
npm run bench -- --compare results/a.json results/b.json  # 对比两次结果
```

结果 JSON 落 `results/`，Markdown 报表打到 stdout。

**QASPER 英文作答**：CLI 按 source 分组跑 QA，qasper 组会在 systemPrompt 后追加英文作答指令——参考答案是英文，模型若用中文作答，中英 token 完全不相交，answerF1 恒≈0。

**`--limit` 语义**：在 `--dataset all` 下为**每组（每个 source）各取 N 条**，不是全局 N 条。

**结果文件命名**：默认 `results/<task>-<config>-<时间戳>.json`；`--dataset all` 时按 source 各写一份（`-qasper` / `-smoke` 后缀）。多配置矩阵 + `--out` 时每个配置追加后缀，形如 `<out>-<config>-<source>.json`（如 `r-topK.1-qasper.json`），防止同名互相覆盖；`--dataset all` 单配置时 QA 报表有两行同名配置，来源靠文件名后缀区分。

**退出码**：单样本失败是正常数据点（记入 `errors[]` 继续，exit 0）；整轮零完成（典型为 API key 配错）报表照常输出后 exit 1。

## 指标速查

**检索** —— `contextPageMrr`、`evidenceRecall`、`evidenceHitRate`、`contextPrecision`、`contextTokens`，以及分母计数 `contextPageMrrSampleCount` / `contextPageMrrEligibleCount`

**MRR (context-page-v1)**：对所有 evidence 映射明确的可回答题，按最终 4096-token
生成上下文中的去重页序查找首个 gold evidence 页；位于第 r 页单元时记 1/r，未命中、
索引失败或检索失败记 0。生成失败不删除已完成的检索观测。只有数据集指纹、有效题集合、
指标版本、BGE-M3 tokenizer **模型与 revision**、evidence 映射版本、上下文预算一致，
且两侧都声明具备检索比较资格（`comparisonEligible`）、固定分母
（`contextPageMrrSampleCount === contextPageMrrEligibleCount`）完整时才能计算横向差值。
此处只是必要条件的大意，完整坐标与判定见下文「口径自证」与 `retrievalComparisonIssues`。

> 主指标别混口径：`PRIMARY_METRIC.qa` 仍是 `evidenceRecall`，那是 **legacy 历史结果表**的加粗口径；新的**检索主表按 `contextPageMrr` 排名并加粗**（`report.ts` 的 `renderRetrievalTable`）。

`evidenceRecall` 与 `contextPrecision` 必须一起看：调大 `topK` 会让前者升、后者降。

> 注意天花板：evidence 反查成功率约 92%——图注类 evidence 存于 QASPER 独立字段，不在正文段落中，检索指标读数接近 92% 不代表检索已完美。

**答案** —— `answerF1`（QASPER token 级 F1）、`unanswerableAccuracy`（该拒答时是否拒答）、`judge*`（三维 1-5 分，仅 `--judge`）

**摘要** —— `rouge1` / `rouge2` / `rougeL`、`compressionRatio`、`emptyRate`

`emptyRate` 高意味着 HF 端点在返回空串，而非模型质量差 —— 这两种情况必须分开看。注意：生产 `callAbstractModel` 对空返回会抛错，真实跑分时空串多落在 errors[] 而非 emptyRate；emptyRate 主要捕捉「返回了空白串」的场景。

**语义树** —— `treeUsedRate`、`treeDegradationRate`、`selectedNodeCount`、`avgTreeNodeCount`、`avgTreeDepth`、`treeEvidenceCoverage`、`treeSharedBlockRate`、`treeCrossSectionNodeRate`、`treeBuildFailureRate`、`treeBuildLatencyP50/P95`、`avgTreeBuildInputTokens` / `avgTreeBuildOutputTokens`

`treeUsedRate` 是「真的走了树路由」的样本占比，`treeDegradationRate` 是「没用上树**或**降级」的占比，两者互补但不严格相加（未建树的论文同时计入后者的分子与分母）。降级要把**两种来源都算上**：树取证不足（已在同一次打分调用里就地回落平面）与打分本身失败（`degraded`：JSON 非法 / 覆盖不全 / 请求异常）——只统计前者会把「路由失败但根节点碰巧有证据」记成成功。建树失败率的分母是**所有尝试过的论文**，而结构/成本的均值只在**建树成功**的论文上算——两种口径混在一个分母里会互相稀释，报表里因此分列；建树失败也会照记那次已发生的调用与 token（模型返回了、只是输出不可用），只有调用前就被拒才是零成本。`selectedNodeCount` 只在走了树路由的样本上有值，与平面路径的 `leafCount` **不同分母**，不可直接相减。

**MRR 的固定分母与有效题契约**：分母不再随「是否存在候选排序」浮动，而是**恒等于有效题数**——有效题定义为 `!unanswerable && evidencePages.length > 0 && evidenceMapping !== 'ambiguous' && evidenceMapping !== 'unmapped'`（`isRetrievalEligible`）。每道有效题无论命中与否都必须产出一条 `contextPageMrr` 观测（未命中、索引失败、检索失败一律记 0）。`assertContextPageDenominator` 强制 `contextPageMrrSampleCount === eligibleRetrievalQuestionCount`，不相等直接抛错让整轮失效；因此不存在「某样本自动从分母缺席」这回事，跨方法比较的前提是这份有效题集合与数据集指纹都一致。

> 自动指标能回答「树有多大」，回答不了「树是不是把目录换了个说法」。后者只能人工看：跑 `npm run bench:trees`，把生成的 Markdown 大纲逐层读一遍（阶段 E 第 4 步）。

**管线诊断** —— `degradedRate`、`rewriteRate`、`llmCallsPerQuery`、`leafCount`、`latencyP50` / `latencyP95`。`leafCount` 为均值（分布可由结果 JSON 的 perSample 导出 p50/p95）；`semanticChunkRate` 未实现（可由 perSample 的分块信息后续补充）。

`latencyP50` / `latencyP95` 是**已废弃**的旧字段（下一发布周期删除）：无请求完成时仍按历史契约写 `0` 而非缺字段，所以「耗时与缓存」区块显示 `—` 的同时，某张表可能显示 `0.000`——不能把这个 `0` 读成瞬时完成。新口径认 `*LatencyP50Ms` / `*P95Ms`（无真实请求则不产生字段，报表渲染 `—`）。

## 基线分组（2026-09-08 强基线矩阵）

| 组 | 行 | 说明 |
|---|---|---|
| Classic | jaccard / bm25 / cosine | 既有检索对照组，口径见上文 |
| Ceiling | `--mode full-context` | **生成上限**，不是检索选手：无检索、全文直投，预算不受 4096 约束，故 `comparisonEligible: false`，只进「生成上限」表、不进检索排名。注意它是 `--mode` 取值而**不是**配置名——没有 `configs/full-context.json`，结果文件里的 `config.name` 仍是 `default`，不要去找一个不存在的配置 |
| Strong | `hybrid-rerank`、`long-section-rag` | 强基线组（计划 §0）：成熟检索栈、结构化阅读 |
| Primary | PaperMind 当前管线 | 被评测的生产方法 |
| Tree | `semantic-tree` | Primary 的变体：同一条分阶段管线（`retrieveRagContext` → `generateRagAnswer`；`runRagPipeline` 仅是向后兼容的组合封装），仅把平面 `scoreAndSelect` 换成单轮树路由——树的收益是唯一变量 |

**强基线共同契约**（计划 `docs/superpowers/plans/2026-09-08-baseline-matrix.md` §1 冻结）：与所有基线同一份数据集/原文/原始问题/最终作答模型/4096 token 上下文预算/指标与错误口径；无查询改写。最终预算由**共用物化器**施加——它把候选逐段填入 4096 token 上限，允许在预算边界**截断最后一段**（部分进入的页仍计入页序）并以 `truncated` 标记；多段之间用 `\n\n---\n\n` 分组分隔符连接，且「分隔符 + 至少一个内容 token」都放不下时整组不进入，避免留下吃掉剩余预算的尾部分隔符。因此不存在「单个候选不截断、预算不足整段停止」的旧行为。

**hybrid-rerank**：512/128 分块 → BM25(top20) 与 BGE-M3(top20) 独立召回 → RRF(k=60) 融合 top40 → 交叉编码器重排 → 预算内选 ≤5 段。MRR 不再按「重排前缀 + 融合尾部」的候选次序计算，而是取**最终物化上下文页序中首个落在 gold evidence 上的页**（见上文 context-page-v1）。重排器权重为 `BAAI/bge-reranker-v2-m3`；官方仓库无 ONNX 权重，配置 pin 的是其 ONNX 转换 `rozgo/bge-reranker-v2-m3`（revision `fbd57b17`，单 logit 输出与原模型一致；权重在仓库根目录、>2GB 外部数据文件，provider 已按此加载）——这是**打包来源差异**，不是换模型，报表与结果 JSON 如实记录。**已验证**（2026-09-08，`bench/scripts/verifyReranker.ts`）：模型加载、句对编码、相关对得分 +5.54 > 无关对 −10.98。

**long-section-rag**：确定性章节边界（标题正则，无 LLM，保留页号映射）→ BM25 锚点段(top10) → 最高排名锚点在所属章节内以锚点为中心连续扩展至 4096 token，绝不跨章节；最佳锚点不可用时按名次取下一个（确定性 fallback）。连续区域是单一上下文单元。

**模型下载**：所有 Hugging Face 下载必须 `HF_ENDPOINT=https://hf-mirror.com`（见「准备」；transformers.js 不读该环境变量，bench 在加载点显式设置 `env.remoteHost`，见 `bench/src/hub.ts`）。镜像失败时不得静默换模型/revision。模型缓存于 `bench/cache/models/`（BGE-M3 与重排器的 2.3GB 外部数据权重已下载并经 SHA-256 对齐 LFS OID 验证；`verifyTokenizer.ts` / `verifyEmbedding.ts` / `verifyReranker.ts` 可复验）。

## 已知局限

- **QASPER 用伪页**：段落按约 3000 字符聚成伪页，与真实排版不同。因此语义分块（`detectSectionBoundaries`）的效果只在冒烟集上可信
- **`normalizeAnswer` 对中文不分词**：整句按 1 个 token 处理，中文答案的 F1 退化为完全匹配——这是 QASPER 官方口径的固有特性。冒烟集标注指南已要求答案为词或短语；若见中文样本 F1 普遍偏低，是分词口径而非模型质量
- **ROUGE 分词复用 `normalizeAnswer`**（去冠词、无词干化），与官方 ROUGE-1.5.5 不一致，**不宜与论文发表的 ROUGE 分数直接对比**
- **`rewriteRate` 恒为 0**：两个数据集都是单轮问答，无对话历史，`rewriteQuery` 不会触发。评测查询改写需要多轮数据集
- **evidence 反查天花板约 92%**：图注类 evidence 存于 QASPER 独立字段，不在正文段落中——检索指标读数接近 92% 不代表检索已完美
- **语义树结构在本数据集上只能部分可信**：QASPER 的伪页是按字符数切的，`detectSectionBoundaries` 的章节边界因此不准，证据块的边界与树的一/二级模块划分都受此影响；树的**规模与成本**指标（节点数、token、时延、失败率）可信，**结构语义**的可读性主要在冒烟集（真实 PDF）上评估。此外 `maxInputChars` 默认 12 万字符，超出即整篇 `input-too-large` 放弃建树（计入失败率），长论文上会看到失败的集中
- **`unanswerableAccuracy` 有两种口径**：默认正则模式匹配（`REFUSAL_PATTERN_VERSION`），`--judge` 时用 judge 判定；judge 不可用时会回落到正则并如实记为 `pattern`。结果 JSON 的 `meta.unanswerableMethod` 标注了实际口径，跨口径的数字不可直接对比
- **`llmEndpointIdentity` 只在断点签名里，不在 `BenchResult.meta` 里**：它参与「是否复用旧断点」的判定，却**不参与横向比较门禁**。两次跑在不同端点、但共享同一 `model` 名的运行，仍能通过 `retrievalComparisonIssues` 的比较门——门禁覆盖不到端点差异，读数前须自行确认端点一致
- **`sliceText` 与 `tokenRangeToPieces` 的空白分歧**：两者对「仅含空白的页边界」处理不同——`pieces` 可能为空、`pieces[0].page` 可能大于区间起始页号、`join(pieces)` 可能带一个 `sliceText` 整段 `trim()` 已吃掉的**前导 `\n`**（`bench/src/tests/strongBaselines.test.ts:62` 已钉住）。页序与指标一律以 `pieces` / 物化页序为准，勿用 `sliceText` 反推
- **`meta.completed` 只数走完**生成**阶段的样本**，而 `meta.total` 是**本轮尝试执行的全部样本**（含生成前失败的题）；两者差额是**索引失败 + 检索失败 + 生成失败**三者之和，而非「生成失败数」，更不是「没这题」——`total` 在检索阶段之前就已自增，索引/检索阶段失败的题同样进了 `total` 却到不了 `completed`。检索已完成的观测在生成失败时照常留在指标分母里
- **4096-token 预算是 bench 专属**：只有 bench 注入 `materialize` 时才切到 4096-token 路径，产品侧不注入、走字符预算路径——被测的产品行为与评测口径就此分开，bench 的改动不回灌产品。注意产品并非「默认按 24000 字符截断」：`ragPipeline` 的 `maxContextChars` 是**可选且无默认值**，产品调用方（`chat.ts`）只传 `externalContext`、根本不传它，故平面路径实际上**不设上限**。24000 只作为 `DEFAULT_SEMANTIC_CONTEXT_CHARS` 存在于 `semanticRoute.ts`，且只封顶**树路由**路径的逐篇块预算，与平面路径无关。两处口径不同，勿混用

## 缓存

LLM 响应按 `sha256(provider + baseUrl + model + messages + maxTokens)` 缓存到 `bench/cache/`（字段以 `\0` 分隔）。key 含 provider、baseUrl 与生成上限——同名模型在不同端点或不同截断口径下不会串用缓存。这让配置矩阵可行：不同 `topK` 共享同一份索引构建结果，只有评分调用需要重发。失败请求也计入 misses，故 `hits/(hits+misses)` 在有错误时会偏低；runner 为纯串行，无并发去重需求——若未来并行跑样本需加 in-flight 去重，否则命中率会塌。

`--no-cache` 当前只跳过**读**缓存、不覆写已有缓存文件（与 spec §8 的「强制重跑并覆写」有差距），`meta.cacheMode` 如实记录实际口径（`normal` / `bypass`）。summary 任务走 HuggingFace 摘要模型、不经过 LLM 缓存，`cacheMode` 仅做口径统一，`--no-cache` 对它无实际作用。

改动 judge rubric 需 bump `RUBRIC_VERSION`（版本号嵌在 prompt 里，而缓存 key 按 prompt 哈希，所以会自动使缓存失效）。

## 口径自证

结果 JSON 的 `meta` 记录了 `model` / `judgeModel` / `gitSha` / `timestamp` / `unanswerableMethod` / `cacheMode`，指标侧有 `REFUSAL_PATTERN_VERSION`（报表打印拒答模式表版本）与 `RUBRIC_VERSION`——任何一个数字都能追溯到产生它的口径与代码版本。

schema-v2 结果另将版本化评测契约的全部坐标随 `meta` 落盘：`metricSchemaVersion`（2）、`mrrDefinition`（`context-page-v1`）、`contextBudgetTokens`（4096）、`contextTokenizer` + `contextTokenizerRevision`（`BAAI/bge-m3`@`main`）、`evidenceMappingVersion`、`datasetFingerprint`、`eligibleRetrievalQuestionIdsHash` 与 `eligibleRetrievalQuestionCount`；`comparisonEligible` 标记该结果是否进入检索排名（`full-context` 为 `false`）。横向差值只有在这些坐标全部一致时才计算（`retrievalComparisonIssues`），任一不一致即拒绝输出差值。
