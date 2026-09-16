// Vitest setup: mock window.db (IPC bridge) so stores can be unit-tested without Electron
import { vi } from 'vitest'

const mockDb = {
  kb: {
    list: vi.fn().mockResolvedValue([{ id: 'default', name: '默认知识库', description: '', color: '#409EFF', createdAt: 0 }]),
    create: vi.fn().mockImplementation(kb => Promise.resolve(kb)),
    remove: vi.fn().mockResolvedValue(undefined),
  },
  paper: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockImplementation(p => Promise.resolve(p)),
    update: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(null),
  },
  chat: {
    listConversations: vi.fn().mockResolvedValue([]),
    createConversation: vi.fn().mockImplementation(c => Promise.resolve({ ...c, messages: [] })),
    updateConversation: vi.fn().mockResolvedValue(undefined),
    removeConversation: vi.fn().mockResolvedValue(undefined),
    addMessage: vi.fn().mockResolvedValue(undefined),
  },
  highlight: {
    listByPaper: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockImplementation(h => Promise.resolve(h)),
    remove: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  },
  settings: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
  },
  index: {
    list: vi.fn().mockResolvedValue([]),
    get:  vi.fn().mockResolvedValue(null),
    set:  vi.fn().mockResolvedValue(undefined),
  },
  tree: {
    list: vi.fn().mockResolvedValue([]),
    get:  vi.fn().mockResolvedValue(null),
    set:  vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  },
  data: {
    export: vi.fn().mockResolvedValue({}),
    clear: vi.fn().mockResolvedValue(undefined),
    import: vi.fn().mockResolvedValue(undefined),
  },
}

Object.defineProperty(globalThis, 'window', { value: globalThis, writable: true })
;(globalThis as any).window.db = mockDb
;(globalThis as any).mockDb = mockDb
