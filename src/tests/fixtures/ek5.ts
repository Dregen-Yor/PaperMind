import type { Embedder } from '../../utils/embedder'
export const ek5Doc = {
  pages: ['Introduction\nIntro body.\nMethods\nOur method uses lasers.', 'Results\nLasers succeed.\nConclusion\nDone.'],
  layoutLines: [],
  outline: ['Introduction', 'Methods', 'Results', 'Conclusion'].map((title, i) => ({ id: String(i), title, page: Math.floor(i / 2), children: [] })),
}
export const ek5Embedder = { id: 'test', embedPassages: async (xs: string[]) => xs.map((_, i) => new Float32Array([i + 1, 1])), embedQuery: async () => new Float32Array([1, 2]) } as Embedder
