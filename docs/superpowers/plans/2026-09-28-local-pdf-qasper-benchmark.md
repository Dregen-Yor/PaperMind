# Local PDF QASPER Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将本分支 benchmark 替换为基于本地真实 PDF 的 QASPER dev 评测，仅输出官方 AnswerF1、EvidenceF1，以及热查询 retrieval latency / TTFT 的 P50、P95。

**Architecture:** 复用产品的 PDF 解析和 A/B/C passage 检索，重建 prepare → run → report 评测链。离线准备隔离检索语料、证据对齐和 gold；查询阶段保存精确来源轨迹，评分阶段直接调用固定版本的官方 Python evaluator。新链路打通后删除旧 benchmark 专用入口和计算，不保留两套公开评测系统。

**Tech Stack:** TypeScript、Node.js（沿用 package.json engines）、Vitest、pdfjs-dist、现有 transformers.js embedding/tokenizer；Python 3 标准库执行官方 evaluator，不新增 Python 第三方依赖。

**Spec:** [2026-09-28-local-pdf-qasper-benchmark-design.md](../specs/2026-09-28-local-pdf-qasper-benchmark-design.md)。用户已要求据此编写实施计划；本计划待审阅、待选择执行方式，未授权在写计划时发起全量模型请求。

## Global Constraints

- dev 的 280 篇 PDF / 1,002 题作为正式集合；train 不混入正式结果。
- 正式集合名称为“local-PDF QASPER dev subset”；缺失 `1802.00396.pdf` 的 3 题在冻结前列入排除清单，之后不能动态增删集合。
- 输入文本必须来自实际 PDF 解析，不得用 QASPER JSON 全文替代 PDF 检索语料。
- 质量指标只有 AnswerF1 和 EvidenceF1，均对齐官方 QASPER evaluator；EvidenceF1 采用默认口径，保留图表证据。
- A/B/C 保持现有 120/350 token 切段设置、4096 token 上下文预算，以及现有融合参数：rrfK=60、sectionWeight=0.5、neighbourFactor=0.5、skipLimit=20。
- tokenizer 为 `BAAI/bge-m3`；B/C embedding 为 `Xenova/bge-small-en-v1.5`、q8、384 维。记录实际文件 hash，不能只记录 main。
- C 目录缺失/非法时回落 B；B/C 稠密依赖失败不能伪装为成功 BM25。A/B/C 索引不调用生成式 LLM。
- 索引已就绪后计时；正式查询串行，concurrency=1。禁用客户端 query embedding、检索结果和回答缓存。
- R 的 EvidenceF1 与两个 retrieval latency 单元格为 null / `—`；全文不能被静默截断。
- 内部值为 0–1；报表也统一展示 0–1，保留四位小数，不混用百分制。延迟单位 ms。
- metrics 仅六键：answerF1、evidenceF1、retrievalLatencyP50Ms、retrievalLatencyP95Ms、ttftP50Ms、ttftP95Ms。
- 质量分母固定；速度使用四组共同完整成功的题目集合，单臂结果明确标为未配对。
- 保留历史结果、PDF、数据集、模型缓存；不提交凭据、真实论文文本或完整真实预测。不改 UI、数据库接口和生产默认行为。
- 两空格、单引号、无分号；每个任务独立测试和提交；最终运行 npm test 与 npm run typecheck。当前 tsconfig.json 已 include bench/**/*。

## Review Focus

1. PDF/S2ORC 中 Unicode 合字、组合字符、跨页断词：规范化能追踪原始位置，不能把删除字符当作已检索证据。由 Task 3/4 测试覆盖。
2. 同页重复段落、不同 canonical 单元归一化碰撞：不能凭首次字符串命中选位置或虚增匹配。由 Task 3/5 测试覆盖。
3. 模型先输出空白/reasoning，或流中途失败：不提前触发 TTFT，不把半截回答当成功。由 Task 7 测试覆盖。
4. 一个方法缺题、重复 question ID、R 超输入限制：质量分母不变，速度共同集合正确，不能按数组下标错配。由 Task 1/8 测试覆盖。
5. 中断写盘、已有目录/符号链接目标、含空格路径及错误中的凭据：不覆盖旧结果，不拼接速度，不泄露 key。由 Task 9/10 测试覆盖。

---

## File Structure 与依赖边界

| 文件 | 职责 |
|---|---|
| `bench/src/localPdf/types.ts`, `contract.ts` | 新 manifest、记录、六指标及身份校验；最终唯一评测协议 |
| `bench/src/localPdf/dataset.ts`, `prepare.ts` | 官方原始数据读取、PDF 匹配、冻结集合与分离的准备产物 |
| `bench/src/localPdf/normalize.ts`, `alignment.ts` | 不接收 qas 的全文证据对齐 |
| `src/utils/sourceTrace.ts` | 共享的纯原文区间/文本映射类型与切片操作，无 QASPER 依赖 |
| `src/utils/passages.ts`, `contextTrace.ts` | 兼容增加来源信息，保持既有产品文本/切段行为 |
| `bench/src/localPdf/context.ts`, `evidence.ts` | 精确预算上下文、实际来源范围 → 预测证据 |
| `bench/vendor/qasper/` | 固定上游 evaluator.py、许可证、来源 commit/hash 元数据 |
| `bench/src/localPdf/score.py`, `scoring.ts` | Python 官方评分桥、Node 调用与结果校验 |
| `bench/src/localPdf/methods.ts`, `runtime.ts`, `tokenizer.ts` | A/B/C 索引/检索适配、模型初始化、实际文件身份 |
| `bench/src/localPdf/query.ts`, `timing.ts` | 热查询状态机、流式首 token、分位数与共同集合 |
| `bench/src/localPdf/artifacts.ts`, `run.ts`, `report.ts` | 逐题写盘、四组执行、离线六列表 |
| `bench/src/args.ts`, `cli.ts` | 替换为 prepare/run/report 命令，装配依赖 |
| `bench/src/llmClient.ts`, `streaming/*`, `hub.ts`, `paths.ts` | 保留网络/流解析等通用能力，解除对旧结果类型的依赖 |
| `bench/src/tests/localPdf*.test.ts`, `localPdfFixtures.ts` | 新协议测试；只使用人工 fixture / 临时合成 PDF |
| `bench/README.md`, `package.json`, `.gitignore` | 新用法、脚本清理和本地产物忽略规则 |

依赖顺序：1 → 2/3 → 4 → 5 → 6 → 7 → 8 → 9 → 10。Task 2 和 3 可独立评审；不默认并行修改共享文件。新增 localPdf 模块是迁移中的实现边界，不是长期第二个 benchmark；Task 10 将其接成唯一公开入口并移除旧链路。

## Task 1: 固定 manifest 与六指标结果协议

**Files:** Create `bench/src/localPdf/types.ts`, `bench/src/localPdf/contract.ts`, `src/utils/sourceTrace.ts`, `bench/src/tests/localPdfContract.test.ts`, `bench/src/tests/localPdfFixtures.ts`.

**Interfaces:** 在 types.ts 定义并由后续任务共用：

```ts
type Method = 'A' | 'B' | 'C' | 'R'
type Split = 'train' | 'dev'
type RunStatus = 'running' | 'completed' | 'incomplete' | 'failed'
interface FileIdentity { path: string; sha256: string }
interface FrozenQuestion { id: string; paperId: string; question: string }
interface FrozenPaper {
  id: string; pdf: FileIdentity; questionIds: string[]
  prepared: FileIdentity
  parseStatus: 'completed' | 'failed'; parseError?: string
}
interface Manifest {
  schema: 'local-pdf-qasper-v1'; split: Split; subset: boolean
  dataset: FileIdentity; gold: FileIdentity; papers: FrozenPaper[]; questions: FrozenQuestion[]
  excluded: { paperId: string; questionIds: string[]; reason: string }[]
  parserVersion: string; alignmentVersion: string; fingerprint: string
}
interface SixMetrics {
  answerF1: number; evidenceF1: number | null
  retrievalLatencyP50Ms: number | null; retrievalLatencyP95Ms: number | null
  ttftP50Ms: number | null; ttftP95Ms: number | null
}
interface QueryRecord {
  method: Method; questionId: string; paperId: string
  retrievalStatus: 'completed' | 'failed' | 'not-applicable'
  generationStatus: 'completed' | 'failed' | 'skipped'
  answer: string; partialAnswer?: string
  evidence: string[] | null; context: string; trace: ContextTrace[]
  t0: number | null; tContextReady: number | null; tFirstAnswerToken: number | null
  error?: { stage: 'parse' | 'index' | 'retrieve' | 'generate'; message: string }
}
```

本任务先在 sourceTrace.ts 声明 `SourceRange = { page:number; start:number; end:number }` 和 `ContextTrace = { passageId:string; contextStart:number; contextEnd:number; source:SourceRange|null }`，供 QueryRecord 引用；Task 4 增加操作实现。`RunIdentity` 除 modelFiles:FileIdentity[] 外，其 manifestFingerprint、gitSha、evaluatorSha256、configSha256、generationSha256、endpointSha256、environmentSha256 字段均为 string；raw API key 不进入 identity。`RunHeader` 包含 schema:'local-pdf-qasper-v1'、runId:string、identity:RunIdentity、methods:Method[]、expectedQuestionIds:string[]、status:RunStatus。`MethodResult` 包含 method:Method、metrics:SixMetrics、qualityQuestionIds:string[]、speedQuestionIds:string[]、paired:boolean。`RunSummary` 包含 header:RunHeader、results:MethodResult[]。

- [ ] **Step 1: 写失败测试。** `rejectsDuplicateQuestionIds` 断言 `expect(() => validateManifest(duplicateIdFixture)).toThrow(/duplicate/i)`；`sixKeysOnly` 断言 Object.keys 精确等于六键，旧 `answerF1AllQuestions` 被拒；`rejectsOldSchema` 断言旧 BenchResult 被拒；`rejectsInvalidNumber` 覆盖 NaN、负时延、F1>1、R 非 null evidence。fixture 本任务在 localPdfFixtures.ts 构造，禁止复制真实样本。
- [ ] **Step 2: 跑红灯。** `npx vitest run bench/src/tests/localPdfContract.test.ts`，预期因新模块/导出缺失失败。
- [ ] **Step 3: 实现协议。** `validateManifest(value: unknown): Manifest`、`validateRunSummary(value: unknown): RunSummary`、`validateQueryRecord(value: unknown): QueryRecord`、`hashCanonical(value: unknown): string`。检查重复 ID、论文/问题归属、null 的合法位置和严格 schema，不用不受约束的 Record 存 metrics。canonical hash 对对象键递归排序、保留数组顺序、使用 SHA-256。
- [ ] **Step 4: 跑绿灯。** 重跑上述测试；fixtures.ts 提供 `manifestFixture(): Manifest`、`recordFixture(method: Method, questionId: string, overrides?: Partial<QueryRecord>): QueryRecord`，所有内容均为人工文本。
- [ ] **Step 5: 提交。** `git add bench/src/localPdf/types.ts bench/src/localPdf/contract.ts bench/src/tests/localPdfContract.test.ts bench/src/tests/localPdfFixtures.ts src/utils/sourceTrace.ts`；`git commit -m "feat(bench): define local PDF evaluation contract"`。

## Task 2: 固定官方 evaluator，建立唯一评分入口

**Files:** Create `bench/vendor/qasper/evaluator.py`, `bench/vendor/qasper/LICENSE`, `bench/vendor/qasper/source.json`, `bench/src/localPdf/score.py`, `bench/src/localPdf/scoring.ts`, `bench/src/tests/localPdfScoring.test.ts`; Modify `bench/src/localPdf/types.ts`.

**Interfaces:** `scoreOfficial(gold: RawQasperDataset, records: QueryRecord[], questionIds: string[], method: Method, python?: string): Promise<QualityScores>`；`QualityScores = { answerF1: number; evidenceF1: number | null; perQuestion: { id: string; answerF1: number; evidenceF1: number | null }[] }`。types.ts 新增以下输入类型，逐标注者保留、不先合并：

```ts
interface RawAnswer {
  unanswerable: boolean; extractive_spans: string[]; free_form_answer: string
  yes_no: boolean | null; evidence: string[]; annotation_id?: string
}
interface RawQasperPaper {
  title: string
  full_text: { section_name: string; paragraphs: string[] }[]
  figures_and_tables: { file: string; caption: string }[]
  qas: { question_id: string; question: string; answers: { answer: RawAnswer }[] }[]
}
type RawQasperDataset = Record<string, RawQasperPaper>
```

仅原始数据加载器和评分器可访问 qas.answers；对齐/检索接口不接收 RawQasperPaper 全对象。

- [ ] **Step 1: 写失败测试。** `officialEdgeCases` 使用这些断言，并增加多标注者“答案最优和证据最优来自不同人”、Yes/No、extractive 优先、图表前缀、Unicode 冠词边界：

```ts
// Python 桥以人工 gold/prediction fixture 调官方函数；断言桥输出逐题值。
expect(duplicateEvidence.evidenceF1).toBeCloseTo(2 / 3) // pred ['p','p'], gold ['p']
expect(emptyEvidence.evidenceF1).toBe(1)              // pred [], gold []
expect(missing).toMatchObject({ answerF1: 0, evidenceF1: 0 })
expect(normalizedEmpty.answerF1).toBe(0)              // answer 'the', reference 'a'
expect(punctuation.answerF1).toBe(1)                  // 'state-of-art' / 'stateofart'
expect(referenceR.evidenceF1).toBeNull()
```

- [ ] **Step 2: 跑红灯。** `npx vitest run bench/src/tests/localPdfScoring.test.ts`，预期缺少评分模块失败。
- [ ] **Step 3: 固定上游源码。** 从 allenai/qasper-led-baseline 的具体 commit 取得 scripts/evaluator.py 和许可证；source.json 写真实 commit、原始 URL、SHA-256、许可证来源。不得手改 evaluator.py；无法确认许可证/固定源码时停止本任务并报告，不能用近似 TS 公式冒充完成。
- [ ] **Step 4: 实现 Python 桥和 Node 包装。** Python import 固定脚本，调用 `get_answers_and_evidence(data, False)` 和 `evaluate`；逐题用单题 gold 调同一 evaluate。Node 用 spawn 参数数组及 stdin JSON，默认 BENCH_PYTHON 或 python3，不走 shell；每臂一次评分而非每题启动 Python。缺失预测不导出，检索成功生成失败导出 answer='' 和真实 evidence。R 只投影官方 Answer F1，丢弃内部 evidence 输出。校验 Python 版本≥3、脚本 hash、完整 question ID 集及输出有限值；无 Python 时给出明确依赖错误。
- [ ] **Step 5: 跑绿灯。** 重跑测试；再以同一 fixture 直接运行原始 evaluator CLI，对比两项均值及逐题值。该一致性测试不得依赖网络或实际 dataset 文件，不得静默 skip。
- [ ] **Step 6: 提交。** `git add bench/vendor/qasper bench/src/localPdf/score.py bench/src/localPdf/scoring.ts bench/src/localPdf/types.ts bench/src/tests/localPdfScoring.test.ts`；`git commit -m "feat(bench): score with pinned QASPER evaluator"`。

## Task 3: 从本地 PDF 冻结数据并独立对齐全部原文单元

**Files:** Create `bench/src/localPdf/dataset.ts`, `prepare.ts`, `normalize.ts`, `alignment.ts`; `bench/src/tests/localPdfDataset.test.ts`, `localPdfAlignment.test.ts`; Modify `.gitignore`.

**Interfaces:** `readQasper(path: string): Promise<RawQasperDataset>`；`prepareDataset(opts: { root: string; split: Split; out: string; limitPapers?: number }, deps?: { extract: typeof extractPdfDocument }): Promise<Manifest>`；`alignCanonical(pages: string[], source: Pick<RawQasperPaper, 'full_text' | 'figures_and_tables'>): AlignmentArtifact`。`SourceRange = { page: number; start: number; end: number }`，所有 offset 是 UTF-16、0-based、左闭右开。`CanonicalUnit = { id: string; text: string; kind: 'paragraph' | 'caption'; status: 'matched' | 'unmapped' | 'ambiguous'; ranges: SourceRange[] }`；`AlignmentArtifact = { version: 'canonical-pdf-v1'; units: CanonicalUnit[] }`。

- [ ] **Step 1: 写失败测试。** Dataset 测试固定论文排序、保留官方问题 ID、train/dev 不混入、缺 PDF 排除、解析失败保留问题、hash 改变拒绝、limitPapers 标 subset。Alignment 测试 NFKC 合字/组合字、跨页断词、引用占位符、两处相同正文为 ambiguous、清洗为空为 unmapped、caption 输出 `FLOAT SELECTED: `、修改 qas 不改变对齐输出。代表断言：`expect(ambiguousUnit).toMatchObject({ status: 'ambiguous', ranges: [] })`；`expect(parsedFailureManifest.questions).toHaveLength(2)`（人工论文有两题且解析抛错）。
- [ ] **Step 2: 跑红灯。** `npx vitest run bench/src/tests/localPdfDataset.test.ts bench/src/tests/localPdfAlignment.test.ts`，预期模块缺失。
- [ ] **Step 3: 实现定位规范化。** `normalizeWithOrigins(pages: string[]): { text: string; origins: SourceRange[][] }`。按 spec 顺序 NFKC → 行末断词 → 独立占位符替换 → lowercase → 空白压缩/trim，使用 grapheme cluster 进行 NFKC 并携带其全部原始范围，避免逐码点丢失组合字符来源。合成跨页空白无原文位置；被移除的引用占位符不算覆盖。枚举完整匹配所有位置，唯一匹配才给 ranges；完整匹配不能以 60 字符前缀替代。不同 canonical ID 若原始字符串相同保留 ID，导出时再去重；原始字符串不同但规范化字符串相同的单元标 ambiguous。
- [ ] **Step 4: 实现 prepare 与身份验证。** 先按原始 JSON 和存在的 PDF 冻结题集，再解析，失败保留。manifest 的旁目录 `<out>.assets/` 独占创建，分别写每篇 `corpus.json`（PDF pages/outline）、`alignment.json`、独立 gold.json；FrozenPaper.prepared 身份指向 paper.json，其结构固定为 `{ corpus:FileIdentity|null, alignment:FileIdentity|null, parseError?:string }`，解析失败时两项 null。gold.json 路径固定为 assets 根目录，其 bytes hash 通过 manifest 新增 `gold:FileIdentity` 冻结。run 的检索依赖只加载 corpus；gold 只进评分器。out 与 assets 任何已有对象均拒绝覆盖，失败清理仅本次创建的临时文件。`.gitignore` 加 `bench/prepared/`；对外路径可配置但不更改 dataset。
- [ ] **Step 5: 跑绿灯。** 重跑两套测试。真实只读核对 dev manifest 候选为 280/1002、排除 1802.00396 的 3 题；此断言写为人工预检命令，不让 hermetic 单测依赖本机完整数据。默认不下载缺失 PDF。
- [ ] **Step 6: 提交。** `git add bench/src/localPdf bench/src/tests/localPdfDataset.test.ts bench/src/tests/localPdfAlignment.test.ts .gitignore`；`git commit -m "feat(bench): freeze PDF corpus and canonical alignment"`。

## Task 4: 来源轨迹贯穿切段与最终预算上下文

**Files:** Modify `src/utils/sourceTrace.ts`, `src/utils/passages.ts`, `src/utils/contextTrace.ts`; Create `bench/src/localPdf/context.ts`, `bench/src/tests/localPdfTrace.test.ts`; regression tests `src/tests/passages.test.ts`, `src/tests/passageIndex.test.ts`, `src/tests/contextTrace.test.ts`.

**Interfaces:** 在 sourceTrace.ts 定义 `SourceRun = { textStart: number; textEnd: number; source: SourceRange | null }`、`ContextTrace = { passageId: string; contextStart: number; contextEnd: number; source: SourceRange | null }`。ContextPiece 兼容新增 `passageId?: string; sourceRuns?: SourceRun[]`。`materializeTracedContext(passages: Passage[], selectedIds: string[], pages: string[], countTokens: (text: string) => number, maxTokens: number): { text: string; trace: ContextTrace[]; tokenCount: number }`。

- [ ] **Step 1: 写失败测试。** `samePageDuplicateUsesOriginalOffset` 用 `'Repeat.\n\nRepeat.'` 只选第二段（测试 minTokens=1，防止合并），断言 `expect(secondTrace.source?.start).toBe(9)`；`splitMergePreservesOrigins` 验证合并/句切后范围；`budgetExcludesTail` 断言未输出尾部无 trace；`traceReconstructsText` 逐段重建文本；`unicodeBoundary` 不切断 surrogate/grapheme。
- [ ] **Step 2: 跑红灯。** `npx vitest run bench/src/tests/localPdfTrace.test.ts`，预期新轨迹缺失。
- [ ] **Step 3: 在切段起点记录来源。** collectParagraphs 逐行扫描时记录真实 offset，trim/句子分割/合并同步变换 SourceRun；人工插入的空白 source=null，原文字符永远指向实际页内范围。atomsToPieces 同步合并 runs；buildPassages 分配 ID 后写到 pieces。不可在产物上用 indexOf 回填位置。文本、searchText、顺序和 token 数应与既有切段一致；共享 materializeContext 默认行为不改。
- [ ] **Step 4: 实现 benchmark 专用精确物化。** 沿既有检索选择顺序及连续 passage 分组，用真实原文/合成分隔符拼接；直接对最终候选字符串计 token，不能 tokenize 后把 token 名拼回正文。超预算时选不破坏 Unicode 字符边界且重新计数验证≤maxTokens 的保守前缀，再裁 SourceRun；不假定 BPE 前缀计数严格单调，不要求填满预算。外层 trim 同步调整 context offsets。本函数不加载 canonical/gold。
- [ ] **Step 5: 跑绿灯与产品回归。** `npx vitest run bench/src/tests/localPdfTrace.test.ts src/tests/passages.test.ts src/tests/passageIndex.test.ts src/tests/contextTrace.test.ts`。验证未传新增字段的旧调用兼容，索引序列化/反序列化旧 fixture 不受破坏；benchmark 不复用无 trace 的旧索引缓存。
- [ ] **Step 6: 提交。** `git add src/utils/sourceTrace.ts src/utils/passages.ts src/utils/contextTrace.ts bench/src/localPdf/context.ts bench/src/tests/localPdfTrace.test.ts`；`git commit -m "feat(bench): trace actual PDF context ranges"`。

## Task 5: 最终上下文导出官方 predicted_evidence

**Files:** Create `bench/src/localPdf/evidence.ts`, `bench/src/tests/localPdfEvidence.test.ts`.

**Interfaces:** `deriveEvidence(paperId: string, pages: string[], context: { text: string; trace: ContextTrace[] }, alignment: AlignmentArtifact): { predicted: string[]; unmatched: { id: string; passageId: string; ranges: SourceRange[]; text: string }[] }`。只消费 Task 3/4 产物，在查询计时结束后调用。

- [ ] **Step 1: 写失败测试。** 完整范围匹配输出原始字符串；两个 chunk 联合覆盖同段只输出一次；只选半段不匹配；同一范围重复出现去重；完整段外多余正文必须多出 unmatched 项；图表输出原始前缀；不匹配项不能等于任何 canonical text；加入/改变 gold 不改变预测。代表断言：`expect(full.predicted).toEqual(['The complete paragraph.'])`；`expect(partial.predicted).not.toContain('The complete paragraph.')`；`expect(extra.unmatched).toHaveLength(1)`。
- [ ] **Step 2: 跑红灯。** `npx vitest run bench/src/tests/localPdfEvidence.test.ts`。
- [ ] **Step 3: 实现完整覆盖与残余差集。** 以页内区间并集合并 coverage，matched canonical 的全部有效 ranges 均覆盖才计入。输出按最终上下文首次贡献位置排序，原始证据字符串去重。减去完整 matched 单元范围后，以每个 passage 的连续实际残余段生成 `UNALIGNED:<paper>:<SHA256(canonical ranges)>`，仅去重同 passage 同 ranges 的重复项；相邻不同 passage 不合并。相同 canonical 字符串的不同来源位置均可解释已覆盖范围，但只输出一次字符串。null 来源仅允许 harness 生成空白/标签，不能用于隐藏 PDF 正文；碰撞直接报契约错误。
- [ ] **Step 4: 跑绿灯和评分集成。** `npx vitest run bench/src/tests/localPdfEvidence.test.ts bench/src/tests/localPdfScoring.test.ts`。增加“1 个正确证据 + 1 个不匹配项、gold 1 个”经真实 Python 得 EvidenceF1=2/3 的测试。
- [ ] **Step 5: 提交。** `git add bench/src/localPdf/evidence.ts bench/src/tests/localPdfEvidence.test.ts`；`git commit -m "feat(bench): derive evidence from final context"`。

## Task 6: A/B/C/R 运行时与公平身份

**Files:** Create `bench/src/localPdf/methods.ts`, `runtime.ts`, `tokenizer.ts`, `bench/src/tests/localPdfMethods.test.ts`; reuse `src/utils/passageIndexBuilder.ts`, `passageRetrieval.ts`, `pdfOutline.ts`, `transformersEmbedder.ts`.

**Interfaces:** `PreparedCorpus = { paperId: string; pages: string[]; outline: PdfOutlineEntry[] }`；`PreparedMethod = { method: Method; retrieve?: (question: string) => Promise<{ text: string; trace: ContextTrace[] }>; fullText?: string; fallbackReason?: string }`。`prepareMethod(method: Method, corpus: PreparedCorpus, deps: MethodDeps): Promise<PreparedMethod>`，MethodDeps 明确为 `{ countTokens: (s:string)=>number; embedder?: Embedder }`。`initializeRuntime(env: Record<string,string|undefined>, methods: Method[]): Promise<{ client: StreamingLlmClient; methodDeps: MethodDeps; identity: RuntimeIdentity }>`；RuntimeIdentity 是 RunIdentity 中除 manifestFingerprint/gitSha/evaluatorSha256 外的字段。

- [ ] **Step 1: 写失败测试。** A 不调 embed；B/C 每题只发一次 query embedding；C 无目录与 B 输出一致且记录原因；B 缺模型初始化拒绝、query embedding 失败不静默 BM25；R 不调用 retrieve 且 fullText 无截断；prepared method 中不存在 gold/qas/alignment；四组相同 PDF 与预算。代表断言：`expect(queryEmbed).toHaveBeenCalledTimes(1)`；`expect(await c.retrieve!('q')).toEqual(await b.retrieve!('q'))`（缺目录 fixture）。
- [ ] **Step 2: 跑红灯。** `npx vitest run bench/src/tests/localPdfMethods.test.ts`。
- [ ] **Step 3: 实现方法适配。** 用 `startPassagePipeline(..., { buildStructure:false, segmentation:{minTokens:120,maxTokens:350}, ... })` 等待 rest 完成；不传旧缓存。沿用现有 passageIndexHook 的 outline 构建/节点向量逻辑到新 methods.ts，保留祖先标题连接 `' > '`，不保留冷启动统计。检索调用 `retrievePassageContext`，依据 hybrid.selectedPassageIds 调 Task 4 物化。检查实际 retrievalMode/向量完整性，B/C dense 失败抛单题检索错误，不改产品降级策略。R 预备全部 pages，不按 maxInputChars 截断。
- [ ] **Step 4: 实现运行时。** 将旧 traditionalRag/embedding.ts 中 tokenizer 加载代码提取到新 tokenizer.ts；不带旧 dense baseline provider。使用 BGE-M3 真实分词计数；B/C createTransformersEmbedder 使用固定参数和实际文件 hash。初始化后用非评测文本预热一次，在 t0 前结束。沿用 resolveQaAnswerOptions 的 maxTokens=4096、temperature=0、timeout=120000ms、retryAttempts=3 及显式 topP/thinking 环境变量；createLlmClient 设置 useCache=false。identity hash 规范化 endpoint 时删除凭据，记录 generation/prompt/backend/模型文件身份；缺真实文件身份时不能开始正式运行。
- [ ] **Step 5: 跑绿灯。** 重跑 methods 测试；用假 embedder/tokenizer 证明没有外网或模型下载。两个独立 runtime 改变 embedding bytes 或生成选项时 identity 必须不同。
- [ ] **Step 6: 提交。** `git add bench/src/localPdf/methods.ts bench/src/localPdf/runtime.ts bench/src/localPdf/tokenizer.ts bench/src/tests/localPdfMethods.test.ts`；`git commit -m "feat(bench): adapt PDF retrieval arms to new harness"`。

## Task 7: 热查询状态机和首个可见回答计时

**Files:** Create `bench/src/localPdf/query.ts`, `bench/src/tests/localPdfQuery.test.ts`; Modify `bench/src/llmClient.ts` only if required for attempt-safe callbacks; retain streaming parser tests.

**Interfaces:** `executeQuery(question: FrozenQuestion, prepared: PreparedMethod, deps: { client: StreamingLlmClient; now: () => number; systemPrompt: string }): Promise<QueryRecord>`。now 在实际运行使用 performance.now；该函数不接受 gold/alignment，不做评分或写盘。

- [ ] **Step 1: 写失败测试。** mock now：t0=100、上下文完成=140、首非空白文本=200，断言 `expect(record.tContextReady! - record.t0!).toBe(40)`、`expect(record.tFirstAnswerToken! - record.t0!).toBe(100)`；前导空白和 reasoning 不触发；检索抛错使生成 skipped；部分输出后失败使 answer=''、partialAnswer 保留、generation failed；R 无 retrieval timestamp；空成功输出不得伪装为完整速度观测。预备模型与评分 mock 均不能落入 t0 区间。
- [ ] **Step 2: 跑红灯。** `npx vitest run bench/src/tests/localPdfQuery.test.ts`。
- [ ] **Step 3: 实现查询。** t0 在任何 query embedding、检索或消息组装之前；tContextReady 在 Task 4 返回后；使用 buildAnswerMessages，所有方法共用英文简洁回答指令以及 `Unanswerable` / `Yes` / `No` 约束。调用 chatStream，`delta.trim().length>0` 才设置首时间戳。收完成功流才标 completed；失败保留实际 trace/evidence 待后处理。R provider 拒绝超输入则失败，不自动裁文本。
- [ ] **Step 4: 固定重试可见性。** 首可见输出之前的可重试错误沿用原 t0 计入等待；一旦发出可见内容后的流失败不透明重试/拼接回答，按失败结束。用注入 fetch 测试确认 llmClient 实际满足规则；若需改动，新增精确 regression 测试，不影响普通成功请求。
- [ ] **Step 5: 跑绿灯。** `npx vitest run bench/src/tests/localPdfQuery.test.ts bench/src/tests/llmClient.test.ts bench/src/tests/openaiSse.test.ts bench/src/tests/ollamaNdjson.test.ts`。两种 provider 流均验证 reasoning/usage 不产生首 token。
- [ ] **Step 6: 提交。** `git add bench/src/localPdf/query.ts bench/src/tests/localPdfQuery.test.ts bench/src/llmClient.ts bench/src/tests/llmClient.test.ts`；`git commit -m "feat(bench): measure hot retrieval latency and TTFT"`。

## Task 8: 固定全题质量与共同成功集合的六指标汇总

**Files:** Create `bench/src/localPdf/timing.ts`, `report.ts`, `bench/src/tests/localPdfReport.test.ts`.

**Interfaces:** `aggregateRun(header: RunHeader, records: QueryRecord[], scores: Map<Method, QualityScores>): RunSummary`；`renderReport(summary: RunSummary): string`；`nearestRank(values: number[], percentile: 50 | 95): number | null`。

- [ ] **Step 1: 写失败测试。** `expect(nearestRank([10,20,30,40], 50)).toBe(20)`、`expect(nearestRank([10,20,30,40], 95)).toBe(40)`、`expect(nearestRank([], 95)).toBeNull()`；A/B/C/R 分别缺不同题时六个时间列采用相同交集；R 失败题仍保留各臂质量分母；单臂 paired=false；空交集保留 F1、延迟=null；重复/未知 ID 抛错；R 三格 `—`；结果 metrics 精确六键。
- [ ] **Step 2: 跑红灯。** `npx vitest run bench/src/tests/localPdfReport.test.ts`。
- [ ] **Step 3: 实现聚合。** 先按 method/questionId 建 map 并检查身份/题集，不按数组下标拼接。完整成功定义为 generation completed、非空可见答案、有限有序 t0/tFirst，A/B/C 还需 retrieval completed 且 t0≤tContextReady≤tFirst。多臂取实际请求所有臂的交集；四臂即 spec 的 A/B/C/R，单臂用自己集合。全部质量由 Task 2 在 expectedQuestionIds 上给出，绝不重用速度 cohort 作质量分母。缺预测按官方零分，不作为 schema 错误。
- [ ] **Step 4: 实现报表。** A/B/C 表和 R 参考表使用 spec 六列，F1 四位小数、ms 两位小数；不适用/无观测用 `—`。表外仅标数据范围、质量题数、速度题数/ID hash、模型身份、运行状态与错误文件路径，不增加 rate/成本/评分列。
- [ ] **Step 5: 跑绿灯。** 重跑 report 测试，验证只对同 identity 的单次 run 聚合；手改 generation/manifest hash 的混合输入拒绝。
- [ ] **Step 6: 提交。** `git add bench/src/localPdf/timing.ts bench/src/localPdf/report.ts bench/src/tests/localPdfReport.test.ts`；`git commit -m "feat(bench): report six metrics on fixed cohorts"`。

## Task 9: 独占产物目录、逐题持久化和离线复算

**Files:** Create `bench/src/localPdf/artifacts.ts`, `run.ts`, `bench/src/tests/localPdfArtifacts.test.ts`, `localPdfRun.test.ts`.

**Interfaces:** `createRun(out: string, header: RunHeader): Promise<RunWriter>`；RunWriter 为 `{ append(record:QueryRecord):Promise<void>; finish(summary:RunSummary):Promise<void> }`。`readRun(out:string):Promise<{header:RunHeader;records:QueryRecord[]}>`；`runBenchmark(manifestPath:string, methods:Method[], out:string, deps: RunDeps):Promise<RunSummary>`；RunDeps 为 `{ runtime: Awaited<ReturnType<typeof initializeRuntime>>; now:()=>number; score:typeof scoreOfficial }`。`reportRun(out:string, python?:string):Promise<RunSummary>` 离线读取独立 gold/预测并重算，不初始化模型。

- [ ] **Step 1: 写失败测试。** `await expect(createRun(existingOut, header)).rejects.toThrow(/exist/i)` 覆盖目录/文件/符号链接；空格路径可用；中断缺题变 incomplete 且固定质量分母；JSONL 尾部截断标损坏、不静默丢题；重复已完成记录拒绝；`expect(savedError).not.toContain('fake-test-api-key')`；report 不调用 runtime/fetch；某题生成失败仍留下 evidence；某论文解析失败为全部问题写记录。
- [ ] **Step 2: 跑红灯。** `npx vitest run bench/src/tests/localPdfArtifacts.test.ts bench/src/tests/localPdfRun.test.ts`。
- [ ] **Step 3: 实现产物。** mkdir 非 recursive 独占最终目录；路径下创建自己的 header.json、records.jsonl、gold.json、summary.json、每臂 scores.json 与官方预测导出。scores.json 保存 QualityScores（包括逐题分数）；这些仅有两项质量分数，不引入其他指标。header 持久化 runId、身份、expected IDs；append 写完整 JSON 行并 flush 后再处理下一题；summary/header 更新用同目录临时文件原子 rename。保存 gold 子集和所有配置身份以供离线复算，不包含凭据。缺完整行区别于缺预测：文件损坏拒绝 report 并明确指示文件，不自动修复用户文件。
- [ ] **Step 4: 实现编排。** manifest 校验全部 hash → 全局依赖初始化/预热 → 每论文准备 A/B/C/R（计时外）→ 各题各方法串行 executeQuery → 计时外 deriveEvidence → 逐题 append → 官方整臂评分 → aggregateRun → finish。采用 question 外层、方法内层固定 A/B/C/R 顺序，记录执行序列。R 与其他方法共享生成设置，prepared method 每论文复用、无查询缓存。
- [ ] **Step 5: 明确退出及重跑。** 全局依赖或全部生成失败保存 failed header 并非零退出；单题失败继续。中断只标当前 run incomplete，重新 run 必须新目录/runId；report 不拼接不同 run。定界参数错误抛给 CLI，不能当作单题模型失败。
- [ ] **Step 6: 跑绿灯并提交。** 重跑两套测试。`git add bench/src/localPdf/artifacts.ts bench/src/localPdf/run.ts bench/src/tests/localPdfArtifacts.test.ts bench/src/tests/localPdfRun.test.ts`；`git commit -m "feat(bench): persist reproducible PDF benchmark runs"`。

## Task 10: 切换唯一 CLI、删除旧评测并完成验收

**Files:** Replace `bench/src/args.ts`, `cli.ts`; Modify `package.json`, `bench/README.md`, `.gitignore`; Create `bench/src/tests/localPdfCli.test.ts`; remove old bench-only files listed below after dependency audit.

**Interfaces:** `parseArgs(argv:string[]): {command:'prepare';root:string;split:Split;out:string;limitPapers?:number} | {command:'run';manifest:string;methods:Method[];out:string} | {command:'report';run:string}`；`main(argv:string[], deps?:CliDeps):Promise<number>`，`CliDeps = { prepare:typeof prepareDataset; run:typeof runBenchmark; report:typeof reportRun; runtime:typeof initializeRuntime; stdout:(s:string)=>void; stderr:(s:string)=>void }`。避免 CLI import 时执行真实请求。

- [ ] **Step 1: 写失败测试。** prepare 必须显式 split/out，run 默认 methods=A,B,C,R 且要求 manifest/out，report 无凭据离线工作；重复方法/未知参数/旧 --task/--judge/--speed/--q-config/--cold-first-query 拒绝，例如 `expect(() => parseArgs(['--judge'])).toThrow()`。临时合成 PDF + 人工 JSON + mock 模型依次调用三个子命令，`expect(Object.keys(result.metrics)).toHaveLength(6)`，另断言 R null、生成失败证据保留、解析失败不掉分母、out 不覆盖。
- [ ] **Step 2: 跑红灯。** `npx vitest run bench/src/tests/localPdfCli.test.ts`，旧 parser 不支持新协议应失败。
- [ ] **Step 3: 切换 CLI。** prepare/run/report 分别调用 Task 3/9 接口；CLI 错误返回非零，脱敏 stderr。将旧 speed/qaOptions.ts 中仍需的环境选项解析移动至 localPdf/generationOptions.ts，明确导出原名 `resolveQaAnswerOptions`；llmClient 的 TokenSnapshot 移为其自身网络类型，不再依赖旧 bench/src/types.ts。
- [ ] **Step 4: 删除旧依赖闭包。** 先用 rg 查实际 import，再删除：bench/src/scoring、旧 metrics、旧 runner（包括 productSweep/passageIndexHook）、datasets、traditionalRag、baselines、toc、jev、treeInspect*、旧 speed 除已迁移代码、旧 types/config/evaluationContract/report。删除对应旧专用测试、旧 configs（包括三个已内置参数的 structure 配置）、旧 bench:trees script；scripts 中依赖被删模块的历史实验启动器移除。保留 llmClient/streaming/hub/paths/logging 和仍覆盖它们的测试；通用算法测试必要部分迁到 src/tests，不能删除生产算法或其测试。历史结果、数据/标注、模型及研究文档不删。
- [ ] **Step 5: 更新文档与产物排除。** README 改为新三命令、Python 3 依赖、唯一六列口径、PDF 对齐限制、R 不适用项、dev/train 使用方式。旧 spec/plans 通过新增目录索引标记 superseded，不逐篇改写历史正文。保留现有 dataset/cache/results 忽略，新增 bench/prepared 忽略。完整真实 run 默认位于 bench/results，文档告知自定义输出需自行保持不提交。
- [ ] **Step 6: 执行完整验证。** `npx vitest run bench/src/tests/localPdf*.test.ts`；`npm test`；`npm run typecheck`；`git diff --check`。用 `rg -n 'answerF1AllQuestions|contextPageMrr|evidenceRecall|judgeFactuality|rouge|qScore|coldFirstQuery|avgOnlineTokens' bench/src --glob '!tests/**'` 检查新运行路径无旧指标；命中历史拒绝测试或注释时逐个解释。确认 `git diff --name-status` 无历史结果/数据删除，git diff 无实际密钥或 PDF 原文。
- [ ] **Step 7: 真实数据本地预检。** `npm run bench -- prepare --split train --dataset-root dataset --limit-papers 3 --out bench/prepared/train-3.json`；仅解析/对齐，不联网答题。查看全部单元对齐审计，并检查 caption 固定前缀；规则冻结后 `prepare --split dev` 核对 280/1002 与缺失项。PDF 失败仍保留题目。已有目标时换新文件名，不覆盖。
- [ ] **Step 8: 提交。** 显式暂存本任务修改/删除的源码、测试、README、package.json、.gitignore 与 superseded 索引，检查 staged diff 后 `git commit -m "refactor(bench): replace legacy benchmark with PDF QASPER flow"`。禁止 git add . 把本地数据或真实预测混入。

## 真实模型运行：执行预算与完成定义

本计划的代码验收是 Task 10 的 hermetic 端到端、全量测试/typecheck 和本地准备；写计划不发真实请求。真实模型评测独立记录，不能用 mock/缓存结果声称正式完成。

- train 冒烟选择冻结的 3 篇论文，其问题数 N 由 prepare 输出确定：A/B/C/R 共 4N 次逻辑回答请求；embedding 为本地模型计算。保持 train 中调试，不根据 dev 成绩调规则。
- 正式 dev 四组共 4 × 1,002 = 4,008 次逻辑回答请求。默认额外重试 3 次，理论最多 16,032 次 HTTP 尝试；解析/检索前失败会减少实际次数。不额外跑冷首问、judge、摘要或 Q。
- 费用取决于实际 provider/model 和论文 token 数，计划不编造价格。实施交接报告先说明所用账户/model、请求上限及是否已有执行授权；未授权全量付费运行时停在可审阅预检产物，获得授权后再执行，不能因已批准实施计划就擅自开始 4,008 请求。
- 正式输出记录实际 runId、manifest/evaluator/model hashes 和失败清单。四组共同成功集合为空，必须报告速度不可比较；不能删失败题重算好看的分数。

## Self-Review 记录

- Spec §1–4：Task 1/3/6/10 覆盖数据集合、方法、公平约束和替换范围。
- Spec §5：Task 2 直接官方实现，Task 8 固定全题宏平均、R 的 null。
- Spec §6：Task 3/4/5 隔离 qas、位置对齐、预算后证据和残余项。
- Spec §7–8：Task 7/8/9 覆盖热计时、重试、失败、中断与共同集合。
- Spec §9–11：Task 9/10 覆盖 CLI、离线复算、清理、真实与 hermetic 验收。
- Review Focus 五项均有明确归属测试；旧类型与新接口在 Task 10 删除前完成迁移；无要求安装产品依赖、修改数据库或提交用户 PDF 的步骤。

## Execution Handoff

计划完成后先由用户审阅并选择执行方式。建议 **Subagent-driven**：10 个任务中，证据对齐、来源追踪、官方评分和速度集合相互依赖，逐任务独立审查有助于发现“代码可运行但测量口径错误”的问题。也可选 **Native**：本会话顺序执行所有任务，结束后独立整分支审查，成本更低。选择前不开始实施。
