import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import { resolve } from 'path'
import { copyFileSync, mkdirSync } from 'fs'

// Copy pdfjs worker to public/ so it's served statically (offline-safe)
try {
  mkdirSync(resolve(__dirname, 'public'), { recursive: true })
  copyFileSync(
    resolve(__dirname, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs'),
    resolve(__dirname, 'public/pdf.worker.min.mjs'),
  )
} catch { /* ignore if already exists */ }

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
          options.startup()
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
