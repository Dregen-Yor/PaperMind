import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'

// Relative URL works with both the Vite dev server and packaged Electron file:// pages.
pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs'

/** 文件内容 SHA-256（十六进制），用于重复导入检测（#10）。 */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function parsePdfMeta(file: File): Promise<{
  title: string; authors: string[]; abstract: string; year: number; fileData: string; fileHash: string
}> {
  const arrayBuffer = await file.arrayBuffer()
  // pdf.js 把 data.buffer transfer 给 worker，调用方的 ArrayBuffer 随之 detach，
  // 所以内容哈希必须在 getDocument 之前算（#10）。
  const fileHash = await sha256Hex(arrayBuffer)
  // Chunked base64 — avoids "Maximum call stack size exceeded" for large PDFs
  const bytes = new Uint8Array(arrayBuffer)
  let binary = ''
  const CHUNK = 8192
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  const base64 = btoa(binary)
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
  const meta = await pdf.getMetadata().catch(() => ({ info: {} }))
  const info = (meta as any).info ?? {}

  // Extract first page text for abstract heuristic
  let abstract = ''
  let year = 0
  try {
    const page = await pdf.getPage(1)
    const textContent = await page.getTextContent()
    const fullText = textContent.items.map((i: any) => i.str).join(' ')
    const abstractMatch = fullText.match(/abstract[:\s]+(.{100,600})/i)
    if (abstractMatch) abstract = abstractMatch[1].trim()
    const yearMatch = fullText.match(/\b(19|20)\d{2}\b/)
    if (yearMatch) year = parseInt(yearMatch[0])
  } catch { /* ignore */ }

  const titleRaw = info.Title || ''
  const authorRaw = info.Author || ''
  const authors = authorRaw ? authorRaw.split(/[,;]+/).map((a: string) => a.trim()).filter(Boolean) : []

  return {
    title: titleRaw || file.name.replace(/\.pdf$/i, ''),
    authors,
    abstract,
    year,
    fileData: base64,
    fileHash,
  }
}

export function base64ToUrl(base64: string): string {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const blob = new Blob([bytes], { type: 'application/pdf' })
  return URL.createObjectURL(blob)
}
