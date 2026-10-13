# AGENTS.md - OpenCode Browser

Guidelines for AI agents working on this codebase.

## Project Overview

OpenCode Chrome Annotation sends browser annotations into OpenCode via an OpenCode **plugin**, backed by a Chrome/Chromium **extension**.

Architecture:

```
Chrome Extension <-> Local HTTP server in each OpenCode Plugin instance
```

Components:

1. **Plugin** - one npm package (`opencode-annotate` 2.x) that works on OpenCode 1 and 2, both serving the same local HTTP endpoints for status/session/claim/annotation. The OpenCode 2 plugin is `v2/index.js` (no build step). The OpenCode 1 plugin is `src/plugin.ts`, built with `bun run build:v1` into `dist/plugin.js`. Package `.` exports `dist/plugin.js` (a plain v1 function, for any OpenCode 1). Package `./server` exports `server.js`, a plain object `{ id, setup, server }`: OpenCode 2 reads `id` and `setup` (it rejects a function default export), recent OpenCode 1 calls `server`. Do not add extra exports to either entry: OpenCode 1 calls every export of the module it loads
2. **Extension** (`extension/`) - discovers plugin instances on localhost ports and sends annotation payloads

## Build & Run Commands

```bash
# Install dependencies
bun install

# Test and check the OpenCode 2 plugin
bun run build:v1 && (cd v2 && node --test) && node --test hybrid.test.js && node --check server.js && node --check v2/index.js

# Validate scripts
node --check extension/background.js
```

## Testing Changes

To test end-to-end you need:

1. The extension loaded in `chrome://extensions`
2. OpenCode configured with the plugin

Then verify manually in a fresh OpenCode process by connecting a tab from the extension popup and submitting an annotation.

## Code Style Guidelines

### TypeScript (src/)

- 2-space indentation
- Double quotes
- Semicolons required

### JavaScript (extension/)

- 2-space indentation
- Double quotes
- No semicolons

## Important Notes

- Plugin binds local HTTP on `127.0.0.1` over a bounded port range (`39240-39260`).
- Extension discovers active instances by probing `/status` and routes annotation requests directly to the selected instance.
