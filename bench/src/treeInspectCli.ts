/**
 * 语义树人工结构检查 CLI（方案 §阶段 E 第 4 步）。
 *
 *   npm run bench:trees -- --config semantic-tree --dataset qasper --limit 5 --out bench/results/trees.md
 *
 * 自动指标能回答「树有多大」，回答不了「树是不是把目录换了个说法」。
 * 这个入口只建树、不跑问答，把树按层打印出来供人工判断。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from './args'
import { loadConfigs } from './config'
import { createLlmClient, resolveEnvConfig } from './llmClient'
import { loadQasperDataset } from './datasets/qasper'
import { loadSmokeDataset } from './datasets/smoke'
import { createSemanticTreeHook } from './runner/semanticTreeQa'
import { renderTreeReport, type TreeInspectionEntry } from './treeInspect'
import { benchPath } from './paths'
import type { EvalSample } from './types'

async function loadDatasets(which: string): Promise<EvalSample[]> {
  const out: EvalSample[] = []
  if (which === 'qasper' || which === 'all') out.push(...await loadQasperDataset())
  if (which === 'smoke' || which === 'all') out.push(...await loadSmokeDataset())
  if (out.length === 0) throw new Error(`数据集为空（--dataset ${which}）`)
  return out
}

const args = parseArgs(process.argv.slice(2))
const configs = await loadConfigs(args.config)
const config = configs[0]
const params = config.kind === 'semantic-tree' ? config.semanticTree : undefined
if (!params) {
  throw new Error(`${args.config} 不是语义树配置（缺少 semanticTree 参数块），无法做结构检查`)
}

const samples = await loadDatasets(args.dataset)
const limited = args.limit === undefined ? samples : samples.slice(0, args.limit)
const client = createLlmClient({ ...resolveEnvConfig(process.env), useCache: args.useCache })
const hook = createSemanticTreeHook({ params, client })

process.stdout.write(`对 ${limited.length} 篇论文建树（${config.name}）...\n`)
const entries: TreeInspectionEntry[] = []
for (const sample of limited) {
  const outcome = await hook(sample)
  entries.push(outcome.semantic
    ? { paperId: sample.paperId, outcome: outcome.semantic }
    : { paperId: sample.paperId, failure: 'build-failed' })
  process.stdout.write(`  ${sample.paperId}：${outcome.semantic ? '已建树' : '建树失败（该篇回落平面检索）'}\n`)
}

const report = renderTreeReport(entries)
const out = args.out ?? benchPath(import.meta.url, '../results/trees.md')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, report)
process.stdout.write(`检查报告已写入 ${out}\n`)
