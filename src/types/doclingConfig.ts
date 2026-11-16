export interface DoclingCredentials {
  apiKey: string
}

export interface OfficialDoclingConfig {
  schemaVersion: 1
  baseUrl: string
  timeoutSeconds: 60
  conversion: {
    fromFormat: 'pdf'
    toFormat: 'json'
    targetType: 'inbody'
    imageExportMode: 'embedded'
    includeImages: true
    imageScale: 2
    ocr: {
      enabled: true
      engine: 'rapidocr'
      preset: 'rapidocr'
    }
    formula: {
      enabled: true
      preset: 'codeformulav2'
    }
    table: {
      enabled: true
      mode: 'accurate'
      preset: 'tableformer_v1_accurate'
    }
    layoutPreset: 'layout_heron_default'
  }
}
