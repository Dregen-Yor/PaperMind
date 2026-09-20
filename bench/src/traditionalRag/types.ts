import type { TraditionalRagConfig } from '../types'
import type { ContextPiece } from '../../../src/utils/contextTrace'

export interface BenchChunk { id: number; text: string; tokenCount: number; startPage: number; endPage: number; pieces: ContextPiece[] }
export interface ScoredChunk { id: number; score: number }
export interface Retriever { score(query: string): Promise<ScoredChunk[]> | ScoredChunk[] }
export interface BuiltRetriever extends Retriever { chunks: BenchChunk[] }
export interface TextTokenizer { tokenize(text: string): string[] }
/** 最大长度由 provider 创建时锁定，避免调用点传入却被 runtime 忽略。 */
export interface EmbeddingProvider { embed(texts: string[]): Promise<number[][]> }
export type { TraditionalRagConfig }
