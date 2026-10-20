import { createHash } from 'node:crypto'
import { buildEk5Index } from '../../../src/utils/ek5/index'
import { extractPdfDocument, type ExtractedPdfDocument, type PdfDocumentDeps } from '../../../src/utils/pdfDocument'
import { retrieveRagContext, generateRagAnswer } from '../../../src/utils/ragPipeline'
import { abstractRunKey, generateDoclingAbstract, type AbstractLLM } from '../../../src/utils/doclingAbstract'
import { isParsedDocument, normalizeDoclingDocument, type ParsedDocument } from '../../../src/utils/doclingDocument'
import type { Embedder } from '../../../src/utils/embedder'
import type { ChatTurn } from '../../../src/utils/queryRewrite'
import type { ChatMessage } from '../../../src/utils/llm'
import { answerF1 } from '../metrics/answerF1'
import { rougeL } from '../metrics/rouge'
import { createLlmClient, type LlmClientOptions } from '../llmClient'

export const PRODUCT_SYSTEM_PROMPT = '你是一个专业的学术论文阅读助手，帮助用户理解和分析论文内容。'
export const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export interface ProductQuestion { question: string; history?: ChatTurn[]; referenceAnswers?: string[]; referencePages?: number[] }
export interface ProductProfile { provider: 'openai' | 'ollama'; model: string; revision: string; baseUrl: string; temperature: number; maxTokens: number; systemPrompt: string }
export interface HashBoundInput { sourceSha256: string; document: unknown }
export function assertSourceBinding(value: HashBoundInput, pdfSha256: string) {
  if (!value || value.sourceSha256 !== pdfSha256) throw new Error('输入 JSON 的 sourceSha256 与原始 PDF 不一致')
}
export function readDoclingInput(value: HashBoundInput, pdfSha256: string): ParsedDocument {
  assertSourceBinding(value, pdfSha256)
  const document = isParsedDocument(value.document) ? value.document : normalizeDoclingDocument(value.document)
  if (!document.items.length) throw new Error('Docling JSON 没有可用文档内容')
  return document
}
export function readExtractedInput(value: HashBoundInput, pdfSha256: string): ExtractedPdfDocument {
  assertSourceBinding(value, pdfSha256)
  const doc = value.document as ExtractedPdfDocument
  if (!doc || !Array.isArray(doc.pages) || !doc.pages.length || !doc.pages.every(page => typeof page === 'string')
    || !Array.isArray(doc.outline) || !Array.isArray(doc.layoutLines)) throw new Error('提取文档 JSON 格式无效')
  return doc
}

// Reuse the benchmark transport with product message roles and explicit profile parameters.
// Native Anthropic/reasoning-model adapters are deliberately rejected instead of mislabeled.
export function createProductModel(profile: ProductProfile, apiKey: string, fetchImpl: typeof fetch = fetch) {
  if (!['openai', 'ollama'].includes(profile.provider)) throw new Error('产品 benchmark 暂仅支持 OpenAI compatible / Ollama，不支持 Anthropic')
  if (!profile.model || !profile.revision) throw new Error('必须显式记录模型名称和 revision')
  if (/^(o[1-9]|gpt-[5-9])/i.test(profile.model.trim().split('/').pop() ?? '')) throw new Error('当前 benchmark transport 不支持该推理模型的产品参数协议')
  if (!Number.isFinite(profile.temperature) || profile.temperature < 0 || profile.temperature > 2
    || !Number.isInteger(profile.maxTokens) || profile.maxTokens < 0) throw new Error('生成参数无效；maxTokens 使用 0 表示不设上限')
  const endpoint = new URL(profile.baseUrl)
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['http:', 'https:'].includes(endpoint.protocol)) throw new Error('模型端点不能含凭据或查询参数')
  let truncated = false
  const observedFetch: typeof fetch = async (url, init) => {
    const response = await fetchImpl(url, init)
    if (response.ok) {
      const data = await response.clone().json() as { choices?: { finish_reason?: string }[]; done_reason?: string }
      truncated = profile.provider === 'ollama' ? data.done_reason === 'length' : data.choices?.[0]?.finish_reason === 'length'
    }
    return response
  }
  const options: LlmClientOptions = {
    provider: profile.provider, model: profile.model, apiKey, baseUrl: profile.baseUrl,
    temperature: profile.temperature, ...(profile.maxTokens > 0 ? { maxTokens: profile.maxTokens } : {}),
    useCache: false, retryAttempts: 0, timeoutMs: 300000, fetchImpl: observedFetch,
  }
  const client = createLlmClient(options)
  const rewriteClient = createLlmClient({ ...options, timeoutMs: 120000 })
  const completion: AbstractLLM = async messages => {
    truncated = false
    try {
      const content = await client.chat(messages)
      return { content, truncated }
    } catch (error) {
      if (error instanceof Error) error.message = error.message.replace(/LLM 请求失败 (\d+):/, 'LLM 请求失败 ($1)：')
      throw error
    }
  }
  return { completion, chat: client.chat, complete: rewriteClient.complete }
}

export interface ProductRunArgs {
  pdfBytes: Uint8Array
  title: string
  synthetic: boolean
  task: 'qa' | 'summary' | 'all'
  questions: ProductQuestion[]
  profile: ProductProfile
  embedder: Embedder
  gitSha: string
  dirty: boolean
  packageVersion: string
  pdfDeps?: PdfDocumentDeps
  extractedInput?: HashBoundInput
  doclingInput?: HashBoundInput
  convertDocling?: () => Promise<ParsedDocument>
  complete: (prompt: string) => Promise<string>
  chat: (messages: ChatMessage[]) => Promise<string>
  summaryCompletion: AbstractLLM
  maxContextChars?: number
  referenceSummary?: string
}

export async function runProductBenchmark(args: ProductRunArgs) {
  const pdfSha256 = sha256(args.pdfBytes)
  const started = performance.now()
  const document = args.extractedInput ? readExtractedInput(args.extractedInput, pdfSha256)
    : await extractPdfDocument(Buffer.from(args.pdfBytes).toString('base64'), args.pdfDeps)
  const extractionMs = performance.now() - started
  const maxContextChars = args.maxContextChars ?? 120000
  if (!Number.isInteger(maxContextChars) || maxContextChars <= 0) throw new Error('上下文字符预算必须是正整数')
  const result = {
    schema: 'product-pipeline-bench-v1', synthetic: args.synthetic,
    identity: {
      gitSha: args.gitSha, dirty: args.dirty, packageVersion: args.packageVersion, node: process.version,
      retrieval: 'ek5-product-v1', summary: 'docling-abstract-v6', embedder: args.task === 'summary' ? 'not-used-summary-only' : args.embedder.id,
      productEmbedderDefault: 'Xenova/bge-small-en-v1.5@main#q8',
      profile: args.profile, budget: { unit: 'characters', max: maxContextChars },
      transport: args.synthetic ? 'synthetic-injected' : 'bench-nonstreaming-product-parameters',
      requestPolicy: { cache: false, concurrency: 1, transportRetries: 0, rewriteTimeoutMs: 120000, answerTimeoutMs: 300000, summaryTimeoutMs: 300000, topK: 0 },
    },
    source: { pdfSha256, pageCount: document.pages.length,
      extraction: args.extractedInput ? 'provided-extracted-document' : args.synthetic ? 'shared-pdfjs-extraction-synthetic-pdf' : 'shared-pdfjs-extraction',
      extractedDocumentSha256: sha256(JSON.stringify(document)), docling: 'not-requested', doclingJsonSha256: '' },
    timing: { extractionMs, coldIndexMs: 0, summaryMs: 0 },
    index: null as null | { sourceTextSha256: string; totalLeaves: number; unlocated: string[]; ambiguous: string[]; fallback: string[]; excludedSourceCharacters: number },
    qa: [] as Array<{ question: string; answer?: string; error?: string; retrieval: { query: string; rewritten: boolean; sources: string[]; hitPages: number[]; selectedLeaves: string[]; leafCoverage: number; contextChars: number; contextTruncated: boolean; warmQueryMs: number }; generationMs?: number; metrics?: Record<string, number> }>,
    summary: null as null | { content: string; sources: unknown[]; truncated: boolean; runKey: string; metrics?: { rougeL: number } },
    errors: [] as Array<{ stage: string; message: string }>,
    limitations: [
      'Measures shared algorithm pipeline; Electron IPC, persistence, PDF rendering and image crop supplementation are not exercised.',
      'Nonstreaming transport: no UI/streaming TTFT claim; model/endpoint revision is operator-declared, not remotely attested. Pinned Node embedding weights/backend may differ from product main/WASM.',
      'Provided JSON hashes bind operator-supplied inputs to PDF identity; they do not independently verify parser correctness.',
      ...(args.synthetic ? ['synthetic fixture / fake vectors / fixed model output: connectivity smoke only, not a quality endorsement.'] : []),
    ],
  }
  if (args.task !== 'summary') {
    if (!args.questions.length) throw new Error('QA 需要至少一个问题')
    const indexStarted = performance.now()
    const ek5 = await buildEk5Index(pdfSha256, document, args.embedder)
    result.timing.coldIndexMs = performance.now() - indexStarted
    const groups = ek5.groups
    result.index = { sourceTextSha256: ek5.sourceSha256, totalLeaves: groups.groups.length, unlocated: groups.unlocatedNodeIds,
      ambiguous: groups.ambiguousNodeIds, fallback: groups.fallbackNodeIds, excludedSourceCharacters: groups.excludedSourceCharacters }
    for (const item of args.questions) {
      try {
        const queryStart = performance.now()
        const stage = await retrieveRagContext([{ ek5, pages: document.pages, paperLabel: args.title,
          tree: { nodeId: 'unused-ek5', title: args.title, summary: '', startPage: 0, endPage: document.pages.length - 1, nodes: [] } }],
        item.question, item.history ?? [], args.complete, { retrievalMode: 'ek5', maxContextChars }, { passage: { embedder: args.embedder } })
        const selectedLeaves = stage.retrievals.flatMap(r => r.selected.map(node => node.nodeId))
        const hitPages = [...new Set(groups.groups.filter(group => selectedLeaves.includes(group.nodeId)).flatMap(group => group.ranges.map(range => range.page)))].sort((a, b) => a - b)
        const record: typeof result.qa[number] = { question: item.question, retrieval: {
          query: stage.retrievalQuery, rewritten: stage.rewritten, sources: stage.sources, hitPages, selectedLeaves,
          leafCoverage: selectedLeaves.length / groups.groups.length, contextChars: stage.context.length,
          contextTruncated: stage.contextTruncated, warmQueryMs: performance.now() - queryStart,
        } }
        result.qa.push(record)
        if (item.referencePages?.length) record.metrics = { pageRecall: item.referencePages.filter(p => hitPages.includes(p)).length / item.referencePages.length }
        try {
          const answer = await generateRagAnswer(stage, item.question, item.history ?? [], args.chat, args.profile.systemPrompt)
          record.answer = answer.answer
          record.generationMs = answer.answerGenerationLatencyMs
          if (item.referenceAnswers?.length) record.metrics = { ...record.metrics, answerF1: answerF1(answer.answer, item.referenceAnswers) }
        } catch (error) {
          record.error = error instanceof Error ? error.message : String(error)
          result.errors.push({ stage: 'generation', message: record.error })
        }
      } catch (error) { result.errors.push({ stage: 'retrieval', message: error instanceof Error ? error.message : String(error) }) }
    }
  }
  if (args.task !== 'qa') {
    const summaryStarted = performance.now()
    try {
      const parsed = args.doclingInput ? readDoclingInput(args.doclingInput, pdfSha256) : await args.convertDocling?.()
      if (!parsed) throw new Error('摘要需要 --docling-json 或显式 --docling-url')
      if (parsed.items.some(item => item.pages.some(page => page >= document.pages.length))) throw new Error('Docling 页码超出 PDF 页数')
      result.source.docling = args.doclingInput ? 'provided-json' : 'remote-convertPdf-no-ssh'
      result.source.doclingJsonSha256 = sha256(JSON.stringify(args.doclingInput?.document ?? parsed))
      const profileIdentity = JSON.stringify(args.profile)
      const runKey = await abstractRunKey(parsed, args.title, profileIdentity, '')
      const summary = await generateDoclingAbstract(parsed, pdfSha256, args.title, messages => {
        const configured = messages.map(message => ({ ...message }))
        configured[0].content = args.profile.systemPrompt + '\n\n' + configured[0].content
        return args.summaryCompletion(configured)
      })
      result.summary = { ...summary, runKey, ...(args.referenceSummary ? { metrics: { rougeL: rougeL(summary.content, args.referenceSummary) } } : {}) }
    } catch (error) { result.errors.push({ stage: 'summary', message: error instanceof Error ? error.message : String(error) }) }
    result.timing.summaryMs = performance.now() - summaryStarted
  }
  return result
}
