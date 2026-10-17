export function canonicalWebPageUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw new Error('仅支持 HTTPS 网页')
  }
  url.hash = ''
  return url.href
}
