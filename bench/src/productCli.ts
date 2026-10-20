import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { syntheticPdf, smokeDocling, smokeEmbedder } from '../product-fixtures/smoke'
import { runProductBenchmark, createProductModel, PRODUCT_SYSTEM_PROMPT, sha256, readDoclingInput, readExtractedInput, type ProductProfile, type ProductQuestion, type HashBoundInput } from './runner/product'
import { BGE_SMALL_MODEL, BGE_SMALL_DTYPE } from '../../src/utils/embedder'
import type { ChatTurn } from '../../src/utils/queryRewrite'

const HELP = `Product E-k5 / Docling shared-algorithm benchmark (not Electron UI/IPC).
  --smoke                                      offline synthetic PDF/vectors/model output
  --pdf FILE --question TEXT                    real PDF QA (repeat --question)
  --task qa|summary|all                         default all
  --questions-json FILE                        array {question,history?,referenceAnswers?,referencePages?}; pages 0-based
  --history-json FILE                          shared [{role:user|assistant,content}]
  --docling-json FILE                           {sourceSha256,document:<raw or normalized Docling>}
  --docling-url URL                             explicit remote convertPdf; no SSH/tunnel
  --extracted-json FILE                         optional {sourceSha256,document:{pages,layoutLines,outline}}
  --max-context-chars N                         default 120000 characters; overflow rejects
  --reference-summary FILE                      optional UTF-8 reference; report ROUGE-L
  --out FILE                                    save JSON (also stdout)
Real runs require BENCH_LLM_MODEL, BENCH_LLM_REVISION, BENCH_LLM_BASE_URL,
BENCH_LLM_API_KEY (OpenAI), BENCH_EMBEDDER_REVISION (immutable 40-hex commit),
BENCH_EMBEDDER_CACHE_DIR (preprovisioned); no automatic model downloads.
Optional BENCH_LLM_PROVIDER=openai|ollama, BENCH_PRODUCT_TEMPERATURE=0.7,
BENCH_PRODUCT_MAX_TOKENS=0, BENCH_PRODUCT_SYSTEM_PROMPT, BENCH_DOCLING_API_KEY.
`
function parse(argv: string[]) {
  const values = new Map<string, string[]>()
  const flags = new Set(['--smoke', '--help'])
  const named = new Set(['--pdf', '--title', '--question', '--task', '--questions-json', '--history-json', '--docling-json', '--docling-url', '--extracted-json', '--max-context-chars', '--reference-summary', '--out'])
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (flags.has(key)) { values.set(key, ['true']); continue }
    if (!named.has(key)) throw new Error(`未知参数：${key}`)
    const value = argv[++i]
    if (!value || value.startsWith('--')) throw new Error(`${key} 缺少值`)
    values.set(key, [...(values.get(key) ?? []), value])
  }
  return { get: (key: string) => values.get(key)?.at(-1), all: (key: string) => values.get(key) ?? [], keys: [...values.keys()] }
}
const json = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T
const requiredEnv = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`缺少环境变量 ${name}`); return value }
function history(value: unknown): ChatTurn[] {
  if (!Array.isArray(value) || value.some(item => !item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string')) throw new Error('history 必须是 user/assistant 消息数组')
  return value as ChatTurn[]
}
async function main() {
  const args = parse(process.argv.slice(2))
  if (args.get('--help')) { process.stdout.write(HELP); return }
  const smoke = !!args.get('--smoke')
  if (smoke && args.keys.some(key => !['--smoke', '--out'].includes(key))) throw new Error('--smoke 不能与真实输入/远程配置参数混用')
  const task = args.get('--task') ?? 'all'
  if (!['qa', 'summary', 'all'].includes(task)) throw new Error('--task 必须是 qa、summary 或 all')
  if (!smoke && !args.get('--pdf')) throw new Error('请提供 --pdf 或使用 --smoke')
  const pdfPath = args.get('--pdf')
  const pdfBytes = smoke ? syntheticPdf() : new Uint8Array(readFileSync(pdfPath!))
  if (!Buffer.from(pdfBytes.subarray(0, 1024)).includes(Buffer.from('%PDF-'))) throw new Error('输入文件不是 PDF')
  const sourceHash = sha256(pdfBytes)
  const extractedInput = args.get('--extracted-json') ? json<HashBoundInput>(args.get('--extracted-json')!) : undefined
  const doclingInput = smoke ? { sourceSha256: sourceHash, document: smokeDocling }
    : args.get('--docling-json') ? json<HashBoundInput>(args.get('--docling-json')!) : undefined
  if (extractedInput) readExtractedInput(extractedInput, sourceHash)
  if (doclingInput) readDoclingInput(doclingInput, sourceHash)
  if (!smoke && task !== 'qa' && !doclingInput && !args.get('--docling-url')) throw new Error('摘要需要 --docling-json 或显式 --docling-url')
  const sharedHistory = args.get('--history-json') ? history(json<unknown>(args.get('--history-json')!)) : []
  const questions: ProductQuestion[] = smoke ? [{ question: 'What method is used?', referencePages: [0] }]
    : [...args.all('--question').map(question => ({ question, history: sharedHistory })),
      ...(args.get('--questions-json') ? json<ProductQuestion[]>(args.get('--questions-json')!) : [])]
  if (!Array.isArray(questions) || questions.some(item => !item || typeof item.question !== 'string' || !item.question.trim()
    || item.history !== undefined && !history(item.history)
    || item.referencePages?.some(page => !Number.isInteger(page) || page < 0)
    || item.referenceAnswers?.some(answer => typeof answer !== 'string'))) throw new Error('问题 JSON 无效')
  if (task !== 'summary' && !questions.length) throw new Error('请提供 --question 或 --questions-json')
  const profile: ProductProfile = smoke ? { provider: 'openai', model: 'synthetic-fixed-output', revision: 'fixture-v1', baseUrl: 'http://synthetic.invalid', temperature: 0.7, maxTokens: 0, systemPrompt: PRODUCT_SYSTEM_PROMPT }
    : { provider: (process.env.BENCH_LLM_PROVIDER ?? 'openai') as ProductProfile['provider'], model: requiredEnv('BENCH_LLM_MODEL'), revision: requiredEnv('BENCH_LLM_REVISION'), baseUrl: requiredEnv('BENCH_LLM_BASE_URL'),
      temperature: Number(process.env.BENCH_PRODUCT_TEMPERATURE ?? 0.7), maxTokens: Number(process.env.BENCH_PRODUCT_MAX_TOKENS ?? 0), systemPrompt: process.env.BENCH_PRODUCT_SYSTEM_PROMPT ?? PRODUCT_SYSTEM_PROMPT }
  const model = smoke ? { complete: async () => 'What method uses lasers?', chat: async () => 'Our method uses lasers.', completion: async () => ({ content: '研究采用激光方法。{{cite:text-1-s1}}', truncated: false }) }
    : createProductModel(profile, profile.provider === 'ollama' ? '' : requiredEnv('BENCH_LLM_API_KEY'))
  const embedderStarted = performance.now()
  let embedder = smokeEmbedder
  let embedderRevision = smoke ? 'fixture-v1' : 'not-used-summary-only'
  if (!smoke && task !== 'summary') {
    embedderRevision = requiredEnv('BENCH_EMBEDDER_REVISION')
    if (!/^[a-f0-9]{40}$/.test(embedderRevision)) throw new Error('BENCH_EMBEDDER_REVISION 必须是不可变的 40 位 commit SHA')
    const cacheDir = resolve(requiredEnv('BENCH_EMBEDDER_CACHE_DIR'))
    const transformers = await import('@huggingface/transformers')
    transformers.env.allowRemoteModels = false
    const { createTransformersEmbedder } = await import('../../src/utils/transformersEmbedder')
    embedder = await createTransformersEmbedder({ model: BGE_SMALL_MODEL, revision: embedderRevision, dtype: BGE_SMALL_DTYPE, cacheDir })
  }
  const embedderInitMs = performance.now() - embedderStarted
  // pdfDocument sets its browser-relative worker URL on import; provide Node's installed worker.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href
  let gitSha = 'unknown'
  let dirty = true
  try { gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); dirty = !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() } catch { /* outside checkout */ }
  const doclingUrl = args.get('--docling-url')
  if (doclingInput && doclingUrl) throw new Error('--docling-json 和 --docling-url 只能选一个')
  const result = await runProductBenchmark({ pdfBytes, title: smoke ? 'Synthetic laser study' : args.get('--title') ?? basename(pdfPath!), synthetic: smoke,
    task: task as 'qa' | 'summary' | 'all', questions, profile, embedder, gitSha, dirty,
    packageVersion: json<{ version: string }>(fileURLToPath(new URL('../../package.json', import.meta.url))).version,
    pdfDeps: { loadDocument: async bytes => {
      const loading = pdfjs.getDocument({ data: bytes, standardFontDataUrl: dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')) + '/standard_fonts/' })
      const pdf = await loading.promise
      return { numPages: pdf.numPages, getPage: page => pdf.getPage(page), getOutline: () => pdf.getOutline(),
        getDestination: id => pdf.getDestination(id), getPageIndex: ref => pdf.getPageIndex(ref as Parameters<typeof pdf.getPageIndex>[0]), destroy: () => loading.destroy() }
    } },
    extractedInput, doclingInput, complete: model.complete, chat: model.chat, summaryCompletion: model.completion,
    maxContextChars: args.get('--max-context-chars') ? Number(args.get('--max-context-chars')) : undefined,
    referenceSummary: args.get('--reference-summary') ? readFileSync(args.get('--reference-summary')!, 'utf8') : undefined,
    convertDocling: doclingUrl ? async () => {
      const { convertPdf } = await import('../../electron/doclingClient')
      return convertPdf(pdfBytes, basename(pdfPath!), { baseUrl: doclingUrl, apiKey: process.env.BENCH_DOCLING_API_KEY ?? '', timeoutSeconds: 600, ocr: true, formula: true }, fetch,
        async () => { /* explicitly no managed SSH/tunnel: CLI connects only to supplied URL */ })
    } : undefined,
  })
  const output = JSON.stringify({ ...result, runtime: { embedderInitMs, embedderRevision, backend: smoke ? 'synthetic' : task === 'summary' ? 'not-used-summary-only' : 'node-onnx-local-files', applicationBackend: 'browser-wasm' } }, null, 2) + '\n'
  if (args.get('--out')) writeFileSync(args.get('--out')!, output)
  process.stdout.write(output)
  if (result.errors.length) process.exitCode = 1
}
main().catch(error => { process.stderr.write(`Product benchmark 失败：${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
