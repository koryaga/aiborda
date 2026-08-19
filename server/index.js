import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, publicModels, scrub } from './pi-config.js';

const WEB = fileURLToPath(new URL('../web/', import.meta.url));

// Заметки — второй канал наружу помимо моделей, и он не проходит через
// allow-list publicModels. Чистим его на выходе: одного намерения
// «не класть в заметку лишнего» мало, заметки пишутся в разных местах.
function publicView(c) {
  return {
    models: publicModels(c.models),
    notes: c.notes.map(n => scrub(n, c.secrets)),
    error: c.error ? scrub(c.error, c.secrets) : null,
  };
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

async function serveStatic(res, pathname) {
  // pathname приходит уже декодированным из new URL(req.url, ...) — WHATWG URL
  // разбирает точечные сегменты (в том числе %2e-кодированные) и не пускает их
  // выше корня ещё на этапе парсинга. normalize() и startsWith(WEB) ниже —
  // вторая линия обороны на случай, если это когда-нибудь перестанет быть так.
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(WEB, rel);
  if (!file.startsWith(WEB)) return json(res, 404, { error: 'не найдено' });
  try {
    const body = await readFile(file);
    const ext = rel.slice(rel.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
    res.end(body);
  } catch { json(res, 404, { error: 'не найдено' }); }
}

export function createApp(opts = {}) {
  const state = { config: null, opts };

  async function reload() {
    state.config = await loadConfig({
      path: opts.configPath, authPath: opts.authPath,
      env: opts.env, fetchImpl: opts.fetchImpl,
    });
    return state.config;
  }

  const server = createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); }
    catch { return json(res, 400, { error: 'некорректный запрос' }); }
    try {
      if (url.pathname === '/api/models') {
        return json(res, 200, publicView(state.config ?? await reload()));
      }
      if (url.pathname === '/api/reload' && req.method === 'POST') {
        return json(res, 200, publicView(await reload()));
      }
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'нет такого метода' });
      return await serveStatic(res, url.pathname);
    } catch (e) {
      return json(res, 500, { error: String(e.message) });
    }
  });

  return {
    server, reload, state,
    get port() { return server.address()?.port; },
    listen(port = 8730) { return new Promise(r => server.listen(port, '127.0.0.1', r)); },
    close() { return new Promise(r => server.close(r)); },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const flag = process.argv.indexOf('--pi-config');
  const app = createApp({ configPath: flag > -1 ? process.argv[flag + 1] : process.env.PI_MODELS_PATH });
  await app.listen(8730);
  process.on('SIGHUP', () => { app.reload(); });
  console.log('dom-agent слушает http://127.0.0.1:8730');
}
