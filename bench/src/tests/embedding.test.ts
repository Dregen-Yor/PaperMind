import { describe, expect, it, vi } from 'vitest'

// transformers 的动态导入在 vi.mock 工厂里被替换：本文件只验证「词表加载几次」，
// 不真正下载权重。vi.hoisted 保证工厂引用的 mock 在提升后仍然可用。
const mocks = vi.hoisted(() => ({
  from_pretrained: vi.fn(async (_model: string, _options: { revision: string }) => ({ tokenize: (text: string) => text.split(/\s+/) })),
}))
vi.mock('@huggingface/transformers', () => ({
  AutoTokenizer: { from_pretrained: mocks.from_pretrained },
  env: {},
  pipeline: vi.fn(async () => ({ tokenizer: {} })),
}))

const { createBgeM3Tokenizer, createBgeM3Provider } = await import('../traditionalRag/embedding')

/** 该 (model, revision) 组合实际触发的词表加载次数。 */
const loads = (model: string, revision: string): number =>
  mocks.from_pretrained.mock.calls.filter(([m, o]) => m === model && (o as { revision: string }).revision === revision).length

/**
 * 受控物化器与检索侧要共用同一份 BGE-M3 词表（§5）：同一次元被加载两遍既不经济，
 * 也让「本次运行用的是哪份 tokenizer」无法自证。
 * 去重范围仅限**两个工厂返回的** tokenizer——`pipeline()` 内部自建的那份不经此缓存。
 */
describe('BGE-M3 tokenizer 加载', () => {
  it('同一 model/revision 只加载一次词表，不同 revision 各自加载', async () => {
    await createBgeM3Tokenizer({ model: 'test/same', revision: 'main' })
    await createBgeM3Tokenizer({ model: 'test/same', revision: 'main' })
    await createBgeM3Tokenizer({ model: 'test/same', revision: 'v1' })

    expect(loads('test/same', 'main')).toBe(1)
    expect(loads('test/same', 'v1')).toBe(1)
  })

  it('provider 工厂返回的 tokenizer 与 tokenizer 工厂共用同一份词表', async () => {
    await createBgeM3Tokenizer({ model: 'test/shared', revision: 'main' })
    const { tokenizer } = await createBgeM3Provider({ model: 'test/shared', revision: 'main', maxLength: 8 })

    expect(loads('test/shared', 'main')).toBe(1)
    expect(tokenizer.tokenize('a b')).toEqual(['a', 'b'])
  })

  it('加载失败不把失败态钉进缓存，下一次调用仍会重试', async () => {
    mocks.from_pretrained.mockRejectedValueOnce(new Error('hub down'))
    await expect(createBgeM3Tokenizer({ model: 'test/retry', revision: 'main' })).rejects.toThrow('hub down')
    await expect(createBgeM3Tokenizer({ model: 'test/retry', revision: 'main' })).resolves.toBeDefined()

    expect(loads('test/retry', 'main')).toBe(2)
  })
})
