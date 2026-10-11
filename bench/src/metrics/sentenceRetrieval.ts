import type { ContextPiece } from '../../../src/utils/contextTrace'
import type { EvalSample, PerSampleRecord, QaQuestion } from '../types'
import { normalizeSentenceText } from '../datasets/peerqa'
import type { EvaluationContract } from '../evaluationContract'

export const SENTENCE_RETRIEVAL_DEFINITION = 'final-context-sentence-v1' as const
export const SENTENCE_MAPPING_VERSION = 'peerqa-official-spans-v1' as const
export const SENTENCE_METRICS = ['sentenceEvidenceRecall', 'annotatedSentencePrecision', 'allGoldSentenceCoverage'] as const
export const ZERO_SENTENCE_METRICS = { sentenceEvidenceRecall: 0, annotatedSentencePrecision: 0, allGoldSentenceCoverage: 0 }

export class SentenceContractViolation extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SentenceContractViolation'
  }
}

export function isSentenceRetrievalEligible(question: QaQuestion): boolean {
  return !question.unanswerable && question.sentenceEvidenceMapping === 'mapped'
    && (question.evidenceSentenceIds?.length ?? 0) > 0
}

export function computeSentenceMetrics(gold: string[], covered: string[]) {
  const evidence = new Set(gold)
  if (evidence.size === 0) throw new SentenceContractViolation('Sentence metrics require nonempty gold evidence')
  const context = new Set(covered)
  const hits = [...context].filter(id => evidence.has(id)).length
  return {
    sentenceEvidenceRecall: hits / evidence.size,
    annotatedSentencePrecision: context.size === 0 ? 0 : hits / context.size,
    allGoldSentenceCoverage: hits === evidence.size ? 1 : 0,
  }
}

export function traceSentenceCoverage(sample: EvalSample, pieces: ContextPiece[] | undefined): string[] {
  if (!pieces || !sample.sentences) throw new SentenceContractViolation('Sentence evaluation requires final context provenance and sentence corpus')
  const pages = sample.pages.map(normalizeSentenceText)
  const intervals = new Map<number, Array<{ start: number; end: number }>>()
  for (const piece of pieces) {
    const fragment = normalizeSentenceText(piece.text)
    if (!fragment) continue
    const source = pages[piece.page]
    const start = source?.indexOf(fragment) ?? -1
    if (start < 0) throw new SentenceContractViolation(`Final fragment has no source match on page ${piece.page}`)
    if (source.indexOf(fragment, start + 1) >= 0) throw new SentenceContractViolation(`Final fragment has ambiguous source spans on page ${piece.page}`)
    const list = intervals.get(piece.page) ?? []
    list.push({ start, end: start + fragment.length })
    intervals.set(piece.page, list)
  }
  for (const [page, list] of intervals) {
    list.sort((a, b) => a.start - b.start || a.end - b.end)
    const merged: typeof list = []
    for (const interval of list) {
      const previous = merged.at(-1)
      if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end)
      else merged.push({ ...interval })
    }
    intervals.set(page, merged)
  }
  return sample.sentences.filter(sentence => intervals.get(sentence.page)
    ?.some(interval => interval.start <= sentence.start && interval.end >= sentence.end)).map(sentence => sentence.id)
}

export function applySentenceRetrieval(record: PerSampleRecord, sample: EvalSample, question: QaQuestion, pieces: ContextPiece[] | undefined): void {
  if (sample.source !== 'peerqa' || !isSentenceRetrievalEligible(question)) return
  const corpus = new Set(sample.sentences?.map(sentence => sentence.id))
  if (question.evidenceSentenceIds!.some(id => !corpus.has(id))) throw new SentenceContractViolation('Gold evidence is absent from the frozen sentence corpus')
  record.contextSentenceIds = traceSentenceCoverage(sample, pieces)
  Object.assign(record.metrics, computeSentenceMetrics(question.evidenceSentenceIds!, record.contextSentenceIds))
}

export function assertSentenceDenominator(counts: Record<string, number>, contract: EvaluationContract): void {
  if (!contract.sentenceRetrievalDefinition) return
  for (const key of SENTENCE_METRICS) {
    if ((counts[key] ?? 0) !== contract.eligibleSentenceQuestionCount) {
      throw new SentenceContractViolation(`${key} denominator differs from frozen sentence question count`)
    }
  }
}
