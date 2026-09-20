# Comparable Context Page MRR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace method-specific candidate MRR with a versioned, failure-aware page MRR computed from the exact 4096-token context sent to the answer model.

**Architecture:** Add a production-side context provenance/materialization primitive, then make PageIndex, semantic-tree, traditional RAG, hybrid rerank, and long-section retrieval emit page-attributed context groups. Split the production RAG pipeline into retrieval and generation stages so benchmark runners can persist retrieval metrics before generation, and make reporting reject comparisons whose dataset, eligible IDs, metric schema, tokenizer, or budget differ.

**Tech Stack:** TypeScript, Vue 3 production utilities, Node.js benchmark CLI, Vitest, `@huggingface/transformers` BGE-M3 tokenizer, SHA-256 run identities.

**Spec:** `docs/superpowers/specs/2026-09-19-comparable-context-page-mrr-design.md`

## Global Constraints

- Context Page MRR uses the ordered, deduplicated pages that actually contribute non-empty text to the final generation context.
- A partially emitted page counts as present; a page completely removed by the final budget does not.
- Retrieval-eligible questions are answerable, have non-empty `evidencePages`, and are neither `ambiguous` nor `unmapped`.
- Every eligible processed question emits `contextPageMrr`; a miss, empty context, index failure, or retrieval failure is `0`, never a missing observation.
- `evidenceRecall`, `evidenceHit`, and `contextPrecision` use the same final `contextPageOrder` and eligible-question set as Context Page MRR.
- Comparable RAG runs use `BAAI/bge-m3`, revision `main`, and a final context budget of exactly 4096 tokenizer tokens.
- Product defaults remain unchanged; the controlled token budget is injected only by the benchmark.
- `full-context` remains untruncated by the retrieval budget and is marked ineligible for retrieval comparison.
- New runs write `metricSchemaVersion: 2` and `mrrDefinition: 'context-page-v1'`; legacy `mrr` is readable but never compared with the new metric.
- The final answer prompt must use the same materialized context object from which `contextPageOrder` is read.
- Existing credentials must never enter results, checkpoint signatures, logs, fixtures, or commits.
- Follow repository style: two-space indentation, single quotes, no semicolons, trailing commas in multiline structures.

## File Structure

- Create `src/utils/contextTrace.ts`: shared page-attributed context types and deterministic token-budget materializer.
- Create `src/tests/contextTrace.test.ts`: materializer boundary, ordering, deduplication, and truncation tests.
- Modify `src/utils/evidenceBlock.ts`: retain exact per-page source pieces for every evidence block.
- Modify `src/utils/pageIndex.ts`: return context groups alongside the legacy context string.
- Modify `src/utils/semanticRoute.ts`: return context groups for semantic evidence and flat fallback paths.
- Modify `src/utils/semanticTree.ts`: bump the persisted semantic-tree schema after the EvidenceBlock JSON shape changes.
- Modify `src/utils/ragPipeline.ts`: expose retrieval and generation stages and optionally use a benchmark materializer.
- Modify `src/tests/evidenceBlock.test.ts`, `src/tests/pageIndex.test.ts`, `src/tests/semanticRoute.test.ts`, `src/tests/ragPipeline.test.ts`, `src/tests/ragPipelineSemantic.test.ts`, and `src/tests/semanticTreeStore.test.ts`: production contract coverage.
- Modify `bench/src/traditionalRag/types.ts`, `bench/src/traditionalRag/chunker.ts`, `bench/src/traditionalRag/context.ts`, `bench/src/baselines/tokenStream.ts`, `bench/src/baselines/contiguous.ts`, `bench/src/runner/hybridRerankQa.ts`, and `bench/src/runner/longSectionQa.ts`: preserve page pieces through benchmark candidates.
- Create `bench/src/evaluationContract.ts`: fixed metric/tokenizer constants, dataset and eligible-ID fingerprints, and comparison identity.
- Replace the candidate-ranking logic in `bench/src/metrics/retrieval.ts` with final-page-order metrics while preserving generic token helpers still used elsewhere.
- Modify `bench/src/types.ts`: schema-v2 metadata, per-sample stage status, final page order, and comparison eligibility.
- Modify `bench/src/runner/qa.ts`, `bench/src/runner/traditionalRagQa.ts`, and `bench/src/runner/strongBaselineQa.ts`: staged records and failure-aware metric aggregation.
- Modify `bench/src/runner/fullContextQa.ts`: explicitly mark the generation ceiling as comparison-ineligible.
- Modify `bench/src/cli.ts`: load one fixed context tokenizer, construct the run contract, and inject the common materializer.
- Modify `bench/src/report.ts`: versioned retrieval table, legacy labeling, and hard comparison gates.
- Modify benchmark and production tests named in each task; update `bench/README.md` after behavior is verified.

---

### Task 1: Shared Context Materializer

**Files:**
- Create: `src/utils/contextTrace.ts`
- Create: `src/tests/contextTrace.test.ts`

**Interfaces:**
- Consumes: a tokenizer exposing `tokenize(text: string): string[]`.
- Produces: `ContextPiece`, `ContextGroup`, `ContextTokenizer`, `MaterializedContext`, `CONTEXT_GROUP_SEPARATOR`, and `materializeContext(groups, tokenizer, maxTokens)`.

- [ ] **Step 1: Write the failing materializer tests**

```ts
import { describe, expect, it } from 'vitest'
import { materializeContext, type ContextGroup } from '../utils/contextTrace'

const tokenizer = {
  tokenize: (text: string) => text.split(/\s+/).filter(Boolean).map(word => `▁${word}`),
}

describe('materializeContext', () => {
  it('keeps prompt text and first-occurrence page order in the same result', () => {
    const groups: ContextGroup[] = [
      { pieces: [{ page: 2, text: 'alpha beta' }, { page: 3, text: 'gamma' }] },
      { pieces: [{ page: 2, text: 'alpha again' }, { page: 5, text: 'delta' }] },
    ]
    const out = materializeContext(groups, tokenizer, 20)
    expect(out.text).toContain('---')
    expect(out.pageOrder).toEqual([2, 3, 5])
    expect(out.tokenCount).toBeLessThanOrEqual(20)
    expect(out.truncated).toBe(false)
  })

  it('counts a partially emitted page and drops pages wholly beyond the budget', () => {
    const out = materializeContext([
      { pieces: [{ page: 0, text: 'a b' }, { page: 1, text: 'c d e' }, { page: 2, text: 'f' }] },
    ], tokenizer, 4)
    expect(out.pageOrder).toEqual([0, 1])
    expect(out.text).not.toContain('f')
    expect(out.tokenCount).toBe(4)
    expect(out.truncated).toBe(true)
  })

  it('does not leave a group separator when no token from the next group fits', () => {
    const out = materializeContext([
      { pieces: [{ page: 0, text: 'a b' }] },
      { pieces: [{ page: 1, text: 'c' }] },
    ], tokenizer, 2)
    expect(out.text).toBe('a b')
    expect(out.pageOrder).toEqual([0])
  })

  it('treats an exactly full 4096-token context as untruncated', () => {
    const text = Array.from({ length: 4096 }, (_, i) => `t${i}`).join(' ')
    const out = materializeContext([{ pieces: [{ page: 7, text }] }], tokenizer, 4096)
    expect(out.tokenCount).toBe(4096)
    expect(out.pageOrder).toEqual([7])
    expect(out.truncated).toBe(false)
  })

  it('returns an empty stable result for empty groups', () => {
    expect(materializeContext([], tokenizer, 4096)).toEqual({
      text: '', pageOrder: [], tokenCount: 0, truncated: false,
    })
  })
})
```

- [ ] **Step 2: Run the focused test and verify the missing-module failure**

Run: `npx vitest run src/tests/contextTrace.test.ts`

Expected: FAIL because `src/utils/contextTrace.ts` does not exist.

- [ ] **Step 3: Implement the shared types and deterministic budget loop**

```ts
export const CONTEXT_GROUP_SEPARATOR = '\n\n---\n\n'

export interface ContextTokenizer {
  tokenize(text: string): string[]
}

export interface ContextPiece {
  page: number
  text: string
}

export interface ContextGroup {
  pieces: ContextPiece[]
}

export interface MaterializedContext {
  text: string
  pageOrder: number[]
  tokenCount: number
  truncated: boolean
}

const renderToken = (token: string) => token.replaceAll('▁', ' ')

export function materializeContext(
  groups: ContextGroup[],
  tokenizer: ContextTokenizer,
  maxTokens: number,
): MaterializedContext {
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new Error('maxTokens 必须为正整数')
  const pageOrder: number[] = []
  const seen = new Set<number>()
  let text = ''
  let tokenCount = 0
  let truncated = false

  const emit = (raw: string, page?: number): boolean => {
    const tokens = tokenizer.tokenize(raw)
    const take = Math.min(tokens.length, maxTokens - tokenCount)
    if (take <= 0) {
      if (tokens.length > 0) truncated = true
      return false
    }
    text += tokens.slice(0, take).map(renderToken).join('')
    tokenCount += take
    if (page !== undefined && take > 0 && !seen.has(page)) {
      seen.add(page)
      pageOrder.push(page)
    }
    if (take < tokens.length) truncated = true
    return take === tokens.length
  }

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const pieces = groups[groupIndex].pieces.filter(piece => piece.text.trim().length > 0)
    if (pieces.length === 0) continue
    const prefix = text.length > 0 ? CONTEXT_GROUP_SEPARATOR : ''
    const prefixTokens = tokenizer.tokenize(prefix).length
    const firstTokens = tokenizer.tokenize(pieces[0].text).length
    if (tokenCount + prefixTokens >= maxTokens && firstTokens > 0) {
      truncated = true
      break
    }
    if (prefix && !emit(prefix)) break
    for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex++) {
      if (!emit(pieces[pieceIndex].text, pieces[pieceIndex].page)) break
    }
    if (tokenCount >= maxTokens) {
      truncated ||= groupIndex < groups.length - 1
      break
    }
  }
  return { text: text.trim(), pageOrder, tokenCount, truncated }
}
```

`ContextPiece.text` is an exact fragment: page-boundary whitespace belongs to the following piece, so concatenating all pieces in one group reproduces that candidate exactly. During implementation, keep the tests as the authority for separator behavior. Do not add a character-estimate fallback to this function; benchmark token materialization must be exact in its own token units.

- [ ] **Step 4: Run the materializer tests**

Run: `npx vitest run src/tests/contextTrace.test.ts`

Expected: PASS.

- [ ] **Step 5: Run type checking**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the primitive**

```bash
git add src/utils/contextTrace.ts src/tests/contextTrace.test.ts
git commit -m "feat: add page-aware context materializer"
```

### Task 2: Production Retrieval Provenance

**Files:**
- Modify: `src/utils/evidenceBlock.ts:19-31,156-205`
- Modify: `src/utils/pageIndex.ts:230-243,284-346`
- Modify: `src/utils/semanticRoute.ts:270-341`
- Modify: `src/utils/semanticTree.ts:13`
- Modify: `src/stores/chat.ts:423-446`
- Modify: `src/tests/evidenceBlock.test.ts`
- Modify: `src/tests/pageIndex.test.ts`
- Modify: `src/tests/semanticRoute.test.ts`
- Modify: `src/tests/semanticTree.test.ts`
- Modify: `src/tests/semanticTreeStore.test.ts`
- Modify: `src/tests/ragPipelineSemantic.test.ts`
- Modify: `bench/src/tests/semanticTreeQa.test.ts`
- Modify: `bench/src/tests/treeInspect.test.ts`

**Interfaces:**
- Consumes: `ContextPiece` and `ContextGroup` from Task 1.
- Produces: `EvidenceBlock.pieces: ContextPiece[]` and `RetrievalResult.contextGroups: ContextGroup[]` on every flat, fallback, and semantic route.

- [ ] **Step 1: Add failing evidence-block provenance tests**

Add assertions that pieces are an exact partition of `rawText` and preserve pages:

```ts
it('stores an exact per-page partition of rawText', () => {
  const blocks = buildEvidenceBlocks(['page zero paragraph', 'page one paragraph'], {
    targetChars: 1000, maxChars: 1200, minChars: 1,
  })
  expect(blocks).toHaveLength(1)
  expect(blocks[0].pieces.map(piece => piece.page)).toEqual([0, 1])
  expect(blocks[0].pieces.map(piece => piece.text).join('')).toBe(blocks[0].rawText)
})
```

Add PageIndex and semantic-route assertions:

```ts
expect(result.contextGroups).toEqual([
  { pieces: [{ page: 0, text: pages[0] }, { page: 1, text: `\n\n${pages[1]}` }] },
])
```

- [ ] **Step 2: Run provenance tests and verify failures**

Run: `npx vitest run src/tests/evidenceBlock.test.ts src/tests/pageIndex.test.ts src/tests/semanticRoute.test.ts`

Expected: FAIL because `pieces` and `contextGroups` are absent.

- [ ] **Step 3: Build EvidenceBlock pieces without changing raw text**

Update the public interface:

```ts
export interface EvidenceBlock {
  id: string
  rawText: string
  normalizedText: string
  pieces: ContextPiece[]
  startPage: number
  endPage: number
  order: number
  previousId: string | null
  nextId: string | null
  sourceType: EvidenceSourceType
}
```

Render atoms into consecutive page pieces while attaching each paragraph separator to the following atom:

```ts
function atomsToPieces(atoms: Atom[]): ContextPiece[] {
  const pieces: ContextPiece[] = []
  atoms.forEach((atom, index) => {
    const fragment = `${index > 0 && atom.breakBefore ? '\n\n' : ''}${atom.text}`
    const last = pieces.at(-1)
    if (last?.page === atom.page) last.text += fragment
    else pieces.push({ page: atom.page, text: fragment })
  })
  return pieces
}
```

Set `rawText` to `pieces.map(piece => piece.text).join('')` so the exact-partition invariant is structural rather than approximate.

- [ ] **Step 4: Add context groups to flat and semantic retrieval results**

Extend `RetrievalResult`:

```ts
export interface RetrievalResult {
  context: string
  contextGroups: ContextGroup[]
  sources: string[]
  selected: IndexNode[]
  scores: NodeScore[]
  degraded: boolean
  llmCalled: boolean
  degradedReason?: 'invalid-json' | 'invalid-score-schema' | 'incomplete-score-coverage' | 'score-request-failed'
}
```

For a selected PageIndex node, produce one group whose first piece is the first page text and whose later pieces include the existing `\n\n` page prefix. For semantic evidence, produce one group per selected EvidenceBlock using `block.pieces`; for flat semantic fallback, use the PageIndex conversion. Keep the existing `context` strings unchanged in this task so product behavior remains stable.

- [ ] **Step 5: Bump the semantic-tree persisted schema and update fixtures**

Change:

```ts
export const SEMANTIC_TREE_SCHEMA_VERSION = 2
```

Update every `EvidenceBlock` factory in the listed tests to include a matching `pieces` array. Update store assertions from schema version `1` to `2`, and retain a test proving a schema-1 record is rejected and rebuilt. In `parseTreeRecord`, validate every schema-2 block before returning it: `pieces` must be a non-empty array, each piece must have a non-negative integer `page` and string `text`, concatenated piece text must equal `rawText`, and first/last piece pages must equal `startPage`/`endPage`. Add a schema-2 fixture with missing or malformed `pieces` and assert it is rejected and rebuilt. No SQLite column migration is needed because blocks remain JSON in `blocks_json`; the schema bump invalidates stale JSON safely.

- [ ] **Step 6: Run the focused production and semantic tests**

Run: `npx vitest run src/tests/evidenceBlock.test.ts src/tests/pageIndex.test.ts src/tests/semanticRoute.test.ts src/tests/semanticTree.test.ts src/tests/semanticTreeStore.test.ts src/tests/ragPipelineSemantic.test.ts bench/src/tests/semanticTreeQa.test.ts bench/src/tests/treeInspect.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit provenance support**

```bash
git add src/utils/evidenceBlock.ts src/utils/pageIndex.ts src/utils/semanticRoute.ts src/utils/semanticTree.ts src/stores/chat.ts src/tests/evidenceBlock.test.ts src/tests/pageIndex.test.ts src/tests/semanticRoute.test.ts src/tests/semanticTree.test.ts src/tests/semanticTreeStore.test.ts src/tests/ragPipelineSemantic.test.ts bench/src/tests/semanticTreeQa.test.ts bench/src/tests/treeInspect.test.ts
git commit -m "feat: preserve page provenance in retrieval contexts"
```

### Task 3: Split the Production RAG Pipeline into Retrieval and Generation Stages

**Files:**
- Modify: `src/utils/ragPipeline.ts:48-196`
- Modify: `src/tests/ragPipeline.test.ts`
- Modify: `src/tests/ragPipelineSemantic.test.ts`
- Modify: `src/stores/chat.ts` only if TypeScript requires adapting to the unchanged `runRagPipeline` wrapper return type.

**Interfaces:**
- Consumes: `RetrievalResult.contextGroups` and `MaterializedContext`.
- Produces: `retrieveRagContext`, `generateRagAnswer`, a backward-compatible `runRagPipeline` composition, and optional `contextPageOrder/contextTokenCount` in the result.

- [ ] **Step 1: Write failing stage-separation tests**

```ts
it('retains a completed retrieval result when generation rejects', async () => {
  const retrieval = await retrieveRagContext(
    [{ tree: twoLeafTree, pages }], 'question', [], complete, {},
    { materialize: groups => materializeContext(groups, tokenizer, 4) },
  )
  expect(retrieval.contextPageOrder).toEqual([0, 1])
  await expect(generateRagAnswer(
    retrieval, 'question', [], async () => { throw new Error('generation failed') }, 'system',
  )).rejects.toThrow('generation failed')
  expect(retrieval.contextPageOrder).toEqual([0, 1])
})

it('uses exactly the materialized text in the answer prompt', async () => {
  const generate = vi.fn(async () => 'answer')
  const result = await runRagPipeline(
    [{ tree: twoLeafTree, pages }], 'question', [], complete, generate, 'system', {},
    { materialize: groups => materializeContext(groups, tokenizer, 3) },
  )
  expect(generate.mock.calls[0][0][0].content).toContain(`参考内容：\n${result.context}`)
  expect(result.contextPageOrder).toEqual([0])
})
```

- [ ] **Step 2: Run pipeline tests and verify missing exports**

Run: `npx vitest run src/tests/ragPipeline.test.ts src/tests/ragPipelineSemantic.test.ts`

Expected: FAIL because `retrieveRagContext` and `generateRagAnswer` are not exported.

- [ ] **Step 3: Introduce the staged interfaces**

```ts
export interface RagRetrievalStage {
  retrievals: PipelineRetrieval[]
  retrievalQuery: string
  rewritten: boolean
  context: string
  contextPageOrder?: number[]
  contextTokenCount?: number
  contextTruncated: boolean
  sources: string[]
  llmCalls: number
  treeRouted: boolean
  queryRewriteLatencyMs: number
  retrievalLatencyMs: number
  pipelineStartedAt: number
}

export interface RagPipelineDeps {
  now?: () => number
  materialize?: (groups: ContextGroup[]) => MaterializedContext
}

export interface RagGenerationStage {
  answer: string
  answerGenerationLatencyMs: number
  queryEndToEndLatencyMs: number
}
```

Move rewrite, scoring, source collection, and context construction into `retrieveRagContext`. When `deps.materialize` exists, flatten `retrievals.flatMap(result => result.contextGroups)` and use its `text`, `pageOrder`, `tokenCount`, and `truncated`; otherwise preserve the current context join and `maxContextChars` behavior exactly.

- [ ] **Step 4: Extract generation and retain the wrapper**

`generateRagAnswer` builds the existing system/user messages from a `RagRetrievalStage`, calls `generate`, and returns `RagGenerationStage`. `runRagPipeline` calls the two stages and maps their fields back to the existing `RagResult`, including its nested `timing`, plus optional page/token provenance. Existing app callers continue using `runRagPipeline` unchanged.

- [ ] **Step 5: Run all pipeline and chat-store tests**

Run: `npx vitest run src/tests/ragPipeline.test.ts src/tests/ragPipelineSemantic.test.ts src/tests/semanticTreeStore.test.ts`

Expected: PASS with existing product prompt behavior unchanged when no materializer is injected.

- [ ] **Step 6: Commit staged production flow**

```bash
git add src/utils/ragPipeline.ts src/tests/ragPipeline.test.ts src/tests/ragPipelineSemantic.test.ts src/stores/chat.ts
git commit -m "refactor: separate RAG retrieval and generation stages"
```

### Task 4: Preserve Page Pieces in Benchmark Candidates

**Files:**
- Modify: `bench/src/traditionalRag/types.ts`
- Modify: `bench/src/traditionalRag/chunker.ts`
- Modify: `bench/src/traditionalRag/context.ts`
- Modify: `bench/src/baselines/tokenStream.ts`
- Modify: `bench/src/baselines/contiguous.ts`
- Modify: `bench/src/runner/hybridRerankQa.ts`
- Modify: `bench/src/runner/longSectionQa.ts`
- Modify: `bench/src/tests/traditionalChunker.test.ts`
- Modify: `bench/src/tests/context.test.ts`
- Modify: `bench/src/tests/strongBaselines.test.ts`
- Modify: `bench/src/tests/strongRunners.test.ts`

**Interfaces:**
- Consumes: `ContextPiece` and `ContextGroup`.
- Produces: `BenchChunk.pieces`, `StreamPassage.pieces`, `ContiguousRegion.pieces`, and retrieval outcomes with `contextGroups`.

- [ ] **Step 1: Write failing candidate-provenance tests**

```ts
it('keeps exact page pieces inside a cross-page chunk', () => {
  const chunks = chunkPages(['a b', 'c d'], tokenizer, { chunkSize: 4, overlap: 0 })
  expect(chunks[0].pieces.map(piece => piece.page)).toEqual([0, 1])
  expect(chunks[0].pieces.map(piece => piece.text).join('')).toBe(chunks[0].text)
})

it('returns context groups in relevance order without applying a second budget', () => {
  const out = selectContext(chunks, ranked, { retrievalTopK: 10, topK: 2 })
  expect(out.contextGroups).toEqual([
    { pieces: chunks[ranked[0].id].pieces },
    { pieces: chunks[ranked[1].id].pieces },
  ])
})
```

- [ ] **Step 2: Run focused benchmark primitive tests**

Run: `npx vitest run bench/src/tests/traditionalChunker.test.ts bench/src/tests/context.test.ts bench/src/tests/strongBaselines.test.ts`

Expected: FAIL because candidate pieces and context groups are absent.

- [ ] **Step 3: Add reusable token-range-to-pieces conversion**

In `bench/src/baselines/tokenStream.ts`, add:

```ts
export function tokenRangeToPieces(tokens: PageToken[], start: number, end: number): ContextPiece[] {
  const pieces: ContextPiece[] = []
  for (let i = start; i < end; i++) {
    const pageBreak = i > start && tokens[i].page !== tokens[i - 1].page ? '\n' : ''
    const fragment = pageBreak + tokens[i].text.replaceAll('▁', ' ')
    const last = pieces.at(-1)
    if (last?.page === tokens[i].page) last.text += fragment
    else pieces.push({ page: tokens[i].page, text: fragment })
  }
  if (pieces.length > 0) {
    pieces[0].text = pieces[0].text.trimStart()
    pieces[pieces.length - 1].text = pieces[pieces.length - 1].text.trimEnd()
  }
  return pieces.filter(piece => piece.text.length > 0)
}
```

Use the same consecutive-page grouping in `chunkPages`, attaching the existing page-break newline to the first fragment of the new page. Trim only the beginning of the first piece and the end of the last piece, so `pieces.map(piece => piece.text).join('') === chunk.text` remains exact. Extend `BenchChunk`, `StreamPassage`, and `ContiguousRegion` with required `pieces: ContextPiece[]` fields.

- [ ] **Step 4: Change candidate selection to return groups**

Change `selectContext` to accept only `{ retrievalTopK, topK }`, preserve the current ranking, retrieval window, and top-K behavior, remove only the old whole-candidate budget stop, and return `contextGroups`. Traditional and hybrid runners will apply the common 4096-token materializer later, allowing the final candidate to be partially emitted as required by the design. Keep legacy `context` only until runner migration is complete within this plan.

Long-section keeps its centered-region algorithm and existing 4096-token expansion, but returns the region's page pieces so the common materializer remains the final enforcement point.

- [ ] **Step 5: Run all candidate and strong retrieval tests**

Run: `npx vitest run bench/src/tests/traditionalChunker.test.ts bench/src/tests/context.test.ts bench/src/tests/strongBaselines.test.ts bench/src/tests/strongRunners.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit benchmark provenance adapters**

```bash
git add bench/src/traditionalRag/types.ts bench/src/traditionalRag/chunker.ts bench/src/traditionalRag/context.ts bench/src/baselines/tokenStream.ts bench/src/baselines/contiguous.ts bench/src/runner/hybridRerankQa.ts bench/src/runner/longSectionQa.ts bench/src/tests/traditionalChunker.test.ts bench/src/tests/context.test.ts bench/src/tests/strongBaselines.test.ts bench/src/tests/strongRunners.test.ts
git commit -m "feat: preserve page provenance in benchmark candidates"
```

### Task 5: Versioned Evaluation Contract and Page Metrics

**Files:**
- Create: `bench/src/evaluationContract.ts`
- Modify: `bench/src/metrics/retrieval.ts`
- Modify: `bench/src/types.ts:123-234`
- Modify: `bench/src/tests/retrieval.test.ts`
- Create: `bench/src/tests/evaluationContract.test.ts`

**Interfaces:**
- Consumes: `EvalSample[]`, a run limit, `QaQuestion`, and final page order.
- Produces: constants for schema/tokenizer/budget, `buildEvaluationContract`, `isRetrievalEligible`, and `computeContextPageMetrics`.

- [ ] **Step 1: Replace candidate-MRR tests with final-page-order tests**

```ts
describe('computeContextPageMetrics', () => {
  it('uses the first gold page position in deduplicated prompt order', () => {
    expect(computeContextPageMetrics([4, 1, 7, 1], [7, 8])).toEqual({
      contextPageMrr: 1 / 3,
      evidenceRecall: 0.5,
      evidenceHit: 1,
      contextPrecision: 1 / 3,
    })
  })

  it('writes four zeros for an eligible miss', () => {
    expect(computeContextPageMetrics([], [2])).toEqual({
      contextPageMrr: 0,
      evidenceRecall: 0,
      evidenceHit: 0,
      contextPrecision: 0,
    })
  })
})

describe('isRetrievalEligible', () => {
  it.each([
    [{ unanswerable: true, evidencePages: [0] }, false],
    [{ unanswerable: false, evidencePages: [] }, false],
    [{ unanswerable: false, evidencePages: [0], evidenceMapping: 'ambiguous' }, false],
    [{ unanswerable: false, evidencePages: [0], evidenceMapping: 'unmapped' }, false],
    [{ unanswerable: false, evidencePages: [0], evidenceMapping: 'mapped' }, true],
  ])('applies the fixed eligibility contract', (partial, expected) => {
    expect(isRetrievalEligible({ id: 'q', question: 'q', answers: ['a'], ...partial })).toBe(expected)
  })
})
```

- [ ] **Step 2: Write evaluation-identity tests**

Assert that changing page content changes `datasetFingerprint`, changing eligible IDs changes `eligibleRetrievalQuestionIdsHash`, and two methods given the same samples/limit produce identical identity fields.

- [ ] **Step 3: Run metrics and identity tests and verify failures**

Run: `npx vitest run bench/src/tests/retrieval.test.ts bench/src/tests/evaluationContract.test.ts`

Expected: FAIL because the new functions do not exist.

- [ ] **Step 4: Implement fixed constants and fingerprints**

```ts
export const METRIC_SCHEMA_VERSION = 2 as const
export const MRR_DEFINITION = 'context-page-v1' as const
export const CONTEXT_BUDGET_TOKENS = 4096
export const CONTEXT_TOKENIZER_MODEL = 'BAAI/bge-m3'
export const CONTEXT_TOKENIZER_REVISION = 'main'
export const EVIDENCE_MAPPING_VERSION = 'page-evidence-v1'
```

Define the exact contract passed to every RAG runner:

```ts
export interface EvaluationContract {
  metricSchemaVersion: typeof METRIC_SCHEMA_VERSION
  mrrDefinition: typeof MRR_DEFINITION
  contextBudgetTokens: number
  contextTokenizer: string
  contextTokenizerRevision: string
  evidenceMappingVersion: string
  datasetFingerprint: string
  eligibleRetrievalQuestionIdsHash: string
  eligibleRetrievalQuestionCount: number
}
```

`buildEvaluationContract(samples, limit)` must select questions in the same paper/question order used by runners. For `datasetFingerprint`, hash a canonical array containing each executed question's `paperId`, source, full `pages`, question ID/text, answers, `evidencePages`, `unanswerable`, and `evidenceMapping`; this makes both corpus and annotation changes visible. Separately hash the exact ordered eligible question IDs for `eligibleRetrievalQuestionIdsHash`. Use `createHash('sha256').update(JSON.stringify(value)).digest('hex')`.

- [ ] **Step 5: Implement page-order metrics and remove new writes of legacy MRR**

```ts
export function computeContextPageMetrics(pageOrder: number[], evidencePages: number[]) {
  const ordered = [...new Set(pageOrder)]
  const evidence = new Set(evidencePages)
  const first = ordered.findIndex(page => evidence.has(page))
  const covered = ordered.filter(page => evidence.has(page)).length
  return {
    contextPageMrr: first < 0 ? 0 : 1 / (first + 1),
    evidenceRecall: evidence.size === 0 ? 0 : covered / evidence.size,
    evidenceHit: covered > 0 ? 1 : 0,
    contextPrecision: ordered.length === 0 ? 0 : covered / ordered.length,
  }
}
```

Keep `estimateTokens` and any page-span utility still used by legacy diagnostics, but delete `computeMrr` and stop accepting `scores/leaves/selected` in the new retrieval metric function.

- [ ] **Step 6: Extend result types**

Add optional schema-v2 fields for backward-compatible reading:

```ts
retrievalStatus?: 'completed' | 'failed' | 'ineligible'
generationStatus?: 'completed' | 'failed' | 'skipped'
judgeStatus?: 'completed' | 'failed' | 'skipped'
contextPageOrder?: number[]
contextTokenCount?: number
contextTruncated?: boolean
```

Add meta fields from the spec, including `datasetFingerprint`, `evidenceMappingVersion`, `metricSchemaVersion`, `mrrDefinition`, budget/tokenizer identity, eligible-ID hash, `comparisonEligible`, and `comparisonIneligibleReason`.

- [ ] **Step 7: Run focused tests and typecheck**

Run: `npx vitest run bench/src/tests/retrieval.test.ts bench/src/tests/evaluationContract.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 8: Commit the evaluation contract**

```bash
git add bench/src/evaluationContract.ts bench/src/metrics/retrieval.ts bench/src/types.ts bench/src/tests/retrieval.test.ts bench/src/tests/evaluationContract.test.ts
git commit -m "feat: define comparable context page metrics"
```

### Task 6: Stage the PaperMind and Semantic-Tree Benchmark Runner

**Files:**
- Modify: `bench/src/runner/qa.ts`
- Modify: `bench/src/runner/semanticTreeQa.ts`
- Modify: `bench/src/tests/qaRunner.test.ts`
- Modify: `bench/src/tests/semanticTreeQa.test.ts`

**Interfaces:**
- Consumes: `retrieveRagContext`, `generateRagAnswer`, injected `materialize`, and `EvaluationContract`.
- Produces: one per-question record with stable retrieval metrics before generation and schema-v2 result metadata.

- [ ] **Step 1: Add failing generation-failure and index-failure tests**

Replace the existing monolithic `runPipeline` fixture with staged fixtures and define the helpers in the test file before the cases:

```ts
const retrievalStage = (overrides: Partial<RagRetrievalStage> = {}): RagRetrievalStage => ({
  retrievals: [],
  retrievalQuery: 'Q1?',
  rewritten: false,
  context: 'CONTEXT_MARKER_9c2e',
  contextPageOrder: [0],
  contextTokenCount: 1,
  contextTruncated: false,
  sources: ['第 1 页'],
  llmCalls: 1,
  treeRouted: false,
  queryRewriteLatencyMs: 0,
  retrievalLatencyMs: 20,
  pipelineStartedAt: 0,
  ...overrides,
})

const stagedDeps = (overrides: Partial<QaTaskDeps> = {}): QaTaskDeps => ({
  buildIndex: vi.fn().mockResolvedValue(tree),
  retrieveContext: vi.fn().mockResolvedValue(retrievalStage()),
  generateAnswer: vi.fn().mockResolvedValue({
    answer: '8',
    answerGenerationLatencyMs: 30,
    queryEndToEndLatencyMs: 50,
  }),
  ...overrides,
})

const argsWith = (overrides: Partial<QaTaskArgs> = {}): QaTaskArgs => ({
  ...baseArgs,
  evaluationContract: buildEvaluationContract([sample]),
  materialize: groups => materializeContext(groups, tokenizer, 4096),
  deps: stagedDeps(),
  ...overrides,
})

it('keeps retrieval metrics when answer generation fails', async () => {
  const result = await runQaTask(argsWith({
    deps: {
      buildIndex: async () => tree,
      retrieveContext: async () => retrievalStage({ contextPageOrder: [3, 0] }),
      generateAnswer: async () => { throw new Error('generation failed') },
    },
  }))
  expect(result.perSample[0].metrics.contextPageMrr).toBe(0.5)
  expect(result.perSample[0].generationStatus).toBe('failed')
  expect(result.meta.completed).toBe(0)
  expect(result.errors).toContainEqual(expect.objectContaining({ stage: 'generate' }))
})

it('writes a zero retrieval observation for every eligible question after index failure', async () => {
  const result = await runQaTask(argsWith({
    deps: { buildIndex: async () => { throw new Error('bad index') } },
  }))
  expect(result.perSample[0].metrics).toMatchObject({
    contextPageMrr: 0, evidenceRecall: 0, evidenceHit: 0, contextPrecision: 0,
  })
  expect(result.perSample[0].retrievalStatus).toBe('failed')
})

it('keeps retrieval and answer metrics when judging fails', async () => {
  const badJudge = { ...fakeClient, complete: vi.fn().mockRejectedValue(new Error('judge failed')) }
  const result = await runQaTask(argsWith({ judgeClient: badJudge as never, judgeModel: 'judge-model' }))
  expect(result.perSample[0]).toMatchObject({
    retrievalStatus: 'completed',
    generationStatus: 'completed',
    judgeStatus: 'failed',
  })
  expect(result.perSample[0].metrics.contextPageMrr).toBe(1)
  expect(result.perSample[0].metrics.answerF1).toBe(1)
})
```

- [ ] **Step 2: Run PaperMind runner tests and verify failures**

Run: `npx vitest run bench/src/tests/qaRunner.test.ts bench/src/tests/semanticTreeQa.test.ts`

Expected: FAIL because the runner currently drops the whole record after generation failure and index failure.

- [ ] **Step 3: Refactor the runner into explicit stages**

Extend `QaTaskDeps` with the exact injectable stage names used by the tests:

```ts
export interface QaTaskDeps {
  buildIndex?: typeof buildPageIndex
  retrieveContext?: typeof retrieveRagContext
  generateAnswer?: typeof generateRagAnswer
}
```

Extend `QaTaskArgs` with required `materialize: (groups: ContextGroup[]) => MaterializedContext` and `evaluationContract: EvaluationContract`. The CLI supplies both for every RAG run; tests use the deterministic tokenizer fixture above. Update the older runner tests to assert calls to `retrieveContext` and `generateAnswer` rather than `runPipeline` while preserving their existing index-option, prompt, timing, answer, and judge assertions.

For each executed question:

1. Create the base record.
2. If index failed, attach four zero metrics for eligible questions and mark generation skipped.
3. Otherwise call `retrieveRagContext`, immediately store page metrics and retrieval diagnostics.
4. Call `generateRagAnswer`; update the existing record on success or mark generation failed on exception.
5. Run answer scoring after generation success, then run judge in its own guarded stage. A null/invalid/failed judge sets `judgeStatus: 'failed'` and leaves retrieval metrics, answer, and Answer F1 intact; a disabled judge sets `judgeStatus: 'skipped'`.

Do not let a generation exception delete the per-sample record. Set `meta.completed` from records whose `generationStatus === 'completed'`, while `meta.total` remains all attempted questions.

- [ ] **Step 4: Aggregate the fixed denominator**

Count `contextPageMrrSampleCount` from finite per-sample observations and set `contextPageMrrEligibleCount` from the injected evaluation contract. Throw an invariant error before returning when the two counts differ. Add the full contract fields to `meta`.

- [ ] **Step 5: Verify semantic-tree fallback uses actual materialized pages**

Add one test where tree routing degrades to a flat context with `contextPageOrder: [2]`; assert MRR is computed from `[2]` while `treeDegradationRate` remains `1`.

- [ ] **Step 6: Run runner tests and typecheck**

Run: `npx vitest run bench/src/tests/qaRunner.test.ts bench/src/tests/semanticTreeQa.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit staged PaperMind evaluation**

```bash
git add bench/src/runner/qa.ts bench/src/runner/semanticTreeQa.ts bench/src/tests/qaRunner.test.ts bench/src/tests/semanticTreeQa.test.ts
git commit -m "feat: preserve retrieval metrics across generation failures"
```

### Task 7: Stage the Traditional RAG Runner

**Files:**
- Modify: `bench/src/runner/traditionalRagQa.ts`
- Modify: `bench/src/tests/traditionalRagQa.test.ts`

**Interfaces:**
- Consumes: candidate `contextGroups`, injected materializer, evaluation contract, and common page metrics.
- Produces: the same schema-v2 per-sample and result contract as Task 6.

- [ ] **Step 1: Write failing traditional-runner contract tests**

Cover a selected cross-page chunk whose second page is cut by the common budget, a retrieval exception that writes zero, and a generation exception that preserves the computed MRR.

```ts
expect(result.perSample[0]).toMatchObject({
  contextPageOrder: [0],
  retrievalStatus: 'completed',
  generationStatus: 'failed',
  metrics: { contextPageMrr: 1, evidenceRecall: 1 },
})
```

- [ ] **Step 2: Run the traditional runner tests and verify failure**

Run: `npx vitest run bench/src/tests/traditionalRagQa.test.ts`

Expected: FAIL because the runner still computes metrics from `selected` spans and drops generation failures.

- [ ] **Step 3: Apply the common materializer and staged record flow**

Call `args.materialize(ctx.contextGroups)` immediately after retrieval. Use only its `text` in the answer system prompt and only its `pageOrder` for all four retrieval metrics. Remove candidate-ranking MRR inputs. Use the same completed/total, independently guarded judge stage, and denominator invariant defined in Task 6.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run bench/src/tests/traditionalRagQa.test.ts bench/src/tests/context.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add bench/src/runner/traditionalRagQa.ts bench/src/tests/traditionalRagQa.test.ts bench/src/tests/context.test.ts
git commit -m "feat: use final context metrics in traditional RAG"
```

### Task 8: Stage Strong Baselines and Make Checkpoints Stage-Aware

**Files:**
- Modify: `bench/src/runner/strongBaselineQa.ts`
- Modify: `bench/src/runner/hybridRerankQa.ts`
- Modify: `bench/src/runner/longSectionQa.ts`
- Modify: `bench/src/tests/strongRunners.test.ts`

**Interfaces:**
- Consumes: schema-v2 records, `MaterializedContext`, evaluation contract, provider/base-URL identity hash, prompt hash, and judge identity.
- Produces: stage-aware `StrongCheckpoint` version 2 that can resume generation from a saved retrieval context.

- [ ] **Step 1: Add failing checkpoint tests**

Add a direct `runStrongBaselineQaTask` fixture so retrieval call counts are observable. Define it locally rather than hiding experimental identity in an opaque helper:

```ts
const retrieve = vi.fn(async () => ({
  contextGroups: [{ pieces: [{ page: 0, text: 'alpha beta' }] }],
  retrievalLlmCalls: 0,
}))

const strongArgs = (checkpointPath: string): StrongBaselineQaArgs => ({
  samples: [sample],
  client,
  systemPrompt: 'system',
  gitSha: 'abc1234',
  model: 'answer-model',
  evaluationContract: buildEvaluationContract([sample]),
  materialize: groups => materializeContext(groups, tokenizer, 4096),
  llmEndpointIdentity: 'provider:endpoint-hash-a',
  systemPromptHash: 'prompt-hash-a',
  generationSettings: { maxTokens: 512, requestTimeoutMs: 30_000 },
  judgeEnabled: false,
  retrieval: {
    granularity: 'test passage',
    build: async () => ({ leafCount: 1, retrieve }),
  },
  meta: { retrievalAlgorithm: 'long-section-rag', baselineFamily: 'strong', config: longConfig },
  checkpointPath,
})

it('resumes generation from a saved retrieval-only checkpoint', async () => {
  await runStrongBaselineQaTask({
    ...strongArgs(checkpointPath),
    generateAnswer: async () => { throw new Error('generation failed') },
  })
  const resumed = await runStrongBaselineQaTask({
    ...strongArgs(checkpointPath),
    generateAnswer: async () => 'answer',
  })
  expect(retrieve).toHaveBeenCalledTimes(1)
  expect(resumed.meta.completed).toBe(1)
  expect(resumed.perSample[0].metrics.contextPageMrr).toBe(1)
})

it.each([
  ['judge model', { judgeModel: 'judge-b' }],
  ['endpoint identity', { llmEndpointIdentity: 'endpoint-b' }],
  ['system prompt hash', { systemPromptHash: 'prompt-b' }],
])('rejects checkpoint when %s changes', async (_label, change) => {
  retrieve.mockClear()
  await runStrongBaselineQaTask({
    ...strongArgs(checkpointPath),
    generateAnswer: async () => { throw new Error('generation failed') },
  })
  await runStrongBaselineQaTask({
    ...strongArgs(checkpointPath),
    ...change,
    generateAnswer: async () => 'answer',
  })
  expect(retrieve).toHaveBeenCalledTimes(2)
})
```

Wrap each case in the existing `mkdtempSync` / `try` / `finally` cleanup pattern so every test receives a fresh `checkpointPath`. Extend `StrongBaselineQaArgs` with the exact identity, materializer, and evaluation-contract fields used above; the CLI wiring in Task 9 supplies them in production.

- [ ] **Step 2: Run strong runner tests and verify failures**

Run: `npx vitest run bench/src/tests/strongRunners.test.ts`

Expected: FAIL because checkpoint version 1 stores only successful records and its signature omits experimental identity fields.

- [ ] **Step 3: Define checkpoint version 2**

```ts
interface StrongCheckpointEntry {
  record: PerSampleRecord
  pendingContext?: MaterializedContext
}

interface StrongCheckpoint {
  version: 2
  signature: string
  startedAt: string
  elapsedMs: number
  entries: StrongCheckpointEntry[]
  llmLatencies: number[]
  cacheHits: number
  cacheMisses: number
}
```

Include the entire evaluation contract (dataset fingerprint, eligible-ID hash, metric/MRR/evidence-mapping versions, context tokenizer/revision/budget), model, Git SHA, config, provider/base-URL identity hash, effective system-prompt hash, generation settings, judge enabled flag, and judge model in `checkpointSignature`. Do not include an API key.

- [ ] **Step 4: Persist retrieval before generation**

After materialization and metric computation, checkpoint `{ record, pendingContext }`. On generation success, replace it with `{ record }`. On resume, skip retrieval only when `pendingContext` exists and the signature matches; continue generation and judge from the saved text/page order.

- [ ] **Step 5: Enforce the same denominator invariant and meta contract**

Apply the same eligibility, zero-on-retrieval-failure, generated-completed count, independently guarded judge stage, and schema-v2 metadata rules used by Tasks 6 and 7.

- [ ] **Step 6: Run strong runner tests and commit**

Run: `npx vitest run bench/src/tests/strongRunners.test.ts bench/src/tests/strongBaselines.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add bench/src/runner/strongBaselineQa.ts bench/src/runner/hybridRerankQa.ts bench/src/runner/longSectionQa.ts bench/src/tests/strongRunners.test.ts bench/src/tests/strongBaselines.test.ts
git commit -m "feat: make strong baseline checkpoints stage-aware"
```

### Task 9: Wire the Controlled Contract Through the CLI and Full-Context Baseline

**Files:**
- Modify: `bench/src/cli.ts:177-255`
- Modify: `bench/src/config.ts:24-40`
- Modify: `bench/src/runner/fullContextQa.ts`
- Modify: `bench/src/traditionalRag/embedding.ts`
- Modify: `bench/src/tests/traditionalConfig.test.ts`
- Modify: `bench/src/tests/qaRunner.test.ts`
- Modify: `bench/src/tests/traditionalRagQa.test.ts`
- Modify: `bench/src/tests/strongRunners.test.ts`
- Modify: `bench/src/tests/report.test.ts`

**Interfaces:**
- Consumes: fixed constants, BGE-M3 tokenizer, `materializeContext`, and `buildEvaluationContract`.
- Produces: identical controlled context configuration for every RAG runner and explicit full-context comparison exclusion.

- [ ] **Step 1: Add a tokenizer identity fixture and full-context metadata test**

```ts
expect(fullContext.meta).toMatchObject({
  comparisonEligible: false,
  comparisonIneligibleReason: 'full-context-generation-ceiling',
  retrievalAlgorithm: 'none',
})
expect(fullContext.metrics.contextPageMrr).toBeUndefined()
```

- [ ] **Step 2: Run focused tests and verify missing metadata**

Run: `npx vitest run bench/src/tests/qaRunner.test.ts bench/src/tests/strongRunners.test.ts bench/src/tests/report.test.ts`

Expected: FAIL because CLI-injected contract fields and full-context exclusion are absent.

- [ ] **Step 3: Load one fixed tokenizer per QA source group**

Use:

```ts
const contextTokenizer = await createBgeM3Tokenizer({
  model: CONTEXT_TOKENIZER_MODEL,
  revision: CONTEXT_TOKENIZER_REVISION,
  cacheDir: benchPath(import.meta.url, '../cache/models/'),
})
const materialize = (groups: ContextGroup[]) =>
  materializeContext(groups, contextTokenizer, CONTEXT_BUDGET_TOKENS)
const evaluationContract = buildEvaluationContract(group, args.limit)
```

Construct these only for RAG mode. Compute endpoint identity from provider plus normalized base URL (never the API key), and hash the effective system prompt after language and fixed math instructions are applied. Pass `materialize`, `evaluationContract`, those hashes, judge identity, and generation settings to every RAG runner. Reuse an already-created retrieval tokenizer where the runtime exposes the same BGE-M3 tokenizer instance; do not load duplicate model weights.

Freeze traditional RAG's `generationContext.maxTokens` validation to `CONTEXT_BUDGET_TOKENS`, matching the already-frozen strong-baseline validation. Keep `generationContext.topK` as the method's candidate-selection control, but make the injected materializer the only final-budget enforcement. Update direct runner tests that currently use tiny config budgets to keep config at 4096 and inject a tiny deterministic materializer when testing truncation.

- [ ] **Step 4: Keep full-context outside the retrieval contract**

Do not load BGE-M3 solely for full-context. Preserve the full paper system prompt and add only comparison-ineligible metadata. Its Answer F1, judge, latency, and completion behavior remain unchanged.

- [ ] **Step 5: Run CLI-adjacent tests and typecheck**

Run: `npx vitest run bench/src/tests/traditionalConfig.test.ts bench/src/tests/qaRunner.test.ts bench/src/tests/traditionalRagQa.test.ts bench/src/tests/strongRunners.test.ts bench/src/tests/report.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit CLI wiring**

```bash
git add bench/src/cli.ts bench/src/config.ts bench/src/runner/fullContextQa.ts bench/src/traditionalRag/embedding.ts bench/src/tests/traditionalConfig.test.ts bench/src/tests/qaRunner.test.ts bench/src/tests/traditionalRagQa.test.ts bench/src/tests/strongRunners.test.ts bench/src/tests/report.test.ts
git commit -m "feat: enforce controlled benchmark context budget"
```

### Task 10: Add Comparison Gates and the Versioned Retrieval Report

**Files:**
- Modify: `bench/src/report.ts`
- Modify: `bench/src/tests/report.test.ts`

**Interfaces:**
- Consumes: schema-v2 result metadata and metrics.
- Produces: `retrievalComparisonIssues(a, b): string[]`, a versioned retrieval table, legacy MRR labeling, and refusal to calculate invalid deltas.

- [ ] **Step 1: Write failing comparison-gate tests**

Extend the existing `result(...)` fixture with a fully comparable schema-v2 helper:

```ts
function comparableResult(name: string, metaPatch: Partial<BenchResult['meta']> = {}): BenchResult {
  return result(name, {
    contextPageMrr: 0.5,
    contextPageMrrSampleCount: 122,
    contextPageMrrEligibleCount: 122,
    evidenceRecall: 0.6,
    evidenceHitRate: 0.7,
    contextPrecision: 0.4,
  }, {
    meta: {
      ...result(name, {}).meta,
      completed: 122,
      total: 122,
      metricSchemaVersion: 2,
      mrrDefinition: 'context-page-v1',
      contextBudgetTokens: 4096,
      contextTokenizer: 'BAAI/bge-m3',
      contextTokenizerRevision: 'main',
      evidenceMappingVersion: 'page-evidence-v1',
      datasetFingerprint: 'dataset-a',
      eligibleRetrievalQuestionIdsHash: 'eligible-a',
      comparisonEligible: true,
      ...metaPatch,
    },
  })
}

it.each([
  ['metric schema', { metricSchemaVersion: 1 }],
  ['MRR definition', { mrrDefinition: 'legacy-candidate-mrr' }],
  ['context budget', { contextBudgetTokens: 2048 }],
  ['tokenizer model', { contextTokenizer: 'other/tokenizer' }],
  ['tokenizer revision', { contextTokenizerRevision: 'other' }],
  ['eligible IDs', { eligibleRetrievalQuestionIdsHash: 'other' }],
  ['dataset', { datasetFingerprint: 'other' }],
  ['evidence mapping', { evidenceMappingVersion: 'other' }],
])('refuses Context Page MRR delta for mismatched %s', (_label, patch) => {
  const md = renderComparison(comparableResult('a'), comparableResult('b', patch))
  expect(md).toContain('不可比较')
  expect(md).not.toMatch(/contextPageMrr.*[+-]0\./)
})

it('allows deltas when every retrieval identity field and denominator match', () => {
  const md = renderComparison(comparableResult('a'), comparableResult('b'))
  expect(md).not.toContain('不可比较')
  expect(md).toContain('MRR (context-page-v1)')
})

it('refuses comparison when sample count is below eligible count', () => {
  const bad = comparableResult('b')
  bad.metrics.contextPageMrrSampleCount = 121
  bad.metrics.contextPageMrrEligibleCount = 122
  expect(renderComparison(comparableResult('a'), bad)).toContain('样本数')
})
```

- [ ] **Step 2: Add failing report-shape tests**

Assert the report contains a retrieval table with `MRR (context-page-v1)`, Recall, Hit Rate, Precision, eligible count, retrieval failures, and generation failures. Assert full-context appears in a separate generation-ceiling note and legacy `mrr` is labeled `Legacy candidate MRR`.

- [ ] **Step 3: Run report tests and verify failures**

Run: `npx vitest run bench/src/tests/report.test.ts`

Expected: FAIL because comparison gates and the dedicated table do not exist.

- [ ] **Step 4: Implement exact comparison checks**

```ts
export function retrievalComparisonIssues(a: BenchResult, b: BenchResult): string[] {
  const issues: string[] = []
  const fields: Array<keyof BenchResult['meta']> = [
    'datasetFingerprint', 'eligibleRetrievalQuestionIdsHash', 'metricSchemaVersion',
    'mrrDefinition', 'contextBudgetTokens', 'contextTokenizer',
    'contextTokenizerRevision', 'evidenceMappingVersion',
  ]
  for (const field of fields) {
    if (a.meta[field] !== b.meta[field]) issues.push(`${field} 不一致`)
  }
  for (const result of [a, b]) {
    if (result.meta.comparisonEligible !== true) issues.push(`${result.config.name} 不具备检索比较资格`)
    if (result.metrics.contextPageMrrSampleCount !== result.metrics.contextPageMrrEligibleCount) {
      issues.push(`${result.config.name} 的 Context Page MRR 样本数不完整`)
    }
  }
  return [...new Set(issues)]
}
```

When issues exist, print them and render `—` for deltas of the four controlled retrieval metrics. Other unrelated metrics may still display their raw values, but the report must not imply a valid retrieval comparison.

- [ ] **Step 5: Implement the retrieval table and legacy display**

Count failures from per-sample `retrievalStatus` and `generationStatus`, not only from aggregate error text. Exclude `comparisonEligible: false` results from the ranking table. Keep legacy results readable in a separate detail block and never bold them as the best new MRR.

- [ ] **Step 6: Run report tests and commit**

Run: `npx vitest run bench/src/tests/report.test.ts`

Expected: PASS.

```bash
git add bench/src/report.ts bench/src/tests/report.test.ts
git commit -m "feat: gate and report comparable retrieval metrics"
```

### Task 11: Cross-Method Contract Tests, Documentation, and Final Verification

**Files:**
- Create: `bench/src/tests/contextPageMrrContract.test.ts`
- Modify: `bench/README.md`
- Modify: `src/utils/CLAUDE.md`
- Modify: `bench/CLAUDE.md`

**Interfaces:**
- Consumes: all completed implementations.
- Produces: cross-method proof that identical final page order yields identical metrics, plus operator documentation.

- [ ] **Step 1: Add the cross-method contract test**

Build synthetic adapters representing PageIndex, traditional chunks, hybrid chunks, a long section, and semantic evidence blocks. Feed each through the shared materializer so all produce `[2, 5, 7]`, then assert:

```ts
const expected = {
  contextPageMrr: 0.5,
  evidenceRecall: 0.5,
  evidenceHit: 1,
  contextPrecision: 1 / 3,
}
for (const outcome of outcomes) {
  expect(computeContextPageMetrics(outcome.pageOrder, [5, 9])).toEqual(expected)
}
```

Also assert an eligible miss from each adapter produces all four zeros and contributes one observation.

- [ ] **Step 2: Run the contract test**

Run: `npx vitest run bench/src/tests/contextPageMrrContract.test.ts`

Expected: PASS.

- [ ] **Step 3: Update benchmark documentation**

Replace the old candidate-ranking MRR description with:

```markdown
**MRR (context-page-v1)**：对所有 evidence 映射明确的可回答题，按最终 4096-token
生成上下文中的去重页序查找首个 gold evidence 页；位于第 r 页单元时记 1/r，未命中、
索引失败或检索失败记 0。生成失败不删除已完成的检索观测。只有数据集指纹、有效题集合、
指标版本、BGE-M3 tokenizer revision 与上下文预算一致的结果才能计算横向差值。
```

Document that `full-context` is a generation ceiling, not a retrieval contestant. Remove text claiming tree-route MRR must be absent, and document legacy-result labeling.

- [ ] **Step 4: Update repository module notes**

Document `contextTrace.ts`, `EvidenceBlock.pieces`, schema version 2, staged RAG APIs, and the benchmark-controlled materializer in the relevant `CLAUDE.md` files. Do not rewrite unrelated guidance.

- [ ] **Step 5: Run the complete verification suite**

Run:

```bash
npm test
npm run typecheck
git diff --check
```

Expected:

- Vitest reports all test files passing.
- `vue-tsc --noEmit` exits 0.
- `git diff --check` exits 0 with no output.

- [ ] **Step 6: Inspect the final diff for generated or credential-bearing files**

Run:

```bash
git status --short
git diff --stat
git diff --check
```

Expected: only source, tests, and documentation from this plan are present; no `bench/cache`, result JSON, model files, databases, PDFs, or credentials appear.

- [ ] **Step 7: Commit the contract and documentation**

```bash
git add bench/src/tests/contextPageMrrContract.test.ts bench/README.md src/utils/CLAUDE.md bench/CLAUDE.md
git commit -m "test: verify comparable context page MRR"
```

- [ ] **Step 8: Run the credentialed full-QASPER acceptance matrix**

When the QASPER dataset, model cache, and benchmark LLM credentials are available, write outputs outside the repository and run every retrieval family plus the generation ceiling:

```bash
mkdir -p /private/tmp/papermind-context-page-mrr
npm run bench -- --task qa --dataset qasper --config default --out /private/tmp/papermind-context-page-mrr/papermind.json
npm run bench -- --task qa --dataset qasper --config semantic-tree --out /private/tmp/papermind-context-page-mrr/semantic-tree.json
npm run bench -- --task qa --dataset qasper --config rag-jaccard --out /private/tmp/papermind-context-page-mrr/jaccard.json
npm run bench -- --task qa --dataset qasper --config rag-bm25 --out /private/tmp/papermind-context-page-mrr/bm25.json
npm run bench -- --task qa --dataset qasper --config rag-cosine --out /private/tmp/papermind-context-page-mrr/cosine.json
npm run bench -- --task qa --dataset qasper --config hybrid-rerank --out /private/tmp/papermind-context-page-mrr/hybrid.json
npm run bench -- --task qa --dataset qasper --config long-section-rag --out /private/tmp/papermind-context-page-mrr/long-section.json
npm run bench -- --task qa --dataset qasper --mode full-context --out /private/tmp/papermind-context-page-mrr/full-context.json
```

For every RAG JSON, verify that `metricSchemaVersion`, `mrrDefinition`, tokenizer/revision, budget, `datasetFingerprint`, eligible-ID hash/count, and `contextPageMrrSampleCount` are identical, that every eligible per-sample MRR is finite and within `[0, 1]`, and that generation failures still retain retrieval fields. Run `--compare` for representative pairs and confirm deltas are emitted; compare any RAG result with full-context and confirm retrieval deltas are refused. Keep these generated results out of Git.
