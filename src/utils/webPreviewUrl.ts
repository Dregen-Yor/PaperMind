function parseWebUrl(value: string): URL | null {
  try {
    const parsed = new URL(value)
    if (!parsed.hostname || parsed.username || parsed.password) return null
    return parsed
  } catch {
    return null
  }
}

export function isAllowedPreviewUrl(url: string): boolean {
  return /^https:\/\//i.test(url) && parseWebUrl(url)?.protocol === 'https:'
}

export function isAllowedExternalUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) && ['http:', 'https:'].includes(parseWebUrl(url)?.protocol ?? '')
}

export function normalizePreviewUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('请输入网页链接')
  if (trimmed.startsWith('//')) throw new Error('请输入有效的 HTTPS 链接')

  // A host with a numeric port has a colon but no URL scheme.
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(trimmed)
    && !/^[^:/?#]+:\d+(?:[/?#]|$)/.test(trimmed)
  const candidate = hasScheme ? trimmed : `https://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error('请输入有效的 HTTPS 链接')
  }
  if (parsed.protocol !== 'https:') throw new Error('仅支持 HTTPS 链接')
  if (!parsed.hostname) throw new Error('请输入有效的 HTTPS 链接')
  if (parsed.username || parsed.password) throw new Error('链接中不能包含用户名或密码')
  return parsed.href
}
