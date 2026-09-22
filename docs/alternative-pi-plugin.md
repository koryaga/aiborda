# Deferred option: dom-agent as a pi extension

Date: 2026-08-20. The decision went in favour of the SDK; this document
preserves the alternative that was considered, together with the facts that
were verified, so it can be revisited without redoing the research.

## What the option was

Instead of a standalone application, an extension to `pi`. The user runs `pi`
in the terminal, the extension brings up an HTTP server and serves the page.
The page becomes a second surface alongside the TUI, within one session.

## Why it was not chosen

The task was phrased as "communication with the user through HTML". In the
plugin option the terminal stays the main window and the page lives next to
it. The SDK gives the page as the only interface.

This does not rule the plugin out as a future second launch mode: the core is
the same, only the entry point differs.

## Verified facts (do not re-check)

An extension is declared with the `pi` field in `package.json`:

```json
"pi": { "extensions": ["./extensions/chrome-profile-bridge/index.ts"] }
```

The entry point is a default-exported function:

```ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI): void { … }
```

The dependency is declared as a peer and marked optional:

```json
"peerDependencies": { "@earendil-works/pi-coding-agent": "*", "typebox": "*" },
"peerDependenciesMeta": { "@earendil-works/pi-coding-agent": { "optional": true } }
```

The user enables it through `packages` in `~/.pi/agent/settings.json` (in a
real config the entries look like `"npm:pi-chrome"`).

### What `ExtensionAPI` provides

What matters for our task:

- `registerTool(tool)` — tools available to the model
- `registerCommand(name, options)` — slash commands
- `registerShortcut`, `registerFlag`, `getFlag`
- `sendUserMessage(content, { deliverAs })` — put a user message into the
  conversation; **always starts a turn**. That is exactly "the human pressed
  send".
- `sendMessage({ customType, content, display })` — a service message, with
  control over whether it reaches the LLM context
- `appendEntry(customType, data)` — a session record that does **not** reach
  the context
- `getActiveTools()` / `setActiveTools(names)` — turn tools on and off on the
  fly
- `exec(...)` — run a shell command
- `registerMessageRenderer`, `registerEntryRenderer`, `registerMarkdownTransformer`
- `setSessionName` / `getSessionName`, `setLabel`

There are about thirty-five events; the useful ones include:
`session_start`, `session_shutdown`, `turn_start`, `turn_end`,
`message_start`, `message_update`, `message_end`,
`tool_execution_start` / `_update` / `_end`, `tool_call`, `tool_result`,
`context`, `before_provider_request`, `input`, `user_bash`,
`model_select`, `thinking_level_select`, `project_trust`.

### Precedent

`pi-chrome` version 0.15.46 is an extension that brings up **its own HTTP
server** through `node:http` and talks to a browser extension in a real Chrome
profile which polls that server for commands. So "a pi extension holds a
server and talks to the browser" is an already working scheme, not a
conjecture.

Other useful things from the same place, should the option be revisited:

- protection against double loading via a flag on `globalThis` — it survives
  `/reload`
- the user's permission is stored separately from the load flag so that
  `/reload` does not reset it
- tools are registered lazily and enabled through `setActiveTools` only after
  authorisation

## What would have to be done differently from the SDK option

- Entry point: `export default function (pi: ExtensionAPI)` instead of
  `createAgentSession(...)`
- A turn is started through `pi.sendUserMessage(diff)` instead of calling the
  session directly
- The page tools are registered through `pi.registerTool` instead of
  `customTools` in the session options
- The server lifecycle is tied to `session_start` / `session_shutdown`
- Publishing: an npm package with a `pi.extensions` field, installed via
  `packages`

Everything else — the image, the shell, the mutation observer, the diff
building — is shared and carries over unchanged.
