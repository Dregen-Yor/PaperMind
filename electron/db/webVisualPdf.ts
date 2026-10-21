import { createHash } from 'node:crypto'

export function decodeWebVisualPdf(value: unknown): Buffer {
  if (typeof value !== 'string' || !value || value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
    || value.length > 64 * 1024 * 1024 * 1.4) throw new Error('网页视觉 PDF 数据无效')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > 64 * 1024 * 1024 || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))
    || bytes.toString('base64') !== value) throw new Error('网页视觉 PDF 数据无效或超过 64 MB')
  return bytes
}

/** Ignore only PDF generation metadata; preserve all rendered content bytes. */
export function webVisualAppearance(bytes: Buffer): string {
  const normalized = bytes.toString('latin1')
    .replace(/\/(CreationDate|ModDate)\s*\([^)]*\)/g, '')
    .replace(/\/ID\s*\[\s*<[a-f0-9]+>\s*<[a-f0-9]+>\s*\]/gi, '')
  return createHash('sha256').update(normalized, 'latin1').digest('hex')
}
