import { readFile } from 'node:fs/promises'
import type { EvalSample, EvidenceSentence, QaQuestion } from '../types'
import { benchPath } from '../paths'
import { PSEUDO_PAGE_CHARS } from './qasper'

export const PEERQA_DATASET_VERSION = 1
export const normalizeSentenceText = (text: string): string =>
  text.normalize('NFKC').replace(/[\s\u00ad]+/gu, '')

interface PaperRow {
  paper_id: string
  idx: number
  pidx: number
  sidx: number
  type: string
  content: string
  last_heading?: string
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PeerQA row must be an object')
  return value as Record<string, unknown>
}

function nonempty(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`PeerQA ${name} must be nonempty`)
  return value
}

function integer(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`PeerQA ${name} must be an integer`)
  return value
}

function evidenceIndices(value: unknown): Array<Array<number | null>> {
  if (value === null || value === undefined) return []
  const entries = Array.isArray(value) ? value.map(entry => object(entry).idx) : object(value).idx
  if (!Array.isArray(entries)) throw new Error('PeerQA evidence idx must be an array')
  return entries.map(indices => {
    if (!Array.isArray(indices)) throw new Error('PeerQA evidence idx must contain arrays')
    return indices.map(index => index === null ? null : integer(index, 'evidence idx'))
  })
}

function paperText(rows: PaperRow[]): { pages: string[]; sentences: EvidenceSentence[]; rowIds: Map<number, string>; ambiguousRows: Set<number> } {
  const pages: string[] = []
  const sentences: EvidenceSentence[] = []
  const rowIds = new Map<number, string>()
  const ambiguousIds = new Set<string>()
  const seenSentenceIds = new Set<string>()
  const paragraphGroups: PaperRow[][] = []
  for (const row of rows) {
    const last = paragraphGroups.at(-1)
    if (last && last[0].pidx === row.pidx && last[0].type !== 'title' && row.type !== 'title') last.push(row)
    else paragraphGroups.push([row])
  }
  let heading = ''
  for (const group of paragraphGroups) {
    const nextHeading = group[0].last_heading?.trim() ?? ''
    const prefix = nextHeading && nextHeading !== heading ? `${nextHeading}\n\n` : ''
    if (nextHeading) heading = nextHeading
    const text = prefix + group.map(row => row.content).join(' ')
    let page = pages.length - 1
    if (page < 0 || pages[page].length + text.length + 2 > PSEUDO_PAGE_CHARS) {
      pages.push('')
      page++
    }
    const before = pages[page] ? `${pages[page]}\n\n` : ''
    let offset = normalizeSentenceText(before + prefix).length
    for (const row of group) {
      const normalized = normalizeSentenceText(row.content)
      if (row.type !== 'title' && row.type !== 'heading' && normalized.length > 0) {
        const id = `${row.paper_id}/${row.pidx}/${row.sidx}`
        if (seenSentenceIds.has(id)) ambiguousIds.add(id)
        seenSentenceIds.add(id)
        sentences.push({ id, page, text: row.content, start: offset, end: offset + normalized.length })
        rowIds.set(row.idx, id)
      }
      offset += normalized.length
    }
    pages[page] = before + text
  }
  const ambiguousRows = new Set<number>()
  for (const [idx, id] of rowIds) if (ambiguousIds.has(id)) { ambiguousRows.add(idx); rowIds.delete(idx) }
  return { pages, sentences: sentences.filter(sentence => !ambiguousIds.has(sentence.id)), rowIds, ambiguousRows }
}

export function normalizePeerQa(qa: unknown[], papers: unknown[]): {
  samples: EvalSample[]
  preparation: { inputQuestions: number; missingPaperQuestions: number; unlabeledQuestions: number }
} {
  const byPaper = new Map<string, PaperRow[]>()
  const rowKeys = new Set<string>()
  for (const input of papers) {
    const raw = object(input)
    const paper_id = nonempty(raw.paper_id, 'paper_id')
    const idx = integer(raw.idx, 'idx')
    const key = `${paper_id}\0${idx}`
    if (rowKeys.has(key)) throw new Error(`duplicate PeerQA row ${paper_id}/${idx}`)
    rowKeys.add(key)
    const row: PaperRow = {
      paper_id, idx, pidx: integer(raw.pidx, 'pidx'), sidx: integer(raw.sidx, 'sidx'),
      type: nonempty(raw.type, 'type'), content: typeof raw.content === 'string' ? raw.content : nonempty(raw.content, 'content'),
      ...(typeof raw.last_heading === 'string' ? { last_heading: raw.last_heading } : {}),
    }
    const group = byPaper.get(paper_id) ?? []
    group.push(row)
    byPaper.set(paper_id, group)
  }
  const samples = new Map<string, EvalSample>()
  const identities = new Map<string, Map<number, string>>()
  const ambiguousRows = new Map<string, Set<number>>()
  const seenQuestions = new Set<string>()
  let missingPaperQuestions = 0
  let unlabeledQuestions = 0
  for (const input of qa) {
    const raw = object(input)
    const id = nonempty(raw.question_id, 'question_id')
    if (seenQuestions.has(id)) throw new Error(`duplicate PeerQA question id ${id}`)
    seenQuestions.add(id)
    const paperId = nonempty(raw.paper_id, 'paper_id')
    const questionText = nonempty(raw.question, 'question')
    if (raw.answerable === null) { unlabeledQuestions++; continue }
    if (typeof raw.answerable !== 'boolean') throw new Error(`PeerQA ${id} answerable must be boolean or null`)
    const rows = byPaper.get(paperId)
    if (!rows) { missingPaperQuestions++; continue }
    let sample = samples.get(paperId)
    if (!sample) {
      const ordered = [...rows].sort((a, b) => a.idx - b.idx)
      const built = paperText(ordered)
      sample = {
        paperId, title: ordered.find(row => row.type === 'title')?.content ?? paperId,
        source: 'peerqa', pages: built.pages, sentences: built.sentences, questions: [],
      }
      samples.set(paperId, sample)
      identities.set(paperId, built.rowIds)
      ambiguousRows.set(paperId, built.ambiguousRows)
    }
    const indices = evidenceIndices(raw.answer_evidence_mapped)
    const evidence = new Set<string>()
    let mapping: QaQuestion['sentenceEvidenceMapping'] = indices.length > 0 ? 'mapped' : 'unmapped'
    for (const group of indices) {
      if (group.length === 0) mapping = 'unmapped'
      for (const idx of group) {
        const sentenceId = idx === null ? undefined : identities.get(paperId)!.get(idx)
        if (idx !== null && ambiguousRows.get(paperId)!.has(idx)) {
          if (mapping !== 'unmapped') mapping = 'ambiguous'
        } else if (sentenceId) evidence.add(sentenceId)
        else mapping = 'unmapped'
      }
    }
    const freeAnswer = typeof raw.answer_free_form === 'string' ? raw.answer_free_form.trim() : ''
    const evidencePages = sample.sentences!.filter(sentence => evidence.has(sentence.id)).map(sentence => sentence.page)
    sample.questions.push({
      id, question: questionText, answers: freeAnswer ? [freeAnswer] : [],
      evidencePages: [...new Set(evidencePages)].sort((a, b) => a - b),
      unanswerable: !raw.answerable,
      evidenceSentenceIds: [...evidence], sentenceEvidenceMapping: mapping,
      hasSentenceEvidence: indices.length > 0 || (Array.isArray(raw.raw_answer_evidence) && raw.raw_answer_evidence.length > 0),
      evidenceMapping: mapping,
    })
  }
  const preparation = { inputQuestions: qa.length, missingPaperQuestions, unlabeledQuestions }
  const result = [...samples.values()]
  for (const sample of result) sample.peerqaPreparation = preparation
  validatePeerQaSamples(result)
  return { samples: result, preparation }
}

export function validatePeerQaSamples(samples: EvalSample[]): void {
  const paperIds = new Set<string>()
  const questionIds = new Set<string>()
  for (const sample of samples) {
    if (sample.source !== 'peerqa' || typeof sample.paperId !== 'string' || !sample.paperId.trim()
      || typeof sample.title !== 'string' || !sample.title.trim() || !Array.isArray(sample.pages)
      || sample.pages.length === 0 || sample.pages.some(page => typeof page !== 'string')
      || !Array.isArray(sample.sentences) || !Array.isArray(sample.questions)) throw new Error('Invalid PeerQA normalized sample')
    if (paperIds.has(sample.paperId)) throw new Error(`duplicate PeerQA paper ${sample.paperId}`)
    paperIds.add(sample.paperId)
    const sentenceIds = new Set<string>()
    const pages = sample.pages.map(normalizeSentenceText)
    for (const sentence of sample.sentences) {
      if (!sentence.id || sentenceIds.has(sentence.id)) throw new Error('duplicate or empty PeerQA sentence id')
      sentenceIds.add(sentence.id)
      if (!Number.isInteger(sentence.page) || !Number.isInteger(sentence.start) || !Number.isInteger(sentence.end)
        || sentence.page < 0 || sentence.page >= pages.length || sentence.start < 0
        || sentence.end <= sentence.start || sentence.end > (pages[sentence.page]?.length ?? 0) || typeof sentence.text !== 'string'
        || pages[sentence.page]?.slice(sentence.start, sentence.end) !== normalizeSentenceText(sentence.text)) {
        throw new Error(`Invalid PeerQA sentence span ${sentence.id}`)
      }
    }
    const ordered = [...sample.sentences].sort((a, b) => a.page - b.page || a.start - b.start)
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i].page === ordered[i - 1].page && ordered[i].start < ordered[i - 1].end) throw new Error('overlapping PeerQA sentence spans')
    }
    for (const question of sample.questions) {
      if (typeof question.id !== 'string' || !question.id.trim() || questionIds.has(question.id)) throw new Error('duplicate or empty PeerQA question id')
      questionIds.add(question.id)
      if (typeof question.question !== 'string' || !question.question.trim() || typeof question.unanswerable !== 'boolean'
        || !Array.isArray(question.answers) || question.answers.some(answer => typeof answer !== 'string' || !answer.trim())
        || !Array.isArray(question.evidencePages) || question.evidencePages.some(page => !Number.isInteger(page) || page < 0 || page >= pages.length)
        || !Array.isArray(question.evidenceSentenceIds) || question.evidenceSentenceIds.some(id => !sentenceIds.has(id))
        || new Set(question.evidenceSentenceIds).size !== question.evidenceSentenceIds.length
        || !['mapped', 'ambiguous', 'unmapped'].includes(question.sentenceEvidenceMapping ?? '')) {
        throw new Error(`Invalid PeerQA evidence or references ${question.id}`)
      }
      if (question.sentenceEvidenceMapping === 'mapped' && question.evidenceSentenceIds.length === 0) throw new Error('mapped PeerQA evidence must be nonempty')
    }
  }
}

export async function loadPeerQaDataset(path = benchPath(import.meta.url, '../../datasets/peerqa/peerqa.jsonl')): Promise<EvalSample[]> {
  let text: string
  try { text = await readFile(path, 'utf8') } catch {
    throw new Error(`PeerQA 数据集不存在：${path}。先运行 npm run bench:peerqa:import -- --qa <qa.jsonl> --papers <papers.jsonl>。`)
  }
  const rows = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as { schemaVersion: number; sample: EvalSample })
  if (rows.some(row => row.schemaVersion !== PEERQA_DATASET_VERSION || !row.sample)) throw new Error('PeerQA dataset schema mismatch; re-import official data')
  const samples = rows.map(row => row.sample)
  validatePeerQaSamples(samples)
  if (samples.length === 0) throw new Error('PeerQA dataset is empty')
  return samples
}
