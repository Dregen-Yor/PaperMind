import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const forbidden = [
  /doclingTunnel|ensureManagedDoclingTunnel|stopManagedDoclingTunnel/,
  /SSH_HOST|ExitOnForwardFailure|ServerAliveInterval/,
  /http:\/\/(?:127\.0\.0\.1|localhost):5001/,
  /101\.76\.222\.(?:151|224)/,
]

const productionFiles = [
  'electron/main.ts',
  'electron/doclingClient.ts',
  'electron/docling.ts',
  'electron/summaryParsing.ts',
  'electron/ipc.ts',
  'src/utils/doclingConfig.ts',
  'src/utils/doclingDocument.ts',
  'src/stores/chat.ts',
  'src/views/SettingsView.vue',
]

const userDocumentation = [
  'README.md',
  'bench/README.md',
  'docs/testing/docling-abstract.md',
  'docs/testing/parsed-material-summary.md',
  'docs/testing/review-completion.md',
  'docs/testing/runtime-security-2026-10-22.md',
]

test('production Docling uses only the official service contract', () => {
  for (const file of productionFiles) {
    const source = readFileSync(file, 'utf8')
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${file}: ${pattern}`)
  }
})

test('the settings view exposes only API-key controls', () => {
  const source = readFileSync('src/views/SettingsView.vue', 'utf8')
  assert.match(source, /docling-api-key/)
  assert.doesNotMatch(source, /docling-base-url|docling-timeout|docling-ocr|docling-formula|docling-table/)
})

test('user documentation does not advertise legacy Docling deployment paths', () => {
  for (const file of userDocumentation) {
    const source = readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /101\.76\.222\.|127\.0\.0\.1:5001|--docling-url|可改填其他服务根地址/, file)
  }
})
