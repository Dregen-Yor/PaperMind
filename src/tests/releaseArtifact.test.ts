// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

describe('release artifact names', () => {
  it.each([
    ['win32-x64', 'exe'], ['darwin-x64', 'dmg'], ['darwin-arm64', 'dmg'], ['linux-x64', 'AppImage'],
  ])('keeps the app prefix and version for %s', (platform, extension) => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8')
    const step = workflow.split('      - name: Rename artifacts\n')[1].split('\n      - name: Upload artifact')[0]
    const script = step.split('        run: |\n')[1].split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n')
      .replaceAll('${{ matrix.name }}', platform)
    const root = mkdtempSync(join(tmpdir(), 'papermind-release-'))
    try {
      mkdirSync(join(root, 'release'))
      writeFileSync(join(root, 'release', `builder output.${extension}`), 'installer fixture')
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'papermind', version: '0.1.0' }))
      const environment: NodeJS.ProcessEnv = { ...process.env, GITHUB_REF_NAME: 'v0.1.0', GITHUB_ENV: join(root, 'github-env') }
      delete environment.app
      execFileSync('bash', ['-e', '-c', script], { cwd: root, env: environment })
      const artifact = `papermind-v0.1.0-${platform}.${extension}`
      const checksum = `${artifact}.sha256`
      expect(readdirSync(join(root, 'release')).sort()).toEqual([artifact, checksum])
      expect(readFileSync(join(root, 'release', checksum), 'utf8'))
        .toMatch(new RegExp(`^[a-f0-9]{64}  ${artifact}\\n$`))
      execFileSync('shasum', ['-a', '256', '-c', checksum], { cwd: join(root, 'release') })
      const outputs = readFileSync(join(root, 'github-env'), 'utf8')
      expect(outputs).toContain(`ASSET=release/${artifact}`)
      expect(outputs).toContain(`CHECKSUM=release/${checksum}`)
      expect(outputs).toContain(`DEST=${artifact}`)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
