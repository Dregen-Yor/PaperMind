import { isSafePaperId } from '../paperProtocol'
import { createHash } from 'crypto'
import type { PaperCreateInput } from '../../src/types/ipcContract'
import type { ChatMessageWrite, ChatMessagePatch } from '../../src/types/chatRun'
import type { WebQaBackup } from '../../src/types/webQa'

const runStatuses = new Set(['preparing', 'streaming', 'completed', 'failed', 'cancelled', 'interrupted'])

function invalid(detail: string): never {
  throw new Error(`备份文件内容无效：${detail}`)
}

function object(value: unknown, detail: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(detail)
  return value as Record<string, unknown>
}

function entries(value: unknown, detail: string): Record<string, unknown>[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) invalid(detail)
  return value.map((item, index) => object(item, `${detail}[${index}]`))
}

function string(value: unknown, detail: string): string {
  if (typeof value !== 'string' || !value) invalid(detail)
  return value
}

function text(value: unknown, detail: string): string {
  if (typeof value !== 'string') invalid(detail)
  return value
}

function optionalString(value: unknown, detail: string) {
  if (value !== undefined && value !== null && typeof value !== 'string') invalid(detail)
}

function paperId(value: unknown, detail: string): string {
  if (!isSafePaperId(value)) invalid(detail)
  return value
}

function alias(row: Record<string, unknown>, snake: string, camel: string): unknown {
  return row[snake] ?? row[camel]
}

function uniqueId(value: string, seen: Set<string>, detail: string) {
  if (seen.has(value)) invalid(`${detail} 重复`)
  seen.add(value)
}

export function validateWebQaBackup(value: unknown): asserts value is WebQaBackup {
  const backup = object(value, 'webQa')
  const snapshots = entries(backup.snapshots, 'webQa.snapshots')
  const sessions = entries(backup.sessions, 'webQa.sessions')
  const messages = entries(backup.messages, 'webQa.messages')
  const snapshotIds = new Set<string>()
  const sessionIds = new Set<string>()
  const messageIds = new Set<string>()
  for (const s of snapshots) {
    uniqueId(string(s.id, '网页快照 ID'), snapshotIds, '网页快照 ID')
    const url = string(s.finalUrl, '网页快照地址')
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) invalid('网页快照地址')
    } catch { invalid('网页快照地址') }
    text(s.title, '网页标题')
    const html = text(s.html, '网页快照内容')
    if (!Number.isSafeInteger(s.capturedAt) || Number(s.capturedAt) < 0) invalid('网页快照时间')
    if (Buffer.byteLength(html, 'utf8') !== s.byteLength || Number(s.byteLength) > 8 * 1024 * 1024) invalid('网页快照大小')
    if (createHash('sha256').update(html, 'utf8').digest('hex') !== s.contentHash) invalid('网页快照指纹')
  }
  for (const s of sessions) {
    uniqueId(string(s.id, '网页会话 ID'), sessionIds, '网页会话 ID')
    if (!snapshotIds.has(string(s.snapshotId, '网页快照 ID'))) invalid('网页快照不存在')
    if (!Number.isSafeInteger(s.createdAt) || !Number.isSafeInteger(s.updatedAt)) invalid('网页会话时间')
  }
  for (const m of messages) {
    uniqueId(string(m.id, '网页消息 ID'), messageIds, '网页消息 ID')
    if (!sessionIds.has(string(m.sessionId, '网页会话 ID'))) invalid('网页会话不存在')
    if (m.role !== 'user' && m.role !== 'assistant') invalid('网页消息角色')
    text(m.content, '网页消息内容')
    if (!['completed', 'streaming', 'failed', 'cancelled', 'interrupted'].includes(String(m.status))) invalid('网页消息状态')
    text(m.error, '网页消息错误')
    text(m.modelId, '网页消息模型')
    if (!Number.isSafeInteger(m.createdAt)) invalid('网页消息时间')
  }
}

export function validatePaperCreateInput(value: unknown): asserts value is PaperCreateInput {
  const paper = object(value, '论文')
  paperId(paper.id, '论文 ID')
  string(paper.knowledgeBaseId, '论文知识库 ID')
  if (typeof paper.title !== 'string' || typeof paper.abstract !== 'string' || typeof paper.fileName !== 'string') invalid('论文元数据')
  if (!Array.isArray(paper.authors) || !paper.authors.every(item => typeof item === 'string')) invalid('论文作者')
  if (!Array.isArray(paper.tags) || !paper.tags.every(item => typeof item === 'string')) invalid('论文标签')
  if (!Number.isSafeInteger(paper.year) || !Number.isSafeInteger(paper.addedAt)) invalid('论文时间或年份')
  if (paper.status !== 'unread' && paper.status !== 'reading' && paper.status !== 'done') invalid('论文状态')
  optionalString(paper.fileHash, '论文文件指纹')
  const fileData = string(paper.fileData, 'PDF 内容')
  if (fileData.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(fileData)) invalid('PDF 内容不是有效的 base64')
}

export function validateChatMessageWrite(value: unknown): asserts value is ChatMessageWrite {
  const message = object(value, '聊天消息')
  string(message.id, '消息 ID')
  string(message.conversationId, '会话 ID')
  if (message.role !== 'user' && message.role !== 'assistant') invalid('消息角色')
  if (typeof message.content !== 'string' || !Array.isArray(message.sources)) invalid('消息内容或来源')
  if (!Number.isSafeInteger(message.timestamp)) invalid('消息时间')
  optionalString(message.error, '消息错误')
  optionalString(message.context, '消息上下文')
  optionalString(message.runId, '运行 ID')
  if (message.truncated !== undefined && typeof message.truncated !== 'boolean') invalid('截断标记')
  if (message.runStatus !== undefined && !runStatuses.has(message.runStatus as string)) invalid('运行状态')
}

export function validateChatMessagePatch(value: unknown): asserts value is ChatMessagePatch {
  const patch = object(value, '消息更新')
  optionalString(patch.content, '消息内容')
  optionalString(patch.error, '消息错误')
  optionalString(patch.context, '消息上下文')
  optionalString(patch.runId, '运行 ID')
  if (patch.sources !== undefined && !Array.isArray(patch.sources)) invalid('消息来源')
  if (patch.truncated !== undefined && typeof patch.truncated !== 'boolean') invalid('截断标记')
  if (patch.runStatus !== undefined && !runStatuses.has(patch.runStatus as string)) invalid('运行状态')
}

/** Check the untrusted version-1 backup before importAll writes files or rows. */
export function validateBackupInput(value: unknown): void {
  const data = object(value, '顶层对象')
  if (data.version !== 1) throw new Error('不支持的备份文件格式（version 必须为 1）')
  if (data.webQa !== undefined) validateWebQaBackup(data.webQa)

  const bases = entries(data.knowledgeBases, 'knowledgeBases')
  const baseIds = new Set<string>()
  for (const base of bases) {
    uniqueId(string(base.id, '知识库 ID'), baseIds, '知识库 ID')
    text(base.name, '知识库名称')
  }

  const papers = entries(data.papers, 'papers')
  const paperIds = new Set<string>()
  for (const paper of papers) {
    uniqueId(paperId(paper.id, '论文 ID'), paperIds, '论文 ID')
    const baseId = string(paper.knowledgeBaseId, '论文知识库 ID')
    if (!baseIds.has(baseId)) invalid('论文引用了不存在的知识库')
    optionalString(paper.title, '论文标题')
    optionalString(paper.fileName, '论文文件名')
    if (paper.fileData !== undefined && paper.fileData !== null) {
      const fileData = string(paper.fileData, 'PDF 内容')
      if (fileData.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(fileData)) invalid('PDF 内容不是有效的 base64')
    }
    for (const key of ['authors', 'tags']) {
      if (paper[key] !== undefined && (!Array.isArray(paper[key]) || !(paper[key] as unknown[]).every(item => typeof item === 'string'))) invalid(`论文 ${key}`)
    }
  }

  const conversations = entries(data.conversations, 'conversations')
  const conversationIds = new Set<string>()
  const messageIds = new Set<string>()
  for (const conversation of conversations) {
    uniqueId(string(conversation.id, '会话 ID'), conversationIds, '会话 ID')
    text(conversation.title, '会话标题')
    if (conversation.paperIds !== undefined && (!Array.isArray(conversation.paperIds) || !(conversation.paperIds as unknown[]).every(id => typeof id === 'string'))) invalid('会话论文列表')
    for (const message of entries(conversation.messages, 'messages')) {
      uniqueId(string(message.id, '消息 ID'), messageIds, '消息 ID')
      if (message.role !== 'user' && message.role !== 'assistant') invalid('消息角色')
      if (typeof message.content !== 'string') invalid('消息内容')
      if (message.sources !== undefined && !Array.isArray(message.sources)) invalid('消息来源')
      optionalString(message.runId, '运行 ID')
      if (message.runStatus !== undefined && message.runStatus !== '' && !runStatuses.has(message.runStatus as string)) invalid('运行状态')
    }
  }

  for (const highlight of entries(data.highlights, 'highlights')) {
    string(highlight.id, '批注 ID')
    const id = paperId(alias(highlight, 'paper_id', 'paperId'), '批注论文 ID')
    if (!paperIds.has(id)) invalid('批注引用了不存在的论文')
    if (typeof highlight.text !== 'string') invalid('批注内容')
  }
  for (const index of entries(data.paperIndexes, 'paperIndexes')) {
    const id = paperId(alias(index, 'paper_id', 'paperId'), '索引论文 ID')
    if (!paperIds.has(id)) invalid('索引引用了不存在的论文')
    string(alias(index, 'index_json', 'indexJson'), '索引内容')
    string(alias(index, 'pages_json', 'pagesJson'), '索引页面内容')
  }
  for (const tree of entries(data.paperTrees, 'paperTrees')) {
    const id = paperId(alias(tree, 'paper_id', 'paperId'), '语义树论文 ID')
    if (!paperIds.has(id)) invalid('语义树引用了不存在的论文')
    string(alias(tree, 'tree_json', 'treeJson'), '语义树内容')
    string(alias(tree, 'blocks_json', 'blocksJson'), '语义树原文块')
  }
  for (const report of entries(data.paperAbstracts, 'paperAbstracts')) {
    const id = paperId(alias(report, 'paper_id', 'paperId'), '摘要论文 ID')
    if (!paperIds.has(id)) invalid('摘要引用了不存在的论文')
    string(report.content, '摘要内容')
  }
  for (const setting of entries(data.settings, 'settings')) {
    string(setting.key, '设置项名称')
    if (typeof setting.value !== 'string') invalid('设置项内容')
  }

  if (data.docling !== undefined && data.docling !== null) {
    const docling = object(data.docling, 'docling')
    for (const row of entries(docling.parses, 'docling.parses')) {
      if (!paperIds.has(paperId(row.paper_id, 'Docling 论文 ID'))) invalid('Docling 缓存引用了不存在的论文')
    }
    for (const row of entries(docling.assets, 'docling.assets')) {
      if (!paperIds.has(paperId(row.paper_id, 'Docling 素材论文 ID'))) invalid('Docling 素材引用了不存在的论文')
    }
  }
}
