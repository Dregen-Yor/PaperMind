# PaperMind 语义检索调研：论文矩阵与来源

日期：2026-10-02。配套[主报告](2026-10-02-semantic-paper-retrieval-survey.md)。共 22 项，含 1 项工程报告。作者采用首作者 et al. 简写；完整作者表见原文。标注“预印本”表示本次使用该来源，不代表已证明其没有后续正式发表。

核验等级：**中/正文**＝阅读了相关方法或实验段，足以支持限定结论，未复现；**弱/摘要**＝只核验元数据、摘要或方法概述，不据此声称实验优势。所有仓库均未安装、运行或审计，不保证当前 API、许可证或平台兼容。没有填报未核实的数字；“未核验”不是“作者没有报告”。

## A. 基础检索与上下文化表示

| ID / 论文、作者、年份与来源 | 任务与机制 / 假设 | 数据、指标、对照与已核验结果 | 成本、消融/失败边界、项目借鉴 | 核验与代码 |
|---|---|---|---|---|
| 01 [Dense Passage Retrieval for Open-Domain Question Answering](https://aclanthology.org/2020.emnlp-main.550/)；Vladimir Karpukhin et al.；EMNLP 2020 | 双编码问题与段落；独立向量支持高效检索 | 开放域 QA；摘要报告相对词法方法改善；本轮未核验各数据集指标表 | 基础范式；不等于细粒度条件匹配，也不是建议回退到老模型；精确成本与消融未核验 | 弱/摘要；代码未核验 |
| 02 [Passage Re-ranking with BERT](https://arxiv.org/abs/1901.04085)；Rodrigo Nogueira、Kyunghyun Cho；2019 预印本 | query–passage 联合编码，给已有候选重排 | MS MARCO passage ranking；具体结果表未核验，不作现代模型排名 | 在线成本随候选量增长；不能补回漏召回；借鉴阶段划分，非指定旧 BERT checkpoint | 弱/摘要；代码未核验 |
| 03 [ColBERTv2: Effective and Efficient Retrieval via Lightweight Late Interaction](https://aclanthology.org/2022.naacl-main.272/)；Keshav Santhanam et al.；NAACL 2022 | 多 token 向量匹配，结合监督改进与表示压缩 | 检索 benchmark；论文摘要支持空间压缩与有效性方向；本轮未提取数据集逐项成绩 | 比单向量索引复杂；更细的交互不保证 Mac 低延迟；消融未核验 | 弱/摘要；[官方实现](https://github.com/stanford-futuredata/ColBERT) |
| 04 [M3-Embedding: Multi-Linguality, Multi-Functionality, Multi-Granularity Text Embeddings Through Self-Knowledge Distillation](https://arxiv.org/abs/2402.03216)；Jianlv Chen et al.；2024 预印本 | dense、sparse、multi-vector 等模式共同训练 | 多语言、多粒度检索；精确各项指标/消融本轮未核验 | 可作为更强表示候选；BGE-M3 与当前 bge-small-en 不是同一资源量级，不可归因为纯结构改进 | 弱/摘要；代码未核验 |
| 05 [Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval)；Anthropic；2024 官方工程报告 | 索引时生成 chunk 语境，再做 contextual dense + BM25，可叠加 reranking | 原报告 top-20 retrieval failure：5.7% → 2.9%；是失败率，不是 AnswerF1；提供组件比较 | 离线生成成本与错误语境风险；自有协议不是本地 QASPER。元数据前缀只是受启发的简化变体 | 中/工程报告；非同行评审论文；实现未核验 |
| 06 [Late Chunking: Contextual Chunk Embeddings Using Long-Context Embedding Models](https://arxiv.org/html/2409.04701v2)；Michael Günther et al.；2024 首发，本轮查 v2 | 先长文 token 编码，再按段池化；缓解指代与跨块信息丢失 | BEIR 子集、LongEmbed 相关实验；nDCG@10；对比 naive/late、模型、切块方式和块大小 | 索引长序列开销；查询不需生成式路由。长文窗口、pooling、模型训练适配影响效果 | 中/方法与实验；[官方实现](https://github.com/jina-ai/late-chunking) |
| 07 [Contextual Document Embeddings](https://proceedings.iclr.cc/paper_files/paper/2025/hash/f79df6cbc6e5f708440004fad7ef64cc-Abstract-Conference.html)；John X. Morris、Alexander Rush；ICLR 2025，2024 首发 | 将邻近文档/语料上下文纳入训练目标和表示架构 | MTEB；摘要报告域外优势；本轮未核验表格/消融 | 语料层上下文不同于同篇段落指代；需要模型/训练支持，不是拼标题的别名 | 弱/摘要；代码未核验 |
| 08 [Context is Gold to find the Gold Passage: Evaluating and Training Contextual Document Embeddings](https://arxiv.org/html/2505.24782v2)；Max Conti et al.；2025 预印本 | ConTEB 测上下文依赖；InSeNT 平衡同序列与 batch negatives | ConTEB，nDCG@10；比较原模型、late chunking、训练；有负例权重消融及 CovidQA 退化案例 | 保持同篇区分度是关键；上下文化与 late interaction 不能直接互换；需适配训练 | 中/方法、Table 2 与消融；[官方实现](https://github.com/illuin-tech/contextual-embeddings) |
| 09 [Dense X Retrieval: What Retrieval Granularity Should We Use?](https://aclanthology.org/2024.emnlp-main.845/)；Tong Chen et al.；EMNLP 2024，2023 首发 | 自包含原子命题作为检索单位，对照句子/段落粒度 | 摘要报告检索及预算内下游 QA 收益；具体数据集分数本轮未提取 | 离线命题生成、条目膨胀、限定条件和原文追踪风险；不直接将命题当官方 evidence | 弱/摘要及方法概述；代码未核验 |

## B. 结构、科学问答与证据处理

| ID / 论文、作者、年份与来源 | 任务与机制 / 假设 | 数据、指标、对照与已核验结果 | 成本、消融/失败边界、项目借鉴 | 核验与代码 |
|---|---|---|---|---|
| 10 [RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval](https://arxiv.org/html/2401.18059v1)；Parth Sarthi et al.；ICLR 2024 | 聚类和递归摘要；collapsed-tree 跨层直接检索 | QASPER AnswerF1、QuALITY accuracy、NarrativeQA 文本指标；有同 retriever ±树对照，以及检索策略比较 | 离线摘要与来源映射；正文摘要树不是目录树；同配置消融优先于跨配置高分 | 中/§3–4、Tables 2–3；代码未核验 |
| 11 [From Local to Global: A Graph RAG Approach to Query-Focused Summarization](https://arxiv.org/abs/2404.16130)；Darren Edge et al.；2024 首发预印本 | 实体/关系图、社区摘要，回答全库全局问题 | query-focused summarization；本轮只确认任务边界，未核验精确 judge 协议及消融 | 构图和摘要成本；不能将全局综合优势外推单篇事实证据 | 弱/摘要；代码未核验 |
| 12 [From RAG to Memory: Non-Parametric Continual Learning for Large Language Models](https://arxiv.org/html/2502.14802v2)（HippoRAG 2）；Bernal Jiménez Gutiérrez et al.；ICML 2025 | passage + phrase 图；query-to-triple，LLM recognition filtering，PPR | NQ/PopQA、NarrativeQA、MuSiQue/2Wiki/HotpotQA/LV-Eval；QA 与检索评测；对照 NV-Embed-v2 及结构方法；提供组件分析 | 离线 OpenIE，在线 LLM 筛选；不是纯本地免模型图搜索。可借鉴关系辅助召回原文 | 中/§3、实验概述；[官方实现](https://github.com/OSU-NLP-Group/HippoRAG) |
| 13 [Language agents achieve superhuman synthesis of scientific knowledge](https://arxiv.org/html/2409.13740v1)（PaperQA2）；Michael D. Skarlinski et al.；2024 预印本 | 搜索、Gather Evidence、LLM relevance/上下文化摘要、引用回答 | LitQA2、综述生成和矛盾检验；accuracy、precision、弃答及各任务评价；涉及人工比较 | 多工具/API 回合；正文有 chunk 范围等分析；标题结论限原实验，非普适超人类 | 中/方法、RCS 相关段；[项目实现](https://github.com/Future-House/paper-qa)，当前版本不保证等同论文版 |
| 14 [Synthesizing scientific literature with retrieval-augmented language models](https://www.nature.com/articles/s41586-025-10072-4)（OpenScholar）；Akari Asai et al.；Nature 2026，预印本 2024 | 文献召回、领域重排、引用生成、自反馈补检索、引用检查 | ScholarQABench：正确性、归因及专家评测；对照 GPT-4o、PaperQA2 等；分析 reranking/self-feedback 组件 | 跨文献规模与训练投入大；取组件思想，不能声称能等比例提高 QASPER | 中/正式正文方法与实验概述；[官方实现](https://github.com/AkariAsai/OpenScholar) |
| 15 [RECOMP: Improving Retrieval-Augmented LMs with Compression and Selective Augmentation](https://arxiv.org/abs/2310.04408)；Fangyuan Xu、Weijia Shi、Eunsol Choi；ICLR 2024，2023 首发 | 把检索文本压缩后提供给 reader，允许选择不增强 | LM/QA 任务；本轮未核验各数据集指标表与压缩率 | 压缩器训练/推理成本；压缩不应破坏限定条件，优先考虑可追踪抽取 | 弱/摘要及方法概述；[官方实现](https://github.com/carriex/recomp) |
| 16 [Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection](https://arxiv.org/abs/2310.11511)；Akari Asai et al.；ICLR 2024，2023 首发 | 训练 retrieval/reflection tokens，按需检索并评估生成 | QA、事实性和长回答等任务；本轮未核验逐项结果与预算 | 需要专门模型训练/推理流程；API 提示词循环只是启发式变体 | 弱/摘要；代码未核验 |
| 17 [ColPali: Efficient Document Retrieval with Vision Language Models](https://arxiv.org/abs/2407.01449)；Manuel Faysse et al.；2024 首发预印本 | 页面图像编码为多向量，文本 query 与视觉 token 匹配 | ViDoRe；页面检索而非官方 QASPER 段落集合 F1；本轮未提取数值表 | 视觉模型、多向量空间、页面回到证据位置的成本；适合图表/OCR 失败路径 | 弱/摘要；代码未核验 |

## C. 诊断、反例与评测边界

| ID / 论文、作者、年份与来源 | 任务与机制 / 假设 | 数据、指标、对照与已核验结果 | 成本、消融/失败边界、项目借鉴 | 核验与代码 |
|---|---|---|---|---|
| 18 [Sufficient Context: A New Lens on Retrieval Augmented Generation Systems](https://arxiv.org/html/2411.06037v2)；Hailey Joren et al.；ICLR 2025，2024 首发 | 按上下文能否支持回答分层分析错误与弃答 | FreshQA、MuSiQue-Ans、HotpotQA；correctness/abstention 与 sufficiency 分析，不是在优化统一检索器 | 自动判定有误差；可用于离线审查，不必增加在线调用。质量与相关性不等价 | 中/§4、设置；[官方实现](https://github.com/hljoren/sufficientcontext) |
| 19 [Lost in the Middle: How Language Models Use Long Contexts](https://aclanthology.org/2024.tacl-1.9/)；Nelson F. Liu et al.；TACL 2024，2023 首发 | 改变答案相关内容位置与长度，检查长上下文利用 | 多文档 QA、key-value retrieval；具体表本轮未核验 | 不能把旧模型位置偏差的幅度直接套用当前生成器；启发顺序/去冗余测试 | 弱/摘要；代码未核验 |
| 20 [BRIGHT: A Realistic and Challenging Benchmark for Reasoning-Intensive Retrieval](https://arxiv.org/abs/2407.12883)；Hongjin Su et al.；ICLR 2025，2024 首发 | 检索需推理而非仅表面相似；比较检索与 query reasoning | 1,384 个跨领域问题；nDCG@10；摘要显示通用 embedding 榜单优势不能直接迁移 | 在线 reasoning 成本；任务不是科学 PDF，仅用来反对“embedding 相似度足够” | 弱/摘要；[官方项目](https://brightbenchmark.github.io/) |
| 21 [Is Semantic Chunking Worth the Computational Cost?](https://arxiv.org/html/2410.13070v1)；Renyi Qu、Forrest Bao、Ruixuan Tu；2024 预印本 | 固定切块、语义断点、聚类切块的比较 | 文档检索、证据检索、回答生成三类 proxy task；本文已核验方法与边界，具体各数据集表未复核 | 收益不稳定而有额外计算；部分人为构造协议限制泛化，不能断言所有语义切块无用 | 中/方法，实验细表未核验；代码未核验 |
| 22 [Beyond Chunk-Then-Embed: A Comprehensive Taxonomy and Evaluation of Document Chunking Strategies for Information Retrieval](https://arxiv.org/html/2602.16974v1)；Yongjie Zhou、Shuai Wang、Bevan Koopman、Guido Zuccon；2026 预印本 | 分开切分方式与编码/切块顺序，统一复现比较 | 6 个 BEIR 集 nDCG@10、GutenQA DCG@10；四个 embedder；同篇与跨库效果反转；Tables 3–4 | 书籍的单篇结果不是科学论文结论；作者代码地址该版仍匿名，无法据此独立复现 | 中/方法、§4.2–4.4；可用代码未核实 |

## 复用证据时的约束

- “强基线”指需要实际纳入的比较类型：BM25、dense、hybrid、hybrid + reranker；不把所有论文里的作者最优模型都称为本项目强基线。
- 核心正文优先核验的是上下文化、结构检索、科学 QA、充分性与负结果。基础模型条目主要建立方法谱系，摘要级条目不能作为定量收益承诺。
- 所列研究使用不同输入、生成模型、语料、预算和答案形式，不生成一个跨论文分数排行榜。
- 代码未核验的条目，实际复现前仍需确认官方实现、checkpoint、许可证、模型导出与设备适配。无需为本次阅读任务提前安装依赖。
