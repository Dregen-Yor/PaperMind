/**
 * 长异步构建的代次（generation）保护。
 *
 * `indexingPapers` 这类「进行中」去重只能挡住同一篇论文的并发重复触发；
 * 挡不住「构建进行到一半，索引配置被改了」——那条路径下在途构建的结果已经
 * 按旧配置算出来了，写盘就会让索引与它自称的配置指纹对不上。
 * 约定：每次开始构建 `begin()` 取一个代次，写盘前用 `isCurrent()` 复核。
 */
export interface BuildGeneration {
  /** 开始一次构建，返回本次构建的代次 */
  begin(key: string): number
  /** 该代次是否仍然有效（没有被 invalidate / invalidateAll 作废） */
  isCurrent(key: string, token: number): boolean
  /** 让某个 key 的在途构建作废（如该篇被重新触发构建） */
  invalidate(key: string): void
  /** 让全部在途构建作废（如索引 profile 被切换） */
  invalidateAll(): void
}

export function createBuildGeneration(): BuildGeneration {
  /** key → 当前有效代次；不存在的 key 表示「没有在途构建」 */
  const current = new Map<string, number>()
  /** 每个 key 的代次计数器只增不减，避免复用旧数值被在途构建蒙对 */
  const counters = new Map<string, number>()

  const next = (key: string): number => {
    const value = (counters.get(key) ?? 0) + 1
    counters.set(key, value)
    return value
  }

  return {
    begin(key: string): number {
      const token = next(key)
      current.set(key, token)
      return token
    },
    isCurrent(key: string, token: number): boolean {
      const active = current.get(key)
      return active !== undefined && active === token
    },
    invalidate(key: string): void {
      if (!counters.has(key)) return // 从未构建过：不需要无谓地推高计数器
      current.delete(key)
      next(key)
    },
    invalidateAll(): void {
      for (const key of current.keys()) {
        current.delete(key)
        next(key)
      }
    },
  }
}
