const frame = document.getElementById('image');
const dot = document.getElementById('dot');
const sendBtn = document.getElementById('send');
const modelLabel = document.getElementById('model');
const log = document.getElementById('log');

let seq = 0;
const pending = new Map();
let imageAllowedOrigin = null;

const say = t => { log.textContent = t; };
// Three states instead of raw session event names: a human needs the fact
// "running / not running", not turn_start and message_update.
const STATES = { idle: 'idle', busy: 'turn in progress', error: 'error' };
const setState = s => {
  dot.dataset.state = s;
  dot.setAttribute('aria-label', STATES[s] ?? s);
};

// event.source is the specific window that sent the message; the model's code
// can call parent.postMessage itself and slip in unsolicited text disguised as
// a reply to our request, so we also check the id against the map of pending
// requests. The origin is now a real value rather than "null" — the image lives
// on its own port — so that check became meaningful and was added alongside.
addEventListener('message', e => {
  if (e.source !== frame.contentWindow) return;
  if (imageAllowedOrigin && e.origin !== imageAllowedOrigin) return;
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'ready') { setState('idle'); return; }
  // The human pressed Ctrl/Cmd+Enter inside the image. The image filters out
  // synthetic events, but the model's code can still forge this message
  // directly — the damage is limited: during a turn commit() returns
  // immediately, and the diff would be empty anyway.
  if (m.type === 'commit') { commit(); return; }
  const p = pending.get(m.id);
  if (!p) { say('dropped an unsolicited message from the image'); return; }
  pending.delete(m.id);
  clearTimeout(p.timer);
  p.resolve(m);
});

function ask(msg, timeout = 5000) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('the image did not answer within ' + timeout + ' ms'));
    }, timeout);
    pending.set(id, { resolve, timer });
    frame.contentWindow.postMessage({ ...msg, id }, imageAllowedOrigin ?? '*');
  });
}

// pi owns the model; we do not pick it here, we only display it.
function showModel(m) {
  modelLabel.textContent = m ? m.provider + ' / ' + m.id : '—';
}

async function boot() {
  const { imageOrigin, model } = await fetch('api/config').then(r => r.json());
  imageAllowedOrigin = imageOrigin;
  showModel(model);
  frame.src = imageOrigin + '/image.html';
}

// Persistent downstream channel: the server initiates page_exec on its own in
// the middle of a turn.
function listen() {
  const es = new EventSource('api/events');
  es.addEventListener('page_exec', async e => {
    const { id, code } = JSON.parse(e.data);
    let out;
    try {
      const r = await ask({ type: 'exec', code });
      out = { id, ok: r.ok, value: r.value, error: r.error };
    } catch (err) {
      out = { id, ok: false, error: String(err.message) };
    }
    fetch('api/page-result', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(out),
    });
  });
  es.addEventListener('agent', e => {
    const t = JSON.parse(e.data).type;
    setState(t === 'agent_settled' || t === 'agent_end' ? 'idle' : 'busy');
  });
  es.addEventListener('model', e => { showModel(JSON.parse(e.data)); });
  es.onerror = () => setState('error');
}

// SSE frames are parsed by hand (EventSource cannot POST). Three things that
// must not be swallowed silently here:
//  - a frame may arrive split across two socket reads — buf accumulates
//    between iterations and is only cut at a "\n\n" that was actually found,
//    so an incomplete tail simply waits for the next read;
//  - "data:" may be missing or malformed in a frame (a connection dropped
//    mid-frame, stray byte garbage) — then JSON.parse(undefined) would kill
//    the whole turn; a frame without data is skipped rather than parsed
//    blindly;
//  - the stream may end without ever sending "done" or "error" (a network
//    drop, a TCP reset). Quietly treating that as an empty answer would count
//    the turn as a legitimate "empty response", even though the model's code
//    could have been lost mid-transfer. Hence `finished` is mandatory.
async function readStream(res, onDelta) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', code = '', error = null, finished = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frameText = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!frameText) continue;
      const ev = {};
      for (const line of frameText.split('\n')) {
        const j = line.indexOf(':');
        if (j < 0) continue;
        ev[line.slice(0, j)] = line.slice(j + 1).trimStart();
      }
      if (ev.data === undefined) continue;
      let data;
      try { data = JSON.parse(ev.data); } catch { continue; }
      if (ev.event === 'delta') onDelta(data.text);
      else if (ev.event === 'done') { code = data.code; finished = true; }
      else if (ev.event === 'error') { error = data.message; finished = true; }
    }
  }
  if (!finished) throw new Error('the stream ended before the model answered');
  if (error) throw new Error(error);
  return code;
}

async function commit() {
  // The hotkey knows nothing about the button being disabled — without this
  // check, Cmd/Ctrl+Enter during a turn already in flight would start a second
  // commit() on top of the first one.
  if (sendBtn.disabled) return;
  sendBtn.disabled = true;
  try {
    const { text: diff } = await ask({ type: 'diff', clearInput: true });
    setState('busy');
    const res = await fetch('api/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diff }),
    });
    // The model no longer returns code in the reply to commit — it calls
    // page_exec itself mid-turn over the persistent channel from listen().
    // Here we just wait for the stream to end (done/error).
    await readStream(res, () => {});
    setState('idle');
  } catch (e) {
    say(String(e.message));
    setState('error');
  } finally {
    sendBtn.disabled = false;
  }
}

sendBtn.addEventListener('click', commit);
addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') commit();
});

await boot();
listen();
