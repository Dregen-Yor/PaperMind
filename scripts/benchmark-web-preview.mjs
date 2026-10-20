// Run one real Electron sample; use a fresh profile for cold measurements and
// reuse a profile across processes to measure persistent-cache revisits.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const [key, ...value] = arg.replace(/^--/, '').split('=')
  return [key, value.join('=') || 'true']
}))
if (!args.output) throw new Error('Required: --output=path.json')
const build = mkdtempSync(join(tmpdir(), 'papermind-preview-bench-'))
const source = resolve(args.source || root)
for (const path of ['electron/webPreview.ts', 'src/utils/webPreviewUrl.ts']) {
  let code = readFileSync(join(source, path), 'utf8')
  if (path === 'electron/webPreview.ts' && args.partition) {
    if (!/const PREVIEW_PARTITION = '[^']+'/.test(code)) throw new Error('Partition declaration not found')
    code = code.replace(/const PREVIEW_PARTITION = '[^']+'/, `const PREVIEW_PARTITION = ${JSON.stringify(args.partition)}`)
  }
  const destination = join(build, path.replace(/\.ts$/, '.js'))
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)
}
const config = {
  label: args.label || 'sample',
  url: args.url || 'https://niutrans.github.io/RL-without-Tears/reader.html',
  partition: args.partition || readFileSync(join(source, 'electron/webPreview.ts'), 'utf8')
    .match(/const PREVIEW_PARTITION = '([^']+)'/)[1],
  profile: resolve(args.profile || join(build, 'profile')),
  output: resolve(args.output),
  controller: join(build, 'electron/webPreview.js'),
  controllerSourceHash: createHash('sha256').update(readFileSync(join(source, 'electron/webPreview.ts'))).digest('hex'),
  timeoutMs: Number(args.timeout || 120000),
  preconnect: args.preconnect === 'true',
  http1: args.http1 === 'true',
  gpu: args.gpu === 'true',
  envProxy: args['env-proxy'] === 'true',
  imageConcurrency: Number(args['image-concurrency'] || 0),
  direct: args.direct === 'true',
}
mkdirSync(dirname(config.output), { recursive: true })
const configPath = join(build, 'config.json')
writeFileSync(configPath, JSON.stringify(config))
// Electron must stay in Electron mode even if the parent is itself an Electron app.
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(require('electron'), [join(root, 'scripts/web-preview-probe.cjs'), configPath], {
  env, stdio: 'inherit',
})
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
