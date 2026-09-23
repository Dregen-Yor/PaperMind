export interface BenchArgs {
  task: 'qa' | 'summary' | 'all'
  dataset: 'qasper' | 'smoke' | 'all'
  config: string
  limit?: number
  judge: boolean
  useCache: boolean
  speed: boolean
  out?: string
  compare?: [string, string]
  qConfig?: string
  mode: 'rag' | 'full-context'
}

const TASKS = ['qa', 'summary', 'all'] as const
const DATASETS = ['qasper', 'smoke', 'all'] as const

/**
 * 结果文件名时间戳部分：ISO 时间转文件名安全格式。
 * toISOString() 自带毫秒，正常已能区分同秒内多次写盘；若来源串不含毫秒，
 * 追加 Date.now() 兜底，防止多配置矩阵下同秒写盘互相覆盖。
 */
export function fileStamp(timestamp: string): string {
  const safe = timestamp.replace(/[:.]/g, '-')
  return /\.\d{3}Z?$/.test(timestamp) ? safe : `${safe}-${Date.now()}`
}

/**
 * 解析 CLI 参数为强类型 BenchArgs。
 * 任何非法取值立即抛错而不是回落默认值——拼错的 flag 静默生效
 * 会让评测结果看起来正常实则跑错配置，比直接失败危害大得多。
 */
export function parseArgs(argv: string[]): BenchArgs {
  const args: BenchArgs = {
    task: 'all',
    dataset: 'all',
    config: 'default',
    judge: false,
    useCache: true,
    speed: false,
    mode: 'rag',
  }

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    switch (flag) {
      case '--task': {
        const v = argv[++i]
        if (!TASKS.includes(v as never)) {
          throw new Error(`--task 取值非法：${v}（合法值：qa / summary / all）`)
        }
        args.task = v as BenchArgs['task']
        break
      }
      case '--dataset': {
        const v = argv[++i]
        if (!DATASETS.includes(v as never)) {
          throw new Error(`--dataset 取值非法：${v}（合法值：qasper / smoke / all）`)
        }
        args.dataset = v as BenchArgs['dataset']
        break
      }
      case '--config': {
        // 作为最后一个 token 时取到 undefined，后续 loadConfigs 会裸 TypeError，
        // 在此提前给出可诊断的报错
        const v = argv[++i]
        if (!v) throw new Error('--config 需要一个值（配置名或 .json 路径）')
        args.config = v
        break
      }
      case '--limit': {
        const v = Number(argv[++i])
        if (!Number.isInteger(v) || v <= 0) {
          throw new Error(`--limit 需要正整数，收到：${argv[i]}`)
        }
        args.limit = v
        break
      }
      case '--out': {
        const v = argv[++i]
        if (!v) throw new Error('--out 需要一个值（结果文件路径）')
        args.out = v
        break
      }
      case '--judge':
        args.judge = true
        break
      case '--no-cache':
        args.useCache = false
        break
      case '--speed':
        args.speed = true
        break
      case '--mode': {
        const v = argv[++i]
        if (v !== 'rag' && v !== 'full-context') throw new Error('--mode 取值非法：rag / full-context')
        args.mode = v
        break
      }
      case '--compare': {
        const a = argv[++i]
        const b = argv[++i]
        if (!a || !b) throw new Error('--compare 需要两个结果文件路径')
        args.compare = [a, b]
        break
      }
      case '--q-config': {
        const v = argv[++i]
        if (!v || v.startsWith('--')) throw new Error('--q-config 需要一个配置文件路径')
        args.qConfig = v
        break
      }
      default:
        throw new Error(`未知参数：${flag}`)
    }
  }
  if (args.speed && args.task !== 'qa') {
    throw new Error('--speed 仅支持显式选择 --task qa')
  }
  if (args.qConfig && !args.compare) throw new Error('--q-config 需要 --compare')
  return args
}
