import { DEFAULT_DOCLING_SETTINGS, normalizeDoclingDocument, normalizeDoclingSettings, type DoclingSettings, type ParsedDocument } from '../src/utils/doclingDocument'
import { ensureManagedDoclingTunnel } from './doclingTunnel'

type Request = typeof fetch
type Connect = (baseUrl: string) => Promise<void>
async function requestJson(path: string, settings: DoclingSettings, init: RequestInit, request: Request, connect: Connect): Promise<any> {
  if (!settings.baseUrl) throw new Error('请先在设置中填写 Docling 服务地址')
  if (settings.baseUrl === DEFAULT_DOCLING_SETTINGS.baseUrl) await connect(settings.baseUrl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), settings.timeoutSeconds * 1000)
  try {
    const response = await request(`${settings.baseUrl}${path}`, {
      ...init, signal: controller.signal,
      headers: { ...(settings.apiKey ? { 'X-Api-Key': settings.apiKey } : {}), ...init.headers },
    })
    if (!response.ok) {
      if ([401, 403].includes(response.status)) throw new Error('Docling 认证失败，请检查服务 API Key')
      throw new Error(`Docling 服务请求失败（HTTP ${response.status}）`)
    }
    try { return await response.json() } catch { throw new Error('Docling 服务未返回有效 JSON') }
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Docling 请求超时（${settings.timeoutSeconds} 秒），请检查服务或增加超时设置`)
    if (error instanceof TypeError) throw new Error('无法连接 Docling 服务，请检查服务地址和网络')
    throw error
  } finally { clearTimeout(timer) }
}

export async function convertPdf(bytes: Uint8Array, fileName: string, value: DoclingSettings, request: Request = fetch, connect: Connect = ensureManagedDoclingTunnel): Promise<ParsedDocument> {
  const settings = normalizeDoclingSettings(value)
  const body = new FormData()
  body.append('files', new Blob([new Uint8Array(bytes).buffer], { type: 'application/pdf' }), fileName)
  const options = {
    from_formats: 'pdf', to_formats: 'json', target_type: 'inbody', image_export_mode: 'embedded',
    include_images: 'true', images_scale: '2', do_table_structure: 'true', table_mode: 'accurate',
    do_ocr: String(settings.ocr), do_formula_enrichment: String(settings.formula),
    document_timeout: String(settings.timeoutSeconds),
  }
  for (const [key, value] of Object.entries(options)) body.append(key, value)
  const result = await requestJson('/v1/convert/file', settings, { method: 'POST', body }, request, connect)
  if (!['success', 'partial_success'].includes(result?.status)) throw new Error('Docling 文档解析失败，请检查服务模型配置后重试')
  let json = result.document?.json_content
  if (typeof json === 'string') {
    try { json = JSON.parse(json) } catch { throw new Error('Docling 文档 JSON 内容无效') }
  }
  const document = normalizeDoclingDocument(json)
  if (result.status === 'partial_success') document.warnings.push('Docling 仅完成部分解析，部分内容或素材可能缺失。')
  return document
}

export async function testDoclingConnection(value: DoclingSettings, request: Request = fetch, connect: Connect = ensureManagedDoclingTunnel): Promise<string> {
  const settings = { ...normalizeDoclingSettings(value), timeoutSeconds: 30 }
  const schema = await requestJson('/openapi.json', settings, {}, request, connect)
  if (!schema?.paths?.['/v1/convert/file']?.post) throw new Error('服务没有 Docling /v1/convert/file 转换接口，请检查根地址')
  return 'Docling 连接成功，文档转换接口可用'
}
