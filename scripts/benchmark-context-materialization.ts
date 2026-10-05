/** Exact-output and CPU-cost comparison with the real QASPER slice/tokenizer. */
import { deepStrictEqual, strictEqual, ok } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { loadQasperDataset } from '../bench/src/datasets/qasper'
import {
  buildEvaluationContract, CONTEXT_BUDGET_TOKENS, CONTEXT_TOKENIZER_MODEL,
  CONTEXT_TOKENIZER_REVISION, isRetrievalEligible,
} from '../bench/src/evaluationContract'
import { computeContextPageMetrics } from '../bench/src/metrics/retrieval'
import { createBgeM3Tokenizer } from '../bench/src/traditionalRag/embedding'
import {
  CONTEXT_GROUP_SEPARATOR, materializeContext,
  type ContextGroup, type ContextTokenizer,
} from '../src/utils/contextTrace'
import { passageConfigHash, type PassageIndex } from '../src/utils/passageIndex'
import { buildPassages } from '../src/utils/passages'
import { retrieveRagContext } from '../src/utils/ragPipeline'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: { 'baseline-ref': { type: 'string', default: '5331fc6' } } })
const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
type Materializer = typeof materializeContext

function measure(materialize: Materializer, groups: ContextGroup[], tokenizer: ContextTokenizer) {
  let calls = 0
  const counted = { tokenize(text: string) { calls++; return tokenizer.tokenize(text) } }
  const started = performance.now()
  const result = materialize(groups, counted, CONTEXT_BUDGET_TOKENS)
  return { result, calls, ms: performance.now() - started }
}

async function main() {
  const baselineSha = git('rev-parse', '--verify', `${values['baseline-ref']}^{commit}`)
  const baselineSource = git('show', `${baselineSha}:src/utils/contextTrace.ts`)
  const sourcePaths = ['src/utils/contextTrace.ts', 'src/utils/ragPipeline.ts', 'scripts/benchmark-context-materialization.ts']
  const sources = await Promise.all(sourcePaths.map(path => readFile(resolve(repo, path), 'utf8')))
  const codeFingerprint = sha256(JSON.stringify(sourcePaths.map((path, i) => ({ path, source: sources[i] }))))
  const baseGitSha = git('rev-parse', 'HEAD')
  const uncommittedProductionChanges = git('diff', 'HEAD', '--name-only', '--', 'src/utils/contextTrace.ts', 'src/utils/ragPipeline.ts').length > 0
  const temporary = await mkdtemp(join(tmpdir(), 'papermind-context-baseline-'))
  try {
    const baselinePath = join(temporary, 'contextTrace.mts')
    await writeFile(baselinePath, baselineSource)
    const baseline: { materializeContext: Materializer } = await import(pathToFileURL(baselinePath).href)
    const samples = await loadQasperDataset()
    strictEqual(samples.length, 60, 'Expected the fixed 60-paper slice')
    strictEqual(samples.reduce((count, sample) => count + sample.questions.length, 0), 179, 'Expected 179 questions')
    const contract = buildEvaluationContract(samples)
    const loadStarted = performance.now()
    const tokenizer = await createBgeM3Tokenizer({
      model: CONTEXT_TOKENIZER_MODEL, revision: CONTEXT_TOKENIZER_REVISION,
      cacheDir: resolve(repo, 'bench/cache/models'),
    })
    const tokenizerLoadMs = performance.now() - loadStarted
    const countTokens = (text: string) => tokenizer.tokenize(text).length
    const segmentation = { minTokens: 120, maxTokens: 350 }
    const separatorTokens = countTokens(CONTEXT_GROUP_SEPARATOR)
    const baselineMs: number[] = []
    const optimizedMs: number[] = []
    const retrievalMs: number[] = []
    const evidenceRecall: number[] = []
    const evidenceHit: number[] = []
    const contextPrecision: number[] = []
    const contextPageMrr: number[] = []
    let baselineCalls = 0
    let optimizedCalls = 0
    let equivalenceCases = 0
    let preparationMs = 0
    let truncatedQuestions = 0
    const noLlm = async () => { throw new Error('This comparison must not call an LLM') }
    for (const sample of samples) {
      const prepareStarted = performance.now()
      const index: PassageIndex = {
        version: 2, stage: 1,
        passages: buildPassages(sample.pages, countTokens, segmentation), separatorTokens,
        passageConfigHash: passageConfigHash({ schemaVersion: 2, segmentation }),
        tree: { title: sample.title, nodeId: 'root', startPage: 0, endPage: sample.pages.length - 1, summary: '', nodes: [] },
      }
      const retrieve = (query: string) => retrieveRagContext(
        [{ tree: index.tree, pages: sample.pages, passageIndex: index }], query, [], noLlm,
        { enableRewrite: false }, { passage: { maxTokens: CONTEXT_BUDGET_TOKENS, headingWeight: 0 } },
      )
      // Prepare lexical statistics once, outside the query/materialization samples.
      await retrieve(sample.questions[0].question)
      preparationMs += performance.now() - prepareStarted
      for (const question of sample.questions) {
        const retrievalStarted = performance.now()
        const retrieval = await retrieve(question.question)
        retrievalMs.push(performance.now() - retrievalStarted)
        strictEqual(retrieval.llmCalls, 0)
        const groups = retrieval.retrievals.flatMap(result => result.contextGroups)
        // Both arms receive the same raw groups. Alternate their order across questions.
        const implementations = baselineMs.length % 2 === 0
          ? [baseline.materializeContext, materializeContext]
          : [materializeContext, baseline.materializeContext]
        const measurements = implementations.map(implementation => measure(implementation, groups, tokenizer))
        const before = measurements[implementations.indexOf(baseline.materializeContext)]
        const after = measurements[implementations.indexOf(materializeContext)]
        deepStrictEqual(after.result, before.result)
        ok(after.result.tokenCount <= CONTEXT_BUDGET_TOKENS)
        ok(after.calls <= before.calls, 'Optimized materialization must not add tokenizer calls')
        equivalenceCases++
        baselineMs.push(before.ms)
        optimizedMs.push(after.ms)
        baselineCalls += before.calls
        optimizedCalls += after.calls
        if (after.result.truncated) truncatedQuestions++
        for (const budget of [1, 64, 256]) {
          deepStrictEqual(materializeContext(groups, tokenizer, budget), baseline.materializeContext(groups, tokenizer, budget))
          equivalenceCases++
        }
        if (isRetrievalEligible(question)) {
          const metrics = computeContextPageMetrics(after.result.pageOrder, question.evidencePages)
          evidenceRecall.push(metrics.evidenceRecall)
          evidenceHit.push(metrics.evidenceHit)
          contextPrecision.push(metrics.contextPrecision)
          contextPageMrr.push(metrics.contextPageMrr)
        }
      }
    }
    strictEqual(baselineMs.length, 179)
    strictEqual(evidenceRecall.length, contract.eligibleRetrievalQuestionCount)
    ok(optimizedCalls < baselineCalls, 'Expected to eliminate duplicate tokenizer calls')
    console.log(JSON.stringify({
      scope: 'real QASPER exact-tokenizer context materialization; lexical candidate retrieval; no dense inference, cards, answers or TTFT',
      baselineSha, baselineSourceFingerprint: sha256(baselineSource), baseGitSha,
      uncommittedProductionChanges, codeFingerprint,
      node: process.version, platform: `${process.platform}-${process.arch}`,
      papers: samples.length, questions: baselineMs.length, contract, segmentation,
      equivalenceCases, budgets: [1, 64, 256, CONTEXT_BUDGET_TOKENS],
      tokenizerLoadMs, preparationMs,
      preparationScope: 'exact passage segmentation and initial lexical-statistics preparation, shared by both materializer arms',
      materialization: {
        baseline: { p50Ms: percentile(baselineMs, 0.5), p95Ms: percentile(baselineMs, 0.95), tokenizerCalls: baselineCalls },
        optimized: { p50Ms: percentile(optimizedMs, 0.5), p95Ms: percentile(optimizedMs, 0.95), tokenizerCalls: optimizedCalls },
      },
      sharedWarmRetrieval: { p50Ms: percentile(retrievalMs, 0.5), p95Ms: percentile(retrievalMs, 0.95) },
      identicalEvidenceMetrics: {
        eligibleQuestions: evidenceRecall.length, evidenceRecall: mean(evidenceRecall),
        evidenceHitRate: mean(evidenceHit), contextPrecision: mean(contextPrecision),
        contextPageMrr: mean(contextPageMrr), truncatedQuestions,
      },
    }, null, 2))
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(String(error instanceof Error ? error.message : error).replace(/https?:\/\/\S+/g, '[download URL]'))
  process.exitCode = 1
})
