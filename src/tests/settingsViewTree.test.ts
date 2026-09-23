import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus, { ElMessageBox, ElMessage } from 'element-plus'
import { ElSwitch } from 'element-plus'

import SettingsView from '../views/SettingsView.vue'
import { useChatStore } from '../stores/chat'

// init 一进来就 `void ensureEmbedder()`：真实实现会动态 import transformers 并真的发起
// 权重下载（取缓存时还会碰 jsdom 未实现的 indexedDB）。单测里向量模型一律缺席，
// 设置页与建树路径都不依赖它。
vi.mock('../utils/transformersEmbedder', () => ({
  createTransformersEmbedder: vi.fn().mockRejectedValue(new Error('测试不加载向量模型')),
}))

const mockDb = () => (globalThis as any).mockDb

/**
 * 填好 API Key 的索引配置：没 Key 时建树会在发请求前短路成「未配置模型」（#13），
 * 而重建用例要验证的是真实请求路径（成功/失败）。每次返回副本，避免用例间互相污染。
 */
const KEYED_PROFILE = [{
  id: 'default', name: '默认配置', provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test',
  baseUrl: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 4096, topK: 0,
  systemPrompt: '你是一个专业的学术论文阅读助手，帮助用户理解和分析论文内容。',
}]

/**
 * 设置：填好 Key 的索引配置 + 语义树显式开启。自方案 §6.3 起语义树默认关闭，
 * 而「重建全部语义树」两条用例验证的是开关打开后的行为，不开启只会被总开关短路。
 */
const keyedSettings = (key: string) => {
  if (key === 'llm_profiles') return Promise.resolve(KEYED_PROFILE.map(profile => ({ ...profile })))
  if (key === 'semantic_tree_enabled') return Promise.resolve(true)
  return Promise.resolve(null)
}

const VALID_TREE = JSON.stringify({
  root: {
    id: 'r', label: '核心主张', description: '论文的中心结论', relationToParent: null,
    evidenceRefs: ['B001'],
    children: [{
      id: 'a1', label: '机制甲', description: '达成该主张的机制', relationToParent: 'constitutes',
      evidenceRefs: ['B001'], children: [],
    }],
  },
})

/** 挂载真实的 SettingsView（含 Element Plus），断言设置页的语义树开关。 */
async function mountSettings() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useChatStore()
  await store.init()
  const wrapper = mount(SettingsView, { global: { plugins: [pinia, ElementPlus] } })
  return { wrapper, store }
}

describe('SettingsView — 语义树开关（§8.2）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDb().chat.listConversations.mockResolvedValue([])
    mockDb().settings.get.mockResolvedValue(null)
    mockDb().index.list.mockResolvedValue([])
    mockDb().tree.list.mockResolvedValue([])
  })

  it('设置页提供语义树开关，默认处于关闭状态（方案 §6.3）', async () => {
    const { wrapper, store } = await mountSettings()
    const switches = wrapper.findAllComponents(ElSwitch)
    expect(switches).toHaveLength(1)
    expect(switches[0].props('modelValue')).toBe(false)
    expect(store.treeEnabled).toBe(false)
  })

  it('已关闭时开关反映关闭状态', async () => {
    mockDb().settings.get.mockImplementation((key: string) =>
      Promise.resolve(key === 'semantic_tree_enabled' ? false : null))
    const { wrapper } = await mountSettings()
    expect(wrapper.findComponent(ElSwitch).props('modelValue')).toBe(false)
  })

  it('拨动开关写入设置，关闭语义树', async () => {
    const { wrapper, store } = await mountSettings()
    await wrapper.findComponent(ElSwitch).vm.$emit('change', false)
    await vi.waitFor(() =>
      expect(mockDb().settings.set).toHaveBeenCalledWith('semantic_tree_enabled', false))
    expect(store.treeEnabled).toBe(false)
  })

  it('拨回开启同样持久化', async () => {
    mockDb().settings.get.mockImplementation((key: string) =>
      Promise.resolve(key === 'semantic_tree_enabled' ? false : null))
    const { wrapper, store } = await mountSettings()
    await wrapper.findComponent(ElSwitch).vm.$emit('change', true)
    await vi.waitFor(() =>
      expect(mockDb().settings.set).toHaveBeenCalledWith('semantic_tree_enabled', true))
    expect(store.treeEnabled).toBe(true)
  })

  it('展示已建好语义树的论文数量', async () => {
    mockDb().tree.list.mockResolvedValue(['p1', 'p2'])
    const { wrapper } = await mountSettings()
    expect(wrapper.text()).toContain('2 篇论文已有可用语义树')
  })

  it('重建全部失败时提示失败，而不是「没有可重建的论文」', async () => {
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue({ value: '', action: 'confirm' } as any)
    const error = vi.spyOn(ElMessage, 'error')
    const success = vi.spyOn(ElMessage, 'success')
    mockDb().settings.get.mockImplementation(keyedSettings)
    mockDb().index.list.mockResolvedValue(['p1'])
    mockDb().index.get.mockResolvedValue({
      indexJson: '{}', pagesJson: JSON.stringify(['Attention is all you need.']),
    })
    mockDb().tree.get.mockResolvedValue(null)
    global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as any
    const { wrapper } = await mountSettings()

    await wrapper.find('[data-test="rebuild-trees"]').trigger('click')
    await vi.waitFor(() => expect(error).toHaveBeenCalled())
    expect(error.mock.calls[0][0]).toContain('失败')
    // 失败文案还要带上原因，用户才知道该改配置还是重试（#13）
    expect(error.mock.calls[0][0]).toContain('请求失败')
    expect(success).not.toHaveBeenCalled()
  })

  it('确认后可强制重建全部语义树（缓存键覆盖不到的场景）', async () => {
    // element-plus 的 resolve 类型与实际返回值对不上，测试只关心「点了确认」
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue({ value: '', action: 'confirm' } as any)
    mockDb().settings.get.mockImplementation(keyedSettings)
    mockDb().index.list.mockResolvedValue(['p1', 'p2'])
    mockDb().index.get.mockResolvedValue({
      indexJson: '{}', pagesJson: JSON.stringify(['Attention is all you need.']),
    })
    mockDb().tree.get.mockResolvedValue(null)
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: VALID_TREE } }] }),
    }) as any
    const { wrapper } = await mountSettings()

    await wrapper.find('[data-test="rebuild-trees"]').trigger('click')
    await vi.waitFor(() => expect(mockDb().tree.set).toHaveBeenCalledTimes(2))
  })
})
