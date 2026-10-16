import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../utils/markdown'

describe('renderMarkdown', () => {
  it('groups old report images with their short source label and repairs detached punctuation', () => {
    const id = 'a'.repeat(64)
    const html = renderMarkdown(`结果提高 [p2](paper-source:paper:1)。\n\n![原文图片](asset:${id})\n\n*原文图片* [p2](paper-source:paper:1)\n\n；后续实验也支持这一点。`)
    const container = document.createElement('div')
    container.innerHTML = html
    const figure = container.querySelector('figure.paper-evidence--image')
    expect(figure?.querySelector('img')?.getAttribute('data-asset-id')).toBe(id)
    expect(figure?.querySelector('figcaption')?.textContent).toContain('原文图片')
    expect(figure?.querySelector('figcaption .paper-source')?.textContent).toBe('p2')
    expect(container.querySelectorAll('p')).toHaveLength(2)
    expect(container.querySelectorAll('p')[1].textContent).toBe('后续实验也支持这一点。')
  })

  it('groups a sourced display formula without altering ordinary formulas', () => {
    const html = renderMarkdown('$$\nx = y\n$$\n\n[p4](paper-source:paper:3)')
    const container = document.createElement('div')
    container.innerHTML = html
    expect(container.querySelector('figure.paper-evidence--formula .katex-display')).not.toBeNull()
    expect(container.querySelector('figcaption .paper-source')?.textContent).toBe('p4')
    expect(renderMarkdown('$$\nx = y\n$$')).not.toContain('paper-evidence')
  })

  it('removes punctuation and a duplicated source line after consecutive evidence blocks', () => {
    const id = 'a'.repeat(64)
    const html = renderMarkdown(`论述尚未结束 [p2](paper-source:paper:1)\n\n$$\nx = y\n$$\n\n[p2](paper-source:paper:1)\n\n![原文图片](asset:${id})\n\n*原文图片* [p2](paper-source:paper:1)\n\n；后续论述。\n\n[p2](paper-source:paper:1)`)
    const container = document.createElement('div')
    container.innerHTML = html
    expect(container.querySelectorAll('figure.paper-evidence')).toHaveLength(2)
    expect(container.querySelectorAll('p')).toHaveLength(2)
    expect(container.querySelectorAll('p')[0].textContent).toContain('论述尚未结束 p2；')
    expect(container.querySelectorAll('p')[1].textContent).toBe('后续论述。 p2')
  })
  it('moves a page-only line after a figure back onto the preceding claim', () => {
    const id = 'a'.repeat(64)
    const html = renderMarkdown(`评测增幅最大\n\n![原文表格](asset:${id})\n\n*原文表格* [p29](paper-source:paper:28)\n\n[p30](paper-source:paper:29)。 [p29](paper-source:paper:28)`)
    const container = document.createElement('div')
    container.innerHTML = html
    expect(container.querySelectorAll('p')).toHaveLength(1)
    expect(container.querySelector('p')?.textContent).toBe('评测增幅最大 p30。')
    expect(container.querySelector('figcaption')?.textContent).toContain('p29')
  })
  it('renders common Markdown structures', () => {
    const html = renderMarkdown(`# Heading

- first
- second

\`inline\`

\`\`\`ts
const answer = 42
\`\`\`

| A | B |
| - | - |
| 1 | 2 |`)

    expect(html).toContain('<h1>Heading</h1>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<code>inline</code>')
    expect(html).toContain('<pre><code class="language-ts">')
    expect(html).toContain('<table>')
  })

  it('opens links externally without exposing the opener', () => {
    const html = renderMarkdown('[Paper](https://example.com/paper)')

    expect(html).toContain('href="https://example.com/paper"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('does not render raw or dangerous HTML', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)"><script>alert(1)</script>')

    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;img')
  })

  it('does not create links for unsafe protocols', () => {
    const html = renderMarkdown('[unsafe](javascript:alert(1))')

    expect(html).not.toContain('<a ')
  })

  it('renders dollar-delimited inline and display LaTeX', () => {
    const html = renderMarkdown('Inline $E = mc^2$.\n\n$$\n\\int_0^1 x^2 \\, dx\n$$')

    expect(html).toContain('class="katex"')
    expect(html).toContain('class="katex-display"')
    expect(html).toContain('<math')
  })

  it('normalizes bracket-delimited display LaTeX to dollar delimiters', () => {
    const html = renderMarkdown('\\[\\sum_{i=1}^{n} i\\]')

    expect(html).toContain('class="katex-display"')
    expect(html).not.toContain('\\[')
    expect(html).not.toContain('\\]')
  })

  it('normalizes parenthesis-delimited inline LaTeX to dollar delimiters', () => {
    const html = renderMarkdown('维度为 \\(d\\)，索引为 \\(k = 0, 1, \\dots, \\frac{d}{2}\\)。')
    const container = document.createElement('div')
    container.innerHTML = html

    expect(container.querySelectorAll('.katex')).toHaveLength(2)
    expect(container.querySelector('.katex-html')?.textContent).not.toContain('\\')
    expect(html).not.toContain('\\(')
    expect(html).not.toContain('\\)')
  })
})
