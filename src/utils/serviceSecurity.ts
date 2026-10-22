export const MAX_SERVICE_JSON_BYTES = 32 * 1024 * 1024

/** Check the original authority before WHATWG URL canonicalizes unusual IP spellings. */
export function validateServiceUrl(value: string): string {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f\\]/.test(value)) throw new Error('服务地址包含无效字符')
  const authority = value.match(/^https?:\/\/([^/?#]+)/i)?.[1]
  if (!authority || /[^\x21-\x7e]/.test(authority)) throw new Error('服务地址必须使用规范的 HTTP/HTTPS 主机名')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('服务地址无效') }
  if (url.username || url.password) throw new Error('服务地址不能包含凭据，请使用 API Key 字段')
  const host = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.split(':')[0]
  if (host.toLowerCase() !== url.hostname.toLowerCase() || url.hostname.endsWith('.')) throw new Error('服务地址必须使用规范主机名或 IP 地址')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('远程服务必须使用 HTTPS；HTTP 仅允许本机回环地址')
  }
  return value
}

/** Limits bytes after fetch decompression, including chunked responses without Content-Length. */
export async function readBoundedText(response: Response, limit = MAX_SERVICE_JSON_BYTES): Promise<string> {
  const declared = Number(response.headers?.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel()
    throw new Error('服务响应超过大小上限')
  }
  if (!response.body) return response.text()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > limit) throw new Error('服务响应超过大小上限')
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function readBoundedJson(response: Response, limit = MAX_SERVICE_JSON_BYTES): Promise<any> {
  if (!response.body) return response.json()
  return JSON.parse(await readBoundedText(response, limit))
}
