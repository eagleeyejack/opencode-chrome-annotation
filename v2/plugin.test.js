import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import plugin from "./index.js"

function makeContext(storageData = {}) {
  const hooks = new Map()
  const tools = new Map()
  const prompts = []
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
      get: async ({ sessionID }) => ({
        id: sessionID,
        title: `Session ${sessionID}`,
        location: { directory: ctx.location.directory },
        time: { created: Date.now(), updated: Date.now() },
      }),
      prompt: async (input) => { prompts.push(input); return { id: "inbox-1", sessionID: input.sessionID } },
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
          next: () => signal.aborted
            ? Promise.resolve({ done: true })
            : new Promise((resolve) => signal.addEventListener("abort", () => resolve({ done: true }), { once: true })),
        }),
      }),
    },
  }
  return { ctx, hooks, tools, prompts, sessionID }
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

    const annotationResponse = await fetch(`http://127.0.0.1:${status.port}/annotation`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://untrusted.example" },
      body: JSON.stringify({
        tabId: 11,
        annotation: {
          comment: "Fix this button",
          page: { title: "Test page", url: "https://example.test" },
          element: { selector: "#save", tag: "button", rect: {} },
          viewport: {},
          screenshot: { dataUrl: "data:image/png;base64,aGVsbG8=" },
        },
      }),
    })
    assert.equal(annotationResponse.status, 200)
    assert.equal(annotationResponse.headers.get("access-control-allow-origin"), null)
    assert.equal(first.prompts.length, 1)
    assert.equal(first.prompts[0].sessionID, first.sessionID)
    assert.match(first.prompts[0].text.text, /Fix this button/)
    assert.equal(first.prompts[0].text.files.length, 1)
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

test("V2 adapter does not delete sessions from browser requests", async (t) => {
  await withRuntime(t, async () => {
    const { ctx, tools, sessionID } = makeContext()
    const cleanup = await plugin.setup(ctx)
    try {
      const status = JSON.parse((await tools.get("chrome_status").execute({}, {})).content)
      const response = await fetch(`http://127.0.0.1:${status.port}/session/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sessionID }),
      })
      assert.equal(response.status, 501)
      assert.match((await response.json()).error, /V2 does not expose session deletion/)
    } finally {
      await cleanup()
    }
  })
})
