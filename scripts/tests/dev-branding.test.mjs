import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { prepareDevBranding, brandingFingerprint } from '../lib/dev-branding.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'Paper Mind 中文-'))
  const files = {
    'node_modules/electron/package.json': '{"version":"44.2.0"}',
    'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron': 'fake electron',
    'node_modules/electron/dist/Electron.app/Contents/Info.plist': '<plist version="1.0"><dict/></plist>',
    'node_modules/electron/dist/Electron.app/Contents/Resources/electron.icns': 'old icon',
    'assets/icons/mac.icns': 'new icon',
  }
  for (const [name, value] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true })
    writeFileSync(join(root, name), value)
  }
  return root
}

const cacheOf = root => join(root, 'node_modules/.papermind-electron')
const copiedExecutableOf = root => join(cacheOf(root), 'PaperMind.app/Contents/MacOS/Electron')
const copiedIconOf = root => join(cacheOf(root), 'PaperMind.app/Contents/Resources/papermind.icns')

test('non-macOS returns before touching filesystem or tools', () => {
  for (const platform of ['win32', 'linux']) {
    assert.equal(prepareDevBranding({ root: '/nonexistent', platform, arch: 'x64', run: () => assert.fail('native tool') }), null)
  }
})

test('launcher imports from a path with spaces and cache is reused', async () => {
  const root = fixture()
  const calls = []
  const args = { root, platform: 'darwin', arch: 'arm64', run: (...call) => calls.push(call) }
  try {
    const originalBinary = join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    const originalPlist = join(root, 'node_modules/electron/dist/Electron.app/Contents/Info.plist')
    const originals = [readFileSync(originalBinary), readFileSync(originalPlist)]

    const launcher = prepareDevBranding(args)
    const executable = (await import(pathToFileURL(launcher).href)).default
    assert.equal(executable, join(root, 'node_modules/.papermind-electron/PaperMind.app/Contents/MacOS/Electron'))
    assert.equal(readFileSync(executable, 'utf8'), 'fake electron')
    assert.ok(calls.some(([cmd]) => cmd === 'plutil'))
    assert.equal(readFileSync(copiedIconOf(root), 'utf8'), 'new icon')
    // 品牌化只作用于开发副本：原版 app 与任何原生工具的目标都不允许指向 node_modules/electron/dist
    for (const [command, argv] of calls) {
      const target = argv.at(-1)
      assert.ok(target.startsWith(join(root, 'node_modules/.papermind-electron')), `${command} must target the dev copy, got ${target}`)
    }
    assert.deepEqual(
      new Map(calls.filter(([command]) => command === 'plutil').map(([, argv]) => [argv[1], argv[3]])),
      new Map([
        ['CFBundleName', 'PaperMind'],
        ['CFBundleDisplayName', 'PaperMind'],
        ['CFBundleIdentifier', 'com.papermind.app.dev'],
        ['CFBundleIconFile', 'papermind.icns'],
      ]),
    )
    const codesign = calls.filter(([command]) => command === 'codesign').map(([, argv]) => argv)
    const verify = codesign.at(-1)
    assert.deepEqual(verify.slice(0, 3), ['--verify', '--deep', '--strict'])
    assert.equal(verify.at(-1), codesign.at(-2).at(-1), 'the bundle is signed last, then verified')
    for (const argv of codesign.slice(0, -1)) {
      assert.deepEqual(argv.slice(0, 4), ['--force', '--sign', '-', '--preserve-metadata=entitlements'])
    }

    const count = calls.length
    prepareDevBranding(args)
    assert.equal(calls.length, count)

    rmSync(copiedExecutableOf(root), { force: true })
    prepareDevBranding(args)
    assert.equal(readFileSync(copiedExecutableOf(root), 'utf8'), 'fake electron')

    writeFileSync(join(cacheOf(root), '.branding.json'), '{ this is not json')
    prepareDevBranding(args)
    assert.equal(readFileSync(copiedExecutableOf(root), 'utf8'), 'fake electron')

    writeFileSync(join(root, 'assets/icons/mac.icns'), 'changed')
    prepareDevBranding(args)
    assert.ok(calls.length > count)
    assert.equal(readFileSync(copiedIconOf(root), 'utf8'), 'changed')

    // 原版二进制与 plist 前后字节不变；staging 与 backup 不留残骸
    assert.deepEqual([readFileSync(originalBinary), readFileSync(originalPlist)], originals)
    assert.deepEqual(
      readdirSync(join(root, 'node_modules')).filter(name => name.startsWith('.papermind-electron')),
      ['.papermind-electron'],
    )
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('nested code is re-signed before the outer bundle', () => {
  const root = fixture()
  const helper = 'node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper.app'
  mkdirSync(join(root, helper, 'Contents/MacOS'), { recursive: true })
  writeFileSync(join(root, helper, 'Contents/MacOS/Electron Helper'), 'fake helper')
  mkdirSync(join(root, helper, 'Contents/Resources'), { recursive: true })
  symlinkSync('Versions/Current/Helpers', join(root, helper, 'Contents/Resources/Helpers'))
  const calls = []
  try {
    prepareDevBranding({ root, platform: 'darwin', arch: 'arm64', run: (...call) => calls.push(call) })
    const signed = calls.filter(([command, argv]) => command === 'codesign' && argv[0] === '--force').map(([, argv]) => argv.at(-1))
    const bundle = signed.at(-1)
    assert.equal(signed.length, 2, 'the helper and the outer bundle are both signed')
    assert.equal(signed[0], join(bundle, 'Contents/Frameworks/Electron Helper.app'))
    assert.deepEqual(calls.at(-1), ['codesign', ['--verify', '--deep', '--strict', bundle]])
    // 相对软链必须按原样复制：改写成绝对路径会破坏 bundle 的封印
    const copiedLink = join(cacheOf(root), 'PaperMind.app/Contents/Frameworks/Electron Helper.app/Contents/Resources/Helpers')
    assert.equal(readlinkSync(copiedLink), 'Versions/Current/Helpers')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('failed signing never produces a successful cache marker', () => {
  const root = fixture()
  try {
    assert.throws(() => prepareDevBranding({ root, platform: 'darwin', arch: 'arm64', run: command => {
      if (command === 'codesign') throw new Error('sign failed')
    } }), /sign failed/)
    assert.equal(existsSync(join(root, 'node_modules/.papermind-electron/.branding.json')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('all identity inputs invalidate fingerprints', () => {
  const base = { version: '44.2.0', arch: 'arm64', icon: Buffer.from('a'), revision: 1 }
  for (const patch of [{ version: '44.3.0' }, { arch: 'x64' }, { icon: Buffer.from('b') }, { revision: 2 }]) {
    assert.notEqual(brandingFingerprint(base), brandingFingerprint({ ...base, ...patch }))
  }
})
