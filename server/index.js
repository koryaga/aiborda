import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge } from './bridge.js';
import { frameTurn, nudgeMessage, startSession, strayText } from './agent.js';
import { createPrinter } from './stream-log.js';

const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));

function withTrailingSlash(p) {
  return p.endsWith('/') ? p : p + '/';
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// We read the request body ourselves: the built-in http module does not parse
// JSON. Broken JSON is not swallowed here — it throws outward, and the calling
// code (the route handler inside createServer's shared try/catch) decides how
// to answer without taking the process down.
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(text ? JSON.parse(text) : {}); }
      catch (e) { reject(new Error('malformed request body: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

async function serveStatic(res, pathname, root) {
  // The order here matters: decodeURIComponent → normalize → join → startsWith.
  // new URL(req.url, ...) in the handler below collapses dot segments in the
  // pathname (including the %2e form — the WHATWG parser does that itself), but
  // it does not decode percent escapes at all, and it encodes non-ASCII instead.
  // So without decodeURIComponent a file in web/ with a non-ASCII name would
  // never be found. decodeURIComponent can re-create "/../" out of "%2e%2e%2f" —
  // but the pathname is always absolute (it starts with "/"), and normalize() on
  // an absolute path clamps "../" to the root rather than letting it escape
  // above it. normalize and startsWith(root) are the two real lines of defense;
  // join (not resolve!) is what stops an absolute second argument from replacing
  // the base entirely.
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { return json(res, 400, { error: 'malformed path' }); }
  const rel = normalize(decoded === '/' ? '/index.html' : decoded);
  const file = join(root, rel);
  if (!file.startsWith(root)) return json(res, 404, { error: 'not found' });
  try {
    const body = await readFile(file);
    const dot = rel.lastIndexOf('.');
    const ext = dot === -1 ? '' : rel.slice(dot);
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
    res.end(body);
  } catch { json(res, 404, { error: 'not found' }); }
}

export function createApp(opts = {}) {
  const state = { opts, abort: null, session: null };
  const root = withTrailingSlash(opts.webRoot ?? DEFAULT_WEB_ROOT);

  const bridge = createBridge({ send: null });
  // The model's stream goes to stdout: text, reasoning and tool calls as they
  // are generated. opts.print === false silences it in tests.
  const printEvent = opts.print === false ? () => {} : createPrinter();

  // pi owns the model: we have no configuration of our own, so we simply ask
  // the session. Before the first turn there is no session yet — then null.
  const modelRef = () => {
    const m = state.session?.model;
    return m ? { provider: m.provider, id: m.id } : null;
  };
  const listeners = new Set();

  // The shell keeps an SSE connection open; over it the server sends page_exec
  // requests and session events. The way back is a plain POST: Node has no
  // WebSocket server, and pulling in ws for a single channel is not worth it.
  function broadcast(event, data) {
    for (const res of listeners) {
      try { sse(res, event, data); } catch { listeners.delete(res); }
    }
  }

  async function ensureSession() {
    if (state.session) return state.session;
    const factory = opts.sessionFactory ?? startSession;
    const { session } = await factory({ callPage: code => bridge.call(code) });
    state.session = session;
    session.subscribe(ev => {
      if (!ev?.type) return;
      broadcast('agent', { type: ev.type });
      if (ev.type === 'model_select') broadcast('model', modelRef());
      printEvent(ev);
    });
    return session;
  }

  async function handleCommit(req, res) {
    const body = await readJson(req);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    // ensureSession() is inside the try, not before writeHead: if the session
    // fails to come up (no model, no key), that has to go out as an error event
    // inside the stream that has already begun, not derail the response back
    // into a JSON 500 from the outer catch — the shell expects SSE on this
    // route specifically.
    try {
      const session = await ensureSession();
      await session.prompt(frameTurn(String(body.diff ?? '')));
      await session.waitForIdle();
      // A closing remark in text is the model's native habit, and the prompt
      // only weakens it. If the turn still ended in text, hand it back once so
      // the model moves it onto the page; a second miss is left alone rather
      // than looped on. A turn with no text at all is fine as it is.
      const stray = strayText(session.messages);
      if (stray !== null) {
        await session.sendCustomMessage(nudgeMessage(stray), { triggerTurn: true });
        await session.waitForIdle();
      }
      sse(res, 'done', {});
    } catch (e) {
      sse(res, 'error', { message: String(e.message) });
    } finally {
      res.end();
    }
  }

  const server = createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); }
    catch {
      if (res.headersSent) return res.destroy();
      return json(res, 400, { error: 'malformed request' });
    }

    // The loopback is not a boundary. An attacker's domain that resolves to
    // 127.0.0.1 (DNS rebinding) makes the victim's browser send requests here
    // with someone else's Host — and that can be a read (an error message with
    // the OS user name in the path) or a write (/api/commit). A cross-site POST
    // is a simple request; no preflight is needed. CORS forbids reading someone
    // else's response, not sending the request, so the absence of CORS headers
    // is not a defense in itself. We answer only when the client actually aimed
    // at this address.
    const port = server.address()?.port;
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!allowedHosts.has(String(req.headers.host).toLowerCase())) {
      return json(res, 403, { error: 'disallowed Host' });
    }

    try {
      if (url.pathname === '/api/commit' && req.method === 'POST') return await handleCommit(req, res);
      if (url.pathname === '/api/abort' && req.method === 'POST') {
        if (state.session) await state.session.abort();
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/config') {
        return json(res, 200, { imageOrigin: `http://127.0.0.1:${imageServer.address()?.port}`, model: modelRef() });
      }
      if (url.pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        // writeHead() by itself sends nothing to the socket — Node buffers the
        // headers until the first write()/end(). Here an arbitrary amount of
        // time can pass before the first event (the page is waiting for a
        // page_exec request), so without an explicit flushHeaders() the client
        // would hang waiting for the response status itself, not just the data.
        res.flushHeaders();
        listeners.add(res);
        // Every new connection re-installs the bridge's sender — that is how
        // the channel is restored after the shell reconnects: while at least
        // one listener is alive the bridge can send requests; when the last one
        // closes it goes mute and rejects everyone waiting.
        bridge.setSender(m => broadcast('page_exec', m));
        req.on('close', () => {
          listeners.delete(res);
          if (listeners.size === 0) {
            bridge.setSender(null);
            bridge.reset('the shell disconnected');
          }
        });
        return;
      }
      if (url.pathname === '/api/page-result' && req.method === 'POST') {
        bridge.deliver(await readJson(req));
        return json(res, 200, { ok: true });
      }
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'no such method' });
      return await serveStatic(res, url.pathname, root);
    } catch (e) {
      if (res.headersSent) return res.destroy();
      return json(res, 500, { error: String(e.message) });
    }
  });

  // The image lives on a separate port, and that is the whole isolation
  // mechanism: a different origin gives it localStorage and the rest of HTML5,
  // but denies it any reach into the shell. The sandbox attribute is not used —
  // it would give less, and worse.
  const imageServer = createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); }
    catch {
      if (res.headersSent) return res.destroy();
      return json(res, 400, { error: 'malformed request' });
    }
    const p = imageServer.address()?.port;
    const allowed = new Set([`127.0.0.1:${p}`, `localhost:${p}`]);
    if (!allowed.has(String(req.headers.host).toLowerCase())) {
      return json(res, 403, { error: 'disallowed Host' });
    }
    const path = url.pathname === '/' ? '/image.html' : url.pathname;
    // `root` is the constant already computed in createApp, with a trailing
    // slash, rather than the raw opts.webRoot: the startsWith check rests on
    // that slash.
    return await serveStatic(res, path, root);
  });

  return {
    server, imageServer, state,
    get port() { return server.address()?.port; },
    get imagePort() { return imageServer.address()?.port; },
    listen(port = 8730, imgPort = 8731) {
      const up = (srv, p) => new Promise((resolve, reject) => {
        const onError = e => reject(e);
        srv.once('error', onError);
        srv.listen(p, '127.0.0.1', () => { srv.removeListener('error', onError); resolve(); });
      });
      return Promise.all([up(server, port), up(imageServer, imgPort)]);
    },
    // Bring the session up ahead of time so the model name is known before the
    // first turn. Called only from the entry point: tests create the session
    // with their own stub.
    warmup: () => ensureSession(),
    close() {
      return Promise.all([
        new Promise(r => server.close(r)),
        new Promise(r => imageServer.close(r)),
      ]);
    },
  };
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = createApp({});
  await app.listen(8730, 8731);
  console.log('aiborda is listening on http://127.0.0.1:8730, the image on http://127.0.0.1:8731');
  try {
    const s = await app.warmup();
    const m = s.model;
    console.log('model:', m ? `${m.provider}/${m.id}` : '(undetermined)');
  } catch (e) {
    console.log('the session failed to start:', e.message);
  }
}
