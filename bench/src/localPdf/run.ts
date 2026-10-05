import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type { AlignmentArtifact, Method, QueryRecord, QualityScores, RawQasperDataset, RunHeader, RunSummary } from './types'
import { SCHEMA, requireThat, uniqueIds, METHODS } from './contract'
import { verifyManifest, verifyFile, writeJson, type PreparedFiles } from './prepare'
import { createRun, readRun } from './artifacts'
import { prepareMethod, type PreparedCorpus, type PreparedMethod } from './methods'
import { executeQuery } from './query'
import { ANSWER_PROMPT, type initializeRuntime } from './runtime'
import { deriveEvidence } from './evidence'
import { evaluatorHash, scoreOfficial } from './scoring'
import { aggregateRun } from './timing'
import { safeError } from './errors'
import { isHeadingMethod } from './headingRetrieval'
export interface RunDeps { runtime: Awaited<ReturnType<typeof initializeRuntime>>; now: () => number; score: typeof scoreOfficial; progress?: (message: string) => void }
export async function runBenchmark(manifestPath: string, methods: Method[], out: string, deps: RunDeps): Promise<RunSummary> {
  uniqueIds(methods); requireThat(methods.length > 0 && methods.every(m => METHODS.includes(m)), 'invalid methods')
  methods = METHODS.filter(m => methods.includes(m))
  const manifest = await verifyManifest(manifestPath)
  const goldText = await readFile(manifest.gold.path, 'utf8'); const gold = JSON.parse(goldText) as RawQasperDataset
  const goldSha256 = createHash('sha256').update(goldText).digest('hex')
  const header: RunHeader = {
    schema: SCHEMA, runId: randomUUID(), methods, expectedQuestionIds: manifest.questions.map(q => q.id), status: 'running', goldSha256,
    dataset: { split: manifest.split, subset: manifest.subset, papers: manifest.papers.length },
    identity: { ...deps.runtime.identity, manifestFingerprint: manifest.fingerprint, evaluatorSha256: evaluatorHash(), gitSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() },
  }
  const writer = await createRun(out, header)
  await writeFile(join(out, 'gold.json'), goldText, { flag: 'wx' })
  await writeJson(join(out, 'manifest.json'), manifest)
  const records: QueryRecord[] = []
  for (const p of manifest.papers) {
    deps.progress?.(`paper ${p.id}: preparing indexes`)
    const files = JSON.parse(await readFile(p.prepared.path, 'utf8')) as PreparedFiles
    let corpus: PreparedCorpus | undefined; let alignment: AlignmentArtifact | undefined
    if (files.corpus && files.alignment) {
      corpus = JSON.parse(await readFile(files.corpus.path, 'utf8')) as PreparedCorpus
      alignment = JSON.parse(await readFile(files.alignment.path, 'utf8')) as AlignmentArtifact
    }
    const prepared = new Map<Method, PreparedMethod>(); const failures = new Map<Method, string>()
    let savedTree = false
    if (corpus) for (const method of methods) {
      deps.progress?.(`paper ${p.id}: index ${method} start`)
      try {
        const ready = await prepareMethod(method, corpus, deps.runtime.methodDeps)
        if ((method === 'D' || isHeadingMethod(method)) && !savedTree) {
          requireThat(ready.tree, 'TOC preparation did not produce a tree')
          await writer.writeTree(p.id, ready.tree)
          savedTree = true
        }
        if (isHeadingMethod(method)) {
          requireThat(ready.headingIndex, 'E preparation did not produce heading index')
          await writer.writeHeadingIndex(method, p.id, ready.headingIndex)
        }
        prepared.set(method, ready)
      }
      catch (error) { failures.set(method, safeError(error)) }
    }
    for (const q of manifest.questions.filter(q => q.paperId === p.id)) for (const method of methods) {
      deps.progress?.(`query ${records.length + 1}/${manifest.questions.length * methods.length}: ${method} ${q.id} start`)
      const ready = prepared.get(method)
      let record: QueryRecord
      if (ready) {
        record = await executeQuery(q, ready, { client: deps.runtime.client, now: deps.now, systemPrompt: ANSWER_PROMPT })
        if (method !== 'R' && record.retrievalStatus === 'completed') {
          // Adapter errors are harness failures, never disguised as successful empty evidence.
          record.evidence = deriveEvidence(p.id, corpus!.pages, { text: record.context, trace: record.trace }, alignment!).predicted
        }
      } else record = {
        method, questionId: q.id, paperId: p.id, retrievalStatus: method === 'R' ? 'not-applicable' : 'failed', generationStatus: 'skipped',
        answer: '', evidence: null, context: '', trace: [], t0: null, tContextReady: null, tFirstAnswerToken: null,
        error: { stage: corpus ? 'index' : 'parse', message: failures.get(method) ?? safeError(p.parseError ?? 'PDF parsing failed') },
      }
      await writer.append(record); records.push(record)
      deps.progress?.(`query ${records.length}/${manifest.questions.length * methods.length}: ${method} ${record.generationStatus}`)
    }
  }
  const scores = new Map<Method, QualityScores>()
  for (const m of methods) {
    const score = await deps.score(gold, records, header.expectedQuestionIds, m)
    scores.set(m, score); await writeJson(join(out, `${m}-scores.json`), score)
    const predictions = records.filter(r => r.method === m && (m === 'R' ? r.generationStatus === 'completed' : r.retrievalStatus === 'completed')).map(r => JSON.stringify({ question_id: r.questionId, predicted_answer: r.answer, predicted_evidence: r.evidence ?? [] }))
    await writeFile(join(out, `${m}-predictions.jsonl`), predictions.join('\n') + (predictions.length ? '\n' : ''), { flag: 'wx' })
  }
  header.status = records.some(r => r.generationStatus === 'completed') ? 'completed' : 'failed'
  const summary = aggregateRun(header, records, scores)
  await writer.finish(summary)
  return summary
}
export async function reportRun(out: string, python?: string): Promise<RunSummary> {
  const { header, records } = await readRun(out)
  requireThat(header.identity.evaluatorSha256 === evaluatorHash(), 'evaluator identity mismatch')
  requireThat(header.goldSha256, 'missing frozen gold hash')
  await verifyFile({ path: join(out, 'gold.json'), sha256: header.goldSha256 })
  const gold = JSON.parse(await readFile(join(out, 'gold.json'), 'utf8')) as RawQasperDataset
  const scores = new Map<Method, QualityScores>()
  for (const m of header.methods) scores.set(m, await scoreOfficial(gold, records, header.expectedQuestionIds, m, python))
  return aggregateRun(header, records, scores)
}
