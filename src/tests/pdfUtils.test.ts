import { describe, it, expect, vi } from 'vitest'
import { webcrypto } from 'node:crypto'

// Mock pdfjs-dist before importing pdfUtils — avoids DOMMatrix error in Node/jsdom
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  default: {},
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
}))

// Import only after mock is set up
const { base64ToUrl, parsePdfMeta, sha256Hex } = await import('../utils/pdfUtils')

describe('base64ToUrl', () => {
  it('returns a blob: URL', () => {
    const url = base64ToUrl(btoa('\x25\x50\x44\x46'))
    expect(url).toMatch(/^blob:/)
    URL.revokeObjectURL(url)
  })

  it('creates a Blob with application/pdf type', () => {
    let captured: Blob | undefined
    const orig = URL.createObjectURL
    URL.createObjectURL = (b: Blob) => { captured = b; return 'blob:mock' }
    base64ToUrl(btoa('test'))
    expect(captured?.type).toBe('application/pdf')
    URL.createObjectURL = orig
  })
})

// pageIndex 依赖 pdfjs-dist，在同一文件内 mock 已生效，直接动态导入
const { detectSectionBoundaries, mergeSmallSections } = await import('../utils/pageIndex')

describe('detectSectionBoundaries', () => {
  it('detects English numbered headings', () => {
    const pages = [
      'Some preamble text on page 1.',
      '1. Introduction\nThis paper presents a novel approach...',
      'Continued introduction text across this page.',
      '2. Methods\nWe used the following experimental setup...',
      '3. Results\nOur experiments demonstrate significant improvements...',
    ]
    expect(detectSectionBoundaries(pages)).toEqual([1, 3, 4])
  })

  it('detects all-caps headings', () => {
    const pages = [
      'Abstract content describing the paper.',
      'INTRODUCTION\nIn this work we explore...',
      'More introduction content here.',
      'METHODS\nWe performed the following steps...',
    ]
    expect(detectSectionBoundaries(pages)).toEqual([1, 3])
  })

  it('detects common section name headings (case-insensitive)', () => {
    const pages = [
      'Abstract\nThis paper investigates...',
      'Introduction\nPrior work has shown...',
      'Conclusion\nIn summary...',
    ]
    expect(detectSectionBoundaries(pages)).toEqual([0, 1, 2])
  })

  it('detects Chinese chapter headings', () => {
    const pages = [
      '摘要内容在此处。',
      '第一章 引言\n本文研究了以下问题...',
      '1.1 研究背景\n近年来深度学习取得了巨大进展...',
      '第二章 方法\n本章详细介绍实验方法...',
    ]
    expect(detectSectionBoundaries(pages)).toEqual([1, 2, 3])
  })

  it('returns empty array when no headings found (scanned PDF)', () => {
    const pages = [
      'this is a scanned document without any clear section headings at all',
      'more unstructured text content here without patterns',
      'even more plain text with no recognizable heading format',
    ]
    expect(detectSectionBoundaries(pages)).toEqual([])
  })
})

describe('mergeSmallSections', () => {
  it('returns single section unchanged (no merge due to result.length > 1 guard)', () => {
    const ranges = [{ start: 0, end: 5 }]
    const result = mergeSmallSections(ranges, 2)
    expect(result).toEqual([{ start: 0, end: 5 }])
  })

  it('merges last section smaller than minPages into previous section', () => {
    const ranges = [
      { start: 0, end: 2 },  // 3 pages
      { start: 3, end: 3 },  // 1 page (< 2)
    ]
    const result = mergeSmallSections(ranges, 2)
    expect(result).toEqual([{ start: 0, end: 3 }])
  })

  it('merges first section smaller than minPages into next section', () => {
    const ranges = [
      { start: 0, end: 0 },  // 1 page (< 2)
      { start: 1, end: 3 },  // 3 pages
    ]
    const result = mergeSmallSections(ranges, 2)
    expect(result).toEqual([{ start: 0, end: 3 }])
  })

  it('does not merge sections at or above minPages threshold', () => {
    const ranges = [
      { start: 0, end: 1 },  // 2 pages (>= 2)
      { start: 2, end: 4 },  // 3 pages (>= 2)
      { start: 5, end: 6 },  // 2 pages (>= 2)
    ]
    const result = mergeSmallSections(ranges, 2)
    expect(result).toEqual(ranges)
  })
})

describe('文件哈希（#10）', () => {
  it('相同字节返回稳定十六进制哈希', async () => {
    if (!globalThis.crypto?.subtle) vi.stubGlobal('crypto', webcrypto)
    const bytes = new TextEncoder().encode('paper-content').buffer
    const first = await sha256Hex(bytes)
    const second = await sha256Hex(bytes)
    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
  })

  it('pdf.js 取走缓冲区之前完成哈希（getDocument 会 transfer 并 detach 它）', async () => {
    if (!globalThis.crypto?.subtle) vi.stubGlobal('crypto', webcrypto)
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const getDocument = vi.mocked((pdfjs as any).getDocument)
    const bytes = new Uint8Array(new TextEncoder().encode('%PDF-1.4 fake body'))

    getDocument.mockImplementationOnce(({ data }: { data: ArrayBuffer }) => {
      // 真实 pdf.js 把 data.buffer transfer 给 worker，调用方的 ArrayBuffer 随之 detach
      structuredClone(data, { transfer: [data] })
      expect(data.byteLength).toBe(0)
      return {
        promise: Promise.resolve({
          getMetadata: () => Promise.resolve({ info: {} }),
          getPage: () => Promise.resolve({ getTextContent: () => Promise.resolve({ items: [] }) }),
        }),
      } as any
    })

    const meta = await parsePdfMeta(new File([bytes], 'fake.pdf', { type: 'application/pdf' }))
    expect(meta.fileHash).toBe(await sha256Hex(bytes.buffer))
  })
})
