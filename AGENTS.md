# aiborda

Instructions for agents working on this code. They are **not** addressed to the
model behind the page: its contract lives in `server/system-prompt.md`, and this
file is filtered out of that model's context (`agentsFilesOverride` in
`server/agent.js`).

aiborda is an HTML page that serves as the interface to
[pi](https://github.com/earendil-works/pi): the human edits the page, the model
receives a diff of their edits and answers by changing the page through the
`page_exec` tool.

## Before changing anything

Read `docs/DEVELOPMENT.md`: the architecture, the two-port isolation, how a turn
goes, how the human's edits are caught, and the known weak spots. The
invariants there are load-bearing:

- the model reaches the page only through `page_exec`; the page cannot reach
  the shell (separate origins, not `sandbox`);
- the model is never sent a snapshot of the page, only the diff;
- both servers check the `Host` header — binding to the loopback is not enough.

`web/image-boot.js` is the most delicate part: mutation attribution, coalescing
and diff building. Change it only together with `test/image-diff.test.js` and
`test/image-exec.test.js`.

## Running and testing

```bash
npm install
npm start      # http://127.0.0.1:8730
npm test       # node:test; no network, no model
```

Run `node --test` without a path: `node --test test/` fails on Node 26.5.0.

## Conventions

- English in code, comments and docs. Comments explain why, not what.
- Plain ES modules, no build step.
- Runtime dependencies are pi and `typebox`. Adding one is a decision to raise,
  not make in passing — see why the server uses SSE rather than `ws`.
