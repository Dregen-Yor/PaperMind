import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import { resolve } from 'path'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'fs'

// dev.mjs 只在 macOS 注入品牌启动器（品牌副本里可执行文件的 file URL）。
// 其他平台返回 undefined，即让 vite-plugin-electron 使用默认的 electron 包。
function brandedLauncher() {
  return process.platform === 'darwin' ? process.env.PAPERMIND_ELECTRON_LAUNCHER : undefined
}

// vite-plugin-electron 在 serve 期间把 Electron 子进程挂在 process.electronApp 上
// （见其 electron-env.d.ts）；tsconfig 未覆盖本文件，这里就地取窄类型。
function electronAppRunning() {
  return Boolean((process as { electronApp?: unknown }).electronApp)
}

// Copy pdfjs worker to public/ so it's served statically (offline-safe)
try {
  mkdirSync(resolve(__dirname, 'public'), { recursive: true })
  copyFileSync(
    resolve(__dirname, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs'),
    resolve(__dirname, 'public/pdf.worker.min.mjs'),
  )
} catch { /* ignore if already exists */ }

// onnxruntime-web 的 wasm 运行时资源：随包发布到 public/ort/，
// 供 src/utils/transformersEmbedder.ts 以 wasmPaths='./ort/' 加载。
// 打包后是 file:// 页面，不能从 CDN 取，而向量模型离线可用是阶段②③ 的前提。
const ORT_ASSETS = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
]
const ORT_DIST = resolve(__dirname, 'node_modules/onnxruntime-web/dist')
const ORT_TARGET = resolve(__dirname, 'public/ort')

/** 复制后的大小；不存在或不可读时返回 0（调用方按「缺失」处理，不再区分两种失败）。 */
function assetSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function warnOrt(message: string): void {
  // 静默失败是这里最坏的结局：四个资源是一套完整运行时，缺一个产品就永远只跑词法路，
  // 而 Node bench 仍跑完整混合路——两侧口径分叉却没有任何信号。所以逐项点名。
  console.warn(`[ort] ${message}；向量模型将不可用，段落检索退化为阶段①（词法）`)
}

/**
 * 逐项复制 + 逐项核对（存在且非空）。依赖缺失仍**不阻断** dev / build
 * （向量模型不可用是受支持的降级态），但每个失败都要能被看见：
 * 上游改名、发布残缺产物、复制中途失败都会在这里留下一条具名告警。
 */
function copyOrtAssets(): void {
  try {
    mkdirSync(ORT_TARGET, { recursive: true })
  } catch (error) {
    warnOrt(`无法创建 public/ort：${error instanceof Error ? error.message : String(error)}`)
    return
  }
  for (const asset of ORT_ASSETS) {
    const target = resolve(ORT_TARGET, asset)
    try {
      copyFileSync(resolve(ORT_DIST, asset), target)
    } catch (error) {
      warnOrt(`缺少 onnxruntime-web 资源 ${asset}（复制失败：${error instanceof Error ? error.message : String(error)}）`)
      continue
    }
    // copyFileSync 对残缺产物不报错，只有「存在且非空」才说明这份资源真的可用
    if (!existsSync(target)) {
      warnOrt(`onnxruntime-web 资源 ${asset} 复制后不存在`)
    } else if (assetSize(target) === 0) {
      warnOrt(`onnxruntime-web 资源 ${asset} 复制后为空文件`)
    }
  }
}

copyOrtAssets()

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/tests/setup.ts'],
    exclude: ['**/node_modules/**', 'dist', 'dist-electron', 'release', 'electron/**', 'scripts/tests/**', '**/.worktrees/**'],
  },
  plugins: [
    vue(),
    electron([
      {
        entry: 'electron/main.ts',
        onstart(options) {
          const launcher = brandedLauncher()
          return launcher
            ? options.startup(undefined, undefined, launcher)
            : options.startup()
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              // native module: keep external, loaded from node_modules at runtime
              external: ['better-sqlite3'],
            },
          },
        },
      },
      {
        entry: 'electron/preload.ts',
        onstart(options) {
          // 插件只对最后完成构建的那个入口调用 onstart：首个 dev 周期若 preload 后完成，
          // 旧的裸 reload() 会在没有运行实例时回落到未品牌化的 electron 包。
          const launcher = brandedLauncher()
          if (launcher && !electronAppRunning()) {
            return options.startup(undefined, undefined, launcher)
          }
          options.reload()
        },
        vite: {
          build: {
            outDir: 'dist-electron',
          },
        },
      },
    ]),
    // Vitest 下跳过 renderer()：它会把 node:fs 等内建模块重写为 CJS shim
    // （.vite-electron-renderer/fs.mjs 里含 require），与 bench/ 的 ESM 测试
    // （直接使用 node:fs / node:crypto）冲突，会报 require is not defined。
    ...(process.env.VITEST ? [] : [renderer()]),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
})
