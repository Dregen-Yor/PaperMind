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

export interface PreviewApi {
  open: (url: string, bounds: PreviewBounds) => Promise<void>
  setBounds: (bounds: PreviewBounds) => Promise<void>
  back: () => Promise<void>
  forward: () => Promise<void>
  reload: () => Promise<void>
  close: () => Promise<void>
  openExternal: (url: string) => Promise<void>
  onState: (callback: (state: PreviewState) => void) => () => void
}

declare global {
  interface Window {
    preview: PreviewApi
  }
}

export {}
