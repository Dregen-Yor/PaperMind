export interface ParsedStream {
  content: string
  usage?: { inputTokens: number; outputTokens: number }
}

type Usage = { prompt_tokens?: unknown; completion_tokens?: unknown }

function parseUsage(value: unknown): ParsedStream['usage'] | undefined {
  if (!value || typeof value !== 'object') return undefined
  const usage = value as Usage
  if (typeof usage.prompt_tokens !== 'number' || typeof usage.completion_tokens !== 'number') return undefined
  return { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens }
}

function eventData(event: string): string {
  return event
    .split(/\r\n|\r|\n/)
    .flatMap(line => {
      if (line === 'data') return ['']
      if (!line.startsWith('data:')) return []
      const value = line.slice('data:'.length)
      return [value.startsWith(' ') ? value.slice(1) : value]
    })
    .join('\n')
}

/** Parse an OpenAI-compatible chat-completions SSE response body. */
export async function parseOpenAiSse(
  stream: ReadableStream<Uint8Array>,
  onVisibleText: (delta: string) => void,
  onCompleteUsage?: (usage: NonNullable<ParsedStream['usage']>) => void,
): Promise<ParsedStream> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let carry = ''
  let content = ''
  let usage: ParsedStream['usage']
  let terminalSeen = false

  const cancelReader = () => {
    void reader.cancel().catch(() => {})
  }

  const parseEvent = (event: string): boolean => {
    const payload = eventData(event)
    if (payload === '') return false
    if (payload === '[DONE]') {
      terminalSeen = true
      cancelReader()
      return true
    }

    let record: unknown
    try {
      record = JSON.parse(payload)
    } catch {
      throw new Error('malformed OpenAI SSE payload')
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('malformed OpenAI SSE record')
    }

    const parsedUsage = parseUsage((record as { usage?: unknown }).usage)
    if (parsedUsage) {
      usage = parsedUsage
      onCompleteUsage?.(parsedUsage)
    }

    const choices = (record as { choices?: unknown }).choices
    if (!Array.isArray(choices)) return false
    for (const choice of choices) {
      if (!choice || typeof choice !== 'object') continue
      const delta = (choice as { delta?: unknown }).delta
      if (!delta || typeof delta !== 'object') continue
      const visible = (delta as { content?: unknown }).content
      if (typeof visible !== 'string' || visible.length === 0) continue
      content += visible
      onVisibleText(visible)
    }
    return false
  }

  const parseCompleteEvents = (): boolean => {
    const separator = /(?:\r\n|\r|\n)(?:\r\n|\r|\n)/
    let match = separator.exec(carry)
    while (match) {
      const event = carry.slice(0, match.index)
      carry = carry.slice(match.index + match[0].length)
      if (parseEvent(event)) return true
      match = separator.exec(carry)
    }
    return false
  }

  while (!terminalSeen) {
    const { done, value } = await reader.read()
    if (done) break
    carry += decoder.decode(value, { stream: true })
    if (parseCompleteEvents()) {
      carry += decoder.decode()
      if (carry.trim().length > 0) {
        throw new Error('OpenAI SSE data appeared after the [DONE] terminal marker')
      }
    }
  }

  if (!terminalSeen) {
    carry += decoder.decode()
    parseCompleteEvents()
    if (terminalSeen) {
      if (carry.trim().length > 0) {
        throw new Error('OpenAI SSE data appeared after the [DONE] terminal marker')
      }
    } else {
      if (carry.length > 0) throw new Error('incomplete OpenAI SSE event')
      throw new Error('OpenAI SSE stream ended before the [DONE] terminal marker')
    }
  }

  if (content.length === 0) throw new Error('OpenAI SSE stream ended with empty final content')
  return usage ? { content, usage } : { content }
}
