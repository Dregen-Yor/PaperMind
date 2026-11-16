const { createRequire } = require('node:module')
const { dirname, join, resolve } = require('node:path')

const PREFIX = 'PAPERMIND_NATIVE_SMOKE='
const runtime = {
  electron: process.versions.electron,
  node: process.versions.node,
  chrome: process.versions.chrome,
  platform: process.platform,
  arch: process.arch,
}

function emit(result) {
  process.stdout.write(`${PREFIX}${JSON.stringify(result)}\n`)
}

async function main() {
  const requireRoot = process.env.PAPERMIND_REQUIRE_ROOT || resolve(__dirname, '../../package.json')
  const projectRequire = createRequire(requireRoot)
  const platformArch = `${process.platform}-${process.arch}`
  const Database = projectRequire('better-sqlite3')
  const sharp = projectRequire('sharp')

  const db = new Database(':memory:')
  db.exec('CREATE TABLE smoke (value INTEGER NOT NULL); INSERT INTO smoke VALUES (42)')
  const sqliteValue = db.prepare('SELECT value FROM smoke').pluck().get()
  db.close()

  const png = await sharp({
    create: { width: 2, height: 2, channels: 4, background: '#336699ff' },
  }).png().toBuffer()
  const metadata = await sharp(png).metadata()

  const sqlitePackage = projectRequire.resolve('better-sqlite3/package.json')
  const sqliteBinding = join(dirname(sqlitePackage), 'prebuilds', `${platformArch}.node`)
  const sharpBinding = projectRequire.resolve(`@img/sharp-${platformArch}/lib/sharp-${platformArch}.node`)
  emit({
    ok: true,
    ...runtime,
    sqliteValue,
    sharp: { width: metadata.width, height: metadata.height, format: metadata.format },
    sqliteBinding,
    sharpBinding,
  })
}

main().catch(error => {
  emit({
    ok: false,
    ...runtime,
    error: (error instanceof Error ? error.message : String(error)).split(/\r?\n/, 1)[0],
  })
  process.exitCode = 1
})
