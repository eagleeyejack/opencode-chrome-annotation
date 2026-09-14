globalThis.__opc_h = function h(tag: string, { text, style, attrs, on }: OpcElementOptions = {}, children: Node[] = []) {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (style) node.style.cssText = style
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      node.setAttribute(key, String(value))
    }
  }
  if (on) {
    for (const [eventName, handler] of Object.entries(on)) {
      node.addEventListener(eventName, handler)
    }
  }
  for (const child of children) {
    if (child) node.appendChild(child)
  }
  return node
}

globalThis.__opc_makeDockable = function makeDockable(overlay: HTMLElement, options = {}) {
  if (!overlay) throw new Error("overlay is required")
  if (overlay.__opcDockApi) return overlay.__opcDockApi

  const blockDragSelector = options.blockDragSelector || "button"
  const snapThreshold = Number.isFinite(options.snapThreshold) ? options.snapThreshold : 10

  let dragging = false
  let pointerId: number | null = null
  let offsetX = 0
  let offsetY = 0

  function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value))
  }

  function applyDockPosition(dock?: string): void {
    const next = dock === "bottom" ? "bottom" : "top"
    overlay.dataset.dock = next
    overlay.style.left = "50%"
    overlay.style.transform = "translateX(-50%)"
    if (next === "bottom") {
      overlay.style.top = ""
      overlay.style.bottom = `${snapThreshold}px`
    } else {
      overlay.style.bottom = ""
      overlay.style.top = `${snapThreshold}px`
    }
  }

  overlay.addEventListener("pointerdown", (event: PointerEvent) => {
    if (event.button !== 0) return
    if (event.target instanceof Element && event.target.closest(blockDragSelector)) return
    event.preventDefault()
    dragging = true
    pointerId = event.pointerId
    const rect = overlay.getBoundingClientRect()
    offsetX = event.clientX - rect.left
    offsetY = event.clientY - rect.top
    overlay.style.cursor = "grabbing"
    overlay.setPointerCapture(pointerId)
  })

  overlay.addEventListener("pointermove", (event: PointerEvent) => {
    if (!dragging) return
    event.preventDefault()
    const rect = overlay.getBoundingClientRect()
    const nextLeft = clamp(event.clientX - offsetX, 8, window.innerWidth - rect.width - 8)
    const nextTop = clamp(event.clientY - offsetY, 8, window.innerHeight - rect.height - 8)
    overlay.style.left = `${Math.round(nextLeft)}px`
    overlay.style.transform = ""
    overlay.style.bottom = ""
    overlay.style.top = `${Math.round(nextTop)}px`
  })

  overlay.addEventListener("pointerup", (event: PointerEvent) => {
    if (!dragging) return
    dragging = false
    applyDockPosition(event.clientY > window.innerHeight / 2 ? "bottom" : "top")
    overlay.style.cursor = "grab"
    if (pointerId !== null) {
      try {
        overlay.releasePointerCapture(pointerId)
      } catch {}
    }
    pointerId = null
  })

  overlay.addEventListener("pointercancel", () => {
    dragging = false
    pointerId = null
    overlay.style.cursor = "grab"
  })

  overlay.__opcDockApi = { applyDockPosition }
  return overlay.__opcDockApi
}

globalThis.__opc_cropDataUrl = function cropDataUrl(
  dataUrl: string,
  rect: { x?: number; y?: number; left?: number; top?: number; width?: number; height?: number } | null,
  viewport: { width?: number; height?: number } | null,
  padding?: number
): Promise<string | null> {
  const pad = Number.isFinite(padding) ? (padding as number) : 8
  if (!dataUrl || !rect || !viewport) return Promise.resolve(null)

  const sourceWidth = Number(viewport.width)
  const sourceHeight = Number(viewport.height)
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    return Promise.resolve(null)
  }

  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => {
      try {
        const scaleX = image.width / sourceWidth
        const scaleY = image.height / sourceHeight
        if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) {
          resolve(null)
          return
        }
        const rectLeft = Number(rect.x ?? rect.left ?? 0)
        const rectTop = Number(rect.y ?? rect.top ?? 0)
        const rectRight = rectLeft + Number(rect.width ?? 0)
        const rectBottom = rectTop + Number(rect.height ?? 0)
        const left = Math.max(0, Math.min(rectLeft, sourceWidth))
        const top = Math.max(0, Math.min(rectTop, sourceHeight))
        const right = Math.min(sourceWidth, rectRight + pad)
        const bottom = Math.min(sourceHeight, rectBottom + pad)
        const cropX = Math.floor(left * scaleX)
        const cropY = Math.floor(top * scaleY)
        const cropWidth = Math.floor((right - left) * scaleX)
        const cropHeight = Math.floor((bottom - top) * scaleY)
        if (cropWidth < 4 || cropHeight < 4) {
          resolve(null)
          return
        }
        const canvas = document.createElement("canvas")
        canvas.width = cropWidth
        canvas.height = cropHeight
        const context = canvas.getContext("2d")
        if (!context) {
          resolve(null)
          return
        }
        context.drawImage(image, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight)
        resolve(canvas.toDataURL("image/png"))
      } catch {
        resolve(null)
      }
    }
    image.onerror = () => resolve(null)
    image.src = dataUrl
  })
}
