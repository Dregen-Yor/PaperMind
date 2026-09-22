// 只读校验已提交的图标产物与母版一致：尺寸、透明度、格式结构。
import { fileURLToPath } from 'node:url'
import { checkIcons } from './lib/icon-assets.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

try {
  await checkIcons(root)
  console.log('[icons] 校验通过：mac.png / mac.icns / win.ico / linux/*.png')
} catch (error) {
  console.error(`[icons] 校验失败：${error.message}`)
  process.exitCode = 1
}
