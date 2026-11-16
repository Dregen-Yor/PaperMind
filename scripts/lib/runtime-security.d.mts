export function nodeSecurityErrors(version: string): string[]
export function electronSecurityErrors(versions: { node?: string; electron?: string; chrome?: string }, expectedElectron: string,
  policy?: { approvedElectron: { electron: string; node: string; chromium: string; evidence: string }[] }): string[]
