/** Deterministic, dependency-free PDF with enough pages to expose eager rendering. */
export function makeFixturePdf(pageCount = 60): Uint8Array {
  const objects: string[] = []
  const pageRefs: string[] = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  for (let page = 1; page <= pageCount; page++) {
    const pageId = 4 + (page - 1) * 2
    const streamId = pageId + 1
    pageRefs.push(`${pageId} 0 R`)
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`
    const lines = Array.from({ length: 28 }, (_, index) =>
      `(${`Benchmark page ${page}, line ${index + 1}: PDF text selection and page rendering.`}) Tj 0 -22 Td`).join('\n')
    const stream = `BT /F1 11 Tf 40 748 Td\n${lines}\nET`
    objects[streamId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  }
  objects[2] = `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pageCount} >>`

  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = pdf.length
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let id = 1; id < objects.length; id++) pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(pdf)
}
