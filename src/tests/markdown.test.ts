import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../utils/markdown'

describe('renderMarkdown', () => {
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
