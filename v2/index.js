import { randomUUID } from "node:crypto"
import { appendFile, chmod, lstat, mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises"
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
const MAX_SESSIONS = 200
const SCREENSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const CLOSE_GRACE_MS = 2000
const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }

function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}

// The protocol types name this error SessionNotFoundError, but OpenCode 2.0.27
// throws it from the in-process session API as "Session.NotFoundError".
function isSessionNotFound(error) {
  return error?._tag === "SessionNotFoundError" || error?._tag === "Session.NotFoundError"
}

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

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    const finish = (settle, value) => {
      req.off("data", onData)
      req.off("end", onEnd)
      req.off("error", onError)
      settle(value)
    }
    const onData = (chunk) => {
      size += chunk.byteLength
      if (size > BODY_LIMIT) {
        chunks.length = 0
        finish(reject, httpError(413, "Request body too large"))
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => {
      const text = Buffer.concat(chunks).toString("utf8")
      try {
        finish(resolve, text ? JSON.parse(text) : {})
      } catch {
        finish(reject, new Error("Invalid JSON body"))
      }
    }
    const onError = (error) => finish(reject, error)
    req.on("data", onData)
    req.on("end", onEnd)
    req.on("error", onError)
  })
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
  const mime = (match[1] || "").toLowerCase()
  if (!Object.hasOwn(IMAGE_TYPES, mime)) throw new Error("Annotation screenshot must be a PNG, JPEG or WebP image")
  return { mime, bytes: Buffer.from(match[2], "base64") }
}

function isTabId(value) {
  return Number.isInteger(value) && value >= 0
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

export default {
  id: "opencode.chrome-annotation-v2",
  async setup(ctx) {
    const uid = typeof process.getuid === "function" ? process.getuid() : "user"
    const runtimeDir = join(process.env.XDG_RUNTIME_DIR || tmpdir(), `opencode-chrome-annotation-v2-${uid}`)
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
    const runtimeStat = await lstat(runtimeDir)
    if (runtimeStat.isSymbolicLink() || !runtimeStat.isDirectory()) throw new Error(`Unsafe runtime directory: ${runtimeDir}`)
    if (typeof process.getuid === "function" && runtimeStat.uid !== process.getuid()) {
      throw new Error(`Runtime directory is not owned by the current user: ${runtimeDir}`)
    }
    await chmod(runtimeDir, 0o700)
    await chmod(annotationDir, 0o700).catch(() => {})
    const log = async (message) => appendFile(logPath, `[${new Date().toISOString()}] ${message}\n`).catch(() => {})
    const trimSessions = () => {
      if (sessions.size <= MAX_SESSIONS) return
      const keep = new Set([...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS).map((item) => item.id))
      for (const id of sessions.keys()) if (!keep.has(id)) sessions.delete(id)
    }
    const persistSessions = () => {
      trimSessions()
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
      trimSessions()
    }
    const pruneScreenshots = async () => {
      const cutoff = Date.now() - SCREENSHOT_MAX_AGE_MS
      for (const name of await readdir(annotationDir)) {
        const filePath = join(annotationDir, name)
        const info = await stat(filePath)
        if (info.isFile() && info.mtimeMs < cutoff) await unlink(filePath)
      }
    }
    void pruneScreenshots().catch(() => {})
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
    const forget = (sessionID) => {
      const existed = sessions.delete(sessionID)
      for (const [tabId, claim] of claims) if (claim.sessionId === sessionID) claims.delete(tabId)
      if (activeSessionID === sessionID) activeSessionID = undefined
      return existed
    }
    const refreshSession = async (sessionID) => {
      try {
        const info = await ctx.session.get({ sessionID })
        remember(info)
        return info
      } catch (error) {
        // Only a missing session is dropped; transient errors keep the cache.
        if (isSessionNotFound(error) && forget(sessionID)) await persistSessions()
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
        const filename = `${Date.now()}-${randomUUID().slice(0, 8)}-${filenamePart(annotation.page?.title || annotation.element?.tag)}.${IMAGE_TYPES[mime]}`
        const filePath = join(annotationDir, filename)
        await writeFile(filePath, bytes, { mode: 0o600 })
        files.push({ uri: pathToFileURL(filePath).href, name: filename })
      }
      lastAnnotation = { ok: null, sessionId: sessionID, phase: "received", time: new Date().toISOString() }
      await ctx.session.prompt({ sessionID, text, files, delivery: "queue" })
      lastAnnotation = { ok: true, sessionId: sessionID, time: new Date().toISOString() }
    }

    const handle = async (req, res) => {
      const origin = extensionOrigin(req)
      if (req.headers.origin !== undefined && !origin) {
        req.resume()
        return sendJson(res, 403, { ok: false, error: "Forbidden origin" })
      }
      const host = String(req.headers.host || "").toLowerCase()
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        req.resume()
        return sendJson(res, 403, { ok: false, error: "Forbidden host" })
      }
      if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true }, origin)
      if (req.method === "POST" && !/^application\/json/i.test(String(req.headers["content-type"] || ""))) {
        req.resume()
        return sendJson(res, 415, { ok: false, error: "Content-Type must be application/json" }, origin)
      }
      try {
        const url = new URL(req.url || "/", `http://${HOST}:${port}`)
        if (req.method === "GET" && url.pathname === "/status") return sendJson(res, 200, status(), origin)
        if (req.method === "GET" && url.pathname === "/sessions") {
          if (activeSessionID) await refreshSession(activeSessionID)
          return sendJson(res, 200, { sessions: [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt) }, origin)
        }
        if (req.method === "POST" && url.pathname === "/claim") {
          const body = await readJson(req)
          if (!isTabId(body.tabId) || typeof body.sessionId !== "string") throw new Error("tabId and sessionId are required")
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
          if (!isTabId(body.tabId)) throw new Error("tabId is required")
          claims.delete(Number(body.tabId))
          extensionVersion = typeof body.extensionVersion === "string" ? body.extensionVersion : extensionVersion
          return sendJson(res, 200, { ok: true }, origin)
        }
        if (req.method === "POST" && url.pathname === "/annotation") {
          const body = await readJson(req)
          if (!isTabId(body.tabId) || !body.annotation || typeof body.annotation !== "object") throw new Error("tabId and annotation are required")
          const claim = claims.get(Number(body.tabId))
          const sessionID = typeof body.sessionId === "string" ? body.sessionId : claim?.sessionId
          if (!sessionID) throw new Error("Link this tab to an OpenCode session first")
          await submitAnnotation(sessionID, { ...body.annotation, tabId: Number(body.tabId) })
          const now = new Date().toISOString()
          claims.set(Number(body.tabId), { ...(claim || {}), sessionId: sessionID, claimedAt: claim?.claimedAt || now, lastSeenAt: now })
          return sendJson(res, 200, { ok: true, sessionId: sessionID }, origin)
        }
        if (req.method === "POST" && url.pathname === "/session/close") {
          const body = await readJson(req)
          const sessionID = body.sessionId
          if (typeof sessionID !== "string" || !sessionID || sessionID.startsWith("plugin:v2:")) throw new Error("sessionId is required")
          if (typeof ctx.session.remove !== "function") {
            return sendJson(res, 501, { ok: false, error: "This OpenCode version does not let plugins close sessions; close it in OpenCode" }, origin)
          }
          try {
            await ctx.session.remove({ sessionID })
          } catch (error) {
            // Already deleted elsewhere counts as closed.
            if (!isSessionNotFound(error)) throw error
          }
          forget(sessionID)
          await persistSessions()
          return sendJson(res, 200, { ok: true, sessionId: sessionID }, origin)
        }
        return sendJson(res, 404, { ok: false, error: "Not found" }, origin)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await log(`request failed: ${message}`)
        const status = error?.status || 400
        if (status === 413) {
          res.setHeader("Connection", "close")
          req.resume()
        }
        return sendJson(res, status, { ok: false, error: message }, origin)
      }
    }

    await ctx.session.hook("prompt", async (event) => {
      const sessionID = event.sessionID
      const previous = activeSessionID
      activeSessionID = sessionID
      refreshSession(sessionID)
        .then((info) => {
          if (info?.parentID && activeSessionID === sessionID) activeSessionID = previous
          return persistSessions()
        })
        .catch((error) => log(`prompt hook refresh failed: ${String(error)}`))
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
            if (data.location?.directory && data.location.directory !== ctx.location.directory) continue
            remember({ id: data.sessionID, parentID: data.parentID, title: data.title, location: data.location, time: { created: event.created } })
            await persistSessions()
          } else if (event.type === "session.renamed") {
            const session = sessions.get(event.data.sessionID)
            if (session) session.title = event.data.title
            await persistSessions()
          } else if (event.type === "session.deleted") {
            forget(event.data.sessionID)
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
        const onError = () => resolve(false)
        candidateServer.once("error", onError)
        candidateServer.listen(candidate, HOST, () => {
          candidateServer.off("error", onError)
          resolve(true)
        })
      })
      if (!listening) continue
      server = candidateServer
      port = candidate
      break
    }
    if (!server) throw new Error(`Could not bind Chrome annotation server on ${HOST}:${PORT_START}-${PORT_END}`)
    server.on("error", (error) => void log(`server error: ${String(error)}`))
    await log(`V2 annotation server listening on ${HOST}:${port}`)

    let closing
    return () => {
      closing ??= (async () => {
        controller.abort()
        await new Promise((resolve) => {
          const timer = setTimeout(() => server.closeAllConnections(), CLOSE_GRACE_MS)
          server.close(() => {
            clearTimeout(timer)
            resolve()
          })
        })
        await sessionWrite
      })()
      return closing
    }
  },
}
