// Spawns claude-bridge.mjs against a fake Claude Code registry and a fake
// session socket, then checks the request guards and the two-frame delivery.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { request } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnop";
const SESSION_ID = "test-session-1";

let home;
let socketServer;
let frames = [];
let bridge;
let port;

function startBridge() {
  const child = spawn(process.execPath, [join(import.meta.dirname, "claude-bridge.mjs")], {
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "" },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  const listening = new Promise((resolve, reject) => {
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = stderr.match(/listening on 127\.0\.0\.1:(\d+)/);
      if (match)
        resolve(Number(match[1]));
    });
    child.on("exit", (code) => reject(Object.assign(new Error(`bridge exited ${code}: ${stderr}`), { code, stderr })));
  });
  return { child, listening };
}

function call(path, { method = "GET", origin = EXTENSION_ORIGIN, host, body, contentType = "application/json" } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host: host || `127.0.0.1:${port}` };
    if (origin)
      headers.origin = origin;
    if (body !== undefined)
      headers["content-type"] = contentType;
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data), allowOrigin: res.headers["access-control-allow-origin"] }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

before(async () => {
  // Unix socket paths are capped near 104 bytes, so keep this under /tmp-ish roots.
  home = mkdtempSync(join(tmpdir(), "cb-"));
  const sessionsDir = join(home, ".claude", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const socketPath = join(home, "s.sock");
  socketServer = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
    });
    socket.on("end", () => {
      frames = buffer.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    });
  });
  await new Promise((resolve) => socketServer.listen(socketPath, resolve));
  // The bridge only lists live pids; this test process stands in for Claude.
  writeFileSync(join(sessionsDir, `${process.pid}.json`), JSON.stringify({
    pid: process.pid,
    sessionId: SESSION_ID,
    name: "Fix the pricing card",
    cwd: "/work/site",
    updatedAt: 1700000000000,
    status: "idle",
    messagingSocketPath: socketPath
  }));
  writeFileSync(join(sessionsDir, `${process.pid}.abc123.key`), JSON.stringify({ peerToken: "peer-token" }));
  bridge = startBridge();
  port = await bridge.listening;
});

after(() => {
  bridge?.child.kill();
  socketServer?.close();
  rmSync(home, { recursive: true, force: true });
});

test("status identifies the bridge", async () => {
  const { status, body } = await call("/status", { origin: null });
  assert.equal(status, 200);
  assert.equal(body.app, "opencode-chrome-annotation");
  assert.equal(body.agent, "claude-code");
});

test("lists live sessions for the extension", async () => {
  const { status, body, allowOrigin } = await call("/sessions");
  assert.equal(status, 200);
  assert.equal(allowOrigin, EXTENSION_ORIGIN);
  assert.deepEqual(body.sessions.map((item) => [item.id, item.title, item.directory, item.agent]), [
    [SESSION_ID, "Fix the pricing card", "/work/site", "claude-code"]
  ]);
});

test("rejects web page origins", async () => {
  const { status } = await call("/sessions", { origin: "https://evil.example" });
  assert.equal(status, 403);
});

test("rejects non-loopback Host headers", async () => {
  const { status } = await call("/sessions", { host: `evil.example:${port}` });
  assert.equal(status, 403);
});

test("rejects non-JSON posts", async () => {
  const { status } = await call("/annotation", { method: "POST", body: {}, contentType: "text/plain" });
  assert.equal(status, 415);
});

test("refuses to close Claude chats", async () => {
  const { status, body } = await call("/session/close", { method: "POST", body: { sessionId: SESSION_ID } });
  assert.equal(status, 501);
  assert.equal(body.ok, false);
});

test("claim fails for a chat that is not running", async () => {
  const { status, body } = await call("/claim", { method: "POST", body: { tabId: 1, sessionId: "gone" } });
  assert.equal(status, 400);
  assert.match(body.error, /no longer active/);
});

test("delivers an annotation as auth + user frames", async () => {
  frames = [];
  const { status, body } = await call("/annotation", {
    method: "POST",
    body: {
      tabId: 7,
      sessionId: SESSION_ID,
      annotation: { comment: "Keep the CTA still", page: { title: "Pricing", url: "https://example.com" }, element: { selector: "#cta", tag: "button" } }
    }
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  for (let i = 0; i < 50 && !frames.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(frames[0], { type: "auth", token: "peer-token" });
  assert.equal(frames[1].type, "user");
  assert.match(frames[1].message.content, /^Browser annotation from Chrome/);
  assert.match(frames[1].message.content, /Keep the CTA still/);
  assert.match(frames[1].message.content, /Selector: #cta/);
});

test("a second bridge for the same registry exits instead of double-listing", async () => {
  const second = startBridge();
  const outcome = await second.listening.then(() => ({ code: "listening" }), (error) => error);
  second.child.kill();
  assert.equal(outcome.code, 0);
  assert.match(outcome.stderr, /already running/);
});
