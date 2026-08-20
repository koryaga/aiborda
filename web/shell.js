const frame = document.getElementById('image');
const dot = document.getElementById('dot');
const sendBtn = document.getElementById('send');
const modelLabel = document.getElementById('model');
const log = document.getElementById('log');

let seq = 0;
const pending = new Map();
let imageAllowedOrigin = null;

const say = t => { log.textContent = t; };
const setState = s => { dot.textContent = s; };

// event.source — это конкретный window, который прислал сообщение; код
// модели способен сам вызвать parent.postMessage и подсунуть незапрошенный
// текст под видом ответа на наш запрос, поэтому сверяем ещё и id с картой
// ожидающих запросов. Теперь origin — настоящее значение, а не "null": образ
// живёт на своём порту, поэтому проверка стала осмысленной и добавлена рядом.
addEventListener('message', e => {
  if (e.source !== frame.contentWindow) return;
  if (imageAllowedOrigin && e.origin !== imageAllowedOrigin) return;
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'ready') { setState('свободна'); return; }
  const p = pending.get(m.id);
  if (!p) { say('незапрошенное сообщение от образа отброшено'); return; }
  pending.delete(m.id);
  clearTimeout(p.timer);
  p.resolve(m);
});

function ask(msg, timeout = 5000) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('образ не ответил за ' + timeout + ' мс'));
    }, timeout);
    pending.set(id, { resolve, timer });
    frame.contentWindow.postMessage({ ...msg, id }, imageAllowedOrigin ?? '*');
  });
}

// Модель ведёт pi, у нас её не выбирают — только показываем.
function showModel(m) {
  modelLabel.textContent = m ? m.provider + ' / ' + m.id : '—';
}

async function boot() {
  const { imageOrigin, model } = await fetch('api/config').then(r => r.json());
  imageAllowedOrigin = imageOrigin;
  showModel(model);
  frame.src = imageOrigin + '/image.html';
}

// Постоянный канал вниз: сервер сам инициирует page_exec посреди хода.
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
  es.addEventListener('agent', e => { setState(JSON.parse(e.data).type ?? 'думает'); });
  es.addEventListener('model', e => { showModel(JSON.parse(e.data)); });
  es.onerror = () => setState('связь потеряна');
}

// Кадры SSE разбираются вручную (EventSource не умеет POST). Три места,
// которые здесь не дозволено спускать молча:
//  - кадр может прийти разорванным между двумя чтениями сокета — buf
//    копится между итерациями и режется только по найденному "\n\n",
//    так что недочитанный хвост просто ждёт следующего чтения;
//  - "data:" в кадре может отсутствовать или быть кривым (обрыв
//    соединения на середине кадра, посторонний байт-мусор) — тогда
//    JSON.parse(undefined) уронит весь ход; кадр без данных пропускаем,
//    а не парсим наугад;
//  - поток может оборваться, не прислав ни "done", ни "error" (обрыв
//    сети, TCP reset). Если тихо считать это пустым ответом, ход будет
//    засчитан как легальный "пустой ответ", хотя код модели мог быть
//    потерян на середине передачи. Поэтому finished — обязателен.
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
  if (!finished) throw new Error('поток оборвался, не дождавшись ответа модели');
  if (error) throw new Error(error);
  return code;
}

async function commit() {
  // Горячая клавиша не знает про disabled кнопки — без этой проверки
  // Cmd/Ctrl+Enter во время уже идущего хода запускает второй commit()
  // поверх первого хода.
  if (sendBtn.disabled) return;
  sendBtn.disabled = true;
  try {
    const { text: diff } = await ask({ type: 'diff' });
    setState('думает');
    const res = await fetch('api/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diff }),
    });
    // Модель больше не возвращает код в ответе на commit — она сама зовёт
    // page_exec посреди хода через постоянный канал listen(). Здесь просто
    // дожидаемся конца потока (done/error).
    await readStream(res, () => {});
    setState('свободна');
  } catch (e) {
    say(String(e.message));
    setState('ошибка');
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
