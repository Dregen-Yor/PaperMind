// 从 assets/papermind-icon.svg 生成各平台图标产物。
// 仅在维护图标时手动运行；应用启动与打包直接使用已提交的 assets/icons 产物。
import { fileURLToPath } from 'node:url'
import { generateIcons } from './lib/icon-assets.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

try {
  await generateIcons(root)
  console.log('[icons] 已生成 assets/icons：mac.png / mac.icns / win.ico / linux/*.png')
} catch (error) {
  console.error(`[icons] 生成失败：${error.message}`)
  process.exitCode = 1
}
