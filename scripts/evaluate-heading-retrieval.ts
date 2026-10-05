/** Real QASPER retrieval-only ablation. No dense model, structure-card LLM or answers. */
import { strictEqual } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { loadQasperDataset } from '../bench/src/datasets/qasper'
import {
  buildEvaluationContract, CONTEXT_BUDGET_TOKENS, CONTEXT_TOKENIZER_MODEL,
  CONTEXT_TOKENIZER_REVISION, isRetrievalEligible,
} from '../bench/src/evaluationContract'
import { computeContextPageMetrics } from '../bench/src/metrics/retrieval'
import { createBgeM3Tokenizer } from '../bench/src/traditionalRag/embedding'
import { CONTEXT_GROUP_SEPARATOR, materializeContext } from '../src/utils/contextTrace'
import { passageConfigHash, type PassageIndex } from '../src/utils/passageIndex'
import { buildPassages } from '../src/utils/passages'
import { retrieveRagContext } from '../src/utils/ragPipeline'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const weights = [0, 0.25, 0.5]
const segmentation = { minTokens: 120, maxTokens: 350 }
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]

async function main() {
  const sourcePaths = ['src/utils/passageRetrieval.ts', 'src/utils/ragPipeline.ts', 'scripts/evaluate-heading-retrieval.ts']
  const sources = await Promise.all(sourcePaths.map(path => readFile(resolve(repo, path), 'utf8')))
  const codeFingerprint = createHash('sha256').update(JSON.stringify(sourcePaths.map((path, i) => ({ path, source: sources[i] })))).digest('hex')
  const baseGitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  const uncommittedProductionChanges = execFileSync('git', ['diff', '--name-only', '--', 'src/utils/passageRetrieval.ts', 'src/utils/ragPipeline.ts'], { cwd: repo, encoding: 'utf8' }).trim().length > 0
  const samples = await loadQasperDataset()
  strictEqual(samples.length, 60, 'Expected the fixed 60-paper slice')
  strictEqual(samples.reduce((count, sample) => count + sample.questions.length, 0), 179, 'Expected 179 questions')
  const contract = buildEvaluationContract(samples)
  const tokenizerStarted = performance.now()
  const tokenizer = await createBgeM3Tokenizer({
    model: CONTEXT_TOKENIZER_MODEL,
    revision: CONTEXT_TOKENIZER_REVISION,
    cacheDir: resolve(repo, 'bench/cache/models'),
  })
  const tokenizerLoadMs = performance.now() - tokenizerStarted
  const countTokens = (text: string) => tokenizer.tokenize(text).length
  const separatorTokens = countTokens(CONTEXT_GROUP_SEPARATOR)
  const results = weights.map(headingWeight => ({
    headingWeight,
    latencyMs: [] as number[],
    evidenceRecall: [] as number[],
    evidenceHit: [] as number[],
    contextPrecision: [] as number[],
    contextPageMrr: [] as number[],
    changedSelections: 0,
    improvedRecallQuestions: 0,
    worseRecallQuestions: 0,
    truncatedQuestions: 0,
  }))
  const noLlm = async () => { throw new Error('Retrieval-only evaluation must not call an LLM') }
  let indexPreparationMs = 0
  let eligibleQuestions = 0
  for (const sample of samples) {
    const started = performance.now()
    const passages = buildPassages(sample.pages, countTokens, segmentation)
    const index: PassageIndex = {
      version: 2, stage: 1, passages, separatorTokens,
      passageConfigHash: passageConfigHash({ schemaVersion: 2, segmentation }),
      tree: { title: sample.title, nodeId: 'root', startPage: 0, endPage: sample.pages.length - 1, summary: '', nodes: [] },
    }
    const retrieve = (query: string, headingWeight: number) => retrieveRagContext(
      [{ tree: index.tree, pages: sample.pages, passageIndex: index }], query, [], noLlm,
      { enableRewrite: false },
      {
        passage: { maxTokens: CONTEXT_BUDGET_TOKENS, headingWeight, rrfK: 60, sectionWeight: 0.5, neighbourFactor: 0.5, skipLimit: 20 },
        materialize: groups => materializeContext(groups, tokenizer, CONTEXT_BUDGET_TOKENS),
      },
    )
    // Prepare the same index and both lexical scorers before measuring any arm.
    for (const weight of weights) await retrieve(sample.questions[0].question, weight)
    indexPreparationMs += performance.now() - started
    for (const question of sample.questions) {
      const eligible = isRetrievalEligible(question)
      if (eligible) eligibleQuestions++
      let baselineIds = ''
      let baselineRecall = 0
      for (const result of results) {
        const start = performance.now()
        const retrieval = await retrieve(question.question, result.headingWeight)
        result.latencyMs.push(performance.now() - start)
        strictEqual(retrieval.llmCalls, 0)
        if (retrieval.contextTokenCount! > CONTEXT_BUDGET_TOKENS) throw new Error('Context budget exceeded')
        if (retrieval.contextTruncated) result.truncatedQuestions++
        const ids = JSON.stringify(retrieval.retrievals[0].hybrid?.selectedPassageIds)
        if (result.headingWeight === 0) baselineIds = ids
        else if (ids !== baselineIds) result.changedSelections++
        if (!eligible) continue
        const metrics = computeContextPageMetrics(retrieval.contextPageOrder!, question.evidencePages)
        result.evidenceRecall.push(metrics.evidenceRecall)
        result.evidenceHit.push(metrics.evidenceHit)
        result.contextPrecision.push(metrics.contextPrecision)
        result.contextPageMrr.push(metrics.contextPageMrr)
        if (result.headingWeight === 0) baselineRecall = metrics.evidenceRecall
        else if (metrics.evidenceRecall > baselineRecall) result.improvedRecallQuestions++
        else if (metrics.evidenceRecall < baselineRecall) result.worseRecallQuestions++
      }
    }
  }
  strictEqual(eligibleQuestions, contract.eligibleRetrievalQuestionCount)
  for (const result of results) strictEqual(result.evidenceRecall.length, eligibleQuestions)
  console.log(JSON.stringify({
    scope: 'retrieval-only QASPER lexical ablation; no dense embeddings, structure cards, answer generation, AnswerF1 or TTFT',
    baseGitSha, uncommittedProductionChanges, codeFingerprint,
    node: process.version, platform: `${process.platform}-${process.arch}`,
    papers: samples.length, questions: 179, eligibleQuestions, contract, segmentation,
    tokenizerLoadMs, indexPreparationMs,
    arms: results.map(result => ({
      headingWeight: result.headingWeight,
      evidenceRecall: mean(result.evidenceRecall), evidenceHitRate: mean(result.evidenceHit),
      contextPrecision: mean(result.contextPrecision), contextPageMrr: mean(result.contextPageMrr),
      retrievalWithMaterializationP50Ms: percentile(result.latencyMs, 0.5),
      retrievalWithMaterializationP95Ms: percentile(result.latencyMs, 0.95),
      changedSelections: result.changedSelections,
      improvedRecallQuestions: result.improvedRecallQuestions, worseRecallQuestions: result.worseRecallQuestions,
      truncatedQuestions: result.truncatedQuestions,
    })),
  }, null, 2))
}

main().catch(error => {
  console.error(String(error instanceof Error ? error.message : error).replace(/https?:\/\/\S+/g, '[download URL]'))
  process.exitCode = 1
})
