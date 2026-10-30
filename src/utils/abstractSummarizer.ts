import { readBoundedJson } from './serviceSecurity'
export const ABSTRACT_MODEL = 'Bashaarat1/t5-small-arxiv-summarizer'
export const ABSTRACT_API_URL =
  `https://api-inference.huggingface.co/models/${ABSTRACT_MODEL}`

// The model accepts at most 512 tokens. English academic prose averages fewer
// than four characters per token, so this leaves room for the T5 task prefix.
const MAX_CHUNK_CHARS = 1600
const MAX_REDUCTION_ROUNDS = 6

export function splitAbstractText(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return []

  const sentences = normalized.match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/g) ?? [normalized]
  const chunks: string[] = []
  let current = ''

  const pushCurrent = () => {
    const value = current.trim()
    if (value) chunks.push(value)
    current = ''
  }

  for (const rawSentence of sentences) {
    let sentence = rawSentence.trim()
    if (!sentence) continue

    if (sentence.length > maxChars) {
      pushCurrent()
      while (sentence.length > maxChars) {
        let splitAt = sentence.lastIndexOf(' ', maxChars)
        if (splitAt < Math.floor(maxChars * 0.6)) splitAt = maxChars
        chunks.push(sentence.slice(0, splitAt).trim())
        sentence = sentence.slice(splitAt).trim()
      }
    }

    if (!sentence) continue
    if (current && current.length + sentence.length + 1 > maxChars) pushCurrent()
    current = current ? `${current} ${sentence}` : sentence
  }

  pushCurrent()
  return chunks
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const data = await readBoundedJson(response)
    if (typeof data?.error === 'string') return data.error
    if (typeof data?.message === 'string') return data.message
  } catch {
    // Fall back to the HTTP status below.
  }
  return `${response.status} ${response.statusText}`.trim()
}

export async function callAbstractModel(text: string, token: string): Promise<string> {
  const response = await fetch(ABSTRACT_API_URL, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(300_000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      inputs: `summarize: ${text}`,
      parameters: {
        max_length: 128,
        min_length: 30,
        do_sample: false,
      },
      options: { wait_for_model: true },
    }),
  })

  if (!response.ok) {
    const detail = await readErrorMessage(response)
    throw new Error(`Hugging Face 摘要服务请求失败：${detail}`)
  }

  const data = await readBoundedJson(response)
  const summary = Array.isArray(data)
    ? data[0]?.summary_text
    : data?.summary_text ?? data?.generated_text
  if (typeof summary !== 'string' || !summary.trim()) {
    throw new Error('Hugging Face 摘要服务未返回有效摘要')
  }
  return summary.trim()
}

export async function summarizeAcademicText(
  text: string,
  token: string,
  summarizeChunk: (chunk: string, token: string) => Promise<string> = callAbstractModel,
): Promise<string> {
  let chunks = splitAbstractText(text)
  if (chunks.length === 0) throw new Error('论文中没有可用于生成摘要的文本')

  for (let round = 0; round < MAX_REDUCTION_ROUNDS; round++) {
    const summaries: string[] = []
    // Keep requests sequential to avoid overwhelming hosted/community endpoints.
    for (const chunk of chunks) summaries.push(await summarizeChunk(chunk, token))
    if (summaries.length === 1) return summaries[0]
    chunks = splitAbstractText(summaries.join(' '))
  }

  throw new Error('论文内容过长，摘要模型未能在限定轮次内完成汇总')
}
