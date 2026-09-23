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
    expect(() => parseArgs(['--dataset', 'nope'])).toThrow(/qasper/)
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
})

describe('fileStamp', () => {
  it('转文件名安全格式：保留毫秒；无毫秒来源追加 Date.now() 兜底', () => {
    expect(fileStamp('2026-09-04T10:00:00.123Z')).toBe('2026-09-04T10-00-00-123Z')
    expect(fileStamp('2026-09-04T10:00:00Z')).toMatch(/^2026-09-04T10-00-00Z-\d+$/)
  })
})
