import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';
import { frameTurn } from '../server/agent.js';

const PACKAGE_JSON_NEEDLE = '"name": "aiborda"';

async function withServer(opts, fn) {
  const app = createApp(opts);
  await app.listen(0, 0);
  try { await fn(`http://127.0.0.1:${app.port}`, app); } finally { await app.close(); }
}

// Writes an HTTP request straight into the socket, bypassing the WHATWG URL
// parsing that fetch() does on the client (and which already collapses "../"
// by itself). That way the request line reaches the server exactly as written
// here. The Host defaults to the correct one (127.0.0.1:port) so that the probe
// tests what its name claims rather than bouncing off the Host check early.
function rawRequest(port, target, { host } = {}) {
  const hostHeader = host ?? `127.0.0.1:${port}`;
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`GET ${target} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`);
    });
    const chunks = [];
    sock.on('data', c => chunks.push(c));
    sock.on('error', reject);
    sock.on('close', () => {
      const raw = Buffer.concat(chunks).toString('binary');
      const idx = raw.indexOf('\r\n\r\n');
      const head = idx === -1 ? raw : raw.slice(0, idx);
      const body = idx === -1 ? '' : raw.slice(idx + 4);
      const statusLine = head.split('\r\n')[0];
      const status = Number(statusLine.split(' ')[1]);
      resolve({ status, statusLine, body });
    });
  });
}

test('a request with a foreign Host is rejected with 403, one with the right Host (127.0.0.1 or localhost) goes through', async () => {
  // The loopback is not a boundary. An attacker's domain resolving to 127.0.0.1
  // makes the victim's browser send requests here with a foreign Host — that is
  // both DNS rebinding and a cross-site POST (CORS forbids reading the response,
  // not sending the request; a simple POST needs no preflight). The answer must
  // depend on the Host.
  await withServer({}, async (base, app) => {
    const bad = await rawRequest(app.port, '/api/config', { host: 'evil.example:80' });
    assert.equal(bad.status, 403);

    const goodIp = await rawRequest(app.port, '/api/config', { host: `127.0.0.1:${app.port}` });
    assert.equal(goodIp.status, 200);

    const goodLocalhost = await rawRequest(app.port, '/api/config', { host: `localhost:${app.port}` });
    assert.equal(goodLocalhost.status, 200);
  });
});

test('a second listen() on a busy port is rejected without taking the process down', async () => {
  const app1 = createApp({});
  const app2 = createApp({});
  try {
    await app1.listen(0, 0);
    // app2's imgPort is 0 as well (not app1.imagePort, which is taken, and not
    // the default 8731): otherwise app2's successful bind of the second port
    // would stay behind as an uncaught socket for the rest of the run —
    // assert.rejects catches Promise.all rejecting on the first failed promise,
    // but it neither cancels nor closes the neighbour that already came up.
    await assert.rejects(() => app2.listen(app1.port, 0), e => e.code === 'EADDRINUSE');
    // Before the fix, an unhandled 'error' event on the server killed the whole
    // node --test process (not just this check) — here we simply make sure app1
    // keeps answering as if nothing happened.
    const res = await fetch(`http://127.0.0.1:${app1.port}/api/config`);
    assert.equal(res.status, 200);
  } finally {
    await app2.close();
    await app1.close();
  }
});

test('GET // with a malformed path gets a 400 (the branch was live but uncovered)', async () => {
  await withServer({}, async (base, app) => {
    const { status } = await rawRequest(app.port, '//');
    assert.equal(status, 400);
  });
});

test('serveStatic: .html/.css get the right content-type, / serves index.html, a file with no dot is octet-stream, a non-ASCII name is decoded', async () => {
  const webRoot = await mkdtemp(join(tmpdir(), 'aiborda-web-'));
  try {
    await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>aiborda</title>', 'utf8');
    await writeFile(join(webRoot, 'style.css'), 'body { color: red }', 'utf8');
    const binBody = Buffer.from([0, 1, 2, 9, 253, 254, 255]);
    await writeFile(join(webRoot, 'noext'), binBody);
    await writeFile(join(webRoot, 'café.html'), '<p>a non-ASCII file name</p>', 'utf8');

    await withServer({ webRoot }, async base => {
      const idx = await fetch(base + '/');
      assert.equal(idx.status, 200);
      assert.match(idx.headers.get('content-type'), /text\/html/);
      assert.equal(await idx.text(), '<!doctype html><title>aiborda</title>');

      const css = await fetch(base + '/style.css');
      assert.equal(css.status, 200);
      assert.match(css.headers.get('content-type'), /text\/css/);
      assert.equal(await css.text(), 'body { color: red }');

      const noext = await fetch(base + '/noext');
      assert.equal(noext.status, 200);
      assert.equal(noext.headers.get('content-type'), 'application/octet-stream');
      assert.deepEqual(Buffer.from(await noext.arrayBuffer()), binBody);

      const nonAscii = await fetch(base + '/' + encodeURIComponent('café.html'));
      assert.equal(nonAscii.status, 200, 'a non-ASCII file name must be decoded and found on disk');
      assert.equal(await nonAscii.text(), '<p>a non-ASCII file name</p>');
    });
  } finally {
    await rm(webRoot, { recursive: true, force: true });
  }
});

async function readSse(res) {
  const out = [];
  for (const frame of (await res.text()).split('\n\n')) {
    if (!frame.trim()) continue;
    const ev = {};
    for (const line of frame.split('\n')) {
      const i = line.indexOf(':');
      ev[line.slice(0, i)] = line.slice(i + 1).trimStart();
    }
    out.push({ event: ev.event, data: JSON.parse(ev.data) });
  }
  return out;
}

function post(base, body) {
  return fetch(base + '/api/commit', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// A stub session for the tests below: it never reaches a real model, it only
// records the calls. Used through opts.sessionFactory.
function stubSession(calls, extra = {}) {
  return async () => ({
    session: {
      prompt: async text => { calls.push(text); },
      subscribe: () => () => {},
      abort: async () => { calls.push('abort'); },
      waitForIdle: async () => {},
      dispose: () => {},
      ...extra,
    },
  });
}

// --- Task 4: a turn through the pi session ---

test('commit starts a turn and returns a stream', async () => {
  const calls = [];
  const app = createApp({
    sessionFactory: async () => ({
      session: {
        prompt: async text => { calls.push(text); },
        subscribe: () => () => {},
        abort: async () => { calls.push('abort'); },
        waitForIdle: async () => {},
        dispose: () => {},
      },
    }),
  });
  await app.listen(0, 0);
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/commit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diff: '#q  "" -> "hello"' }),
    });
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(calls[0], frameTurn('#q  "" -> "hello"'));
  } finally { await app.close(); }
});

// --- The nudge: a turn that ended in text is handed back once ---

// A session whose last message is set by the test; sendCustomMessage records
// the nudge and, like a real follow-up turn, may replace the last message.
function nudgeSession({ first, afterNudge }) {
  const nudges = [];
  const events = [];
  let last = first;
  const session = {
    prompt: async () => { events.push('prompt'); },
    subscribe: () => () => {},
    abort: async () => {},
    waitForIdle: async () => { events.push('idle'); },
    dispose: () => {},
    get messages() { return last ? [last] : []; },
    sendCustomMessage: async (message, options) => {
      nudges.push({ message, options });
      events.push('nudge');
      last = afterNudge;
    },
  };
  return { factory: async () => ({ session }), nudges, events };
}

const say = text => ({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] });

test('a turn that ended in text gets one nudge, then the stream finishes', async () => {
  const s = nudgeSession({ first: say('The answer is 42.'), afterNudge: say('done') });
  await withServer({ sessionFactory: s.factory }, async base => {
    const body = await (await post(base, { diff: 'd' })).text();
    assert.match(body, /event: done/);
  });
  assert.equal(s.nudges.length, 1);
  assert.equal(s.nudges[0].options.triggerTurn, true);
  assert.ok(s.nudges[0].message.content.includes('The answer is 42.'));
  // the nudged turn is waited for before "done" goes out
  assert.deepEqual(s.events, ['prompt', 'idle', 'nudge', 'idle']);
});

test('a turn that ended without text, or with the log word, is not nudged', async () => {
  for (const first of [say('done'), { role: 'assistant', stopReason: 'stop', content: [] }]) {
    const s = nudgeSession({ first });
    await withServer({ sessionFactory: s.factory }, async base => {
      await (await post(base, { diff: 'd' })).text();
    });
    assert.equal(s.nudges.length, 0);
  }
});

test('a second miss is left alone: one nudge per human turn, no loop', async () => {
  const s = nudgeSession({ first: say('Here it is.'), afterNudge: say('Still text.') });
  await withServer({ sessionFactory: s.factory }, async base => {
    const body = await (await post(base, { diff: 'd' })).text();
    assert.match(body, /event: done/);
  });
  assert.equal(s.nudges.length, 1);
});

test('abort reaches the session', async () => {
  const calls = [];
  const app = createApp({
    sessionFactory: async () => ({
      session: { prompt: async () => {}, subscribe: () => () => {},
        abort: async () => { calls.push('abort'); }, waitForIdle: async () => {}, dispose: () => {} },
    }),
  });
  await app.listen(0, 0);
  try {
    await fetch(`http://127.0.0.1:${app.port}/api/commit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diff: 'd' }),
    }).then(r => r.text());
    await fetch(`http://127.0.0.1:${app.port}/api/abort`, { method: 'POST' });
    assert.ok(calls.includes('abort'));
  } finally { await app.close(); }
});

test("a page_exec result with someone else's id is dropped, the server stays alive", async () => {
  const app = createApp({});
  await app.listen(0, 0);
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/page-result`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'no-such-id', ok: true, value: 'x' }),
    });
    assert.equal(res.status, 200);
  } finally { await app.close(); }
});

test('a page_exec from the model reaches the SSE subscriber and comes back as a result', async () => {
  let callPage = null;
  const app = createApp({
    sessionFactory: async ({ callPage: fn }) => {
      callPage = fn;
      return { session: { prompt: async () => {}, subscribe: () => () => {},
        abort: async () => {}, waitForIdle: async () => {}, dispose: () => {} } };
    },
  });
  await app.listen(0, 0);
  let reader = null;
  try {
    // subscribe to the events, the way the shell does
    const es = await fetch(`http://127.0.0.1:${app.port}/api/events`);
    reader = es.body.getReader();
    const dec = new TextDecoder();

    // bring the session up — it is created lazily on the first turn
    await fetch(`http://127.0.0.1:${app.port}/api/commit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diff: 'd' }),
    }).then(r => r.text());

    const pending = callPage('return 2 + 2');
    // Keep reading until the request frame shows up: other events can be in the
    // stream, and one read() is not obliged to return a whole frame.
    let buf = '', m = null;
    for (let i = 0; i < 10 && !m; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      m = /"id":"(p\d+)"/.exec(buf);
    }
    assert.ok(m, 'the stream must carry a page_exec request with an id: ' + buf);

    await fetch(`http://127.0.0.1:${app.port}/api/page-result`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: m[1], ok: true, value: '4' }),
    });
    assert.deepEqual(await pending, { ok: true, value: '4' });
  } finally {
    // Release the stream before close(): otherwise the open connection holds the
    // server, and on a failed assert close() waits for it forever — the test
    // hangs instead of failing.
    try { await reader?.cancel(); } catch {}
    await app.close();
  }
});

test('stream headers: /api/commit answers with text/event-stream', async () => {
  await withServer({ sessionFactory: stubSession([]) }, async base => {
    const res = await post(base, { diff: 'd' });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    await res.text();
  });
});

test('a broken request body does not take the server down', async () => {
  await withServer({ sessionFactory: stubSession([]) }, async base => {
    const bad = await fetch(base + '/api/commit', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: 'this is not json {{{',
    });
    assert.notEqual(bad.status, 200);
    // The server must stay alive — the next normal request has to go through.
    const ok = await post(base, { diff: 'd' });
    assert.equal(ok.status, 200);
    await ok.text();
  });
});

test('/api/abort with no turn in flight does not fail and returns ok', async () => {
  await withServer({}, async base => {
    const res = await fetch(base + '/api/abort', { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

// --- Beyond the plan: robustness of the page_exec channel ---

test('the session fails to start (no model/key) — commit emits an error event, the server stays alive', async () => {
  await withServer({
    sessionFactory: async () => { throw new Error('no model available'); },
  }, async base => {
    const res = await post(base, { diff: 'd' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const events = await readSse(res);
    assert.equal(events.at(-1).event, 'error');
    assert.ok(events.at(-1).data.message.includes('no model available'));

    // the server is alive — an ordinary route still answers
    const alive = await fetch(base + '/api/abort', { method: 'POST' });
    assert.equal(alive.status, 200);
  });
});

test('the shell disconnected mid-turn: a page_exec call is rejected, the server stays alive', async () => {
  let callPage = null;
  await withServer({
    sessionFactory: async ({ callPage: fn }) => {
      callPage = fn;
      return { session: { prompt: async () => {}, subscribe: () => () => {},
        abort: async () => {}, waitForIdle: async () => {}, dispose: () => {} } };
    },
  }, async base => {
    const ctrl = new AbortController();
    await fetch(base + '/api/events', { signal: ctrl.signal });
    await post(base, { diff: 'd' }).then(r => r.text()); // brings the session up

    ctrl.abort(); // the shell disconnected — the only subscriber is gone
    await new Promise(r => setTimeout(r, 100)); // let the server process the close

    await assert.rejects(callPage('return 1'), /disconnected|not connected/);

    // the server is alive: an ordinary route still answers
    const alive = await fetch(base + '/api/abort', { method: 'POST' });
    assert.equal(alive.status, 200);
  });
});

test('two SSE subscribers: the request goes to both, a duplicate reply with the same id does not confuse the bridge', async () => {
  let callPage = null;
  await withServer({
    sessionFactory: async ({ callPage: fn }) => {
      callPage = fn;
      return { session: { prompt: async () => {}, subscribe: () => () => {},
        abort: async () => {}, waitForIdle: async () => {}, dispose: () => {} } };
    },
  }, async base => {
    const es1 = await fetch(base + '/api/events');
    const es2 = await fetch(base + '/api/events');
    const r1 = es1.body.getReader();
    const r2 = es2.body.getReader();
    const dec = new TextDecoder();

    await post(base, { diff: 'd' }).then(r => r.text());

    const pending = callPage('return 1 + 1');
    const id1 = /"id":"(p\d+)"/.exec(dec.decode((await r1.read()).value))?.[1];
    const id2 = /"id":"(p\d+)"/.exec(dec.decode((await r2.read()).value))?.[1];
    assert.ok(id1, 'the first subscriber must receive the page_exec request');
    assert.equal(id1, id2, 'both subscribers get the same request with the same id');

    await fetch(base + '/api/page-result', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: id1, ok: true, value: '2' }),
    });
    // a late reply from the second subscriber with the same id — the server must not trip over it
    const dup = await fetch(base + '/api/page-result', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: id1, ok: true, value: 'a different answer' }),
    });
    assert.equal(dup.status, 200);
    assert.deepEqual(await pending, { ok: true, value: '2' });

    r1.cancel(); r2.cancel();
  });
});

test('the shell reconnecting restores the page_exec channel', async () => {
  let callPage = null;
  await withServer({
    sessionFactory: async ({ callPage: fn }) => {
      callPage = fn;
      return { session: { prompt: async () => {}, subscribe: () => () => {},
        abort: async () => {}, waitForIdle: async () => {}, dispose: () => {} } };
    },
  }, async base => {
    await post(base, { diff: 'd' }).then(r => r.text()); // brings the session up

    const ctrl = new AbortController();
    await fetch(base + '/api/events', { signal: ctrl.signal });
    ctrl.abort();
    await new Promise(r => setTimeout(r, 100));
    await assert.rejects(callPage('a'), /disconnected|not connected/);

    // reconnect — a new SSE request must start accepting requests again
    const es2 = await fetch(base + '/api/events');
    const reader = es2.body.getReader();
    const dec = new TextDecoder();
    const pending = callPage('return 3');
    const m = /"id":"(p\d+)"/.exec(dec.decode((await reader.read()).value));
    assert.ok(m, 'after a reconnect the server must send requests into the SSE again');

    await fetch(base + '/api/page-result', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: m[1], ok: true, value: '3' }),
    });
    assert.deepEqual(await pending, { ok: true, value: '3' });
    reader.cancel();
  });
});

test('escaping web/ is forbidden: traversals over a raw socket, bypassing client-side normalization', async () => {
  // web/ does not exist by default (DEFAULT_WEB_ROOT), so the only file that
  // could actually be read via a traversal is the repository's package.json (it
  // is one level above web/). Were containment broken, one of these requests
  // would return 200 with its contents.
  const real = await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8');
  assert.ok(real.includes(PACKAGE_JSON_NEEDLE), 'the reference string must be in the real package.json');

  await withServer({}, async (base, app) => {
    const probes = [
      '/../package.json',              // a literal ".." — new URL() clamps it to the root while parsing the pathname
      '/%2e%2e/package.json',          // percent-encoded dots — the WHATWG URL parser recognizes %2e as "." when looking for dot segments
      '/%2e%2e%2fpackage.json',        // dots and slash encoded together — one segment on input, which decodeURIComponent turns into "/../package.json" and normalize() clamps
      '/..%2fpackage.json',            // literal dots, encoded slash (%2f) — decodeURIComponent yields a real "../", but the pathname is always absolute: normalize() clamps "../" to the root rather than letting it escape
      '/..%2Fpackage.json',            // the same in upper case
      '/..\\package.json',             // a backslash — for the http scheme the WHATWG URL parser treats it as "/" during parsing, after which it is an ordinary ".."
      '/..%5cpackage.json',            // an encoded backslash (lower case) — after decoding this is a literal "\" inside the file name (not a separator on POSIX), looked up as one plausible file and not found
      '/..%5Cpackage.json',            // the same in upper case
      '/foo/%2e%2e/%2e%2e/package.json', // a nested traversal out of a subdirectory
      '/./../package.json',            // mixed segments
      '/etc/passwd',                   // an absolute path with no traversal — catches the join() vs resolve() bug
      '//etc/passwd',                  // "//" — the WHATWG URL parser reads this as protocol-relative: "etc" becomes a (bogus) host during parsing and the pathname collapses to "/passwd", so the traversal logic in serveStatic is never reached in the usual form
      '/package.json%00.html',         // a null byte after a real name — decodeURIComponent yields a literal \0 in the name, fs.readFile throws on such a path and it is caught as a 404
      '/%00package.json',              // a null byte at the start of the name
      '/index.html%00',                // a null byte at the end
    ];

    for (const target of probes) {
      const { status, body } = await rawRequest(app.port, target);
      assert.notEqual(status, 200, `${target} must not return 200`);
      assert.equal(status, 404, `${target} must get a 404`);
      assert.equal(body.includes(PACKAGE_JSON_NEEDLE), false, `${target} must not serve the contents of package.json`);
    }
  });
});

// --- Task 3: the image on its own origin ---

test('the image is served from the second port', async () => {
  const app = createApp({});
  await app.listen(0, 0);
  try {
    assert.notEqual(app.port, app.imagePort);
    const res = await fetch(`http://127.0.0.1:${app.imagePort}/image.html`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('id="q"'), 'the scaffold is in place');
    assert.ok(html.includes('image-boot.js'), 'the loader is wired up');
    assert.equal(html.includes('sandbox'), false, 'the sandbox attribute is not used');
  } finally { await app.close(); }
});

test("/api/config returns the image's origin", async () => {
  const app = createApp({});
  await app.listen(0, 0);
  try {
    const body = await (await fetch(`http://127.0.0.1:${app.port}/api/config`)).json();
    assert.equal(body.imageOrigin, `http://127.0.0.1:${app.imagePort}`);
  } finally { await app.close(); }
});

test('the image port checks Host the same way the shell does', async () => {
  // fetch() does not let you override the Host header — undici (like the browser
  // fetch) treats it as forbidden and quietly sends the real address instead of
  // the given one (verified: with headers:{host:'evil.example'} the server still
  // sees 127.0.0.1:port). That is exactly why the shell's Host check already
  // uses rawRequest — the same trick is needed here.
  const app = createApp({});
  await app.listen(0, 0);
  try {
    const bad = await rawRequest(app.imagePort, '/image.html', { host: 'evil.example' });
    assert.equal(bad.status, 403);
    const good = await rawRequest(app.imagePort, '/image.html');
    assert.equal(good.status, 200);
  } finally { await app.close(); }
});

test('image-boot.js is served from the second port', async () => {
  const app = createApp({});
  await app.listen(0, 0);
  try {
    const res = await fetch(`http://127.0.0.1:${app.imagePort}/image-boot.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    assert.match(await res.text(), /function createImage/);
  } finally { await app.close(); }
});

test('on the image port "/" serves image.html with the right content-type', async () => {
  const app = createApp({});
  await app.listen(0, 0);
  try {
    const res = await fetch(`http://127.0.0.1:${app.imagePort}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(await res.text(), /id="q"/);
  } finally { await app.close(); }
});
