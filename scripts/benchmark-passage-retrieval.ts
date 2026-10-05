/** Synthetic engineering benchmark; no model inference or answer-quality claims. */
import { deepStrictEqual } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import type { Embedder } from '../src/utils/embedder'
import { parsePassageIndex, serializePassageIndex, type PassageIndex } from '../src/utils/passageIndex'
import { createParsedPaperCache } from '../src/utils/parsedPaperCache'
import type { Passage } from '../src/utils/passages'
import { fillPassageBudget, retrievePassageContext } from '../src/utils/passageRetrieval'
import { retrieveRagContext } from '../src/utils/ragPipeline'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({
  options: {
    'baseline-ref': { type: 'string', default: '1649433' },
    iterations: { type: 'string', default: '120' },
    passages: { type: 'string', default: '600' },
  },
})
const iterations = Number(values.iterations)
const passageCount = Number(values.passages)
if (!Number.isInteger(iterations) || iterations < 20 || !Number.isInteger(passageCount) || passageCount < 40) {
  throw new Error('iterations must be >= 20 and passages must be >= 40 (integers)')
}
const queries = ['training corpus', 'evaluation results', 'limitations method', 'unknownzz']
const vocabulary = 'training corpus evaluation results limitations method baseline multilingual alignment accuracy dataset ablation memory optimization parameters inference'.split(' ')

function fixture(count = passageCount): PassageIndex {
  const passages: Passage[] = Array.from({ length: count }, (_, order) => {
    const words = Array.from({ length: 80 + order % 13 }, (_, j) => vocabulary[(j + Math.floor(order / 20) * 3) % vocabulary.length])
    const half = Math.floor(words.length / 2)
    const pieces = [
      { page: Math.floor(order / 4), text: words.slice(0, half).join(' ') + '\n' },
      { page: Math.floor(order / 4) + 1, text: words.slice(half).join(' ') + '\n\n' },
    ]
    const text = pieces.map(piece => piece.text).join('')
    return {
      id: `P${order}`, order, pieces, text, searchText: text, tokenCount: words.length,
      prevId: order > 0 ? `P${order - 1}` : null,
      nextId: order + 1 < count ? `P${order + 1}` : null,
      subsection: `Section ${Math.floor(order / 20)} ${vocabulary[Math.floor(order / 20) % vocabulary.length]}`,
    }
  })
  const cards = Array.from({ length: Math.ceil(count / 20) }, (_, i) => ({
    id: `S${i}`, range: [passages[i * 20].id, passages[Math.min(count - 1, i * 20 + 19)].id] as [string, string],
    title: `Topic ${i} ${vocabulary[i % vocabulary.length]}`, summary: vocabulary[(i + 1) % vocabulary.length],
    keyTerms: [vocabulary[(i + 2) % vocabulary.length]],
  }))
  return {
    version: 2, stage: 3, passageConfigHash: 'synthetic-v1', separatorTokens: 2,
    passages, cards, embedderId: 'synthetic', vectorDim: 4,
    passageVectors: passages.map((_, i) => new Float32Array([i % 7, 1, i % 3, 2])),
    cardVectors: cards.map((_, i) => new Float32Array([i % 5, 1, 2, i % 3])),
    tree: { title: 'Synthetic paper', nodeId: 'root', startPage: 0, endPage: Math.ceil(count / 4), summary: '', nodes: [] },
  }
}

const embedder: Embedder = {
  id: 'synthetic',
  async embedQuery() { return new Float32Array([1, 1, 2, 0]) },
  async embedPassages(texts) { return texts.map(() => new Float32Array([1, 1, 2, 0])) },
}

function percentile(samples: number[], fraction: number, digits = 3): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return Number(sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(digits))
}

async function main() {
  const temporary = await mkdtemp(join(tmpdir(), 'papermind-retrieval-benchmark-'))
  try {
    const baselineRef = values['baseline-ref']!
    const baselineSha = execFileSync('git', ['rev-parse', '--verify', `${baselineRef}^{commit}`], { cwd: repo, encoding: 'utf8' }).trim()
    for (const name of ['passageRetrieval', 'ragPipeline']) {
      const source = execFileSync('git', ['show', `${baselineSha}:src/utils/${name}.ts`], { cwd: repo, encoding: 'utf8' })
      const rewritten = source.replace(/(from\s+|import\s+)(['"])(\.\/[^'"]+)\2/g, (_, prefix: string, quote: string, relative: string) => {
        const target = name === 'ragPipeline' && relative === './passageRetrieval'
          ? join(temporary, 'passageRetrieval.mts')
          : resolve(repo, 'src/utils', `${relative}.ts`)
        return `${prefix}${quote}${pathToFileURL(target).href}${quote}`
      })
      await writeFile(join(temporary, `${name}.mts`), rewritten)
    }
    const baseline = await import(pathToFileURL(join(temporary, 'passageRetrieval.mts')).href) as typeof import('../src/utils/passageRetrieval')
    const baselineRag = await import(pathToFileURL(join(temporary, 'ragPipeline.mts')).href) as typeof import('../src/utils/ragPipeline')
    const index = fixture()
    const lexical = { ...index, passageVectors: undefined, cardVectors: undefined }
    const variants = [
      { name: 'bm25', index: { ...lexical, cards: undefined }, options: {} },
      { name: 'card-lexical', index: lexical, options: {} },
      { name: 'dense', index: { ...index, cards: undefined, cardVectors: undefined }, options: { embedder } },
      { name: 'full', index, options: { embedder } },
      { name: 'title-fallback', index: { ...index, structureFallback: { reason: 'request-failed' as const } }, options: { embedder } },
      { name: 'model-mismatch', index: { ...index, embedderId: 'another-model' }, options: { embedder } },
      { name: 'embed-failure', index, options: { embedder: { ...embedder, async embedQuery(): Promise<Float32Array> { throw new Error('offline') } } } },
      { name: 'empty', index: fixture(0), options: { embedder } },
    ]
    let equivalenceCases = 0
    for (const variant of variants) {
      for (const query of queries) {
        for (const maxTokens of [0, 80, 300, 4096, 1_000_000]) {
          const options = { ...variant.options, maxTokens }
          const current = await retrievePassageContext(variant.index, query, options)
          deepStrictEqual(current, await baseline.retrievePassageContext(variant.index, query, options))
          const disabledHeading = { ...options, headingWeight: 0 }
          deepStrictEqual(await retrievePassageContext(variant.index, query, disabledHeading), current)
          equivalenceCases += 2
        }
      }
    }
    for (const replacement of ['cards', 'passages'] as const) {
      const pendingReplacement = async (retrieve: typeof retrievePassageContext) => {
        const mutable = fixture(40)
        const options = {
          maxTokens: 300,
          embedder: {
            ...embedder,
            async embedQuery(): Promise<Float32Array> {
              if (replacement === 'cards') {
                mutable.cards = mutable.cards!.map((card, i) => ({ ...card, title: i === 0 ? 'unrelated' : 'training corpus', summary: '', keyTerms: [] }))
              } else {
                mutable.passages = mutable.passages.map((passage, i) => ({ ...passage, searchText: i === 39 ? 'training corpus' : 'unrelated' }))
              }
              throw new Error('offline after snapshot replacement')
            },
          },
        }
        return retrieve(mutable, queries[0], options)
      }
      deepStrictEqual(await pendingReplacement(retrievePassageContext), await pendingReplacement(baseline.retrievePassageContext))
      equivalenceCases++
    }
    // Exercise sparse selection, bridge separators, skip limits and neighbor scores.
    let seed = 20261003
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 2 ** 32
    }
    for (let i = 0; i < 120; i++) {
      const passages = fixture(40).passages.map(passage => ({ ...passage, tokenCount: 1 + Math.floor(random() * 70) }))
      const args = {
        passages,
        candidates: passages.map(passage => ({ order: passage.order, score: random(), fromNeighbour: false })),
        separatorTokens: i % 7,
        maxTokens: Math.floor(random() * 1600), neighbourFactor: (i % 3) / 2, skipLimit: 1 + i % 20,
      }
      deepStrictEqual(fillPassageBudget(args), baseline.fillPassageBudget(args))
      equivalenceCases++
    }
    const llm = async () => { throw new Error('unexpected query-time LLM call') }
    for (const variant of variants) {
      const paper = { tree: variant.index.tree, pages: [], passageIndex: variant.index }
      const dependencies = { now: () => 0, passage: { ...variant.options, maxTokens: 4096 } }
      deepStrictEqual(await retrieveRagContext([paper, paper], queries[0], [], llm, {}, dependencies), await baselineRag.retrieveRagContext([paper, paper], queries[0], [], llm, {}, dependencies))
      equivalenceCases++
    }
    const measure = async (retrieve: typeof retrievePassageContext, input: PassageIndex, options: Parameters<typeof retrievePassageContext>[2]) => {
      const fresh = { ...input, passages: [...input.passages] }
      const started = performance.now()
      await retrieve(fresh, queries[0], options)
      const firstQueryMs = Number((performance.now() - started).toFixed(3))
      for (let i = 0; i < 16; i++) await retrieve(fresh, queries[i % queries.length], options)
      const samples = []
      for (let i = 0; i < iterations; i++) {
        const start = performance.now()
        await retrieve(fresh, queries[i % queries.length], options)
        samples.push(performance.now() - start)
      }
      return { firstQueryMs, warmP50Ms: percentile(samples, 0.5), warmP95Ms: percentile(samples, 0.95) }
    }
    const timings = []
    for (const variant of variants.slice(0, 4)) {
      timings.push({ mode: variant.name, baseline: await measure(baseline.retrievePassageContext, variant.index, variant.options), optimized: await measure(retrievePassageContext, variant.index, variant.options) })
    }
    const headingTimings = []
    for (const headingWeight of [0, 0.25, 0.5]) {
      const options = { embedder, headingWeight }
      headingTimings.push({ headingWeight, ...await measure(retrievePassageContext, index, options) })
    }
    const record = { indexJson: JSON.stringify(serializePassageIndex(index)), pagesJson: JSON.stringify(index.passages.map(passage => passage.text)) }
    const cache = createParsedPaperCache()
    const parseRecord = () => ({ pages: JSON.parse(record.pagesJson), passageIndex: parsePassageIndex(JSON.parse(record.indexJson)) })
    deepStrictEqual(cache.get('synthetic-paper', record), parseRecord())
    const parsedRecordTimings = []
    for (const [name, load] of [
      ['uncached', parseRecord],
      ['cached', () => cache.get('synthetic-paper', record)],
    ] as const) {
      for (let i = 0; i < 16; i++) load()
      const samples = []
      for (let i = 0; i < iterations; i++) {
        const start = performance.now()
        load()
        samples.push(performance.now() - start)
      }
      parsedRecordTimings.push({ mode: name, warmP50Ms: percentile(samples, 0.5, 6), warmP95Ms: percentile(samples, 0.95, 6) })
    }
    console.log(JSON.stringify({ baselineSha, node: process.version, platform: `${process.platform}-${process.arch}`, passageCount, iterations, equivalenceCases, timings, headingTimings, parsedRecordTimings, scope: 'synthetic CPU retrieval and record parsing; deterministic 4-dimensional fake embeddings; no answer generation, inference, database IPC or network latency' }, null, 2))
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
