/**
 * 侧车协议。全部用假侧车（一个内联的 node 子进程），**不依赖 Python 或 MLX**——
 * 这是「判定逻辑与运行时解耦」的直接回报：CI 与别人的机器上都能跑。
 */
import { describe, it, expect } from 'vitest'
import { SidecarJudge, type SidecarSpawn } from '../jev/protocol'

/** 假侧车：逐行读请求，按 request 里 title 长度回一个确定概率。 */
const FAKE = `
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    const req = JSON.parse(line)
    const scores = req.nodes.map((n) => (n.title.length % 10) / 10)
    process.stdout.write(JSON.stringify({ id: req.id, scores }) + '\\n')
  }
})
`
const spawnFake: SidecarSpawn = () => ({ command: process.execPath, args: ['-e', FAKE] })

describe('SidecarJudge', () => {
  it('批量往返：返回与候选等长的概率', async () => {
    const judge = new SidecarJudge({ spawn: spawnFake })
    try {
      const scores = await judge.judge({
        query: 'q',
        nodes: [{ id: 'a', title: 'aa', path: [] }, { id: 'b', title: 'bbbb', path: [] }],
      })
      expect(scores).toEqual([0.2, 0.4])
    } finally { await judge.close() }
  })

  it('并发调用各自拿到自己的结果（按 id 配对，不串线）', async () => {
    const judge = new SidecarJudge({ spawn: spawnFake })
    try {
      const [a, b] = await Promise.all([
        judge.judge({ query: 'q', nodes: [{ id: 'x', title: 'x', path: [] }] }),
        judge.judge({ query: 'q', nodes: [{ id: 'y', title: 'yyyyyyyyyy', path: [] }] }),
      ])
      expect(a).toEqual([0.1])
      expect(b).toEqual([0.0])
    } finally { await judge.close() }
  })

  it('空候选不发起请求', async () => {
    const judge = new SidecarJudge({ spawn: spawnFake })
    try {
      expect(await judge.judge({ query: 'q', nodes: [] })).toEqual([])
    } finally { await judge.close() }
  })

  it('侧车立刻退出时抛错，调用方据此按篇回落', async () => {
    const judge = new SidecarJudge({ spawn: () => ({ command: process.execPath, args: ['-e', 'process.exit(1)'] }) })
    await expect(judge.judge({ query: 'q', nodes: [{ id: 'a', title: 'a', path: [] }] }))
      .rejects.toThrow(/sidecar exited/)
    await judge.close()
  })

  it('超时抛错，不无限等待', async () => {
    const judge = new SidecarJudge({
      spawn: () => ({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }),
      timeoutMs: 200,
    })
    await expect(judge.judge({ query: 'q', nodes: [{ id: 'a', title: 'a', path: [] }] }))
      .rejects.toThrow(/timeout/)
    await judge.close()
  })

  it('返回长度与候选不匹配时抛错', async () => {
    const lying = `let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);const r=JSON.parse(l);process.stdout.write(JSON.stringify({id:r.id,scores:[0.5]})+'\\n')}})`
    const judge = new SidecarJudge({ spawn: () => ({ command: process.execPath, args: ['-e', lying] }) })
    await expect(judge.judge({ query: 'q', nodes: [{ id: 'a', title: 'a', path: [] }, { id: 'b', title: 'b', path: [] }] }))
      .rejects.toThrow(/length-mismatch/)
    await judge.close()
  })
})
