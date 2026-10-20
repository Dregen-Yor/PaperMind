/** Providers must explicitly terminate a stream; a closed socket alone is not success. */
export async function readProviderStream(
  response: Response,
  provider: 'openai' | 'anthropic' | 'ollama',
  onToken: (token: string) => void,
  signal?: AbortSignal,
): Promise<{ content: string; truncated: boolean }> {
  if (!response.body) throw new Error('流式响应不可用')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let truncated = false
  let terminal = false
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  const consume = (line: string) => {
    let payload = line.trim()
    if (!payload || terminal) return
    if (provider !== 'ollama') {
      if (!payload.startsWith('data:')) return
      payload = payload.slice(5).trim()
      if (provider === 'openai' && payload === '[DONE]') { terminal = true; return }
    }
    if (!payload) return
    let data: any
    try { data = JSON.parse(payload) } catch { throw new Error('模型流式响应格式错误') }
    if (data.error || data.type === 'error') {
      throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || '模型服务返回错误')
    }
    const token = provider === 'openai' ? data.choices?.[0]?.delta?.content
      : provider === 'anthropic' ? (data.type === 'content_block_delta' ? data.delta?.text : undefined)
        : data.message?.content
    if (typeof token === 'string' && token) { content += token; onToken(token) }
    if (provider === 'openai' && data.choices?.[0]?.finish_reason != null) {
      truncated = data.choices[0].finish_reason === 'length'
      terminal = true
    } else if (provider === 'anthropic') {
      if (data.type === 'message_delta' && data.delta?.stop_reason === 'max_tokens') truncated = true
      if (data.type === 'message_stop') terminal = true
    } else if (provider === 'ollama' && data.done === true) {
      truncated = data.done_reason === 'length'
      terminal = true
    }
  }
  try {
    for (;;) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) consume(line)
      if (done) { consume(buffer); break }
      if (terminal) break
    }
    if (!terminal) throw new Error('回答在正常结束前中断，请重试或继续')
    if (!content.trim()) throw new Error('模型返回了空响应')
    return { content, truncated }
  } finally {
    signal?.removeEventListener('abort', cancel)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
