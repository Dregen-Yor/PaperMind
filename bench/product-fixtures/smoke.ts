import type { ParsedDocument } from '../../src/utils/doclingDocument'
import type { Embedder } from '../../src/utils/embedder'

/** Generated, valid two-page PDF; no user document or network/model artifact. */
export function syntheticPdf(): Uint8Array {
  const stream = (lines: Array<[number, number, string]>) => lines.map(([size, y, text]) => `BT /F1 ${size} Tf 50 ${y} Td (${text}) Tj ET`).join('\n')
  const p1 = stream([[18, 740, 'Introduction'], [12, 710, 'Synthetic laser study.'], [18, 650, 'Methods'], [12, 620, 'Our method uses lasers.']])
  const p2 = stream([[18, 740, 'Results'], [12, 710, 'Lasers succeed in this synthetic fixture.'], [18, 650, 'Conclusion'], [12, 620, 'This is a smoke fixture, not a real study.']])
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${p1.length} >>\nstream\n${p1}\nendstream`,
    `<< /Length ${p2.length} >>\nstream\n${p2}\nendstream`,
    '<< /Type /Outlines /First 9 0 R /Last 12 0 R /Count 4 >>',
    '<< /Title (Introduction) /Parent 8 0 R /Next 10 0 R /Dest [3 0 R /XYZ null 740 null] >>',
    '<< /Title (Methods) /Parent 8 0 R /Prev 9 0 R /Next 11 0 R /Dest [3 0 R /XYZ null 650 null] >>',
    '<< /Title (Results) /Parent 8 0 R /Prev 10 0 R /Next 12 0 R /Dest [4 0 R /XYZ null 740 null] >>',
    '<< /Title (Conclusion) /Parent 8 0 R /Prev 11 0 R /Dest [4 0 R /XYZ null 650 null] >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(pdf)
}
export const smokeEmbedder: Embedder = {
  id: 'synthetic-fixed-vectors@fixture-v1#float32',
  embedPassages: async texts => texts.map((_, index) => new Float32Array([index + 1, 1])),
  embedQuery: async () => new Float32Array([1, 2]),
}
export const smokeDocling: ParsedDocument = { version: 1, warnings: ['synthetic fixture'], items: [{
  id: 'text-1', kind: 'text', text: 'Our method uses lasers.', caption: '', pages: [0], regions: [], images: [],
}] }
