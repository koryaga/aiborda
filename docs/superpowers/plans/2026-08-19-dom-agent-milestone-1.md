# DOM-агент, веха 1: первый живой ход

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** довести систему до первого настоящего хода: человек правит образ руками, жмёт «отправить», локальная модель отвечает кодом, код меняет тот же DOM.

**Architecture:** сайдкар на `node:http` держит историю и ходит к провайдеру через `@earendil-works/pi-ai`; оболочка — статическая страница, которая общается с образом по `postMessage`; образ — `iframe sandbox="allow-scripts"` со `srcdoc` из `seed.html` и инлайненного `image-boot.js`. Правки человека ловятся `MutationObserver`, правки модели отсекаются по окну исполнения.

**Tech Stack:** Node ≥ 20 (на машине 26.5), ESM, `node:test` + `jsdom` для тестов, `@earendil-works/pi-ai@0.84.2` как единственная рантайм-зависимость. Без бандлера, без Express, без фреймворка.

---

## Границы вехи

Этот план покрывает §11 шаги 1–4 спецификации
`docs/superpowers/specs/2026-08-19-dom-agent-design.md`.

**Входит:** загрузчик конфига pi, `/api/models`, оболочка с селектором,
образ с `exec`/`snap`, захват правок человека и сборка дифа, разбор ответа
модели, `/api/commit` со стримом, применение кода, возврат результата в
историю.

**Не входит (веха 2):** карта образа (§3), сброс истории и его триггеры,
счётчик токенов в UI, очередь и пауза (§2), watchdog с восстановлением,
журнал и снапшоты на диск (§8).

**Поправка к спецификации, принятая здесь:** отдельного `POST /api/result`
нет. Результат предыдущего хода едет в теле следующего `POST /api/commit`
полем `result`, и сайдкар кладёт его в историю перед дифом. Порядок
сообщений получается ровно такой, как в §3, и лишнего запроса нет. §5
спецификации обновляется в задаче 12.

## Проверенные факты, на которых стоит план

Все взяты из `.d.ts` установленного `@earendil-works/pi-ai@0.84.2` и со
стенда, описанного в §0 спецификации. Не перепроверяйте, но и не
изобретайте альтернатив.

- `import { stream } from '@earendil-works/pi-ai/api/openai-completions'` —
  сигнатура `(model, context, options) => AssistantMessageEventStream`.
  Регистрировать провайдера и заводить credential store **не нужно**:
  `options.apiKey` и `options.signal` принимаются прямо в вызове.
- `AssistantMessageEventStream` реализует `AsyncIterable`, обходится
  через `for await`.
- События потока: `text_delta` (`.delta`), `thinking_delta`, `done`
  (`.message`), `error` (`.error.errorMessage`). Рассуждения приходят
  **отдельным типом события**, поэтому §7 шаг 0 сводится к «читать только
  `text_delta`».
- `Context = { systemPrompt?: string, messages: Message[] }`.
- `UserMessage = { role:'user', content: string | […], timestamp: number }` —
  строка в `content` допустима.
- `AssistantMessage` требует `role, content, api, provider, model, usage,
  stopReason, timestamp`; `content` — массив `{type:'text', text}`.
- `Usage = { input, output, cacheRead, cacheWrite, totalTokens, cost:{input,
  output, cacheRead, cacheWrite, total} }`.
- `Model` требует `id, name, api, provider, baseUrl, reasoning, input, cost,
  contextWindow, maxTokens`.

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `package.json` | ESM, скрипты, зависимости |
| `server/pi-config.js` | чтение `models.json`/`auth.json`, `$VAR`, discovery, сбор секретов |
| `server/parse.js` | превращение ответа модели в исполняемый код |
| `server/context.js` | системный промпт, история сообщений, оценка токенов |
| `server/index.js` | HTTP, статика, `/api/models`, `/api/reload`, `/api/commit`, `/api/abort` |
| `web/index.html` | разметка оболочки |
| `web/shell.js` | сборка образа, `postMessage`, ход, разбор потока |
| `web/image-boot.js` | наблюдатель, атрибуция, диф, снапшот, `exec` |
| `web/seed.html` | заготовка образа |
| `web/style.css` | оформление оболочки |
| `test/*.test.js` | тесты на `node:test` |

`server/providers.js` не создаётся: адаптеры берутся из `pi-ai`.

`web/image-boot.js` не имеет импортов и объявляет одну функцию
`createImage(doc, send, opts)`. Оболочка забирает текст файла и вставляет
его в `srcdoc`; тесты забирают тот же текст и выполняют его в jsdom.
Тестируется ровно то, что исполняется в браузере.

---

### Task 1: Каркас проекта

**Files:**
- Create: `package.json`, `.gitignore`, `test/smoke.test.js`

- [ ] **Step 1: Инициализировать репозиторий**

```bash
git init && git add PLAN.md docs && git commit -m "chore: спецификация и план"
```

- [ ] **Step 2: Создать `package.json`**

```json
{
  "name": "dom-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node server/index.js",
    "test": "node --test"
  }
}
```

Без пути-директории намеренно: на Node 26.5.0 `node --test test/` пытается
разрешить директорию как модуль и падает. Автопоиск находит те же файлы.

- [ ] **Step 3: Создать `.gitignore`**

```
node_modules/
.dom-agent/
```

- [ ] **Step 4: Поставить зависимости**

```bash
npm install @earendil-works/pi-ai@0.84.2 && npm install --save-dev jsdom
```

- [ ] **Step 5: Написать smoke-тест**

`test/smoke.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

test('jsdom умеет MutationObserver с oldValue', async () => {
  const dom = new JSDOM('<div id="a" class="v1"></div>');
  const doc = dom.window.document;
  const seen = [];
  const obs = new dom.window.MutationObserver(rs => { for (const r of rs) seen.push(r.oldValue); });
  obs.observe(doc.documentElement, { subtree: true, attributes: true, attributeOldValue: true });
  doc.querySelector('#a').setAttribute('class', 'v2');
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(seen, ['v1']);
});
```

- [ ] **Step 6: Запустить тест**

Run: `npm test`
Expected: PASS, 1 тест. Если `MutationObserver` в jsdom не работает —
остановиться и сообщить: на нём стоит весь план тестов образа.

- [ ] **Step 7: Коммит**

```bash
git add package.json package-lock.json .gitignore test/smoke.test.js && git commit -m "chore: каркас проекта, node:test и jsdom"
```

---

### Task 2: `pi-config` — разворачивание `$VAR` и плоский список моделей

**Files:**
- Create: `server/pi-config.js`, `test/pi-config.test.js`, `test/fixtures/models.json`

- [ ] **Step 1: Создать фикстуру `test/fixtures/models.json`**

```json
{
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com",
      "api": "openai-completions",
      "apiKey": "$TEST_DS_KEY",
      "compat": { "supportsDeveloperRole": false },
      "models": [
        { "id": "deepseek-v4-flash", "name": "DeepSeek V4 Flash", "contextWindow": 1000000, "maxTokens": 384000 }
      ]
    },
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "modelOverrides": {
        "gemma4:12b-mlx-64k": { "name": "Gemma 4 12B MLX 64K", "reasoning": true, "contextWindow": 65536 }
      }
    },
    "exotic": {
      "baseUrl": "https://example.com",
      "api": "google-generative-ai",
      "models": [{ "id": "whatever" }]
    }
  }
}
```

- [ ] **Step 2: Написать падающие тесты**

`test/pi-config.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { expandVars, flattenModels, toModel } from '../server/pi-config.js';

const raw = JSON.parse(await readFile(new URL('./fixtures/models.json', import.meta.url), 'utf8'));

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
```

- [ ] **Step 3: Запустить тесты и убедиться, что падают**

Run: `npm test`
Expected: FAIL, `Cannot find module '../server/pi-config.js'`

- [ ] **Step 4: Написать `server/pi-config.js`**

```js
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_MODELS_PATH = join(homedir(), '.pi', 'agent', 'models.json');
export const DEFAULT_AUTH_PATH = join(homedir(), '.pi', 'agent', 'auth.json');

const SUPPORTED = new Set(['openai-completions', 'anthropic-messages']);
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function expandVars(value, env = process.env) {
  if (typeof value !== 'string') return value;
  const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(value);
  if (!m) return value;
  return env[m[1]] ?? '';
}

export function toModel(provider, spec) {
  const merged = { ...spec, ...(provider.overrides[spec.id] ?? {}) };
  return {
    id: merged.id,
    name: merged.name ?? merged.id,
    api: provider.api,
    provider: provider.name,
    baseUrl: provider.baseUrl,
    reasoning: merged.reasoning ?? false,
    input: merged.input ?? ['text'],
    cost: { ...ZERO_COST, ...merged.cost },
    contextWindow: merged.contextWindow ?? 32768,
    maxTokens: merged.maxTokens ?? 4096,
    compat: { ...provider.compat, ...(merged.compat ?? {}) },
  };
}

export function flattenModels(raw, { env = process.env } = {}) {
  const providers = [], models = [], notes = [];
  for (const [name, p] of Object.entries(raw?.providers ?? {})) {
    const provider = {
      name,
      baseUrl: p.baseUrl,
      api: p.api,
      apiKey: expandVars(p.apiKey, env),
      compat: p.compat ?? {},
      overrides: p.modelOverrides ?? {},
      supported: SUPPORTED.has(p.api),
      dynamic: !Array.isArray(p.models),
    };
    providers.push(provider);
    if (!provider.supported) {
      notes.push(`провайдер ${name}: api "${p.api}" не поддержан, модели пропущены`);
      continue;
    }
    for (const spec of Array.isArray(p.models) ? p.models : []) {
      if (typeof spec.id !== 'string' || spec.id === '') {
        notes.push(`провайдер ${name}: модель без id пропущена`);
        continue;
      }
      models.push(toModel(provider, spec));
    }
  }
  return { providers, models, notes };
}
```

`Array.isArray` вместо `?? []` намеренно: `"models": {}` в правленом руками
конфиге иначе роняет разбор целиком, хотя строкой выше не-массив уже признан
штатным случаем. `cost` мержится поверх нулей, иначе частично заданная цена
даёт `NaN` при расчёте.

- [ ] **Step 5: Запустить тесты**

Run: `npm test`
Expected: PASS, все тесты `pi-config` зелёные.

- [ ] **Step 6: Коммит**

```bash
git add server/pi-config.js test/pi-config.test.js test/fixtures/models.json && git commit -m "feat(config): плоский список моделей из models.json"
```

---

### Task 3: `pi-config` — discovery для провайдера без `models`

Провайдер `ollama` в реальном конфиге пользователя не имеет массива `models`.
Без этой задачи селектор по нему пуст.

**Files:**
- Modify: `server/pi-config.js`
- Modify: `test/pi-config.test.js`

- [ ] **Step 1: Написать падающие тесты**

Дописать в `test/pi-config.test.js`:

```js
import { discoverModels, loadConfig, publicModels } from '../server/pi-config.js';

test('discoverModels читает /models и накладывает overrides', async () => {
  const provider = { name: 'ollama', baseUrl: 'http://localhost:11434/v1',
    api: 'openai-completions', apiKey: 'ollama', compat: {},
    overrides: { 'gemma4:12b-mlx-64k': { name: 'Гемма', contextWindow: 65536 } } };
  const fake = async url => {
    assert.equal(url, 'http://localhost:11434/v1/models');
    return { ok: true, json: async () => ({ data: [{ id: 'gemma4:12b-mlx-64k' }, { id: 'qwen3.5:latest' }] }) };
  };
  const models = await discoverModels(provider, fake);
  assert.equal(models.length, 2);
  assert.equal(models[0].name, 'Гемма');
  assert.equal(models[0].contextWindow, 65536);
  assert.equal(models[1].name, 'qwen3.5:latest');
});

test('падение discovery не роняет загрузку, а даёт заметку', async () => {
  const fake = async () => { throw new Error('соединение отклонено'); };
  const res = await loadConfig({
    path: new URL('./fixtures/models.json', import.meta.url).pathname,
    authPath: '/no/such/auth.json',
    env: { TEST_DS_KEY: 'секрет' },
    fetchImpl: fake,
  });
  assert.equal(res.error, null);
  assert.ok(res.models.some(m => m.provider === 'deepseek'));
  assert.ok(res.notes.some(n => n.includes('ollama')));
});

test('отсутствующий конфиг даёт пустой список и текст ошибки', async () => {
  const res = await loadConfig({ path: '/no/such/models.json', authPath: '/no/auth.json' });
  assert.deepEqual(res.models, []);
  assert.ok(res.error.includes('создайте его или укажите --pi-config'));
});

test('publicModels отдаёт только три поля', () => {
  const out = publicModels([{ provider: 'p', id: 'i', contextWindow: 1, baseUrl: 'секрет', compat: {} }]);
  assert.deepEqual(Object.keys(out[0]).sort(), ['contextWindow', 'id', 'provider']);
});
```

- [ ] **Step 2: Запустить и убедиться, что падают**

Run: `npm test`
Expected: FAIL, `discoverModels is not a function`

- [ ] **Step 3: Дописать `server/pi-config.js`**

```js
export async function discoverModels(provider, fetchImpl = globalThis.fetch) {
  if (provider.api !== 'openai-completions') return [];
  const url = provider.baseUrl.replace(/\/+$/, '') + '/models';
  const headers = provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {};
  const res = await fetchImpl(url, { headers });
  if (!res.ok) throw new Error(`${url} ответил ${res.status}`);
  const body = await res.json();
  return (body?.data ?? []).map(d => toModel(provider, { id: d.id }));
}

async function readAuth(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return {}; }
}

function collectStrings(value, out) {
  if (typeof value === 'string') { if (value.length >= 8) out.add(value); return out; }
  if (value && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, out);
  return out;
}

export async function loadConfig({
  path = DEFAULT_MODELS_PATH,
  authPath = DEFAULT_AUTH_PATH,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  let raw;
  try { raw = JSON.parse(await readFile(path, 'utf8')); }
  catch {
    return { providers: [], models: [], notes: [], secrets: new Set(),
      error: `не найден ${path} — создайте его или укажите --pi-config` };
  }

  const auth = await readAuth(authPath);
  const { providers, models, notes } = flattenModels(raw, { env });

  for (const p of providers) {
    if (p.apiKey) continue;
    const entry = auth[p.name];
    const stored = typeof entry?.key === 'string' ? entry.key
      : typeof entry?.apiKey === 'string' ? entry.apiKey : '';
    p.apiKey = stored || env[`${p.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`] || '';
  }

  for (const p of providers) {
    if (!p.supported || !p.dynamic) continue;
    try { models.push(...await discoverModels(p, fetchImpl)); }
    catch (e) { notes.push(`провайдер ${p.name}: список моделей не получен — ${e.message}`); }
  }

  const secrets = new Set();
  collectStrings(auth, secrets);
  for (const p of providers) if (p.apiKey) secrets.add(p.apiKey);

  return { providers, models, notes, secrets, error: null };
}

export function publicModels(models) {
  return models.map(m => ({ provider: m.provider, id: m.id, contextWindow: m.contextWindow }));
}

export function scrub(text, secrets) {
  let out = String(text ?? '');
  for (const s of secrets ?? []) if (s && s.length >= 8) out = out.split(s).join('***');
  return out;
}
```

> **Реализованный код отличается от этого блока — смотрите `server/pi-config.js`.**
> Ревью качества нашло в написанном выше пять дефектов, все исправлены:
> `discoverModels` возвращает `{models, notes}` и валидирует каждый элемент
> ответа; `baseUrl` убран из текста ошибки, иначе он уходил в браузер
> заметкой в обход `publicModels` и ломал приёмку §12 п.5; порог длины
> секрета убран из `scrub` и оставлен только в сборе кандидатов, иначе ключ
> короче 8 символов попадал в множество и гарантированно не вычищался;
> секреты сортируются по убыванию длины; битый `auth.json` даёт заметку,
> а не молчит. Ниже оставлено как история решения.

- [ ] **Step 4: Запустить тесты**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Проверить на настоящем конфиге**

```bash
node -e "import('./server/pi-config.js').then(async m => { const c = await m.loadConfig(); console.log('моделей:', c.models.length, 'провайдеры:', [...new Set(c.models.map(x => x.provider))]); console.log('заметки:', c.notes); console.log('ключ утёк в публичный вид:', JSON.stringify(m.publicModels(c.models)).includes('om-')); })"
```

Expected: среди провайдеров есть `ollama` с непустым списком моделей;
последняя строка `false`.

- [ ] **Step 6: Коммит**

```bash
git add server/pi-config.js test/pi-config.test.js && git commit -m "feat(config): discovery динамических провайдеров и сбор секретов"
```

---

### Task 4: Сайдкар — HTTP, `/api/models`, `/api/reload`, статика

**Files:**
- Create: `server/index.js`, `test/server.test.js`

- [ ] **Step 1: Написать падающие тесты**

`test/server.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';

const FIXTURE = new URL('./fixtures/models.json', import.meta.url).pathname;

async function withServer(opts, fn) {
  const app = createApp(opts);
  await app.listen(0);
  try { await fn(`http://127.0.0.1:${app.port}`, app); } finally { await app.close(); }
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

test('выход за пределы web/ запрещён', async () => {
  await withServer({ configPath: '/no/models.json', authPath: '/no/auth.json' }, async base => {
    assert.equal((await fetch(base + '/../package.json')).status, 404);
  });
});
```

- [ ] **Step 2: Запустить и убедиться, что падают**

Run: `npm test`
Expected: FAIL, `Cannot find module '../server/index.js'`

- [ ] **Step 3: Написать `server/index.js`**

```js
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

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function serveStatic(res, pathname) {
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
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (url.pathname === '/api/models') {
        const c = state.config ?? await reload();
        return json(res, 200, publicView(c));
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
    server, reload, state, readJson,
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
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add server/index.js test/server.test.js && git commit -m "feat(server): HTTP, /api/models, /api/reload, статика"
```

---

### Task 5: Образ — seed и `image-boot` с `exec` и `snap`

**Files:**
- Create: `web/seed.html`, `web/image-boot.js`, `test/image-exec.test.js`

- [ ] **Step 1: Создать `web/seed.html`**

```html
<textarea id="q" rows="3"></textarea>
<ul id="items"></ul>
<div id="out"></div>
<div id="notes" hidden></div>
```

- [ ] **Step 2: Написать падающие тесты**

`test/image-exec.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const src = await readFile(new URL('../web/image-boot.js', import.meta.url), 'utf8');
const createImage = new Function(src + '\nreturn createImage;')();

function makeImage(html = '<textarea id="q"></textarea><div id="out"></div>') {
  const dom = new JSDOM(`<body>${html}</body>`, { runScripts: 'outside-only' });
  const sent = [];
  const img = createImage(dom.window.document, m => sent.push(m), { trusted: () => true, grace: 0 });
  return { dom, doc: dom.window.document, img, sent };
}

test('exec возвращает значение', async () => {
  const { img } = makeImage();
  const r = await img.exec('return 1 + 1');
  assert.equal(r.ok, true);
  assert.equal(r.value, '2');
});

test('exec меняет DOM', async () => {
  const { img, doc } = makeImage();
  await img.exec('document.querySelector("#out").textContent = "готово"');
  assert.equal(doc.querySelector('#out').textContent, 'готово');
});

test('exec возвращает ошибку, а не бросает', async () => {
  const { img } = makeImage();
  const r = await img.exec('нетТакогоОбъекта.поле');
  assert.equal(r.ok, false);
  assert.ok(r.error.length > 0);
});

test('exec без return не даёт значения', async () => {
  const { img } = makeImage();
  const r = await img.exec('const x = 1;');
  assert.equal(r.ok, true);
  assert.equal(r.value, undefined);
});

test('значение усекается до 10000 символов', async () => {
  const { img } = makeImage();
  const r = await img.exec('return "я".repeat(20000)');
  assert.equal(r.value.length, 10000);
});

test('snapshot переносит живое значение поля в разметку', async () => {
  const { img, doc } = makeImage();
  doc.querySelector('#q').value = 'набрано';
  assert.ok(img.snapshot().includes('набрано'));
});

test('snapshot не мутирует живой DOM', async () => {
  const { img, doc } = makeImage();
  const q = doc.querySelector('#q');
  q.value = 'набрано';
  img.snapshot();
  assert.equal(q.getAttribute('value'), null);
});

test('handle отвечает на exec сообщением result с тем же id', async () => {
  const { img, sent } = makeImage();
  await img.handle({ type: 'exec', id: 7, code: 'return 5' });
  assert.deepEqual(sent.at(-1), { type: 'result', id: 7, ok: true, value: '5', error: undefined });
});
```

- [ ] **Step 3: Запустить и убедиться, что падают**

Run: `npm test`
Expected: FAIL, `ENOENT ... web/image-boot.js`

Код модели создаётся через `win.Function`, а не через глобальный `Function`,
чтобы в тестах он исполнялся в реальности jsdom и видел её `document`.
В браузере `win.Function === Function`, разницы нет. Если jsdom не отдаёт
`window.Function` — проверьте, что окно создано с `runScripts:
'outside-only'`; без этой опции его действительно нет.

- [ ] **Step 4: Написать `web/image-boot.js`**

```js
// Исполняется внутри образа и в тестах. Импортов нет: текст этого файла
// инлайнится в srcdoc обычным script-тегом, поэтому здесь только объявления.

function createImage(doc, send, opts) {
  const win = doc.defaultView;
  const options = opts || {};
  const trusted = options.trusted || (e => e.isTrusted);
  const grace = options.grace != null ? options.grace : 250;
  const LIMIT = 10000;

  let execDepth = 0;
  const recs = [];
  const baseline = new Map();
  const dirty = new Set();

  const observer = new win.MutationObserver(rs => {
    for (const r of rs) recs.push({
      type: r.type,
      target: r.target,
      attributeName: r.attributeName,
      oldValue: r.oldValue,
      removed: Array.prototype.slice.call(r.removedNodes),
      added: Array.prototype.slice.call(r.addedNodes),
      byModel: execDepth > 0,
    });
  });

  function path(n) {
    if (n.nodeType === 3) n = n.parentNode;
    if (!n || n === doc.documentElement) return 'html';
    if (n.id) return '#' + n.id;
    const p = n.parentNode;
    if (!p || !p.children) return n.nodeName.toLowerCase();
    const i = Array.prototype.indexOf.call(p.children, n) + 1;
    return path(p) + ' > ' + n.tagName.toLowerCase() + ':nth-child(' + i + ')';
  }

  function serialize(n) {
    return n.nodeType === 3 ? JSON.stringify(n.data) : n.outerHTML;
  }

  function clear() {
    recs.length = 0;
    baseline.clear();
    dirty.clear();
  }

  // Синхронизация делается на клоне: живой DOM — это память агента,
  // и мутировать его ради сериализации нельзя.
  function snapshot() {
    const clone = doc.body.cloneNode(true);
    const src = doc.body.querySelectorAll('input,textarea,select,option');
    const dst = clone.querySelectorAll('input,textarea,select,option');
    for (let i = 0; i < src.length; i++) {
      const s = src[i], d = dst[i];
      if (s.type === 'checkbox' || s.type === 'radio') d.toggleAttribute('checked', s.checked);
      else if (s.tagName === 'OPTION') d.toggleAttribute('selected', s.selected);
      else if ('value' in s) d.setAttribute('value', s.value);
      if (s.tagName === 'TEXTAREA') d.textContent = s.value;
    }
    return clone.innerHTML;
  }

  function show(v) {
    if (v === undefined) return undefined;
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }

  function clip(s) {
    if (s === undefined) return undefined;
    return s.length > LIMIT ? s.slice(0, LIMIT) : s;
  }

  async function exec(code) {
    execDepth++;
    try {
      const fn = new win.Function('return (async () => {' + code + '})()');
      return { ok: true, value: clip(show(await fn())) };
    } catch (e) {
      return { ok: false, error: String((e && e.stack) || e) };
    } finally {
      win.setTimeout(() => { execDepth--; }, grace);
    }
  }

  function buildDiff() { return ''; }

  async function handle(m) {
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'exec') {
      const r = await exec(m.code);
      send({ type: 'result', id: m.id, ok: r.ok, value: r.value, error: r.error });
    } else if (m.type === 'diff') {
      send({ type: 'diff', id: m.id, text: buildDiff() });
    } else if (m.type === 'snap') {
      send({ type: 'snap', id: m.id, html: snapshot() });
    }
  }

  function install() {
    observer.observe(doc.documentElement, {
      subtree: true, childList: true, attributes: true, characterData: true,
      attributeOldValue: true, characterDataOldValue: true,
    });
    doc.addEventListener('focusin', e => {
      if (!trusted(e)) return;
      const el = e.target;
      if (el && 'value' in el && !baseline.has(el)) baseline.set(el, el.value);
    }, true);
    for (const t of ['input', 'change']) {
      doc.addEventListener(t, e => { if (trusted(e)) dirty.add(e.target); }, true);
    }
    win.addEventListener('message', e => {
      if (e.source !== win.parent) return;
      handle(e.data);
    });
    send({ type: 'ready' });
    return api;
  }

  const api = { install, handle, exec, snapshot, buildDiff, path, clear };
  return api;
}
```

`buildDiff` пока заглушка — она пишется в следующей задаче.

- [ ] **Step 5: Запустить тесты**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Коммит**

```bash
git add web/seed.html web/image-boot.js test/image-exec.test.js && git commit -m "feat(image): seed, exec с усечением значения, снапшот с клона"
```

---

### Task 6: Образ — захват правок человека и сборка дифа

Ядро вехи. Заменяет заглушку `buildDiff`.

**Files:**
- Modify: `web/image-boot.js`
- Create: `test/image-diff.test.js`

- [ ] **Step 1: Написать падающие тесты**

`test/image-diff.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const src = await readFile(new URL('../web/image-boot.js', import.meta.url), 'utf8');
const createImage = new Function(src + '\nreturn createImage;')();
const tick = () => new Promise(r => setTimeout(r, 0));

function makeImage(html) {
  const dom = new JSDOM(`<body>${html}</body>`, { runScripts: 'outside-only' });
  const sent = [];
  const img = createImage(dom.window.document, m => sent.push(m), { trusted: () => true, grace: 0 });
  img.install();
  return { dom, doc: dom.window.document, img, sent };
}

test('правка атрибута попадает в диф', async () => {
  const { doc, img } = makeImage('<div id="out" class="v1"></div>');
  doc.querySelector('#out').setAttribute('class', 'v2');
  await tick();
  assert.equal(img.buildDiff(), '#out  @class: "v1" -> "v2"');
});

test('две правки одного атрибута дают одну строку со старым от первой', async () => {
  const { doc, img } = makeImage('<div id="out" class="v1"></div>');
  const el = doc.querySelector('#out');
  el.setAttribute('class', 'v2');
  await tick();
  el.setAttribute('class', 'v3');
  await tick();
  assert.equal(img.buildDiff(), '#out  @class: "v1" -> "v3"');
});

test('правка, вернувшая прежнее значение, в диф не идёт', async () => {
  const { doc, img } = makeImage('<div id="out" class="v1"></div>');
  const el = doc.querySelector('#out');
  el.setAttribute('class', 'v2');
  await tick();
  el.setAttribute('class', 'v1');
  await tick();
  assert.equal(img.buildDiff(), '');
});

test('удаление узла попадает в диф вместе с его HTML и родителем', async () => {
  const { doc, img } = makeImage('<ul id="items"><li id="row-2">второй</li></ul>');
  doc.querySelector('#row-2').remove();
  await tick();
  assert.equal(img.buildDiff(), 'удалён из #items: <li id="row-2">второй</li>');
});

test('добавление узла попадает в диф', async () => {
  const { doc, img } = makeImage('<ul id="items"></ul>');
  const li = doc.createElement('li');
  li.id = 'row-3';
  li.textContent = 'третий';
  doc.querySelector('#items').append(li);
  await tick();
  assert.equal(img.buildDiff(), 'добавлен в #items: <li id="row-3">третий</li>');
});

test('узел, добавленный и сразу удалённый, в дифе не появляется', async () => {
  const { doc, img } = makeImage('<ul id="items"></ul>');
  const li = doc.createElement('li');
  doc.querySelector('#items').append(li);
  await tick();
  li.remove();
  await tick();
  assert.equal(img.buildDiff(), '');
});

test('правка текста попадает в диф с путём через nth-child', async () => {
  const { doc, img } = makeImage('<ul id="items"><li>первый</li></ul>');
  doc.querySelector('#items li').firstChild.data = 'первый пункт';
  await tick();
  assert.equal(img.buildDiff(), '#items > li:nth-child(1)  текст: "первый" -> "первый пункт"');
});

test('мутации кода модели в диф не попадают', async () => {
  const { img } = makeImage('<div id="out"></div>');
  await img.exec('document.querySelector("#out").setAttribute("class", "модель")');
  await tick();
  assert.equal(img.buildDiff(), '');
});

test('живой ввод в поле попадает в диф', async () => {
  const { doc, img, dom } = makeImage('<textarea id="q"></textarea>');
  const q = doc.querySelector('#q');
  q.dispatchEvent(new dom.window.Event('focusin', { bubbles: true }));
  q.value = 'посчитай маржу';
  q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await tick();
  assert.equal(img.buildDiff(), '#q  "" -> "посчитай маржу"');
});

test('после сборки буферы пусты и повторный диф пуст', async () => {
  const { doc, img } = makeImage('<div id="out" class="v1"></div>');
  doc.querySelector('#out').setAttribute('class', 'v2');
  await tick();
  img.buildDiff();
  assert.equal(img.buildDiff(), '');
});
```

- [ ] **Step 2: Запустить и убедиться, что падают**

Run: `npm test`
Expected: FAIL, тесты `image-diff` получают `''` из заглушки.

- [ ] **Step 3: Заменить заглушку в `web/image-boot.js`**

Удалить строку `function buildDiff() { return ''; }` и вставить на её место:

```js
  // Коалесцирование обязательно: getAttribute в момент доставки записи
  // возвращает текущее значение, а не значение на момент мутации.
  // Старое берётся из самой ранней записи, новое — из живого DOM.
  function buildDiff() {
    const attrs = new Map();
    const texts = new Map();
    const removed = [];
    const added = [];

    for (const r of recs) {
      if (r.byModel) continue;
      if (r.type === 'attributes') {
        if (!attrs.has(r.target)) attrs.set(r.target, new Map());
        const m = attrs.get(r.target);
        if (!m.has(r.attributeName)) m.set(r.attributeName, r.oldValue);
      } else if (r.type === 'characterData') {
        if (!texts.has(r.target)) texts.set(r.target, r.oldValue);
      } else {
        for (const n of r.removed) removed.push({ node: n, parent: r.target });
        for (const n of r.added) added.push({ node: n, parent: r.target });
      }
    }

    const addedNodes = new Set(added.map(a => a.node));
    const lines = [];

    for (const el of dirty) {
      const was = baseline.has(el) ? baseline.get(el) : '';
      if (el.value === was) continue;
      lines.push(path(el) + '  ' + JSON.stringify(was) + ' -> ' + JSON.stringify(el.value));
    }
    for (const [node, m] of attrs) {
      if (!node.isConnected) continue;
      for (const [attr, old] of m) {
        const now = node.getAttribute(attr);
        if (old === now) continue;
        lines.push(path(node) + '  @' + attr + ': ' + JSON.stringify(old) + ' -> ' + JSON.stringify(now));
      }
    }
    for (const [node, old] of texts) {
      if (!node.isConnected || node.data === old) continue;
      lines.push(path(node) + '  текст: ' + JSON.stringify(old) + ' -> ' + JSON.stringify(node.data));
    }
    for (const item of removed) {
      if (item.node.isConnected || addedNodes.has(item.node)) continue;
      lines.push('удалён из ' + path(item.parent) + ': ' + serialize(item.node));
    }
    for (const item of added) {
      if (!item.node.isConnected) continue;
      lines.push('добавлен в ' + path(item.parent) + ': ' + serialize(item.node));
    }

    clear();
    return lines.join('\n');
  }
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test`
Expected: PASS, все 10 тестов `image-diff` зелёные.

- [ ] **Step 5: Коммит**

```bash
git add web/image-boot.js test/image-diff.test.js && git commit -m "feat(image): диф правок человека с коалесцированием и атрибуцией"
```

---

### Task 7: Разбор ответа модели

**Files:**
- Create: `server/parse.js`, `test/parse.test.js`

- [ ] **Step 1: Написать падающие тесты**

`test/parse.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripThinking, extractCode, checkParsable } from '../server/parse.js';

test('вырезает блок рассуждений', () => {
  assert.equal(stripThinking('<think>подумаю</think>const a = 1').trim(), 'const a = 1');
  assert.equal(stripThinking('<thinking>ага</thinking>x()').trim(), 'x()');
});

test('снимает обёртку из обратных кавычек', () => {
  assert.equal(extractCode('```js\nconst a = 1\n```'), 'const a = 1');
  assert.equal(extractCode('```\nconst a = 1\n```'), 'const a = 1');
});

test('отрезает вводные префиксы', () => {
  assert.equal(extractCode('Вот код:\nconst a = 1'), 'const a = 1');
  assert.equal(extractCode('Here is the code:\nconst a = 1'), 'const a = 1');
});

test('снимает рассуждения и кавычки вместе', () => {
  assert.equal(extractCode('<think>э</think>\n```js\nconst a = 1\n```'), 'const a = 1');
});

test('пустой ответ даёт пустую строку', () => {
  assert.equal(extractCode('   \n  '), '');
  assert.equal(extractCode('<think>только мысли</think>'), '');
});

test('checkParsable принимает код с верхнеуровневым await', () => {
  assert.deepEqual(checkParsable('await Promise.resolve(1)'), { ok: true });
});

test('checkParsable ловит синтаксическую ошибку', () => {
  const r = checkParsable('const = ;');
  assert.equal(r.ok, false);
  assert.ok(r.error.length > 0);
});

test('пустой код считается разбираемым', () => {
  assert.deepEqual(checkParsable(''), { ok: true });
});
```

- [ ] **Step 2: Запустить и убедиться, что падают**

Run: `npm test`
Expected: FAIL, `Cannot find module '../server/parse.js'`

- [ ] **Step 3: Написать `server/parse.js`**

```js
export function stripThinking(text) {
  return String(text ?? '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
}

export function extractCode(text) {
  let s = stripThinking(text).trim();
  const fenced = /^```(?:js|javascript)?[^\S\n]*\n([\s\S]*?)\n?```$/i.exec(s);
  if (fenced) s = fenced[1];
  s = s.replace(/^\s*(?:вот код|вот|here(?:'s| is) the code|here(?:'s| is))\s*[:：]?[^\S\n]*\n?/i, '');
  return s.trim();
}

// Проверка обязана совпадать с тем, как код оборачивается в образе,
// иначе верхнеуровневый await ложно объявляется синтаксической ошибкой.
export function checkParsable(code) {
  if (!code) return { ok: true };
  try {
    new Function('return (async () => {' + code + '})()');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message) };
  }
}
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add server/parse.js test/parse.test.js && git commit -m "feat(server): разбор ответа модели со срезанием рассуждений"
```

---

### Task 8: Контекст и системный промпт

**Files:**
- Create: `server/context.js`, `test/context.test.js`

- [ ] **Step 1: Написать падающие тесты**

`test/context.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistory, SYSTEM_PROMPT, estimateTokens } from '../server/context.js';

const MODEL = { id: 'g:1', api: 'openai-completions', provider: 'ollama' };

test('системный промпт требует только код и объясняет чтение состояния', () => {
  assert.ok(SYSTEM_PROMPT.includes('ТОЛЬКО кодом JavaScript'));
  assert.ok(SYSTEM_PROMPT.includes('return'));
  assert.ok(SYSTEM_PROMPT.includes('#notes'));
});

test('порядок сообщений: результат, диф, код', () => {
  const h = createHistory();
  h.pushResult('42');
  h.pushDiff('#q  "" -> "привет"');
  h.pushCode('document.title = "x"', MODEL);
  assert.deepEqual(h.messages.map(m => m.role), ['user', 'user', 'assistant']);
  assert.equal(h.messages[0].content, 'результат: 42');
  assert.equal(h.messages[1].content, '#q  "" -> "привет"');
  assert.deepEqual(h.messages[2].content, [{ type: 'text', text: 'document.title = "x"' }]);
});

test('undefined-результат сообщения не добавляет', () => {
  const h = createHistory();
  h.pushResult(undefined);
  h.pushResult(null);
  assert.equal(h.messages.length, 0);
});

test('сообщение модели содержит поля, обязательные для pi-ai', () => {
  const h = createHistory();
  h.pushCode('x()', MODEL);
  const m = h.messages[0];
  for (const k of ['role', 'content', 'api', 'provider', 'model', 'usage', 'stopReason', 'timestamp']) {
    assert.ok(k in m, `нет поля ${k}`);
  }
  assert.equal(typeof m.usage.totalTokens, 'number');
});

test('reset очищает историю', () => {
  const h = createHistory();
  h.pushDiff('a');
  h.reset();
  assert.equal(h.messages.length, 0);
});

test('оценка токенов — четыре символа на токен', () => {
  assert.equal(estimateTokens('12345678'), 2);
});
```

- [ ] **Step 2: Запустить и убедиться, что падают**

Run: `npm test`
Expected: FAIL, `Cannot find module '../server/context.js'`

- [ ] **Step 3: Написать `server/context.js`**

```js
export const SYSTEM_PROMPT = `Ты управляешь HTML-страницей. Отвечай ТОЛЬКО кодом JavaScript.
Без markdown, без объяснений, без обратных кавычек.

Код исполняется в контексте страницы, тебе доступен document.
Отвечай пользователю не текстом, а изменением DOM: пиши в #out, меняй
элементы, создавай новые. Форму ответа выбираешь сама.

Страница создана из такой заготовки:
  <textarea id="q">   свободный ввод пользователя
  <ul id="items">     список
  <div id="out">      область вывода
  <div id="notes">    твои заметки, скрыт от пользователя
Ты и пользователь с тех пор могли изменить что угодно, включая эти узлы.

Снимка страницы тебе никто не присылает. Если нужно знать состояние —
верни нужное из кода, результат придёт следующим ходом:
  return [...document.querySelectorAll('[id]')].map(n => n.id).join()
  return document.querySelector('#items').innerHTML

Не трать ход на чтение, если можешь прочитать и изменить в одном коде:
  const box = document.querySelector('#items') ?? make('#items')
  if (box.children.length) { ... } else { ... }

Состояние храни в DOM — в узлах и data-* атрибутах. Заметки себе пиши
в #notes. Между ходами ничего кроме DOM не сохраняется.

Пользователь правит страницу руками — в полях ввода и через инструменты
разработчика браузера. Его правки приходят тебе дифом.

Ничего делать не обязательно: пустой ответ — законный ход.`;

const EMPTY_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 4);
}

export function createHistory() {
  const messages = [];
  return {
    messages,
    pushDiff(diff) {
      messages.push({ role: 'user', content: String(diff ?? ''), timestamp: Date.now() });
    },
    pushResult(value) {
      if (value === undefined || value === null) return;
      messages.push({ role: 'user', content: 'результат: ' + value, timestamp: Date.now() });
    },
    // В историю кладётся только код: рассуждения модели не переиспользуются
    // и ломали бы неизменность префикса, на которой держится KV-кэш.
    pushCode(code, model) {
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: code }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { ...EMPTY_USAGE, cost: { ...EMPTY_USAGE.cost } },
        stopReason: 'stop',
        timestamp: Date.now(),
      });
    },
    reset() { messages.length = 0; },
    size() {
      return estimateTokens(SYSTEM_PROMPT) + messages.reduce((n, m) => n + estimateTokens(
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content)), 0);
    },
  };
}
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add server/context.js test/context.test.js && git commit -m "feat(server): системный промпт и история сообщений"
```

---

### Task 9: `/api/commit` со стримом

**Files:**
- Modify: `server/index.js`
- Modify: `test/server.test.js`

- [ ] **Step 1: Написать падающие тесты**

Дописать в `test/server.test.js`:

```js
function fakeStream(events) {
  return () => ({
    async *[Symbol.asyncIterator]() { for (const e of events) yield e; },
  });
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
  env: { TEST_DS_KEY: 'k' },
  fetchImpl: async () => { throw new Error('оффлайн'); },
};

const MODEL_REF = { provider: 'deepseek', id: 'deepseek-v4-flash' };

test('commit стримит дельты и отдаёт очищенный код, рассуждения не уходят', async () => {
  await withServer({ ...COMMIT_OPTS, streamFn: fakeStream([
    { type: 'thinking_delta', delta: 'сейчас подумаю' },
    { type: 'text_delta', delta: '```js\ndocument' },
    { type: 'text_delta', delta: '.title = "x"\n```' },
    { type: 'done', reason: 'stop', message: {} },
  ]) }, async base => {
    const res = await fetch(base + '/api/commit', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL_REF, diff: '#q  "" -> "привет"' }),
    });
    const events = await readSse(res);
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
    await fetch(base + '/api/commit', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL_REF, diff: 'диф', result: '42' }),
    }).then(r => r.text());
    assert.deepEqual(app.state.history.messages.map(m => m.content),
      ['результат: 42', 'диф', [{ type: 'text', text: 'x()' }]]);
  });
});

test('пустой ответ модели — законный ход: done с пустым кодом', async () => {
  await withServer({ ...COMMIT_OPTS, streamFn: fakeStream([
    { type: 'text_delta', delta: '<think>делать нечего</think>' },
    { type: 'done', reason: 'stop', message: {} },
  ]) }, async base => {
    const events = await readSse(await fetch(base + '/api/commit', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL_REF, diff: 'д' }),
    }));
    assert.equal(events.at(-1).event, 'done');
    assert.equal(events.at(-1).data.code, '');
  });
});

test('неизвестная модель даёт 400', async () => {
  await withServer(COMMIT_OPTS, async base => {
    const res = await fetch(base + '/api/commit', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: { provider: 'нет', id: 'нет' }, diff: '' }),
    });
    assert.equal(res.status, 400);
  });
});

test('ошибка провайдера уходит событием error и не роняет сервер', async () => {
  await withServer({ ...COMMIT_OPTS, streamFn: fakeStream([
    { type: 'error', reason: 'error', error: { errorMessage: 'провайдер лёг' } },
  ]) }, async base => {
    const events = await readSse(await fetch(base + '/api/commit', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL_REF, diff: 'д' }),
    }));
    assert.equal(events.at(-1).event, 'error');
    assert.ok(events.at(-1).data.message.includes('провайдер лёг'));
  });
});
```

- [ ] **Step 2: Запустить и убедиться, что падают**

Run: `npm test`
Expected: FAIL, `/api/commit` отвечает 404.

- [ ] **Step 3: Дописать `server/index.js`**

Расширить импорты:

```js
import { stream as openaiStream } from '@earendil-works/pi-ai/api/openai-completions';
import { stream as anthropicStream } from '@earendil-works/pi-ai/api/anthropic-messages';
import { loadConfig, publicModels, scrub } from './pi-config.js';
import { extractCode, checkParsable } from './parse.js';
import { createHistory, SYSTEM_PROMPT } from './context.js';
```

Добавить помощник рядом с `json`:

```js
function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
```

Заменить строку объявления состояния в `createApp` на:

```js
  const state = { config: null, opts, history: createHistory(), abort: null };
```

Добавить внутрь `createApp` перед `const server = createServer(...)`:

```js
  function pickStream(model) {
    if (opts.streamFn) return opts.streamFn(model);
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
        // §7: ровно один автоповтор с текстом ошибки
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
```

Добавить маршруты перед строкой `if (url.pathname.startsWith('/api/'))`:

```js
      if (url.pathname === '/api/commit' && req.method === 'POST') return await handleCommit(req, res);
      if (url.pathname === '/api/abort' && req.method === 'POST') {
        state.abort?.abort();
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/session') return json(res, 200, { tokens: state.history.size() });
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add server/index.js test/server.test.js && git commit -m "feat(server): /api/commit со стримом, автоповтором и abort"
```

---

### Task 10: Оболочка

**Files:**
- Create: `web/index.html`, `web/shell.js`, `web/style.css`

- [ ] **Step 1: Создать `web/index.html`**

```html
<!doctype html>
<html lang="ru">
<meta charset="utf-8">
<title>DOM-агент</title>
<link rel="stylesheet" href="style.css">
<main>
  <iframe id="image" sandbox="allow-scripts" title="образ"></iframe>
  <div id="bar">
    <select id="model" aria-label="модель"></select>
    <span id="dot" aria-live="polite">—</span>
    <button id="send">отправить</button>
  </div>
  <pre id="log" aria-live="polite"></pre>
</main>
<script type="module" src="shell.js"></script>
</html>
```

- [ ] **Step 2: Создать `web/style.css`**

```css
:root { color-scheme: light dark; }
body { margin: 0; font: 14px/1.5 system-ui, sans-serif; }
main { display: flex; flex-direction: column; height: 100vh; }
#image { flex: 1; width: 100%; border: 0; border-bottom: 1px solid #8888; background: Canvas; }
#bar { display: flex; gap: .5rem; align-items: center; padding: .5rem; }
#bar button, #bar select { font: inherit; padding: .3rem .6rem; }
:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
#log { margin: 0; padding: .5rem; max-height: 8rem; overflow: auto;
       font: 12px/1.4 ui-monospace, monospace; white-space: pre-wrap; }
@media (max-width: 900px) { #bar { flex-wrap: wrap; } }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
```

- [ ] **Step 3: Создать `web/shell.js`**

```js
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

// Единственная валидная проверка отправителя: event.origin у sandbox всегда "null".
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
  if (r.error) say(r.error);
  else if (r.notes?.length) say(r.notes.join('\n'));
}

async function readStream(res, onDelta) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', code = '', error = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frameText = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = {};
      for (const line of frameText.split('\n')) {
        const j = line.indexOf(':');
        ev[line.slice(0, j)] = line.slice(j + 1).trimStart();
      }
      const data = JSON.parse(ev.data);
      if (ev.event === 'delta') onDelta(data.text);
      else if (ev.event === 'done') code = data.code;
      else if (ev.event === 'error') error = data.message;
    }
  }
  if (error) throw new Error(error);
  return code;
}

async function commit() {
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
    const code = await readStream(res, d => { shown += d; say(shown); });
    lastResult = undefined;
    if (!code) { say('пустой ответ — ход засчитан, образ не тронут'); setState('свободна'); return; }
    const r = await ask({ type: 'exec', code });
    if (r.ok) { lastResult = r.value; say(code); setState('свободна'); }
    else { say('ошибка исполнения:\n' + r.error); setState('ошибка'); }
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
```

- [ ] **Step 4: Проверить руками**

```bash
npm start
```

Открыть `http://127.0.0.1:8730`. Expected: селектор заполнен моделями из
настоящего `models.json`, включая провайдер `ollama`; индикатор «свободна».

- [ ] **Step 5: Коммит**

```bash
git add web/index.html web/shell.js web/style.css && git commit -m "feat(web): оболочка с селектором моделей и ходом"
```

---

### Task 11: Сквозная проверка на живой модели

**Files:** нет; это проверка, а не код.

- [ ] **Step 1: Убедиться, что ollama отвечает**

```bash
curl -s http://localhost:11434/v1/models | head -c 200
```

Expected: JSON со списком, в нём `gemma4:12b-mlx-64k`.

- [ ] **Step 2: Первый ход**

Запустить `npm start`, открыть `http://127.0.0.1:8730`, выбрать
`ollama / gemma4:12b-mlx-64k`, набрать в поле образа
`сделай список из трёх пунктов`, нажать «отправить».

Expected: в `#items` появляется три `<li>`. Если модель ответила текстом —
это ожидаемая слабость §13; зафиксировать факт и идти дальше.

- [ ] **Step 3: Проверить, что правки модели не возвращаются дифом**

Нажать «отправить» ещё раз, ничего не правя.

Expected: диф пуст, образ не ломается. Это приёмка §12 пункт 10.

- [ ] **Step 4: Проверить чтение состояния**

Набрать в `#q` `сколько пунктов в списке` и отправить.

Expected: если модель вернула значение через `return`, следующий ход
получает его сообщением `результат:` — видно в `app.state.history`.

- [ ] **Step 5: Проверить приёмки §12 пунктов 19 и 20 на живом образе**

В DevTools выбрать контекст фрейма образа и выполнить `localStorage.getItem('x')`,
затем `fetch('https://example.com')`.

Expected: `SecurityError` и `TypeError`.

- [ ] **Step 6: Проверить, что незапрошенное сообщение отбрасывается**

В DevTools в контексте фрейма образа выполнить:

```js
parent.postMessage({ type: 'diff', id: 999, text: 'подделка' }, '*')
```

Expected: в логе оболочки «незапрошенное сообщение от образа отброшено»,
подделка в контекст не попадает. Это приёмка §12 пункт 12.

- [ ] **Step 7: Записать наблюдения в README**

Создать `README.md`: как запустить; решение по `pi-ai` (адаптеры берутся из
пакета, свой загрузчик остаётся только для файла конфига); наблюдения
первого прогона — отвечала ли модель чистым кодом и сколько ходов ушло на
чтение.

- [ ] **Step 8: Коммит**

```bash
git add README.md && git commit -m "docs: README с решением по pi-ai и наблюдениями первого прогона"
```

---

### Task 12: Обновить спецификацию под принятые поправки

**Files:**
- Modify: `docs/superpowers/specs/2026-08-19-dom-agent-design.md`

- [ ] **Step 1: Внести поправку в §5**

Дописать, что отдельного метода для результата нет: результат исполнения
едет полем `result` в теле следующего `POST /api/commit`, и сайдкар кладёт
его в историю перед дифом. Обновить пример тела запроса:

```json
{
  "model": { "provider": "ollama", "id": "gemma4:12b-mlx-64k" },
  "diff": "#q  \"\" -> \"посчитай маржу\"",
  "result": "3"
}
```

- [ ] **Step 2: Отметить в §11 закрытые шаги**

Пометить шаги 1–4 выполненными и сослаться на
`docs/superpowers/plans/2026-08-19-dom-agent-milestone-1.md`.

- [ ] **Step 3: Коммит**

```bash
git add docs/superpowers/specs/2026-08-19-dom-agent-design.md && git commit -m "docs: поправка §5 — результат едет в теле следующего commit"
```

---

## Что остаётся вехе 2

Не покрыто этим планом и должно попасть в следующий: карта образа (§3) и её
выдача после сброса; триггеры сброса (60% контекста, две ошибки подряд,
кнопка); счётчик токенов в UI (§9); очередь отложенного хода и пауза (§2);
watchdog с пересозданием образа из последнего снапшота (§6); журнал
`log.jsonl` и снапшоты на диск (§8); приёмки §12 пунктов 12, 13, 18, 21, 22.
