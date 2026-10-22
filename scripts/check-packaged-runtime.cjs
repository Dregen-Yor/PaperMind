const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

module.exports = async context => {
  const product = context.packager.appInfo.productFilename
  const executable = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${product}.app`, 'Contents', 'MacOS', product)
    : join(context.appOutDir, context.electronPlatformName === 'win32'
      ? `${product}.exe` : context.packager.config.linux?.executableName || product)
  const resources = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${product}.app`, 'Contents', 'Resources') : join(context.appOutDir, 'resources')
  const check = spawnSync(process.execPath, [join(__dirname, 'check-runtime.mjs'), '--executable', executable,
    '--receipt', join(resources, 'runtime-security.json')], {
    encoding: 'utf8', timeout: 45_000,
  })
  if (check.status !== 0 || check.error) throw new Error(`安装包运行时安全检查失败：\n${check.stdout || ''}${check.stderr || ''}`)
  console.log(check.stdout)
}
