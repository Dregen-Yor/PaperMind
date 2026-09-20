# Query Timeline 时间效率 Benchmark 设计

- 日期：2026-09-19
- 状态：设计已确认，待实施计划
- 范围：PaperMind QA benchmark 的在线查询时间效率、流式 TTFT、完整答案时间与在线 token 消耗

## 1. 背景

当前 QA benchmark 主要输出索引、检索、答案生成、单题端到端和 LLM 网络延迟。这些字段适合排查工程瓶颈，但不适合作为对外的时间效率主指标：

- 指标分别从不同阶段和样本集合采集，生成失败可能让已经完成的检索时间退出分位数；
- `retrievalLatency` 在 PaperMind 中已经包含 query rewrite，不能与 rewrite 时间直接相加；
- `answerGenerationLatency` 只能观测完整响应返回，不知道用户何时看到第一个 token；
- cache hit 会把模型调用替换成本地文件读取，严重压低生成与端到端延迟；
- 强基线断点续跑时，旧的端到端时间可能只覆盖恢复后的生成半程；
- 不同 runner 对本地模型加载、索引和生成阶段的边界并不完全一致；
- 旧报表同时暴露均值、P50/P95 和 deprecated 网络别名，主次不清晰。

本设计将速度主指标收敛为一条统一的 query timeline，以用户真实等待为观察面，只保留六个时间分位数和一个在线 token 均值。

## 2. 目标与非目标

### 2.1 目标

1. 用同一个 query 起点定义 Evidence Ready、TTFT 和 Full Answer 三个时间。
2. 使用真实流式响应测量第一个用户可见答案文本，而不是用完整响应时间估算 TTFT。
3. 让三组时间和 token 消耗使用完全相同的 completed-query 分母。
4. 用一个在线总 token 指标表达成功回答的平均模型消耗。
5. 禁止缓存、样本集合、模型配置或执行环境差异产生误导性的速度 delta。
6. 保留现有阶段耗时作为诊断数据，但不再把它们当作速度主指标。
7. 保持 PageIndex、traditional RAG、hybrid rerank、long-section RAG 和 semantic tree 的检索算法不变。

### 2.2 非目标

- 不在主表增加 TTFT 之外的流式细分，如首字节时间、首 reasoning token 时间或每 chunk 间隔。
- 不在主表拆分 prompt token、completion token、rewrite token 或 retrieval token。
- 不在本阶段增加 tokens/s、prefill tokens/s、decode tokens/s、QPS 或并发吞吐指标。
- 不把索引、建树或 benchmark judge 的 token 混入在线 query token。
- 不删除旧 timing 字段，也不改变现有质量指标的定义。
- 不让 full-context 参与检索方法的速度排名。

## 3. 七个速度主指标

速度主表只有七个数：

| Evidence Ready | TTFT | Full Answer | Online Tokens |
|---|---|---|---|
| P50 / P95 | P50 / P95 | P50 / P95 | Mean |

结果字段为：

```ts
interface SpeedMetrics {
  evidenceReadyLatencyP50Ms: number
  evidenceReadyLatencyP95Ms: number
  timeToFirstTokenP50Ms: number
  timeToFirstTokenP95Ms: number
  fullAnswerLatencyP50Ms: number
  fullAnswerLatencyP95Ms: number
  avgOnlineTokensPerCompletedAnswer: number
}
```

P50/P95 沿用当前 benchmark 的最近秩算法。时间越低越好；平均在线 token 越低表示完成一次回答所需的模型资源越少。

## 4. 统一 Query Timeline

### 4.1 四个时间点

每道题只创建一条 timeline，使用同一个可注入单调时钟：

```text
t0  runner 接收到 query，开始在线处理
t1  最终 evidence context 完成 materialization
t2  最终回答流中第一个非空、用户可见文本到达
t3  最终回答流正常结束，完整答案可用
```

三个时间定义为：

```text
Evidence Ready = t1 - t0
TTFT           = t2 - t0
Full Answer    = t3 - t0
```

内部计时器保留时间点，结果只落盘相对时长：

```ts
interface QuerySpeedRecord {
  evidenceReadyLatencyMs: number
  timeToFirstTokenMs: number
  fullAnswerLatencyMs: number
  onlineTokenCount?: number
  tokenAccountingComplete: boolean
}
```

### 4.2 时间不变量

完整成功记录必须满足：

```text
0 <= evidenceReadyLatencyMs
evidenceReadyLatencyMs <= timeToFirstTokenMs
timeToFirstTokenMs <= fullAnswerLatencyMs
```

字段缺失、非有限、负数或顺序颠倒属于 benchmark 口径错误，必须使本轮失败，不能用 `Math.max` 钳制、交换字段或补零掩盖问题。

### 4.3 Evidence Ready 的含义

Evidence Ready 表示生成模型已经可以消费最终上下文，而不是“首次命中 gold evidence”：

- 包含 query rewrite；
- 包含召回、打分、融合和重排；
- 包含候选选择；
- 包含公共 context materializer 的最终 token 截断和文本构造；
- 不依赖 gold evidence 标注；
- 即使最终 context 为空，只要检索流程正常结束，也可以形成 `t1`；质量由 Context Page MRR 等指标另行表达。

论文索引、embedding 索引和 semantic tree 必须在 `t0` 之前准备完成，不能进入 Evidence Ready。

### 4.4 TTFT 的含义

TTFT 只认最终 answer channel 中第一个非空、用户可见的文本 delta：

- HTTP headers、SSE 建连、role metadata、finish reason 和 usage-only chunk 不计；
- 空字符串或纯协议事件不计；
- 隐藏 reasoning token 不计；
- 第一个可见文本只记录一次；
- 必须来自真实 streaming API，禁止以完整响应时间、平均 token 时间或 mock 比例估算。

### 4.5 Full Answer 的含义

Full Answer 在最终可见回答流正常结束、完整答案可以交给现有答案评分逻辑时形成。它包含 retrieval、等待首 token 和后续流式生成，也包含已配置的 retry/backoff 用户等待；它不包含 judge。

## 5. 速度样本集合

### 5.1 主表分母

七个主指标使用同一批 query IDs。一个 query 只有同时满足以下条件才进入速度主表：

- 最终 evidence context 已就绪；
- 已收到第一个用户可见答案文本；
- 流正常结束并得到完整非空答案；
- 三个时长通过 timeline 不变量校验。

结果记录：

```ts
meta: {
  speedMetricSchemaVersion: 1
  speedDefinition: 'query-timeline-v1'
  completedSpeedQuestionIdsHash: string
  completedSpeedQuestionCount: number
}
```

六个时间分位数都从这个 completed speed 集合计算。token 均值只有在同一集合的每道题都完成 token accounting 时才产生。

### 5.2 失败与部分记录

失败仍保留已经形成的阶段数据用于诊断：

- retrieval 失败：只有 `t0`，没有速度主表观测；
- evidence ready 后生成失败：保留 Evidence Ready，但不进入主表；
- 收到首 token 后流中断：保留 Evidence Ready 和 TTFT，但不进入主表；
- 完整流成功：保留全部字段并进入主表。

报告继续展示 retrieval、generation、stream 和 judge 的失败数量。速度主表不以失败题补 timeout 常数，也不静默把困难题从横向比较中抹掉：跨方法 completed speed ID 集合不同会触发比较门禁。

## 6. 在线 Token 指标

### 6.1 定义

每道完整回答的在线总 token 为：

```text
Online Total Tokens
= t0 到 t3 之间所有在线 LLM 调用的 input tokens + output tokens
```

包括：

- query rewrite；
- PaperMind/semantic-tree 的在线 LLM 检索打分或路由；
- 最终回答生成。

不包括：

- `t0` 之前的 PageIndex 构建；
- embedding 索引或 semantic tree 构建；
- `t3` 之后的 Answer F1 和 judge；
- evidence context token 的额外重复计数，因为它已经属于 generation input tokens。

主表展示：

```text
avgOnlineTokensPerCompletedAnswer
= sum(onlineTokenCount) / completedSpeedQuestionCount
```

使用均值而非中位数，因为 token 是可加的资源成本；长请求造成的真实消耗不应被中位数隐藏。原始整轮总数不进主表，因为它与运行题数直接相关。

### 6.2 真实 Usage 优先

token 数只接受 provider 返回的 usage：

- OpenAI-compatible 非流式响应读取 `usage.prompt_tokens` 与 `usage.completion_tokens`；
- OpenAI-compatible 流式响应请求 `stream_options.include_usage`，读取结束 usage；
- Ollama 读取 `prompt_eval_count` 与 `eval_count`；
- 不使用字符数除以常数、BGE tokenizer 或其它模型 tokenizer 猜测回答模型 token。

如果完成 query 的任一在线 LLM 调用缺失 usage，则该题设置 `tokenAccountingComplete: false`。时间指标仍然有效，但只要 token 完整题 ID 集合与 completed speed ID 集合不完全相同，`avgOnlineTokensPerCompletedAnswer` 就不产生，报表显示 `—` 和缺失原因，禁止偷偷换分母。

retry/backoff 进入真实时间；每个能返回 usage 的尝试都累加。如果失败尝试无法提供 usage，则该 query 的 token accounting 不完整。

## 7. 缓存、并发与计时环境

### 7.1 缓存

时间效率模式的在线路径强制关闭 LLM 响应缓存：

```text
llmCacheEnabled = false
```

如果 CLI 或调用方尝试在 speed mode 开启响应缓存，应直接拒绝运行，而不是在结果中混入 cache hit。质量 benchmark 仍可使用现有缓存，与时间效率模式分开运行。

### 7.2 并发

第一版冻结：

```text
queryConcurrency = 1
```

并发吞吐不是本设计目标。串行执行避免多个 query 争抢本地 CPU/GPU 或共享 endpoint 配额后，把排队噪声误认为方法本身延迟。

### 7.3 时钟

query timeline 使用单调时钟，例如 Node `performance.now()`，测试通过依赖注入提供脚本化时钟。ISO 时间戳和运行区间继续使用 wall clock，但不得参与三个主时长的减法。

### 7.4 初始化边界

tokenizer、embedding model、reranker、索引和 semantic tree 必须在 `t0` 前就绪。模型加载和建索引成本可以继续进入详细诊断或整轮 wall-clock，但不进入七个在线主指标。

## 8. 流式 LLM 接口

### 8.1 Benchmark Client

保留现有非流式接口，增加流式与 token telemetry：

```ts
interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

interface StreamCompletion {
  content: string
  usage?: TokenUsage
}

interface LlmClient {
  complete(prompt: string): Promise<string>
  chat(messages: ChatMessage[]): Promise<string>
  chatStream(
    messages: ChatMessage[],
    onVisibleText: (delta: string) => void,
  ): Promise<StreamCompletion>
  tokenSnapshot(): {
    totalTokens: number
    incompleteRequestCount: number
  }
}
```

`tokenSnapshot` 是累计 telemetry 的不可变快照。runner 在 `t0` 前与 `t3` 后取差值，因第一版 query 串行，token 差值可以无歧义地覆盖 rewrite、retrieval/routing 与 final generation，同时自然排除索引和 judge。只有 `incompleteRequestCount` 的差值为 0 时，该 query 的 token accounting 才完整；索引阶段早先出现过缺失 usage 不会污染后续 query 的完整性判断。

### 8.2 OpenAI-Compatible SSE

请求使用 `stream: true` 和 `stream_options: { include_usage: true }`。解析器必须：

- 正确处理一个 SSE event 被任意网络 chunk 切开的情况；
- 正确处理一个网络 chunk 含多个 event；
- 忽略 `[DONE]`、空 data、role、finish reason 和 usage-only event 的 TTFT 触发；
- 只把 `choices[].delta.content` 中的非空可见文本交给回调；
- 拼接 delta 得到最终完整 answer；
- 读取最终 usage。

当前 `anthropic` provider 使用的仍是 OpenAI-compatible `/chat/completions` 形状，只是认证 header 不同，因此复用同一个 SSE parser。

### 8.3 Ollama NDJSON

请求使用 `stream: true`。解析器按行处理 NDJSON：

- `message.content` 的非空文本触发可见文本回调；
- `done: true` 结束流；
- 从结束记录读取 `prompt_eval_count` 和 `eval_count`；
- 支持一行跨多个网络 chunk 以及一个 chunk 含多行。

## 9. Runner 数据流

统一在线流程为：

```text
准备索引与本地模型
→ 读取 token snapshot
→ t0: startQueryTimeline()
→ query rewrite / retrieve / rerank
→ materialize final context
→ t1: markEvidenceReady()
→ 构造最终生成 messages
→ chatStream()
→ t2: first non-empty visible delta
→ 拼接完整 answer
→ t3: complete()
→ 读取 token snapshot 差值
→ 写 per-sample speed record
→ answer scoring / judge
```

PageIndex、traditional、hybrid、long-section 和 semantic-tree runner 只负责得到最终 materialized context。`QueryTimeline`、最终消息构造、streaming generation、usage 差值和不变量校验必须使用共享实现，不能在每个 runner 中复制。

生产侧抽出共享的 `buildAnswerMessages(...)`。现有非流式 `generateRagAnswer` 继续存在，新的 benchmark 流式生成路径复用同一消息构造函数，避免 benchmark 和产品 prompt 漂移。

## 10. 结果契约

### 10.1 Per-Sample

```ts
interface PerSampleRecord {
  // existing fields...
  speed?: {
    evidenceReadyLatencyMs?: number
    timeToFirstTokenMs?: number
    fullAnswerLatencyMs?: number
    onlineTokenCount?: number
    tokenAccountingComplete: boolean
  }
}
```

部分字段缺失必须与阶段状态一致。完整成功记录缺任一时间字段或不满足单调约束时，整轮失败。

### 10.2 Meta

新结果至少记录：

```ts
meta: {
  speedMetricSchemaVersion: 1
  speedDefinition: 'query-timeline-v1'
  completedSpeedQuestionIdsHash: string
  completedSpeedQuestionCount: number
  streaming: true
  llmCacheEnabled: false
  queryConcurrency: 1
  retryAttempts: number
  answerModelIdentity: string
  answerFramingIdentityHash: string
  endpointIdentity: string
  generationSettingsHash: string
  executionEnvironmentFingerprint: string
}
```

endpoint identity 不含 API key。执行环境指纹至少覆盖平台、CPU 架构、Node 版本以及本地推理所用 device/backend；不得包含用户名、绝对路径或其它个人信息。

### 10.3 Metrics

主指标写入 `metrics` 的七个字段，同时记录必要的自证计数：

```ts
metrics: {
  evidenceReadyLatencyP50Ms: number
  evidenceReadyLatencyP95Ms: number
  timeToFirstTokenP50Ms: number
  timeToFirstTokenP95Ms: number
  fullAnswerLatencyP50Ms: number
  fullAnswerLatencyP95Ms: number
  avgOnlineTokensPerCompletedAnswer?: number
  speedSampleCount: number
  onlineTokenSampleCount: number
}
```

计数用于门禁和诊断，不计入“七个速度主指标”。

## 11. 横向比较门禁

只有以下条件全部一致时，比较器才允许输出速度 delta：

1. dataset fingerprint 与 executed question IDs；
2. `completedSpeedQuestionIdsHash`；
3. `speedMetricSchemaVersion` 与 `speedDefinition`；
4. answer model、provider、endpoint identity 与最终回答固定 framing identity；
5. temperature、max output tokens、stop 等 generation settings；
6. retry 配置；
7. `streaming: true` 与 `llmCacheEnabled: false`；
8. `queryConcurrency: 1`；
9. execution environment fingerprint。

`answerFramingIdentityHash` 必须覆盖传给 `buildAnswerMessages` 的生效 base system prompt、
样本语言指令、数学格式指令和固定 message/context framing；结果只保存 SHA-256，不落盘 prompt 明文或凭据。

Git SHA 不要求一致，否则无法比较不同实现版本。每个结果还必须满足：

```text
speedSampleCount === completedSpeedQuestionCount
```

token delta 另需：

```text
onlineTokenSampleCount === completedSpeedQuestionCount
```

条件不满足时仍可展示各自原始值，但不计算差值，并列出具体不可比较原因。

## 12. 报告

速度主表固定为：

| 方法 | Evidence Ready P50 | P95 | TTFT P50 | P95 | Full Answer P50 | P95 | Avg Online Tokens |
|---|---:|---:|---:|---:|---:|---:|---:|

主表之外保留：

- completed speed count；
- retrieval/generation/stream/judge failure 数量；
- index、tree build、旧 retrieval/generation/network latency 诊断；
- 整轮 wall-clock；
- 旧 `latencyP50/P95` 的 legacy 标签。

full-context 继续放在独立的生成上限区域：

- 展示 TTFT、Full Answer 和 Avg Online Tokens；
- Evidence Ready 显示 `—`；
- 不进入检索方法速度排名或速度 delta。

旧结果缺少 `speedDefinition: 'query-timeline-v1'` 时仍可读取，但只能进入 legacy/诊断区域，不能与新速度指标混算。

## 13. 测试策略

### 13.1 Query Timeline

- 正常的 `t0 <= t1 <= t2 <= t3`；
- 相等时间点合法；
- 缺字段、负数、NaN、Infinity 和逆序使整轮失败；
- first visible token 只记录一次；
- 空 context 正常形成 Evidence Ready；
- judge 时间不进入 Full Answer。

### 13.2 Streaming Parser

- OpenAI SSE event 被逐字节、逐行和随机边界拆包；
- 一个网络 chunk 包含多个 SSE event；
- metadata、空 delta、reasoning、finish reason、usage-only chunk 不触发 TTFT；
- `[DONE]` 正常结束；
- Ollama NDJSON 跨 chunk 和多行 chunk；
- 首 token 后断流保留部分 timeline，但不进入主表；
- 流结束得到的拼接文本与现有完整回答评分输入逐字一致。

### 13.3 Token Accounting

- rewrite、检索打分和生成 usage 全部累加；
- 本地检索不凭空产生 LLM token；
- 索引、建树和 judge usage 不进入在线总数；
- OpenAI 与 Ollama usage 字段映射正确；
- 任一调用缺 usage 时 token accounting 不完整；
- token 样本集合不完整时主表为 `—`，不能换分母；
- retry 的可用 usage 累加，缺失 usage 使该题不完整。

### 13.4 Runner 契约

- 五种检索方法都在最终 context materialization 后标记 Evidence Ready；
- 三种时间和 token 来自同一 completed-query 集合；
- retrieval、generation 和 mid-stream failure 的部分字段符合阶段状态；
- speed mode 强制 cache off、streaming on、concurrency 1；
- 索引和本地模型在 `t0` 前完成。

### 13.5 比较器与报告

- 身份与 completed ID 集合一致时允许速度比较；
- completed ID 集合即使数量相同但内容不同也拒绝；
- 模型、endpoint、generation settings、retry、并发或环境不同均拒绝；
- token accounting 不完整只抑制 token delta，不伪造数字；
- 主表严格展示六个时间数和一个 token 数；
- full-context 不进入检索速度排名；
- legacy timing 仍可读取但不与新指标混算。

## 14. 验收标准

1. 每个进入速度主表时间分位数的 query 都有同源的 Evidence Ready、TTFT 和 Full Answer；只有同一集合的在线 token 记录全部完整时才展示 token 均值。
2. 三个时间由同一个单调 query timeline 产生并满足顺序不变量。
3. TTFT 来自真实流式的第一个用户可见答案文本。
4. 在线路径 cache 明确关闭，query concurrency 固定为 1。
5. 六个时间分位数使用同一批 completed query IDs；token 均值产生时必须使用完全相同的 ID 集合。
6. Online Tokens 包含 query 期间全部在线 LLM 调用，但不包含索引、建树和 judge。
7. usage 不完整时不输出 token 均值。
8. 任一比较身份或 completed ID 集合不一致时，报告拒绝速度 delta。
9. full-context 保持独立生成上限，不进入检索方法速度排名。
10. 旧 timing 数据保留为诊断信息，已有结果仍可读取。
