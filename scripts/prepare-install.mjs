import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXPECTED_ELECTRON, manifestErrors, readActualToolchain, toolchainErrors } from './lib/install-contract.mjs'
import { prepareElectron } from './lib/electron-install.mjs'
import { nativeProbeErrors, runNativeProbe } from './lib/native-verification.mjs'
import { electronSecurityErrors } from './lib/runtime-security.mjs'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const require = createRequire(import.meta.url)

function assertNoErrors(errors) {
  if (!errors.length) return
  throw new Error(errors.join('\n'))
}

function readRepositoryContract() {
  return {
    manifest: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')),
    lock: JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')),
    nvmrc: readFileSync(join(root, '.nvmrc'), 'utf8'),
    npmrc: readFileSync(join(root, '.npmrc'), 'utf8'),
  }
}

try {
  assertNoErrors(toolchainErrors(readActualToolchain()))
  assertNoErrors(manifestErrors(readRepositoryContract()))
  prepareElectron({ root })
  const result = runNativeProbe({
    executable: require('electron'),
    requireRoot: join(root, 'package.json'),
  })
  assertNoErrors([
    ...electronSecurityErrors(result, EXPECTED_ELECTRON),
    ...nativeProbeErrors(result),
  ])
  console.log(JSON.stringify(result))
  console.log('Install preparation passed')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
