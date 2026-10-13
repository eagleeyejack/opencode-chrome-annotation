import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { readFileSync } from "node:fs"
import * as v1Entry from "./dist/plugin.js"
import * as serverEntry from "./server.js"
import v2 from "./v2/index.js"

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))

test("package exposes the v1 function at . and the hybrid object at ./server", () => {
  assert.equal(pkg.main, "./dist/plugin.js")
  assert.deepEqual(pkg.exports, { ".": "./dist/plugin.js", "./server": "./server.js" })
  for (const file of ["dist/plugin.js", "server.js", "v2/index.js"]) assert.ok(pkg.files.includes(file), file)
})

test("the . entry exports exactly one thing, the v1 plugin function", () => {
  assert.deepEqual(Object.keys(v1Entry), ["default"])
  assert.equal(typeof v1Entry.default, "function")
})

test("the ./server entry is a plain object OpenCode 2 and recent OpenCode 1 both accept", () => {
  assert.deepEqual(Object.keys(serverEntry), ["default"])
  const plugin = serverEntry.default
  assert.equal(typeof plugin, "object")
  assert.equal(plugin.id, "opencode.chrome-annotation-v2")
  assert.equal(plugin.id, v2.id)
  assert.equal(typeof plugin.setup, "function")
  assert.equal(plugin.setup, v2.setup)
  assert.equal(plugin.server, v1Entry.default)
  assert.equal("effect" in plugin, false)
})

test("importing either entry has no filesystem or network side effects", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-annotate-import-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const file of ["./dist/plugin.js", "./server.js", "./v2/index.js"]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(new URL(file, import.meta.url).href)})`], {
      env: { ...process.env, XDG_RUNTIME_DIR: dir, TMPDIR: dir },
      encoding: "utf8",
      timeout: 15000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(await readdir(dir), [], file)
  }
})
