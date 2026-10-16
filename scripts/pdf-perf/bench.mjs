import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const server = await createServer({ root, configFile: false, plugins: [vue()], optimizeDeps: { exclude: ['pdfjs-dist'] }, server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const address = server.httpServer.address()
const url = `http://127.0.0.1:${address.port}/scripts/pdf-perf/harness.html`
const runs = Number(process.argv[2] ?? 3)

try {
  const results = []
  for (let index = 0; index < runs; index++) {
    const result = await new Promise((resolveRun, reject) => {
      const child = spawn(process.execPath, [resolve(import.meta.dirname, 'runner.mjs'), url], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      let errors = ''
      child.stdout.on('data', chunk => { output += chunk })
      child.stderr.on('data', chunk => { errors += chunk })
      child.stderr.on('data', chunk => { if (process.env.PDF_BENCH_VERBOSE) process.stderr.write(chunk) })
      child.on('exit', code => {
        if (code !== 0) reject(new Error(`Browser benchmark exited ${code}: ${errors}`))
        else {
          try { resolveRun(JSON.parse(output.trim().split('\n').at(-1))) }
          catch { reject(new Error(`Invalid benchmark output: ${output}\n${errors}`)) }
        }
      })
      child.on('error', reject)
    })
    if (result.error) throw new Error(result.error)
    results.push(result)
  }
  process.stdout.write(`${JSON.stringify({ runs: results }, null, 2)}\n`)
} finally {
  await server.close()
}
