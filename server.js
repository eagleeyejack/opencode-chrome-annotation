// Entry for hosts that look for a package's "./server" export first.
//
// OpenCode 2 requires the default export to be a plain object (a function is
// rejected by its schema), reads `id` and `setup` from it, and ignores other
// keys. OpenCode 1 (recent) accepts a default object that has `server`, a v1
// plugin function, and calls that. The same object serves both.
//
// Older OpenCode 1 releases iterate every export of the module and call each
// one, so they use the "." export (dist/plugin.js, the plain v1 function).
import v1Plugin from "./dist/plugin.js"
import v2Plugin from "./v2/index.js"

export default { id: v2Plugin.id, setup: v2Plugin.setup, server: v1Plugin }
