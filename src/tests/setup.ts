// Vitest setup: mock window.db (IPC bridge) so stores can be unit-tested without Electron
import { vi } from 'vitest'

const mockDb = {
  webQa: {
    listPages: vi.fn().mockResolvedValue([]),
    archive: vi.fn().mockRejectedValue(new Error('未配置网页归档测试结果')),
    getPreview: vi.fn().mockResolvedValue(null),
    findAppearance: vi.fn().mockResolvedValue(null),
    getSnapshot: vi.fn().mockResolvedValue(null),
    listSessions: vi.fn().mockResolvedValue([]),
    getSession: vi.fn().mockResolvedValue(null),
    createSession: vi.fn().mockRejectedValue(new Error('未配置网页会话测试结果')),
    appendTurn: vi.fn().mockRejectedValue(new Error('未配置网页追加测试结果')),
    ensureAssistantForLastUser: vi.fn().mockRejectedValue(new Error('未配置网页重试测试结果')),
    removeSession: vi.fn().mockResolvedValue(undefined),
    removePage: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockImplementation(input => Promise.resolve({
      id: input.sessionId, snapshotId: input.sessionId, snapshot: input.snapshot,
      finalUrl: input.snapshot.finalUrl, title: input.snapshot.title,
      capturedAt: input.snapshot.capturedAt, byteLength: input.snapshot.byteLength,
      createdAt: input.createdAt, updatedAt: input.createdAt,
      messages: [{ id: input.messageId, sessionId: input.sessionId, role: 'user',
        content: input.question, status: 'completed', error: '', modelId: '', createdAt: input.createdAt }],
    })),
    addMessage: vi.fn().mockResolvedValue(undefined),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  },
  docling: {
    convert: vi.fn().mockRejectedValue(new Error('未配置测试解析结果')),
    save: vi.fn().mockImplementation((_id, record) => Promise.resolve(record)),
    readAsset: vi.fn().mockResolvedValue(null),
    testConnection: vi.fn().mockResolvedValue('Docling 连接成功'),
  },
  abstractCheckpoint: {
    get: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
  },
  paperAbstract: {
    get: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockImplementation(report => Promise.resolve({ ...report, updatedAt: Date.now() })),
  },
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
    contentUrl: vi.fn().mockResolvedValue(null),
  },
  chat: {
    listConversations: vi.fn().mockResolvedValue([]),
    createConversation: vi.fn().mockImplementation(c => Promise.resolve({ ...c, messages: [] })),
    updateConversation: vi.fn().mockResolvedValue(undefined),
    removeConversation: vi.fn().mockResolvedValue(undefined),
    addMessage: vi.fn().mockResolvedValue(undefined),
    updateMessage: vi.fn().mockResolvedValue(undefined),
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
    exportFile: vi.fn().mockResolvedValue({ canceled: false, filePath: '/tmp/papermind-backup-test.json' }),
    clear: vi.fn().mockResolvedValue(undefined),
    import: vi.fn().mockResolvedValue(undefined),
  },
}

Object.defineProperty(globalThis, 'window', { value: globalThis, writable: true })
;(globalThis as any).window.db = mockDb
;(globalThis as any).mockDb = mockDb
