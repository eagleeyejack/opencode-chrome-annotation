#!/usr/bin/env node
// claude-bridge.mjs - exposes active Claude Code sessions to the
// opencode-annotate Chrome extension, speaking the same HTTP contract as the
// OpenCode plugin (see v2/index.js).
//
//   npx opencode-annotate@latest claude-bridge --install    start at login (macOS)
//   npx opencode-annotate@latest claude-bridge --uninstall  remove it again
//   npx opencode-annotate@latest claude-bridge              run in the foreground
//
// From a checkout, `node claude-bridge.mjs [--install | --uninstall]` does the same.
//
// The extension discovers every server on 127.0.0.1:39240-39260 answering
// /status with app "opencode-chrome-annotation", so Claude sessions appear in
// the same side-panel picker as OpenCode ones.
//
// Sessions come from Claude Code's own registry (<config>/sessions/<pid>.json)
// filtered to live processes, so only active chats are listed. Delivery uses
// Claude Code's cross-session inbox socket: authenticate with the peer token
// stored next to the registry file, then post the annotation as a user message
// (same prompt text the OpenCode plugin composes).
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ID = "opencode-chrome-annotation";
const AGENT = "claude-code";
const APP_VERSION = "claude-bridge/0.2.0";
const PORT_START = 39240;
const PORT_END = 39260;
const HOST = "127.0.0.1";
const BODY_LIMIT = 10 * 1024 * 1024;
const SCREENSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const LAUNCH_LABEL = "com.opencode-annotate.claude-bridge";

// Claude Code honours CLAUDE_CONFIG_DIR, so the registry lives wherever it does.
const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const sessionsDir = join(claudeDir, "sessions");
const annotationDir = join(tmpdir(), "claude-code-bridge", "annotations");
const log = (...args) => console.error("[claude-bridge]", ...args);

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function readRegistry() {
  let files;
  try {
    files = readdirSync(sessionsDir);
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    if (!file.endsWith(".json"))
      continue;
    let entry;
    try {
      entry = JSON.parse(readFileSync(join(sessionsDir, file), "utf-8"));
    } catch {
      continue;
    }
    // Bare-mode sessions never bind a socket, so they can't receive messages.
    if (!entry?.sessionId || !entry?.messagingSocketPath || !entry?.pid)
      continue;
    try {
      process.kill(entry.pid, 0); // throws ESRCH once the process is gone
    } catch {
      continue;
    }
    out.push(entry);
  }
  return out;
}

function findRegistryEntry(sessionId) {
  return readRegistry().find((entry) => entry.sessionId === sessionId) || null;
}

function readPeerToken(pid) {
  const file = readdirSync(sessionsDir).find((name) => name.startsWith(`${pid}.`) && name.endsWith(".key"));
  if (!file)
    return null;
  try {
    return JSON.parse(readFileSync(join(sessionsDir, file), "utf-8"))?.peerToken || null;
  } catch {
    return null;
  }
}

function listSessions() {
  return readRegistry()
    .map((entry) => ({
      id: entry.sessionId,
      title: entry.name || entry.sessionId,
      directory: entry.cwd || "",
      updatedAt: Number(entry.updatedAt) || Number(entry.startedAt) || 0,
      status: entry.status || "idle",
      agent: AGENT
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// Mirrors buildAnnotationPrompt in src/plugin.ts so Claude receives the same
// payload shape OpenCode sessions get.
function buildAnnotationPrompt(annotation) {
  const comment = typeof annotation?.comment === "string" ? annotation.comment.trim() : "";
  const page = annotation?.page || {};
  const element = annotation?.element || {};
  const rect = element?.rect || {};
  const viewport = annotation?.viewport || {};
  return [
    "Browser annotation from Chrome",
    "",
    "User comment:",
    comment || "(no comment provided)",
    "",
    "Page:",
    `Title: ${page.title || ""}`,
    `URL: ${page.url || ""}`,
    typeof annotation?.tabId === "number" ? `Tab ID: ${annotation.tabId}` : "Tab ID: ",
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
    "Please inspect the screenshot and selected element metadata, then make the appropriate code change."
  ].join("\n");
}

function fileStem(value) {
  return String(value || "annotation")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "annotation";
}

function pruneScreenshots() {
  const cutoff = Date.now() - SCREENSHOT_MAX_AGE_MS;
  let files;
  try {
    files = readdirSync(annotationDir);
  } catch {
    return;
  }
  for (const file of files) {
    const path = join(annotationDir, file);
    try {
      if (statSync(path).mtimeMs < cutoff)
        rmSync(path);
    } catch {}
  }
}

function saveScreenshot(annotation) {
  const match = String(annotation.screenshot.dataUrl).match(/^data:([^;,]+);base64,(.+)$/);
  const ext = IMAGE_TYPES[match?.[1]];
  if (!ext)
    throw new Error("Screenshot must be a base64 PNG, JPEG or WebP data URL");
  mkdirSync(annotationDir, { recursive: true, mode: 0o700 });
  pruneScreenshots();
  const stem = fileStem(annotation.page?.title || annotation.element?.tag);
  const path = join(annotationDir, `${Date.now()}-${randomUUID().slice(0, 8)}-${stem}.${ext}`);
  writeFileSync(path, Buffer.from(match[2], "base64"), { mode: 0o600 });
  return path;
}

// Claude Code cross-session inbox protocol: newline-delimited JSON over the
// session's Unix socket. Line 1 authenticates with the session's peer token,
// line 2 delivers the message as a user turn. The wire is silent on success -
// there is no ack - so completing both writes is the success signal.
function deliverToSession(socketPath, token, text) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (error) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error)
        reject(error);
      else
        resolve();
    };
    const timer = setTimeout(() => finish(new Error("Timed out writing to the Claude session socket")), 10000);
    socket.on("connect", () => {
      socket.write(JSON.stringify({ type: "auth", token }) + "\n");
      socket.end(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
    });
    socket.on("error", (error) => finish(new Error(`Could not reach the Claude session: ${error.message}`)));
    socket.on("close", () => finish());
  });
}

function sendJson(res, status, body, origin) {
  if (origin)
    res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

function extensionOrigin(req) {
  const origin = req.headers?.origin;
  return typeof origin === "string" && /^(chrome|moz)-extension:\/\//.test(origin) ? origin : undefined;
}

// Listeners rather than for-await: breaking out of an async iterator destroys
// the socket, and the 413 response would never reach the extension.
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const finish = (settle, value) => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      settle(value);
    };
    const onData = (chunk) => {
      size += chunk.byteLength;
      if (size > BODY_LIMIT) {
        chunks.length = 0;
        finish(reject, httpError(413, "Request body too large"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (!chunks.length) {
        finish(resolve, {});
        return;
      }
      let value;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      } catch {
        finish(reject, new Error("Request body must be valid JSON"));
        return;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        finish(reject, new Error("Request body must be a JSON object"));
        return;
      }
      finish(resolve, value);
    };
    const onError = (error) => finish(reject, error);
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

function isTabId(value) {
  return Number.isInteger(value) && value >= 0;
}

async function handleAnnotation(body) {
  const { tabId, sessionId, annotation } = body;
  if (!isTabId(tabId) || typeof sessionId !== "string" || !sessionId)
    throw new Error("tabId and sessionId are required");
  if (!annotation || typeof annotation !== "object")
    throw new Error("annotation is required");
  const entry = findRegistryEntry(sessionId);
  if (!entry)
    throw new Error("That Claude Code chat is no longer active. Pick a running chat and try again.");
  const token = readPeerToken(entry.pid);
  if (!token)
    throw new Error("Could not read the Claude session's messaging token");
  let text = buildAnnotationPrompt(annotation);
  if (annotation.screenshot?.dataUrl)
    text += `\n\nScreenshot: ${saveScreenshot(annotation)}`;
  await deliverToSession(entry.messagingSocketPath, token, text);
  log(`annotation delivered sessionId=${sessionId} tabId=${tabId}`);
}

function createBridgeServer(getPort) {
  return createServer(async (req, res) => {
    // Same guards as the OpenCode plugin: only the extension (or a local CLI
    // with no Origin) may talk to us, and the Host must be loopback, so web
    // pages can't read chats or inject prompts, even via DNS rebinding.
    const origin = extensionOrigin(req);
    if (req.headers.origin !== undefined && !origin) {
      req.resume();
      return sendJson(res, 403, { ok: false, error: "Forbidden origin" });
    }
    const port = getPort();
    const host = String(req.headers.host || "").toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      req.resume();
      return sendJson(res, 403, { ok: false, error: "Forbidden host" });
    }
    if (req.method === "OPTIONS")
      return sendJson(res, 200, { ok: true }, origin);
    if (req.method === "POST" && !/^application\/json/i.test(String(req.headers["content-type"] || ""))) {
      req.resume();
      return sendJson(res, 415, { ok: false, error: "Content-Type must be application/json" }, origin);
    }
    const url = new URL(req.url || "/", `http://${HOST}:${port}`);
    try {
      if (req.method === "GET" && url.pathname === "/status") {
        return sendJson(res, 200, { app: APP_ID, agent: AGENT, version: APP_VERSION, port, pid: process.pid, sessionsDir }, origin);
      }
      if (req.method === "GET" && url.pathname === "/sessions")
        return sendJson(res, 200, { sessions: listSessions() }, origin);
      if (req.method === "POST" && url.pathname === "/claim") {
        const body = await readJson(req);
        if (!isTabId(body.tabId) || typeof body.sessionId !== "string" || !body.sessionId)
          throw new Error("tabId and sessionId are required");
        if (!findRegistryEntry(body.sessionId))
          throw new Error("That Claude Code chat is no longer active. Pick a running chat and try again.");
        return sendJson(res, 200, { ok: true, sessionId: body.sessionId }, origin);
      }
      if (req.method === "POST" && url.pathname === "/unclaim") {
        await readJson(req);
        return sendJson(res, 200, { ok: true }, origin);
      }
      if (req.method === "POST" && url.pathname === "/annotation") {
        const body = await readJson(req);
        await handleAnnotation(body);
        return sendJson(res, 200, { ok: true, sessionId: body.sessionId, transport: "cross-session-socket" }, origin);
      }
      if (req.method === "POST" && url.pathname === "/session/close")
        throw httpError(501, "Closing Claude Code chats from the side panel is not supported. Stop the session in your terminal.");
      return sendJson(res, 404, { ok: false, error: "Not found" }, origin);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error?.status || 400;
      log(`request failed path=${url.pathname} status=${status} error=${message}`);
      if (status === 413) {
        res.setHeader("Connection", "close");
        req.resume();
      }
      return sendJson(res, status, { ok: false, error: message }, origin);
    }
  });
}

async function probeStatus(port) {
  try {
    const response = await fetch(`http://${HOST}:${port}/status`, { signal: AbortSignal.timeout(500) });
    return await response.json();
  } catch {
    return null;
  }
}

// launchd plus a manual run would otherwise list every chat twice.
async function findRunningBridge() {
  const ports = [];
  for (let port = PORT_START; port <= PORT_END; port++)
    ports.push(port);
  const statuses = await Promise.all(ports.map(probeStatus));
  return statuses.find((status) => status?.app === APP_ID && status?.agent === AGENT && status?.sessionsDir === sessionsDir) || null;
}

async function start() {
  const running = await findRunningBridge();
  if (running) {
    log(`already running on ${HOST}:${running.port} (pid ${running.pid}); exiting`);
    return;
  }
  let boundPort = 0;
  const server = createBridgeServer(() => boundPort);
  for (let port = PORT_START; port <= PORT_END; port++) {
    const bound = await new Promise((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, HOST, () => resolve(true));
    });
    if (bound) {
      boundPort = port;
      log(`listening on ${HOST}:${port}, reading ${sessionsDir}`);
      return;
    }
  }
  throw new Error(`All ports ${PORT_START}-${PORT_END} are busy`);
}

function launchAgentPath() {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCH_LABEL}.plist`);
}

// npx runs us from a cache folder npm may clear, so the LaunchAgent runs a
// copy kept here instead. The bridge is one file with no dependencies.
function installedScriptPath() {
  return join(homedir(), "Library", "Application Support", "opencode-annotate", "claude-bridge.mjs");
}

function xml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function launchctl(args) {
  return spawnSync("launchctl", args, { encoding: "utf-8" });
}

async function install() {
  if (process.platform !== "darwin")
    throw new Error("--install sets up a macOS LaunchAgent. On other systems, run `npx opencode-annotate@latest claude-bridge` from your login scripts.");
  const plistPath = launchAgentPath();
  const logPath = join(homedir(), "Library", "Logs", "claude-bridge.log");
  const scriptPath = installedScriptPath();
  mkdirSync(dirname(scriptPath), { recursive: true });
  copyFileSync(fileURLToPath(import.meta.url), scriptPath);
  // launchd has no shell PATH (nvm, Homebrew), so pin the node binary running us.
  const args = [process.execPath, scriptPath];
  let env = "";
  if (process.env.CLAUDE_CONFIG_DIR)
    env = `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>CLAUDE_CONFIG_DIR</key>\n    <string>${xml(process.env.CLAUDE_CONFIG_DIR)}</string>\n  </dict>\n`;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>
${env}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(plistPath, plist);
  const domain = `gui/${process.getuid()}`;
  const service = `${domain}/${LAUNCH_LABEL}`;
  launchctl(["bootout", service]); // fails harmlessly when not loaded
  // bootout returns before the old job is gone; bootstrapping too soon fails
  // with "5: Input/output error", so wait for it to unload, then retry.
  for (let i = 0; i < 50 && launchctl(["print", service]).status === 0; i++)
    await sleep(100);
  let result = launchctl(["bootstrap", domain, plistPath]);
  for (let attempt = 0; attempt < 5 && result.status !== 0; attempt++) {
    await sleep(500);
    result = launchctl(["bootstrap", domain, plistPath]);
  }
  if (result.status !== 0)
    throw new Error(`launchctl bootstrap failed: ${(result.stderr || result.stdout).trim()}`);
  console.log(`Installed ${plistPath}`);
  console.log(`Runs ${scriptPath} with ${process.execPath}`);
  console.log(`The bridge now starts at login. Log: ${logPath}`);
  console.log("Remove it with: npx opencode-annotate@latest claude-bridge --uninstall");
}

function uninstall() {
  const plistPath = launchAgentPath();
  launchctl(["bootout", `gui/${process.getuid()}/${LAUNCH_LABEL}`]);
  rmSync(plistPath, { force: true });
  rmSync(installedScriptPath(), { force: true });
  console.log(`Removed ${plistPath} and the installed bridge`);
}

// Accept both `claude-bridge.mjs --install` and the package bin form
// `opencode-annotate claude-bridge --install`.
const args = process.argv.slice(2);
if (args[0] === "claude-bridge")
  args.shift();
const command = args[0];
if (command === "--install")
  await install();
else if (command === "--uninstall")
  uninstall();
else if (command === undefined)
  await start();
else {
  console.error("Usage: opencode-annotate claude-bridge [--install | --uninstall]");
  process.exit(2);
}
