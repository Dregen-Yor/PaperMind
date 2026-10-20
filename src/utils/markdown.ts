import DOMPurify from 'dompurify'
import 'katex/dist/katex.min.css'
import MarkdownIt from 'markdown-it'
import texmath from 'markdown-it-texmath'
import { parseEvidenceHref } from './sourceRef'

const markdown = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
})

markdown.use(texmath, {
  delimiters: 'dollars',
  katexOptions: {
    throwOnError: false,
    strict: false,
  },
})

const defaultImage = markdown.renderer.rules.image
markdown.renderer.rules.image = (tokens, index, options, env, self) => {
  const token = tokens[index]
  const source = token.attrGet('src') || ''
  if (source.startsWith('asset:')) {
    const id = source.slice(6)
    if (!/^[a-f0-9]{64}$/.test(id)) return ''
    return `<img data-asset-id="${id}" alt="${markdown.utils.escapeHtml(token.content)}" loading="lazy">`
  }
  return defaultImage ? defaultImage(tokens, index, options, env, self) : self.renderToken(tokens, index, options)
}

const defaultLinkOpen = markdown.renderer.rules.link_open

markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index]
  const href = token.attrGet('href') || ''
  if (href.startsWith('paper-source:')) {
    const source = parseEvidenceHref(href)
    if (source?.paperId && source.startPage !== undefined) {
      const box = source.region ? [source.region.x, source.region.y, source.region.width, source.region.height].join(',') : ''
      return `<a class="paper-source" data-paper-id="${markdown.utils.escapeHtml(source.paperId)}" data-page="${source.startPage}"${source.endPage !== source.startPage ? ` data-end-page="${source.endPage}"` : ''}${box ? ` data-region="${box}"` : ''}${source.quote ? ` data-quote="${markdown.utils.escapeHtml(source.quote)}"` : ''} role="button" tabindex="0">`
    }
    token.attrSet('href', '')
  }
  tokens[index].attrSet('target', '_blank')
  tokens[index].attrSet('rel', 'noopener noreferrer')
  return defaultLinkOpen
    ? defaultLinkOpen(tokens, index, options, env, self)
    : self.renderToken(tokens, index, options)
}

function sourceParagraph(element: Element | null): element is HTMLParagraphElement {
  return element instanceof HTMLParagraphElement
    && element.querySelectorAll('a.paper-source').length > 0
    && Array.from(element.childNodes).every(node => node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()
      || node instanceof HTMLAnchorElement && node.classList.contains('paper-source'))
}

function referenceOnlyParagraph(element: Element | null): element is HTMLParagraphElement {
  return element instanceof HTMLParagraphElement
    && element.querySelectorAll('a.paper-source').length > 0
    && Array.from(element.childNodes).every(node => node.nodeType === Node.TEXT_NODE && /^[\s；;，,。.!?！？：:–-]*$/.test(node.textContent || '')
      || node instanceof HTMLAnchorElement && node.classList.contains('paper-source'))
}

function assetCaption(element: Element | null): element is HTMLParagraphElement {
  return element instanceof HTMLParagraphElement
    && element.querySelectorAll('a.paper-source').length > 0
    && Array.from(element.childNodes).every(node => node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()
      || node instanceof HTMLAnchorElement && node.classList.contains('paper-source')
      || node instanceof HTMLElement && node.tagName === 'EM' && /^原文(?:图片|表格|公式)$/.test(node.textContent?.trim() || ''))
}

function formatEvidence(html: string): string {
  if (!html.includes('paper-source') || !html.includes('data-asset-id') && !html.includes('katex-display')) return html
  const root = document.createElement('div')
  root.innerHTML = html
  const makeFigure = (block: Element, media: Element, label: string, source: HTMLParagraphElement, kind: string) => {
    const figure = document.createElement('figure')
    figure.className = `paper-evidence paper-evidence--${kind}`
    const stage = document.createElement('div')
    stage.className = 'paper-evidence-media'
    block.replaceWith(figure)
    stage.append(media)
    const caption = document.createElement('figcaption')
    const name = document.createElement('span')
    name.className = 'paper-evidence-label'
    name.textContent = label
    const pages = document.createElement('span')
    pages.className = 'paper-evidence-pages'
    pages.append(...Array.from(source.querySelectorAll('a.paper-source')))
    caption.append(name, pages)
    figure.append(stage, caption)
    source.remove()
  }
  for (const image of Array.from(root.querySelectorAll<HTMLImageElement>('img[data-asset-id]'))) {
    const block = image.parentElement
    const caption = block?.nextElementSibling || null
    if (block?.tagName !== 'P' || block.children.length !== 1 || block.textContent?.trim() || !assetCaption(caption)) continue
    makeFigure(block, image, caption.querySelector('em')?.textContent?.trim() || image.alt, caption, 'image')
  }
  for (const formula of Array.from(root.querySelectorAll('.katex-display'))) {
    let block: Element = formula
    while (block.parentElement && block.parentElement !== root) block = block.parentElement
    const source = block.nextElementSibling
    if (!sourceParagraph(source)) continue
    makeFigure(block, block, '原文公式', source, 'formula')
  }
  for (const paragraph of Array.from(root.querySelectorAll(':scope > p'))) {
    const first = paragraph.firstChild
    if (first?.nodeType !== Node.TEXT_NODE) continue
    const opening = /^\s*([；;，,。.!?！？：:])\s*/.exec(first.textContent || '')
    if (!opening) continue
    first.textContent = (first.textContent || '').slice(opening[0].length)
    let before = paragraph.previousElementSibling
    while (before?.matches('figure.paper-evidence') || sourceParagraph(before)) before = before.previousElementSibling
    const ending = before?.textContent?.trim() || ''
    if (before?.tagName === 'P' && ending && !/^[–-]$/.test(ending) && !/[；;，,。.!?！？：:]$/.test(ending)) before.append(opening[1])
    if (!paragraph.textContent?.trim()) paragraph.remove()
  }
  for (const paragraph of Array.from(root.querySelectorAll(':scope > p'))) {
    if (!referenceOnlyParagraph(paragraph)) continue
    let before = paragraph.previousElementSibling
    const intervening: Element[] = []
    while (before?.matches('figure.paper-evidence')) { intervening.push(before); before = before.previousElementSibling }
    const known = Array.from((before?.tagName === 'P' ? before : intervening[0])?.querySelectorAll('a.paper-source') || [])
    for (const figure of intervening) known.push(...Array.from(figure.querySelectorAll('a.paper-source')))
    const target = before?.tagName === 'P' ? before : null
    if (!target && !intervening.length) continue
    const remaining = Array.from(paragraph.childNodes).filter(node => {
      if (!(node instanceof HTMLAnchorElement)) return Boolean(node.textContent?.trim())
      const duplicate = known.some(page => page.getAttribute('data-paper-id') === node.getAttribute('data-paper-id')
        && page.getAttribute('data-page') === node.getAttribute('data-page'))
      if (!duplicate) known.push(node)
      return !duplicate
    })
    if (target) {
      for (const node of remaining) {
        if (node instanceof HTMLAnchorElement) target.append(' ', node)
        else if (!/[；;，,。.!?！？：:]$/.test(target.textContent?.trim() || '')) target.append(node.textContent?.trim() || '')
      }
      paragraph.remove()
    } else if (!remaining.some(node => node instanceof HTMLAnchorElement)) paragraph.remove()
  }
  return root.innerHTML
}

export function renderMarkdown(content: string): string {
  // Some models emit LaTeX delimiters as \(...\) and \[...\]. Markdown
  // treats their backslashes as escapes, so normalize them to dollar syntax.
  const normalized = content
    .replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_match, formula: string) =>
      `\n$$\n${formula.trim()}\n$$\n`,
    )
    .replace(/\\\(\s*([^\n]*?)\s*\\\)/g, (_match, formula: string) =>
      `$${formula.trim()}$`,
    )

  const html = DOMPurify.sanitize(markdown.render(normalized), {
    USE_PROFILES: { html: true, mathMl: true },
    ADD_ATTR: ['target'],
  })
  return formatEvidence(html)
}
