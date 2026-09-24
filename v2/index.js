import { Plugin } from "@opencode/plugin"
import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { pathToFileURL } from "node:url"
import { createServer } from "node:http"

const APP_ID = "opencode-chrome-annotation"
const PORT_START = 39240
const PORT_END = 39260
const HOST = "127.0.0.1"
const CLAIM_TTL_MS = 5 * 60 * 1000
const BODY_LIMIT = 10 * 1024 * 1024

function sendJson(res, status, body, origin) {
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin)
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "content-type")
  res.setHeader("Content-Type", "application/json; charset=utf-8")
  res.statusCode = status
  res.end(JSON.stringify(body))
}

function extensionOrigin(req) {
  const origin = req.headers?.origin
  return typeof origin === "string" && /^(chrome|moz)-extension:\/\//.test(origin) ? origin : undefined
}

async function readJson(req) {
  let text = ""
  for await (const chunk of req) {
    text += chunk.toString("utf8")
    if (text.length > BODY_LIMIT) throw new Error("Request body too large")
  }
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    throw new Error("Invalid JSON body")
  }
}

function filenamePart(value) {
  return String(value || "annotation")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "annotation"
}

function imageData(value) {
  const match = String(value || "").match(/^data:([^;,]+)?;base64,(.+)$/)
  if (!match) throw new Error("Annotation screenshot must be a base64 data URL")
  return { mime: match[1] || "application/octet-stream", bytes: Buffer.from(match[2], "base64") }
}

function annotationPrompt(annotation) {
  const page = annotation.page || {}
  const element = annotation.element || {}
  const rect = element.rect || {}
  const viewport = annotation.viewport || {}
  return [
    "Browser annotation from Chrome",
    "",
    "User comment:",
    typeof annotation.comment === "string" && annotation.comment.trim() ? annotation.comment.trim() : "(no comment provided)",
    "",
    "Page:",
    `Title: ${page.title || ""}`,
    `URL: ${page.url || ""}`,
    typeof annotation.tabId === "number" ? `Tab ID: ${annotation.tabId}` : "Tab ID:",
    `Viewport: width=${viewport.width ?? ""} height=${viewport.height ?? ""} devicePixelRatio=${viewport.devicePixelRatio ?? ""}`,
    "",
    "Selected element:",
    `Selector: ${element.selector || ""}`,
    `Tag: ${element.tag || ""}`,
    `Role: ${element.role || ""}`,
    `Text: ${element.text || ""}`,
    `Aria label: ${element.ariaLabel || ""}`,
    `Rect: x=${rect.x ?? ""} y=${rect.y ?? ""} width=${rect.width ?? ""} height=${rect.height ?? ""}`,
    "",
    "Inspect the screenshot and selected-element metadata, then make the appropriate code change.",
  ].join("\n")
}

export default Plugin.define({
  id: "opencode.chrome-annotation-v2",
  async setup(ctx) {
    const uid = typeof process.getuid === "function" ? process.getuid() : "user"
    const runtimeDir = join(process.env.XDG_RUNTIME_DIR || tmpdir(), "opencode-chrome-annotation-v2")
    const annotationDir = join(runtimeDir, "annotations")
    const logPath = join(runtimeDir, "plugin.log")
    const sessions = new Map()
    const claims = new Map()
    const controller = new AbortController()
    let activeSessionID
    let lastAnnotation
    let extensionVersion
    let port
    let server
    let sessionWrite = Promise.resolve()

    await mkdir(annotationDir, { recursive: true, mode: 0o700 })
    const log = async (message) => appendFile(logPath, `[${new Date().toISOString()}] ${message}\n`).catch(() => {})
    const persistSessions = () => {
      const snapshot = [...sessions.values()]
      sessionWrite = sessionWrite
        .then(() => ctx.storage.set("sessions", snapshot))
        .catch((error) => log(`session cache write failed: ${String(error)}`))
      return sessionWrite
    }
    const cachedSessions = await ctx.storage.get("sessions")
    if (Array.isArray(cachedSessions)) {
      for (const item of cachedSessions) {
        if (item && typeof item.id === "string" && !item.id.startsWith("v2-plugin:")) sessions.set(item.id, item)
      }
    }
    const remember = (info) => {
      if (!info?.id || info.parentID) return
      sessions.set(info.id, {
        id: info.id,
        title: info.title || `Session ${String(info.id).slice(0, 8)}`,
        directory: info.location?.directory || ctx.location.directory,
        status: "open",
        updatedAt: info.time?.updated || info.time?.created || Date.now(),
      })
    }
    const refreshSession = async (sessionID) => {
      try {
        remember(await ctx.session.get({ sessionID }))
      } catch {
        // A session can be deleted while the extension is open.
      }
    }
    const listClaims = () => {
      const cutoff = Date.now() - CLAIM_TTL_MS
      for (const [tabId, claim] of claims) {
        if (Date.parse(claim.lastSeenAt) < cutoff) claims.delete(tabId)
      }
      return [...claims.entries()].map(([tabId, claim]) => ({ tabId, ...claim })).sort((a, b) => a.tabId - b.tabId)
    }
    const status = () => ({
      app: APP_ID,
      version: `opencode-annotate-v2/${ctx.app.version}`,
      instanceId: `plugin:v2:${uid}:${port || "starting"}`,
      sessionId: `plugin:v2:${uid}:${port || "starting"}`,
      opencodeSessionId: activeSessionID || null,
      directory: ctx.location.directory,
      runtimeBaseDir: runtimeDir,
      annotationDir,
      logPath,
      server: { status: server ? "listening" : "starting", host: HOST, port: port || null },
      port: port || null,
      lastExtensionVersion: extensionVersion || null,
      claimTtlMs: CLAIM_TTL_MS,
      claims: listClaims(),
      lastAnnotation: lastAnnotation || null,
    })
    const submitAnnotation = async (sessionID, annotation) => {
      if (typeof sessionID !== "string" || !sessionID || sessionID.startsWith("plugin:v2:")) {
        throw new Error("Choose an OpenCode session before sending an annotation")
      }
      await refreshSession(sessionID)
      const text = annotationPrompt(annotation)
      const files = []
      if (annotation.screenshot?.dataUrl) {
        const { mime, bytes } = imageData(annotation.screenshot.dataUrl)
        const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png"
        const filename = `${Date.now()}-${filenamePart(annotation.page?.title || annotation.element?.tag)}.${ext}`
        const filePath = join(annotationDir, filename)
        await writeFile(filePath, bytes, { mode: 0o600 })
        files.push({ uri: pathToFileURL(filePath).href, name: filename })
      }
      lastAnnotation = { ok: null, sessionId: sessionID, phase: "received", time: new Date().toISOString() }
      await ctx.session.prompt({ sessionID, text: { text, files } })
      lastAnnotation = { ok: true, sessionId: sessionID, time: new Date().toISOString() }
    }

    const handle = async (req, res) => {
      const origin = extensionOrigin(req)
      if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true }, origin)
      try {
        const url = new URL(req.url || "/", `http://${HOST}:${port}`)
        if (req.method === "GET" && url.pathname === "/status") return sendJson(res, 200, status(), origin)
        if (req.method === "GET" && url.pathname === "/sessions") {
          if (activeSessionID) await refreshSession(activeSessionID)
          return sendJson(res, 200, { sessions: [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt) }, origin)
        }
        if (req.method === "POST" && url.pathname === "/claim") {
          const body = await readJson(req)
          if (!Number.isFinite(body.tabId) || typeof body.sessionId !== "string") throw new Error("tabId and sessionId are required")
          if (!sessions.has(body.sessionId)) await refreshSession(body.sessionId)
          if (!sessions.has(body.sessionId)) throw new Error("Session is not available in this OpenCode instance")
          extensionVersion = typeof body.extensionVersion === "string" ? body.extensionVersion : extensionVersion
          const prior = claims.get(Number(body.tabId))
          const now = new Date().toISOString()
          claims.set(Number(body.tabId), { sessionId: body.sessionId, claimedAt: prior?.claimedAt || now, lastSeenAt: now, extensionVersion })
          return sendJson(res, 200, { ok: true, sessionId: body.sessionId }, origin)
        }
        if (req.method === "POST" && url.pathname === "/unclaim") {
          const body = await readJson(req)
          if (!Number.isFinite(body.tabId)) throw new Error("tabId is required")
          claims.delete(Number(body.tabId))
          extensionVersion = typeof body.extensionVersion === "string" ? body.extensionVersion : extensionVersion
          return sendJson(res, 200, { ok: true }, origin)
        }
        if (req.method === "POST" && url.pathname === "/annotation") {
          const body = await readJson(req)
          if (!Number.isFinite(body.tabId) || !body.annotation || typeof body.annotation !== "object") throw new Error("tabId and annotation are required")
          const claim = claims.get(Number(body.tabId))
          const sessionID = typeof body.sessionId === "string" ? body.sessionId : claim?.sessionId
          if (!sessionID) throw new Error("Link this tab to an OpenCode session first")
          await submitAnnotation(sessionID, { ...body.annotation, tabId: Number(body.tabId) })
          const now = new Date().toISOString()
          claims.set(Number(body.tabId), { ...(claim || {}), sessionId: sessionID, claimedAt: claim?.claimedAt || now, lastSeenAt: now })
          return sendJson(res, 200, { ok: true, sessionId: sessionID }, origin)
        }
        if (req.method === "POST" && url.pathname === "/session/close") {
          return sendJson(res, 501, { ok: false, error: "V2 does not expose session deletion to plugins; close sessions in OpenCode" }, origin)
        }
        return sendJson(res, 404, { ok: false, error: "Not found" }, origin)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await log(`request failed: ${message}`)
        return sendJson(res, 400, { ok: false, error: message }, origin)
      }
    }

    await ctx.session.hook("prompt", async (event) => {
      activeSessionID = event.sessionID
      await refreshSession(event.sessionID)
      await persistSessions()
    })
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "chrome_status",
        description: "Report OpenCode Chrome Annotation server, session, tab claims, and last annotation status.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ content: JSON.stringify(status(), null, 2) }),
      })
    })

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "session.created") {
            const data = event.data
            remember({ id: data.sessionID, parentID: data.parentID, title: data.title, location: data.location, time: { created: event.created } })
            await persistSessions()
          } else if (event.type === "session.renamed") {
            const session = sessions.get(event.data.sessionID)
            if (session) session.title = event.data.title
            await persistSessions()
          } else if (event.type === "session.deleted") {
            sessions.delete(event.data.sessionID)
            for (const [tabId, claim] of claims) if (claim.sessionId === event.data.sessionID) claims.delete(tabId)
            if (activeSessionID === event.data.sessionID) activeSessionID = undefined
            await persistSessions()
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) await log(`event subscription failed: ${String(error)}`)
      }
    })()

    for (let candidate = PORT_START; candidate <= PORT_END; candidate++) {
      const candidateServer = createServer(handle)
      const listening = await new Promise((resolve) => {
        candidateServer.once("error", () => resolve(false))
        candidateServer.listen(candidate, HOST, () => resolve(true))
      })
      if (!listening) continue
      server = candidateServer
      port = candidate
      break
    }
    if (!server) throw new Error(`Could not bind Chrome annotation server on ${HOST}:${PORT_START}-${PORT_END}`)
    await log(`V2 annotation server listening on ${HOST}:${port}`)

    return async () => {
      controller.abort()
      await new Promise((resolve) => server.close(resolve))
    }
  },
})
