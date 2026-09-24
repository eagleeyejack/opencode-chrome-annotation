# OpenCode v2 adapter

This is a separate OpenCode **2.x** adapter. The root package and `src/plugin.ts`
remain the OpenCode 1.x plugin; do not replace or edit that entry point when
working on this adapter.

## Install for local development

From this directory, install the V2 plugin API dependency:

```sh
npm install
```

Register `index.js` in the V2 config used by the isolated V2 profile:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-chrome-annotation/v2"]
}
```

The V2 profile needs `@opencode/plugin` 2.0.16 available to this module. Keep
V1 and V2 config/data directories separate; the plugin opens a localhost server
on the same bounded port range as V1, and automatically picks a free port if
both versions are running.

## Behavior and differences

- The existing Chrome extension protocol and `/status`, `/sessions`, `/claim`,
  `/unclaim`, and `/annotation` routes are retained.
- V2 sessions are recorded from session events and prompt admission and cached
  using V2 plugin storage. A fresh V2 install cannot show V1 session history.
- Screenshot attachments are written under V2's isolated runtime directory and
  passed to the selected V2 session as a local file URI.
- The `chrome_status` tool is registered through the V2 tool transform.
- The V2 plugin API does not expose session deletion to plugins, so
  `/session/close` returns `501`; close that session in OpenCode instead.
- The server binds only to `127.0.0.1`, and reflects CORS origins only for
  browser-extension schemes.

## Verify

```sh
npm test
node --check index.js
```

The tests use a mock V2 plugin context and localhost requests. End-to-end use
requires OpenCode 2.x and the existing Chrome extension.
