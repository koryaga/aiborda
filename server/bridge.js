// The bridge from the server to the image. The server cannot reach the image
// directly: a request goes to the shell over SSE, the shell hands it to the
// image via postMessage, and the result comes back as a POST. Only the matching
// of requests to responses lives here.

export function createBridge({ send, timeoutMs = 15000 } = {}) {
  const pending = new Map();
  let seq = 0;
  let sender = send;

  function call(code) {
    if (!sender) return Promise.reject(new Error('the shell is not connected'));
    const id = 'p' + (++seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`the image did not answer within ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      sender({ type: 'page_exec', id, code });
    });
  }

  function deliver(msg) {
    const entry = pending.get(msg?.id);
    if (!entry) return false;          // someone else's answer, or a duplicate
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    entry.resolve(msg.ok
      ? { ok: true, value: msg.value }
      : { ok: false, error: msg.error });
    return true;
  }

  function reset(reason) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
  }

  return {
    call, deliver, reset,
    pendingCount: () => pending.size,
    setSender(fn) { sender = fn; },
  };
}
