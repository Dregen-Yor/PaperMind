import { readActualToolchain, toolchainErrors } from './lib/install-contract.mjs'

const actual = readActualToolchain()
const errors = toolchainErrors(actual)

if (actual.platform === 'win32') {
  const build = Number(actual.release.split('.')[2])
  if (Number.isInteger(build) && build < 22000) {
    console.warn(`Windows best-effort support: expected=Windows 11 build >=22000 actual=${actual.release}`)
  }
}

console.log(JSON.stringify(actual))
if (errors.length) {
  for (const error of errors) console.error(error)
  process.exitCode = 1
} else {
  console.log('Toolchain verification passed')
}
