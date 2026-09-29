import { METHODS, requireThat, uniqueIds } from './localPdf/contract'
import type { Method, Split } from './localPdf/types'
export type Args =
  | { command: 'prepare'; root: string; split: Split; out: string; limitPapers?: number }
  | { command: 'run'; manifest: string; methods: Method[]; out: string }
  | { command: 'report'; run: string }
export function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv
  requireThat(['prepare', 'run', 'report'].includes(command), 'Use bench prepare | run | report; legacy options are no longer supported')
  const allowed = command === 'prepare' ? ['--dataset-root', '--split', '--out', '--limit-papers'] : command === 'run' ? ['--manifest', '--methods', '--out'] : ['--run']
  const options = new Map<string, string>()
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]; const value = rest[i + 1]
    requireThat(allowed.includes(flag) && !options.has(flag), `Unknown or duplicate option: ${flag}`)
    requireThat(value && !value.startsWith('--'), `Missing value for ${flag}`)
    options.set(flag, value)
  }
  const required = (flag: string) => { const value = options.get(flag); requireThat(value, `Required: ${flag}`); return value }
  if (command === 'prepare') {
    const split = required('--split'); requireThat(split === 'train' || split === 'dev', 'split must be train or dev')
    const limitPapers = options.has('--limit-papers') ? Number(options.get('--limit-papers')) : undefined
    requireThat(limitPapers === undefined || Number.isInteger(limitPapers) && limitPapers > 0, 'invalid paper limit')
    return { command, root: options.get('--dataset-root') ?? 'dataset', split, out: required('--out'), ...(limitPapers ? { limitPapers } : {}) }
  }
  if (command === 'run') {
    const methods = (options.get('--methods') ?? 'A,B,C,R').split(',') as Method[]
    uniqueIds(methods); requireThat(methods.every(m => METHODS.includes(m)), 'Unknown method')
    return { command, manifest: required('--manifest'), methods, out: required('--out') }
  }
  return { command: 'report', run: required('--run') }
}
