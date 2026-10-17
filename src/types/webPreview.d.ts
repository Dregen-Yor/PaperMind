export interface PreviewBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface PreviewState {
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error: string
  notice: string
  visible: boolean
}

export interface PreviewSnapshot {
  finalUrl: string
  title: string
  html: string
  capturedAt: number
  contentHash: string
  byteLength: number
}

export interface PreviewApi {
  open: (url: string, bounds: PreviewBounds) => Promise<void>
  openAndCapture: (url: string, bounds: PreviewBounds) => Promise<PreviewSnapshot>
  setBounds: (bounds: PreviewBounds) => Promise<void>
  back: () => Promise<void>
  forward: () => Promise<void>
  reload: () => Promise<void>
  close: () => Promise<void>
  openExternal: (url: string) => Promise<void>
  captureSnapshot: () => Promise<PreviewSnapshot>
  onState: (callback: (state: PreviewState) => void) => () => void
}

declare global {
  interface Window {
    preview: PreviewApi
  }
}

export {}
