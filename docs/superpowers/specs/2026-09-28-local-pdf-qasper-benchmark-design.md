# 本地 PDF QASPER Benchmark 重构设计

日期：2026-09-28

分支：`exp/llm-structure`

状态：设计稿，待用户审阅；本轮不实施代码变更。

## 1. 目标与已确认决策

用根目录 `dataset/` 的真实 PDF 重建本分支的 benchmark。正式评测仅使用本地可用的 QASPER dev 论文；train 用于开发、调试和规则验证。输入文本必须来自实际 PDF 解析，不得用 QASPER JSON 全文替代 PDF 检索语料。

用户已逐项确认：

1. dev 的 280 篇 PDF / 1,002 题作为正式集合；train 不混入正式结果。
2. 质量指标只有 AnswerF1 和 EvidenceF1，均对齐官方 QASPER evaluator；EvidenceF1 采用默认口径，保留图表证据。
3. 索引已就绪后计时，仅报告 retrieval latency 和 TTFT，各自 P50/P95。
4. A/B/C 正式对比，R 全文直投单列参考；R 的 EvidenceF1 与 retrieval latency 不适用。
5. 替换旧 benchmark 的入口、指标计算和报表；保留历史结果及必要复现记录。
6. `predicted_evidence` 来自最终实际送入回答模型的检索上下文，不再让回答模型挑选证据。

以下关于对齐细则、失败处理、CLI 和统计样本集的内容是本设计的具体提案，随本文一并审阅，不视为已经单独获得确认。

## 2. 当前代码与替换策略

当前主入口为 `bench/src/cli.ts`，sweep 位于 `bench/src/runner/productSweep.ts`；真实 PDF 小集加载器为 `datasets/outlineStudy.ts`。现有 `metrics/retrieval.ts` 计算页级指标，不能改名后当作官方 EvidenceF1。现有全题 Answer F1 可以作为迁移基础，但必须用官方 Python evaluator 做逐题一致性验证。

当前 passage 保有逐页文本，公共 `ContextPiece` 只有 `page/text`，materializer 只返回页序；缺少预算裁剪后的精确来源范围。EvidenceF1 接入需要增加可验证的文本位置轨迹，不能从页号反推段落。

选择：复用 A/B/C 的 PDF 解析、切段、BM25、向量融合和原生目录检索能力，替换评测的数据适配、结果协议、评分、计时汇总和 CLI。相比只隐藏旧报表，这符合移除旧计算的要求；相比全部重写检索算法，可避免同时改变算法与测量口径。新增另一套长期并存的 benchmark 不在范围内。

共享生产工具只在来源追踪确有需要时做兼容扩展；不删除产品仍使用的检索算法，不改 UI、SQLite 或模型配置界面。

## 3. 数据集冻结

输入：

- `dataset/qasper-dev-v0.3.json`：官方原始问题、逐标注者答案和证据。
- `dataset/qasper-pdfs/<arxiv-id>.pdf`：真实 PDF。
- `dataset/qasper-train-v0.3.json` 及匹配 PDF：开发集合。

本次目录核验：dev 原始数据 281 篇，本地匹配 280 篇 / 1,002 题；缺失 PDF `1802.00396`，对应 3 题。正式集合明确命名为“local-PDF QASPER dev subset”，不得称为完整官方 dev。train 本地匹配 880 篇 / 2,579 题。这些数字只是文件与 ID 匹配结果，尚未证明 PDF 全部可解析。

prepare 阶段冻结 manifest：论文 ID 升序，论文内沿用原始 qas 顺序，保留官方 `question_id`。记录输入 JSON、PDF bytes、解析文本、原生目录、解析器和对齐版本的指纹；记录所有排除项与原因。正式运行不得根据下载状态自动改变集合。之后补齐 PDF 必须产生新的 manifest。

manifest 冻结后，解析失败、索引失败、目录缺失、证据对齐失败都不能删除论文或问题。遇到冻结文件缺失或 hash 不一致，拒绝运行并要求重新准备；遇到可复现的解析失败，保留该篇所有题目的失败记录。开发用限量运行必须显式标为 subset，不能覆盖正式全量结果。

## 4. 对比方法与公平约束

| 方法 | 检索行为 | 回答输入 |
|---|---|---|
| A：structure-lexical | PDF 原文 passage BM25 | 最终预算内检索上下文 |
| B：structure-hybrid-raw | BM25 + passage 向量融合 | 同上 |
| C：structure-hybrid-outline | B + PDF 原生目录先验 | 同上 |
| R：full-context | 不执行检索/证据选择 | 全部 PDF 解析文本 |

A/B/C 保持现有 120/350 token 切段设置、4096 token 上下文预算，以及现有融合参数。上下文计数沿用 BGE-M3 tokenizer；B/C 当前 embedding 配置是 `Xenova/bge-small-en-v1.5`、q8、384 维，不能混称为 BGE-M3 embedding。记录实际模型文件及 tokenizer 身份，不能只记录可变的 `main` 标签。

C 没有合法原生目录时回落 B，保留同一全题分母并在运行记录中注明。不得用 QASPER section labels 伪造 PDF 原生目录。B/C 稠密模型初始化失败时不能偷偷作为 BM25 继续出正式混合方法成绩；全局依赖故障使运行失败，单篇索引故障按失败题处理。

四组共享同一 manifest、问题、生成模型、endpoint、英文简洁回答指令、输出上限、temperature、thinking 设置与超时重试策略。无法回答时统一要求输出 `Unanswerable`，是非题使用 `Yes`/`No`；不在评分阶段用拒答正则重写答案。

R 不受 4096 检索预算约束；超过模型输入上限时记录失败，不能截断后仍称全文直投。R 不是理论质量上限。

## 5. 官方评分协议

权威实现：[allenai/qasper-led-baseline/scripts/evaluator.py](https://github.com/allenai/qasper-led-baseline/blob/main/scripts/evaluator.py)。实施时保存所采用脚本的固定 commit 与 SHA-256，复核许可证后用于一致性测试或直接执行；不能以浮动 main 作为唯一版本身份。

### 5.1 AnswerF1

严格采用官方答案处理顺序：不可回答为 `Unanswerable`；extractive spans 用 `, ` 连接；否则取 free-form；否则 Yes/No。保留每个标注者的独立答案。

答案小写、删除 Python `string.punctuation` 中的标点、移除独立英语冠词、压缩空白；按空白分词，以 token 多重集交集计算 P/R 和 F1。没有公共 token 为 0，包括归一化后双方均为空。每题对所有参考答案取最大 F1，最后在固定全部题目上宏平均。

只保留一个公开 `answerF1` 字段，含义就是上述全题官方口径；不再并列 legacy `answerF1` 与 `answerF1AllQuestions`。新 schema 与旧结果明确隔离。

### 5.2 EvidenceF1

不启用 `--text_evidence_only`。对单个标注者：

```text
overlap = |set(predicted_evidence) ∩ set(reference_evidence)|
P = overlap / len(predicted_evidence)
R = overlap / len(reference_evidence)
F1 = 2PR / (P + R)
```

字符串精确相等；评分器不清洗证据字符串。交集用集合，分母用原始列表长度，保留官方对重复项的行为。双方列表都为空为 1；否则交集为 0 时为 0。不可回答标注的参考证据为空列表。

每题分别对各标注者取最高 EvidenceF1；不将多个标注者的证据合并，AnswerF1 与 EvidenceF1 各自取最大值，不要求来自同一标注者。全部 1,002 题进入宏平均，不能沿用旧的“可回答且 evidence 映射成功”过滤器。官方缺失整题预测时，两项均为 0。

内部值为 0–1；报表也统一展示 0–1，保留四位小数，不混用百分制。R 只计算 AnswerF1，EvidenceF1 写 null / 显示 `—`，不伪造空预测证据进行评分。

## 6. PDF 到官方证据的适配

### 6.1 隔离标注与检索

prepare 的对齐器只接收 PDF 解析文本、QASPER `full_text` 的全部段落及 `figures_and_tables` 的全部 captions，不接收 `qas`、问题文本、gold evidence 或参考答案。检索器与回答器只接收 PDF 语料和当前问题，不接收 QASPER 原文替身或 gold。

原始标注只交给独立评分阶段。不能复用 `dataset/census.mts` 的 gold evidence 前 60 字符查找作为正式对齐器；该脚本只是历史普查工具，并读取了 gold。

### 6.2 首版对齐规则

给每个 canonical 段落/caption 分配稳定 ID，保留原始字符串。另建仅用于定位的规范化文本及其到 PDF 原字符区间的来源映射。按固定顺序执行 NFKC、修复英文字母之间的行末连字符加换行、将独立的 `(BIB|TAB|FIG|SEC|EQ)REF` 加数字占位符替换为空格、转小写、压缩空白并 trim。PDF 与 canonical 使用同一规则；每个保留字符携带来源区间，跨页连接使用空白而非正文标记。所有变换写入版本和测试，不能改变回答输入或 gold。

首版采用规范化后完整单元的唯一连续匹配，允许跨 PDF 页。无匹配或存在多个候选位置则标记未对齐/歧义；不靠问题语义、gold 或模型猜测。若规范化后不含有效文字，不能产生匹配。

图表证据用完整 caption 定位；输出字符串为 `FLOAT SELECTED: ` 加原始 caption，本次已在本地 train 样例中核对该前缀。实施时在 train 上完成格式验证后冻结，不能逐题从 gold 借用字符串补齐。没有提取到 caption 时保持未对齐；本轮不新增图像理解或 OCR。

prepare 输出全语料对齐审计，允许在 train 上人工检查和改进；dev 不用于选择最有利的对齐规则。对齐是 PDF 输入适配，不属于官方 evaluator；最终结果必须标注这一点，不能声称与直接使用官方 JSON 全文的实验具有完全相同输入条件。

### 6.3 从最终上下文导出预测证据

来源追踪至少包含 passage ID、PDF 页、原文字符区间、预算裁剪后实际贡献的范围。重复正文不能通过字符串第一次命中来推断位置。索引、上下文组装和 trace 从同一次文本处理产生，并验证 trace 能复原真实输入内容。

对最终上下文中的原文范围取并集。一个已对齐 canonical 单元只有在其完整有效文本范围被覆盖时，才输出其原始官方字符串；来自多个 chunk 的范围可以共同覆盖一个单元，重复检索同一单元只输出一次。仅出现一小段或被预算裁掉大部分，不能计作完整段落命中。

未被完整 canonical 单元解释的非空正文，按“每个实际输出 passage 内的连续残余区间”产生不匹配证据项。项使用稳定的 `UNALIGNED:<paper>:<range-hash>` 命名，检查与 canonical 字符串不冲突；保存对应 PDF 原文以供审计。不能丢弃残余项以改善 Precision。只排除 harness 自己添加的分隔符和标签，不排除检索到的无关正文、标题或页眉。

推导发生在评分侧，使用计时阶段记录的原始 trace；canonical 对齐信息不能参与检索排序、预算选择或回答。不增加证据选择 LLM。官方评分器读取适配器导出的字符串列表，完全执行其原始算法。

该保守策略可能因 PDF/S2ORC 文本差异降低得分；这是首版已知限制，不靠过滤 dev 题目消除。对齐误差与实际检索错误需要借助逐题记录区分。此适配规则连同完整覆盖要求属于本文待审阅的设计决策。

## 7. 热查询计时

PDF 解析、索引、embedding/tokenizer 加载预热、目录处理和离线对齐均在计时前完成。检索索引可以复用；query embedding、检索结果和最终回答不能命中客户端查询缓存。正式查询串行，concurrency=1。provider 侧缓存无法保证关闭，记录已知配置，不宣称完全控制。

使用单调时钟：

- `t0`：已具备索引后，runner 接收当前问题、尚未计算 query embedding 或组装上下文。
- `tContextReady`：检索、融合、目录先验、预算裁剪及必要来源轨迹准备完成，最终上下文固定。
- `tFirstAnswerToken`：流式收到首个非空白可见回答文本；reasoning、usage、角色帧不算。
- retrieval latency = `tContextReady - t0`。
- TTFT = `tFirstAnswerToken - t0`，包含检索、消息组装、网络、实际重试及等待。

R 的 t0 在逐题消息组装前，整篇 PDF 文本可预备；没有 tContextReady 检索里程碑。EvidenceF1 导出、官方评分与结果写盘在计时之外，不能将对齐开销混入检索速度。

采用最近秩法：升序数组索引 `ceil(p × n) - 1`，p 为 0.50/0.95；单位毫秒。无有效观测写 null / `—`，不能填 0。

四组 sweep 的速度表使用 A/B/C/R 都完整成功且具备必要时间戳的共同问题集合；A/B/C 的 retrieval latency 和四组 TTFT 均在这个集合计算，保证同表同题。单臂运行使用自己的完整成功集合，并标注未配对，不能直接当作配对比较。共同集合为空时保留质量分与错误记录，速度均显示 `—`。集合 ID 与样本数是统计来源元数据，不新增性能指标。

## 8. 失败和持久化

质量分母永远是冻结集合。解析或检索失败导致没有合法预测时，按官方缺失预测计两项 0，并保留本地失败记录；不得用 `predicted_evidence=[]` 冒充成功检索，从而在不可回答题上获得 1。

检索成功但生成失败时，保留真实 predicted evidence；预测答案置空，AnswerF1 为 0，EvidenceF1 仍按官方评分。空 evidence 只有确实成功得到空检索上下文时才算合法预测。流式中途失败不以半截回答参与质量评分，也不进入完整成功的速度集合。生成失败必须与成功输出空答案在状态字段中区分。

运行采用新的结果 schema，保留 manifest/config/model/代码版本身份、逐题状态、原始回答、predicted evidence、trace、必要时间戳与错误。成功完成题逐题落盘；中断后缺失题按缺失预测处理并标为 incomplete。断点重跑形成独立 run，不拼接不同运行的速度观测冒充单轮结果。

全局配置错误、模型依赖失败或全部生成失败退出非零；单题失败允许落盘整轮成绩，并附原始失败题清单。失败数与对齐清单属于运行有效性说明，不增加 completion rate、alignment rate 等报表指标。

## 9. CLI 与结果表

建议将 `npm run bench` 简化为三个明确子命令：

```bash
npm run bench -- prepare --split dev --dataset-root dataset --out <new-manifest.json>
npm run bench -- run --manifest <manifest.json> --methods A,B,C,R --out <new-run-directory>
npm run bench -- report --run <run-directory>
```

train 使用显式 `--split train`；限量 prepare 使用显式参数并在 manifest 标为开发子集。输出拒绝覆盖已有 manifest/run。现有模型环境变量可复用，但必须校验四组实际配置一致。run 同时得到原始预测与质量/速度结果，report 离线重算，不调用模型。实现时 README 提供完整可执行示例，不保留失效的旧命令。

正式表仅包含方法标识和六个数值列：

| 方法 | AnswerF1 | EvidenceF1 | Retrieval latency P50 (ms) | P95 (ms) | TTFT P50 (ms) | P95 (ms) |
|---|---|---|---|---|---|---|
| A | 数值 | 数值 | 数值 | 数值 | 数值 | 数值 |
| B | 数值 | 数值 | 数值 | 数值 | 数值 | 数值 |
| C | 数值 | 数值 | 数值 | 数值 | 数值 | 数值 |

R 在单独参考表使用同一列布局，EvidenceF1 和两个 retrieval latency 单元格为 `—`。表外说明数据范围、质量分母、速度共同集合、失败记录位置与模型身份，不再打印附加质量或速度表。

新 `metrics` 对象仅有六个字段：`answerF1`、`evidenceF1`、`retrievalLatencyP50Ms`、`retrievalLatencyP95Ms`、`ttftP50Ms`、`ttftP95Ms`。不适用或无观测值为 null。逐题只保留对应的两项分数、两项时间及必要原始记录。

## 10. 清理边界

删除旧评测公开入口及其专用计算/配置/测试：伪页 QASPER 通路、smoke/outline-study 小集运行入口、旧 traditional/semantic-tree/其他基线入口、摘要与 ROUGE、judge、拒答准确率、四项页级检索指标、Q 综合评分、冷首问、完整回答耗时汇总、online token 均值及旧附加诊断指标。移除失去用途的 `bench:trees` 等脚本入口。

迁移期逐项检查依赖后清理；A/B/C/R 所需公共代码保留并缩小接口。provider 返回 usage 可以留在原始请求记录，但不聚合成额外指标。历史实验文档标注已被本规范替代，不重写历史结论。

不删除历史结果、原始 PDF、数据集 JSON、模型下载或用户资料。旧结果不送入新评分器强制转换；新 reader 对旧 schema 明确拒绝。`dataset/` 继续 gitignored，不提交数据副本、API key、完整真实预测或 PDF 正文。

## 11. 验证与验收

1. 数据：固定排序、官方 question ID、dev/train 隔离、缺失 PDF 清单、hash 改变、解析失败保留分母、限量标记。
2. 官方一致性：同一人工 fixture 同时交给新实现和固定版本官方 Python evaluator，逐题及均值相等；覆盖重复证据、空集合、缺失预测、多标注者不同最优答案/证据、Unanswerable、Yes/No、图表和标点归一化。
3. 对齐：不传 qas 的接口约束；跨页、断词、重复正文歧义、无匹配、caption、分块合并、预算部分裁剪、残余不匹配项。修改 gold 不得改变对齐或检索结果。
4. trace：可复原实际上下文；被预算完全丢弃的候选不能出现在 predicted evidence；仅部分覆盖的 canonical 单元不能获得完整匹配。
5. 计时：用受控时钟/流验证 query embedding 与重试计入，解析/建索引/评分不计入，reasoning 不触发 TTFT；验证 P50/P95、失败样本和共同集合。
6. 端到端：用临时合成 PDF、人工标注和 mock 模型跑 prepare/run/report，断言只产生六个指标且 R 不适用项为 null；旧参数/schema 被拒绝。
7. 清理：依赖搜索确认运行路径没有旧指标计算，历史结果保留；执行 `npm test`、`npm run typecheck`，并验证 benchmark TypeScript 文件确实被对应检查覆盖。
8. 真实运行：先在 train 上做小规模解析、对齐与模型冒烟；冻结所有规则后执行本地 dev。真实外部模型评测的次数和预算在实施计划中说明，不把写文档视为已开始全量请求。

## 12. 审阅关注点与后续

本文已落实用户确认的范围。需重点审阅的具体提案是：完整单元覆盖的保守对齐、残余项计入预测列表、跨四组共同成功集合的速度统计，以及生成失败保留检索证据的处理。

这些规则影响 PDF 实验的可解释性，虽然评分函数严格复用官方定义，也不能将输入适配后的结果直接冒充官方 leaderboard 结果。

用户审阅书面设计后再编写实施计划；本文件不构成代码已经实现或真实评测已经完成的声明。
