import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { parseArgs } from './args'
import { prepareDataset, verifyManifest } from './localPdf/prepare'
import { runBenchmark, reportRun } from './localPdf/run'
import { initializeRuntime } from './localPdf/runtime'
import { scoreOfficial, evaluatorHash } from './localPdf/scoring'
import { renderReport } from './localPdf/report'
import { safeError } from './localPdf/errors'
import { requireThat } from './localPdf/contract'
export interface CliDeps {
  prepare: typeof prepareDataset; run: typeof runBenchmark; report: typeof reportRun
  runtime: typeof initializeRuntime; stdout: (s: string) => void; stderr: (s: string) => void
}
const defaults: CliDeps = { prepare: prepareDataset, run: runBenchmark, report: reportRun, runtime: initializeRuntime, stdout: s => process.stdout.write(s), stderr: s => process.stderr.write(s) }
export async function main(argv: string[], deps: CliDeps = defaults): Promise<number> {
  try {
    const args = parseArgs(argv)
    if (args.command === 'prepare') {
      const m = await deps.prepare(args)
      deps.stdout(`Prepared ${m.papers.length} PDFs / ${m.questions.length} questions (${m.split}${m.subset ? ', development subset' : ', local-PDF subset'}).\nManifest: ${args.out}\n`)
      return 0
    }
    if (args.command === 'report') {
      const summary = await deps.report(args.run)
      deps.stdout(renderReport(summary))
      return summary.header.status === 'completed' ? 0 : 1
    }
    const exists = await lstat(args.out).catch(e => { if (e.code === 'ENOENT') return null; throw e })
    requireThat(!exists, 'Run output already exists; choose a new directory')
    await verifyManifest(args.manifest); evaluatorHash()
    await mkdir(dirname(resolve(args.out)), { recursive: true })
    let runtime: Awaited<ReturnType<typeof initializeRuntime>>
    deps.stderr(`[${new Date().toISOString()}] initializing runtime\n`)
    try { runtime = await deps.runtime(process.env, args.methods) }
    catch (error) {
      // No metric identity exists yet: persist a failed launch, not fabricated run scores.
      await mkdir(args.out)
      await writeFile(join(args.out, 'launch-error.json'), JSON.stringify({ status: 'failed', stage: 'initialize', error: safeError(error) }) + '\n', { flag: 'wx' })
      throw error
    }
    const summary = await deps.run(args.manifest, args.methods, args.out, { runtime, now: () => performance.now(), score: scoreOfficial, progress: message => deps.stderr(`[${new Date().toISOString()}] ${message}\n`) })
    deps.stdout(renderReport(summary))
    return summary.header.status === 'failed' ? 1 : 0
  } catch (error) { deps.stderr(`${safeError(error)}\n`); return 1 }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then(code => { process.exitCode = code })
}
