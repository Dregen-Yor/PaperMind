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

const defaultLinkOpen = markdown.renderer.rules.link_open

markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
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
