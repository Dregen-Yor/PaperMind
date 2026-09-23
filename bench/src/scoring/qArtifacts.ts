import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { BenchResult } from '../types'
import type { QComparison } from './qComparison'

export interface QSource<T = unknown> {
  name: string
  sha256: string
  data: T
}

export interface QArtifact {
  schemaVersion: 1
  kind: 'papermind-q-comparison'
  comparison: QComparison
  inputs: {
    reference: QSource<BenchResult>
    candidate: QSource<BenchResult>
    config: QSource
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readBenchResult(value: unknown): BenchResult {
  if (!object(value)) throw new Error('Benchmark result must be an object')
  if (value.task !== 'qa' && value.task !== 'summary') throw new Error('Benchmark result task must be qa or summary')
  if (!object(value.meta)) throw new Error('Benchmark result meta must be an object')
  if (!object(value.config) || typeof value.config.name !== 'string' || !value.config.name.trim()) {
    throw new Error('Benchmark result config.name must be a nonempty string')
  }
  if (!object(value.metrics)) throw new Error('Benchmark result metrics must be an object')
  if (!Array.isArray(value.perSample) || value.perSample.some(row => !object(row) || typeof row.id !== 'string' || !row.id.trim() || !object(row.metrics))) {
    throw new Error('Benchmark result perSample must contain rows with id and metrics object')
  }
  if (!Array.isArray(value.errors)) throw new Error('Benchmark result errors must be an array')
  return value as unknown as BenchResult
}

/** Retains the parsed source, including fields unknown to the current benchmark schema. */
export function readQSource(path: string): QSource {
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch {
    throw new Error(`Cannot read Q input file: ${basename(path)}`)
  }
  let data: unknown
  try {
    data = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error(`Q input is not valid JSON: ${basename(path)}`)
  }
  return { name: basename(path), sha256: createHash('sha256').update(bytes).digest('hex'), data }
}

const credentialKey = /^(api[_-]?key|authorization|access[_-]?token|secret|password)$/i

/** Key-based credential guard; free text is deliberately outside its scope. */
function rejectCredentialKeys(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value !== 'object' || value === null) return
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const child of value) rejectCredentialKeys(child, seen)
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (credentialKey.test(key)) throw new Error(`Q artifact contains a credential key: ${key}`)
    rejectCredentialKeys(child, seen)
  }
}

export function writeQArtifact(path: string, artifact: unknown): void {
  rejectCredentialKeys(artifact)
  const serialized = JSON.stringify(artifact, null, 2)
  if (serialized === undefined) throw new Error('Q artifact must be JSON serializable')
  try {
    writeFileSync(path, serialized, { flag: 'wx' })
  } catch (error) {
    const code = object(error) ? error.code : undefined
    if (code === 'EEXIST') throw new Error('Q artifact path already exists; choose a new path')
    if (code === 'ENOENT') throw new Error('Q artifact parent directory does not exist')
    throw error
  }
}
