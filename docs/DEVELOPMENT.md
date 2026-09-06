# aiborda — for developers

Technical documentation: architecture, how the protocol works, known
weaknesses. The user-facing README is [../README.md](../README.md).

An agent that talks to a human through an HTML page. The human edits the page
by hand — in fields, through `contenteditable`, through the browser developer
tools — and presses "send". The model receives a **diff of the edits** and
answers by changing the same page.

The core is the `@earendil-works/pi-coding-agent` SDK. The model works with
the usual tools — `bash`, reading and writing files, `web_fetch`, memory,
subagents — plus one of ours, `page_exec`, for working with the page.

Two invariants:

1. **The model is all-powerful on the outside and reaches the page only
   through `page_exec`. The page cannot reach the shell.** Isolation comes
   from origin separation, not from a sandbox.
2. **The diff is the only automatic channel of perception.** A snapshot of the
   page is never sent to the model. If it needs the state, it reads it itself
   with a `page_exec` call.

## Running it

You need Node ≥ 20 and a configured `pi`: the model, the keys and the settings
all come from `~/.pi/agent`; aiborda has no configuration of its own.

```bash
npm install
npm start
```

Open `http://127.0.0.1:8730`.

## Two ports — and that is the whole isolation mechanism

| port | what it serves |
|---|---|
| 8730 | the shell: the "send" button, the turn indicator, the model name |
| 8731 | the image: the page the human and the model work with |

Different ports mean different origins. That gives both of the following at
once:

- the image has **all of HTML5 working**: `localStorage`, `sessionStorage`,
  `indexedDB`, `cookie`, `isSecureContext: true`
- the image **cannot reach the shell**: `parent.document` throws a
  `SecurityError`, a request to the shell's origin throws a `TypeError`
- `event.origin` in the shell is the image's real address rather than `null`,
  which makes the sender check meaningful; the `event.source` check and the
  `id` match stayed alongside it

The `sandbox` attribute is not used. It would give less: `allow-same-origin`
unlocks the storages at the price of full access to the shell, including the
ability to strip its own `sandbox`.

The server listens on the loopback only and checks the `Host` header on both
ports: binding to `127.0.0.1` is not enough on its own, because an attacker's
domain that resolves to `127.0.0.1` lets their page read the responses as its
own.

## Where the contract with the model lives

- `AGENTS.md` in the root — the product framing and the rules of behaviour. pi
  reads it as a context file. In each directory it takes the **first one it
  finds** out of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`,
  `CLAUDE.MD`; first the global one from `~/.pi/agent/`, then from the root
  down through the ancestors. **`README.md` is not a context file** — the model
  never sees it.
- `promptGuidelines` and `promptSnippet` on the `page_exec` tool in
  `server/agent.js` — the mechanics: what to read, where to keep state, where
  the human's edits come from.

We have no separate system prompt and need none: `createAgentSession` has no
such field, and both paths above are the supported ones. pi assembles the base
prompt itself, and our lines slot into its "Available tools" and "Guidelines"
sections.

## Permissions

**There are no gates.** The tools are available to the model straight away,
including `bash` and `write`. This is a deliberate decision for the first
version: the agent has the user's authority on the machine, like `pi` without
confirmations.

The direct consequence: prompt injection is a significant risk as soon as the
model starts reading the contents of third-party sites. There are no
mitigations at present.

## Layout

```
server/
  index.js       two HTTP servers, SSE down, POST up, static files
  agent.js       the pi session and the page_exec tool
  bridge.js      matching requests to the image with their answers
web/
  index.html     the shell
  shell.js       the turn, EventSource, exchange with the image
  image.html     the image: the page stub
  image-boot.js  mutation observer, attribution, diff building, snapshot
  style.css
AGENTS.md        the contract with the model
```

### How a turn goes

```
the human edits the page
  ↓ "send"
the shell asks the image for a diff  (postMessage)
  ↓ POST /api/commit
the server calls session.prompt(diff)
  ↓ the model decides and calls page_exec
server → shell (SSE) → image (postMessage) → back via POST /api/page-result
```

The model can call `page_exec`, `bash`, `read`, `write` and `web_fetch` as
many times as it likes within a single turn. Reading state does not cost a
separate turn: `page_exec` both reads and writes.

The server → image channel is built on SSE down and POST up rather than a
WebSocket: Node has a WebSocket client but no server, and the `ws` package
would become the first dependency besides pi.

### How the human's edits are captured

`web/image-boot.js` is the subtlest part of the project, carried over from the
first milestone unchanged. Edits made through DevTools produce no events at
all, so the foundation is `MutationObserver`; live typing into a field changes
the `.value` property, which the observer does not see, so fields additionally
listen for `focusin`, `input` and `change`.

The model's own edits are filtered out by the `page_exec` execution window,
not by `isTrusted`. Coalescing is mandatory: `getAttribute()` at the moment a
record is delivered returns the current value, not the value at the time of
the mutation.

## Keyboard

`Ctrl+Enter` or `Cmd+Enter` sends the turn. The input field is single-line and
is cleared right after sending — atomically with building the diff, inside the
image: as a separate message the human could type something in between and the
text would be lost. The baseline is re-seeded at the same time; otherwise the
next diff would report "was ‹what was just sent›". This works even when focus
is in the input field inside the image: a keyboard event does not bubble from
there up into the shell, since they are different origins, so the image
reports the press itself with a `commit` message. Synthetic events are
filtered out by `isTrusted` so that the model's code cannot send a turn on the
human's behalf.

## Debugging

The model's stream goes to the `node` output: text, reasoning in a dimmed
colour, and tool calls with arguments — as they are generated.

```bash
npm start
```

```
model: openrouter/nvidia/nemotron-3-ultra-550b-a55b:free

The user wants me to write the word "done" into the #out element…
→ page_exec {"code":"const out = document.getElementById('out');…"}
← page_exec Done: wrote "done" to #out

Done — the word "done" has been written into `#out`.
```

The full history of turns lives in the transcripts pi writes itself:

```bash
npm run log
```

```bash
node log.mjs -f
```

## Tests

```bash
npm test
```

129 tests on `node:test`. The image tests execute **the very same text** of
`image-boot.js` that the browser loads, through `new Function` in jsdom. No
test goes to the network or talks to a model: the session is substituted via
`sessionFactory`, and the image's answers come through the bridge.

## Verified live

A full turn: the human typed "make a list of three items", the model called
`page_exec`, three items appeared on the page. Twenty-five seconds.

Persistent storage: "remember in localStorage under the key name that my name
is Sergey" — the value was written and is visible from a separate tab on the
image's origin.

Reaching outwards: "use bash to find out how many files are in the current
directory and show the number in #out" — the model went to `bash`, counted,
and wrote the answer onto the page.

## Known weaknesses

- **Prompt injection** when reading third-party sites — there are no gates.
- **A human edit to the same node the model is editing** during a turn will be
  attributed to the model and lost. `MutationObserver` does not report
  authorship; attribution goes by the execution window plus a grace period.
- **The diff is lost on a network failure**: the image clears its buffers at
  build time, before it is known whether the request arrived.
- **The model's text is visible only in the `node` output**, not on the page.
  The indicator shows only the fact that a turn is running.
- **Model selection has been removed from the interface** — the name is shown
  next to the button, but it cannot be changed from the page. It will come
  back as a separate task via `session.setModel` and `session.cycleModel`.
- **Two tabs on one server** share a single session and a single bridge; the
  second tab will receive `page_exec` requests meant for the first.
- **The model's code can forge a `commit` message** and start a turn. The
  `isTrusted` filter in the image closes the synthetic-keydown route, but
  nothing closes a direct `parent.postMessage`. The damage is limited: during
  a turn `commit()` returns straight away, and the diff will be empty — the
  model's own edits do not go into it.

## Two things worth not tripping over

**`node --test test/` does not work on Node 26.5.0** — the runner tries to
resolve the directory as a module. `package.json` has a bare `node --test`
with no path; auto-discovery finds the same files.

**Paths with spaces.** `new URL(...).pathname` returns a percent-encoded path,
and ``import.meta.url === `file://${process.argv[1]}` `` evaluates to `false` —
because of the second one, `npm start` would exit silently without starting
anything. `fileURLToPath` is used everywhere.
