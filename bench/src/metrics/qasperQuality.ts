export interface QasperAnswerAnnotation {
  unanswerable?: boolean
  extractive_spans?: readonly string[]
  free_form_answer?: string
  yes_no?: boolean | null
}

const referenceError = (): Error => new Error('QASPER annotation has no valid reference answer')

/** Convert one QASPER annotator response using the official evaluator precedence. */
export function qasperReference(annotation: QasperAnswerAnnotation): string {
  if (!annotation || typeof annotation !== 'object') throw referenceError()
  if (annotation.unanswerable !== undefined && typeof annotation.unanswerable !== 'boolean') throw referenceError()
  if (annotation.free_form_answer !== undefined && typeof annotation.free_form_answer !== 'string') throw referenceError()
  if (annotation.yes_no !== undefined && annotation.yes_no !== null && typeof annotation.yes_no !== 'boolean') {
    throw referenceError()
  }
  if (annotation.extractive_spans !== undefined && !Array.isArray(annotation.extractive_spans)) {
    throw referenceError()
  }
  const spans = annotation.extractive_spans ?? []
  if (spans.some(span => typeof span !== 'string' || span.trim().length === 0)) throw referenceError()
  if (annotation.unanswerable === true) return 'Unanswerable'
  if (spans.length > 0) return spans.join(', ')

  if (typeof annotation.free_form_answer === 'string' && annotation.free_form_answer.trim()) {
    return annotation.free_form_answer
  }
  if (annotation.yes_no === true) return 'Yes'
  if (annotation.yes_no === false) return 'No'
  throw referenceError()
}

function normalizedTokens(value: string): string[] {
  const normalized = value
    .toLowerCase()
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, '')
    // Python's official evaluator uses Unicode-aware `\b`/`\w`; JavaScript `\b`
    // is ASCII-only even with /u, so spell out the equivalent word characters.
    .replace(/(?<![\p{L}\p{N}_])(a|an|the)(?![\p{L}\p{N}_])/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return normalized ? normalized.split(' ') : []
}

function tokenF1(answer: string, reference: string): number {
  const answerTokens = normalizedTokens(answer)
  const referenceTokens = normalizedTokens(reference)
  const remaining = new Map<string, number>()
  for (const token of referenceTokens) remaining.set(token, (remaining.get(token) ?? 0) + 1)
  let shared = 0
  for (const token of answerTokens) {
    const count = remaining.get(token) ?? 0
    if (count <= 0) continue
    shared++
    remaining.set(token, count - 1)
  }
  // Matches the official QASPER evaluator, including normalized-empty versus empty.
  if (shared === 0) return 0
  const precision = shared / answerTokens.length
  const recall = shared / referenceTokens.length
  return 2 * precision * recall / (precision + recall)
}

/** Official token-multiset F1, taking the best score across annotator references. */
export function qasperAnswerF1(answer: string, references: readonly string[]): number {
  if (typeof answer !== 'string') throw new Error('QASPER answer must be a string')
  if (!Array.isArray(references) || references.length === 0) {
    throw new Error('QASPER reference answers must be a non-empty array')
  }
  for (const reference of references) {
    if (typeof reference !== 'string' || reference.trim().length === 0) {
      throw new Error('QASPER reference answers must contain non-empty strings')
    }
  }
  return Math.max(...references.map(reference => tokenF1(answer, reference)))
}
