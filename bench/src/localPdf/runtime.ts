import { readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createLlmClient, resolveEnvConfig } from '../llmClient'
import { createTransformersEmbedder } from '../../../src/utils/transformersEmbedder'
import { createBgeM3Tokenizer } from './tokenizer'
import { resolveQaAnswerOptions } from './generationOptions'
import { hashCanonical, requireThat } from './contract'
import { fileIdentity } from './prepare'
import { RETRIEVAL_CONFIG, type MethodDeps } from './methods'
import type { FileIdentity, Method, RunIdentity } from './types'
import { TOC_TREE_CONFIG_SHA256 } from './tocTree'
import { TOC_ROUTING_CONFIG_SHA256, TOC_ROUTING_PROMPT_VERSION } from './tocRouting'
export const ANSWER_PROMPT = 'Answer the question in concise English using only the provided paper text. If the paper does not provide the answer, respond exactly Unanswerable. For yes/no questions respond Yes or No. Do not add citations or repeat the question.'
export type RuntimeIdentity = Omit<RunIdentity, 'manifestFingerprint' | 'gitSha' | 'evaluatorSha256'>
async function modelFiles(dir: string): Promise<FileIdentity[]> {
  const out: FileIdentity[] = []
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await modelFiles(path))
    else if (entry.isFile() && /\.(json|onnx|model|txt)$/.test(entry.name)) out.push(await fileIdentity(path))
  }
  return out
}
export async function initializeRuntime(env: Record<string, string | undefined>, methods: Method[]) {
  const config = resolveEnvConfig(env); const generation = resolveQaAnswerOptions(env)
  const client = createLlmClient({ ...config, ...generation, useCache: false })
  const cacheDir = resolve(env.BENCH_MODEL_CACHE_DIR ?? 'bench/cache/models')
  const endpoint = new URL(config.baseUrl)
  endpoint.username = ''; endpoint.password = ''; endpoint.search = ''; endpoint.hash = ''
  if (['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) requireThat(env.BENCH_EXECUTION_BACKEND, 'local model requires BENCH_EXECUTION_BACKEND')
  const deps: MethodDeps = { countTokens: () => { throw new Error('R has no retrieval tokenizer') } }
  const files: FileIdentity[] = []
  if (methods.some(m => m !== 'R')) {
    const tokenizer = await createBgeM3Tokenizer(cacheDir)
    deps.countTokens = tokenizer.countTokens
    deps.countTokens('Benchmark warmup.')
    const tokenFiles = await modelFiles(join(cacheDir, 'BAAI/bge-m3'))
    requireThat(tokenFiles.some(f => f.path.endsWith('tokenizer.json')), 'tokenizer files missing from cache')
    files.push(...tokenFiles)
  }
  if (methods.includes('D')) deps.routeToc = prompt => client.complete(prompt)
  if (methods.some(m => m === 'B' || m === 'C')) {
    deps.embedder = await createTransformersEmbedder({ model: 'Xenova/bge-small-en-v1.5', revision: 'main', dtype: 'q8', dim: 384, cacheDir })
    await deps.embedder.embedQuery('Benchmark warmup.')
    const embeddingFiles = await modelFiles(join(cacheDir, 'Xenova/bge-small-en-v1.5'))
    requireThat(embeddingFiles.some(f => f.path.endsWith('.onnx')), 'embedding model files missing from cache')
    files.push(...embeddingFiles)
  }
  const identity: RuntimeIdentity = {
    configSha256: hashCanonical(RETRIEVAL_CONFIG),
    generationSha256: hashCanonical({ ...generation, model: config.model, provider: config.provider, prompt: ANSWER_PROMPT, streaming: true, cache: false, concurrency: 1 }),
    endpointSha256: hashCanonical(endpoint.toString()),
    environmentSha256: hashCanonical({ platform: process.platform, arch: process.arch, node: process.version, backend: env.BENCH_EXECUTION_BACKEND ?? 'node' }),
    modelFiles: files,
    ...(methods.includes('D') ? {
      tocTreeSha256: TOC_TREE_CONFIG_SHA256,
      tocRoutingSha256: hashCanonical({
        config: TOC_ROUTING_CONFIG_SHA256,
        promptVersion: TOC_ROUTING_PROMPT_VERSION,
        generation,
        model: config.model,
        provider: config.provider,
        cache: false,
      }),
    } : {}),
  }
  return { client, methodDeps: deps, identity }
}
