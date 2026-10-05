export function safeError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error)
  for (const [key, value] of Object.entries(process.env)) {
    if (value && /(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(key)) message = message.split(value).join('[redacted]')
  }
  return message.replace(/(Bearer\s+)\S+/gi, '$1[redacted]').replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@').replace(/([?&](?:api_key|token|key)=)[^&\s]+/gi, '$1[redacted]').slice(0, 2000)
}
