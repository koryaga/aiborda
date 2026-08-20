import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/models.json', import.meta.url));
const PACKAGE_JSON_NEEDLE = '"name": "dom-agent"';

async function withServer(opts, fn) {
  const app = createApp(opts);
  await app.listen(0);
  try { await fn(`http://127.0.0.1:${app.port}`, app); } finally { await app.close(); }
}

// Путь вроде /no/models.json полагается на то, что корень примонтирован
// только для чтения — верно на macOS, не гарантировано под root в Linux CI.
// Файл внутри свежего tmpdir() гарантированно не существует независимо от
// платформы и прав процесса, поэтому именно так моделируем "конфига нет".
async function withMissingConfig(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dom-agent-missing-'));
  try {
    await fn({ configPath: join(dir, 'models.json'), authPath: join(dir, 'auth.json'), env: {} });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test('GET /api/models отдаёт только provider, id и contextWindow', async () => {
  await withServer({
    configPath: FIXTURE,
    authPath: '/no/auth.json',
    // Изолируем от настоящего ~/.pi/agent/settings.json разработчика: без этого
    // enabledModels на реальной машине фильтрует список моделей теста и делает
    // его недетерминированным между машинами.
    settingsPath: '/no/settings.json',
    env: { TEST_DS_KEY: 'очень-секретный-ключ' },
    fetchImpl: async () => { throw new Error('оффлайн'); },
  }, async base => {
    const res = await fetch(base + '/api/models');
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(body.models.length > 0);
    assert.deepEqual(Object.keys(body.models[0]).sort(), ['contextWindow', 'id', 'provider']);
    assert.equal(JSON.stringify(body).includes('очень-секретный-ключ'), false);
    assert.equal(JSON.stringify(body).includes('api.deepseek.com'), false);
    // Приёмка §12 п.5: baseUrl не должен уходить в браузер ни одним каналом,
    // включая заметки о недоступных провайдерах.
    assert.equal(body.notes.some(n => n.includes('http')), false);
  });
});

test('GET /api/models при отсутствии конфига отдаёт текст ошибки и живой сервер', async () => {
  await withMissingConfig(async opts => {
    await withServer(opts, async base => {
      const body = await (await fetch(base + '/api/models')).json();
      assert.deepEqual(body.models, []);
      assert.ok(body.error.includes('--pi-config'));
    });
  });
});

test('POST /api/reload перечитывает конфиг и отдаёт тот же публичный вид', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dom-agent-reload-'));
  const configPath = join(dir, 'models.json');
  const authPath = join(dir, 'auth.json'); // не создаём — readAuth() должен молча стерпеть отсутствие
  const cfgV1 = {
    providers: { p: {
      baseUrl: 'https://example.invalid', api: 'anthropic-messages', apiKey: 'ключ-раз',
      models: [{ id: 'reload-m1', contextWindow: 1000 }],
    } },
  };
  await writeFile(configPath, JSON.stringify(cfgV1));
  try {
    // settingsPath — заведомо не существующий путь внутри того же tmpdir:
    // без изоляции реальный ~/.pi/agent/settings.json разработчика (если он
    // есть) отфильтровал бы reload-m1/reload-m2 через enabledModels.
    await withServer({ configPath, authPath, settingsPath: join(dir, 'settings.json'), env: {} }, async base => {
      const before = await (await fetch(base + '/api/models')).json();
      assert.deepEqual(before.models.map(m => m.id), ['reload-m1']);

      // Меняем конфиг на диске между запросами — без реального перечитывания
      // сервер продолжил бы отдавать закэшированный ответ.
      const cfgV2 = {
        providers: { p: {
          baseUrl: 'https://example.invalid', api: 'anthropic-messages', apiKey: 'ключ-два',
          models: [{ id: 'reload-m1', contextWindow: 1000 }, { id: 'reload-m2', contextWindow: 2000 }],
        } },
      };
      await writeFile(configPath, JSON.stringify(cfgV2));

      const reloadRes = await fetch(base + '/api/reload', { method: 'POST' });
      const reloaded = await reloadRes.json();
      assert.equal(reloadRes.status, 200);
      assert.deepEqual(reloaded.models.map(m => m.id).sort(), ['reload-m1', 'reload-m2']);
      assert.deepEqual(Object.keys(reloaded).sort(), ['default', 'error', 'models', 'notes']);
      // Ключи из cfgV2 не должны утечь ни в одном канале.
      assert.equal(JSON.stringify(reloaded).includes('ключ-два'), false);

      // Публичный вид из /api/reload и последующего /api/models должен совпасть —
      // значит перечитанный конфиг реально осел в состоянии сервера, а не был
      // возвращён разово и тут же отброшен.
      const after = await (await fetch(base + '/api/models')).json();
      assert.deepEqual(after, reloaded);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('запрос с чужим Host отклоняется 403, с правильным (127.0.0.1 или localhost) — проходит', async () => {
  // Петля — не граница. Домен атакующего, резолвящийся в 127.0.0.1, заставляет
  // браузер жертвы слать сюда запросы с чужим Host — это и DNS rebinding, и
  // межсайтовый POST (CORS запрещает читать ответ, а не отправлять запрос;
  // preflight простой POST не требует). Ответ должен зависеть от Host.
  await withMissingConfig(async opts => {
    await withServer(opts, async (base, app) => {
      const bad = await rawRequest(app.port, '/api/models', { host: 'evil.example:80' });
      assert.equal(bad.status, 403);
      assert.equal(bad.body.includes('--pi-config'), false, 'при 403 тело не должно нести полезную нагрузку API');

      const goodIp = await rawRequest(app.port, '/api/models', { host: `127.0.0.1:${app.port}` });
      assert.equal(goodIp.status, 200);

      const goodLocalhost = await rawRequest(app.port, '/api/models', { host: `localhost:${app.port}` });
      assert.equal(goodLocalhost.status, 200);
    });
  });
});

test('второй listen() на занятый порт отклоняется, не роняя процесс', async () => {
  await withMissingConfig(async opts => {
    const app1 = createApp(opts);
    const app2 = createApp(opts);
    try {
      await app1.listen(0);
      await assert.rejects(() => app2.listen(app1.port), e => e.code === 'EADDRINUSE');
      // До фикса необработанное 'error'-событие на сервере убивало весь процесс
      // node --test (а не только эту проверку) — здесь просто убеждаемся, что
      // app1 как ни в чём не бывало продолжает отвечать.
      const res = await fetch(`http://127.0.0.1:${app1.port}/api/models`);
      assert.equal(res.status, 200);
    } finally {
      await app1.close();
    }
  });
});

test('GET // с некорректным путём получает 400 (ветка была живой, но не покрытой)', async () => {
  await withMissingConfig(async opts => {
    await withServer(opts, async (base, app) => {
      const { status } = await rawRequest(app.port, '//');
      assert.equal(status, 400);
    });
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

    // configPath/authPath здесь не читаются вообще: тест не трогает /api/*.
    await withServer({ configPath: '/unused', authPath: '/unused', env: {}, webRoot }, async base => {
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

function fakeStream(events) {
  return () => ({
    async *[Symbol.asyncIterator]() { for (const e of events) yield e; },
  });
}

// В отличие от fakeStream (одна и та же лента для любого числа вызовов),
// эта фабрика различает попытки — нужна для проверки автоповтора: считает
// вызовы и на каждый следующий отдаёт свою заготовленную ленту событий.
function sequentialStream(replySets) {
  const calls = [];
  const fn = (model, context, options) => {
    const events = replySets[calls.length] ?? replySets[replySets.length - 1];
    calls.push({ model, context, options });
    return { async *[Symbol.asyncIterator]() { for (const e of events) yield e; } };
  };
  fn.calls = calls;
  return fn;
}

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

const COMMIT_OPTS = {
  configPath: FIXTURE,
  authPath: '/no/auth.json',
  // См. комментарий у первого теста /api/models: без изоляции настоящий
  // ~/.pi/agent/settings.json разработчика фильтрует MODEL_REF через
  // enabledModels и делает эти тесты недетерминированными между машинами.
  settingsPath: '/no/settings.json',
  env: { TEST_DS_KEY: 'k' },
  fetchImpl: async () => { throw new Error('оффлайн'); },
};

const MODEL_REF = { provider: 'deepseek', id: 'deepseek-v4-flash' };

function post(base, body) {
  return fetch(base + '/api/commit', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const BAD_TEXT = 'это не код, а просто текст';

test('commit стримит дельты и отдаёт очищенный код, рассуждения не уходят', async () => {
  await withServer({ ...COMMIT_OPTS, streamFn: fakeStream([
    { type: 'thinking_delta', delta: 'сейчас подумаю' },
    { type: 'text_delta', delta: '```js\ndocument' },
    { type: 'text_delta', delta: '.title = "x"\n```' },
    { type: 'done', reason: 'stop', message: {} },
  ]) }, async base => {
    const events = await readSse(await post(base, { model: MODEL_REF, diff: '#q  "" -> "привет"' }));
    assert.equal(events.at(-1).event, 'done');
    assert.equal(events.at(-1).data.code, 'document.title = "x"');
    assert.equal(events.some(e => e.data.text === 'сейчас подумаю'), false);
  });
});

test('commit кладёт результат прошлого хода перед дифом', async () => {
  await withServer({ ...COMMIT_OPTS, streamFn: fakeStream([
    { type: 'text_delta', delta: 'x()' },
    { type: 'done', reason: 'stop', message: {} },
  ]) }, async (base, app) => {
    await post(base, { model: MODEL_REF, diff: 'диф', result: '42' }).then(r => r.text());
    assert.deepEqual(app.state.history.messages.map(m => m.content),
      ['результат: 42', 'диф', [{ type: 'text', text: 'x()' }]]);
  });
});

test('пустой ответ модели — законный ход: done с пустым кодом', async () => {
  await withServer({ ...COMMIT_OPTS, streamFn: fakeStream([
    { type: 'text_delta', delta: '<think>делать нечего</think>' },
    { type: 'done', reason: 'stop', message: {} },
  ]) }, async base => {
    const events = await readSse(await post(base, { model: MODEL_REF, diff: 'д' }));
    assert.equal(events.at(-1).event, 'done');
    assert.equal(events.at(-1).data.code, '');
  });
});

test('неизвестная модель даёт 400', async () => {
  await withServer(COMMIT_OPTS, async base => {
    assert.equal((await post(base, { model: { provider: 'нет', id: 'нет' }, diff: '' })).status, 400);
  });
});

test('ошибка провайдера уходит событием error и не роняет сервер', async () => {
  await withServer({ ...COMMIT_OPTS, streamFn: fakeStream([
    { type: 'error', reason: 'error', error: { errorMessage: 'провайдер лёг' } },
  ]) }, async base => {
    const events = await readSse(await post(base, { model: MODEL_REF, diff: 'д' }));
    assert.equal(events.at(-1).event, 'error');
    assert.ok(events.at(-1).data.message.includes('провайдер лёг'));
  });
});

// --- Дополнительно к плану ---

test('секрет (baseUrl провайдера) не уходит в текст события error', async () => {
  // baseUrl фикстуры — https://api.deepseek.com — попадает в config.secrets
  // безусловно (pi-config.js), независимо от длины apiKey. Ошибка провайдера,
  // случайно содержащая его в тексте, не должна долетать до браузера как есть.
  await withServer({ ...COMMIT_OPTS, streamFn: fakeStream([
    { type: 'error', reason: 'error', error: { errorMessage: 'запрос к https://api.deepseek.com/v1/chat не прошёл' } },
  ]) }, async base => {
    const events = await readSse(await post(base, { model: MODEL_REF, diff: 'д' }));
    assert.equal(events.at(-1).event, 'error');
    assert.equal(events.at(-1).data.message.includes('api.deepseek.com'), false);
    assert.ok(events.at(-1).data.message.includes('***'));
  });
});

test('автоповтор ровно один раз: два неразбираемых ответа подряд — провайдер вызван дважды, наружу error', async () => {
  const streamFn = sequentialStream([
    [{ type: 'text_delta', delta: BAD_TEXT }, { type: 'done', reason: 'stop', message: {} }],
    [{ type: 'text_delta', delta: BAD_TEXT }, { type: 'done', reason: 'stop', message: {} }],
  ]);
  await withServer({ ...COMMIT_OPTS, streamFn }, async base => {
    const events = await readSse(await post(base, { model: MODEL_REF, diff: 'д' }));
    assert.equal(streamFn.calls.length, 2, 'провайдер должен быть вызван ровно дважды, не трижды');
    assert.equal(events.at(-1).event, 'error');
  });
});

test('успешный автоповтор: первый ответ мусорный, второй валидный — done со вторым, в истории обе попытки', async () => {
  const streamFn = sequentialStream([
    [{ type: 'text_delta', delta: BAD_TEXT }, { type: 'done', reason: 'stop', message: {} }],
    [{ type: 'text_delta', delta: 'x()' }, { type: 'done', reason: 'stop', message: {} }],
  ]);
  await withServer({ ...COMMIT_OPTS, streamFn }, async (base, app) => {
    const events = await readSse(await post(base, { model: MODEL_REF, diff: 'д' }));
    assert.equal(streamFn.calls.length, 2);
    assert.equal(events.at(-1).event, 'done');
    assert.equal(events.at(-1).data.code, 'x()');
    const assistantTexts = app.state.history.messages
      .filter(m => m.role === 'assistant')
      .map(m => m.content[0].text);
    assert.deepEqual(assistantTexts, [BAD_TEXT, 'x()']);
  });
});

test('история не растёт при 400 (неизвестная модель)', async () => {
  await withServer(COMMIT_OPTS, async (base, app) => {
    await post(base, { model: { provider: 'нет', id: 'нет' }, diff: 'д' });
    assert.equal(app.state.history.messages.length, 0);
  });
});

test('result не передан — сообщения "результат:" в истории нет', async () => {
  await withServer({ ...COMMIT_OPTS, streamFn: fakeStream([
    { type: 'text_delta', delta: 'x()' },
    { type: 'done', reason: 'stop', message: {} },
  ]) }, async (base, app) => {
    await post(base, { model: MODEL_REF, diff: 'диф без result' }).then(r => r.text());
    assert.equal(app.state.history.messages.some(m =>
      typeof m.content === 'string' && m.content.startsWith('результат:')), false);
    assert.equal(app.state.history.messages[0].content, 'диф без result');
  });
});

test('/api/session отдаёт растущее число токенов после хода', async () => {
  await withServer({ ...COMMIT_OPTS, streamFn: fakeStream([
    { type: 'text_delta', delta: 'x()' },
    { type: 'done', reason: 'stop', message: {} },
  ]) }, async base => {
    const before = (await (await fetch(base + '/api/session')).json()).tokens;
    await post(base, { model: MODEL_REF, diff: 'диф побольше текста, чтобы токены точно выросли' })
      .then(r => r.text());
    const after = (await (await fetch(base + '/api/session')).json()).tokens;
    assert.ok(after > before, `${after} должно быть больше ${before}`);
  });
});

test('/api/abort без активного хода не падает и отдаёт ok', async () => {
  await withServer(COMMIT_OPTS, async base => {
    const res = await fetch(base + '/api/abort', { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test('заголовки потока: /api/commit отвечает text/event-stream', async () => {
  await withServer({ ...COMMIT_OPTS, streamFn: fakeStream([
    { type: 'text_delta', delta: 'x()' },
    { type: 'done', reason: 'stop', message: {} },
  ]) }, async base => {
    const res = await post(base, { model: MODEL_REF, diff: 'д' });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    await res.text();
  });
});

test('битое тело запроса не роняет сервер', async () => {
  await withServer({ ...COMMIT_OPTS, streamFn: fakeStream([
    { type: 'text_delta', delta: 'x()' },
    { type: 'done', reason: 'stop', message: {} },
  ]) }, async base => {
    const bad = await fetch(base + '/api/commit', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: 'это не json {{{',
    });
    assert.notEqual(bad.status, 200);
    // Сервер должен остаться живым — следующий нормальный запрос обязан пройти.
    const ok = await post(base, { model: MODEL_REF, diff: 'д' });
    assert.equal(ok.status, 200);
    await ok.text();
  });
});

test('выход за пределы web/ запрещён: обходы через сырой сокет, минуя нормализацию клиента', async () => {
  // web/ ещё не существует по умолчанию (DEFAULT_WEB_ROOT), поэтому единственный
  // файл, который реально можно было бы прочитать через обход наружу — это
  // package.json репозитория (он на один уровень выше web/). Если бы контейнмент
  // был сломан, один из этих запросов вернул бы 200 с его содержимым.
  const real = await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8');
  assert.ok(real.includes(PACKAGE_JSON_NEEDLE), 'сверочная строка должна быть в реальном package.json');

  await withMissingConfig(async opts => {
    await withServer(opts, async (base, app) => {
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
});

test('модель встроенного провайдера уходит через его собственный поток', async () => {
  let usedBuiltin = false;
  const provider = { name: 'vstroennyy', apiKey: 'kluch', builtin: true,
    baseUrl: 'https://primer', streamFn: () => { usedBuiltin = true; return fakeStream([
      { type: 'text_delta', delta: 'x()' },
      { type: 'done', reason: 'stop', message: {} },
    ])(); } };
  const model = { provider: 'vstroennyy', id: 'm', api: 'openai-responses', maxTokens: 16 };

  const app = createApp({ configPath: '/нет', authPath: '/нет', settingsPath: '/нет' });
  app.state.config = { models: [model], providers: [provider], notes: [], secrets: new Set(),
    default: null, error: null };
  await app.listen(0);
  try {
    const events = await readSse(await fetch(`http://127.0.0.1:${app.port}/api/commit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: { provider: 'vstroennyy', id: 'm' }, diff: 'д' }),
    }));
    assert.equal(usedBuiltin, true, 'должен был использоваться streamFn провайдера');
    assert.equal(events.at(-1).event, 'done');
    assert.equal(events.at(-1).data.code, 'x()');
  } finally { await app.close(); }
});

test('пользовательская модель по-прежнему идёт через адаптер по api', async () => {
  await withServer({ ...COMMIT_OPTS, streamFn: fakeStream([
    { type: 'text_delta', delta: 'y()' },
    { type: 'done', reason: 'stop', message: {} },
  ]) }, async base => {
    const events = await readSse(await post(base, { model: MODEL_REF, diff: 'д' }));
    assert.equal(events.at(-1).data.code, 'y()');
  });
});

test('GET /api/models отдаёт умолчание', async () => {
  const app = createApp({ configPath: '/нет', authPath: '/нет', settingsPath: '/нет' });
  app.state.config = { models: [], providers: [], notes: [], secrets: new Set(),
    error: null, default: { provider: 'deepseek', id: 'deepseek-v4-pro' } };
  await app.listen(0);
  try {
    const body = await (await fetch(`http://127.0.0.1:${app.port}/api/models`)).json();
    assert.deepEqual(body.default, { provider: 'deepseek', id: 'deepseek-v4-pro' });
  } finally { await app.close(); }
});
