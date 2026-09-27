# LLM 预生成结构：速度优先的产品验证

日期：2026-09-27

分支：`exp/llm-structure`

状态：修订设计，尚未实现或运行实验。替代此前以质量归因、机制消融为中心的版本。

## 1. 产品问题与优先级

用户明确的排序：**速度最重要，其次准确率**。本实验回答：PaperMind 是否值得默认生成 LLM 结构，还是直接检索原文能提供更好的使用体验。

决策顺序：先检查回答是否仍可用，再优先比较用户实际等待时间，最后考虑准确率小幅收益、调用成本和实现复杂度。不能为了几个质量分默认增加明显等待；也不能通过快速返回空答案获胜。

关注两个产品时刻：

1. 新论文第一次提问：文本解析、索引等待及后台构建是否影响首次可见回答。
2. 已有论文继续提问：取证耗时、首字等待及完整回答时间。

当前结构卡片不是推理模型的长期记忆，而是检索先验。本轮只判断现有增强的产品价值，不证明所有树/结构在理论上是否有效，不研究分组与描述各自的贡献。

## 2. 直接沿用当前 bench

核对依据：`bench/README.md`、`runner/qa.ts`、`runner/passageIndexHook.ts`、`speed/{queryTimeline,metrics,contract,policy}.ts`、`scoring/{qScore,qComparison}.ts`。

现有能力继续使用：

- `npm run bench -- --task qa --speed`，schema 2 / `query-timeline-v2`。
- 真实流式回答；首次可见正文才算首字，reasoning/usage 帧不算。
- TTFT 包含检索、消息组装、排队、网络、重试；不是只计模型生成时间。
- 单题串行，客户端 answer cache 关闭，speed 不续跑 query checkpoint。
- 速度主表七列：Evidence Ready P50/P95、TTFT P50/P95、Full Answer P50/P95、Avg Online Tokens。
- 同一数据集、问题顺序、完成 cohort、模型、endpoint、prompt framing、生成参数、环境身份才允许 speed delta/Q；不放宽比较门禁。
- `answerF1AllQuestions`、拒答、失败账目、现有页级证据指标与 `--judge`。
- 4096 token 检索证据预算与公共 materializer；同一 tokenizer/切段/回答 prompt。
- 现有 full-context 路径作为 Q 的参考；现有离线 `--compare ... --q-config ...`。

本轮必须补上的缺口：现有 QA runner 先等待索引完成再记 query t0，passage hook 还强制等待 stage 3。因此热 TTFT 无法回答“刚导入能不能马上问”，`sectionWeight=0` 也无法测不生成结构的收益。

## 3. 对照组：三个产品方案 + 一个现有参考

| ID | 产品方案 | 检索 | 文档处理 | 主要问题 |
|---|---|---|---|---|
| A lexical | 最快可用 | 原文段落 BM25 | 本地切段；不加载向量，不生成结构 | 最简路径是否已经足够 |
| B hybrid-raw | 无生成式预处理 | 原文 BM25 + 段落向量 | 切段 + 本地向量；不生成结构 | 默认推荐候选 |
| C hybrid-llm | 当前完整路径 | 与 B 相同 + LLM 结构卡片先验 | B + LLM 卡片 + 卡片向量 | 当前增强的成本和收益 |
| R full-context | 全文直投参考 | 无检索 | 沿用现有全文 runner | 相同协议下计算 Q 的标尺 |

**核心比较 B vs C；A 是速度下限方案；R 只是 Q 参考，不是质量理论上限。** 不再把原文章节卡片、四格机制消融、Jev、旧语义树列入首轮。

A/B/C 使用相同 Passage[]、原文清洗、原文标题、120/350 切段、邻段策略、排序组装及 4096 证据预算。B/C 固定相同 embedding 模型/revision/dtype/维度；C 用现有 sectionWeight=0.5，B 无 cards/cardVectors。其余旋钮沿用现有配置，不扫网格。

“无生成式结构”不意味着删除原文自带标题或取消原有章节感知切段。A/B 构建阶段必须零 LLM 请求，不能先生成再关权重，也不能通过让模型调用失败得到 fallback 来冒充禁用。

C 的卡片沿用当前实现，只作用于检索；最终回答用原文。来源标签统一使用真实论文/页/段落 ID，避免生成标题变成额外答案提示。

R 保留当前全文输入口径，不强制裁成 4096；它与检索臂的信息预算不同，是既有 Q 参考，不作为结构消融。每轮都用相同文件、顺序、模型和生成协议重新跑 R，禁止随手复用旧结果。

## 4. 速度指标：用户等待在前，模块耗时用于解释

### 4.1 热查询主表：完全沿用 query-timeline-v2

每臂索引就绪、本地模型初始化完毕后，同题同顺序运行：

| 优先级 | 指标 | 用途 |
|---|---|---|
| 首要 | TTFT P50/P95 | 用户开始看到回答的时间；同时关注常态和长尾 |
| 第二 | Evidence Ready P50/P95 | 检索是否在拖慢首字；不能代替 TTFT |
| 第三 | Full Answer P50/P95 | 避免首字快但完整回答很慢 |
| 辅助 | Avg Online Tokens、完成率、失败/超时数 | 解释网络成本和失败偏差 |

保留现有七个 headline 字段与聚合函数，不另造“热速度得分”。报表突出 TTFT，但六个时间分位数仍来自同一完整 cohort。

A 是有意不用向量，不能沿用“bm25 模式一定是意外降级”的逻辑将其判无效；B/C 的意外向量失败仍明确标记。失败样本不补假时间、不从质量分母消失。

### 4.2 冷首问：本轮必做的轻量补充

新增独立 `cold-first-query-v1` 记录，与现有热 speed 并排报告，**不改 query-timeline-v2 的 t0，不把冷时间塞进现有 Q**。

固定起点：用户问题已提交、原文尚未建立索引时，单调时钟开始。QASPER 从规范化文本输入开始；真实 PDF 从本地 bytes 开始，包含实际解析，二者分别成表。本轮不开发新 OCR 能力；不能解析的 PDF 如实失败。

每篇使用清单中固定的第一道问题，每个场景最多一次首次提问；所有臂选同一道。记录：

- `localModelInitMs`：需要的本地模型首次进程加载；已经下载好的文件不代表已经初始化。
- `lexicalReadyMs`：本地切段并具备检索条件。
- `denseReadyMs` / `structureReadyMs`：对应能力实际完成，A 无此步骤记不适用，不记缺失错误。
- `coldFirstTtftMs` / `coldFirstFullAnswerMs`：从冷 t0 到首字/完成，直接实测。
- 首问实际使用的 index stage、retrievalMode、结构是否已就绪、后台任务起止与总耗时。

必须区分两种固定策略：

**ready-before-query（索引完全就绪后回答）**：A 等本地切段，B 等段落向量，C 等结构和卡片向量。量化等待各完整方案的成本，不声称这就是当前产品的默认首问等待。

**ask-at-lexical-ready（产品首问主场景）**：所有臂本地切段后即回答。A 无后续构建；B 继续向量构建；C 继续向量和结构构建。按产品语义只取提问开始时可见的已落盘阶段快照，不能在回答中途切换索引。模型未就绪则使用 BM25，绝不等待加载。真实后台任务必须继续运行并观测资源/网络争用，不能提前关掉后声称没有影响。

当前产品已经允许第二种策略：如果 B/C 首问实际都走 BM25，这正是产品事实，不能给 C 使用尚未完成的卡片。此时差异可能来自后台资源争用，也可能几乎没有差异，不预设“取消结构必然让首问更快”。完整索引就绪后的收益由热表测量。

每个策略/臂使用独立 fresh process 和文档缓存未命中条件；模型权重已下载，进程加载成本计入冷时间。清理仅限该实验专用缓存 namespace。首问完成后等待本篇后台任务收尾并记账，再开启下一篇，防止跨论文干扰；收尾不计入已经结束的用户首问时间。

冷表报告 P50/P95、样本数、完成/失败数及场景身份；同一策略、同一输入类型、同一问题清单和完成 cohort 才作差。不能相加“建索引 P50 + 热 TTFT P50”冒充冷首问分位数。

## 5. 准确率：用现有质量指标守底线

主质量直接用现有 `answerF1AllQuestions`：同一版本化参考、全题固定分母、失败/跳过为 0。不新建 semantic judge rubric、span-level evidence 评测或全量人工标注系统。

同时保留：

- 现有 unanswerableAccuracy 与方法标签、回答完成率、索引/生成失败数。
- 现有 evidenceRecall / hit / contextPrecision / contextPageMrr；它们用来定位漏证据，不代替答案质量，也不用于产品排名。
- F1 明显下降或与直观答案冲突的逐题样本，抽查原文、参考答案和回答。必要时复用现有 `--judge`，其耗时不进入回答时间线。

建议初始回归警戒线：相对 C，候选全题 F1 下降超过 0.02（绝对值）即触发逐题复核，不自动推荐默认替换。0.02 是设计建议，不是用户已承诺的容忍值，也不是非劣证明；复核若发现关键事实错误，即使整体 F1 在警戒线内也不能靠速度分掩盖。

本轮先给产品决策证据，不要求先完成统计非劣证明。重复结果波动大时明确“暂不能定”，不把未显著差异表述成等效。

## 6. Q：复用公式，显式表达速度优先

现有默认配置 `q-score.json` 为 F1 0.6、TTFT P50 0.2、TTFT P95 0.2，偏质量。保留原配置和原公式，历史口径不动。

新增拟用配置 `bench/configs/scoring/q-speed-first.json`：

```json
{
  "schemaVersion": 1,
  "formula": "weighted-geometric-relative-v1",
  "baselineMode": "full-context",
  "weights": { "answerF1": 0.2, "ttftP50": 0.4, "ttftP95": 0.4 }
}
```

这是对用户“速度优先”的建议权重，正式运行前固定并随结果存档，不能看结果后再调。两套权重都用现有离线比较器计算，分别标 `Q_default` / `Q_speed`，不可把新旧分数混作同一口径。

`Q_speed = 100 × (F/Fref)^0.2 × (T50ref/T50)^0.4 × (T95ref/T95)^0.4`

R 为同轮全文参考。Q_speed 用于概括热查询表现，权重不是字典序的速度保证；质量警戒、失败和冷首问必须单独展示，不能用高 Q 抵消明显的产品回归。只有通过现有 qComparison 全部身份/cohort/质量校验后才给分，缺失则显示不可比较及原因。

不为冷启动发明第二套综合公式。报告固定三张表：冷首问；现有热 speed + F1 + Q；文档构建成本。用户可以直接看去掉结构到底省在哪里。

## 7. 数据与运行规模：先拿到可用结论

首轮直接使用现有 `qasper-current.jsonl` 的冻结 60 篇 / 179 题。当前全题质量参考已具备，122 题可计算页级检索指标；不要重新抓数据、改伪页或扩展标注后才能开跑。

这份数据已经用于开发，因此结果叫“产品回归实验”，不宣称未知数据泛化。若出现要据此改变默认行为的明显结论，再用未使用论文做一次小规模确认；它不是首轮实施前置条件。

同轮固定：原文文件 SHA、执行问题顺序、Git SHA、回答/索引模型和 endpoint、embedding/tokenizer 实际版本、生成参数、4096 证据预算、相同机器/backend。tokenizer revision 若为 main，额外记录实际本地文件 hash；不同文件不作对比，不悄悄改旧契约常量。

分三步运行：

1. **冒烟**：5 篇固定论文，验证 A/B 零结构调用、C 正常构建、所有模式可比较、冷热计时不混用。
2. **一轮全量筛选**：A/B/C/R 各跑全部 179 题，共 716 个回答逻辑请求（不含结构及重试）。同一遍 speed 回答同时算 F1，无需独立再跑质量实验；冷首问使用固定每篇首题另跑，最多 3 臂 × 2 策略 × 60 篇 = 360 个回答逻辑请求，失败/重试另记。
3. **确认速度趋势**：优先复跑 B/C/R 两轮，使核心比较有三轮；A 若更有产品潜力也加入。各轮固定题序、轮换臂执行顺序，不并发跑臂；逐轮计算 speed/Q，不能把三个 BenchResult 草率拼成一份绕过门禁。若冷首问差异是推荐依据，也复跑对应策略两轮。

temperature 沿用 0，输出 token 上限、thinking、retry、timeout 使用现有 QA 设置并记录实际值。所有臂相同，不通过更短答案、更少重试或隐式关闭 thinking 制造加速。首轮不扫权重、不换多套 embedding、不跑机制矩阵。

结构质量实验可复用已冻结卡片；其原始构建耗时和缓存命中分别记录。冷热成本测量的文档 artifact 必须是 miss，热查询可以复用文档索引，但不复用答案或查询向量响应来伪造速度。本地安装下载时间另列，不与文档处理混合。

## 8. 产品判定

优先看 ask-at-lexical-ready 的冷首问与热 TTFT，再看 Evidence Ready、Full Answer 和 F1。

| 结果 | 产品倾向 |
|---|---|
| B 的冷热速度更好，质量无明显回归 | 默认直接 hybrid 检索，移除默认 LLM 结构生成 |
| A 更快且质量也够用 | A 作为即时可用路径；向量是否值得后台补齐由 B−A 决定 |
| B/C 首问、热查询近似，C 仅多消耗后台构建且质量无实质改善 | 取消默认生成；收益叫简化/节约，不夸大为响应加速 |
| C 有质量收益，但显著拖慢响应 | 默认保持快速路径，将结构作为可选深度增强 |
| C 质量明显更好，且冷热响应不退化 | 可以保留后台增强，但仍不阻塞首问 |
| F1 降幅大、失败率异常或速度波动改变胜负 | 先复核/复跑，暂不切默认 |

不设置“结构必须提升准确率才算实验成功”的目标。实验成功是清楚回答用户等待发生在哪里，以及哪条路径更适合默认产品体验。

## 9. 最小实现框架：扩展现有 bench，不建平行系统

### 9.1 配置与真实禁用

在现有 `passage` 配置增加可选 `mode: 'lexical' | 'hybrid-raw' | 'hybrid-llm'`，缺省为 `hybrid-llm`，旧配置保持行为。验证器按 mode 校验 embedding 要求，lexical 不初始化 embedder；矩阵展开必须保留 mode，不能只克隆 embedder 后把它丢掉。

新增三个配置文件（拟议路径）：

- `bench/configs/structure-lexical.json`
- `bench/configs/structure-hybrid-raw.json`
- `bench/configs/structure-hybrid-llm.json`

对应修改 `bench/src/types.ts`、`config.ts`、`cli.ts` 的配置透传与期望模式判定。mode、模型身份、结构策略进入新增实验 meta 与缓存身份；不允许跨模式复用卡片。

### 9.2 索引构建

扩展现有 `src/utils/passageIndexBuilder.ts` 的显式构建策略：允许跳过生成式结构阶段，默认保持当前产品行为。无结构必须不调用 structure LLM、不构建 cardVectors；raw 的 rest 只等待需要的段落向量。A 返回真实 stage 1，B 在向量就绪时返回 stage 2；兼容用标题 tree 不参与卡片检索。

`bench/src/runner/passageIndexHook.ts` 按 mode 决定要求的阶段，取消对 A/B 的“必须 cards 非空”检查，仍对 C 保留完整阶段与失败诊断。禁用结构不记 structure fallback，不产生假的 structure tokens=1；结构字段区分“不执行”和“实际失败”。

生产默认参数不变；本轮不改变 UI、SQLite schema、产品自动补齐/缓存重建规则。产品随后若采用禁用策略，再独立处理“无卡片是完整状态而非待补齐”的持久化语义。

### 9.3 热查询与 Q

复用 `runner/qa.ts`、`speed/*`、现有 materializer/answer generator、`scoring/*`。只调整按模式判断预期 retrievalMode 的逻辑：A 的 bm25、B 的 bm25+dense 都正常；C 失败回落如实报告，部署表保留题目，严格比较资格遵守现有规则。

新增速度优先 Q 配置，现有比较器无需新公式；现有 report 可加一份实验摘要，链接到各轮原始报告。

### 9.4 冷首问扩展

新增一个小的 `bench/src/runner/coldFirstQuery.ts` 与 `bench/src/metrics/coldFirstQuery.ts`，复用同一构建器、生产检索与流式生成，不复制排序或回答逻辑。以构建器的 stage persist/onStage 事件记录能力就绪，外层时钟贯穿加载/构建/检索/回答。

ask-at-lexical-ready 使用 readiness handle，不能 await 构建 rest 后再声称是即时首问。记录任务完成/失败并做收尾；测试用受控 promise 验证问题在结构完成前已开始回答。

通过现有 bench CLI 增加独立冷场景入口参数（拟用 `--cold-first-query` 与策略选项）；与 `--speed` 互斥，输出独立冷场景 JSON，不传进现有 Q。fresh process/专用缓存由简单批次脚本编排，不新增 structureStudy 框架、裁判服务或 artifact 子系统。

### 9.5 必要测试

- A/B 不发结构请求；A 不加载 embedding；C 行为回归不变。
- mode 经配置展开/CLI/hook 真正生效；旧配置默认行为不变。
- B 与“C artifact 去除全部卡片分支”最终原文 context 相同；卡片描述不泄漏进 answer prompt。
- no-structure 不是生成失败，不产生伪费用或 fallback。
- A/B 的合法检索模式不会被误判为失败；意外降级仍可见。
- 冷计时含真实等待；即时首问不等 rest；后台争用场景真实执行；结束后不会污染下一篇。
- 热 v2 七指标、完整 cohort、F1 固定分母、Q 门禁及 token 完整性保持不变。

完成实现后运行相关新测试、`npm test`、`npm run typecheck`；正式模型实验单独记录，单测通过不能代替产品表现验证。

## 10. 交付结果

一份摘要足够回答默认策略：

1. 冷首问 P50/P95、实际检索模式与失败数（按策略/输入类型分表）。
2. 现有热 speed 七指标 + F1 + Q_default/Q_speed，各轮并列。
3. 结构构建耗时、后台完成时间、调用/实际或明确标注的估算 token；不为了报告金额另开发计费系统。
4. B−C 和 A−B 的产品解释，质量回归样本及是否建议取消默认预生成。

保留未见数据确认与必要错误分析，不再把多因素机制消融、新证据指标、全量新裁判或大规模统计研究作为首轮完成条件。
