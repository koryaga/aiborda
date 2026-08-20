import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';

const PACKAGE_JSON_NEEDLE = '"name": "dom-agent"';

async function withServer(opts, fn) {
  const app = createApp(opts);
  await app.listen(0, 0);
  try { await fn(`http://127.0.0.1:${app.port}`, app); } finally { await app.close(); }
}

// Пишет HTTP-запрос напрямую в сокет, минуя WHATWG URL-парсинг, который делает
// fetch() на клиенте (и который уже сам схлопывает "../"). Так строка запроса
// доходит до сервера ровно в том виде, в каком написана здесь. Host по
// умолчанию — правильный (127.0.0.1:port), чтобы проба тестировала именно то,
// что заявлено в её названии, а не отлетала на проверке Host раньше времени.
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

test('запрос с чужим Host отклоняется 403, с правильным (127.0.0.1 или localhost) — проходит', async () => {
  // Петля — не граница. Домен атакующего, резолвящийся в 127.0.0.1, заставляет
  // браузер жертвы слать сюда запросы с чужим Host — это и DNS rebinding, и
  // межсайтовый POST (CORS запрещает читать ответ, а не отправлять запрос;
  // preflight простой POST не требует). Ответ должен зависеть от Host.
  await withServer({}, async (base, app) => {
    const bad = await rawRequest(app.port, '/api/config', { host: 'evil.example:80' });
    assert.equal(bad.status, 403);

    const goodIp = await rawRequest(app.port, '/api/config', { host: `127.0.0.1:${app.port}` });
    assert.equal(goodIp.status, 200);

    const goodLocalhost = await rawRequest(app.port, '/api/config', { host: `localhost:${app.port}` });
    assert.equal(goodLocalhost.status, 200);
  });
});

test('второй listen() на занятый порт отклоняется, не роняя процесс', async () => {
  const app1 = createApp({});
  const app2 = createApp({});
  try {
    await app1.listen(0, 0);
    // imgPort у app2 — тоже 0 (а не занятый app1.imagePort и не дефолтный
    // 8731): иначе успешный bind второго порта app2 остался бы висеть
    // непойманным сокетом до конца прогона тестов — assert.rejects ловит
    // отказ Promise.all по первому упавшему промису, но не отменяет и не
    // закрывает уже поднявшийся сосед.
    await assert.rejects(() => app2.listen(app1.port, 0), e => e.code === 'EADDRINUSE');
    // До фикса необработанное 'error'-событие на сервере убивало весь процесс
    // node --test (а не только эту проверку) — здесь просто убеждаемся, что
    // app1 как ни в чём не бывало продолжает отвечать.
    const res = await fetch(`http://127.0.0.1:${app1.port}/api/config`);
    assert.equal(res.status, 200);
  } finally {
    await app2.close();
    await app1.close();
  }
});

test('GET // с некорректным путём получает 400 (ветка была живой, но не покрытой)', async () => {
  await withServer({}, async (base, app) => {
    const { status } = await rawRequest(app.port, '//');
    assert.equal(status, 400);
  });
});

test('serveStatic: .html/.css с правильным content-type, / отдаёт index.html, файл без точки — octet-stream, кириллица в имени раскодируется', async () => {
  const webRoot = await mkdtemp(join(tmpdir(), 'dom-agent-web-'));
  try {
    await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>дом-агент</title>', 'utf8');
    await writeFile(join(webRoot, 'style.css'), 'body { color: red }', 'utf8');
    const binBody = Buffer.from([0, 1, 2, 9, 253, 254, 255]);
    await writeFile(join(webRoot, 'noext'), binBody);
    await writeFile(join(webRoot, 'файл.html'), '<p>кириллица в имени файла</p>', 'utf8');

    await withServer({ webRoot }, async base => {
      const idx = await fetch(base + '/');
      assert.equal(idx.status, 200);
      assert.match(idx.headers.get('content-type'), /text\/html/);
      assert.equal(await idx.text(), '<!doctype html><title>дом-агент</title>');

      const css = await fetch(base + '/style.css');
      assert.equal(css.status, 200);
      assert.match(css.headers.get('content-type'), /text\/css/);
      assert.equal(await css.text(), 'body { color: red }');

      const noext = await fetch(base + '/noext');
      assert.equal(noext.status, 200);
      assert.equal(noext.headers.get('content-type'), 'application/octet-stream');
      assert.deepEqual(Buffer.from(await noext.arrayBuffer()), binBody);

      const cyr = await fetch(base + '/' + encodeURIComponent('файл.html'));
      assert.equal(cyr.status, 200, 'кириллическое имя файла должно раскодироваться и находиться на диске');
      assert.equal(await cyr.text(), '<p>кириллица в имени файла</p>');
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

// Подставная сессия для тестов ниже: не ходит к настоящей модели, только
// запоминает вызовы. Используется через opts.sessionFactory.
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

// --- Задача 4: ход через сессию pi ---

test('commit запускает ход и отдаёт поток', async () => {
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
      body: JSON.stringify({ diff: '#q  "" -> "привет"' }),
    });
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(calls[0], '#q  "" -> "привет"');
  } finally { await app.close(); }
});

test('abort доходит до сессии', async () => {
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
      body: JSON.stringify({ diff: 'д' }),
    }).then(r => r.text());
    await fetch(`http://127.0.0.1:${app.port}/api/abort`, { method: 'POST' });
    assert.ok(calls.includes('abort'));
  } finally { await app.close(); }
});

test('результат page_exec с чужим id отбрасывается, сервер жив', async () => {
  const app = createApp({});
  await app.listen(0, 0);
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/page-result`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'нет-такого', ok: true, value: 'x' }),
    });
    assert.equal(res.status, 200);
  } finally { await app.close(); }
});

test('page_exec от модели доходит до подписчика SSE и возвращается результатом', async () => {
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
    // подписываемся на события, как это делает оболочка
    const es = await fetch(`http://127.0.0.1:${app.port}/api/events`);
    reader = es.body.getReader();
    const dec = new TextDecoder();

    // поднимаем сессию — она создаётся лениво при первом ходе
    await fetch(`http://127.0.0.1:${app.port}/api/commit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diff: 'д' }),
    }).then(r => r.text());

    const pending = callPage('return 2 + 2');
    // Читаем, пока не увидим кадр с запросом: в потоке могут идти и другие
    // события, и один read() не обязан вернуть целый кадр.
    let buf = '', m = null;
    for (let i = 0; i < 10 && !m; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      m = /"id":"(p\d+)"/.exec(buf);
    }
    assert.ok(m, 'в потоке должен быть запрос page_exec с id: ' + buf);

    await fetch(`http://127.0.0.1:${app.port}/api/page-result`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: m[1], ok: true, value: '4' }),
    });
    assert.deepEqual(await pending, { ok: true, value: '4' });
  } finally {
    // Отпускаем поток до close(): иначе открытое соединение держит сервер,
    // и при упавшем ассерте close() ждёт его вечно — тест виснет вместо падения.
    try { await reader?.cancel(); } catch {}
    await app.close();
  }
});

test('заголовки потока: /api/commit отвечает text/event-stream', async () => {
  await withServer({ sessionFactory: stubSession([]) }, async base => {
    const res = await post(base, { diff: 'д' });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    await res.text();
  });
});

test('битое тело запроса не роняет сервер', async () => {
  await withServer({ sessionFactory: stubSession([]) }, async base => {
    const bad = await fetch(base + '/api/commit', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: 'это не json {{{',
    });
    assert.notEqual(bad.status, 200);
    // Сервер должен остаться живым — следующий нормальный запрос обязан пройти.
    const ok = await post(base, { diff: 'д' });
    assert.equal(ok.status, 200);
    await ok.text();
  });
});

test('/api/abort без активного хода не падает и отдаёт ok', async () => {
  await withServer({}, async base => {
    const res = await fetch(base + '/api/abort', { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

// --- Дополнительно к плану: устойчивость канала page_exec ---

test('сессия не поднимается (нет модели/ключа) — commit отдаёт error-событие, сервер жив', async () => {
  await withServer({
    sessionFactory: async () => { throw new Error('нет доступной модели'); },
  }, async base => {
    const res = await post(base, { diff: 'д' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const events = await readSse(res);
    assert.equal(events.at(-1).event, 'error');
    assert.ok(events.at(-1).data.message.includes('нет доступной модели'));

    // сервер жив — обычный маршрут всё ещё отвечает
    const alive = await fetch(base + '/api/abort', { method: 'POST' });
    assert.equal(alive.status, 200);
  });
});

test('оболочка отключилась посреди хода: вызов page_exec отклоняется, сервер жив', async () => {
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
    await post(base, { diff: 'д' }).then(r => r.text()); // поднимает сессию

    ctrl.abort(); // оболочка отключилась — единственный подписчик ушёл
    await new Promise(r => setTimeout(r, 100)); // дать серверу обработать close

    await assert.rejects(callPage('return 1'), /отключилась|не подключена/);

    // сервер жив: обычный маршрут всё ещё отвечает
    const alive = await fetch(base + '/api/abort', { method: 'POST' });
    assert.equal(alive.status, 200);
  });
});

test('два подписчика SSE: запрос уходит в оба, повторный ответ с тем же id не путает мост', async () => {
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

    await post(base, { diff: 'д' }).then(r => r.text());

    const pending = callPage('return 1 + 1');
    const id1 = /"id":"(p\d+)"/.exec(dec.decode((await r1.read()).value))?.[1];
    const id2 = /"id":"(p\d+)"/.exec(dec.decode((await r2.read()).value))?.[1];
    assert.ok(id1, 'первый подписчик должен получить запрос page_exec');
    assert.equal(id1, id2, 'оба подписчика получают один и тот же запрос с одним id');

    await fetch(base + '/api/page-result', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: id1, ok: true, value: '2' }),
    });
    // запоздавший ответ второго подписчика с тем же id — сервер не должен споткнуться
    const dup = await fetch(base + '/api/page-result', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: id1, ok: true, value: 'другой ответ' }),
    });
    assert.equal(dup.status, 200);
    assert.deepEqual(await pending, { ok: true, value: '2' });

    r1.cancel(); r2.cancel();
  });
});

test('переподключение оболочки восстанавливает канал page_exec', async () => {
  let callPage = null;
  await withServer({
    sessionFactory: async ({ callPage: fn }) => {
      callPage = fn;
      return { session: { prompt: async () => {}, subscribe: () => () => {},
        abort: async () => {}, waitForIdle: async () => {}, dispose: () => {} } };
    },
  }, async base => {
    await post(base, { diff: 'д' }).then(r => r.text()); // поднимает сессию

    const ctrl = new AbortController();
    await fetch(base + '/api/events', { signal: ctrl.signal });
    ctrl.abort();
    await new Promise(r => setTimeout(r, 100));
    await assert.rejects(callPage('a'), /отключилась|не подключена/);

    // переподключение — новый SSE-запрос должен снова принимать запросы
    const es2 = await fetch(base + '/api/events');
    const reader = es2.body.getReader();
    const dec = new TextDecoder();
    const pending = callPage('return 3');
    const m = /"id":"(p\d+)"/.exec(dec.decode((await reader.read()).value));
    assert.ok(m, 'после переподключения сервер снова должен слать запросы в SSE');

    await fetch(base + '/api/page-result', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: m[1], ok: true, value: '3' }),
    });
    assert.deepEqual(await pending, { ok: true, value: '3' });
    reader.cancel();
  });
});

test('выход за пределы web/ запрещён: обходы через сырой сокет, минуя нормализацию клиента', async () => {
  // web/ ещё не существует по умолчанию (DEFAULT_WEB_ROOT), поэтому единственный
  // файл, который реально можно было бы прочитать через обход наружу — это
  // package.json репозитория (он на один уровень выше web/). Если бы контейнмент
  // был сломан, один из этих запросов вернул бы 200 с его содержимым.
  const real = await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8');
  assert.ok(real.includes(PACKAGE_JSON_NEEDLE), 'сверочная строка должна быть в реальном package.json');

  await withServer({}, async (base, app) => {
    const probes = [
      '/../package.json',              // буквальный ".." — new URL() клэмпит его к корню ещё при разборе pathname
      '/%2e%2e/package.json',          // процентное кодирование точек — WHATWG URL распознаёт %2e как "." при поиске dot-сегментов
      '/%2e%2e%2fpackage.json',        // точки и слэш закодированы вместе — один сегмент на входе, после decodeURIComponent превращается в "/../package.json" и клэмпится normalize()
      '/..%2fpackage.json',            // точки буквальные, слэш закодирован (%2f) — decodeURIComponent даёт настоящий "../", но pathname всегда абсолютный: normalize() клэмпит "../" к корню, а не выпускает выше него
      '/..%2Fpackage.json',            // то же в верхнем регистре
      '/..\\package.json',             // обратный слэш — для http-схемы WHATWG URL приравнивает его к "/" ещё на этапе разбора, дальше как обычный ".."
      '/..%5cpackage.json',            // обратный слэш закодирован (нижний регистр) — после decode это буквальный символ "\" внутри имени файла (не разделитель на POSIX), ищется как один опознаваемый файл и не находится
      '/..%5Cpackage.json',            // то же в верхнем регистре
      '/foo/%2e%2e/%2e%2e/package.json', // вложенный обход из подкаталога
      '/./../package.json',            // смешанные сегменты
      '/etc/passwd',                   // абсолютный путь без обхода — ловит баг join() vs resolve()
      '//etc/passwd',                  // "//" — WHATWG URL читает как protocol-relative: "etc" становится (фиктивным) host'ом при разборе, pathname схлопывается до "/passwd" — до логики обхода в serveStatic в привычном виде вообще не доходит
      '/package.json%00.html',         // нулевой байт после реального имени — decodeURIComponent даёт литеральный \0 в имени, fs.readFile на таком пути бросает, ловится как 404
      '/%00package.json',              // нулевой байт в начале имени
      '/index.html%00',                // нулевой байт в конце
    ];

    for (const target of probes) {
      const { status, body } = await rawRequest(app.port, target);
      assert.notEqual(status, 200, `${target} не должен отдавать 200`);
      assert.equal(status, 404, `${target} должен получить 404`);
      assert.equal(body.includes(PACKAGE_JSON_NEEDLE), false, `${target} не должен отдать содержимое package.json`);
    }
  });
});

// --- Задача 3: образ на своём origin ---

test('образ отдаётся со второго порта', async () => {
  const app = createApp({});
  await app.listen(0, 0);
  try {
    assert.notEqual(app.port, app.imagePort);
    const res = await fetch(`http://127.0.0.1:${app.imagePort}/image.html`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('id="q"'), 'заготовка на месте');
    assert.ok(html.includes('image-boot.js'), 'загрузчик подключён');
    assert.equal(html.includes('sandbox'), false, 'атрибут sandbox не используется');
  } finally { await app.close(); }
});

test('/api/config отдаёт origin образа', async () => {
  const app = createApp({});
  await app.listen(0, 0);
  try {
    const body = await (await fetch(`http://127.0.0.1:${app.port}/api/config`)).json();
    assert.equal(body.imageOrigin, `http://127.0.0.1:${app.imagePort}`);
  } finally { await app.close(); }
});

test('порт образа проверяет Host так же, как оболочка', async () => {
  // fetch() не даёт подменить заголовок Host — undici (как и браузерный fetch)
  // считает его запрещённым и молча шлёт настоящий адрес вместо заданного
  // (проверено: с headers:{host:'evil.example'} на сервер всё равно приходит
  // 127.0.0.1:port). Ровно поэтому в проверке Host у оболочки уже используется
  // rawRequest — тот же приём нужен и здесь.
  const app = createApp({});
  await app.listen(0, 0);
  try {
    const bad = await rawRequest(app.imagePort, '/image.html', { host: 'evil.example' });
    assert.equal(bad.status, 403);
    const good = await rawRequest(app.imagePort, '/image.html');
    assert.equal(good.status, 200);
  } finally { await app.close(); }
});

test('image-boot.js отдаётся со второго порта', async () => {
  const app = createApp({});
  await app.listen(0, 0);
  try {
    const res = await fetch(`http://127.0.0.1:${app.imagePort}/image-boot.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    assert.match(await res.text(), /function createImage/);
  } finally { await app.close(); }
});

test('на порту образа "/" отдаёт image.html с правильным content-type', async () => {
  const app = createApp({});
  await app.listen(0, 0);
  try {
    const res = await fetch(`http://127.0.0.1:${app.imagePort}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(await res.text(), /id="q"/);
  } finally { await app.close(); }
});
