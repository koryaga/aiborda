import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { expandVars, flattenModels, toModel, discoverModels, loadConfig, publicModels, scrub } from '../server/pi-config.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raw = JSON.parse(await readFile(new URL('./fixtures/models.json', import.meta.url), 'utf8'));
// fileURLToPath (не .pathname) декодирует пробелы и юникод в пути проекта корректно.
const FIXTURE_MODELS_PATH = fileURLToPath(new URL('./fixtures/models.json', import.meta.url));

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
