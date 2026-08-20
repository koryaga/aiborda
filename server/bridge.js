// Мост от сервера к образу. Сервер не достаёт до образа напрямую: запрос
// уходит в оболочку по SSE, оболочка передаёт его образу через postMessage,
// и результат возвращается обратно POST-ом. Здесь живёт только сопоставление
// запросов с ответами.

export function createBridge({ send, timeoutMs = 15000 } = {}) {
  const pending = new Map();
  let seq = 0;
  let sender = send;

  function call(code) {
    if (!sender) return Promise.reject(new Error('оболочка не подключена'));
    const id = 'p' + (++seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`образ не ответил за ${timeoutMs} мс`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      sender({ type: 'page_exec', id, code });
    });
  }

  function deliver(msg) {
    const entry = pending.get(msg?.id);
    if (!entry) return false;          // чужой или повторный ответ
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
