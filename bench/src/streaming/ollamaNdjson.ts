export interface ParsedStream {
  content: string
  usage?: { inputTokens: number; outputTokens: number }
}

type Usage = { prompt_eval_count?: unknown; eval_count?: unknown }

function parseUsage(value: unknown): ParsedStream['usage'] | undefined {
  if (!value || typeof value !== 'object') return undefined
  const usage = value as Usage
  if (typeof usage.prompt_eval_count !== 'number' || typeof usage.eval_count !== 'number') return undefined
  return { inputTokens: usage.prompt_eval_count, outputTokens: usage.eval_count }
}

/** Parse an Ollama `/api/chat` NDJSON response body. */
export async function parseOllamaNdjson(
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

  const parseLine = (line: string): boolean => {
    if (line.trim().length === 0) return false

    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      throw new Error('malformed Ollama NDJSON payload')
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('malformed Ollama NDJSON record')
    }

    const message = (record as { message?: unknown }).message
    if (message && typeof message === 'object') {
      const visible = (message as { content?: unknown }).content
      if (typeof visible === 'string' && visible.length > 0) {
        content += visible
        onVisibleText(visible)
      }
    }

    const completed = (record as { done?: unknown }).done === true
    const parsedUsage = parseUsage(record)
    if (parsedUsage) usage = parsedUsage
    if (parsedUsage && completed) onCompleteUsage?.(parsedUsage)
    if (completed) {
      terminalSeen = true
      cancelReader()
      return true
    }
    return false
  }

  const parseCompleteLines = (): boolean => {
    let newline = carry.indexOf('\n')
    while (newline >= 0) {
      const line = carry.slice(0, newline).replace(/\r$/, '')
      carry = carry.slice(newline + 1)
      if (parseLine(line)) return true
      newline = carry.indexOf('\n')
    }
    return false
  }

  while (!terminalSeen) {
    const { done: streamDone, value } = await reader.read()
    if (streamDone) break
    carry += decoder.decode(value, { stream: true })
    if (parseCompleteLines()) {
      carry += decoder.decode()
      if (carry.trim().length > 0) {
        throw new Error('Ollama NDJSON data appeared after the done:true terminal marker')
      }
    }
  }

  if (!terminalSeen) {
    carry += decoder.decode()
    parseCompleteLines()
    if (!terminalSeen && carry.length > 0) {
      const finalLine = carry.replace(/\r$/, '')
      carry = ''
      parseLine(finalLine)
    }
    if (!terminalSeen) {
      throw new Error('Ollama NDJSON stream ended before the done:true terminal marker')
    }
    if (carry.trim().length > 0) {
      throw new Error('Ollama NDJSON data appeared after the done:true terminal marker')
    }
  }

  if (content.length === 0) throw new Error('Ollama NDJSON stream ended with empty final content')
  return usage ? { content, usage } : { content }
}
