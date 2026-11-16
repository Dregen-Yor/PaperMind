import { readFileSync } from 'node:fs'
import { manifestErrors } from './lib/install-contract.mjs'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'))
const nvmrc = readFileSync(new URL('.nvmrc', root), 'utf8')
const npmrc = readFileSync(new URL('.npmrc', root), 'utf8')
const errors = manifestErrors({ manifest, lock, nvmrc, npmrc })

if (errors.length) {
  for (const error of errors) console.error(error)
  process.exitCode = 1
} else {
  console.log('Manifest verification passed')
}
