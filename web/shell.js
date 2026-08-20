const frame = document.getElementById('image');
const modelSel = document.getElementById('model');
const dot = document.getElementById('dot');
const sendBtn = document.getElementById('send');
const log = document.getElementById('log');

let seq = 0;
const pending = new Map();
let lastResult;

const say = t => { log.textContent = t; };
const setState = s => { dot.textContent = s; };

// Единственная валидная проверка отправителя: у sandbox-фрейма event.origin
// всегда "null", сравнивать его бессмысленно. event.source — это конкретный
// window, который прислал сообщение; код модели способен сам вызвать
// parent.postMessage и подсунуть незапрошенный текст под видом ответа на
// наш запрос, поэтому сверяем ещё и id с картой ожидающих запросов.
addEventListener('message', e => {
  if (e.source !== frame.contentWindow) return;
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
    frame.contentWindow.postMessage({ ...msg, id }, '*');
  });
}

async function boot() {
  const [seed, bootJs] = await Promise.all([
    fetch('seed.html').then(r => r.text()),
    fetch('image-boot.js').then(r => r.text()),
  ]);
  const call = 'createImage(document, m => parent.postMessage(m, "*")).install();';
  frame.srcdoc = seed + '<scr' + 'ipt>' + bootJs + '\n' + call + '</scr' + 'ipt>';
}

async function loadModels() {
  const r = await fetch('api/models').then(r => r.json());
  modelSel.replaceChildren();
  for (const m of r.models) {
    const o = document.createElement('option');
    o.value = m.provider + ' ' + m.id;
    o.textContent = m.provider + ' / ' + m.id;
    modelSel.append(o);
  }
  // Умолчание из настроек pi. Если такой модели нет в отобранном списке —
  // остаётся первая, как было.
  if (r.default) {
    const want = r.default.provider + ' ' + r.default.id;
    if ([...modelSel.options].some(o => o.value === want)) modelSel.value = want;
  }
  if (r.error) say(r.error);
  else if (r.notes?.length) say(r.notes.join('\n'));
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
  // поверх первого: оба читают/пишут один и тот же lastResult и общую
  // историю сервера, и как раз тот инвариант "результат уезжает ровно
  // один раз", который мы защищаем, ломается гонкой.
  if (sendBtn.disabled) return;
  if (!modelSel.value) { say('нет доступных моделей — проверьте models.json'); return; }
  sendBtn.disabled = true;
  try {
    const { text: diff } = await ask({ type: 'diff' });
    const [provider, id] = modelSel.value.split(' ');
    setState('думает');
    let shown = '';
    const res = await fetch('api/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: { provider, id }, diff, result: lastResult }),
    });
    // С этой точки запрос точно дошёл до сервера: pushResult/pushDiff там
    // выполняются синхронно ДО того, как уйдут заголовки ответа — то есть
    // раньше, чем к нам сюда вернётся управление из await fetch. Значит
    // lastResult уже лёг в историю сервера независимо от того, как сложится
    // поток дальше (в том числе если он оборвётся с ошибкой) — и его нельзя
    // послать повторно при следующем ходе. Сбрасываем сразу, а не после
    // чтения потока и не после exec.
    lastResult = undefined;
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || ('сервер ответил ' + res.status));
    }
    const code = await readStream(res, d => { shown += d; say(shown); });
    if (!code) { say('пустой ответ — ход засчитан, образ не тронут'); setState('свободна'); return; }
    const r = await ask({ type: 'exec', code });
    if (r.ok) {
      // Успешный exec даёт новое значение — оно уедет ровно на следующем
      // ходу (лежит в lastResult только с этого момента и до следующего
      // commit(), где снова будет сброшено сразу после отправки).
      lastResult = r.value;
      say(code);
      setState('свободна');
    } else {
      // Ошибка exec: lastResult уже undefined (сброшен выше, до exec), и
      // трогать его тут не нужно — значение, из-за которого код бросил,
      // никогда не было получено (fn бросила раньше return), докладывать
      // на следующем ходу нечего.
      say('ошибка исполнения:\n' + r.error);
      setState('ошибка');
    }
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
await loadModels();
