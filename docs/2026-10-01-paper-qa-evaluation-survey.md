# PaperMind 论文 PDF 问答评测调研

调研日期：2026-10-01。范围：单篇或用户提供的有限论文集合上的 PDF 问答、证据检索、方法对照；扩展讨论跨论文搜索与综述。依据原论文、作者仓库与官方文档，不把检索结果数量视作使用率统计。“代表性”不表示整个行业有统一标准。未修改 benchmark 配置。

## 测试集与实际指标

| 测试集 | 主要任务 | 论文/官方采用的评价 | 对本项目的适用性 |
|---|---|---|---|
| QASPER | 单篇科研论文信息寻求问答，有人工答案及支持证据 | Answer F1、Evidence F1 | 现有主基准适用。原数据是结构化论文内容；我们的原始 PDF 解析与对齐增加了额外环节 |
| SciDQA | 来自评审与作者回复的深入问题；涉及正文、图表、公式、附录与参考文献 | ROUGE、BLEURT、BERTScore；LLM judge 的相关性、准确性、完整性、简洁性 | 适合补充复杂解释题；不能照搬为只看当前单篇正文的任务 |
| DocBench | 原始文档上传后问答，覆盖多种文档和题型 | GPT-4 判定 0/1，汇总 Accuracy | 与 PDF 产品流程接近，适合评估解析到回答的整体效果 |
| MMLongBench-Doc | 长 PDF、多模态、跨页及不可回答问题 | LLM 提取短答案后按规则计算 generalized Accuracy/F1 | 适合检验图表与跨页能力；这里的 F1 不是 QASPER token F1 |
| MMDocIR | 长文档内部的页面与版面区域检索 | Recall@k；区域标签通过框重叠评价 | 要比较检索器、切页、图文检索时很直接；不是答案生成基准 |
| ViDoRe | 多模态文档/页面检索 | V2 常报告 nDCG@5；V3 官方报告 nDCG@10 | 适合跨文档检索与视觉检索，不能直接用来评价回答质量 |
| SPIQA | 科研论文图表相关问答 | METEOR、ROUGE-L、CIDEr、BERTScore、BLEU，以及 L3Score 语义判分 | 以后评估图表理解时使用；当前纯文本方案有模态限制 |
| LitQA2 / PaperQA2 | 查找相关论文并阅读全文回答，多选与不确定选项 | Accuracy、Precision；同时分析 DOI retrieval recall | 适合跨论文搜索代理；回答 Precision 不能当作证据段落 Precision |
| ScholarQABench / OpenScholar | 跨论文、带引用的长答案与综述 | Correctness、Citation F1、Coverage、Relevance、Organization；专家评价 | 多篇综合与引用质量升级时使用，超出单篇短答 |

上述事实分别来自：[QASPER 论文](https://aclanthology.org/2021.naacl-main.365/)、[官方 evaluator](https://github.com/allenai/qasper-led-baseline/blob/main/scripts/evaluator.py)、[SciDQA 论文 §4.1](https://aclanthology.org/2024.emnlp-main.1163.pdf)、[DocBench](https://openreview.net/pdf/6476b6ba33688e29f503f8be3f5383185415c99a.pdf)、[MMLongBench-Doc §4.1](https://arxiv.org/html/2407.01523v2)、[MMDocIR §6.1](https://arxiv.org/html/2501.08828v1)、[ViDoRe V2](https://huggingface.co/blog/manu/vidore-v2)、[ViDoRe V3](https://huggingface.co/blog/QuentinJG/introducing-vidore-v3)、[SPIQA 官方指标](https://github.com/google/spiqa)、[PaperQA2](https://arxiv.org/html/2409.13740v1)、[OpenScholar 官方介绍](https://allenai.org/blog/openscilm)。

## 近期补充与版本约束

- AstaBench 明确区分 LitQA2-FullText 问答、LitQA2-FullText-Search 论文排序，以及 ScholarQA-CS2 长篇综述。即使共用题目，任务与评分也不同。[官方任务说明](https://allenai.org/asta/bench)
- 2026-07 的 ResearchQA: Benchmarking Citation-Grounded Question-Answering on Scientific Papers 收录 494 篇论文、6,211 题，覆盖多个领域；采用 citation precision、section coverage、citation accuracy、拒答相关指标及语义评价。它是近期候选，不应称为已有广泛共识的标准。问题是模型生成，引用匹配能验证引文是否出现在原文，但不独立证明它在语义上支持结论。[原论文](https://arxiv.org/html/2607.11074v1)
- ResearchQA 存在不同同名工作，引用时必须写完整标题，不能把它与 survey-mined ResearchQA 混为一谈。
- MMLongBench-Doc 的原始版、作者版本变化与 2026 年第三方修订应分别锁定。第三方 V2 更换标注和语义判分，论文明确说明其分数不能与 V1 直接比较。[修订论文](https://arxiv.org/abs/2608.03397)

## 指标分别回答什么

1. **AnswerF1**：标准化后答案词元的重合程度，不是答对题目的比例。正确改写可能低分，否定词、数字或单位错误也不能只靠总体重合识别。QASPER 官方对多个参考答案取最佳得分后按题平均。
2. **EvidenceF1**：官方标注证据段落与预测证据段落匹配的精确率、召回率的调和平均；不是语义相似度，也不是答案引用正确率。必须维持官方证据单位和匹配协议。我们的 PDF→规范段落映射会影响此分数，宜同时审计对齐覆盖率，不能用这个值单独诊断检索器。
3. **Recall@k**：前 k 个结果覆盖了多少金标准相关项。需要说明项是论文、页还是段落；“至少命中一个”应标为 Hit@k，不能含混地与多证据召回混用。
4. **nDCG@k / MRR**：相关项是否排得靠前；nDCG 适合带分级相关性，MRR 更关注第一个相关结果。BEIR 官方提供这些指标，但 BEIR 本身不评价 PDF 问答答案。[BEIR 指标](https://github.com/beir-cellar/beir/wiki/Metrics-available)
5. **语义正确性**：按题目和参考答案/评分要点，由固定 judge 或人工判定是否正确、完整。必须冻结 judge、prompt 和评分规范，人工抽检数字、否定、边界条件及拒答，不将 judge 当绝对真值。
6. **Faithfulness / Citation correctness**：回答主张是否得到已检索上下文或所引文献的支持。事实碰巧正确不等于有依据；引文真实存在也不等于能支持主张。QASPER EvidenceF1、ScholarQA Citation F1 和 ResearchQA citation accuracy 不能互换。
7. **RAGAS** 是评价工具，不是独立测试集，也不是一个通用总分。其 LLM-based Context Recall 用参考答案的主张作为证据覆盖代理，与基于相关文档 ID 的 Recall@k 不同。[官方指标目录](https://docs.ragas.io/en/latest/concepts/metrics/available_metrics/)、[Context Recall 定义](https://github.com/vibrantlabsai/ragas/blob/main/docs/concepts/metrics/available_metrics/context_recall.md)

## 对 PaperMind 的建议（研究判断，不是已执行变更）

**第一优先级：保留现有基准，提升结论可信度。** QASPER + AnswerF1/EvidenceF1 + retrieval latency/TTFT P50/P95 仍能支撑 A/B/C/D 方法迭代。179 题是开发子集，不能直接宣称官方 test/leaderboard 成绩；反复调参后应增加按论文隔离的未见测试集。四个主指标不必因为本次调研立即替换。

**第二优先级：做少量语义正确性审核。** 从现有回答抽取 AnswerF1 与人工感受不一致的题目，盲评正确性、完整性、拒答；新抽样也包含随机题，避免只审异常。这样能判断低 AnswerF1 是改写、长度还是实质错误。未来若增加自动 judge，应作为独立辅助列，不覆盖原始 F1。

**第三优先级：按要改的组件补一个针对性测试集。**

- 改检索器、切分或目录策略：MMDocIR 页面/区域子集 + Recall@k；方法返回不同粒度时，先映射成统一证据单位，并保持输入 token 预算可比。
- 改 PDF 解析或图表理解：DocBench 的学术文档部分，或 MMLongBench-Doc/SPIQA 的图表、跨页切片。
- 改多篇搜索与综述：LitQA2、ScholarQABench/AstaBench；不要用单篇 QASPER 的成绩代替多文档检索证据。

若只能增加一项：优先现有题目的语义审核；若必须增加一个公共数据集：优先选择 DocBench 中贴近真实 PDF 上传问答的学术切片。这里是基于当前产品功能与接入成本的建议，并非某个公共榜单的排名结论。

## 对照实验应固定的条件

以下是针对本项目的实验设计建议：

- 区分单篇内检索和整个论文库检索；当前单篇已知 paperId 的任务不能说明选论文能力。
- 相同 PDF/解析版本、题目、生成模型、提示、上下文预算；比较检索方法时别同时更换回答模型。
- 用论文级隔离的 development/test；按论文进行 paired bootstrap 或重复运行报告不确定性，小分差不直接当稳定改进。
- 保留无上下文、全文、金标准证据几个控制组，区分先验知识、检索失误与回答失误；全文不是理论上界。
- 保留质量全题分母；速度可报共同成功 cohort，但必须同时披露各方法失败数量，避免失败越多反而显得越快。
- retrieval latency 仍计从查询开始到最终上下文就绪，包含查询时模型路由、分词、截断；TTFT 从同一个起点计至首个可见回答 token。API 自身 TTFT 不是此端到端 TTFT。
- 冷启动/建索引单独计时；热查询报告 P50/P95。后端、并发、缓存、超时/重试与合盖休眠条件固定。方法有多次模型调用时，额外记录请求数与 token 成本作为诊断。

本次仅调研与记录建议，没有新增指标、下载数据集或发起付费评测。
