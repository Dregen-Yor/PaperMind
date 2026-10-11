import DOMPurify from 'dompurify'
import 'katex/dist/katex.min.css'
import MarkdownIt from 'markdown-it'
import texmath from 'markdown-it-texmath'

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
    const match = /^paper-source:(.+):(\d+)$/.exec(href)
    if (match && Number.isSafeInteger(Number(match[2]))) {
      try {
        const paperId = decodeURIComponent(match[1])
        return `<a class="paper-source" data-paper-id="${markdown.utils.escapeHtml(paperId)}" data-page="${match[2]}" role="button" tabindex="0">`
      } catch { /* A malformed source is rendered as a plain label. */ }
    }
    token.attrSet('href', '')
  }
  tokens[index].attrSet('target', '_blank')
  tokens[index].attrSet('rel', 'noopener noreferrer')
  return defaultLinkOpen
    ? defaultLinkOpen(tokens, index, options, env, self)
    : self.renderToken(tokens, index, options)
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

  return DOMPurify.sanitize(markdown.render(normalized), {
    USE_PROFILES: { html: true, mathMl: true },
    ADD_ATTR: ['target'],
  })
}
