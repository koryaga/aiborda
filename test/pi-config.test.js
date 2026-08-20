import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { expandVars, flattenModels, toModel, discoverModels, loadConfig, publicModels, publicView, scrub, findBuiltinModel, builtinProviderRecord } from '../server/pi-config.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raw = JSON.parse(await readFile(new URL('./fixtures/models.json', import.meta.url), 'utf8'));
// fileURLToPath (не .pathname) декодирует пробелы и юникод в пути проекта корректно.
const FIXTURE_MODELS_PATH = fileURLToPath(new URL('./fixtures/models.json', import.meta.url));

async function withSettingsFile(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dom-agent-'));
  const path = join(dir, 'settings.json');
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
  try { await fn(path); } finally { await rm(dir, { recursive: true, force: true }); }
}

const NO_NET = async () => { throw new Error('оффлайн'); };

test('expandVars разворачивает $VAR из окружения', () => {
  assert.equal(expandVars('$TEST_DS_KEY', { TEST_DS_KEY: 'секрет' }), 'секрет');
  assert.equal(expandVars('${TEST_DS_KEY}', { TEST_DS_KEY: 'секрет' }), 'секрет');
});

test('expandVars не трогает обычные строки', () => {
  assert.equal(expandVars('ollama', {}), 'ollama');
});

test('expandVars отдаёт пустую строку для отсутствующей переменной', () => {
  assert.equal(expandVars('$NETU', {}), '');
});

test('flattenModels собирает статические модели и разворачивает ключ', () => {
  const { models, providers } = flattenModels(raw, { env: { TEST_DS_KEY: 'секрет' } });
  const ds = models.find(m => m.id === 'deepseek-v4-flash');
  assert.equal(ds.provider, 'deepseek');
  assert.equal(ds.baseUrl, 'https://api.deepseek.com');
  assert.equal(ds.contextWindow, 1000000);
  assert.equal(providers.find(p => p.name === 'deepseek').apiKey, 'секрет');
});

test('провайдер без массива models помечается динамическим и моделей не даёт', () => {
  const { providers, models } = flattenModels(raw, { env: {} });
  const ol = providers.find(p => p.name === 'ollama');
  assert.equal(ol.dynamic, true);
  assert.equal(models.some(m => m.provider === 'ollama'), false);
});

test('неподдержанный api не роняет загрузку, а даёт заметку', () => {
  const { models, notes } = flattenModels(raw, { env: {} });
  assert.equal(models.some(m => m.provider === 'exotic'), false);
  assert.ok(notes.some(n => n.includes('exotic')));
});

test('toModel заполняет обязательные поля pi-ai', () => {
  const p = { name: 'x', baseUrl: 'http://h', api: 'openai-completions', compat: {}, overrides: {} };
  const m = toModel(p, { id: 'a' });
  assert.equal(m.name, 'a');
  assert.equal(m.reasoning, false);
  assert.deepEqual(m.input, ['text']);
  assert.equal(typeof m.maxTokens, 'number');
  assert.deepEqual(Object.keys(m.cost).sort(), ['cacheRead', 'cacheWrite', 'input', 'output']);
});

test('modelOverrides накладываются поверх модели', () => {
  const p = { name: 'ollama', baseUrl: 'http://h', api: 'openai-completions', compat: {},
    overrides: { 'g:1': { name: 'Гемма', reasoning: true, contextWindow: 65536 } } };
  const m = toModel(p, { id: 'g:1' });
  assert.equal(m.name, 'Гемма');
  assert.equal(m.reasoning, true);
  assert.equal(m.contextWindow, 65536);
});

test('flattenModels не падает, если models не массив (например объект)', () => {
  const broken = {
    providers: {
      broken: {
        baseUrl: 'http://h',
        api: 'openai-completions',
        models: {},
      },
    },
  };
  const { providers, models } = flattenModels(broken, { env: {} });
  const p = providers.find(p => p.name === 'broken');
  assert.equal(p.dynamic, true);
  assert.equal(models.some(m => m.provider === 'broken'), false);
});

test('toModel дополняет частичный cost нулями', () => {
  const p = { name: 'x', baseUrl: 'http://h', api: 'openai-completions', compat: {}, overrides: {} };
  const m = toModel(p, { id: 'a', cost: { input: 5 } });
  assert.deepEqual(m.cost, { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test('модель без id пропускается с заметкой', () => {
  const raw2 = {
    providers: {
      p1: {
        baseUrl: 'http://h',
        api: 'openai-completions',
        models: [{ id: 'ok' }, {}],
      },
    },
  };
  const { models, notes } = flattenModels(raw2, { env: {} });
  const p1models = models.filter(m => m.provider === 'p1');
  assert.equal(p1models.length, 1);
  assert.equal(p1models[0].id, 'ok');
  assert.ok(notes.some(n => n.includes('p1') && n.includes('без id')));
});

test('cost не расшаривается между моделями одного провайдера', () => {
  const raw3 = {
    providers: {
      p2: {
        baseUrl: 'http://h',
        api: 'openai-completions',
        models: [{ id: 'a' }, { id: 'b' }],
      },
    },
  };
  const { models } = flattenModels(raw3, { env: {} });
  const [a, b] = models.filter(m => m.provider === 'p2');
  assert.notEqual(a.cost, b.cost);
});

test('discoverModels читает /models и накладывает overrides', async () => {
  const provider = { name: 'ollama', baseUrl: 'http://localhost:11434/v1',
    api: 'openai-completions', apiKey: 'ollama', compat: {},
    overrides: { 'gemma4:12b-mlx-64k': { name: 'Гемма', contextWindow: 65536 } } };
  const fake = async url => {
    assert.equal(url, 'http://localhost:11434/v1/models');
    return { ok: true, json: async () => ({ data: [{ id: 'gemma4:12b-mlx-64k' }, { id: 'qwen3.5:latest' }] }) };
  };
  const { models } = await discoverModels(provider, fake);
  assert.equal(models.length, 2);
  assert.equal(models[0].name, 'Гемма');
  assert.equal(models[0].contextWindow, 65536);
  assert.equal(models[1].name, 'qwen3.5:latest');
});

test('discoverModels пропускает элементы без id и не теряет остальные, с заметкой', async () => {
  const provider = { name: 'gw', baseUrl: 'http://h', api: 'openai-completions', apiKey: '', compat: {}, overrides: {} };
  const fake = async () => ({ ok: true, json: async () => ({ data: [{ name: 'x' }, { id: 'ok' }] }) });
  const { models, notes } = await discoverModels(provider, fake);
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'ok');
  assert.ok(notes.some(n => n.includes('gw') && n.includes('без id')));
});

test('discoverModels не падает на null-элементах в data', async () => {
  const provider = { name: 'gw', baseUrl: 'http://h', api: 'openai-completions', apiKey: '', compat: {}, overrides: {} };
  const fake = async () => ({ ok: true, json: async () => ({ data: [null, { id: 'ok' }] }) });
  const { models } = await discoverModels(provider, fake);
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'ok');
});

test('discoverModels отдаёт пустой список, если data не массив', async () => {
  const provider = { name: 'gw', baseUrl: 'http://h', api: 'openai-completions', apiKey: '', compat: {}, overrides: {} };
  const fake = async () => ({ ok: true, json: async () => ({ data: {} }) });
  const { models } = await discoverModels(provider, fake);
  assert.deepEqual(models, []);
});

test('discoverModels отправляет Authorization при непустом ключе', async () => {
  const provider = { name: 'gw', baseUrl: 'http://h', api: 'openai-completions', apiKey: 'секрет-ключ', compat: {}, overrides: {} };
  let seenHeaders;
  const fake = async (url, opts) => { seenHeaders = opts.headers; return { ok: true, json: async () => ({ data: [] }) }; };
  await discoverModels(provider, fake);
  assert.equal(seenHeaders.authorization, 'Bearer секрет-ключ');
});

test('discoverModels не отправляет Authorization при пустом ключе', async () => {
  const provider = { name: 'gw', baseUrl: 'http://h', api: 'openai-completions', apiKey: '', compat: {}, overrides: {} };
  let seenHeaders;
  const fake = async (url, opts) => { seenHeaders = opts.headers; return { ok: true, json: async () => ({ data: [] }) }; };
  await discoverModels(provider, fake);
  assert.equal('authorization' in seenHeaders, false);
});

test('падение discovery не роняет загрузку, а даёт заметку', async () => {
  const fake = async () => { throw new Error('соединение отклонено'); };
  const res = await loadConfig({
    path: FIXTURE_MODELS_PATH,
    authPath: '/no/such/auth.json',
    env: { TEST_DS_KEY: 'секрет' },
    fetchImpl: fake,
  });
  assert.equal(res.error, null);
  assert.ok(res.models.some(m => m.provider === 'deepseek'));
  assert.ok(res.notes.some(n => n.includes('ollama')));
});

test('заметка о неудачном discovery не содержит baseUrl', async () => {
  const fake = async () => ({ ok: false, status: 401 });
  const res = await loadConfig({
    path: FIXTURE_MODELS_PATH,
    authPath: '/no/such/auth.json',
    env: { TEST_DS_KEY: 'секрет' },
    fetchImpl: fake,
  });
  const note = res.notes.find(n => n.includes('ollama'));
  assert.ok(note);
  assert.ok(!note.includes('http'));
});

// Task 3 закрыл только ветку !res.ok ("ответил 401") — сообщение там пишет
// discoverModels сама и явно без baseUrl. Но когда fetchImpl бросает САМ (сеть,
// или — как здесь — undici при разборе URL без схемы), в notes.push(...— ${e.message})
// попадает чужой текст, и его содержимое мы не контролируем. baseUrl должен быть
// вычищен структурно, через secrets, а не за счёт дисциплины в текстах ошибок.
test('провайдер с baseUrl без схемы: настоящая (не подставная) ошибка парсинга URL не протекает в заметку после scrub', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-config-'));
  const modelsPath = join(dir, 'models.json');
  await writeFile(modelsPath, JSON.stringify({
    providers: {
      deepseek: {
        baseUrl: 'api.deepseek.com/v1', // опечатка в схеме — обычный случай для локального OpenAI-совместимого сервера
        api: 'openai-completions',
        apiKey: 'sk-live-secret-full',
      },
    },
  }));
  try {
    // fetchImpl не переопределён — используется настоящий глобальный fetch.
    // Разбор URL падает ДО сетевого обращения (схемы нет), так что тест
    // офлайн-безопасен, но получает подлинное сообщение undici вида
    // "Failed to parse URL from api.deepseek.com/v1/models" — с baseUrl внутри.
    const res = await loadConfig({ path: modelsPath, authPath: '/no/such/auth.json', env: {} });
    const note = res.notes.find(n => n.includes('список моделей не получен'));
    assert.ok(note, 'должна быть заметка о падении discovery');
    assert.ok(note.includes('deepseek.com'), 'сырая (нечищеная) заметка содержит baseUrl — так проявляется дефект');
    const cleaned = scrub(note, res.secrets);
    assert.equal(cleaned.includes('deepseek.com'), false);
    assert.equal(cleaned.includes('sk-live-secret-full'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig().secrets содержит baseUrl каждого провайдера, и scrub вычищает его из произвольного текста', async () => {
  const fake = async () => { throw new Error('оффлайн'); };
  const res = await loadConfig({
    path: FIXTURE_MODELS_PATH,
    authPath: '/no/such/auth.json',
    env: { TEST_DS_KEY: 'секрет' },
    fetchImpl: fake,
  });
  assert.ok(res.secrets.has('https://api.deepseek.com'));
  assert.ok(res.secrets.has('http://localhost:11434/v1'));
  const cleaned = scrub(
    'ошибка при обращении к http://localhost:11434/v1/models и https://api.deepseek.com/models',
    res.secrets,
  );
  assert.equal(cleaned.includes('localhost:11434'), false);
  assert.equal(cleaned.includes('api.deepseek.com'), false);
});

test('publicView отдаёт models/notes/error, вычищенные от ключей и baseUrl', async () => {
  const fake = async () => { throw new Error('оффлайн'); };
  const cfg = await loadConfig({
    path: FIXTURE_MODELS_PATH,
    authPath: '/no/such/auth.json',
    env: { TEST_DS_KEY: 'секрет-из-теста' },
    fetchImpl: fake,
  });
  const view = publicView(cfg);
  assert.deepEqual(Object.keys(view).sort(), ['error', 'models', 'notes']);
  const json = JSON.stringify(view);
  assert.equal(json.includes('секрет-из-теста'), false);
  assert.equal(json.includes('api.deepseek.com'), false);
  assert.equal(json.includes('localhost:11434'), false);
});

test('отсутствующий конфиг даёт пустой список и текст ошибки', async () => {
  const res = await loadConfig({ path: '/no/such/models.json', authPath: '/no/auth.json' });
  assert.deepEqual(res.models, []);
  assert.ok(res.error.includes('создайте его или укажите --pi-config'));
});

test('битый models.json даёт предписанный error и заметку с причиной', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-config-'));
  const modelsPath = join(dir, 'models.json');
  await writeFile(modelsPath, '{ "providers": ', 'utf8');
  try {
    const res = await loadConfig({ path: modelsPath, authPath: '/no/such/auth.json' });
    assert.ok(res.error.includes('создайте его или укажите --pi-config'));
    assert.ok(res.notes.some(n => n.includes('models.json не разобран')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('publicModels отдаёт только три поля', () => {
  const out = publicModels([{ provider: 'p', id: 'i', contextWindow: 1, baseUrl: 'секрет', compat: {} }]);
  assert.deepEqual(Object.keys(out[0]).sort(), ['contextWindow', 'id', 'provider']);
});

test('publicModels на реальном результате loadConfig не содержит baseUrl и ключей', async () => {
  const fake = async () => ({ ok: true, json: async () => ({ data: [] }) });
  const res = await loadConfig({
    path: FIXTURE_MODELS_PATH,
    authPath: '/no/such/auth.json',
    env: { TEST_DS_KEY: 'секрет-ключ-123' },
    fetchImpl: fake,
  });
  const json = JSON.stringify(publicModels(res.models));
  assert.ok(!json.includes('baseUrl'));
  assert.ok(!json.includes('apiKey'));
  assert.ok(!json.includes('секрет-ключ-123'));
});

test('loadConfig берёт apiKey из auth.json, когда его нет в models.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-config-'));
  const authPath = join(dir, 'auth.json');
  await writeFile(authPath, JSON.stringify({ exotic: { key: 'из-auth-json' } }));
  try {
    const fake = async () => ({ ok: true, json: async () => ({ data: [] }) });
    const res = await loadConfig({
      path: FIXTURE_MODELS_PATH,
      authPath,
      env: { TEST_DS_KEY: 'секрет' },
      fetchImpl: fake,
    });
    const exotic = res.providers.find(p => p.name === 'exotic');
    assert.equal(exotic.apiKey, 'из-auth-json');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig берёт apiKey из окружения, если его нет ни в models.json, ни в auth.json', async () => {
  const fake = async () => ({ ok: true, json: async () => ({ data: [] }) });
  const res = await loadConfig({
    path: FIXTURE_MODELS_PATH,
    authPath: '/no/such/auth.json',
    env: { TEST_DS_KEY: 'секрет', EXOTIC_API_KEY: 'из-окружения' },
    fetchImpl: fake,
  });
  const exotic = res.providers.find(p => p.name === 'exotic');
  assert.equal(exotic.apiKey, 'из-окружения');
});

test('приоритет ключа: models.json побеждает auth.json и окружение', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-config-'));
  const authPath = join(dir, 'auth.json');
  await writeFile(authPath, JSON.stringify({ deepseek: { key: 'из-auth-json' } }));
  try {
    const fake = async () => ({ ok: true, json: async () => ({ data: [] }) });
    const res = await loadConfig({
      path: FIXTURE_MODELS_PATH,
      authPath,
      env: { TEST_DS_KEY: 'из-models-json', DEEPSEEK_API_KEY: 'из-окружения' },
      fetchImpl: fake,
    });
    const ds = res.providers.find(p => p.name === 'deepseek');
    assert.equal(ds.apiKey, 'из-models-json');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('приоритет ключа: без значения в models.json побеждает auth.json над окружением (и работает запасное поле apiKey)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-config-'));
  const authPath = join(dir, 'auth.json');
  await writeFile(authPath, JSON.stringify({ exotic: { apiKey: 'из-auth-json' } }));
  try {
    const fake = async () => ({ ok: true, json: async () => ({ data: [] }) });
    const res = await loadConfig({
      path: FIXTURE_MODELS_PATH,
      authPath,
      env: { TEST_DS_KEY: 'секрет', EXOTIC_API_KEY: 'из-окружения' },
      fetchImpl: fake,
    });
    const exotic = res.providers.find(p => p.name === 'exotic');
    assert.equal(exotic.apiKey, 'из-auth-json');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig().secrets содержит ключи и из models.json, и из auth.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-config-'));
  const authPath = join(dir, 'auth.json');
  await writeFile(authPath, JSON.stringify({ exotic: { key: 'секрет-из-auth-json' } }));
  try {
    const fake = async () => ({ ok: true, json: async () => ({ data: [] }) });
    const res = await loadConfig({
      path: FIXTURE_MODELS_PATH,
      authPath,
      env: { TEST_DS_KEY: 'секрет-из-models-json' },
      fetchImpl: fake,
    });
    assert.ok(res.secrets.has('секрет-из-models-json'));
    assert.ok(res.secrets.has('секрет-из-auth-json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('битый auth.json даёт заметку и не роняет загрузку', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-config-'));
  const authPath = join(dir, 'auth.json');
  await writeFile(authPath, '{ "deepseek": ', 'utf8');
  try {
    const fake = async () => ({ ok: true, json: async () => ({ data: [] }) });
    const res = await loadConfig({
      path: FIXTURE_MODELS_PATH,
      authPath,
      env: { TEST_DS_KEY: 'секрет' },
      fetchImpl: fake,
    });
    assert.equal(res.error, null);
    assert.ok(res.notes.some(n => n.includes('auth.json') && n.includes('не разобран')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('auth.json с литералом null не роняет загрузку', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-config-'));
  const authPath = join(dir, 'auth.json');
  await writeFile(authPath, 'null', 'utf8');
  try {
    const fake = async () => ({ ok: true, json: async () => ({ data: [] }) });
    const res = await loadConfig({
      path: FIXTURE_MODELS_PATH,
      authPath,
      env: { TEST_DS_KEY: 'секрет' },
      fetchImpl: fake,
    });
    assert.equal(res.error, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('отсутствующий auth.json не даёт заметку', async () => {
  const fake = async () => ({ ok: true, json: async () => ({ data: [] }) });
  const res = await loadConfig({
    path: FIXTURE_MODELS_PATH,
    authPath: '/no/such/auth.json',
    env: { TEST_DS_KEY: 'секрет' },
    fetchImpl: fake,
  });
  assert.ok(!res.notes.some(n => n.includes('auth.json')));
});

test('scrub заменяет секрет на звёздочки', () => {
  const secrets = new Set(['sk-secret-key-12345']);
  const text = 'Ошибка: ключ sk-secret-key-12345 не прошёл';
  const out = scrub(text, secrets);
  assert.ok(!out.includes('sk-secret-key-12345'));
  assert.ok(out.includes('***'));
});

test('scrub чистит секрет короче 8 символов', () => {
  const out = scrub('ключ ollama использован', new Set(['ollama']));
  assert.ok(!out.includes('ollama'));
  assert.ok(out.includes('***'));
});

test('scrub с пустой строкой в секретах не портит текст', () => {
  const out = scrub('привет мир', new Set(['']));
  assert.equal(out, 'привет мир');
});

test('scrub маскирует пересекающиеся секреты полностью', () => {
  const secrets = new Set(['sk-org-ABC', 'sk-org-ABC-proj-Z']);
  const out = scrub('ключ sk-org-ABC-proj-Z в логах', secrets);
  assert.ok(!out.includes('sk-org-ABC-proj-Z'));
  assert.ok(!out.includes('-proj-Z'));
});

test('findBuiltinModel находит модель встроенного провайдера', () => {
  const m = findBuiltinModel('openrouter', 'openrouter/free');
  assert.ok(m, 'модель openrouter/free должна быть в пакете');
  assert.equal(m.provider, 'openrouter');
  assert.equal(m.api, 'openai-completions');
  assert.equal(typeof m.contextWindow, 'number');
  for (const k of ['id', 'name', 'api', 'provider', 'baseUrl', 'cost', 'maxTokens']) {
    assert.ok(k in m, `нет поля ${k}`);
  }
});

test('findBuiltinModel возвращает null для неизвестного провайдера и модели', () => {
  assert.equal(findBuiltinModel('такого-нет', 'что-угодно'), null);
  assert.equal(findBuiltinModel('openrouter', 'такой-модели-нет'), null);
});

test('builtinProviderRecord даёт запись провайдера с функцией потока', () => {
  const p = builtinProviderRecord('openrouter');
  assert.equal(p.name, 'openrouter');
  assert.equal(p.builtin, true);
  assert.equal(typeof p.streamFn, 'function');
  assert.ok(p.baseUrl.startsWith('https://'));
});

test('builtinProviderRecord возвращает null для неизвестного', () => {
  assert.equal(builtinProviderRecord('такого-нет'), null);
});

test('streamFn действительно зовёт поток провайдера и передаёт ключ', async () => {
  const p = builtinProviderRecord('openrouter');
  const model = findBuiltinModel('openrouter', 'openrouter/free');
  let seen = null;
  const fakeFetch = async (url, init) => {
    seen = { url: String(url), headers: init?.headers };
    return new Response('', { status: 401, headers: { 'content-type': 'application/json' } });
  };
  // Ключ — латиницей: OpenAI SDK кладёт apiKey в HTTP-заголовок Authorization,
  // а заголовки — ByteString (WHATWG Fetch), кириллица там в принципе
  // непредставима и роняет сборку клиента ДО вызова fetch — это ограничение
  // протокола, не то, что тест проверяет. Настоящие API-ключи всегда ASCII.
  const TEST_KEY = 'KLYUCH-DLYA-PROVERKI';
  const events = p.streamFn(model, { systemPrompt: 'с', messages: [] },
    { apiKey: TEST_KEY, fetch: fakeFetch, maxTokens: 16 });
  try { for await (const _ of events) { /* до первой ошибки */ } } catch { /* 401 ожидаем */ }
  assert.ok(seen, 'запрос должен был уйти в подставной fetch');
  const auth = JSON.stringify(seen.headers instanceof Headers ? Object.fromEntries(seen.headers) : (seen.headers ?? {}));
  assert.ok(auth.includes(TEST_KEY), 'ключ должен попасть в заголовки: ' + auth);
});

// --- Task 3: enabledModels как источник списка моделей ---

test('enabledModels становится списком моделей', async () => {
  await withSettingsFile({
    enabledModels: ['deepseek/deepseek-v4-flash', 'openrouter/openrouter/free'],
  }, async settingsPath => {
    const c = await loadConfig({
      path: FIXTURE_MODELS_PATH, authPath: '/нет/auth.json', settingsPath,
      env: { TEST_DS_KEY: 'секрет', OPENROUTER_API_KEY: 'kluch-routera' }, fetchImpl: NO_NET,
    });
    assert.equal(c.models.length, 2);
    assert.ok(c.models.some(m => m.provider === 'deepseek' && m.id === 'deepseek-v4-flash'));
    assert.ok(c.models.some(m => m.provider === 'openrouter' && m.id === 'openrouter/free'));
  });
});

test('пользовательский провайдер побеждает встроенный при совпадении', async () => {
  await withSettingsFile({ enabledModels: ['deepseek/deepseek-v4-flash'] }, async settingsPath => {
    const c = await loadConfig({
      path: FIXTURE_MODELS_PATH, authPath: '/нет/auth.json', settingsPath,
      env: { TEST_DS_KEY: 'секрет' }, fetchImpl: NO_NET,
    });
    const m = c.models.find(x => x.id === 'deepseek-v4-flash');
    // Различаем источник по compat, а НЕ по contextWindow: у встроенного
    // deepseek-v4-flash он тоже 1000000, и такая проверка прошла бы при любом
    // источнике. У встроенного compat из пяти ключей, у собранного нашим
    // toModel — ровно один, унаследованный от провайдера в фикстуре.
    assert.deepEqual(m.compat, { supportsDeveloperRole: false });
  });
});

test('неразрешимая запись даёт заметку и не роняет загрузку', async () => {
  await withSettingsFile({
    enabledModels: ['takogo-net/model', 'deepseek/deepseek-v4-flash'],
  }, async settingsPath => {
    const c = await loadConfig({
      path: FIXTURE_MODELS_PATH, authPath: '/нет/auth.json', settingsPath,
      env: { TEST_DS_KEY: 'секрет' }, fetchImpl: NO_NET,
    });
    assert.equal(c.error, null);
    assert.equal(c.models.length, 1);
    assert.ok(c.notes.some(n => n.includes('takogo-net')));
  });
});

test('модель без ключа не попадает в список', async () => {
  await withSettingsFile({ enabledModels: ['openrouter/openrouter/free'] }, async settingsPath => {
    const c = await loadConfig({
      path: FIXTURE_MODELS_PATH, authPath: '/нет/auth.json', settingsPath,
      env: {}, fetchImpl: NO_NET,
    });
    assert.equal(c.models.length, 0);
    assert.ok(c.notes.some(n => n.includes('openrouter')));
  });
});

test('пустой enabledModels даёт прежнее поведение', async () => {
  await withSettingsFile({ enabledModels: [] }, async settingsPath => {
    const c = await loadConfig({
      path: FIXTURE_MODELS_PATH, authPath: '/нет/auth.json', settingsPath,
      env: { TEST_DS_KEY: 'секрет' }, fetchImpl: NO_NET,
    });
    assert.ok(c.models.some(m => m.provider === 'deepseek'));
    assert.equal(c.models.some(m => m.provider === 'openrouter'), false);
  });
});

test('отсутствующий settings.json даёт прежнее поведение', async () => {
  const c = await loadConfig({
    path: FIXTURE_MODELS_PATH, authPath: '/нет/auth.json', settingsPath: '/нет/settings.json',
    env: { TEST_DS_KEY: 'секрет' }, fetchImpl: NO_NET,
  });
  assert.ok(c.models.some(m => m.provider === 'deepseek'));
});

test('умолчание доезжает до результата загрузки', async () => {
  await withSettingsFile({
    enabledModels: ['deepseek/deepseek-v4-flash'],
    defaultProvider: 'deepseek', defaultModel: 'deepseek-v4-flash',
  }, async settingsPath => {
    const c = await loadConfig({
      path: FIXTURE_MODELS_PATH, authPath: '/нет/auth.json', settingsPath,
      env: { TEST_DS_KEY: 'секрет' }, fetchImpl: NO_NET,
    });
    assert.deepEqual(c.default, { provider: 'deepseek', id: 'deepseek-v4-flash' });
  });
});

test('baseUrl встроенного провайдера попадает в secrets', async () => {
  await withSettingsFile({ enabledModels: ['openrouter/openrouter/free'] }, async settingsPath => {
    const c = await loadConfig({
      path: FIXTURE_MODELS_PATH, authPath: '/нет/auth.json', settingsPath,
      env: { OPENROUTER_API_KEY: 'kluch-routera' }, fetchImpl: NO_NET,
    });
    assert.ok([...c.secrets].some(s => s.includes('openrouter.ai')));
    assert.ok(c.secrets.has('kluch-routera'));
  });
});

// --- Дополнительные тесты (проверка на дефекты сверх плана) ---

test('порядок моделей в результате соответствует порядку enabledModels, а не порядку провайдеров', async () => {
  await withSettingsFile({
    // Порядок нарочно "против" models.json: сперва openrouter (встроенный,
    // добавляется последним в providers), потом deepseek (первый в фикстуре).
    enabledModels: ['openrouter/openrouter/free', 'deepseek/deepseek-v4-flash'],
  }, async settingsPath => {
    const c = await loadConfig({
      path: FIXTURE_MODELS_PATH, authPath: '/нет/auth.json', settingsPath,
      env: { TEST_DS_KEY: 'секрет', OPENROUTER_API_KEY: 'kluch-routera' }, fetchImpl: NO_NET,
    });
    assert.deepEqual(c.models.map(m => m.provider), ['openrouter', 'deepseek']);
  });
});

test('дубль в enabledModels не даёт двух записей', async () => {
  await withSettingsFile({
    enabledModels: ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-flash'],
  }, async settingsPath => {
    const c = await loadConfig({
      path: FIXTURE_MODELS_PATH, authPath: '/нет/auth.json', settingsPath,
      env: { TEST_DS_KEY: 'секрет' }, fetchImpl: NO_NET,
    });
    assert.equal(c.models.filter(m => m.provider === 'deepseek' && m.id === 'deepseek-v4-flash').length, 1);
  });
});

test('пользовательский провайдер есть, но такой модели у него нет — заметка, а не молчаливый пропуск', async () => {
  await withSettingsFile({
    enabledModels: ['deepseek/такой-модели-нет'],
  }, async settingsPath => {
    const c = await loadConfig({
      path: FIXTURE_MODELS_PATH, authPath: '/нет/auth.json', settingsPath,
      env: { TEST_DS_KEY: 'секрет' }, fetchImpl: NO_NET,
    });
    assert.equal(c.models.length, 0);
    assert.ok(c.notes.some(n => n.includes('deepseek') && n.includes('такой-модели-нет')));
  });
});

test('заметки о пропущенных моделях чистятся scrub через publicView', async () => {
  await withSettingsFile({
    enabledModels: ['takogo-net/model', 'openrouter/openrouter/free'],
  }, async settingsPath => {
    const c = await loadConfig({
      path: FIXTURE_MODELS_PATH, authPath: '/нет/auth.json', settingsPath,
      env: {}, fetchImpl: NO_NET,
    });
    // Без ключа openrouter тоже даст заметку — обе должны пройти publicView.
    assert.ok(c.notes.length >= 2);
    const view = publicView(c);
    const json = JSON.stringify(view);
    for (const s of c.secrets) {
      if (!s) continue;
      assert.equal(json.includes(s), false, `секрет "${s}" протёк в publicView`);
    }
  });
});
