import type { DbApi, IpcArgs, IpcResult, TypedInvoke } from '../types/ipcContract'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Assert<T extends true> = T

type PaperCreateArgs = Assert<Equal<IpcArgs<'paper:create'>, Parameters<DbApi['paper']['create']>>>
type PaperListResult = Assert<Equal<IpcResult<'paper:list'>, Awaited<ReturnType<DbApi['paper']['list']>>>>

declare const invoke: TypedInvoke

function compileOnly() {
  // @ts-expect-error A paper object is required, not an arbitrary string.
  invoke('paper:create', 'paper-1')
  // @ts-expect-error Channel names are part of the shared contract.
  invoke('paper:missing')
  // @ts-expect-error The backup import takes exactly one value.
  invoke('data:import')
}

void (null as unknown as PaperCreateArgs)
void (null as unknown as PaperListResult)
void compileOnly
