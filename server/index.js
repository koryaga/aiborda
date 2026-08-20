import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge } from './bridge.js';
import { startSession } from './agent.js';

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

// Тело запроса читаем сами: встроенный http-модуль не парсит JSON.
// Битый JSON здесь не глушится — бросает наружу, и уже вызывающий код
// (обработчик маршрута внутри общего try/catch createServer) решает,
// как ответить, не роняя сам процесс.
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(text ? JSON.parse(text) : {}); }
      catch (e) { reject(new Error('некорректное тело запроса: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

async function serveStatic(res, pathname, root) {
  // Порядок здесь принципиален: decodeURIComponent → normalize → join → startsWith.
  // new URL(req.url, ...) в обработчике ниже схлопывает точечные сегменты в pathname
  // (включая %2e-форму — это делает сам WHATWG-парсер), но проценты вообще не
  // декодирует, а не-ASCII, наоборот, кодирует. Значит без decodeURIComponent
  // кириллическое имя файла в web/ никогда не найдётся. decodeURIComponent может
  // заново породить "/../" из "%2e%2e%2f" — но pathname всегда абсолютный
  // (начинается с "/"), а normalize() на абсолютном пути клэмпит "../" к корню,
  // а не выпускает выше него. normalize и startsWith(root) — две настоящие линии
  // обороны; join (не resolve!) — то, что не даёт абсолютному второму аргументу
  // переопределить базу целиком.
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { return json(res, 400, { error: 'некорректный путь' }); }
  const rel = normalize(decoded === '/' ? '/index.html' : decoded);
  const file = join(root, rel);
  if (!file.startsWith(root)) return json(res, 404, { error: 'не найдено' });
  try {
    const body = await readFile(file);
    const dot = rel.lastIndexOf('.');
    const ext = dot === -1 ? '' : rel.slice(dot);
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
    res.end(body);
  } catch { json(res, 404, { error: 'не найдено' }); }
}

export function createApp(opts = {}) {
  const state = { opts, abort: null, session: null };
  const root = withTrailingSlash(opts.webRoot ?? DEFAULT_WEB_ROOT);

  const bridge = createBridge({ send: null });
  const listeners = new Set();

  // Оболочка держит открытый SSE; по нему сервер шлёт запросы page_exec и
  // события сессии. Обратный ход — обычным POST: WebSocket-сервера в Node нет,
  // а тянуть ws ради одного канала не стоит.
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
    session.subscribe(ev => { if (ev?.type) broadcast('agent', { type: ev.type }); });
    return session;
  }

  async function handleCommit(req, res) {
    const body = await readJson(req);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    // ensureSession() — внутри try, а не до writeHead: если сессия не поднимается
    // (нет модели, нет ключа), это должно уйти событием error внутри уже начатого
    // потока, а не сорвать ответ обратно в JSON 500 из внешнего catch — оболочка
    // ждёт именно SSE на этом маршруте.
    try {
      const session = await ensureSession();
      await session.prompt(String(body.diff ?? ''));
      await session.waitForIdle();
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
      return json(res, 400, { error: 'некорректный запрос' });
    }

    // Петля — не граница. Домен атакующего, резолвящийся в 127.0.0.1 (DNS
    // rebinding), заставляет браузер жертвы слать сюда запросы с чужим Host —
    // и это может быть чтение (текста ошибки с именем пользователя ОС в пути)
    // или запись (/api/commit). Межсайтовый POST — simple request, preflight
    // не нужен; CORS запрещает читать чужой ответ, а не отправлять запрос,
    // так что отсутствие CORS-заголовков само по себе не защита. Отвечаем
    // только тогда, когда клиент целился именно в этот адрес.
    const port = server.address()?.port;
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!allowedHosts.has(String(req.headers.host).toLowerCase())) {
      return json(res, 403, { error: 'недопустимый Host' });
    }

    try {
      if (url.pathname === '/api/commit' && req.method === 'POST') return await handleCommit(req, res);
      if (url.pathname === '/api/abort' && req.method === 'POST') {
        if (state.session) await state.session.abort();
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/config') {
        return json(res, 200, { imageOrigin: `http://127.0.0.1:${imageServer.address()?.port}` });
      }
      if (url.pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        // writeHead() сам по себе ничего не отправляет в сокет — Node копит
        // заголовки до первого write()/end(). Здесь до первого события может
        // пройти сколько угодно времени (страница ждёт запроса page_exec),
        // так что без явного flushHeaders() клиент завис бы в ожидании самого
        // статуса ответа, а не только данных.
        res.flushHeaders();
        listeners.add(res);
        // Каждое новое подключение переустанавливает отправителя моста — это и
        // есть восстановление канала после переподключения оболочки (п.3
        // «Дополнительно к плану»): пока хотя бы один слушатель жив, мост может
        // слать запросы; на закрытии последнего — немеет и отклоняет ожидающих.
        bridge.setSender(m => broadcast('page_exec', m));
        req.on('close', () => {
          listeners.delete(res);
          if (listeners.size === 0) {
            bridge.setSender(null);
            bridge.reset('оболочка отключилась');
          }
        });
        return;
      }
      if (url.pathname === '/api/page-result' && req.method === 'POST') {
        bridge.deliver(await readJson(req));
        return json(res, 200, { ok: true });
      }
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'нет такого метода' });
      return await serveStatic(res, url.pathname, root);
    } catch (e) {
      if (res.headersSent) return res.destroy();
      return json(res, 500, { error: String(e.message) });
    }
  });

  // Образ живёт на отдельном порту, и это весь механизм изоляции: другой
  // origin даёт ему localStorage и остальной HTML5, но не даёт достать до
  // оболочки. Атрибут sandbox не используется — он дал бы меньше и хуже.
  const imageServer = createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); }
    catch {
      if (res.headersSent) return res.destroy();
      return json(res, 400, { error: 'некорректный запрос' });
    }
    const p = imageServer.address()?.port;
    const allowed = new Set([`127.0.0.1:${p}`, `localhost:${p}`]);
    if (!allowed.has(String(req.headers.host).toLowerCase())) {
      return json(res, 403, { error: 'недопустимый Host' });
    }
    const path = url.pathname === '/' ? '/image.html' : url.pathname;
    // `root` — уже вычисленная в createApp константа с завершающим слэшем,
    // а не сырой opts.webRoot: на слэше держится проверка startsWith.
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
  console.log('dom-agent слушает http://127.0.0.1:8730, образ — http://127.0.0.1:8731');
}
