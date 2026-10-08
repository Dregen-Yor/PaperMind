/** Browser-safe SHA-256; used for cache identity, never for credentials. */
export function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
export function uniqueIds(ids: string[]) {
  requireThat(ids.every(id => typeof id === 'string' && id.length > 0) && new Set(ids).size === ids.length, 'invalid IDs')
}
const primes: number[] = []
for (let n = 2; primes.length < 64; n++) if (!primes.some(p => n % p === 0)) primes.push(n)
const fraction = (n: number) => (n % 1 * 0x100000000) | 0
const initial = primes.slice(0, 8).map(p => fraction(Math.sqrt(p)))
const constants = primes.map(p => fraction(Math.cbrt(p)))
const rotate = (n: number, b: number) => (n >>> b) | (n << (32 - b))
export function hashCanonical(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)])) : v
  const input = new TextEncoder().encode(JSON.stringify(sort(value)))
  const bytes = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64)
  bytes.set(input); bytes[input.length] = 128
  const view = new DataView(bytes.buffer)
  view.setUint32(bytes.length - 8, Math.floor(input.length / 0x20000000))
  view.setUint32(bytes.length - 4, input.length * 8)
  const h = [...initial]
  const w = new Int32Array(64)
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2]
      w[i] = w[i - 16] + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) + w[i - 7] + (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10))
    }
    let [a, b, c, d, e, f, g, j] = h
    for (let i = 0; i < 64; i++) {
      const t1 = (j + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + constants[i] + w[i]) | 0
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      j = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0
    }
    ;[a, b, c, d, e, f, g, j].forEach((n, i) => { h[i] = (h[i] + n) | 0 })
  }
  return h.map(n => (n >>> 0).toString(16).padStart(8, '0')).join('')
}
