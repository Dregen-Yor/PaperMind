import type { DoclingCredentials } from '../src/types/doclingConfig'
import { normalizeDoclingCredentials, OFFICIAL_DOCLING_CONFIG } from '../src/utils/doclingConfig'
import { normalizeDoclingDocument, type ParsedDocument } from '../src/utils/doclingDocument'
import { nodeSecurityErrors } from '../scripts/lib/runtime-security.mjs'
import { readBoundedJson } from '../src/utils/serviceSecurity'

type Request = typeof fetch

interface DoclingResponse {
  status?: string
  document?: { json_content?: unknown }
}

let activeRequests = 0
const MAX_PDF_BYTES = 64 * 1024 * 1024

async function requestJson(
  path: string,
  credentials: DoclingCredentials,
  init: RequestInit,
  request: Request,
): Promise<unknown> {
  const config = OFFICIAL_DOCLING_CONFIG
  // Do not feed remote responses into an unpatched embedded Node networking stack.
  if (request === fetch) {
    const errors = nodeSecurityErrors(process.versions.node)
    if (errors.length) throw new Error(`Docling 网络请求已暂停：${errors.join('；')}`)
  }
  if (activeRequests >= 2) throw new Error('Docling 解析请求过多，请等待当前任务结束后重试')
  activeRequests++
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutSeconds * 1000)
  try {
    const response = await request(`${config.baseUrl}${path}`, {
      ...init,
      redirect: 'error',
      signal: controller.signal,
      headers: {
        ...(credentials.apiKey ? { 'X-Api-Key': credentials.apiKey } : {}),
        ...init.headers,
      },
    })
    if (!response.ok) {
      if ([401, 403].includes(response.status)) throw new Error('Docling 认证失败，请检查服务 API Key')
      throw new Error(`Docling 服务请求失败（HTTP ${response.status}）`)
    }
    try {
      return await readBoundedJson(response, 64 * 1024 * 1024)
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('Docling 服务未返回有效 JSON')
      throw error
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Docling 请求超时（${config.timeoutSeconds} 秒），请稍后重试`)
    if (error instanceof TypeError) throw new Error('无法连接 Docling 官方服务，请检查网络')
    throw error
  } finally {
    clearTimeout(timer)
    activeRequests--
  }
}

async function convertPdfDocument(
  bytes: Uint8Array,
  fileName: string,
  value: DoclingCredentials,
  request: Request,
  forSummary: boolean,
): Promise<ParsedDocument> {
  const credentials = normalizeDoclingCredentials(value)
  const conversion = OFFICIAL_DOCLING_CONFIG.conversion
  if (bytes.byteLength > MAX_PDF_BYTES) throw new Error('PDF 超过 Docling 上传大小上限（64 MiB）')
  const body = new FormData()
  body.append('files', new Blob([new Uint8Array(bytes).buffer], { type: 'application/pdf' }), fileName)
  const options = {
    from_formats: conversion.fromFormat,
    to_formats: conversion.toFormat,
    target_type: conversion.targetType,
    image_export_mode: conversion.imageExportMode,
    include_images: String(conversion.includeImages),
    images_scale: String(conversion.imageScale),
    do_ocr: String(conversion.ocr.enabled),
    ocr_engine: conversion.ocr.engine,
    ocr_preset: conversion.ocr.preset,
    do_formula_enrichment: String(conversion.formula.enabled),
    code_formula_preset: conversion.formula.preset,
    do_table_structure: String(conversion.table.enabled),
    table_mode: conversion.table.mode,
    table_structure_preset: conversion.table.preset,
    layout_preset: conversion.layoutPreset,
    document_timeout: String(OFFICIAL_DOCLING_CONFIG.timeoutSeconds),
  }
  for (const [key, option] of Object.entries(options)) body.append(key, option)
  const payload = await requestJson('/v1/convert/file', credentials, { method: 'POST', body }, request)
  const result: DoclingResponse = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as DoclingResponse
    : {}
  if (!['success', 'partial_success'].includes(result.status ?? '')) throw new Error('Docling 文档解析失败，请检查官方服务状态后重试')
  if (forSummary && result.status === 'partial_success') throw new Error('Docling 仅完成部分解析，无法生成完整摘要，请稍后重试')
  let json = result.document?.json_content
  if (typeof json === 'string') {
    try {
      json = JSON.parse(json)
    } catch {
      throw new Error('Docling 文档 JSON 内容无效')
    }
  }
  const document = normalizeDoclingDocument(json, { preserveAllPictures: forSummary })
  if (result.status === 'partial_success') document.warnings.push('Docling 仅完成部分解析，部分内容或素材可能缺失。')
  return document
}

export async function convertPdf(
  bytes: Uint8Array,
  fileName: string,
  credentials: DoclingCredentials,
  request: Request = fetch,
): Promise<ParsedDocument> {
  return convertPdfDocument(bytes, fileName, credentials, request, false)
}

export async function convertPdfForSummary(
  bytes: Uint8Array,
  fileName: string,
  credentials: DoclingCredentials,
  request: Request = fetch,
): Promise<ParsedDocument> {
  return convertPdfDocument(bytes, fileName, credentials, request, true)
}

export async function testDoclingConnection(
  value: DoclingCredentials,
  request: Request = fetch,
): Promise<string> {
  const credentials = normalizeDoclingCredentials(value)
  const schema = await requestJson('/openapi.json', credentials, {}, request) as { paths?: Record<string, { post?: unknown }> }
  if (!schema?.paths?.['/v1/convert/file']?.post) throw new Error('官方服务没有 Docling /v1/convert/file 转换接口')
  return 'Docling 官方服务连接成功，文档转换接口可用'
}
