// @vitest-environment node
import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { testDoclingConnection } from '../../electron/doclingClient'
import { DEFAULT_DOCLING_SETTINGS } from '../utils/doclingDocument'

describe('Docling credentials at the real HTTP boundary', () => {
  it('never follows a redirect carrying the configured API key', async () => {
    const received: string[] = []
    const server = createServer((request, response) => {
      received.push(request.url || '')
      response.writeHead(302, { Location: '/credential-sink' })
      response.end()
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    try {
      const port = (server.address() as { port: number }).port
      await expect(testDoclingConnection({ ...DEFAULT_DOCLING_SETTINGS,
        baseUrl: `http://127.0.0.1:${port}`, apiKey: 'fixture-key',
      })).rejects.toThrow()
      expect(received).toEqual(['/openapi.json'])
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) })
    }
  })
})
