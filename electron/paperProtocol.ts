import { realpathSync, statSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { pathToFileURL } from 'url'

const scheme = 'papermind-paper:'
const validPaperId = /^[A-Za-z0-9:_-]+$/

export function isSafePaperId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && validPaperId.test(value)
}

export function paperContentUrl(id: string): string {
  return `papermind-paper://paper/${encodeURIComponent(id)}`
}

export function paperIdFromUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== scheme || url.hostname !== 'paper' || url.port || url.username || url.password || url.search || url.hash) return null
    const path = url.pathname.slice(1)
    if (!path || path.includes('/')) return null
    const id = decodeURIComponent(path)
    return isSafePaperId(id) ? id : null
  } catch { return null }
}

// A DB row alone is not permission to serve an arbitrary local path. Serve only
// an existing PDF under the app's paper directory, with no symlink escape.
export function storedPaperFilePath(id: string, filePath: string | null | undefined, papersDir: string): string | null {
  if (!isSafePaperId(id) || !filePath) return null
  const expected = resolve(join(papersDir, `${id}.pdf`))
  if (resolve(filePath) !== expected) return null
  try {
    const root = realpathSync(papersDir)
    const realFile = realpathSync(expected)
    return dirname(realFile) === root && statSync(realFile).isFile() ? realFile : null
  } catch { return null }
}

export async function servePaperRequest(
  request: Request,
  findFile: (id: string) => string | null,
  fetchFile: (url: string, headers: Headers) => Promise<Response>,
): Promise<Response> {
  const headers = new Headers({ 'Access-Control-Allow-Origin': '*' })
  if (request.method === 'OPTIONS') {
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    headers.set('Access-Control-Allow-Headers', 'Range')
    return new Response(null, { status: 204, headers })
  }
  const id = paperIdFromUrl(request.url)
  const file = id ? findFile(id) : null
  if (!file) return new Response('Paper not found', { status: 404, headers })
  try {
    const response = await fetchFile(pathToFileURL(file).toString(), request.headers)
    const resultHeaders = new Headers(response.headers)
    resultHeaders.set('Content-Type', 'application/pdf')
    resultHeaders.set('Access-Control-Allow-Origin', '*')
    return new Response(response.body, { status: response.status, headers: resultHeaders })
  } catch {
    return new Response('Paper could not be opened', { status: 500, headers })
  }
}
