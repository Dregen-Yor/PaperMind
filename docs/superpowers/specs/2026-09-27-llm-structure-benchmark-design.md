# LLM 预生成结构的收益验证设计

日期：2026-09-27

分支：`exp/llm-structure`

状态：设计草案，供用户审阅；尚未实施或运行实验。

## 1. 已确认的目标与结论边界

用户已确认：论文经过轻量处理即可提问，额外计算可由具体问题触发；无需等待 LLM 预先理解全文。此次任务是设计 benchmark、metrics、对照组和大致实现框架，不改产品默认行为。

需要回答三个问题：

1. 相同原文检索基础上，LLM 预生成结构是否改善最终回答？
2. 改善来自主题分组，还是生成的标题、摘要、同义检索词？
3. 改善是否值得额外的导入计算、API token、失败风险和维护复杂度？

“有效”与“必要”分开：统计上有收益，不等于应默认开启；未发现显著收益，不等于证明无效。结论仅适用于已测数据、模型、预算和结构生成方法，不外推为“所有树均无用”。API 无持久记忆不是本实验的自变量。

本轮主对象是当前 `structureCards`，不是旧 `semantic-tree` 或 Jev。当前卡片是连续段落范围 + title + summary + keyTerms，供检索加分；没有多层树遍历。旧树和 Jev 的切分、路由与调用数不同，仅作为背景，不混入因果主表。

## 2. 方案选择

| 方案 | 能回答什么 | 代价/不足 |
|---|---|---|
| 两臂：原文 hybrid vs 完整卡片 | 当前增强是否有净收益 | 不知道免费章节信息是否已经足够，也不能拆分机制 |
| 四个主臂 + 四格机制消融（推荐） | 净收益、廉价替代、分组和描述的贡献 | 主实验四臂；机制阶段额外三个臂，共享已有卡片 |
| 原文、树、Jev、agentic、多模型大矩阵 | 多种产品路线横评 | 同时改变太多变量，成本高，偏离当前问题 |

先运行主实验，机制实验用于解释收益或失败，不以机制结果反过来修改已看过结果的主实验。

## 3. 对照组

### 3.1 四个主臂

所有臂使用同一份不可变 `Passage[]`，同一 token 计数器、原文清洗、局部章节边界、邻段扩展、证据预算及回答协议。

| ID | 段落检索 | 卡片来源 | 导入时生成式 LLM | 用途 |
|---|---|---|---|---|
| A lexical | BM25 | 无 | 0 | 最小可用路径，测不等向量的体验 |
| B hybrid-raw | BM25 + 原文段落向量 | 无 | 0 | 主基线 |
| C hybrid-title | 与 B 相同 | 原文中检测出的章节标题与范围 | 0 | 免费结构能否替代生成结构 |
| D hybrid-llm | 与 B 相同 | 当前 LLM 主题卡片 | 每篇一次逻辑构建，失败/重试另记 | 当前完整方案 |

主比较预注册为 D−B；D−C 判断 LLM 是否优于廉价结构；C−B 是原文章节先验的收益；B−A 是向量收益，不能称为结构收益。

C 使用现有 `buildTitleCards`。所有章节信息来自同一原文解析，不给 C 额外读取 QASPER 的干净 section labels。C/D 使用同一固定向量模型编码卡片，以相同卡片权重进入同一融合函数。

B 的“无结构”指无卡片先验、无生成式预处理，并非删除原文标题或取消已有章节感知切段。A/B 没有 `cards`、`cardVectors`；不得先生成再隐藏。

### 3.2 四格机制消融

把“分组方式”与“卡片表达方式”交叉，全部基于 B 的原文 hybrid：

| | 原文表征 R | LLM 表征 G |
|---|---|---|
| 原文章节分组 N | N-R：原文段落向量池化 | N-G：固定原文章节范围，LLM 只写描述 |
| LLM 主题分组 L | L-R：沿 D 的范围，原文段落向量池化 | L-G：D 的完整卡片 |

R 表征：组内各段向量按真实段落 token 数加权平均，再 L2 normalize；零范数视为不可用。只使用该范围原文向量，不用 D 生成的标题、摘要或 keyTerms。G 使用固定 `cardEmbedText` 字段和同一 embedding 模型。

比较 L-G vs L-R，保持 LLM 分组不变，测生成表征的贡献；N-G vs N-R 在原文分组下复核。比较 L-R vs N-R，测分组方案整体的贡献；卡片个数与范围长度也是这一干预的一部分，记录其分布，不能宣称“只改变了层级形状”。检验两因素交互，不把各差值强行相加。

N-G 使用单独的固定范围 prompt，禁止修改范围；其生成调用与 token 单独计费。L-R 仍然依赖 D 的 LLM 分组，绝不能标成零 LLM 冷启动。机制组是解释性对照，不直接作为产品胜者。

### 3.3 协议自检，不作为竞赛臂

- D-off：复用 D artifact，但彻底移除卡片分支。必须与 B 产生相同 passage IDs、context hash、预算消耗；这验证隔离正确，不代表免去了生成成本。
- 所有进入最终回答的事实文本都来自原文 pieces。生成摘要、关键词、主题标题不额外注入回答 prompt；来源标签统一为论文/页/段落 ID，防止标签成为隐性信息通道。
- 可选 gold-evidence 回答诊断：只用于定位生成瓶颈，独立记录；不给主臂金标，也不把它称为理论上限。

## 4. 数据与切分

### 4.1 已有数据审计

本地 `bench/datasets/qasper/qasper-current.jsonl` 当前为 60 篇 / 179 题：173 可回答、6 不可回答，122 题有可评分证据页映射，全部有版本化质量参考答案。该切片已多次用于开发和观察结果，只能作为 pilot/dev；重新分一半不能恢复为未见测试集。

不覆盖 `qasper.jsonl` 或 `qasper-current.jsonl`，不回填旧结果的版本字段冒充新结果。

### 4.2 正式数据协议

- Pilot/dev：上述 60 篇，检查管线、预估方差/成本和冻结权重。
- Confirmatory：从 QASPER validation 剩余论文中，按上游稳定论文 ID 排除全部已用论文、近重复及明确被使用过的样本，再冻结剩余集合。若上游仍为 281 篇且排除恰好 60 篇，候选至多 221 篇；实际数量以 manifest 审计为准，不先承诺。
- 本地 `paperId` 若只是位置编号，必须补充上游 ID/原文 hash 做映射；不能按标题近似拼接或默认位置恒定。
- 原始 snapshot、转换版本、论文/题目 ID 清单、题干/答案/evidence hash 全部进入 manifest。新文件及缓存使用独立命名空间。
- 正式集所有问题进入答案质量分母；只有预先固定的 retrieval-eligible 问题进入证据指标。映射失败不影响其答案质量评测资格。
- 保留源 evidence 段落与多标注者集合的 sidecar，绝不修改现有伪页分包口径。无唯一 span 映射的标注显式记 unmapped/ambiguous。
- 真实 PDF 另做外部有效性小集：使用有人工 QA 的短文及长文、标题抽取困难样本。先冻结问题、参考与证据，再运行。没有人工标注的长 PDF 仅测解析覆盖和耗时，不能产生 QA 正确率。

QASPER 仅支持论文单轮问答结论；中文跨语言查询、多文档问答、长综述总结、对话记忆不在主结论内。

## 5. 冻结条件与执行

### 5.1 质量实验

- 主证据预算 4096，沿用公共 materializer；预算含原文分隔符，计数器与建 passage 时相同。额外报告实际使用量，不强行填满。
- tokenizer/embedding 固定到不可变 revision 及本地文件 hash。现有 tokenizer `main` 不是充分身份，不把现有历史结果直接混入新表。
- 默认切段 120/350 token、RRF k=60、邻段系数 0.5、skipLimit=20；从当前配置继承后记录最终值。
- C/D 主表 card weight 同为 0.5，只有卡片来源变化。dev 补充扫描 {0.25, 0.5, 1.0}，各方法同等调参预算；各自最优配置仅进入“调优后产品比较”副表，不取代固定权重因果主表。
- answer 模型、endpoint 身份、prompt、语言、temperature、输出上限、重试/超时全部相同；单轮无 query rewrite。structure、answer、judge 各用独立角色客户端，即使模型相同也分别记身份与费用。
- 构建结构不得接触问题、参考答案或证据标注；每篇 artifact 只构建一次供该轮所有题复用。原文段落向量及查询向量在质量实验中可共享，保持字节相同。
- 主实验先固定一份结构 artifact；每个臂进行 3 次独立回答运行，temperature=0 仍不能假设服务端确定性。重复运行按轮号记录，不宣称 API 支持随机种子就一定确定。
- 稳定性补充：dev 预先按长度/标题可用性分层冻结最多 30 篇，独立构建 3 次结构，测选段一致性和质量波动；不能把共享同一 artifact 的回答重复称为结构稳定性。
- 预算敏感性 2048/8192 仅作后续诊断，各预算是独立 protocol，不改旧契约的全局 4096，不跨预算算结构收益。

### 5.2 计时实验

质量与计时记录分开，避免缓存重用伪造加速。速度复用 `query-timeline-v2` 的真实流式、单题串行、answer response cache 关闭和 usage 完整性规则。

- 文档冷启动：本地模型文件已存在、没有该论文索引/卡片/向量缓存，从规范化文本开始测 A/B/C/D 的完整 index-ready。模型进程加载时间另列。网络首次下载作为安装成本另列。
- PDF 导入：单独从本地 PDF bytes 开始计时，包含解析/OCR（如存在）；不能把 QASPER 文本索引时间冒充 PDF 导入时间。
- 首次可用：记录 `lexicalReady`、`denseReady`、`structureReady` 三个里程碑。产品允许在 lexicalReady 后提问，不能把 D 的全部后台成本都声称为必然阻塞。
- 首问场景分两种：等待本臂完全 ready 后提问；以及在 lexicalReady 立刻提问。后一种记录实际 index stage/retrieval mode，并在新时间线中包含等待、资源争用与请求耗时，不能用不同场景的 P50 相加代替实测。
- 首轮最小交付必须有各 ready 时间和“等待本臂 ready”的首问实测；未实施渐进场景之前，不对后台争用或即时提问收益作结论。
- 热查询：索引和本地模型已就绪，关闭本地 answer cache，不复用查询向量缓存，各臂执行同一预冻结问题顺序。以固定随机种子轮换臂的运行顺序，3 个 block；provider 缓存无法控制时记录可见 usage/cache 字段和限制。
- 调试可以续跑；正式速度样本不能用 checkpoint 补齐后冒充一次连续运行。失败题仍保留在质量和可靠性分母，速度列显示完成数；cohort 不一致时不输出严格速度 delta。

## 6. 指标

### 6.1 答案质量：做决策的主指标

1. `answerF1AllQuestions`：复用版本化 QASPER 全题 F1；每题跨 3 次回答先平均，再对题平均。生成/索引/检索失败计 0；不以成功题子集重定义主分母。
2. 盲审语义正确性（共同主要证据）：每题、每臂独立评分，隐藏臂名；使用问题、冻结参考答案及一致的 gold 原文证据评价 0/0.5/1（错误或无法回答可回答题/部分正确/完整正确）。不把候选自己的检索上下文作为唯一真值。gold 证据不可用时标明 reference-only，单独报告。
3. 对不可回答题，正确拒答记正确、给实质性编造答案记错误；另报可回答题误拒答率和不可回答题正确拒答率，附样本数。当前 6 个负例不足以支持稳定拒答结论。
4. Groundedness 单列：依据各臂实际回答上下文判断回答是否获得支撑。它回答“是否忠于已给证据”，与“是否正确回答问题”不同。无证据拒答可忠实却不正确，不合成一个分数。

现有 `judge.ts` 的 1–5 rubric 保留为 legacy，不重命名为上述指标。新增独立 rubric/version，固定 judge model/prompt；系统未产出有效回答时 semantic 正确性直接记 0，不必调用 judge。对有效回答的 judge 失败为缺失，不伪造 0 或满分。主质量 F1 仍保留该题；semantic 指标显示 judged/attempted 及系统失败数。缺评须按固定重试规则补齐或报告上下界，不能悄悄对各臂不同成功子集作差。

人工核查：test 前冻结抽样规则，随机分层抽取 50 题（不足则全部），盲审 B/D 所有回答轮次；再审盲评与 F1 强烈分歧案例。抽样分层按原文长度与是否可回答，按各层题数比例分配配额，并保存抽样 seed/清单；若为稀有类别超额抽样，汇总必须按抽样概率加权。随机样本用于报告 judge 一致性，额外错误样本仅诊断、不混入无偏正确率估计。裁判身份可以和回答模型同供应商，但必须披露；优先独立模型。

### 6.2 检索诊断：解释质量差异

- 兼容旧口径：最终 materialized context 的 evidenceRecall、evidenceHitRate、contextPrecision、contextPageMrr，固定有效题分母，失败为 0。
- 页指标只表示命中相关页，不代表真正读到了页内证据。增加 sidecar span 覆盖诊断：源 gold 段落与实际入上下文 pieces 做确定性规范化字符区间映射；跨块保留 offset，不用语义相似度伪造精确映射。
- `goldEvidenceCoverage`：一个标注者 evidence 集合内，被最终上下文覆盖的规范化 gold 字符数 / gold 字符总数；多标注者对完整集合取最高分，不把不同标注者的片段拼成“最佳答案”。
- `completeEvidenceHit`：至少一个完整标注 evidence 集合被覆盖；空集合不记成功。限定在预先冻结且全部 evidence span 唯一可映射的题目集合；映射失败数量显式报告。
- 不将“未标注文本”自动视为错误证据，span precision 若提供必须叫 annotated-evidence precision，不能当 factuality。
- 保存 selected passage IDs、raw/final context hash、实际 token、截断标志、卡片/range 分布、fallback reason，便于逐题复盘。
- Context MRR 受原文组装顺序影响，只作位置诊断，不用于本实验总排名。

### 6.3 时间、费用、可靠性

- 每篇：文本切段时间、段落向量时间、结构 API 时间、卡片向量时间、各 ready 时间、墙钟总时间；并行阶段不可简单相加。
- 每题：Evidence Ready / TTFT / Full Answer 的 P50/P95；明确热/冷场景及完成 cohort。
- 结构与回答分开记录逻辑调用数、实际 attempt 数、输入/输出 usage、缓存来源。供应商 usage 不可用时计费为 unavailable；字符/本地 tokenizer 估算放独立列，不能混算费用。
- 费用公式：每篇问 n 次的总成本 `C_index + sum(C_query_i)`，报告 n=1/3/10/30 的摊销情景。n 超过实测问题数时，是基于实测均值的预测，不冒充 session 实测。
- 价格表如使用，固定 provider、币种、单价及日期。没有可靠单价就只报 tokens，不造金额。不能把研究阶段共享 artifact 的边际开销当产品部署成本为 0。
- 若 D 的单题成本不低于 B，不存在靠多提问收回索引费用的货币 break-even；质量价值与费用分开展示。
- 结构失败率、fallback 率、向量失败率、答案失败率分别以全部尝试论文/问题为分母。
- 新研究报告不以现有 Q-score 作裁决：Q 将词法质量和热 TTFT 混成标量且不含冷启动，容易掩盖本问题的取舍。

## 7. 统计与预注册判定

主比较 D−B；以论文为 cluster 做配对 bootstrap，10,000 次、固定分析 seed，给出差值的 95% CI。每次同时重采样相同论文在两臂的所有题，先平均回答重复，避免把同论文问题及同题重复当独立样本。主点估计为题级宏平均，补充论文级宏平均；抽样时保持该估计量定义。

次比较 D−C、C−B、机制差值均报告 CI 并标探索性，不靠多次比较挑一个正结果当主结论。若要作多项确认性优越声明，另行预注册多重比较校正。

建议默认实践门槛：F1 容忍差 0.02（绝对值），语义正确性 0.03。它们是产品取舍建议，不是统计学常数；在首次查看正式 test 结果前由用户审阅并写入 manifest。若用户选择“先测量不定门槛”，仅提供效应/CI/Pareto 曲线，不出“可安全移除”的非劣结论。

- 保留增强的依据：D−B 的主质量有稳定正向证据，盲审同向，且代价可接受；优先作为可选增强，不能由热质量结果推出必须阻塞首问。
- 支持移除默认预生成：B−D 的 F1 95% CI 下界 > −0.02，semantic 下界 > −0.03，节约的结构调用/成本被实测，且可靠性与预声明关键组无明确严重退化。多个条件均需满足；未显著变差不是非劣证明。
- 结果不确定：CI 跨过容忍界限、semantic 缺评未解决或质量指标冲突。明确报告功效不足/证据冲突，不判平局、不自动删除结构。
- 分组：全文 token 长度、实际可检索内容是否本就装得进预算、原文章节标题可用性，以及能从标注确定的单证据/多证据组。局部事实/跨节综合等题型仅在规则或盲标注冻结后使用，不用实验输赢反推题型。
- dev 可用于评估 CI 宽度和预计调用量；剩余独立论文不足时，接受无法证明 2 分非劣，而非扩大容忍值直到通过。

## 8. 实现框架（设计，不是实施计划）

### 8.1 模块边界

| 模块 | 职责/复用 |
|---|---|
| `bench/src/structureStudy/protocol.ts`（新增） | arm 定义、允许变化字段、模型/预算/数据/分词器/rubric 身份；独立 study version |
| `bench/src/structureStudy/manifest.ts`（新增） | 数据冻结、上游 ID 映射、开发/测试隔离、sidecar evidence、问题顺序 |
| `bench/src/structureStudy/artifacts.ts`（新增） | 原文 passages、向量、N/L 卡片的不可变 artifact；按内容和构建配置寻址 |
| `bench/src/structureStudy/indexHook.ts`（新增） | 按 arm 构建 PassageIndex；无结构 arm 不获取生成权限；声明 expected mode |
| `bench/src/structureStudy/runner.ts`（新增） | 轮次/臂编排、失败账目、checkpoint；复用 `runQaTask` 及生产检索/生成函数 |
| `bench/src/structureStudy/metrics.ts`（新增） | study 质量契约、span coverage、配对统计、冷启动/摊销汇总；旧页指标继续复用 |
| `bench/src/structureStudy/judge.ts`（新增） | 独立盲审 rubric 与缺评状态，不改 legacy rubric |
| `bench/src/structureStudy/report.ts`（新增） | 主比较、机制表、CI、质量/成本曲线、逐题差异及排除/失败账目 |
| `bench/configs/structure-study/*.json`（新增） | 显式 arm 与冻结默认值，拒绝未知/矛盾组合 |
| `bench/scripts/structureStudy.ts`（新增） | prepare / run / analyze 的专用入口，避免扩张历史 CLI 矩阵 |

上述为拟新增路径，当前仓库尚不存在。主实验不修改 UI、SQLite schema 或产品默认构建策略。`src/utils/passages.ts`、`structureCards.ts`、`passageRetrieval.ts`、`contextTrace.ts` 为共享实现，禁止在 bench 复制打分与预算算法。

现有 `createPassageIndexHook` 强制等待 stage 3、要求 cards 非空，不适合直接开关实验。新增 hook 适配同一 `PassageIndexHook` 返回结构；A/B 返回真实无 cards 的合法索引，标题树仅满足旧数据类型，不参与检索。实验不能通过让 LLM 抛异常伪装禁用，否则会生成标题 fallback 且记录失败。

对 runner 的最小扩展：期望模式由 arm 指定；A 的 bm25、B 的 bm25+dense 是正常结果，不能被旧规则当作意外降级。新字段进入 study 专用记录/嵌套 meta，不破坏旧 frozen result 类型及比较器。

### 8.2 数据流与能力隔离

`冻结原文 → 一次共享切段 → 原文向量 artifact → 按 arm 装配 index → 同一检索函数 → 同一 materializer → context 快照 → 同一回答模型 → 离线盲审/统计`

结构构建单独接受 `pages/passages + structureClient`，不接受 `QaQuestion`。A/B/C 的构建器不注入 structureClient；单测注入调用即抛错的 spy，保证零生成请求。A 不初始化 embedder；B/C/D 固定同一向量模型。

协议自检必须检查最终 prompt/context，而不只看 config：D-off 与 B 的最终上下文逐字一致；卡片文本不会进入 answer messages；所有 passages 的 text/pieces/source/token hash 在各臂相同。

### 8.3 Artifact、缓存与费用

artifact key 至少包含原文 hash、段落切分版本与参数、tokenizer 文件 hash、模型 revision/endpoint identity、prompt/schema 版本、结构运行编号、生成配置。回答缓存 key 含 question、final context、answer 配置和回答轮号；正式速度禁用回答缓存，质量的独立重复也不得复用上一轮回答。

quality run 可以读取固定卡片和向量；记录 artifact 的原始生成账单与当前 cache-hit 时间，不把二者覆盖。冷启动 run 必须从本臂 artifact miss 开始；不同臂公平分摊共用成本与部署总成本分别展示。

`LlmClient.complete` 当前主要返回字符串，旧冷启动 tokens 使用字符估算。新 hook 需要通过可观测请求 wrapper 或兼容扩展获取逐 attempt usage，不修改 complete 的既有调用语义；拿不到就明确缺失。

### 8.4 失败策略

- D 结构生成失败：保留费用与失败原因，主部署表使用预声明 C 回落，仍归入 D（intention-to-treat）；成功构建子集另报，不删除失败论文。
- B/C/D 向量失败：保留退化后的部署表现及失败账目；该次不进入严格机制因果结论，报告协议不满足。不能用其他臂的成功样本交集悄悄重定义分母。
- A/B/C 意外发结构请求、生成文本进入回答、manifest/hash 不一致、budget/denominator 不守恒：协议错误，停止并判该轮不可比较。
- 答案超时/失败：全题 F1 为 0，保留检索结果；judge 失败是评测缺失，二者不得混同。

### 8.5 必要测试与产物

测试覆盖：零 LLM/零向量调用约束、共享 passages 一致性、C/D 来源隔离、D-off 不变量、来源标签无泄漏、预算与最终证据同源、失败仍入分母、禁用不伪装失败、fallback 计费、缓存身份、模型/预算变更拒绝横比、cluster bootstrap 确定性及缺评处理。

运行产物：冻结 manifest、每篇 artifact 与计费事件、逐题原文证据快照/回答/usage/时间线、独立 judge 记录、主/机制/成本报告、paired delta CSV、人工盲审表。语料和运行数据沿用 gitignored 结果目录；提交设计、配置和代码，不提交凭据/用户 PDF/模型权重。

## 9. 分阶段交付与停止条件

1. 协议及 pilot：实现 A/B/C/D 与隔离测试，在旧 60 篇跑通，冻结主参数、正式集、模型、判定门槛；预估实际调用量后才开启完整 API 运行。
2. 确认性主实验：四臂同题同预算，完成质量、冷/热时间和费用报告。每轮回答请求上限为 `4 × test 问题数`，三轮为其三倍，judge 与失败 attempts 另列；D 结构按论文数计费。
3. 机制解释：四格消融，共享 D 卡片；为 N-G 追加固定范围生成。结果只解释机制，不改已冻结主实验。
4. 外部有效性与产品决策：真实 PDF 小集、结构稳定性、必要时预算敏感性；再决定保留、按需生成或移除默认增强。

不在本轮加入 agentic 查询分解、Jev 重训、新 reranker 或多层树实现；这些会更换问题。只有发现明确的现有协议 bug 才修复共享实现，所有臂用修复后的同一版本重跑。

## 10. 参考依据

- 本仓库：`bench/src/runner/passageIndexHook.ts`、`bench/src/evaluationContract.ts`、`bench/src/speed/contract.ts`、`bench/src/metrics/judge.ts`、`src/utils/structureCards.ts`、`src/utils/passageRetrieval.ts`。
- [QASPER 原论文](https://aclanthology.org/2021.naacl-main.365/)：面向科研论文的信息寻求型 QA，包含答案与证据，适合作为主数据；原文页代理不能替代细粒度证据正确性。
- [Dror et al., ACL 2018](https://aclanthology.org/P18-1128/)：显著性检验需匹配任务、实验依赖与指标。本文采用论文聚类的配对 bootstrap 是针对本实验重复/聚类结构的设计选择，非引用论文对本项目给出的结论。
