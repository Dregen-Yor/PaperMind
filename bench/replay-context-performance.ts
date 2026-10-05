/** Offline-only verification. Never initializes the LLM runtime or writes the run. */
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { AutoTokenizer, env } from '@huggingface/transformers'
import { createBgeM3Tokenizer } from './src/localPdf/tokenizer'
import { optimizeUnigram } from './src/localPdf/unigram'
import { materializePageRanges } from './src/localPdf/tocRouting'
import { graphemePrefixWithinBudget } from './src/localPdf/context'

const runDir = resolve(process.argv[2] ?? 'bench/results/ds-qasper-60-179-toc-tree-v1-rerun-20260930-225924')
const baseline = process.argv.includes('--baseline')
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'))
const manifest = await json(join(runDir, 'manifest.json'))
const records = (await readFile(join(runDir, 'records.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
// Disable all remote access: every tokenizer asset must already exist locally.
env.allowRemoteModels = false
const cacheDir = resolve('bench/cache/models')
const tokenizer = await createBgeM3Tokenizer(cacheDir)
const stock = await AutoTokenizer.from_pretrained('BAAI/bge-m3', { cache_dir: cacheDir, local_files_only: true })
optimizeUnigram(stock.model)
let differentialContexts = 0
for (const record of records.filter(r => r.context)) {
  const expected = stock.tokenize(record.context)
  if (!isDeepStrictEqual(tokenizer.tokenize(record.context), expected)
    || tokenizer.countTokens(record.context) !== expected.length) {
    throw new Error(`Token sequence/count mismatch: ${record.method}/${record.questionId}`)
  }
  differentialContexts++
}
const times: number[] = []
let calls = 0
let maxTokens = 0
let selected: { base: string; candidate: string } | undefined
const corpora = new Map<string, string[]>()
for (const paper of manifest.papers) {
  const prepared = await json(paper.prepared.path)
  const corpus = await json(prepared.corpus.path)
  corpora.set(paper.id, corpus.pages)
}
for (const record of records.filter(r => r.method === 'D' && r.retrievalStatus === 'completed')) {
  let localCalls = 0
  const start = performance.now()
  const result = materializePageRanges(corpora.get(record.paperId)!, record.routing.selectedRanges, text => {
    localCalls++
    return tokenizer.countTokens(text)
  }, 4096)
  const ms = performance.now() - start
  if (result.text !== record.context || !isDeepStrictEqual(result.trace, record.trace) || result.tokenCount > 4096) {
    throw new Error(`Context/trace/budget mismatch: ${record.paperId}/${record.questionId}`)
  }
  calls += localCalls
  times.push(ms)
  maxTokens = Math.max(maxTokens, result.tokenCount)
  process.stderr.write(JSON.stringify({ paper: record.paperId, question: record.questionId, ms, calls: localCalls, tokens: result.tokenCount }) + '\n')
  // Recover the exact overflowing append for the previously investigated slow paper.
  if (!selected && record.paperId === '2002.03407') {
    const last = result.trace.at(-1)
    if (last?.source) {
      const candidate = corpora.get(record.paperId)![last.source.page]
      if (last.source.end < candidate.length) selected = { base: result.text.slice(0, last.contextStart), candidate }
    }
  }
}
const sorted = [...times].sort((a, b) => a - b)
const percentile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1]
const report: Record<string, unknown> = {
  runDir, records: times.length, differentialContexts, contextAndTraceExact: true, maxTokens, calls,
  localMs: { total: times.reduce((a, b) => a + b, 0), p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) },
}
if (baseline) {
  if (!selected) throw new Error('Known slow overflowing append not found')
  let oldCalls = 0
  const oldCount = (text: string) => { oldCalls++; return stock.tokenize(text).length }
  const start = performance.now()
  let take = 0
  if (oldCount(selected.base + selected.candidate) <= 4096) take = selected.candidate.length
  else for (const segment of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(selected.candidate)) {
    const end = segment.index + segment.segment.length
    if (oldCount(selected.base + selected.candidate.slice(0, end)) <= 4096) take = end
  }
  const oldMs = performance.now() - start
  let newCalls = 0
  const nextStart = performance.now()
  const fastTake = graphemePrefixWithinBudget(selected.base, selected.candidate, text => {
    newCalls++; return tokenizer.countTokens(text)
  }, 4096)
  const newMs = performance.now() - nextStart
  if (take !== fastTake) throw new Error('Slow sample prefix differs from exhaustive baseline')
  report.slowAppend = { paperId: '2002.03407', candidateChars: selected.candidate.length, take, oldCalls, newCalls, oldMs, newMs, speedup: oldMs / newMs }
}
console.log(JSON.stringify(report, null, 2))
