import { basename, isAbsolute, relative, resolve, sep } from 'node:path'

export interface BenchmarkPathLogOptions {
  speed: boolean
  root?: string
}

/** Speed logs retain useful repo-relative labels without exposing usernames or absolute paths. */
export function benchmarkPathForLog(path: string, options: BenchmarkPathLogOptions): string {
  if (!options.speed) return path
  const root = resolve(options.root ?? process.cwd())
  const target = resolve(path)
  const label = relative(root, target)
  const insideRoot = label === '' || (!label.startsWith(`..${sep}`) && label !== '..' && !isAbsolute(label))
  return insideRoot ? (label || '.') : `<external>/${basename(target)}`
}

export function writeBenchmarkPathLine(
  write: (text: string) => unknown,
  prefix: string,
  path: string,
  options: BenchmarkPathLogOptions,
): void {
  write(`${prefix}${benchmarkPathForLog(path, options)}\n`)
}
