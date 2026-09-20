# 可横向比较的 Context Page MRR 设计

- 日期：2026-09-19
- 状态：设计已确认，待实施计划
- 范围：PaperMind QA benchmark 的检索指标、最终上下文来源轨迹及横向比较契约

## 1. 背景

当前 benchmark 将各检索方法内部的候选排序直接用于 MRR。候选单位却不一致：传统 RAG 排序 512-token passage，PaperMind 排序多页 PageIndex 叶节点，long-section-rag 排序锚点但向生成器发送扩展章节，语义树又使用树节点和证据块。不同方法的 MRR 因此不是同一个随机变量。

现有结果还存在分母不一致。传统基线通常在所有有效 evidence 问题上产生 MRR，PaperMind 的单叶短路、降级或树路由会缺少内部排序，从 MRR 分母中被剔除。横向报告可能把不同样本集合上的均值并排展示。

本设计将 MRR 从“检索器内部候选排名”重新定义为“最终送入生成模型的上下文中，首次出现 gold evidence 页的位置”。该定义评价生成器需要读到第几个来源页才能接触证据，并以最终 prompt 为共同观察面，不依赖内部检索结构。

## 2. 目标与非目标

### 2.1 目标

1. 让 PaperMind、传统 RAG、hybrid-rerank、long-section-rag 和语义树使用同一定义、同一分母计算 MRR。
2. 让 MRR、evidence recall、evidence hit rate 和 context precision 全部基于真正进入生成 prompt 的页面，而不是被选中但可能被预算截掉的候选范围。
3. 将检索评测与答案生成成功解耦：生成失败不抹掉已经完成的检索评测。
4. 在横向比较前验证数据集、有效题集合、指标版本、tokenizer 和上下文预算一致。
5. 保留旧结果的可读性，但禁止旧候选 MRR 与新 Context Page MRR 计算差值。

### 2.2 非目标

- 不修改各方法的召回、打分、重排或语义树选择算法。
- 不以本设计统一产品运行时的默认上下文限制。
- 不将 QASPER 的页级 evidence 升级为字符级或 canonical-passage 标注。
- 不让 full-context 参与检索 MRR 排名；它继续表示回答模型在全文可见时的能力上限。
- 不在本阶段重新设计 Answer F1、LLM-as-judge 或摘要指标。

## 3. 核心定义

### 3.1 最终上下文页序

`contextPageOrder` 是最终上下文中来源页第一次出现的顺序：

- QASPER 使用归一化后的 3000 字符伪页号。
- 真实 PDF 使用 0-based PDF 页号。
- 一个候选跨多页时，按该候选文本实际出现的原文页序展开。
- 多个候选包含同一页时，只保留该页第一次出现的位置。
- 页面只有部分非空文本进入 prompt 时，该页仍计入页序。
- 被最终 token 预算完全截掉的页面不进入页序。
- 页序必须与生成模型收到的上下文文本同源生成，禁止从 `selected`、`sources` 或内部 `scores` 事后推断。

### 3.2 有效题集合

一道题只有同时满足以下条件才进入检索指标分母：

- `unanswerable === false`；
- `evidencePages` 非空；
- evidence 映射明确，不是 `ambiguous` 或 `unmapped`。

对于完整 QASPER 数据集，每种检索方法必须使用相同的有效题 ID 集合。比较器校验 ID 集合本身，而不只校验数量。

### 3.3 Context Page MRR

对有效题 `q`，设最终页序为 `P_q`，gold evidence 页集合为 `E_q`。定义：

```text
rank(q) = min(i + 1), where P_q[i] is in E_q
RR(q)   = 1 / rank(q), if rank(q) exists
RR(q)   = 0, otherwise
MRR     = mean(RR(q)) over all eligible q
```

新字段名为 `contextPageMrr`，报表显示为 `MRR (context-page-v1)`。旧字段 `mrr` 的语义标记为 `legacy-candidate-mrr`，新运行不再产生旧 MRR。

### 3.4 同源检索指标

以下指标统一消费最终 `contextPageOrder`：

- `contextPageMrr`：首个 evidence 页的 reciprocal rank；
- `evidenceRecall`：页序覆盖的 gold evidence 页数除以 gold evidence 页总数；
- `evidenceHit`：是否至少覆盖一个 gold evidence 页；
- `contextPrecision`：页序中的 gold evidence 页数除以页序的总页数。

这些指标共享有效题集合。对有效题，即使未命中也必须显式写入 0，不能通过缺失字段退出分母。

## 4. 统一上下文来源契约

### 4.1 类型边界

在生产侧 `src/utils` 新增通用上下文轨迹模块。概念接口如下：

```ts
interface ContextPiece {
  page: number
  text: string
}

interface ContextGroup {
  pieces: ContextPiece[]
}

interface MaterializedContext {
  text: string
  pageOrder: number[]
  tokenCount: number
  truncated: boolean
}
```

`ContextGroup` 表示一个被选中的候选上下文单元。组内 piece 保持候选内的原始内容顺序，组间保持最终发送给生成器的候选顺序。公共 materializer 负责：

1. 使用现有候选分隔符连接 groups；
2. 使用冻结的 tokenizer 计算最终 token 预算；
3. 在预算边界截断最后一个 piece；
4. 生成最终 `text`；
5. 同步生成去重的 `pageOrder`；
6. 报告实际 token 数及是否截断。

生成器和指标层必须消费同一个 `MaterializedContext`。任何 runner 都不能独立拼一份 prompt 文本、再另行推测页序。

### 4.2 各检索方法的适配

- **PaperMind PageIndex**：被选节点按产品实际上下文顺序展开为逐页 pieces。
- **Traditional RAG**：利用 chunk 构建时已有的 token→page 来源，将选中 chunk 分解为逐页 pieces；重叠 chunk 的重复页由 materializer 首次出现去重。
- **Hybrid rerank**：保持最终 reranker 候选顺序，再按 chunk 的逐页来源生成 groups。
- **Long section RAG**：连续章节区域按实际 token 流顺序生成逐页 pieces。
- **Semantic tree**：EvidenceBlock 构建阶段保留 atom 的逐页来源，使被选证据块能生成逐页 pieces；邻居扩展和预算后的实际块顺序保持不变。

内部候选结构仍可保留用于诊断，但不再参与公共 MRR 计算。

## 5. 受控上下文预算

横向检索实验统一使用 4096 个 BGE-M3 tokenizer token 的最终上下文硬预算，并在结果中记录：

- tokenizer 模型名；
- tokenizer revision；
- `contextBudgetTokens: 4096`；
- 实际 `contextTokens`；
- 是否发生截断。

每种方法先执行自己的召回、打分和候选选择，再由公共 materializer 施加统一最终预算。单个候选允许在预算边界截断，部分进入的页面计入页序。

该预算属于 benchmark 的受控实验配置，不替换 PaperMind 产品默认的 `maxContextChars: 24000`。benchmark 调用生产管线时显式提供受控预算与 tokenizer；应用正常运行仍使用既有默认配置。

`full-context` 保持全文直投，用于表示回答模型充分利用全文时的效果上限。它不受 4096-token 检索预算约束，也不参与检索 MRR 横向排名。结果中标记 `comparisonEligible: false` 及原因 `full-context-generation-ceiling`。

## 6. Runner 分阶段数据流

每道题按 `index → retrieve → generate → judge` 分阶段处理。

### 6.1 Index

方法建立自己的论文索引。索引失败时：

- 记录论文级 index error；
- 对该论文的每道有效题写入空 `contextPageOrder`；
- 四个公共检索指标写 0；
- 不执行生成。

### 6.2 Retrieve

检索器输出候选 groups，公共 materializer 生成最终上下文。runner 随即：

- 计算并写入四个检索指标；
- 保存 `contextPageOrder`、token 数、截断状态和降级状态；
- 创建 per-sample 记录。

检索评分失败但产品成功回落到默认上下文时，指标按回落后的真实上下文计算，并由既有 `degradedRate` 单独表达降级。检索彻底失败且没有上下文时，对有效题写 0。

### 6.3 Generate

生成模型读取 `MaterializedContext.text`。成功后在同一记录中补充答案、Answer F1 和生成时延。生成失败时保留检索记录，并写 `stage: generate` 错误；检索指标不受影响。

### 6.4 Judge

judge 成功后补充 judge 指标。judge 失败只影响 judge 字段和 judge 成功率，不删除检索指标或 Answer F1。

### 6.5 断点续跑

checkpoint 必须记录阶段状态。只有生成完成的样本才算整题完成；只有检索记录的样本在恢复时继续生成，不能因为已存在 per-sample 记录而跳过。

checkpoint 签名至少包含数据集指纹、问题 ID、Git SHA、检索配置、回答模型身份、provider/base URL 身份、system prompt 哈希、生成参数、judge 开关与 judge 模型身份。凭据本身不得进入签名或结果文件。

## 7. 结果与版本契约

新结果至少记录：

```ts
meta: {
  metricSchemaVersion: 2
  mrrDefinition: 'context-page-v1'
  contextBudgetTokens: 4096
  contextTokenizer: string
  contextTokenizerRevision: string
  eligibleRetrievalQuestionIdsHash: string
  comparisonEligible: boolean
  comparisonIneligibleReason?: string
}

metrics: {
  contextPageMrr: number
  contextPageMrrSampleCount: number
  contextPageMrrEligibleCount: number
  evidenceRecall: number
  evidenceHitRate: number
  contextPrecision: number
}
```

per-sample 记录保留 `contextPageOrder`，便于复核 rank 和定位异常。为控制结果体积，不要求保存完整 prompt 上下文；已有答案与来源诊断继续保留。

旧结果仍可解析和展示，但缺少 `mrrDefinition: context-page-v1` 时一律按 legacy 结果处理。比较器不得在 legacy MRR 与 Context Page MRR 之间计算 delta。

## 8. 横向比较门禁

只有以下字段全部一致时，比较器才允许计算检索指标增减：

1. 数据集身份及内容指纹；
2. 有效题 ID 集合哈希；
3. `metricSchemaVersion`；
4. `mrrDefinition`；
5. 上下文预算；
6. tokenizer 模型与 revision；
7. evidence 映射版本。

此外必须满足：

```text
contextPageMrrSampleCount === contextPageMrrEligibleCount
```

任何条件不满足时，比较器不输出误导性的 delta，而是列出具体不可比较原因。

## 9. 报告

检索主表展示：

| 方法 | MRR (context-page-v1) | Recall | Hit Rate | Precision | 有效题数 | 检索失败 | 生成失败 |
|---|---:|---:|---:|---:|---:|---:|---:|

报告同时打印统一预算、tokenizer、指标定义版本和比较资格。`full-context` 放入独立的生成上限区域，不出现在检索排名表中。

旧结果的 `mrr` 可在历史详情中显示为 `Legacy candidate MRR`，但不进入新主表。

## 10. 测试策略

### 10.1 Materializer 单元测试

- 单页与多页候选；
- 候选重叠和重复页面；
- 相同页非连续重复；
- 4096-token 边界；
- 在页面中间截断；
- 后续页面被完全截掉；
- 空上下文；
- 文本与页序来自同一 materialization 结果。

### 10.2 指标单元测试

- 第一个页面命中；
- 后续页面命中；
- 多个 gold evidence 页；
- 未命中显式记 0；
- 空上下文记 0；
- unanswerable、ambiguous、unmapped 和空 evidence 不进入分母；
- 重复页不改变排名；
- 四个公共检索指标消费同一页序。

### 10.3 Runner 契约测试

构造具有相同最终 `pageOrder`、但内部候选表示不同的 PageIndex、traditional、hybrid、long-section 和 semantic-tree 结果，断言四个公共检索指标完全相同。

覆盖以下失败路径：

- index 失败；
- retrieve 失败；
- 评分降级并回落；
- generate 失败但检索指标保留；
- judge 失败但 Answer F1 与检索指标保留；
- checkpoint 从仅完成检索的记录恢复后继续生成。

### 10.4 比较器与报告测试

- 同版本、同预算、同有效题集合允许比较；
- legacy 与新 MRR 拒绝比较；
- 不同预算拒绝比较；
- 不同 tokenizer/revision 拒绝比较；
- 有效题 ID 集合不同，即使数量相同也拒绝比较；
- sample count 小于 eligible count 时拒绝比较；
- full-context 不进入检索排名。

## 11. 验收标准

1. 所有检索方法在同一完整 QASPER 运行中具有完全相同的 Context Page MRR 分母和有效题 ID 哈希。
2. 每道有效题都存在 `contextPageMrr`，取值为 `[0, 1]` 内有限数。
3. 生成失败样本仍保留检索指标。
4. prompt 中的上下文文本与 materializer 输出逐字一致。
5. 任一预算、tokenizer、指标版本或有效题集合不一致时，比较器拒绝输出 MRR delta。
6. full-context 继续保持全文直投并明确排除于检索排名。
7. 旧结果可以读取，但不会与新 MRR 混算。

