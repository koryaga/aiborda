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
    await withServer({ configPath, authPath, env: {} }, async base => {
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
      assert.deepEqual(Object.keys(reloaded).sort(), ['error', 'models', 'notes']);
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
