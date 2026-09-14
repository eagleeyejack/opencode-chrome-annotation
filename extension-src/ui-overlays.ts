import { warnExtension } from "./logger.js"

export type QueuePreview = {
  id: string
  comment: string
  tag?: string | null
  selector?: string | null
}

export type OverlayOptions = {
  openQueue?: boolean
  linkedLabel?: string
  queueEntries?: QueuePreview[]
}

export async function injectConnectionOverlay(tabId: number, options: OverlayOptions = {}): Promise<void> {
  const queueEntries = options.queueEntries || []
  const openQueue = options.openQueue === true
  const linkedLabel = options.linkedLabel || "Connected"

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      files: ["injected/dom.js"],
    })

    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      args: [queueEntries, openQueue, linkedLabel],
      func: (entries: QueuePreview[], openPanel: boolean, linkedLabelArg: string) => {
        const makeDockable = globalThis.__opc_makeDockable
        if (typeof makeDockable !== "function") {
          throw new Error("OpenCode dock helper is unavailable")
        }

        globalThis.__opc_lastQueueCount = entries.length
        if (openPanel) {
          globalThis.__opc_queuePanelOpen = true
        }

        const PANEL_STYLE = {
          panel: [
            "position:fixed",
            "right:12px",
            "z-index:2147483647",
            "width:min(360px,calc(100vw - 24px))",
            "max-height:min(420px,calc(100vh - 96px))",
            "overflow:auto",
            "padding:10px",
            "border-radius:12px",
            "background:rgba(255,255,255,0.97)",
            "color:#111111",
            "border:1px solid rgba(0,0,0,0.12)",
            "box-shadow:0 14px 40px rgba(0,0,0,0.35)",
            "font:12px/1.35 ui-sans-serif,system-ui,sans-serif",
            "pointer-events:auto",
            "backdrop-filter:blur(8px)",
            "user-select:none",
            "-webkit-user-select:none",
          ].join(";"),
          header: "display:flex;align-items:center;justify-content:space-between;gap:8px;margin:2px 2px 8px;",
          titleHeader: "font-weight:700;color:#111111;",
          close: "display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;color:#111111;cursor:pointer;font:700 14px/1 ui-sans-serif,system-ui,sans-serif;padding:0 2px;",
          empty: "padding:8px 4px 2px;color:#111111;",
          item: "padding:8px 2px;border-top:1px solid rgba(0,0,0,0.08);",
          itemHeader: "display:flex;align-items:center;justify-content:space-between;gap:8px;",
          itemIndex: "font-weight:600;color:#6b7280;margin-right:6px;",
          itemMeta: "margin-top:2px;color:#6b7280;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:0.92;",
          itemComment: "margin-top:4px;color:#111111;word-break:break-word;line-height:1.45;",
          itemRemove: "border:0;background:transparent;color:#111111;cursor:pointer;font:700 14px/1 ui-sans-serif,system-ui,sans-serif;padding:0 4px;",
          footer: "display:flex;gap:8px;justify-content:flex-end;margin-top:10px;",
          secondary: "padding:6px 10px;border-radius:999px;border:1px solid rgba(0,0,0,0.12);background:transparent;color:#111111;cursor:pointer;font:600 11px/1 ui-sans-serif,system-ui,sans-serif;",
          primary: "padding:6px 10px;border-radius:999px;border:0;background:#111111;color:#ffffff;cursor:pointer;font:600 11px/1 ui-sans-serif,system-ui,sans-serif;",
        }

        function createCloseIcon(): SVGElement {
          const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
          svg.setAttribute("viewBox", "0 0 12 12")
          svg.setAttribute("width", "12")
          svg.setAttribute("height", "12")
          svg.setAttribute("aria-hidden", "true")

          const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
          path.setAttribute("d", "M2 2 L10 10 M10 2 L2 10")
          path.setAttribute("stroke", "currentColor")
          path.setAttribute("stroke-width", "1.8")
          path.setAttribute("stroke-linecap", "round")
          svg.appendChild(path)
          return svg
        }

        function sendRuntimeMessage(payload: Record<string, unknown>): void {
          try {
            chrome.runtime.sendMessage(payload)
          } catch {}
        }

        function buildPanel(dock?: string): HTMLElement {
          const count = entries.length
          const panel = document.createElement("div")
          panel.id = "__opc_queue_panel"
          panel.style.cssText = PANEL_STYLE.panel + (dock === "bottom" ? ";bottom:48px;top:auto" : ";top:48px;bottom:auto")

          const header = document.createElement("div")
          header.style.cssText = PANEL_STYLE.header
          const title = document.createElement("div")
          title.style.cssText = PANEL_STYLE.titleHeader
          title.textContent = `Queued annotations (${count})`
          const closeButton = document.createElement("button")
          closeButton.type = "button"
          closeButton.style.cssText = PANEL_STYLE.close
          closeButton.setAttribute("aria-label", "Close queued annotations")
          closeButton.appendChild(createCloseIcon())
          closeButton.addEventListener("click", (event: MouseEvent) => {
            event.preventDefault()
            event.stopPropagation()
            globalThis.__opc_queuePanelOpen = false
            panel.remove()
          })
          header.appendChild(title)
          header.appendChild(closeButton)
          panel.appendChild(header)

          if (!count) {
            const empty = document.createElement("div")
            empty.style.cssText = PANEL_STYLE.empty
            empty.textContent = "No queued annotations yet"
            panel.appendChild(empty)
            return panel
          }

          entries.forEach((entry, index) => {
            const excerpt = typeof entry.comment === "string" && entry.comment.length > 140 ? `${entry.comment.slice(0, 140)}...` : entry.comment || ""
            const item = document.createElement("div")
            item.style.cssText = PANEL_STYLE.item

            const itemHeader = document.createElement("div")
            itemHeader.style.cssText = PANEL_STYLE.itemHeader
            const metaWrap = document.createElement("div")
            const itemIndex = document.createElement("span")
            itemIndex.style.cssText = PANEL_STYLE.itemIndex
            itemIndex.textContent = `${index + 1}.`
            const itemMeta = document.createElement("span")
            itemMeta.style.cssText = PANEL_STYLE.itemMeta
            itemMeta.textContent = `${entry.tag || ""} ${entry.selector || ""}`.trim()
            metaWrap.appendChild(itemIndex)
            metaWrap.appendChild(itemMeta)
            const removeButton = document.createElement("button")
            removeButton.type = "button"
            removeButton.style.cssText = PANEL_STYLE.itemRemove
            removeButton.setAttribute("aria-label", `Remove queued annotation ${index + 1}`)
            removeButton.textContent = "\u00d7"
            removeButton.addEventListener("click", (event: MouseEvent) => {
              event.preventDefault()
              event.stopPropagation()
              sendRuntimeMessage({ type: "remove_queued_annotation", id: entry.id })
            })
            itemHeader.appendChild(metaWrap)
            itemHeader.appendChild(removeButton)

            const comment = document.createElement("div")
            comment.style.cssText = PANEL_STYLE.itemComment
            comment.textContent = excerpt

            item.appendChild(itemHeader)
            item.appendChild(comment)
            panel.appendChild(item)
          })

          const footer = document.createElement("div")
          footer.style.cssText = PANEL_STYLE.footer
          const clearButton = document.createElement("button")
          clearButton.type = "button"
          clearButton.style.cssText = PANEL_STYLE.secondary
          clearButton.textContent = "Clear"
          clearButton.addEventListener("click", (event: MouseEvent) => {
            event.preventDefault()
            event.stopPropagation()
            sendRuntimeMessage({ type: "clear_queue" })
          })
          const sendButton = document.createElement("button")
          sendButton.type = "button"
          sendButton.style.cssText = PANEL_STYLE.primary
          sendButton.textContent = "Send all to OpenCode"
          sendButton.addEventListener("click", (event: MouseEvent) => {
            event.preventDefault()
            event.stopPropagation()
            sendRuntimeMessage({ type: "send_queued_annotations" })
          })
          footer.appendChild(clearButton)
          footer.appendChild(sendButton)
          panel.appendChild(footer)
          return panel
        }

        let overlay = document.getElementById("__opc_connection_overlay")
        if (!overlay) {
          overlay = document.createElement("div")
          overlay.id = "__opc_connection_overlay"
          overlay.style.cssText = [
            "position:fixed",
            "left:50%",
            "z-index:2147483647",
            "transform:translateX(-50%)",
            "display:flex",
            "align-items:center",
            "gap:8px",
            "padding:6px 8px 6px 10px",
            "border-radius:999px",
            "background:rgba(255,255,255,0.97)",
            "color:#111111",
            "border:1px solid rgba(0,0,0,0.12)",
            "box-shadow:0 8px 24px rgba(0,0,0,0.22)",
            "font:12px/1.2 ui-sans-serif,system-ui,sans-serif",
            "pointer-events:auto",
            "backdrop-filter:blur(8px)",
            "cursor:grab",
            "user-select:none",
            "-webkit-user-select:none",
          ].join(";")

          const label = document.createElement("button")
          label.type = "button"
          label.dataset.role = "label"
          label.title = "Linked OpenCode chat - click to switch"
          label.style.cssText = [
            "border:0",
            "background:transparent",
            "color:#111111",
            "font:600 12px/1.2 ui-sans-serif,system-ui,sans-serif",
            "cursor:pointer",
            "padding:0",
            "max-width:200px",
            "overflow:hidden",
            "text-overflow:ellipsis",
            "white-space:nowrap",
            "text-align:left",
          ].join(";")
          label.addEventListener("click", (event: MouseEvent) => {
            event.preventDefault()
            event.stopPropagation()
            sendRuntimeMessage({ type: "refresh_sessions" })
          })
          overlay.appendChild(label)

          const button = document.createElement("button")
          button.type = "button"
          button.textContent = "Annotate"
          button.style.cssText = [
            "border:0",
            "border-radius:999px",
            "padding:4px 8px",
            "background:#111111",
            "color:#ffffff",
            "font:600 11px/1 ui-sans-serif,system-ui,sans-serif",
            "cursor:pointer",
          ].join(";")
          button.addEventListener("click", (event: MouseEvent) => {
            event.preventDefault()
            event.stopPropagation()
            sendRuntimeMessage({ type: "start_annotation_from_overlay" })
          })
          overlay.appendChild(button)

          const queueButton = document.createElement("button")
          queueButton.type = "button"
          queueButton.setAttribute("aria-label", "Queued annotations")
          queueButton.style.cssText = [
            "position:relative",
            "border:1px solid rgba(0,0,0,0.12)",
            "border-radius:999px",
            "padding:4px 8px",
            "background:transparent",
            "color:#111111",
            "font:600 11px/1 ui-sans-serif,system-ui,sans-serif",
            "cursor:pointer",
          ].join(";")
          queueButton.textContent = "Queue"
          if (entries.length) {
            const badge = document.createElement("span")
            badge.textContent = String(entries.length)
            badge.style.cssText = [
              "margin-left:5px",
              "padding:1px 5px",
              "border-radius:999px",
              "background:#bbf7d0",
              "color:#111111",
              "font:700 10px/1.4 ui-sans-serif,system-ui,sans-serif",
              "vertical-align:super",
            ].join(";")
            queueButton.appendChild(badge)
          }
          queueButton.addEventListener("click", (event: MouseEvent) => {
            event.preventDefault()
            event.stopPropagation()
            globalThis.__opc_queuePanelOpen = !globalThis.__opc_queuePanelOpen
            document.getElementById("__opc_queue_panel")?.remove()
            if (globalThis.__opc_queuePanelOpen) {
              document.documentElement.appendChild(buildPanel(overlay?.dataset.dock))
            }
          })
          overlay.appendChild(queueButton)

          const closeButton = document.createElement("button")
          closeButton.type = "button"
          closeButton.setAttribute("aria-label", "Disconnect tab")
          closeButton.style.cssText = [
            "border:0",
            "padding:0 2px",
            "background:transparent",
            "color:#111111",
            "font:700 14px/1 ui-sans-serif,system-ui,sans-serif",
            "cursor:pointer",
          ].join(";")
          closeButton.appendChild(createCloseIcon())
          closeButton.addEventListener("click", (event: MouseEvent) => {
            event.preventDefault()
            event.stopPropagation()
            sendRuntimeMessage({ type: "disconnect_tab" })
          })
          overlay.appendChild(closeButton)
          document.documentElement.appendChild(overlay)
        }

        const dockable = makeDockable(overlay, { blockDragSelector: "button", snapThreshold: 10 })
        dockable.applyDockPosition(overlay.dataset.dock)
        const label = overlay.querySelector("[data-role='label']")
        if (label) label.textContent = linkedLabelArg

        document.getElementById("__opc_queue_panel")?.remove()
        if (globalThis.__opc_queuePanelOpen) {
          document.documentElement.appendChild(buildPanel(overlay.dataset.dock))
        }
      },
    })
  } catch (error) {
    warnExtension("Failed to inject connection overlay", { tabId, error: error instanceof Error ? error.message : String(error) })
  }
}

export async function removeConnectionOverlay(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: () => {
        document.getElementById("__opc_connection_overlay")?.remove()
        document.getElementById("__opc_queue_panel")?.remove()
        delete globalThis.__opc_queuePanelOpen
      },
    })
  } catch {
    // Tab may have closed or disallow injection.
  }
}

export async function showAnnotationError(tabId: number, message: string): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    args: [message],
    func: (errorMessage: string) => {
      const existing = document.getElementById("__opc_annotation_error")
      if (existing) existing.remove()

      const panel = document.createElement("div")
      panel.id = "__opc_annotation_error"
      panel.textContent = `OpenCode annotation failed: ${errorMessage}`
      panel.style.cssText = [
        "position:fixed",
        "right:16px",
        "bottom:16px",
        "z-index:2147483647",
        "max-width:360px",
        "padding:12px 14px",
        "border-radius:10px",
        "background:#ffe4e6",
        "color:#111111",
        "border:1px solid rgba(0,0,0,0.10)",
        "box-shadow:0 10px 30px rgba(0,0,0,0.35)",
        "font:13px/1.4 ui-sans-serif,system-ui,sans-serif",
        "transform:translateX(calc(100% + 40px))",
        "opacity:0",
        "transition:transform 180ms cubic-bezier(.2,.8,.2,1), opacity 160ms ease",
      ].join(";")
      document.documentElement.appendChild(panel)
      requestAnimationFrame(() => {
        panel.style.transform = "translateX(0)"
        panel.style.opacity = "1"
      })
      setTimeout(() => {
        panel.style.transform = "translateX(calc(100% + 40px))"
        panel.style.opacity = "0"
        setTimeout(() => panel.remove(), 220)
      }, 7000)
    },
  })
}

export async function showSendToast(tabId: number, message: string): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    args: [message],
    func: (successMessage: string) => {
      const existing = document.getElementById("__opc_annotation_sent")
      if (existing) existing.remove()

      const panel = document.createElement("div")
      panel.id = "__opc_annotation_sent"
      panel.textContent = successMessage
      panel.style.cssText = [
        "position:fixed",
        "right:16px",
        "bottom:16px",
        "z-index:2147483647",
        "max-width:360px",
        "padding:12px 14px",
        "border-radius:10px",
        "background:#d1fae5",
        "color:#111111",
        "border:1px solid rgba(0,0,0,0.10)",
        "box-shadow:0 10px 30px rgba(0,0,0,0.35)",
        "font:13px/1.4 ui-sans-serif,system-ui,sans-serif",
        "transform:translateX(calc(100% + 40px))",
        "opacity:0",
        "transition:transform 180ms cubic-bezier(.2,.8,.2,1), opacity 160ms ease",
      ].join(";")
      document.documentElement.appendChild(panel)
      requestAnimationFrame(() => {
        panel.style.transform = "translateX(0)"
        panel.style.opacity = "1"
      })
      setTimeout(() => {
        panel.style.transform = "translateX(calc(100% + 40px))"
        panel.style.opacity = "0"
        setTimeout(() => panel.remove(), 220)
      }, 3500)
    },
  })
}
