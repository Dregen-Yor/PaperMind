import { describe, expect, it } from 'vitest'
import { loadConfigs, retrievalTokenizerIdentity } from '../config'
import { CONTEXT_BUDGET_TOKENS, CONTEXT_TOKENIZER_MODEL, CONTEXT_TOKENIZER_REVISION } from '../evaluationContract'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 一份合法传统 RAG 配置，用于逐项变异出被拒绝的口径。 */
function traditional(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'rag',
    kind: 'traditional-rag',
    chunking: { tokenizer: 'bge-m3', chunkSize: 10, overlap: 0 },
    retrieval: { algorithm: 'jaccard', topK: 2 },
    generationContext: { topK: 1, maxTokens: CONTEXT_BUDGET_TOKENS },
    ...overrides,
  }
}

function writeConfig(raw: unknown): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'traditional-config-'))
  const path = join(dir, 'c.json')
  writeFileSync(path, JSON.stringify(raw))
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('traditional config', () => {
  it('loads each baseline as one validated point', async () => {
    for (const [name, algorithm] of [['rag-cosine', 'cosine'], ['rag-bm25', 'bm25'], ['rag-jaccard', 'jaccard']] as const) {
      const configs = await loadConfigs(name)
      expect(configs).toHaveLength(1)
      expect(configs[0]).toMatchObject({ name, kind: 'traditional-rag', retrieval: { algorithm } })
    }
  })
  it('rejects invalid traditional constraints and unknown matrix keys with their path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'traditional-config-'))
    try {
      const bad = join(dir, 'bad.json')
      // 除 overlap 外全部合法：让用例只考它自己断言的那条约束，不靠校验顺序侥幸通过
      writeFileSync(bad, JSON.stringify(traditional({ chunking: { tokenizer: 'bge-m3', chunkSize: 10, overlap: 10 } })))
      await expect(loadConfigs(bad)).rejects.toThrow(/chunking.overlap/)
      writeFileSync(bad, JSON.stringify({ name: 'bad', matrix: { topk: [1] } }))
      await expect(loadConfigs(bad)).rejects.toThrow(/matrix.topk/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  /**
   * 与传统 RAG 强基线同一个冻结口径：最终 4096 预算由 CLI 注入的 materializer 统一施加，
   * 配置里的 maxTokens 不再是可变实验参数。允许它偏离就等于允许某条基线偷偷换预算。
   */
  it('freezes generationContext.maxTokens to the shared controlled budget', async () => {
    const bad = writeConfig(traditional({ generationContext: { topK: 1, maxTokens: CONTEXT_BUDGET_TOKENS - 2048 } }))
    const ok = writeConfig(traditional({ retrieval: { algorithm: 'jaccard', topK: 3 }, generationContext: { topK: 2, maxTokens: CONTEXT_BUDGET_TOKENS } }))
    try {
      await expect(loadConfigs(bad.path)).rejects.toThrow(new RegExp(`冻结口径 ${CONTEXT_BUDGET_TOKENS}`))
      // 冻结挡不住候选选择控制：topK 仍是各方法自己的实验参数
      expect((await loadConfigs(ok.path))[0]).toMatchObject({ generationContext: { topK: 2, maxTokens: CONTEXT_BUDGET_TOKENS } })
    } finally { bad.cleanup(); ok.cleanup() }
  })

  /**
   * 受控物化器要复用检索侧已加载的 BGE-M3 词表，前提是「检索路径实际用的 tokenizer」
   * 与契约身份同源。这里把各 kind 的真实来源逐条钉死：判断写错会让 meta 断言一份
   * 本次运行并未使用的 tokenizer（不报错，只是数字不可信）。
   */
  it('reports which BGE-M3 identity each retrieval path actually loads', () => {
    const contract = { model: CONTEXT_TOKENIZER_MODEL, revision: CONTEXT_TOKENIZER_REVISION }
    // chunking/anchors 没有 model/revision 字段，runner 内固定加载 bge-m3@main
    expect(retrievalTokenizerIdentity(traditional() as never)).toEqual(contract)
    expect(retrievalTokenizerIdentity({
      name: 'l', kind: 'long-section-rag',
      anchors: { tokenizer: 'bge-m3', chunkSize: 10, overlap: 0 },
      retrieval: { algorithm: 'bm25', topK: 2, k1: 1.2, b: 0.75 },
      generationContext: { topK: 1, maxTokens: CONTEXT_BUDGET_TOKENS },
    })).toEqual(contract)
    // hybrid 的 dense embedding 另有自己的 tokenizer，但分块走的是独立的 bge-m3@main 实例
    expect(retrievalTokenizerIdentity({
      name: 'h', kind: 'hybrid-rerank',
      chunking: { tokenizer: 'bge-m3', chunkSize: 10, overlap: 0 },
      retrieval: {
        bm25: { topK: 2, k1: 1.2, b: 0.75 },
        dense: { topK: 2, embedding: { model: 'other/model', revision: 'v9', queryPrefix: '', normalize: true, maxLength: 8 } },
        rrf: { k: 60, topK: 2 },
        reranker: { model: 'test/reranker', revision: 'main', topK: 2, maxLength: 8 },
      },
      generationContext: { topK: 1, maxTokens: CONTEXT_BUDGET_TOKENS },
    })).toEqual(contract)
    // 传统 cosine 用 embedding pin 的 tokenizer 分块：pin 不同即身份不同，必须如实报出
    const pinned = (model: string, revision: string) => retrievalTokenizerIdentity({
      name: 'rag', kind: 'traditional-rag',
      chunking: { tokenizer: 'bge-m3', chunkSize: 10, overlap: 0 },
      retrieval: { algorithm: 'cosine', topK: 2, embedding: { model, revision, queryPrefix: '', normalize: true, maxLength: 8 } },
      generationContext: { topK: 1, maxTokens: CONTEXT_BUDGET_TOKENS },
    })
    expect(pinned(CONTEXT_TOKENIZER_MODEL, CONTEXT_TOKENIZER_REVISION)).toEqual(contract)
    expect(pinned('BAAI/bge-m3', 'v1.5')).toEqual({ model: 'BAAI/bge-m3', revision: 'v1.5' })
    expect(pinned('other/model', 'main')).toEqual({ model: 'other/model', revision: 'main' })
  })
})
