# <img src="https://raw.githubusercontent.com/jodusnodus/opencode-chrome-annotation/main/icon.svg" width="60" align="center" /> opencode-annotate

[![version](https://img.shields.io/npm/v/opencode-annotate?style=flat&colorA=000000&colorB=000000)](https://npmjs.com/package/opencode-annotate)
[![license](https://img.shields.io/npm/l/opencode-annotate?style=flat&colorA=000000&colorB=000000)](https://github.com/eagleeyejack/opencode-chrome-annotation/blob/main/LICENSE)

> Fork of [JodusNodus/opencode-chrome-annotation](https://github.com/JodusNodus/opencode-chrome-annotation), published as `opencode-annotate`. GPL-3.0. Not built by the OpenCode team and not affiliated with them.

Point at what's broken in your live app. Your agent fixes it.

This is the **OpenCode plugin** half of the tool. Pair it with the [Chrome extension](https://github.com/eagleeyejack/opencode-chrome-annotation-extension): a side panel connects any tab to your OpenCode session, you click the broken element on the live page, write what should change, and the agent receives the cropped screenshot, the element's exact selector, and your instruction.

## Install

Add the plugin to your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-annotate@latest"]
}
```

Restart OpenCode. It runs a local server on `127.0.0.1` (ports `39240-39260`) that the Chrome extension discovers.

Then install the Chrome extension from [eagleeyejack/opencode-chrome-annotation-extension](https://github.com/eagleeyejack/opencode-chrome-annotation-extension) (load unpacked; a Chrome Web Store listing is in review).

## How It Works

1. Start OpenCode in your project.
2. Click the extension icon: the side panel opens and lists your OpenCode sessions, grouped by project.
3. Pick a session to link the current tab.
4. Click **Select element**, click anything on the page, write your instruction, and add it to the queue.
5. Queue as many annotations as you need, then hit **Send all to OpenCode**.
6. Your agent receives each annotation's cropped screenshot, exact selector, tag/role/ARIA metadata, and your instruction.

Sessions can be closed (deleted) straight from the panel, with a two-click confirm.

### What Gets Sent

- Your written instruction.
- The current page URL and title.
- The selected element's metadata: selector, tag, role, ARIA label, visible text, bounds.
- A cropped screenshot of the selected element.

Everything travels over `127.0.0.1` (ports `39240-39260`) to your own OpenCode instance. Nothing leaves your machine. OpenCode and your browser must be on the same localhost (not in separate containers).

## What's different from upstream

- **Side panel UI.** Session picker, annotate form, and queue moved out of the page into Chrome's side panel, so nothing overlays the page being annotated. Browsers without the Side Panel API fall back to the original in-page picker.
- **Session cleanup.** Close stale OpenCode sessions from the panel (`POST /session/close` via the OpenCode SDK).
- **Session dates.** `/sessions` includes `updatedAt` so the panel shows relative last-activity time per session.
- **Annotation queue.** Batch feedback across a page, then send everything in one click. Survives service worker restarts via `chrome.storage.session`.
- **Element screenshots.** Each annotation crops the captured viewport to the selected element.
- **Chat locking.** Annotations always go to the chat you picked; sub-agent sessions cannot hijack routing and placeholder sessions are rejected clearly.
- **All chats, grouped.** The picker lists every open chat, grouped by project, with a Linked badge.
- **Security.** The local server no longer reflects arbitrary web origins into `Access-Control-Allow-Origin`.

## License

GPL-3.0 - inherited from upstream, with credit to [JodusNodus](https://github.com/JodusNodus/opencode-chrome-annotation) for the original.