/** 备份脱敏（#5）：默认导出不含任何明文凭据（API Key / Token）。 */
export function stripApiKeysFromSettings(rows: Array<{ key: string; value: string }>): Array<{ key: string; value: string }> {
  return rows.map(row => {
    if (row.key === 'huggingface_token') return { ...row, value: JSON.stringify('') }
    try {
      if (row.key === 'llm_profiles') {
        const profiles = JSON.parse(row.value)
        if (!Array.isArray(profiles)) return row
        const redacted = profiles.map(profile =>
          typeof profile === 'object' && profile !== null ? { ...profile, apiKey: '' } : profile,
        )
        return { ...row, value: JSON.stringify(redacted) }
      }
      if (row.key === 'llm_config') {
        const config = JSON.parse(row.value)
        if (typeof config !== 'object' || config === null || Array.isArray(config)) return row
        return { ...row, value: JSON.stringify({ ...config, apiKey: '' }) }
      }
    } catch {
      return row
    }
    return row
  })
}

/** 可读备份文件名（#5）。 */
export function backupFileName(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `papermind-backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.json`
}
