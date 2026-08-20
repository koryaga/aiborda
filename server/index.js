import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, publicView, scrub } from './pi-config.js';
import { stream as openaiStream } from '@earendil-works/pi-ai/api/openai-completions';
import { stream as anthropicStream } from '@earendil-works/pi-ai/api/anthropic-messages';
import { extractCode, checkParsable } from './parse.js';
import { createHistory, SYSTEM_PROMPT } from './context.js';

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
  const state = { config: null, opts, history: createHistory(), abort: null };
  const root = withTrailingSlash(opts.webRoot ?? DEFAULT_WEB_ROOT);

  async function reload() {
    state.config = await loadConfig({
      path: opts.configPath, authPath: opts.authPath,
      env: opts.env, fetchImpl: opts.fetchImpl,
    });
    return state.config;
  }

  // opts.streamFn — подмена на тестах: сама функция вызывается с той же
  // сигнатурой (model, context, options), что и настоящие openaiStream/
  // anthropicStream, поэтому здесь возвращается ссылка на функцию,
  // а не результат её вызова — вызовет её уже collect().
  function pickStream(model) {
    if (opts.streamFn) return opts.streamFn;
    return model.api === 'anthropic-messages' ? anthropicStream : openaiStream;
  }

  async function collect(model, provider, signal, res) {
    const events = pickStream(model)(
      model,
      { systemPrompt: SYSTEM_PROMPT, messages: state.history.messages },
      { apiKey: provider?.apiKey, signal, maxTokens: model.maxTokens },
    );
    let text = '';
    for await (const ev of events) {
      if (ev.type === 'text_delta') { text += ev.delta; sse(res, 'delta', { text: ev.delta }); }
      else if (ev.type === 'error') throw new Error(ev.error?.errorMessage ?? 'провайдер вернул ошибку');
    }
    return text;
  }

  async function handleCommit(req, res) {
    const body = await readJson(req);
    const c = state.config ?? await reload();
    const model = c.models.find(m => m.provider === body.model?.provider && m.id === body.model?.id);
    if (!model) return json(res, 400, { error: 'модель не найдена' });
    const provider = c.providers.find(p => p.name === model.provider);

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    state.history.pushResult(body.result);
    state.history.pushDiff(body.diff);

    const ctl = new AbortController();
    state.abort = ctl;
    try {
      let code = extractCode(await collect(model, provider, ctl.signal, res));
      let check = checkParsable(code);
      if (!check.ok) {
        // §7 спецификации: ровно один автоповтор с текстом ошибки
        state.history.pushCode(code, model);
        state.history.pushDiff('код не разобрался: ' + check.error +
          '\nпришли только исполнимый JavaScript');
        code = extractCode(await collect(model, provider, ctl.signal, res));
        check = checkParsable(code);
      }
      if (!check.ok) sse(res, 'error', { message: 'код не разбирается: ' + check.error });
      else {
        state.history.pushCode(code, model);
        sse(res, 'done', { code });
      }
    } catch (e) {
      sse(res, 'error', { message: scrub(e.message, c.secrets) });
    } finally {
      state.abort = null;
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
    // и это может быть чтение (списка моделей, текста ошибки с именем
    // пользователя ОС в пути) или, начиная со следующей задачи, запись
    // (/api/commit). Межсайтовый POST — simple request, preflight не нужен;
    // CORS запрещает читать чужой ответ, а не отправлять запрос, так что
    // отсутствие CORS-заголовков само по себе не защита. Отвечаем только
    // тогда, когда клиент целился именно в этот адрес.
    const port = server.address()?.port;
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!allowedHosts.has(String(req.headers.host).toLowerCase())) {
      return json(res, 403, { error: 'недопустимый Host' });
    }

    try {
      if (url.pathname === '/api/models') {
        return json(res, 200, publicView(state.config ?? await reload()));
      }
      if (url.pathname === '/api/reload' && req.method === 'POST') {
        return json(res, 200, publicView(await reload()));
      }
      if (url.pathname === '/api/commit' && req.method === 'POST') return await handleCommit(req, res);
      if (url.pathname === '/api/abort' && req.method === 'POST') {
        state.abort?.abort();
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/session') return json(res, 200, { tokens: state.history.size() });
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'нет такого метода' });
      return await serveStatic(res, url.pathname, root);
    } catch (e) {
      if (res.headersSent) return res.destroy();
      // Конфиг мог быть уже загружен — ключи и baseUrl лежат в state.config.secrets.
      // Текст непредвиденной ошибки чистим тем же scrub, что и обычные каналы: это
      // единственный выход из процесса мимо publicView, и он не должен быть дырой
      // в инварианте «ключи и baseUrl не уходят в браузер» просто по недосмотру.
      const message = state.config ? scrub(String(e.message), state.config.secrets) : String(e.message);
      return json(res, 500, { error: message });
    }
  });

  return {
    server, reload, state,
    get port() { return server.address()?.port; },
    listen(port = 8730) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    },
    close() { return new Promise(r => server.close(r)); },
  };
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const flag = process.argv.indexOf('--pi-config');
  const app = createApp({ configPath: flag > -1 ? process.argv[flag + 1] : process.env.PI_MODELS_PATH });
  await app.listen(8730);
  process.on('SIGHUP', () => { app.reload(); });
  console.log('dom-agent слушает http://127.0.0.1:8730');
}
