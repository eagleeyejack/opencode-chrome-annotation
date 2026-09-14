import { logExtension, warnExtension } from "./logger.js"
import { getActiveTab } from "./tabs.js"
import { postJson, requestSessionState } from "./server-api.js"
import { injectConnectionOverlay, removeConnectionOverlay, showAnnotationError, showSendToast } from "./ui-overlays.js"
import type { QueuePreview } from "./ui-overlays.js"
import { showSessionPicker } from "./session-picker.js"
import { runAnnotationPicker } from "./annotation-picker.js"
import { createConnectionMonitor } from "./connection-monitor.js"
import { createClaimsStore } from "./claims-store.js"
import { createAnnotationQueueStore } from "./annotation-queue-store.js"
import type { AnnotationQueueEntry, ExtensionMessage, SessionInfo } from "./types.js"

const claimedTabs = createClaimsStore()
const annotationQueues = createAnnotationQueueStore()
const extensionVersion = chrome.runtime.getManifest().version

const monitor = createConnectionMonitor({
  claimedTabs,
  removeConnectionOverlay,
  extensionVersion,
})

const MESSAGE_TYPE = {
  START_ANNOTATION: "start_annotation_from_overlay",
  CONNECT_TAB: "connect_tab_to_session",
  DISCONNECT_TAB: "disconnect_tab",
  REFRESH_SESSIONS: "refresh_sessions",
  SHOW_QUEUE: "show_annotation_queue",
  REMOVE_QUEUED: "remove_queued_annotation",
  CLEAR_QUEUE: "clear_queue",
  SEND_QUEUE: "send_queued_annotations",
} as const

function isSupportedMessage(message: unknown): message is ExtensionMessage {
  const type = typeof message === "object" && message !== null ? (message as { type?: unknown }).type : undefined
  return typeof type === "string" && (Object.values(MESSAGE_TYPE) as string[]).includes(type)
}

function toOriginPattern(url?: string): string | null {
  if (typeof url !== "string" || !url) return null
  try {
    const parsed = new URL(url)
    if (!/^https?:$/.test(parsed.protocol)) return null
    return `${parsed.origin}/*`
  } catch {
    return null
  }
}

function sessionLabel(session: Pick<SessionInfo, "id" | "title">): string {
  return session?.title || session?.id
}

function claimRequestBody(tabId: number, sessionId: string) {
  return { tabId, sessionId, extensionVersion }
}

async function showConnectionOverlay(tabId: number, openQueue = false): Promise<void> {
  const queueEntries: QueuePreview[] = annotationQueues.list(tabId).map((entry) => ({
    id: entry.id,
    comment: entry.comment,
    tag: entry.element?.tag,
    selector: entry.element?.selector,
  }))
  await injectConnectionOverlay(tabId, {
    openQueue,
    linkedLabel: claimedTabs.get(tabId)?.sessionLabel || "Connected",
    queueEntries,
  })
}

async function ensureSiteAccess(tab: chrome.tabs.Tab): Promise<void> {
  if (!chrome.permissions?.request) return

  const origin = toOriginPattern(tab?.url)
  if (!origin) {
    throw new Error("This page cannot be annotated. Open an http(s) page and try again.")
  }

  const granted = await chrome.permissions.request({ origins: [origin] })
  if (!granted) {
    throw new Error("Site access was denied for this page.")
  }
}

async function captureVisibleTabWithTimeout(windowId: number, timeoutMs = 10000): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Screenshot capture timed out. The tab may have navigated. Reconnect and try again.")),
      timeoutMs
    )
  })
  try {
    return await Promise.race([chrome.tabs.captureVisibleTab(windowId, { format: "png" }), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function cropScreenshot(
  tabId: number,
  dataUrl: string,
  rect: { x?: number; y?: number; width?: number; height?: number } | null | undefined,
  viewport: { width: number; height: number } | null | undefined
): Promise<string | null> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      files: ["injected/dom.js"],
    })
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: (source: string, rectArg: unknown, viewportArg: unknown) =>
        globalThis.__opc_cropDataUrl!(source, rectArg as never, viewportArg as never, 12),
      args: [dataUrl, rect, viewport],
    })
    return results[0]?.result || null
  } catch {
    return null
  }
}

async function sendQueuedAnnotations(tab: chrome.tabs.Tab) {
  const entries = annotationQueues.list(tab.id)
  if (!entries.length) return { ok: true, sent: 0 }
  const claim = claimedTabs.get(tab.id)
  if (!claim?.baseUrl || !claim?.sessionId) {
    throw new Error("Tab is not connected to an OpenCode instance")
  }
  try {
    await postJson(claim.baseUrl, "/claim", claimRequestBody(tab.id!, claim.sessionId))
  } catch {
    // Best-effort claim refresh; delivery below reports real failures.
  }
  const taken = await annotationQueues.take(tab.id!)
  let sent = 0
  let failure: Error | null = null
  for (const entry of taken) {
    try {
      await postJson(claim.baseUrl, "/annotation", {
        ...claimRequestBody(tab.id!, claim.sessionId),
        annotation: {
          comment: entry.comment,
          page: entry.page,
          element: entry.element,
          viewport: entry.viewport,
          screenshot: entry.screenshot,
        },
      })
      sent += 1
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
      break
    }
  }
  if (failure) {
    const remaining = taken.slice(sent)
    for (const entry of remaining) await annotationQueues.add(tab.id!, entry)
    warnExtension("Failed to send queued annotations", {
      tabId: tab.id,
      sent,
      total: taken.length,
      error: failure.message,
    })
    await showAnnotationError(tab.id!, `Failed to send queued annotations (${sent} of ${taken.length} delivered): ${failure.message}`)
    await showConnectionOverlay(tab.id!, true)
    return { ok: false, sent, failed: taken.length - sent, error: failure.message }
  }
  logExtension("Queued annotations delivered to OpenCode instance", {
    tabId: tab.id,
    baseUrl: claim.baseUrl,
    sent,
  })
  await showSendToast(tab.id!, `Sent ${sent} annotations to OpenCode`).catch(() => {})
  await showConnectionOverlay(tab.id!)
  return { ok: true, sent, failed: 0 }
}

async function runMessageAction(message: ExtensionMessage, tab: chrome.tabs.Tab) {
  if (message.type === "connect_tab_to_session") {
    logExtension("Session picker selection received", {
      tabId: tab?.id,
      sessionId: message.session?.id,
      sessionLabel: sessionLabel(message.session),
    })
    await claimTabForSession(tab, message.session)
    return { ok: true }
  }

  if (message.type === "disconnect_tab") {
    const disconnected = await disconnectTab(tab)
    return { ok: true, disconnected }
  }

  if (message.type === "refresh_sessions") {
    const { sessions, context } = await requestSessionState()
    if (!tab.id) throw new Error("No active tab found")
    await showSessionPicker(tab.id, sessions, context, claimedTabs.get(tab.id)?.sessionId || null)
    return { ok: true, sessions: sessions.length }
  }

  if (message.type === "show_annotation_queue") {
    if (!tab.id) throw new Error("No active tab found")
    await showConnectionOverlay(tab.id, true)
    return { ok: true, queued: annotationQueues.list(tab.id).length }
  }

  if (message.type === "remove_queued_annotation") {
    if (!tab.id) throw new Error("No active tab found")
    await annotationQueues.remove(tab.id, message.id)
    await showConnectionOverlay(tab.id, true)
    return { ok: true }
  }

  if (message.type === "clear_queue") {
    if (!tab.id) throw new Error("No active tab found")
    const hadEntries = annotationQueues.list(tab.id).length > 0
    await annotationQueues.clear(tab.id)
    await showConnectionOverlay(tab.id, hadEntries)
    return { ok: true }
  }

  if (message.type === "send_queued_annotations") {
    if (!tab.id) throw new Error("No active tab found")
    return await sendQueuedAnnotations(tab)
  }

  const result = await startAnnotationMode(tab)
  if (tab.id && result?.queued > 0) await showConnectionOverlay(tab.id, true)
  return { ok: true, cancelled: !!result?.cancelled, queued: result?.queued || 0 }
}

async function handleMessage(message: ExtensionMessage, sender: chrome.runtime.MessageSender) {
  const tab = sender.tab?.id ? sender.tab : await getActiveTab()

  try {
    return await runMessageAction(message, tab)
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    if (message.type === "connect_tab_to_session") {
      warnExtension("Failed to connect tab to OpenCode session", {
        tabId: tab?.id,
        sessionId: message.session?.id,
        error: text,
      })
    }
    if (tab?.id) await showAnnotationError(tab.id, text).catch(() => {})
    return { ok: false, error: text }
  }
}

async function claimTabForSession(tab: chrome.tabs.Tab, session: SessionInfo): Promise<void> {
  if (!tab.id) throw new Error("No active tab found")
  if (session.id.startsWith("plugin:")) {
    throw new Error("That is a placeholder session, not a real chat. Restart OpenCode in your project and try again.")
  }
  logExtension("Connecting tab to OpenCode session", {
    tabId: tab?.id,
    sessionId: session?.id,
    sessionLabel: sessionLabel(session),
    baseUrl: session?.baseUrl,
  })

  await postJson(session.baseUrl, "/claim", claimRequestBody(tab.id, session.id))

  claimedTabs.set(tab.id, {
    sessionId: session.id,
    sessionLabel: sessionLabel(session),
    baseUrl: session.baseUrl,
    origin: toOriginPattern(tab.url),
    extensionVersion,
  })

  await showConnectionOverlay(tab.id)
  monitor.ensure()

  logExtension("Connected tab to OpenCode session", {
    tabId: tab?.id,
    sessionId: session?.id,
    sessionLabel: sessionLabel(session),
    baseUrl: session?.baseUrl,
  })
}

async function disconnectTab(tab: chrome.tabs.Tab): Promise<boolean> {
  if (!tab.id) return false
  const claim = claimedTabs.get(tab?.id)
  if (!claim) return false

  if (claim?.baseUrl && claim?.sessionId) {
    try {
      await postJson(claim.baseUrl, "/unclaim", claimRequestBody(tab.id, claim.sessionId))
    } catch (error) {
      warnExtension("Failed to clear upstream tab claim", {
        tabId: tab?.id,
        sessionId: claim?.sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  claimedTabs.delete(tab.id)
  annotationQueues.delete(tab.id)
  await removeConnectionOverlay(tab.id)
  if (!claimedTabs.size()) monitor.stop()

  logExtension("Disconnected tab from OpenCode session", {
    tabId: tab?.id,
    sessionId: claim?.sessionId,
  })

  return true
}

async function startAnnotationMode(tabOverride?: chrome.tabs.Tab): Promise<{ cancelled: boolean; queued: number }> {
  const tab = tabOverride?.id ? tabOverride : await getActiveTab()
  if (!tab?.id || !tab.windowId) throw new Error("No active tab found")

  const claim = claimedTabs.get(tab.id)
  if (!claim?.baseUrl || !claim?.sessionId) {
    throw new Error("Tab is not connected to an OpenCode instance")
  }
  try {
    await postJson(claim.baseUrl, "/claim", claimRequestBody(tab.id, claim.sessionId))
  } catch (error) {
    warnExtension("Failed to refresh upstream tab claim before annotating", {
      tabId: tab.id,
      sessionId: claim.sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  logExtension("Starting annotation queue mode", {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url,
    title: tab.title,
  })

  let queued = 0
  for (;;) {
    const picked = await runAnnotationPicker(tab.id)
    if (!picked || picked.cancelled === true) break

    logExtension("Capturing annotation screenshot", { tabId: tab.id, windowId: tab.windowId })
    const screenshot = await captureVisibleTabWithTimeout(tab.windowId)
    const cropped = await cropScreenshot(tab.id, screenshot, picked.element?.rect, picked.viewport)
    const dataUrl = cropped || screenshot
    logExtension("Captured annotation screenshot", {
      tabId: tab.id,
      cropped: !!cropped,
      bytesApprox: Math.round((dataUrl.length * 3) / 4),
    })

    try {
      await annotationQueues.add(tab.id, {
        comment: picked.comment || "",
        page: {
          url: tab.url || "",
          title: tab.title || "",
        },
        element: picked.element,
        viewport: picked.viewport,
        screenshot: {
          mime: "image/png",
          dataUrl,
        },
        createdAt: Date.now(),
      })
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      warnExtension("Failed to persist annotation queue", { tabId: tab.id, error: text })
      await showAnnotationError(tab.id, "Annotation queue is full - send or remove queued annotations")
      break
    }

    queued += 1
    logExtension("Annotation queued", {
      tabId: tab.id,
      selector: picked.element?.selector,
      commentLength: (picked.comment || "").length,
      queued,
    })
    await showConnectionOverlay(tab.id, true)
    if (picked.finish === true) break
  }

  return { cancelled: false, queued }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  claimedTabs.delete(tabId)
  annotationQueues.delete(tabId)
  if (!claimedTabs.size()) monitor.stop()
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return
  const claim = claimedTabs.get(tabId)
  if (!claim) return

  const nextOrigin = toOriginPattern(tab?.url)
  if (nextOrigin && claim.origin && nextOrigin !== claim.origin) {
    disconnectTab({ ...tab, id: tabId }).catch(() => {})
    return
  }

  showConnectionOverlay(tabId)
})

chrome.tabs.onActivated.addListener(({ tabId }) => {
  const claim = claimedTabs.get(tabId)
  if (claim) showConnectionOverlay(tabId)
})

async function restoreClaimState() {
  await claimedTabs.restore()
  await annotationQueues.restore()

  for (const [tabId, claim] of Array.from(claimedTabs.entries())) {
    try {
      const tab = await chrome.tabs.get(tabId)
      const nextOrigin = toOriginPattern(tab?.url)
      if (!nextOrigin || (claim.origin && nextOrigin !== claim.origin)) {
        claimedTabs.delete(tabId)
        continue
      }
      await showConnectionOverlay(tabId)
    } catch {
      claimedTabs.delete(tabId)
    }
  }

  if (claimedTabs.size()) monitor.ensure()
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isSupportedMessage(message)) return false

  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    })

  return true
})

chrome.action.onClicked.addListener(async (clickedTab) => {
  try {
    const tab = clickedTab?.id ? clickedTab : await getActiveTab()
    if (!tab.id) throw new Error("No active tab found")
    await ensureSiteAccess(tab)
    const { sessions, context } = await requestSessionState()
    await showSessionPicker(tab.id, sessions, context, claimedTabs.get(tab.id)?.sessionId || null)
    logExtension(sessions.length ? "Session picker shown" : "OpenCode setup help shown", undefined)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    warnExtension("Failed to show session picker", { error: message })
    const tab = await getActiveTab().catch((): null => null)
    if (tab?.id) await showAnnotationError(tab.id, message).catch(() => {})
  }
})

restoreClaimState().catch((error) => {
  warnExtension("Failed to restore tab claims", { error: error instanceof Error ? error.message : String(error) })
})
