# <img src="https://raw.githubusercontent.com/jodusnodus/opencode-chrome-annotation/main/icon.svg" width="60" align="center" /> OpenCode Chrome Annotation

[![version](https://img.shields.io/npm/v/opencode-annotate?style=flat&colorA=000000&colorB=000000)](https://npmjs.com/package/opencode-annotate)
> Fork of [JodusNodus/opencode-chrome-annotation](https://github.com/JodusNodus/opencode-chrome-annotation), published as `opencode-annotate`. GPL-3.0.
[![license](https://img.shields.io/npm/l/opencode-chrome-annotation?style=flat&colorA=000000&colorB=000000)](https://github.com/jodusnodus/opencode-chrome-annotation/blob/main/LICENSE)

Annotate any page in Chrome and send the screenshot, selected element metadata, and your instruction directly into [OpenCode](https://opencode.ai).

> **This is a fork** of [jodusnodus/opencode-chrome-annotation](https://github.com/jodusnodus/opencode-chrome-annotation) with quality-of-life and routing changes described below. The upstream npm package and Chrome Web Store listing serve the original; this repo's `main` is self-contained and not published to npm.

## What's different in this fork

- **Annotation queue.** Pick mode stays on after each annotation so you can batch feedback, then send everything in one click. The connection bar shows a queue badge with a panel to review, remove, clear, or send all. The queue survives service worker restarts (`chrome.storage.session`).
- **Element screenshots.** Each queued annotation crops the captured viewport to the selected element instead of shipping the full page.
- **Chat locking.** Annotations now go to the chat you picked, always. Sub-agent sessions can no longer hijack routing, placeholder sessions are rejected with a clear message instead of silently rerouting, and prompts are delivered to the target session's own project directory.
- **All chats, grouped.** The picker lists every open chat (not just the most recent one), grouped under project headers, with a Linked badge and a refresh button. The bar shows which chat you are linked to; clicking its name switches chats.
- **Security.** The local server no longer reflects arbitrary web origins into `Access-Control-Allow-Origin`, so random web pages cannot read your chat titles over the localhost port.
- **Robustness and restyle.** 10s timeout on screenshot capture (it can hang when a tab navigates mid-annotation), and a white/black/pastel UI.

## Install (this fork)

1. Clone and build:

```bash
git clone https://github.com/eagleeyejack/opencode-chrome-annotation
cd opencode-chrome-annotation
bun install
bun run build
bun run build:extension
```

2. Point your OpenCode config at the built plugin (absolute path to `dist/plugin.js`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/path/to/opencode-chrome-annotation/dist/plugin.js"]
}
```

3. Load the generated `extension/` directory unpacked from `chrome://extensions`.

If you would rather run the original upstream instead: add `opencode-chrome-annotation@latest` to your OpenCode config and install the extension from the Chrome Web Store:

https://chromewebstore.google.com/detail/abeihanpaeioklkhioiigklonbomhjfd

## How It Works

1. Start OpenCode in your project.
2. Click the extension button in Chrome.
3. Connect the current tab to a specific OpenCode chat from the in-page picker (grouped by project, with the linked chat badged).
4. Click **Annotate** in the in-page pill.
5. Select an element, write your instruction, then **Add to queue** (keep going) or **Add & finish**.
6. Open the queue from the bar and hit **Send all to OpenCode** when you are done.


### What Gets Sent

- Your written instruction.
- The current page URL and title.
- Selected element metadata such as selector, tag, text, role, aria label, and bounds.
- A screenshot saved locally by the plugin and referenced in the OpenCode prompt.


### Troubleshooting
The plugin runs a local HTTP server bound to `127.0.0.1` on ports `39240-39260`. The extension discovers the active OpenCode plugin instance over localhost.

- The extension can't start a new session, you need to be in an active OpenCode session to connect.
- If the extension can't find any session, ask your agent to run `chrome_status` that should give a detailed report.
- Make sure OpenCode and your Chromium browser exist in the same localhost network (not in seperate containers).


## Development

### Plugin

The OpenCode plugin source lives in `src/plugin.ts`. The published package entrypoint is generated at `dist/plugin.js`.

Install dependencies:

```bash
bun install
```

Build the plugin:

```bash
bun run build
```

### Extension

The Chrome extension source lives in `extension-src/`. The loadable extension output is generated into `extension/` and is not tracked by git.

```bash
bun run build:extension
```

Then load the generated `extension/` directory from `chrome://extensions`.

To create the Chrome Web Store upload zip:

```bash
bun run build:zip
```
