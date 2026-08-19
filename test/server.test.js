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

// Пишет HTTP-запрос напрямую в сокет, минуя WHATWG URL-парсинг, который делает
// fetch() на клиенте (и который уже сам схлопывает "../"). Так строка запроса
// доходит до сервера ровно в том виде, в каком написана здесь.
function rawRequest(port, target) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
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
  await withServer({ configPath: '/no/models.json', authPath: '/no/auth.json' }, async base => {
    const body = await (await fetch(base + '/api/models')).json();
    assert.deepEqual(body.models, []);
    assert.ok(body.error.includes('--pi-config'));
  });
});

test('POST /api/reload перечитывает конфиг и отдаёт тот же публичный вид', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dom-agent-reload-'));
  const configPath = join(dir, 'models.json');
  const cfgV1 = {
    providers: { p: {
      baseUrl: 'https://example.invalid', api: 'anthropic-messages', apiKey: 'ключ-раз',
      models: [{ id: 'reload-m1', contextWindow: 1000 }],
    } },
  };
  await writeFile(configPath, JSON.stringify(cfgV1));
  try {
    await withServer({ configPath, authPath: '/no/auth.json', env: {} }, async base => {
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

test('выход за пределы web/ запрещён: обходы через сырой сокет, минуя нормализацию клиента', async () => {
  // web/ ещё не существует в этой задаче, поэтому единственный файл, который
  // реально можно было бы прочитать через обход наружу — это package.json
  // репозитория (он на один уровень выше web/). Если бы контейнмент был
  // сломан, один из этих запросов вернул бы 200 с его содержимым.
  const real = await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8');
  assert.ok(real.includes(PACKAGE_JSON_NEEDLE), 'сверочная строка должна быть в реальном package.json');

  await withServer({ configPath: '/no/models.json', authPath: '/no/auth.json' }, async (base, app) => {
    const probes = [
      '/../package.json',              // буквальный ".." — не доходит нормализованным лишь у fetch, но не у сырого сокета
      '/%2e%2e/package.json',          // процентное кодирование точек
      '/%2e%2e%2fpackage.json',        // точки и слэш закодированы вместе
      '/..%2fpackage.json',            // точки буквальные, слэш закодирован
      '/..%2Fpackage.json',            // то же в верхнем регистре
      '/..\\package.json',             // обратный слэш вместо прямого
      '/..%5cpackage.json',            // обратный слэш закодирован (нижний регистр)
      '/..%5Cpackage.json',            // обратный слэш закодирован (верхний регистр)
      '/foo/%2e%2e/%2e%2e/package.json', // вложенный обход из подкаталога
      '/./../package.json',            // смешанные сегменты
      '/etc/passwd',                   // абсолютный путь без обхода — ловит баг join() vs resolve()
      '//etc/passwd',                  // двойной ведущий слэш перед абсолютным путём
      '/package.json%00.html',         // нулевой байт после реального имени
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
