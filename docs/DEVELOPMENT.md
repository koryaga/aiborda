# aiborda — for developers

Technical documentation: architecture, how the protocol works, known weak
spots. The user-facing README is [../README.md](../README.md).

An agent that talks to a human through an HTML page. The human edits the page
by hand — in fields, via `contenteditable`, through the browser's developer
tools — and presses "send". The model receives **a diff of the edits** and
answers by changing that same page.

The core is the SDK of the `@earendil-works/pi-coding-agent` tool. The model
works with the ordinary tools: `bash`, reading and writing files, `web_fetch`,
memory, subagents — plus one of ours, `page_exec`, for working with the page.

Two invariants:

1. **The model is all-powerful outside and reaches the page only through
   `page_exec`. The page does not reach the shell.** The isolation comes from
   the origin split, not from a sandbox.
2. **The diff is the only automatic channel of perception.** A snapshot of the
   page is never sent to the model. If it needs the state, it reads it itself
   with a `page_exec` call.

The design documents (specs, plans, brainstorms) are deliberately kept out of
the repository and live only on the author's machine.

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

Different ports mean different origins. From that follow both of these at once:

- the image **has all of HTML5 working**: `localStorage`, `sessionStorage`,
  `indexedDB`, `cookie`, `isSecureContext: true`
- the image **cannot reach the shell**: `parent.document` throws a
  `SecurityError`, and a request to the shell's origin is a `TypeError`
- `event.origin` in the shell is the image's real address, not `null`, so
  checking the sender became meaningful; the checks on `event.source` and on a
  matching `id` remain alongside it

The `sandbox` attribute is not used. It would give less: `allow-same-origin`
opens up the storages at the price of full access to the shell, including the
ability to strip its own `sandbox`.

The server listens on the loopback only and checks the `Host` header on both
ports: binding to `127.0.0.1` alone is not enough, because an attacker's domain
that resolves to `127.0.0.1` lets their page read the responses as its own.

## Where the contract with the model lives

In three places, from the strongest to the weakest position:

- **`server/system-prompt.md` — the system prompt itself.** It *replaces* pi's
  base prompt through `systemPromptOverride` on `DefaultResourceLoader`
  (`createAgentSession` has no such field; the loader does). pi's base prompt
  opens with "You are an expert coding assistant" and closes its guidelines with
  "Be concise in your responses": both frame a text reply as the answer, and
  they used to outrank our contract, which pi appended last as a project context
  file. With the override, pi drops `promptSnippet` and `promptGuidelines`
  altogether, so everything the model must know lives in this one file.
- **The turn framing, `frameTurn()` in `server/agent.js`.** The diff goes to the
  model wrapped in a one-line header and a reminder at the end — the last thing
  it reads before answering.
- **The nudge, in `handleCommit` in `server/index.js`.** If a turn still ends
  with text other than the log word `done`, that text is sent back once as a
  hidden custom message with `triggerTurn: true`, so the model moves it onto the
  page. Once per human turn: a second miss is left alone rather than looped on.
  A turn that ends with no text at all is never nudged.

`AGENTS.md` in the root is **not** part of the contract: it is for agents
working on this code. pi would load it as a context file (it takes the first of
`AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` in each
directory, from `~/.pi/agent/` and down through the ancestors of the working
directory), so `agentsFilesOverride` filters out every context file inside this
repository. Context files from elsewhere — the user's global one, a parent
directory's — still reach the model. **`README.md` is not a context file.**

## Permissions

**There are no gates.** The tools are available to the model right away,
including `bash` and `write`. This is a deliberate decision for the first
version: the agent has the user's authority on the machine, like `pi` without
confirmations.

The direct consequence: prompt injection is a significant risk as soon as the
model starts reading the contents of other people's sites. There are no
mitigations at the moment.

## Layout

```
server/
  index.js       two HTTP servers, SSE down, POST up, static files
  agent.js       the pi session, the page_exec tool, turn framing, the nudge
  system-prompt.md  the contract with the model
  bridge.js      matching requests to the image with their responses
web/
  index.html     the shell
  shell.js       a turn, EventSource, the exchange with the image
  image.html     the image: the page scaffold
  image-boot.js  the mutation observer, attribution, diff building, snapshot
  style.css
AGENTS.md        instructions for agents working on this code
```

### How a turn goes

```
the human edits the page
  ↓ "send"
the shell asks the image for a diff  (postMessage)
  ↓ POST /api/commit
the server calls session.prompt(frameTurn(diff))
  ↓ the model decides and calls page_exec
server → shell (SSE) → image (postMessage) → back via POST /api/page-result
  ↓ the turn ends in text other than "done"?
one hidden nudge, one more turn, then "done" goes to the shell
```

The model can call `page_exec`, `bash`, `read`, `edit` and `write` as many times
as it likes within a single turn. Reading the state does not cost a turn of its
own: `page_exec` both reads and writes.

The server → image channel is built on SSE down and POST up rather than a
WebSocket: Node has a WebSocket client but no server, and the `ws` package
would become the first dependency besides pi.

### How the human's edits are caught

`web/image-boot.js` is the subtlest part of the project. Edits made through
DevTools produce no events at all, so the foundation is a `MutationObserver`;
live typing into a field changes the `.value` property, which the observer does
not see, so for fields `focusin`, `input` and `change` are listened to
separately.

The model's own edits are filtered out by the `page_exec` execution window, not
by `isTrusted`. Coalescing is mandatory: `getAttribute()` at the moment a
record is delivered returns the current value, not the value at the time of the
mutation.

**What the model adds is editable by default.** The prompt asks for it, but a
prompt only makes it likely, so the image enforces it: at the end of every
`page_exec` (after an error too), each topmost block of text the model added
gets `contenteditable="true"` unless it or an ancestor already carries a
`contenteditable` of its own. Buttons, links and form controls inside it get
`contenteditable="false"`, so they stay clickable. `#q`, `#notes`, scripts,
styles, SVG, canvas and empty containers are left alone, and so is anything the
human added. These writes belong to the image, not to either party:
`makeEditable()` drops their records with `takeRecords()`, so they reach
neither the diff nor the attribution. What the model adds *after* an `await`
inside its own code is not covered: attribution already credits such nodes to
the human (see "Known weak spots").

Every node in the diff is named by its **full path from `<html>`**:
`html > body > div#out > figure#calc > div.big:nth-child(1)`. A step is the tag
plus a unique id, or plus its plain-identifier classes and its position among
siblings (`head` and `body` need none). The path shows the model where a node
sits, not just which one it is, and it is also a selector matching exactly that
node, ready for `querySelector`. Ids and classes that are not plain identifiers
are left out rather than escaped: `CSS.escape` is not available everywhere this
file runs.

**What the human points at.** A question typed into `#q` is usually about
something on the page ("why is this so big?"). The image remembers the last
element the human clicked, or the text they selected, anywhere outside `#q`.
When a diff carries a change to `#q`, an `about:` line follows it with that
element's full path and a short excerpt, or `selected: "…"` with the selected
words. The pointer is reset on every send, so a follow-up question does not
inherit a stale "this". Three things are deliberately ignored:

- a click on the bare page background, which points at nothing in particular;
- a selection made while `#q` has focus: Chrome reports text selected inside a
  field through the document selection, anchored on the field's parent, so
  selecting words of the question itself would point at the whole page;
- a selection made during the `page_exec` window: the model's code can move
  the selection, and the browser reports that as a trusted event.

## Keyboard

`Ctrl+Enter` or `Cmd+Enter` commits a turn. The input field is single-line and
is cleared immediately after a commit — atomically with building the diff,
inside the image: were this a separate message, the human could type in the gap
and the text would be lost. The baseline is re-seeded at the same time,
otherwise the next diff would report "was <what was just sent>". It works even
when focus is in the input field inside the image: a keyboard event does not
bubble from there up into the shell, since these are different origins, so the
image reports the keypress itself with a `commit` message. Synthetic events are
filtered out by `isTrusted`, so that the model's code cannot commit a turn on
the human's behalf.

## Debugging

The model's stream goes to `node`'s output: text, reasoning in a dimmed color,
and tool calls with their arguments — as they are generated.

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

161 tests on `node:test`. The image tests execute **the very text** of
`image-boot.js` that is loaded in the browser — through `new Function` in
jsdom. No test goes out to the network or reaches a model: the session is
substituted via `sessionFactory`, and the image's responses come through the
bridge.

## Verified live

A whole turn: the human typed "make a list of three items", the model called
`page_exec`, and three items appeared on the page. Twenty-five seconds.

Persistent storage: "remember in localStorage under the key `name` that my name
is Sergey" — the value was written and is visible from a separate tab on the
image's origin.

Reaching outward: "use bash to find out how many files are in the current
directory and show the number in #out" — the model went to `bash`, counted, and
wrote the answer onto the page.

## Known weak spots

- **Prompt injection** when reading other people's sites — there are no gates.
- **A human edit to the same node the model is editing** during a turn will be
  attributed to the model and lost. `MutationObserver` does not report
  authorship; attribution goes by the execution window with a grace period.
- **The reverse: what the model adds after an `await` in its own code** counts
  as the human's — unless it lands on a node the model already touched in that
  call. Past the first macrotask a human could have slipped in, so new nodes are
  not credited to the model. Such nodes reach the next diff as the human's
  additions, and they are not made editable by default. It shows up whenever
  the model's code fetches something and only then renders it.
- **The diff is lost on a network failure**: the image clears its buffers at
  build time, before it is known whether the request got through.
- **The model's text is only visible in `node`'s output**, not on the page. A
  turn that ends in text is handed back once (see the nudge above); if the model
  answers in text a second time, that text stays invisible to the human. The
  indicator only shows the fact that a turn is running.
- **Model selection has been removed from the interface** — the name is shown
  next to the button, but it cannot be changed from the page. It will come back
  as a separate task, via `session.setModel` and `session.cycleModel`.
- **Two tabs on one server** share a single session and a single bridge; the
  second tab will receive `page_exec` requests meant for the first.
- **The model's code can forge a `commit` message** and start a turn. The
  `isTrusted` filter in the image closes the path through a synthetic keydown,
  but nothing closes a direct `parent.postMessage`. The damage is limited:
  during a turn `commit()` returns immediately, and the diff would be empty —
  the model's own edits never go into it.

## Two things not to trip over

**`node --test test/` does not work on Node 26.5.0** — the runner tries to
resolve the directory as a module. `package.json` has a bare `node --test` with
no path; autodiscovery finds the same files.

**Paths with spaces.** `new URL(...).pathname` returns a percent-encoded path,
and ``import.meta.url === `file://${process.argv[1]}` `` evaluates to `false` —
because of the latter, `npm start` would silently exit having started nothing.
`fileURLToPath` is used everywhere.
