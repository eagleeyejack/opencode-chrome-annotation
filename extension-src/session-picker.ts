import type { SessionInfo, SessionPickerContext } from "./types.js"

function sessionPickerScript(items: SessionInfo[], context: SessionPickerContext, currentSessionId: string | null) {
  const h = globalThis.__opc_h!
  const makeDockable = globalThis.__opc_makeDockable!
  if (typeof h !== "function" || typeof makeDockable !== "function") {
    throw new Error("OpenCode UI helpers are unavailable")
  }

  if (typeof globalThis.__opc_cleanupSessionPicker === "function") {
    globalThis.__opc_cleanupSessionPicker()
  }

  const STYLE = {
    collapsed: [
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
    ].join(";"),
    expanded: [
      "position:fixed",
      "left:50%",
      "z-index:2147483647",
      "transform:translateX(-50%)",
      "display:block",
      "width:min(420px,calc(100vw - 20px))",
      "max-height:min(560px,calc(100vh - 40px))",
      "overflow:auto",
      "padding:10px",
      "border-radius:14px",
      "background:rgba(255,255,255,0.97)",
      "color:#111111",
      "border:1px solid rgba(0,0,0,0.12)",
      "box-shadow:0 14px 40px rgba(0,0,0,0.35)",
      "font:12px/1.35 ui-sans-serif,system-ui,sans-serif",
      "pointer-events:auto",
      "backdrop-filter:blur(8px)",
      "cursor:grab",
      "user-select:none",
      "-webkit-user-select:none",
    ].join(";"),
    row: "display:flex;align-items:center;gap:8px;",
    label: "font-weight:600;",
    annotate: "border:0;border-radius:999px;padding:4px 8px;background:#111111;color:#ffffff;font:600 11px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer;",
    title: "font-weight:700;margin:2px 4px 8px;color:#111111;",
    header: "display:flex;align-items:center;justify-content:space-between;gap:8px;margin:2px 2px 8px;",
    empty: "padding:8px 4px 2px;color:#111111;",
    emptyTitle: "font-weight:700;margin-bottom:6px;",
    emptyText: "margin:0 0 8px;color:#6b7280;line-height:1.45;",
    emptyList: "margin:0;padding-left:18px;color:#6b7280;line-height:1.5;",
    retry: "margin-top:10px;border:0;border-radius:999px;padding:6px 10px;background:#111111;color:#ffffff;font:600 11px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer;",
    itemButton: [
      "display:block",
      "width:100%",
      "text-align:left",
      "padding:7px 2px 7px 4px",
      "margin:0",
      "border:0",
      "border-radius:0",
      "border-bottom:1px solid rgba(0,0,0,0.08)",
      "background:transparent",
      "color:#111111",
      "cursor:pointer",
    ].join(";"),
    itemButtonFocused: [
      "background:#f3f4f6",
    ].join(";"),
    name: "font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
    meta: "margin-top:2px;color:#6b7280;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:0.92;",
    groupHeader: "display:flex;align-items:baseline;gap:6px;margin:10px 2px 2px;padding-top:6px;border-top:1px solid rgba(0,0,0,0.08);overflow:hidden;",
    groupName: "font-weight:700;color:#111111;font-size:11px;flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
    groupPath: "color:#6b7280;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
    close: "display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;color:#111111;cursor:pointer;font:700 14px/1 ui-sans-serif,system-ui,sans-serif;padding:0 2px;",
  }

  function ensureOverlay() {
    let overlay = document.getElementById("__opc_connection_overlay")
    const existed = !!overlay

    if (!overlay) {
      overlay = h("div", { attrs: { id: "__opc_connection_overlay" } })
      document.documentElement.appendChild(overlay)
    }

    return { overlay, existed }
  }

  function renderCollapsed(overlay: HTMLElement, labelText: string) {
    overlay.innerHTML = ""
    overlay.style.cssText = STYLE.collapsed
    const dockable = makeDockable(overlay, { blockDragSelector: "button", snapThreshold: 10 })
    dockable.applyDockPosition(overlay.dataset.dock)

    const label = h("span", {
      text: labelText,
      style: STYLE.label,
      attrs: { "data-role": "label" },
    })

    const annotate = h("button", {
      text: "Annotate",
      style: STYLE.annotate,
      attrs: { type: "button" },
      on: {
        click: (event: Event) => {
          event.preventDefault()
          event.stopPropagation()
          try {
            chrome.runtime.sendMessage({ type: "start_annotation_from_overlay" })
          } catch {}
        },
      },
    })

    const row = h("div", { style: STYLE.row, attrs: { "data-role": "row" } }, [label, annotate])
    overlay.appendChild(row)

    const queueCount = Number(globalThis.__opc_lastQueueCount) || 0
    if (queueCount > 0) {
      const queueButton = h("button", {
        text: `Queue (${queueCount})`,
        style: "margin-left:8px;border:1px solid rgba(0,0,0,0.12);border-radius:999px;padding:4px 8px;background:transparent;color:#111111;font:600 11px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer;",
        attrs: { type: "button", "aria-label": "Queued annotations" },
        on: {
          click: (event: Event) => {
            event.preventDefault()
            event.stopPropagation()
            try {
              chrome.runtime.sendMessage({ type: "show_annotation_queue" })
            } catch {}
          },
        },
      })
      row.appendChild(queueButton)
    }
  }

  function sessionButton(onSelect: () => void, item: SessionInfo) {
    const isLinked = Boolean(currentSessionId) && item.id === currentSessionId
    const children = [h("span", { text: item.title || item.id, style: STYLE.name })]
    if (isLinked) {
      children.unshift(h("span", {
        text: "Linked",
        style: "flex:none;padding:1px 6px;border-radius:999px;background:#bfdbfe;color:#111111;font:700 10px/1.4 ui-sans-serif,system-ui,sans-serif;",
      }))
    }
    return h(
      "button",
      {
        style: STYLE.itemButton,
        attrs: { type: "button", "data-role": "session-item" },
        on: {
          click: () => {
            try {
              chrome.runtime.sendMessage({ type: "connect_tab_to_session", session: item })
            } catch {}
            onSelect()
          },
        },
      },
      [
        h("div", { style: "display:flex;align-items:center;gap:6px;" }, children),
        h("div", {
          text: item.directory || item.id,
          style: STYLE.meta,
        }),
      ]
    )
  }

  function emptyStateContent() {
    if (context.reason === "no-sessions") {
      return {
        title: "No OpenCode session available",
        text: "The local plugin responded, but it did not report any real OpenCode chats. Restart OpenCode in the project you want to edit.",
        steps: [
          "Open OpenCode in the project you want to edit",
          "Make sure the annotation plugin is enabled in that OpenCode config",
          "Restart OpenCode if you just changed the config",
        ],
      }
    }

    return {
      title: "OpenCode plugin not found",
      text: "The extension could not find a local OpenCode annotation server on ports 39240-39260.",
      steps: [
        "Install npm package: opencode-chrome-annotation",
        "Add it to your OpenCode config",
        "Restart OpenCode in your project",
      ],
    }
  }

  function renderEmptyState() {
    const content = emptyStateContent()
    return h("div", { style: STYLE.empty }, [
      h("div", { text: content.title, style: STYLE.emptyTitle }),
      h("p", {
        text: content.text,
        style: STYLE.emptyText,
      }),
      h("ol", { style: STYLE.emptyList }, content.steps.map((step) => h("li", { text: step }))),
      h("button", {
        text: "Try again",
        style: STYLE.retry,
        attrs: { type: "button" },
        on: {
          click: () => {
            try {
              chrome.runtime.sendMessage({ type: "refresh_sessions" })
            } catch {}
          },
        },
      }),
    ])
  }

  function createCloseIcon() {
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

  function createRefreshIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    svg.setAttribute("viewBox", "0 0 12 12")
    svg.setAttribute("width", "12")
    svg.setAttribute("height", "12")
    svg.setAttribute("aria-hidden", "true")

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
    path.setAttribute("d", "M10 6a4 4 0 1 1-1.17-2.83M10 1.5V3.5H8")
    path.setAttribute("stroke", "currentColor")
    path.setAttribute("stroke-width", "1.4")
    path.setAttribute("stroke-linecap", "round")
    path.setAttribute("stroke-linejoin", "round")
    path.setAttribute("fill", "none")
    svg.appendChild(path)
    return svg
  }

  const { overlay, existed } = ensureOverlay()
  const dockable = makeDockable(overlay, { blockDragSelector: "button", snapThreshold: 10 })
  const priorLabel = overlay.querySelector("[data-role='label']")?.textContent || "Connected"
  overlay.style.cssText = STYLE.expanded
  dockable.applyDockPosition(overlay.dataset.dock)
  overlay.innerHTML = ""

  const close = () => {
    cleanupKeyboard()
    if (!existed) {
      overlay.remove()
      return
    }
    renderCollapsed(overlay, priorLabel)
  }

  overlay.appendChild(
    h("div", { style: STYLE.header }, [
      h("div", { text: "Connect this tab to OpenCode", style: STYLE.title }),
      h("div", { style: "display:flex;align-items:center;gap:2px;" }, [
        h("button", {
          style: STYLE.close,
          attrs: { type: "button", "aria-label": "Refresh chat list" },
          on: {
            click: (event: Event) => {
              event.preventDefault()
              event.stopPropagation()
              try {
                chrome.runtime.sendMessage({ type: "refresh_sessions" })
              } catch {}
            },
          },
        }, [createRefreshIcon()]),
        h("button", {
          style: STYLE.close,
          attrs: { type: "button", "aria-label": "Close session picker" },
          on: { click: close },
        }, [createCloseIcon()]),
      ]),
    ])
  )

  if (items.length) {
    const groups: Array<{ directory: string; items: SessionInfo[] }> = []
    const byDirectory = new Map<string, { directory: string; items: SessionInfo[] }>()
    for (const item of items) {
      const dir = item.directory || ""
      let group = byDirectory.get(dir)
      if (!group) {
        group = { directory: dir, items: [] }
        byDirectory.set(dir, group)
        groups.push(group)
      }
      group.items.push(item)
    }
    for (const group of groups) {
      if (groups.length > 1) {
        const segments = group.directory.split("/").filter(Boolean)
        const projectName = segments.length ? segments[segments.length - 1] : group.directory
        overlay.appendChild(h("div", { style: STYLE.groupHeader }, [
          h("span", { text: projectName, style: STYLE.groupName }),
          h("span", { text: group.directory, style: STYLE.groupPath }),
        ]))
      }
      for (const item of group.items) {
        overlay.appendChild(sessionButton(close, item))
      }
    }
  } else {
    overlay.appendChild(renderEmptyState())
  }

  const sessionButtons = Array.from(overlay.querySelectorAll("[data-role='session-item']")) as HTMLElement[]
  let focusedIndex = sessionButtons.length ? 0 : -1

  function setFocusedIndex(nextIndex: number) {
    if (!sessionButtons.length) {
      focusedIndex = -1
      return
    }

    const count = sessionButtons.length
    focusedIndex = ((nextIndex % count) + count) % count
    sessionButtons.forEach((button, index) => {
      button.style.cssText = STYLE.itemButton + (index === focusedIndex ? `;${STYLE.itemButtonFocused}` : "")
    })
    sessionButtons[focusedIndex].focus({ preventScroll: true })
  }

  function onKeyDown(event: KeyboardEvent) {
    if (!overlay.isConnected) return
    if (event.key === "Escape") {
      event.preventDefault()
      close()
      return
    }

    if (!sessionButtons.length) return

    if (event.key === "ArrowDown") {
      event.preventDefault()
      setFocusedIndex(focusedIndex + 1)
      return
    }

    if (event.key === "ArrowUp") {
      event.preventDefault()
      setFocusedIndex(focusedIndex - 1)
      return
    }

    if (event.key === "Enter") {
      event.preventDefault()
      if (focusedIndex >= 0) sessionButtons[focusedIndex].click()
    }
  }

  function cleanupKeyboard() {
    document.removeEventListener("keydown", onKeyDown, true)
    if (globalThis.__opc_cleanupSessionPicker === cleanupKeyboard) {
      delete globalThis.__opc_cleanupSessionPicker
    }
  }

  document.addEventListener("keydown", onKeyDown, true)
  globalThis.__opc_cleanupSessionPicker = cleanupKeyboard
  setFocusedIndex(0)
}

export async function showSessionPicker(
  tabId: number,
  sessions: SessionInfo[],
  context: SessionPickerContext = { instanceCount: sessions.length ? 1 : 0 },
  currentSessionId: string | null = null
): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    files: ["injected/dom.js"],
  })
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    args: [sessions.slice(0, 24), context, currentSessionId],
    func: sessionPickerScript,
  })
}
