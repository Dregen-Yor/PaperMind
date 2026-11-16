import { fileURLToPath } from 'node:url'
import { prepareElectron } from './lib/electron-install.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

try {
  const result = prepareElectron({ root })
  console.log(result.downloaded
    ? '[ensure-electron] Electron binary download completed'
    : '[ensure-electron] Electron binary is ready')
} catch (error) {
  console.error(`[ensure-electron] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
