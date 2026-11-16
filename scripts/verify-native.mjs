import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { electronSecurityErrors } from './lib/runtime-security.mjs'
import { nativeProbeErrors, runNativeProbe } from './lib/native-verification.mjs'

const require = createRequire(import.meta.url)
const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const executable = require('electron')
const result = runNativeProbe({ executable, requireRoot: join(root, 'package.json') })
const errors = [
  ...electronSecurityErrors(result, manifest.devDependencies.electron),
  ...nativeProbeErrors(result),
]

console.log(JSON.stringify(result))
if (errors.length) {
  for (const error of errors) console.error(error)
  process.exitCode = 1
} else {
  console.log('Native dependency verification passed')
}
