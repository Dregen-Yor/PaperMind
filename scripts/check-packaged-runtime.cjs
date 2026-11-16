const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { lstatSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { isAbsolute, join, relative, sep } = require('node:path')

function relativeInside(root, candidate) {
  const value = relative(root, candidate)
  return value && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value) ? value : null
}

function packagedNativePaths(result, resources) {
  const archive = join(resources, 'app.asar')
  const unpacked = join(resources, 'app.asar.unpacked')
  const physicalPath = value => {
    if (typeof value !== 'string') return null
    const inner = relativeInside(archive, value) ?? relativeInside(unpacked, value)
    return inner ? join(unpacked, inner) : null
  }
  return {
    sqliteBinding: physicalPath(result?.sqliteBinding),
    sharpBinding: physicalPath(result?.sharpBinding),
  }
}

function packagedNativeErrors(result, resources) {
  const errors = []
  const paths = resources ? packagedNativePaths(result, resources) : {}
  for (const [name, source, physical] of [
    ['better-sqlite3', result?.sqliteBinding, paths.sqliteBinding],
    ['Sharp', result?.sharpBinding, paths.sharpBinding],
  ]) {
    let isFile = false
    try { isFile = !!physical && lstatSync(physical).isFile() } catch {}
    if (!isFile) errors.push(`${name} binding must exist in app.asar.unpacked: expected=${physical ?? 'unresolved'} actual=${source ?? 'missing'}`)
  }
  return errors
}

async function afterPack(context) {
  const product = context.packager.appInfo.productFilename
  const executable = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${product}.app`, 'Contents', 'MacOS', product)
    : join(context.appOutDir, context.electronPlatformName === 'win32'
      ? `${product}.exe` : context.packager.config.linux?.executableName || product)
  const resources = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${product}.app`, 'Contents', 'Resources') : join(context.appOutDir, 'resources')
  const receiptPath = join(resources, 'runtime-security.json')
  rmSync(receiptPath, { force: true })

  const check = spawnSync(process.execPath, [join(__dirname, 'check-runtime.mjs'), '--executable', executable], {
    encoding: 'utf8', timeout: 45_000,
  })
  if (check.status !== 0 || check.error) throw new Error(`安装包运行时安全检查失败：\n${check.stdout || ''}${check.stderr || ''}`)
  const runtimeLine = String(check.stdout).split(/\r?\n/).find(line => line.startsWith('{'))
  if (!runtimeLine) throw new Error('安装包运行时安全检查未返回实际版本')
  const runtime = JSON.parse(runtimeLine)

  const { nativeProbeErrors, runNativeProbe } = await import('./lib/native-verification.mjs')
  const native = runNativeProbe({
    executable,
    requireRoot: join(resources, 'app.asar', 'package.json'),
    timeout: 45_000,
  })
  const nativeErrors = [...nativeProbeErrors(native), ...packagedNativeErrors(native, resources)]
  if (nativeErrors.length) throw new Error(`安装包原生模块检查失败：\n${nativeErrors.join('\n')}`)
  const nativePaths = packagedNativePaths(native, resources)

  const policy = readFileSync(join(__dirname, '../config/runtime-security.json'))
  const receipt = {
    versions: runtime,
    buildNode: process.versions.node,
    policySha256: createHash('sha256').update(policy).digest('hex'),
    native: {
      sqliteValue: native.sqliteValue,
      sharp: native.sharp,
      sqliteBinding: relative(resources, nativePaths.sqliteBinding),
      sharpBinding: relative(resources, nativePaths.sharpBinding),
    },
  }
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  console.log(JSON.stringify({ runtime, native: receipt.native }))
}

afterPack.packagedNativeErrors = packagedNativeErrors
afterPack.packagedNativePaths = packagedNativePaths
module.exports = afterPack
