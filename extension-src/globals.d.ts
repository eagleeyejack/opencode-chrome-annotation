declare global {
  type OpcElementOptions = {
    text?: string
    style?: string
    attrs?: Record<string, string>
    on?: Record<string, EventListener>
  }

  type OpcDockApi = {
    applyDockPosition(dock?: string): void
  }

  var __opc_h: ((tag: string, options?: OpcElementOptions, children?: Node[]) => HTMLElement) | undefined
  var __opc_makeDockable: ((overlay: HTMLElement, options?: { blockDragSelector?: string; snapThreshold?: number }) => OpcDockApi) | undefined
  var __opc_cleanupSessionPicker: (() => void) | undefined
  var __opc_cropDataUrl:
    | ((
        dataUrl: string,
        rect: { x?: number; y?: number; width?: number; height?: number } | null,
        viewport: { width?: number; height?: number } | null,
        padding?: number
      ) => Promise<string | null>)
    | undefined
  var __opc_queuePanelOpen: boolean | undefined
  var __opc_lastQueueCount: number | undefined

  interface HTMLElement {
    __opcDockApi?: OpcDockApi
  }
}

export {}
