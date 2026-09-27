import { describe, it, expect } from 'vitest'
import { parseArgs, fileStamp } from '../args'

describe('parseArgs', () => {
  it('无参数时用默认值', () => {
    const a = parseArgs([])
    expect(a).toMatchObject({
      task: 'all', dataset: 'all', config: 'default', judge: false, useCache: true, speed: false,
    })
    expect(a.limit).toBeUndefined()
  })

  it('解析 --task 与 --dataset', () => {
    const a = parseArgs(['--task', 'qa', '--dataset', 'qasper'])
    expect(a.task).toBe('qa')
    expect(a.dataset).toBe('qasper')
  })

  it('解析 --dataset outline-study', () => {
    expect(parseArgs(['--task', 'qa', '--dataset', 'outline-study']).dataset).toBe('outline-study')
  })

  it('--dataset all 仍可解析（outline-study 不属于 all）', () => {
    expect(parseArgs(['--dataset', 'all']).dataset).toBe('all')
  })

  it('解析 --limit 为数字', () => {
    expect(parseArgs(['--limit', '20']).limit).toBe(20)
  })

  it('解析 --mode full-context', () => {
    expect(parseArgs(['--mode', 'full-context']).mode).toBe('full-context')
  })

  it('解析布尔 flag', () => {
    const a = parseArgs(['--judge', '--no-cache'])
    expect(a.judge).toBe(true)
    expect(a.useCache).toBe(false)
  })

  it.each([
    ['ready-before-query', 'ready-before-query'],
    ['ask-at-lexical-ready', 'ask-at-lexical-ready'],
  ])('解析 --cold-strategy %s', (value, expected) => {
    expect(parseArgs(['--task', 'qa', '--cold-first-query', '--cold-strategy', value]).coldStrategy).toBe(expected)
  })

  it('--cold-first-query 不带 --cold-strategy 时默认 ready-before-query', () => {
    expect(parseArgs(['--task', 'qa', '--cold-first-query']).coldStrategy).toBe('ready-before-query')
  })

  it('--cold-strategy 需要 --cold-first-query', () => {
    expect(() => parseArgs(['--cold-strategy', 'ready-before-query'])).toThrow(/--cold-first-query/)
  })

  it('--cold-strategy 取值非法时抛出列出合法值的错误', () => {
    expect(() => parseArgs(['--task', 'qa', '--cold-first-query', '--cold-strategy', 'nope']))
      .toThrow(/ready-before-query.*ask-at-lexical-ready/)
  })

  it.each([
    ['--speed 在前', ['--task', 'qa', '--speed', '--cold-first-query']],
    ['--cold-first-query 在前', ['--task', 'qa', '--cold-first-query', '--speed']],
  ])('--cold-first-query 与 --speed 互斥（$0）', (_label, argv) => {
    expect(() => parseArgs(argv)).toThrow(/互斥/)
  })

  it.each([
    ['没有显式 task', ['--cold-first-query']],
    ['summary task', ['--task', 'summary', '--cold-first-query']],
    ['all task', ['--task', 'all', '--cold-first-query']],
  ])('--cold-first-query 拒绝 $0', (_label, argv) => {
    expect(() => parseArgs(argv)).toThrow(/--cold-first-query.*--task qa/)
  })

  it('仅在显式选择 QA task 时解析 --speed', () => {
    expect(parseArgs(['--task', 'qa', '--speed']).speed).toBe(true)
  })

  it.each([
    ['没有显式 task', ['--speed']],
    ['summary task', ['--task', 'summary', '--speed']],
    ['all task', ['--task', 'all', '--speed']],
  ])('--speed 拒绝 $0', (_label, argv) => {
    expect(() => parseArgs(argv)).toThrow(/--speed.*--task qa/)
  })

  it('解析 --compare 的两个路径', () => {
    const a = parseArgs(['--compare', 'a.json', 'b.json'])
    expect(a.compare).toEqual(['a.json', 'b.json'])
  })

  it('requires --compare and a non-flag path for --q-config', () => {
    expect(parseArgs(['--compare', 'a.json', 'b.json', '--q-config', 'q.json']).qConfig).toBe('q.json')
    expect(() => parseArgs(['--q-config', 'q.json'])).toThrow(/--compare/)
    expect(() => parseArgs(['--compare', 'a.json', 'b.json', '--q-config'])).toThrow(/--q-config/)
    expect(() => parseArgs(['--compare', 'a.json', 'b.json', '--q-config', '--out', 'x.json'])).toThrow(/--q-config/)
  })

  it('--task 取值非法时抛出列出合法值的错误', () => {
    expect(() => parseArgs(['--task', 'nope'])).toThrow(/qa.*summary.*all/)
  })

  it('--dataset 取值非法时抛错', () => {
    const message = (() => {
      try { parseArgs(['--dataset', 'nope']) } catch (error) { return (error as Error).message }
      return ''
    })()
    expect(message).toMatch(/qasper/)
    expect(message).toMatch(/outline-study/)
    expect(message).toMatch(/all/)
  })

  it('--limit 非正整数时抛错', () => {
    expect(() => parseArgs(['--limit', '0'])).toThrow(/--limit/)
    expect(() => parseArgs(['--limit', 'abc'])).toThrow(/--limit/)
  })

  it('--config 作为最后 token 缺值时抛错', () => {
    expect(() => parseArgs(['--config'])).toThrow(/--config/)
  })

  it('--out 作为最后 token 缺值时抛错', () => {
    expect(() => parseArgs(['--out'])).toThrow(/--out/)
  })

  it('--compare 只给一个路径时抛错', () => {
    expect(() => parseArgs(['--compare', 'a.json'])).toThrow(/两个/)
  })

  it('未知 flag 时抛错，避免拼错静默生效', () => {
    expect(() => parseArgs(['--topk', '2'])).toThrow(/--topk/)
  })

  it('解析 --sweep（产品实验入口）', () => {
    const a = parseArgs(['--task', 'qa', '--dataset', 'outline-study', '--speed', '--sweep'])
    expect(a.sweep).toBe(true)
  })

  it('--sweep 缺 --speed 或非 outline-study 数据集时抛错', () => {
    expect(() => parseArgs(['--task', 'qa', '--dataset', 'outline-study', '--sweep']))
      .toThrow(/--sweep 需要 --speed/)
    expect(() => parseArgs(['--task', 'qa', '--dataset', 'qasper', '--speed', '--sweep']))
      .toThrow(/--sweep 仅支持 --dataset outline-study/)
  })

  it('--sweep 与 --mode full-context 互斥；与 --cold-first-query 同跑也被既有互斥规则拒绝', () => {
    expect(() => parseArgs(['--task', 'qa', '--dataset', 'outline-study', '--speed', '--sweep', '--mode', 'full-context']))
      .toThrow(/--sweep.*full-context/)
    // --sweep 需要 --speed，而 --speed 与 --cold-first-query 的互斥检查在前，先抛出
    expect(() => parseArgs(['--task', 'qa', '--dataset', 'outline-study', '--speed', '--sweep', '--cold-first-query']))
      .toThrow(/互斥/)
  })
})

describe('fileStamp', () => {
  it('转文件名安全格式：保留毫秒；无毫秒来源追加 Date.now() 兜底', () => {
    expect(fileStamp('2026-09-04T10:00:00.123Z')).toBe('2026-09-04T10-00-00-123Z')
    expect(fileStamp('2026-09-04T10:00:00Z')).toMatch(/^2026-09-04T10-00-00Z-\d+$/)
  })
})
