import { describe, expect, it } from 'vitest'
import type { PdfTextLine } from '../../../src/utils/pdfDocument'
import { extractHeadingCandidates, extractVerifiedTocCandidates } from '../localPdf/tocCandidates'

function line(page: number, text: string, x = 20, y = 700, fontSize = 10, bold = false): PdfTextLine {
  return { page, text, x, y, fontSize, bold }
}

describe('TOC heading candidates', () => {
  it('keeps numbered, known, and large short headings without adjacent body text', () => {
    const long = `1 ${'word '.repeat(21)}`.trim()
    const layout = [[
      line(0, 'ordinary body text for the paper', 20, 650),
      line(0, 'another ordinary body line', 20, 640),
      line(0, 'more body copy', 20, 630),
      line(0, 'final body copy', 20, 620),
      line(0, 'body copy five', 20, 610),
      line(0, 'body copy six', 20, 600),
      line(0, 'body copy seven', 20, 590),
      line(0, '1 Introduction', 20, 700, 14, true),
      line(0, '2.1 Model Architecture', 30, 580, 13, true),
      line(0, 'Ablation Study', 20, 500, 16, true),
      line(0, long, 20, 400, 16, true),
      line(0, 'Figure 2 Results by dataset', 20, 300, 16, true),
      line(0, 'Smith et al. 2020. Example reference.', 20, 200, 16, true),
    ]]

    expect(extractHeadingCandidates(layout)).toEqual([
      { title: '1 Introduction', page: 0, numbering: [1], indent: 20, fontSize: 14, bold: true, source: 'heading' },
      { title: '2.1 Model Architecture', page: 0, numbering: [2, 1], indent: 30, fontSize: 13, bold: true, source: 'heading' },
      { title: 'Ablation Study', page: 0, numbering: null, indent: 20, fontSize: 16, bold: true, source: 'heading' },
    ])
  })

  it('removes a normalized running header repeated at the same y on three pages', () => {
    const layout = [0, 1, 2].map(page => [
      line(page, page === 1 ? ' INTRODUCTION ' : 'Introduction', 20, 790, 12, true),
      line(page, `body ${page}`, 20, 600),
    ])
    expect(extractHeadingCandidates(layout)).toEqual([])
  })
})

describe('verified TOC-page candidates', () => {
  const tocPage = [
    line(0, 'Contents', 20, 780, 18, true),
    line(0, '1 Introduction ........ 3', 20, 700),
    line(0, '2 Methods ........ iv', 20, 680),
    line(0, '3 Results ........ 5', 300, 720),
    line(0, '4 Conclusion ........ 6', 300, 700),
  ]
  const headings = [
    line(4, '1 Introduction', 20, 700, 14, true),
    line(5, '2 Methods', 20, 700, 14, true),
    line(6, '3 Results', 20, 700, 14, true),
    line(7, '4 Conclusion', 20, 700, 14, true),
  ].map(item => ({ title: item.text, page: item.page, numbering: [Number(item.text[0])], indent: item.x, fontSize: item.fontSize, bold: item.bold, source: 'heading' as const }))

  it('orders two columns and calibrates Arabic and Roman printed pages', () => {
    expect(extractVerifiedTocCandidates([tocPage, ...Array.from({ length: 7 }, () => [])], headings)).toEqual([
      { title: '1 Introduction', page: 4, numbering: [1], indent: 20, fontSize: 10, bold: false, source: 'toc-page' },
      { title: '2 Methods', page: 5, numbering: [2], indent: 20, fontSize: 10, bold: false, source: 'toc-page' },
      { title: '3 Results', page: 6, numbering: [3], indent: 300, fontSize: 10, bold: false, source: 'toc-page' },
      { title: '4 Conclusion', page: 7, numbering: [4], indent: 300, fontSize: 10, bold: false, source: 'toc-page' },
    ])
  })

  it('rejects conflicting offsets and fewer than two verified entries', () => {
    expect(extractVerifiedTocCandidates([tocPage], [{ ...headings[0] }])).toEqual([])
    expect(extractVerifiedTocCandidates([tocPage], [headings[0], { ...headings[1], page: 8 }])).toEqual([])
  })
})
