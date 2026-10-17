import { createHash } from 'crypto'

export function archiveAppearanceHash(archive: Buffer): string {
  // Blink gives every MHTML save a new date, boundary and cid even when its resources are identical.
  const raw = archive.toString('utf8')
  const boundary = raw.match(/\bboundary="?([^";\r\n]+)"?/i)?.[1]
  let stable = raw.replace(/^Date:[^\r\n]*/gmi, 'Date:')
  if (boundary) stable = stable.split(boundary).join('__boundary__')
  const cidParts = new Map<string, string>()
  if (boundary) {
    const parts = stable.split('--__boundary__')
    parts.forEach((part, index) => {
      const headers = part.split(/\r?\n\r?\n/, 1)[0]
      const location = headers.match(/^Content-Location:\s*cid:([^\r\n]+)/im)?.[1]
      const contentId = headers.match(/^Content-ID:\s*<([^>]+)>/im)?.[1]
      for (const cid of [location, contentId]) {
        if (cid) cidParts.set(cid, `cid:part-${index}@mhtml.blink`)
      }
    })
  }
  stable = stable.replace(/^Content-ID:[^\r\n]*/gmi, 'Content-ID:')
    .replace(/cid:([A-Za-z0-9._%+-]*(?:=\r?\n[A-Za-z0-9._%+-]*)*@mhtml\.blink)/gi,
      (reference, cid: string) => cidParts.get(cid.replace(/=\r?\n/g, '')) ?? reference)
  return `v2:${createHash('sha256').update(stable).digest('hex')}`
}
