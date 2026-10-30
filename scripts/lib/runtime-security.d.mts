export function nodeSecurityErrors(version: string): string[]
export function electronSecurityErrors(versions: { node?: string; electron?: string }, expectedElectron: string,
  policy?: { approvedElectron: { electron: string; node: string; evidence: string }[] }): string[]
