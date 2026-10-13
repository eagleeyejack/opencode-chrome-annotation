import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { request as httpRequest } from "node:http"
import { createServer } from "node:net"
import test from "node:test"
import plugin from "./index.js"

function makeContext(storageData = {}) {
  const missing = new Set()
  const queue = []
  let wake
  const hooks = new Map()
  const tools = new Map()
  const prompts = []
  const removed = []
  const sessionID = "ses-v2-annotation-test"
  const ctx = {
    app: { version: "2.0.16" },
    location: { directory: "/tmp/opencode-v2-test", project: { id: "test" } },
    options: {},
    storage: {
      get: async (key) => storageData[key],
      set: async (key, value) => { storageData[key] = structuredClone(value) },
      remove: async (key) => { delete storageData[key] },
      scan: async () => ({ entries: [] }),
    },
    session: {
      hook: async (name, callback) => { hooks.set(name, callback); return { dispose: async () => {} } },
      get: async ({ sessionID }) => {
        if (missing.has(sessionID)) throw { _tag: "SessionNotFoundError", sessionID, message: "Session not found" }
        return {
        id: sessionID,
        title: `Session ${sessionID}`,
        location: { directory: ctx.location.directory },
        time: { created: Date.now(), updated: Date.now() },
        }
      },
      prompt: async (input) => { prompts.push(input); return { id: "inbox-1", sessionID: input.sessionID } },
      remove: async (input) => {
        removed.push(input)
        if (missing.has(input.sessionID)) throw { _tag: "SessionNotFoundError", sessionID: input.sessionID, message: "Session not found" }
      },
    },
    tool: {
      transform: async (callback) => {
        callback({ add: (definition) => tools.set(definition.name, definition) })
        return { dispose: async () => {} }
      },
    },
    event: {
      subscribe: ({ signal }) => ({
        [Symbol.asyncIterator]: () => ({
          next: () => {
            if (signal.aborted) return Promise.resolve({ done: true })
            if (queue.length) return Promise.resolve({ done: false, value: queue.shift() })
            return new Promise((resolve) => {
              wake = () => resolve({ done: signal.aborted, value: queue.shift() })
              signal.addEventListener("abort", () => resolve({ done: true }), { once: true })
            })
          },
        }),
      }),
    },
  }
  const emit = (event) => {
    queue.push(event)
    const fn = wake
    wake = undefined
    fn?.()
  }
  return { ctx, hooks, tools, prompts, removed, sessionID, missing, emit }
}

async function withRuntime(t, run) {
  const runtime = await mkdtemp(join(tmpdir(), "opencode-annotate-v2-test-"))
  const previousRuntime = process.env.XDG_RUNTIME_DIR
  process.env.XDG_RUNTIME_DIR = runtime
  t.after(async () => {
    if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR
    else process.env.XDG_RUNTIME_DIR = previousRuntime
    await rm(runtime, { recursive: true, force: true })
  })
  await run()
}

test("V2 adapter serves sessions, submits screenshots, and restores its session cache", async (t) => {
  await withRuntime(t, async () => {
    const storage = {}
    const first = makeContext(storage)
    const firstCleanup = await plugin.setup(first.ctx)
    await first.hooks.get("prompt")({ sessionID: first.sessionID, prompt: { text: "start" } })
    const status = JSON.parse((await first.tools.get("chrome_status").execute({}, {})).content)
    assert.equal(status.app, "opencode-chrome-annotation")
    assert.ok(status.port)

    const sessionsResponse = await fetch(`http://127.0.0.1:${status.port}/sessions`)
    assert.equal(sessionsResponse.status, 200)
    assert.equal((await sessionsResponse.json()).sessions[0].id, first.sessionID)

    const claimResponse = await fetch(`http://127.0.0.1:${status.port}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tabId: 11, sessionId: first.sessionID, extensionVersion: "test" }),
    })
    assert.equal(claimResponse.status, 200)

    const annotationBody = JSON.stringify({
      tabId: 11,
      annotation: {
        comment: "Fix this button",
        page: { title: "Test page", url: "https://example.test" },
        element: { selector: "#save", tag: "button", rect: {} },
        viewport: {},
        screenshot: { dataUrl: "data:image/png;base64,aGVsbG8=" },
      },
    })
    const untrusted = await fetch(`http://127.0.0.1:${status.port}/annotation`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://untrusted.example" },
      body: annotationBody,
    })
    assert.equal(untrusted.status, 403)
    assert.equal(untrusted.headers.get("access-control-allow-origin"), null)
    assert.equal(first.prompts.length, 0)

    const extensionOrigin = "chrome-extension://abcdefghijklmnop"
    const annotationResponse = await fetch(`http://127.0.0.1:${status.port}/annotation`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: extensionOrigin },
      body: annotationBody,
    })
    assert.equal(annotationResponse.status, 200)
    assert.equal(annotationResponse.headers.get("access-control-allow-origin"), extensionOrigin)
    assert.equal(first.prompts.length, 1)
    assert.equal(first.prompts[0].sessionID, first.sessionID)
    assert.match(first.prompts[0].text, /Fix this button/)
    assert.equal(first.prompts[0].files.length, 1)
    assert.equal(first.prompts[0].delivery, "queue")
    assert.equal("prompt" in first.prompts[0], false)

    const { ClientApi } = await import("@opencode/protocol/client")
    const { Schema } = await import("effect")
    const ep = ClientApi.groups["server.session"].endpoints["session.prompt"]
    for (const s of [ep.params, ...[...ep.payload.values()].flatMap((p) => p.schemas)].filter(Boolean)) {
      Schema.decodeUnknownSync(s)(first.prompts[0])
    }
    await firstCleanup()

    const second = makeContext(storage)
    const secondCleanup = await plugin.setup(second.ctx)
    try {
      const restored = JSON.parse((await second.tools.get("chrome_status").execute({}, {})).content)
      const restoredSessions = await fetch(`http://127.0.0.1:${restored.port}/sessions`).then((r) => r.json())
      assert.equal(restoredSessions.sessions[0].id, second.sessionID)
    } finally {
      await secondCleanup()
    }
  })
})

test("V2 adapter closes sessions through ctx.session.remove", async (t) => {
  await withRuntime(t, async () => {
    const storage = {}
    const { ctx, hooks, tools, removed, sessionID } = makeContext(storage)
    const cleanup = await plugin.setup(ctx)
    try {
      await hooks.get("prompt")({ sessionID, prompt: { text: "start" } })
      const status = JSON.parse((await tools.get("chrome_status").execute({}, {})).content)
      const base = `http://127.0.0.1:${status.port}`
      const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      assert.equal((await fetch(`${base}/sessions`).then((r) => r.json())).sessions[0].id, sessionID)
      assert.equal((await post("/claim", { tabId: 3, sessionId: sessionID })).status, 200)

      const response = await post("/session/close", { sessionId: sessionID })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { ok: true, sessionId: sessionID })
      assert.deepEqual(removed, [{ sessionID }])

      assert.deepEqual((await fetch(`${base}/sessions`).then((r) => r.json())).sessions, [])
      const after = JSON.parse((await tools.get("chrome_status").execute({}, {})).content)
      assert.deepEqual(after.claims, [])
      assert.equal(after.opencodeSessionId, null)
      assert.deepEqual(storage.sessions, [])
    } finally {
      await cleanup()
    }
  })
})

test("V2 adapter treats an already-deleted session as closed", async (t) => {
  await withRuntime(t, async () => {
    const { ctx, hooks, tools, removed, missing, sessionID } = makeContext()
    const cleanup = await plugin.setup(ctx)
    try {
      await hooks.get("prompt")({ sessionID, prompt: { text: "start" } })
      const status = JSON.parse((await tools.get("chrome_status").execute({}, {})).content)
      const base = `http://127.0.0.1:${status.port}`
      await fetch(`${base}/sessions`)
      missing.add(sessionID)
      for (const tag of ["SessionNotFoundError", "Session.NotFoundError"]) {
        // OpenCode 2.0.27 throws the dotted tag; the protocol types use the undotted one.
        ctx.session.remove = async (input) => {
          removed.push(input)
          throw { _tag: tag, sessionID: input.sessionID }
        }
        const response = await fetch(`${base}/session/close`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sessionID }) })
        assert.equal(response.status, 200, tag)
        assert.deepEqual(await response.json(), { ok: true, sessionId: sessionID })
      }
      assert.equal(removed.length, 2)
    } finally {
      await cleanup()
    }
  })
})

test("V2 adapter validates the close request and surfaces remove failures", async (t) => {
  await withRuntime(t, async () => {
    const { ctx, tools, removed } = makeContext()
    ctx.session.remove = async (input) => { removed.push(input); throw new Error("database is locked") }
    const cleanup = await plugin.setup(ctx)
    try {
      const status = JSON.parse((await tools.get("chrome_status").execute({}, {})).content)
      const post = (body) => fetch(`http://127.0.0.1:${status.port}/session/close`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      assert.equal((await post({})).status, 400)
      assert.equal((await post({ sessionId: 5 })).status, 400)
      assert.equal((await post({ sessionId: `plugin:v2:1:${status.port}` })).status, 400)
      assert.equal(removed.length, 0)
      const failed = await post({ sessionId: "ses-x" })
      assert.equal(failed.status, 400)
      assert.match((await failed.json()).error, /database is locked/)
    } finally {
      await cleanup()
    }
  })
})

test("V2 adapter keeps returning 501 when the host cannot remove sessions", async (t) => {
  await withRuntime(t, async () => {
    const { ctx, tools, sessionID } = makeContext()
    delete ctx.session.remove
    const cleanup = await plugin.setup(ctx)
    try {
      const status = JSON.parse((await tools.get("chrome_status").execute({}, {})).content)
      const response = await fetch(`http://127.0.0.1:${status.port}/session/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sessionID }),
      })
      assert.equal(response.status, 501)
      assert.equal((await response.json()).ok, false)
    } finally {
      await cleanup()
    }
  })
})

async function boot(t) {
  const made = makeContext()
  const cleanup = await plugin.setup(made.ctx)
  t.after(() => cleanup())
  const status = JSON.parse((await made.tools.get("chrome_status").execute({}, {})).content)
  return { ...made, cleanup, port: status.port, base: `http://127.0.0.1:${status.port}` }
}

const jsonPost = (url, body, headers = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) })

test("V2 adapter rejects bad content types, hosts and bodies", async (t) => {
  await withRuntime(t, async () => {
    const { base, port } = await boot(t)

    const plain = await fetch(`${base}/claim`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })
    assert.equal(plain.status, 415)

    const hostStatus = await new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/status", headers: { host: "evil.example" } }, (res) => {
        res.resume()
        res.on("end", () => resolve(res.statusCode))
      })
      req.on("error", reject)
      req.end()
    })
    assert.equal(hostStatus, 403)

    const preflight = await fetch(`${base}/claim`, { method: "OPTIONS", headers: { origin: "chrome-extension://abc" } })
    assert.equal(preflight.status, 200)

    const bad = await jsonPost(`${base}/claim`, "{nope")
    assert.equal(bad.status, 400)

    const big = await jsonPost(`${base}/claim`, JSON.stringify({ pad: "x".repeat(10 * 1024 * 1024 + 10) }))
    assert.equal(big.status, 413)

    const after = await fetch(`${base}/status`)
    assert.equal(after.status, 200)
  })
})

test("V2 adapter rejects non-image screenshots", async (t) => {
  await withRuntime(t, async () => {
    const { base, prompts, sessionID } = await boot(t)
    await jsonPost(`${base}/claim`, { tabId: 1, sessionId: sessionID })
    const response = await jsonPost(`${base}/annotation`, {
      tabId: 1,
      annotation: { comment: "x", screenshot: { dataUrl: "data:text/html;base64,PGI+aGk8L2I+" } },
    })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /PNG, JPEG or WebP/)
    assert.equal(prompts.length, 0)
  })
})

test("V2 adapter removes a session that no longer exists", async (t) => {
  await withRuntime(t, async () => {
    const { base, hooks, missing, sessionID } = await boot(t)
    await hooks.get("prompt")({ sessionID })
    assert.equal((await fetch(`${base}/sessions`).then((r) => r.json())).sessions.length, 1)
    assert.equal((await jsonPost(`${base}/claim`, { tabId: 2, sessionId: sessionID })).status, 200)
    missing.add(sessionID)
    const sessions = await fetch(`${base}/sessions`).then((r) => r.json())
    assert.equal(sessions.sessions.length, 0)
    const claim = await jsonPost(`${base}/claim`, { tabId: 3, sessionId: sessionID })
    assert.equal(claim.status, 400)
    const status = await fetch(`${base}/status`).then((r) => r.json())
    assert.equal(status.claims.length, 0)
  })
})

test("V2 adapter clears claims when a session is deleted", async (t) => {
  await withRuntime(t, async () => {
    const { base, emit, sessionID } = await boot(t)
    assert.equal((await jsonPost(`${base}/claim`, { tabId: 4, sessionId: sessionID })).status, 200)
    assert.equal((await fetch(`${base}/status`).then((r) => r.json())).claims.length, 1)
    emit({ type: "session.deleted", data: { sessionID } })
    for (let i = 0; i < 50; i++) {
      const status = await fetch(`${base}/status`).then((r) => r.json())
      if (status.claims.length === 0) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.fail("claims were not cleared")
  })
})

test("V2 adapter frees its port on cleanup", async (t) => {
  await withRuntime(t, async () => {
    const { ctx, tools } = makeContext()
    const cleanup = await plugin.setup(ctx)
    const status = JSON.parse((await tools.get("chrome_status").execute({}, {})).content)
    await cleanup()
    await cleanup()
    await new Promise((resolve, reject) => {
      const probe = createServer()
      probe.once("error", reject)
      probe.listen(status.port, "127.0.0.1", () => probe.close(resolve))
    })
  })
})
