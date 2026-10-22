// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { isTrustedApplicationFrame } from '../../electron/ipcSecurity'

describe('application IPC trust boundary', () => {
  const frame = { url: 'file:///app/dist/index.html#/reader/a' }
  const sender = { mainFrame: frame }
  const expected = 'file:///app/dist/index.html'
  it('accepts only the registered main frame with the expected application URL', () => {
    expect(isTrustedApplicationFrame({ sender, senderFrame: frame }, [sender], expected)).toBe(true)
    expect(isTrustedApplicationFrame({ sender, senderFrame: { ...frame } }, [sender], expected)).toBe(false)
    expect(isTrustedApplicationFrame({ sender, senderFrame: frame }, [], expected)).toBe(false)
    expect(isTrustedApplicationFrame({ sender, senderFrame: { url: 'https://evil.org' } }, [sender], expected)).toBe(false)
    const navigated = { url: 'file:///app/other.html' }
    const changed = { mainFrame: navigated }
    expect(isTrustedApplicationFrame({ sender: changed, senderFrame: navigated }, [changed], expected)).toBe(false)
  })
})
