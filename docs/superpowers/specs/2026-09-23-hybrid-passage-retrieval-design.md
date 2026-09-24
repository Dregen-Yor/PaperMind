# 段落级混合检索 + 结构卡片先验：设计

## 背景与已确认的目标

PaperMind v1 在冻结 QASPER 切片（60 篇 / 179 题）上答案 F1 低于全文直投与 BM25 / cosine 基线（v1 口径 0.194 vs 0.231 / 0.208 / 0.209），差距几乎全在抽取型题。按 v1 perSample 近似分析，主要原因有三：

- 整章粒度选择（平均 1.65 个章节、单章可达 12 页），选错一章即整段丢失证据，证据漏检 14%，漏检时 F1 仅约 0.07；
- 25% 的题上下文被预算截断；
- 约一半的题在回答前多一次串行 LLM 打分（均值约 4.2 秒），是首字延迟的最大来源。

现有 `buildPageIndex` 也不是单次调用：每个叶节点一次、根一次，共 N+1 次，且每个叶节点只看前 3000 字符（`src/utils/pageIndex.ts:125`、`:196-206`）。

与用户已确认的约束：

1. **产品与 bench 同一管线**：优化落在 `src/utils` 的真实 RAG 管线，应用与评测同时受益；Q 是验收指标，不做只对 QASPER 有效的特化。
2. **检索依赖**：BM25 + 本地小向量模型 **bge-small-en-v1.5**（int8 量化，约 35MB，384 维，仅英文）。**不面向中文论文**。
3. **回答前零 LLM 调用**：提问热路径只有最终回答一次调用；产品多轮对话时的查询改写保留（bench 单轮不触发）。
4. **上下文预算保持 4096 token 冻结**，与现有基线同口径。
5. **冷启动每篇论文恰好一次 LLM 调用**，生成结构卡片，替换 PageIndex 的 N+1 次调用。
6. **产品分阶段就绪**：提问不等待结构卡片调用。
7. **bench 单独记录冷启动成本**，不进入 Q，但与 Q 并列报告。

已知评测局限（用户认可，见记忆 q-score-limits）：QASPER 词法 F1 偏好简短回答、Q 不计成本、仅单轮英文、P95 样本少。因此回答提示词（`buildAnswerMessages`，与参考方共用、受 framing 指纹约束）**不在本设计改动范围内**，收益只来自检索与延迟。

与 `2026-09-21-progressive-topic-index-design.md` 的关系：两者都用一次全文 LLM 调用建立主题结构，但本设计不做查询时的主题路由（无论本地还是 LLM），卡片只作为融合打分中的一路先验；并引入段落向量，且直接进入产品默认路径。两者方向重叠，该实验是否继续另行决定；其中「LLM 自报结构不可作为事实证据」「失败不重试不修补」等原则在本设计中沿用。

## 总览

```
导入（后台，分阶段就绪，bench 在逐题计时之前完成）
  逐页文本 ─► 段落切分 P01..Pn ─────────────► 阶段①：BM25 可用
                 ├─► bge-small 段落向量 ──────► 阶段②：+ 段落向量
                 └─► 【唯一一次 LLM】结构卡片 ─► bge-small 卡片向量 ─► 阶段③：+ 卡片先验
  （② 与 ③ 的 LLM 调用并行）

提问（计时；回答前零 LLM）
  问题 ─► BM25(段落) ┐
       ─► 向量(段落) ┼─► 加权 RRF ─► 4096 预算填充 + 邻段扩展 ─► 原文顺序组装
       ─► 向量(卡片) ┘                                              │
                                        buildAnswerMessages ─► 唯一一次 LLM（流式）
```

## 一、段落切分

以论文自然段为单位，不按固定 token 数硬切：

- 标题行识别复用 `isHeadingLine`（从 `bench/src/baselines/sections.ts` 移入 `src/utils`）。**标题行并入其后一段的开头**，不单独成段；遇到标题强制开新段，**段落不跨小节**。
- 不足 120 token 的自然段向后合并，直到达到 120 token 或遇到小节边界。
- 超过 350 token 的自然段在句子边界切开。
- 小节末尾不足 120 token 的段**保留**，不跨标题合并。
- 允许跨页，由原文分片 `pieces: ContextPiece[]`（每页一片，`rawText === pieces 拼接`）记录页码，用于来源页与 bench 的 `contextPageOrder`。

页眉页脚与页码行清洗复用 `detectRunningLines` / `normalizeEvidenceText`，只影响打分与向量用的文本；进入上下文的始终是原文分片。PDF 自然段识别的工程细节（无空行页面的行级启发式等）在实施计划中处理。

段落记录：`{ id: 'P01'…, order, pieces, text, tokenCount, prevId, nextId, subsection }`。`tokenCount` 由注入的 token 计数器给出（见第五节）。

## 二、结构卡片（冷启动唯一一次 LLM 调用）

### 作用

卡片**不进入回答上下文、不作为事实依据**，只做两件事：

1. 把段落按主题归组，使「整片相关」能作为段落的加分项；
2. 用 LLM 读过全文后写出的摘要与 keyTerms，补上段落原文里没有的提问用词（例如原文写 "We evaluate on Europarl and MultiUN"，卡片 keyTerms 含 "datasets / evaluation data"）。

附带：由卡片推导现有 `IndexNode` 树（根来自 `paper`，每张卡片一个叶节点，页区间由其覆盖段落算出），UI 与依赖 `IndexNode` 的旧代码不改。

### 调用

使用产品的索引 profile（`indexProfile`）。输入为全部段落，每段前标 `[Pxx]`；输入超过 120000 字符（与语义树 `DEFAULT_MAX_INPUT_CHARS` 同值）直接走回落，不截断补救。

要求模型按主题把段落划为 3–10 片**连续**范围，输出 JSON：

```json
{
  "paper": { "title": "...", "summary": "2-3 sentences" },
  "sections": [
    { "id": "S1", "range": ["P01", "P05"],
      "title": "具体主题名，非通用章节名",
      "summary": "2-3 句，含具体名称、数据集、指标、数字",
      "keyTerms": ["5-12 个读者可能的提问用词，含原文未出现的同义说法"] }
  ]
}
```

卡片按主题划分，不照抄论文标题：可合并（Abstract + Introduction）也可拆分（Experiments 拆为「设置」与「结果」）。

### 校验

以下任一不满足即整份作废，**不重试、不修补**：

- JSON 可解析且字段类型正确；
- 卡片数 3–10；
- 每个 `range` 连续，全部段落被覆盖恰好一次（无重叠、无遗漏），且按段落顺序排列；
- 卡片标题不命中 `isGenericSectionLabel`；
- `keyTerms` 1–12 项，均为非空字符串。

语义合理性无法由程序校验，靠 bench 结果与人工抽查（沿用 `bench:trees` 的人工检查思路，新增卡片视图）。

### 回落

作废时按标题行划分章节，每章一张卡片，只有标题（无 summary / keyTerms），卡片向量只由标题算出；检索流程不变。记录 `structureFallback: true` 与原因（`request-failed` / `invalid-json` / `invalid-structure` / `input-too-large`）。

## 三、向量

- 模型 `Xenova/bge-small-en-v1.5`，int8 量化，L2 归一化；通过 `@huggingface/transformers` 加载（产品渲染层走 WASM，bench 在 Node 走 onnxruntime-node，同一权重）。
- 段落向量：段落文本（清洗后），不加前缀。
- 卡片向量：`title + ". " + summary + " Key terms: " + keyTerms.join(", ")`。
- 查询向量：加前缀 `Represent this sentence for searching relevant passages: `。
- 接口 `Embedder { id; embedQuery(text); embedPassages(texts) }`，测试注入假实现。`id` = 模型 + revision + 量化方式，进入缓存身份。
- 模型首次使用时下载（约 35MB）并本地缓存，之后离线可用。模型在建索引阶段加载，提问时不承担首次加载。

## 四、提问时检索

1. **查询**：单轮直接用原问题；产品多轮沿用 `rewriteQuery` 触发条件不变。
2. **三路打分**：
   - 段落 BM25（k1=1.2、b=0.75，实现从 `bench/src/traditionalRag/bm25.ts` 移入 `src/utils`，统计量加载时现算不落盘）；
   - 段落向量 cos；
   - 卡片向量 cos 得卡片名次，段落继承所属卡片名次。
3. **融合**（加权 RRF，k=60，RRF 实现从 `bench/src/baselines/rrf.ts` 移入）：
   `score(P) = 1/(60+r_bm25) + 1/(60+r_dense) + w_sec · 1/(60+r_card)`，默认 `w_sec = 0.5`；同分按段落 `order` 升序，保证确定性。名次 1-based。
4. **预算填充**（目标 4096 token）：
   - 全部段落按融合分进入优先队列；
   - 段落被选中后，其同一小节内的前、后邻段以「该段分 × 0.5」进入队列，已在队列中的取两者较大值；
   - 依次取出，放得下即放入；放不下跳过继续，连续跳过 20 个后停止；
   - token 计数包含组间分隔符 `CONTEXT_GROUP_SEPARATOR`，与 `materializeContext` 的计法一致，保证最终物化不截断；
   - 全文 ≤ 4096 token 时按原文顺序整篇放入。
5. **组装**：选中段落按原文顺序排列，原文连续的段落合为一个 `ContextGroup`，不连续的组以分隔符隔开。产出沿用 `RetrievalResult`：`contextGroups`、按真实连续页区间拆分的 `selected`、`sources`（卡片标题 + 页码）、诊断 `scores`，`llmCalled: false`。

### 分阶段就绪下的检索

检索按当前可用信号降级，不等待：

| 阶段 | 可用信号 | 融合 |
|---|---|---|
| ① 仅段落 | BM25 | 只用 BM25 名次 |
| ② + 段落向量 | BM25 + dense | 两路 RRF |
| ③ 完整 | BM25 + dense + 卡片 | 三路加权 RRF |
| 卡片回落 | BM25 + dense + 标题卡片 | 三路，卡片向量只由标题算出 |
| 向量不可用但卡片已生成 | BM25 + 卡片文本 BM25 | 段落 BM25 名次 + `w_sec` × 卡片 BM25 名次 |

检索结果记录实际使用的 `retrievalMode`（`bm25` / `bm25+dense` / `full` / `full-title-fallback` / `bm25+card-lexical`）。

## 五、回答

`buildAnswerMessages` 与系统提示词不变（与全文直投参考方共用，framing 指纹必须一致）。每题只有这一次 LLM 调用，流式输出。

## 六、产品接入

### 分阶段后台构建

`indexPaper` 改为分阶段流水线，每个阶段完成即持久化，提问读取当时已有的最高阶段：

1. **阶段①**（导入后 <1 秒）：提取页面、切段落 → 落盘。此后提问即可用 BM25。
2. **阶段②**（再数秒）：计算段落向量 → 落盘。
3. **阶段③**（约 20–40 秒，估算，待实测）：结构卡片调用 → 校验 → 卡片向量 → 落盘。

阶段② 与阶段③ 的 LLM 调用**并行**启动；卡片向量在两者都完成后计算。

`collectIndexedPapers` 不再同步等待完整索引（现 `src/stores/chat.ts:890-895` 在无索引时 await `indexPaper`）：若连阶段①都没有，只同步执行阶段①（本地、<1 秒），其余阶段继续在后台进行。

向量模型不可用（下载失败、离线无缓存）时停留在阶段①，并在后续导入或设置页操作时重试下载；卡片仍可生成，但卡片先验需要向量，因此此时退化为 BM25 匹配卡片文本（`retrievalMode: 'bm25+card-lexical'`）。

### 持久化

沿用 `paper_indexes` 表与 `window.db.index.*`，不新增表与 IPC 通道。`index_json` 升级为版本化结构：

```ts
{
  version: 2,
  stage: 1 | 2 | 3,
  passages: Passage[],
  passageVectors?: string,     // base64 Float32Array，n × 384
  cards?: StructureCard[],
  paper?: { title: string; summary: string },
  cardVectors?: string,
  structureFallback?: { reason: string },
  tree: IndexNode,             // 阶段①由标题行推导，阶段③由卡片推导
  embedderId?: string,
  structureHash?: string,      // 切段参数 + 卡片提示词版本 + 索引模型端点与模型名
  passageConfigHash: string,
}
```

失效规则：`passageConfigHash` 变化 → 全部重建；`structureHash` 变化 → 重做阶段③；`embedderId` 变化 → 只重算向量（段落与卡片），不重新调用 LLM。旧版（无 `version`）索引在加载时视为过期，后台重建；重建期间旧索引仍按旧路径（`scoreAndSelect`）服务。

一篇约 150 段的论文，段落向量约 230KB（base64 后约 300KB）。

### 管线

`IndexedPaper` 新增可选字段 `passageIndex`；`retrieveRagContext` 在其存在时走段落混合检索，否则走旧路径。`chat.ts` 调用方式不变。

### 语义树

退出默认路径：`treeEnabled` 默认值改为关闭，已存偏好不强制覆盖；代码与设置页开关保留，是否删除另议。

## 七、bench 接入

- 新增 `bench/configs/papermind-hybrid.json`（`kind: 'papermind'`，新增检索字段：切段参数、`rrfK`、`sectionWeight`、邻段系数、`skipLimit`、embedder 模型 / revision / 量化）。`default.json` 不改，历史口径保持。
- 冷启动（切段、卡片调用、全部向量、模型加载）在逐题计时之前完成，符合 query-timeline-v2 协议；卡片调用走带缓存的 LLM 客户端，重跑不重复计费。bench 始终构建到阶段③，不评测中间阶段的检索。
- token 计数注入冻结的 BGE-M3 分词器（`CONTEXT_TOKENIZER_MODEL`），与 materializer 一致。
- 旧版索引或缺失段落索引时**直接报错**，不静默走旧路径。
- 向量模型不可用时的 `bm25*` 模式结果打标记，不进入正式对照。

### 冷启动成本单独记录

每篇论文记录，并在结果 JSON 与报表中单列（不进入 Q）：

| 字段 | 含义 |
|---|---|
| `coldStart.passageMs` | 切段耗时 |
| `coldStart.embedPassagesMs` | 段落向量耗时 |
| `coldStart.structureCallMs` | 卡片 LLM 调用耗时（缓存命中时单独标记，不计入耗时统计） |
| `coldStart.structureInputTokens` / `structureOutputTokens` | 服务商 usage；缺失时标记为估算 |
| `coldStart.embedCardsMs` | 卡片向量耗时 |
| `coldStart.totalMs` | 端到端冷启动（②③ 并行时取墙钟） |
| `coldStart.structureFallback` | 是否回落及原因 |
| `coldStart.cardCount` / `passageCount` | 结构规模 |

聚合指标：`coldStartTotalP50/P95`、`structureCallP50/P95`（仅未命中缓存的调用）、`structureTokensPerPaper`、`structureFallbackRate`。报表在 Q 对比旁新增「冷启动成本」表。

同时新增每题 `retrievalMode`、`contextTokenCount`。

### 验收与消融

- 按 v2 速度协议运行 `papermind-hybrid`，与全文直投参考方计算 Q；按 q-score-limits 的约定，同时报告 judge 分、每题 token、Q 的 bootstrap 置信区间，小差距不判胜负。
- 消融：`sectionWeight ∈ {0, 0.5, 1}`（0 等于无卡片先验）；embedder `bge-small-en-v1.5` vs `BAAI/bge-m3`。
- 结构抽查：扩展 `bench:trees` 输出卡片划分（范围、标题、keyTerms），供人工核对。

## 八、错误处理汇总

| 情况 | 产品 | bench |
|---|---|---|
| 卡片调用失败 / 校验不通过 / 输入过长 | 标题行卡片回落，检索不变 | 同左，计入 `structureFallbackRate` |
| 向量模型不可用 | 停留阶段①，后续重试下载 | 标记 `bm25*`，不进正式对照 |
| 索引未就绪 | 同步只做阶段①，后台继续 | 不适用（计时前构建完毕） |
| 旧版索引 | 后台重建，期间走旧路径 | 报错 |
| 论文无文本 | 空上下文照常回答 | 记 `emptyContext` |
| 构建中途切换索引 profile | 沿用语义树的配置快照 + 代次保护：以开始时的 profile 快照计算 `structureHash`，写盘前比对代次，过期结果丢弃 | 不适用 |

## 九、测试

- **段落切分**：`pieces` 拼接无损；标题并入下段段首；token 下限 / 上限；不跨小节；小节末小段保留；跨页分片正确。
- **结构卡片**：提示词含全部段落编号；每篇恰好一次调用；非法 JSON、卡片数越界、范围不连续 / 重叠 / 遗漏 / 乱序、通用标题、keyTerms 越界均判非法；回落产出标题卡片；由卡片推导 `IndexNode`；三种失效规则各自触发正确的重建范围。
- **向量**：假 embedder 下查询前缀、卡片文本拼接与归一化正确。
- **检索**：融合确定性与并列破平；`w_sec=0` 等价于两路 RRF；各阶段降级；任意输入下总 token（含分隔符）≤ 4096；邻段扩展；跳过上限；原文顺序与连续合并；短论文整篇放入；`selected` 按真实连续页区间拆分。
- **管线**：段落路径下检索阶段 `llmCalls === 0`；多轮时改写仍触发；旧索引走旧路径。
- **store**：分阶段落盘与就绪状态；提问不等待阶段③；②③ 并行；profile 切换的快照与代次保护。
- **bench**：配置校验；冷启动字段与聚合；缓存命中的卡片调用不计入耗时统计；`bm25*` 结果被排除在正式对照外；旧索引报错。

## 不在本设计范围

- 回答提示词与回答格式调整（受 framing 指纹约束，且对 Q 基本中性）；
- doc2query 式逐段问题生成（可作为后续实验，卡片接口不预留专门字段）；
- 中文论文支持；
- 语义树代码删除；
- 设置页新增 UI（除语义树开关默认值外）。
