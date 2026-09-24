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
export BENCH_QA_REQUEST_TIMEOUT_MS=120000  # QA 最终回答请求超时，默认 120000 ms
export BENCH_QA_RETRY_ATTEMPTS=3          # QA 最终回答重试次数，默认 3
# export BENCH_QA_TOP_P=0.8              # 可选，有限数值 [0,1]
# export BENCH_QA_THINKING=disabled      # 可选：enabled | disabled；不设置则用 provider 默认值
export BENCH_JUDGE_MODEL=gpt-4o         # 仅 --judge 时需要
export HF_TOKEN=hf_...                  # 仅摘要任务需要
export HF_MODEL=Bashaarat1/t5-small-arxiv-summarizer  # 可选，覆盖摘要模型（此为默认值）

# Hugging Face 模型/分词器下载（BGE-M3、交叉编码器重排器）走镜像站：
export HF_ENDPOINT=https://hf-mirror.com
# GitHub 克隆等依赖下载走本地代理（只放执行环境，绝不写进提交的配置或源码）：
export HTTP_PROXY=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897
# Node 自带 fetch 默认不读上面两个代理变量；模型首次下载需要走代理时再加：
export NODE_USE_ENV_PROXY=1
```

QA 最终回答统一请求 `maxTokens=4096`、`temperature=0`，并共用上述超时与重试设置；这些请求参数也进入速度协议身份。`temperature=0` 只是请求值，provider 可能忽略参数，不能据此保证确定性。`BENCH_QA_TOP_P` 与 `BENCH_QA_THINKING` 未设置时保持 provider 默认行为，不等同于明确关闭 thinking；正式对照须两侧使用相同的显式选择。`BENCH_QA_THINKING` 的请求对象面向支持它的 OpenAI 兼容端点；`BENCH_LLM_PROVIDER=ollama` 会拒绝任何显式 thinking 值（包括 `disabled`），使用 Ollama 时应留空。客户端支持 `stop`，但目前没有相应的 `BENCH_STOP` CLI 环境变量。

DeepSeek 的受控 profile 可设 `BENCH_LLM_PROVIDER=openai`、`BENCH_LLM_MODEL=deepseek-flash`、`BENCH_LLM_BASE_URL=https://api.deepseek.com`；API key 仅通过本机 `BENCH_LLM_API_KEY` 提供。官方[模型与价格说明](https://api-docs.deepseek.com/quick_start/pricing/)列出 `deepseek-flash` 与 thinking / non-thinking 两种模式；[thinking mode 文档](https://api-docs.deepseek.com/guides/thinking_mode/)使用 `thinking.type: enabled | disabled`。先选定一种模式并在所有正式对照中保持一致；thinking 模式下 provider 对 temperature / top-p 的支持有限，应核对实际请求与响应。这里不替用户选择正式运行模式。

> **`BENCH_LLM_PROVIDER=anthropic` 注意**：端点形状与生产一致（`POST {baseUrl}/chat/completions` + `x-api-key` 头），仅支持 OpenAI 兼容代理；直接指向 `https://api.anthropic.com` 会 404。原生 Anthropic API 的路径是 `/v1/messages`，与该形状不匹配。

### 2. 数据集

```bash
# QASPER 主切片（60 篇、179 题）；旧版归一化文件缺 Q 所需参考答案时也须重新生成
QASPER_LIMIT=60 npx tsx bench/datasets/qasper/fetch.ts

# 冒烟集：见 datasets/smoke/README.md 自行准备 PDF 与标注
```

> 端到端评测尚未真实运行过（需要真实凭据）；`bench/datasets/smoke/` 的 PDF（放入 `papers/`，已 git-ignore）与标注需按指南自行准备。

旧 `bench/datasets/qasper/qasper.jsonl` 若缺 `qualityAnswers` / `qualityDefinition`，加载器会拒绝；上面的命令会覆盖本地归一化数据集，需留存旧文件时先自行备份。正式运行前核对冻结切片确为 60 篇 / 179 题。旧结果无法只补版本标签或参考答案来参与 Q，必须用同一新协议重跑全文参考和候选方法。

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

### 查询时间线速度（`--speed`）

`--speed` 是一个严格的 QA 速度协议，必须**显式**给出 `--task qa`；它不支持 summary 或 `--task all`。常用的检索路径与全文生成上限路径分别是：

```bash
npm run bench -- --task qa --dataset qasper --config default --speed
npm run bench -- --task qa --dataset qasper --mode full-context --speed
```

速度运行采用 schema 2 / `query-timeline-v2`，强制使用真实的流式最终回答、客户端 answer response cache 关闭、单题串行（concurrency 1），且不读取或续跑 query checkpoint。客户端不能控制 provider 侧响应缓存。`--no-cache` 不能改变 answer-cache 强制关闭；若同时使用 `--judge`，judge 在最终回答时间线之后执行，不计入该时间线。失败、部分流或不完整里程碑的题不会被修补进速度样本。

全文参考在每题组装消息**之前**记 t0；整篇论文文本可按论文预备，检索索引也在逐题计时之前建立。逐题检索、上下文与消息组装、排队、网络和重试均计入首次可见回答的 TTFT。reasoning / usage 帧不算首次可见回答文本。

对检索方法，报表的速度主表严格只有七个 headline 值：`Evidence Ready` P50/P95、`TTFT`（首次可见文本）P50/P95、`Full Answer` P50/P95，以及 `Avg Online Tokens`。六个时间百分位数始终从同一个完整题目 cohort 计算；`meta.completedSpeedQuestionIdsHash` 是该 cohort 的有序题目 ID 哈希，`speedSampleCount` 与 `completedSpeedQuestionCount` 必须一致。Token 均值只采用 LLM provider 在流式请求中返回的实际 usage，绝不按字符或 prompt 估算；只要 cohort 中任一完成题的 usage 不完整，`Avg Online Tokens` 整列即显示 `—`。

每份 speed 结果还写入可比较身份：数据集指纹、已执行题目顺序哈希、已完成 cohort 哈希、answer model（provider + model）身份、最终回答固定 framing 哈希、规范化 endpoint 身份、temperature/maxTokens/topP/thinking/stop/timeout 设置哈希、retry 次数、streaming/cache/concurrency 协议和执行环境指纹。framing 哈希覆盖 `buildAnswerMessages` 实际使用的 base system prompt、样本语言指令、数学格式指令和固定 message/context framing，只落盘 SHA-256，不保存 prompt 明文。速度 delta 的门禁要求这些身份**每一项都存在且两侧相等**，还要求 `completedSpeedQuestionIdsHash`、`completedSpeedQuestionCount` 与两侧的 `speedSampleCount` 彼此一致；任一缺失或不一致，七个 delta 都不输出。Token accounting 不完整只抑制 token delta，不抑制仍满足这些门禁的时间 delta。endpoint 身份会剥离凭据；执行环境只哈希 platform、arch、Node 版本和 backend，不写主机名、路径或凭据。对 Ollama（以及其他 localhost/本地端点）必须设置稳定的实际设备/backend 标签，例如 `BENCH_EXECUTION_BACKEND=metal` 或 `BENCH_EXECUTION_BACKEND=cpu`；该标签进入环境身份，因此不同设备/backend 的数字不会被当作同一可比较运行。speed 模式的缓存与结果路径日志只打印仓库相对路径或 `<external>/文件名`，内部文件操作仍使用完整路径。

`--mode full-context --speed` 在旧报表中标为**生成上限**：它不走检索，也不会伪造 `Evidence Ready`，因此在独立的生成上限速度表中该两格为 `—`，并且始终 `comparisonEligible: false`，不进入检索速度排名或 delta；该旧标签仅指全文直投的对照路径，不代表理论质量上限。速度表与「详细耗时与缓存诊断（Legacy timing）」是两套口径：前者才是 query-timeline-v2 的主指标；后者保留 index/retrieval/generation/end-to-end/network 与 wall-clock 的历史诊断，不能拿来替代或混入速度主表和 delta。

**QASPER 英文作答**：CLI 按 source 分组跑 QA，qasper 组会在 systemPrompt 后追加英文作答指令——参考答案是英文，模型若用中文作答，中英 token 完全不相交，answerF1 恒≈0。

### Q：同一论文问答切片的质量与速度

Q 是在两份已经生成的 QASPER `--speed` 结果上离线计算的单一相对分数。先用**同一冻结切片与同一生成协议**分别运行 `--mode full-context --speed` 和候选 RAG `--speed`，再从仓库根目录执行：

```bash
npm run bench -- --compare bench/results/full-context.json bench/results/rag.json --q-config bench/configs/scoring/q-score.json
npm run bench -- --compare bench/results/full-context.json bench/results/rag.json --q-config bench/configs/scoring/q-score.json --out bench/results/q-comparison.json
```

第一份输入必须是全文直投参考，第二份是候选；有无 `--out` 都是离线对比，不调用模型或要求 API key。省略 `--out` 只打印报表；使用时父目录须已存在，目标必须是新路径，已有文件（含符号链接、硬链接）不会被覆盖，也没有强制覆盖选项。

配置 `configs/scoring/q-score.json` 使用 schema 1、`weighted-geometric-relative-v1`，当前默认权重为回答质量 0.6、TTFT P50 0.2、TTFT P95 0.2。设 `F=answerF1AllQuestions`，`T50/T95=timeToFirstTokenP50Ms/P95Ms`，下标 `ref` 表示第一份全文参考，则

```text
Q = 100 × (F/Fref)^wF × (T50ref/T50)^w50 × (T95ref/T95)^w95
```

权重必须是严格正的有限数，且总和为 1；没有固定 TTFT 预算、阈值、epsilon 或分数截断。参考自身 Q=100，候选可以超过 100；100 只是相对标尺，既非准确率百分比，也非理论质量上限。参考 F1 为 0，或任一侧 TTFT 非正、非有限时 Q 不可用；候选 F1 为 0 且其他比较条件均有效时 Q=0。权重来自配置文件而非编译进代码；更改权重应另存配置与新输出，保留原实验口径。计算保留完整浮点精度，报表只显示两位小数。

`answerF1AllQuestions` 使用 QASPER 官方归一化 token 多重集 F1，对多位标注者取最高分。数据归一化保留 extractive spans 拼接、free form、yes/no、`Unanswerable` 参考；每道**已尝试题**都进入固定分母，失败或跳过计 0，缺题或缺参考答案使 Q 无效。这个词法 F1 不等于语义准确性或有证据支撑的正确性。旧 `answerF1` 仍是可缺席的历史诊断；拒答、judge、检索、token、完整答案时间、失败与原始逐题记录也分别保留，不由 Q 代替。

Q 要求两侧都是 schema 2 / `query-timeline-v2`，并逐项核对同一数据集指纹、已执行题目顺序、已完成速度 cohort、answer provider/model、endpoint、固定 prompt framing、生成设置哈希、retry、流式/缓存/并发协议与执行环境。它重算每题 F1、质量聚合与速度聚合；旧 v1、缺参考答案、指标不一致、仅取成功题交集或用旧 `answerF1` 补空值均不可出 Q。即使结果含失败题，失败题也留在质量分母，速度 cohort 只接受完整时间线；两侧 cohort 不一致时 Q 为 `—` 并列出原因。`full-context` 虽然 `comparisonEligible: false`、继续排除在检索排名及检索 delta 之外，仍是 Q 的合法参考。

派生 JSON 原样包含参考结果、候选结果及配置的解析后内容（包括当前 schema 未识别字段），同时记录三份输入的文件名和原始字节 SHA-256，便于追溯。写入器递归拒绝 `apiKey`、`authorization` 等凭据键，但**不扫描自由文本**；导出或分享前检查源结果的 `errors` 和自由文本，勿提交凭据或原始用户数据。

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

**答案** —— `answerF1AllQuestions`（QASPER 已尝试全题固定分母 F1；Q 的质量项）、`answerF1`（历史可缺席诊断）、`unanswerableAccuracy`（该拒答时是否拒答）、`judge*`（三维 1-5 分，仅 `--judge`）

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
| Ceiling | `--mode full-context` | 报表沿用**生成上限**标签，指全文直投参考而非理论质量上限；它不是检索选手：无检索、全文直投，预算不受 4096 约束，故 `comparisonEligible: false`，只进「生成上限」表、不进检索排名。注意它是 `--mode` 取值而**不是**配置名——没有 `configs/full-context.json`，结果文件里的 `config.name` 仍是 `default`，不要去找一个不存在的配置 |
| Strong | `hybrid-rerank`、`long-section-rag` | 强基线组（计划 §0）：成熟检索栈、结构化阅读 |
| Primary | PaperMind 当前管线 | 被评测的生产方法 |
| Hybrid | `papermind-hybrid`、`papermind-hybrid-m3` | 段落级混合检索（方案 `docs/superpowers/specs/2026-09-23-hybrid-passage-retrieval-design.md`）：BM25 + 段落向量 + 结构卡片先验三路加权 RRF，回答前零 LLM 调用；冷启动成本单独成表、不进 Q。任一题降级为 `bm25*` 检索（向量模型加载失败或单篇向量失败）整轮标 `comparisonEligible: false`。`-m3` 变体向量模型为 `Xenova/bge-m3`（`BAAI/bge-m3` 官方仓库无 q8 ONNX 权重，pin 到 revision `4de13258`），查询不加 bge v1.5 的检索指令前缀 |
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

LLM 响应缓存 key 是 `provider`、`baseUrl`、`model`、序列化的 `messages` 与生成参数对象的 `\0` 分隔串的 SHA-256；生成参数包含 `maxTokens`、`temperature`、`topP`、`thinking`、`stop`。不同采样、thinking 或停止设置不会串用缓存；这让配置矩阵可行：不同 `topK` 共享同一份索引构建结果，只有评分调用需要重发。失败请求也计入 misses，故 `hits/(hits+misses)` 在有错误时会偏低；runner 为纯串行，无并发去重需求——若未来并行跑样本需加 in-flight 去重，否则命中率会塌。

`--no-cache` 当前只跳过**读**缓存、不覆写已有缓存文件（与 spec §8 的「强制重跑并覆写」有差距），`meta.cacheMode` 如实记录实际口径（`normal` / `bypass`）。summary 任务走 HuggingFace 摘要模型、不经过 LLM 缓存，`cacheMode` 仅做口径统一，`--no-cache` 对它无实际作用。

改动 judge rubric 需 bump `RUBRIC_VERSION`（版本号嵌在 prompt 里，而缓存 key 按 prompt 哈希，所以会自动使缓存失效）。

## 口径自证

结果 JSON 的 `meta` 记录了 `model` / `judgeModel` / `gitSha` / `timestamp` / `unanswerableMethod` / `cacheMode`，指标侧有 `REFUSAL_PATTERN_VERSION`（报表打印拒答模式表版本）与 `RUBRIC_VERSION`——任何一个数字都能追溯到产生它的口径与代码版本。

schema-v2 结果另将版本化评测契约的全部坐标随 `meta` 落盘：`metricSchemaVersion`（2）、`mrrDefinition`（`context-page-v1`）、`contextBudgetTokens`（4096）、`contextTokenizer` + `contextTokenizerRevision`（`BAAI/bge-m3`@`main`）、`evidenceMappingVersion`、`datasetFingerprint`、`eligibleRetrievalQuestionIdsHash` 与 `eligibleRetrievalQuestionCount`；`comparisonEligible` 标记该结果是否进入检索排名（`full-context` 为 `false`）。横向差值只有在这些坐标全部一致时才计算（`retrievalComparisonIssues`），任一不一致即拒绝输出差值。
