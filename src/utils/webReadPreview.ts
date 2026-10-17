import { parse } from 'parse5'
import type { WebPreviewBlock, WebReadPreview } from '../types/webQa'

type HtmlNode = { nodeName: string; value?: string; childNodes?: HtmlNode[] }
const ignored = new Set(['script', 'style', 'nav', 'header', 'footer', 'aside', 'form', 'svg', 'iframe'])

function find(node: HtmlNode, name: string): HtmlNode | undefined {
  if (node.nodeName === name) return node
  for (const child of node.childNodes ?? []) {
    const found = find(child, name)
    if (found) return found
  }
}

function readableText(node: HtmlNode): string {
  if (ignored.has(node.nodeName)) return ''
  if (node.nodeName === '#text') return node.value ?? ''
  return (node.childNodes ?? []).map(readableText).join(' ')
}

export function extractWebReadPreview(html: string): WebReadPreview {
  const document = parse(html) as unknown as HtmlNode
  const root = [find(document, 'article'), find(document, 'main'), find(document, 'body'), document]
    .find(node => node && readableText(node).trim()) ?? document
  const blocks: WebPreviewBlock[] = []
  let bytes = 0
  let truncated = false

  function append(kind: WebPreviewBlock['kind'], raw: string, level?: number) {
    const clean = kind === 'code' ? raw.trim() : raw.replace(/\s+/g, ' ').trim()
    if (!clean) return
    if (blocks.length >= 2000 || bytes >= 512 * 1024) {
      truncated = true
      return
    }
    const chars = Array.from(clean)
    let low = 0
    let high = chars.length
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (Buffer.byteLength(chars.slice(0, mid).join(''), 'utf8') <= 512 * 1024 - bytes) low = mid
      else high = mid - 1
    }
    if (low < chars.length) truncated = true
    if (low > 0) {
      const text = chars.slice(0, low).join('')
      blocks.push({ kind, text, ...(level ? { level } : {}) })
      bytes += Buffer.byteLength(text, 'utf8')
    }
  }

  function visit(node: HtmlNode): void {
    if (ignored.has(node.nodeName)) return
    const level = /^h[1-6]$/.test(node.nodeName) ? Number(node.nodeName[1]) : undefined
    const kinds: Record<string, WebPreviewBlock['kind']> = {
      p: 'paragraph', li: 'list', blockquote: 'quote', pre: 'code',
    }
    const kind = level ? 'heading' : kinds[node.nodeName]
    if (kind) {
      append(kind, readableText(node), level)
      return
    }
    for (const child of node.childNodes ?? []) visit(child)
  }

  visit(root)
  if (!blocks.length) append('paragraph', readableText(root))
  if (!blocks.length) throw new Error('网页没有可缓存的文字')
  return { blocks, truncated }
}
