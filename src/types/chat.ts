import type { SourceRef } from '../utils/sourceRef'
import type { ChatRunStatus } from './chatRun'

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 结构化来源：芯片文案 + 跳转所需的论文与页区间（#1） */
  sources?: SourceRef[]
  timestamp: number
  /** 非空表示这一轮失败，渲染失败卡（#2） */
  error?: string
  /** finish_reason=length：回答被截断（#3） */
  truncated?: boolean
  /** 用户划选原文；/abstract 的助手消息保存带类型的续写状态。 */
  context?: string
  /** 流式渲染中的占位气泡标记（仅内存态，不落库）（#6） */
  streaming?: boolean
  runId?: string
  runStatus?: ChatRunStatus
}

export interface Conversation {
  id: string
  title: string
  paperIds: string[]
  messages: Message[]
  createdAt: number
}
