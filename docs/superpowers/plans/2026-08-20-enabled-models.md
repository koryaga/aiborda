# Модели из настроек pi: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** селектор моделей показывает ровно те модели, которые пользователь отобрал в `~/.pi/agent/settings.json`, включая встроенных в pi провайдеров вроде openrouter.

**Architecture:** `enabledModels` из настроек pi становится авторитетным списком. Ссылка `провайдер/id` разрешается сначала среди пользовательских провайдеров из `models.json`, затем среди встроенных в пакет `pi-ai`. Встроенные модели уходят к провайдеру через его собственный `.stream()`, поэтому чужие API не требуют адаптеров.

**Tech Stack:** Node ≥ 20, чистый ESM, `node:test`, `@earendil-works/pi-ai@0.84.2`. Новых зависимостей нет.

---

## Спецификация

`docs/superpowers/specs/2026-08-20-enabled-models-design.md`. Расхождения
разрешаются в её пользу.

## Проверенные факты — не перепроверяйте, альтернатив не изобретайте

Взяты из установленного `pi-ai@0.84.2` и реального конфига пользователя.

- `import { getBuiltinModels, builtinProviders } from '@earendil-works/pi-ai/providers/all'`
  работает; в `package.json` пакета есть `"./providers/*"`.
- `getBuiltinModels(id)` даёт готовые объекты `Model` со всеми обязательными
  полями (`id, name, api, provider, baseUrl, reasoning, input, cost,
  contextWindow, maxTokens`). Собирать их через `toModel` **не нужно**.
  Для неизвестного провайдера функция бросает — оборачивайте.
- `builtinProviders()` даёт объекты `Provider` с `id, name, baseUrl, headers,
  auth, getModels, refreshModels, filterModels, stream, streamSimple`.
  Вызов строит все 39 провайдеров, поэтому результат кэшируется один раз на
  модуль.
- `provider.stream(model, context, options)` — та же сигнатура, что у
  адаптеров. В `models.js` ключ разрешается как
  `apiKey = options?.apiKey ?? auth.apiKey`, то есть явно переданный ключ
  побеждает. `CredentialStore` реализовывать не нужно.
- `ProviderRequestOptions` принимает `fetch` — это позволяет проверить
  исходящий запрос без сети.
- Формы учётных записей в `auth.json`: `{type:'api_key', key}` и
  `{type:'oauth', access, refresh, expires, accountId}`, где `expires` —
  число миллисекунд эпохи.
- В `settings.json` пользователя: `enabledModels` (8 ссылок),
  `defaultProvider: "deepseek"`, `defaultModel: "deepseek-v4-pro"`.
- Идентификаторы моделей содержат слэши: `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`
  — это провайдер `openrouter` и id `nvidia/nemotron-3-ultra-550b-a55b:free`.
  Резать по **первому** слэшу.

## Правило для всех задач

**Ни один автотест не ходит в сеть.** Для этого и передаются `fetchImpl` в
`loadConfig`, `fetch` в опциях потока и `streamFn` в `createApp`. Ручные
проверки на настоящем конфиге вынесены в отдельные шаги и помечены явно; из
них в сеть уходит только живой ход в Task 7.

**В `~/.pi/` не пишется ничего и никогда.** Ни одна задача не добавляет
`writeFile` по путям домашнего каталога; это проверяется в Task 4.

## Текущее состояние кода

Ветка `enabled-models` от `main`, 135 тестов зелёных, `npm test`.

- `server/pi-config.js` (178 строк) экспортирует `DEFAULT_MODELS_PATH`,
  `DEFAULT_AUTH_PATH`, `expandVars`, `toModel`, `flattenModels`,
  `discoverModels`, `loadConfig`, `publicModels`, `publicView`, `scrub`.
  `loadConfig({path, authPath, env, fetchImpl})` возвращает
  `{providers, models, notes, secrets, error}`.
- Запись провайдера: `{name, baseUrl, api, apiKey, compat, overrides,
  supported, dynamic}`.
- `server/index.js`: `pickStream(model)` возвращает функцию потока,
  `collect(model, provider, signal, res)` её вызывает.
- `web/shell.js`: `loadModels()` заполняет селектор значениями
  `провайдер + ' ' + id`.

## Структура файлов

| Файл | Ответственность |
|---|---|
| `server/pi-settings.js` | **новый** — чтение `settings.json`: отобранный список и умолчание |
| `server/pi-config.js` | правится — встроенные провайдеры, oauth-ключ, разрешение ссылок |
| `server/index.js` | правится — выбор пути отправки |
| `web/shell.js` | правится — предвыбор умолчания |
| `test/pi-settings.test.js` | **новый** |
| `test/pi-config.test.js`, `test/server.test.js` | дополняются |

---

### Task 1: Чтение `settings.json`

**Files:**
- Create: `server/pi-settings.js`, `test/pi-settings.test.js`

- [ ] **Step 1: Написать падающие тесты**

`test/pi-settings.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitRef, loadSettings } from '../server/pi-settings.js';

async function withSettings(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dom-agent-'));
  const path = join(dir, 'settings.json');
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
  try { await fn(path); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('splitRef режет по первому слэшу', () => {
  assert.deepEqual(splitRef('deepseek/deepseek-v4-pro'), { provider: 'deepseek', id: 'deepseek-v4-pro' });
});

test('splitRef сохраняет слэши внутри id', () => {
  assert.deepEqual(splitRef('openrouter/nvidia/nemotron-3-ultra-550b-a55b:free'),
    { provider: 'openrouter', id: 'nvidia/nemotron-3-ultra-550b-a55b:free' });
  assert.deepEqual(splitRef('openrouter/openrouter/free'),
    { provider: 'openrouter', id: 'openrouter/free' });
});

test('splitRef отвергает мусор', () => {
  for (const bad of ['', 'безслэша', '/начинается', 'кончается/', null, undefined, 42]) {
    assert.equal(splitRef(bad), null, `должно быть null для ${JSON.stringify(bad)}`);
  }
});

test('loadSettings читает отобранный список и умолчание', async () => {
  await withSettings({
    enabledModels: ['openrouter/openrouter/free', 'deepseek/deepseek-v4-pro'],
    defaultProvider: 'deepseek',
    defaultModel: 'deepseek-v4-pro',
  }, async path => {
    const s = await loadSettings({ path });
    assert.equal(s.enabled.length, 2);
    assert.deepEqual(s.enabled[0], { provider: 'openrouter', id: 'openrouter/free' });
    assert.deepEqual(s.default, { provider: 'deepseek', id: 'deepseek-v4-pro' });
    assert.deepEqual(s.notes, []);
  });
});

test('негодные ссылки отбрасываются с заметкой, годные остаются', async () => {
  await withSettings({ enabledModels: ['безслэша', 'deepseek/deepseek-v4-pro'] }, async path => {
    const s = await loadSettings({ path });
    assert.equal(s.enabled.length, 1);
    assert.ok(s.notes.some(n => n.includes('безслэша')));
  });
});

test('отсутствующий файл — не ошибка и не заметка', async () => {
  const s = await loadSettings({ path: '/нет/такого/settings.json' });
  assert.deepEqual(s.enabled, []);
  assert.equal(s.default, null);
  assert.deepEqual(s.notes, []);
});

test('битый файл даёт заметку и пустой список', async () => {
  await withSettings('{ висячая запятая, }', async path => {
    const s = await loadSettings({ path });
    assert.deepEqual(s.enabled, []);
    assert.ok(s.notes.some(n => n.includes('settings.json')));
  });
});

test('enabledModels не массив — пустой список без падения', async () => {
  await withSettings({ enabledModels: 'ой' }, async path => {
    assert.deepEqual((await loadSettings({ path })).enabled, []);
  });
});

test('умолчание без одной из половин игнорируется', async () => {
  await withSettings({ defaultProvider: 'deepseek' }, async path => {
    assert.equal((await loadSettings({ path })).default, null);
  });
});

test('файл с литералом null не роняет загрузку', async () => {
  await withSettings('null', async path => {
    assert.deepEqual((await loadSettings({ path })).enabled, []);
  });
});
```

- [ ] **Step 2: Запустить и убедиться, что падают**

Run: `npm test`
Expected: FAIL, `Cannot find module '../server/pi-settings.js'`

- [ ] **Step 3: Написать `server/pi-settings.js`**

```js
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_SETTINGS_PATH = join(homedir(), '.pi', 'agent', 'settings.json');

// Идентификаторы моделей сами содержат слэши: openrouter/nvidia/nemotron-...
// Поэтому режем по первому, а не последнему и не по всем.
export function splitRef(ref) {
  if (typeof ref !== 'string') return null;
  const i = ref.indexOf('/');
  if (i <= 0 || i === ref.length - 1) return null;
  return { provider: ref.slice(0, i), id: ref.slice(i + 1) };
}

export async function loadSettings({ path = DEFAULT_SETTINGS_PATH } = {}) {
  let raw;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    // Отсутствие файла — штатный случай: отобранного списка просто нет.
    // Битый файл — другое дело, о нём надо сказать.
    const notes = e.code === 'ENOENT' ? [] : [`settings.json не разобран — ${e.message}`];
    return { enabled: [], default: null, notes };
  }

  const obj = raw ?? {};
  const list = Array.isArray(obj.enabledModels) ? obj.enabledModels : [];
  const enabled = [], notes = [];
  for (const ref of list) {
    const parsed = splitRef(ref);
    if (parsed) enabled.push(parsed);
    else notes.push(`enabledModels: запись ${JSON.stringify(ref)} не похожа на провайдер/модель`);
  }

  const def = typeof obj.defaultProvider === 'string' && typeof obj.defaultModel === 'string'
    ? { provider: obj.defaultProvider, id: obj.defaultModel }
    : null;

  return { enabled, default: def, notes };
}
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test`
Expected: PASS, 135 старых + 9 новых.

- [ ] **Step 5: Проверить на настоящих настройках**

```bash
node -e "import('./server/pi-settings.js').then(async m => { const s = await m.loadSettings(); console.log('включено:', s.enabled.length); console.log(s.enabled.map(r => r.provider + ' :: ' + r.id).join('\n')); console.log('умолчание:', JSON.stringify(s.default)); console.log('заметки:', s.notes); })"
```

Expected: 8 записей, среди них `openrouter :: nvidia/nemotron-3-ultra-550b-a55b:free`
и `openrouter :: openrouter/free`; умолчание `{"provider":"deepseek","id":"deepseek-v4-pro"}`;
заметок нет.

- [ ] **Step 6: Коммит**

```bash
git add server/pi-settings.js test/pi-settings.test.js && git commit -m "feat(config): чтение enabledModels и умолчания из settings.json"
```

---

### Task 2: Встроенные провайдеры pi

**Files:**
- Modify: `server/pi-config.js`
- Modify: `test/pi-config.test.js`

- [ ] **Step 1: Написать падающие тесты**

Дописать в `test/pi-config.test.js`:

```js
import { findBuiltinModel, builtinProviderRecord } from '../server/pi-config.js';

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
  const events = p.streamFn(model, { systemPrompt: 'с', messages: [] },
    { apiKey: 'КЛЮЧ-ДЛЯ-ПРОВЕРКИ', fetch: fakeFetch, maxTokens: 16 });
  try { for await (const _ of events) { /* до первой ошибки */ } } catch { /* 401 ожидаем */ }
  assert.ok(seen, 'запрос должен был уйти в подставной fetch');
  const auth = JSON.stringify(seen.headers ?? {});
  assert.ok(auth.includes('КЛЮЧ-ДЛЯ-ПРОВЕРКИ'), 'ключ должен попасть в заголовки: ' + auth);
});
```

Последний тест — проверка того, что явно переданный `apiKey` действительно
доезжает до запроса. Он же служит образцом для проверки oauth в Task 4.
Сети нет: `fetch` подставной.

- [ ] **Step 2: Запустить и убедиться, что падают**

Run: `npm test`
Expected: FAIL, `findBuiltinModel is not a function`

- [ ] **Step 3: Дописать `server/pi-config.js`**

Добавить импорт сверху:

```js
import { getBuiltinModels, builtinProviders } from '@earendil-works/pi-ai/providers/all';
```

Добавить рядом с `discoverModels`:

```js
// builtinProviders() строит все 39 провайдеров, поэтому зовём один раз.
let builtinCache = null;
function builtinById(id) {
  if (!builtinCache) {
    builtinCache = new Map();
    for (const p of builtinProviders()) builtinCache.set(p.id, p);
  }
  return builtinCache.get(id) ?? null;
}

export function findBuiltinModel(provider, id) {
  try {
    return getBuiltinModels(provider).find(m => m.id === id) ?? null;
  } catch {
    return null; // провайдер не встроенный
  }
}

export function builtinProviderRecord(id) {
  const p = builtinById(id);
  if (!p) return null;
  return {
    name: p.id,
    baseUrl: p.baseUrl,
    api: null,          // api задаётся моделью, а не провайдером
    apiKey: '',
    compat: {},
    overrides: {},
    supported: true,
    dynamic: false,
    builtin: true,
    // Метод, а не ссылка: отвязанный от объекта stream потеряет this.
    streamFn: (model, context, options) => p.stream(model, context, options),
  };
}
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test`
Expected: PASS. Если последний тест покажет, что ключ до заголовков не
доходит — **остановитесь и сообщите**: на этом стоит вся задача.

- [ ] **Step 5: Коммит**

```bash
git add server/pi-config.js test/pi-config.test.js && git commit -m "feat(config): встроенные провайдеры pi и их собственный поток"
```

---

### Task 3: `enabledModels` как источник списка

**Files:**
- Modify: `server/pi-config.js`
- Modify: `test/pi-config.test.js`

- [ ] **Step 1: Написать падающие тесты**

Дописать в `test/pi-config.test.js`. Хелпер `withSettings` скопируйте из
`test/pi-settings.test.js` — дублирование девяти строк дешевле, чем общий
модуль тестовых утилит ради двух файлов.

```js
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function withSettingsFile(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dom-agent-'));
  const path = join(dir, 'settings.json');
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
  try { await fn(path); } finally { await rm(dir, { recursive: true, force: true }); }
}

const NO_NET = async () => { throw new Error('оффлайн'); };

test('enabledModels становится списком моделей', async () => {
  await withSettingsFile({
    enabledModels: ['deepseek/deepseek-v4-flash', 'openrouter/openrouter/free'],
  }, async settingsPath => {
    const c = await loadConfig({
      path: FIXTURE_MODELS_PATH, authPath: '/нет/auth.json', settingsPath,
      env: { TEST_DS_KEY: 'секрет', OPENROUTER_API_KEY: 'ключ-роутера' }, fetchImpl: NO_NET,
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
    enabledModels: ['такого-нет/модель', 'deepseek/deepseek-v4-flash'],
  }, async settingsPath => {
    const c = await loadConfig({
      path: FIXTURE_MODELS_PATH, authPath: '/нет/auth.json', settingsPath,
      env: { TEST_DS_KEY: 'секрет' }, fetchImpl: NO_NET,
    });
    assert.equal(c.error, null);
    assert.equal(c.models.length, 1);
    assert.ok(c.notes.some(n => n.includes('такого-нет')));
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
      env: { OPENROUTER_API_KEY: 'ключ-роутера' }, fetchImpl: NO_NET,
    });
    assert.ok([...c.secrets].some(s => s.includes('openrouter.ai')));
    assert.ok(c.secrets.has('ключ-роутера'));
  });
});
```

- [ ] **Step 2: Запустить и убедиться, что падают**

Run: `npm test`
Expected: FAIL — `loadConfig` не знает про `settingsPath`, списки не сходятся.

- [ ] **Step 3: Правка `server/pi-config.js`**

Добавить импорт:

```js
import { loadSettings, DEFAULT_SETTINGS_PATH } from './pi-settings.js';
```

Заменить сигнатуру `loadConfig` на:

```js
export async function loadConfig({
  path = DEFAULT_MODELS_PATH,
  authPath = DEFAULT_AUTH_PATH,
  settingsPath = DEFAULT_SETTINGS_PATH,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
```

В ветке «конфиг не читается» добавить поле `default`, чтобы форма результата
не расходилась между ветками:

```js
    return { providers: [], models: [], notes: [], secrets: new Set(),
      default: null,
      error: `не найден ${path} — создайте его или укажите --pi-config` };
```

После `const { providers, models, notes } = flattenModels(raw, { env });`
вставить чтение настроек и добавление встроенных провайдеров — **до** цепочки
ключей, чтобы ключ разрешался и для них:

```js
  const settings = await loadSettings({ path: settingsPath });
  notes.push(...settings.notes);

  // Встроенные провайдеры подключаются только когда есть отобранный список.
  // Без него они дали бы четыреста пунктов в селекторе.
  if (settings.enabled.length) {
    const known = new Set(providers.map(p => p.name));
    for (const ref of settings.enabled) {
      if (known.has(ref.provider)) continue;
      const rec = builtinProviderRecord(ref.provider);
      if (!rec) continue;      // заметка появится при разрешении ссылки ниже
      providers.push(rec);
      known.add(ref.provider);
    }
  }
```

После цикла discovery и **до** сбора секретов вставить разрешение ссылок:

```js
  let finalModels = models;
  if (settings.enabled.length) {
    const byRef = new Map(models.map(m => [m.provider + '/' + m.id, m]));
    const byName = new Map(providers.map(p => [p.name, p]));
    const resolved = [];
    for (const ref of settings.enabled) {
      const key = ref.provider + '/' + ref.id;
      const custom = byRef.get(key);
      if (custom) { resolved.push(custom); continue; }

      const provider = byName.get(ref.provider);
      if (!provider) {
        notes.push(`${key}: провайдер не найден ни в models.json, ни среди встроенных`);
        continue;
      }
      if (!provider.apiKey) {
        notes.push(`${key}: пропущена, ключ провайдера ${ref.provider} не найден`);
        continue;
      }
      const builtin = findBuiltinModel(ref.provider, ref.id);
      if (!builtin) {
        notes.push(`${key}: модель не найдена у провайдера`);
        continue;
      }
      resolved.push(builtin);
    }
    finalModels = resolved;
  }
```

Собрать секреты **по всем** провайдерам, включая добавленные встроенные — этот
цикл уже есть, менять его не нужно, он итерируется по `providers`.

Заменить возврат на:

```js
  return { providers, models: finalModels, notes, secrets, default: settings.default, error: null };
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Проверить на настоящем конфиге**

```bash
node -e "import('./server/pi-config.js').then(async m => { const c = await m.loadConfig(); console.log('моделей:', c.models.length); for (const x of c.models) console.log('  ' + x.provider + ' / ' + x.id); console.log('умолчание:', JSON.stringify(c.default)); console.log('заметки:', c.notes); })"
```

Expected: шесть моделей на ключе (две openrouter free, две deepseek, одна
ollama, одна openrouter liquid); две записи `openai-codex` пока в заметках —
их включает Task 4. Умолчание `deepseek/deepseek-v4-pro`.

- [ ] **Step 6: Коммит**

```bash
git add server/pi-config.js test/pi-config.test.js && git commit -m "feat(config): enabledModels как источник списка моделей"
```

---

### Task 4: oauth-учётка только на чтение

**Files:**
- Modify: `server/pi-config.js`
- Modify: `test/pi-config.test.js`

Провайдер `openai-codex` держит oauth-учётку. Токен берём как есть, не
обновляем и **не пишем в `~/.pi/` ни при каких условиях**: обновление выдаёт
новый refresh-токен и гасит старый, поэтому обновление без записи сломает вход
у самого pi, а запись означала бы правку чужого конфига и гонку за токен.

**Открытый вопрос спецификации закрыт проверкой, запасное поведение не
понадобится.** `openai-codex` извлекает `accountId` из самого токена, поэтому
произвольную строку он отвергает до запроса с ошибкой
`Failed to extract accountId from token`. Но с настоящим `access` из
`auth.json` путь работает: запрос уходит, токен доезжает до заголовков.
Проверено локально с подставным `fetch`, без обращения к сети. Автотеста на
codex поэтому нет — он потребовал бы подделки JWT с нужным полем; вместо него
ручная проверка в Step 5.

- [ ] **Step 1: Написать падающие тесты**

Дописать в `test/pi-config.test.js`:

```js
async function withAuthFile(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dom-agent-auth-'));
  const path = join(dir, 'auth.json');
  await writeFile(path, JSON.stringify(content));
  try { await fn(path); } finally { await rm(dir, { recursive: true, force: true }); }
}

const HOUR = 3600_000;

test('живой oauth-токен становится ключом провайдера', async () => {
  await withAuthFile({ openrouter: { type: 'oauth', access: 'ЖИВОЙ-ТОКЕН',
    refresh: 'обновляющий', expires: Date.now() + HOUR } }, async authPath => {
    await withSettingsFile({ enabledModels: ['openrouter/openrouter/free'] }, async settingsPath => {
      const c = await loadConfig({
        path: FIXTURE_MODELS_PATH, authPath, settingsPath, env: {}, fetchImpl: NO_NET,
      });
      assert.equal(c.models.length, 1);
      assert.equal(c.providers.find(p => p.name === 'openrouter').apiKey, 'ЖИВОЙ-ТОКЕН');
    });
  });
});

test('истёкший oauth-токен: модель скрыта, заметка про повторный вход', async () => {
  await withAuthFile({ openrouter: { type: 'oauth', access: 'СТАРЫЙ',
    refresh: 'обновляющий', expires: Date.now() - HOUR } }, async authPath => {
    await withSettingsFile({ enabledModels: ['openrouter/openrouter/free'] }, async settingsPath => {
      const c = await loadConfig({
        path: FIXTURE_MODELS_PATH, authPath, settingsPath, env: {}, fetchImpl: NO_NET,
      });
      assert.equal(c.models.length, 0);
      assert.ok(c.notes.some(n => n.includes('pi')), 'заметка должна советовать войти через pi');
    });
  });
});

test('refresh-токен не попадает в ключ провайдера', async () => {
  await withAuthFile({ openrouter: { type: 'oauth', access: 'ЖИВОЙ-ТОКЕН',
    refresh: 'ОБНОВЛЯЮЩИЙ-СЕКРЕТ', expires: Date.now() + HOUR } }, async authPath => {
    await withSettingsFile({ enabledModels: ['openrouter/openrouter/free'] }, async settingsPath => {
      const c = await loadConfig({
        path: FIXTURE_MODELS_PATH, authPath, settingsPath, env: {}, fetchImpl: NO_NET,
      });
      assert.equal(c.providers.find(p => p.name === 'openrouter').apiKey, 'ЖИВОЙ-ТОКЕН');
      // но в secrets он быть обязан: collectSecretCandidates обходит auth.json целиком
      assert.ok(c.secrets.has('ОБНОВЛЯЮЩИЙ-СЕКРЕТ'));
    });
  });
});

test('oauth без expires считается живым', async () => {
  await withAuthFile({ openrouter: { type: 'oauth', access: 'БЕЗ-СРОКА' } }, async authPath => {
    await withSettingsFile({ enabledModels: ['openrouter/openrouter/free'] }, async settingsPath => {
      const c = await loadConfig({
        path: FIXTURE_MODELS_PATH, authPath, settingsPath, env: {}, fetchImpl: NO_NET,
      });
      assert.equal(c.models.length, 1);
    });
  });
});
```

- [ ] **Step 2: Запустить и убедиться, что падают**

Run: `npm test`
Expected: FAIL — oauth-учётка сейчас не распознаётся, `apiKey` пуст.

- [ ] **Step 3: Правка цепочки ключей в `server/pi-config.js`**

Заменить тело цикла разрешения ключа на:

```js
  for (const p of providers) {
    if (p.apiKey) continue;
    const entry = auth[p.name];

    if (entry?.type === 'oauth') {
      // Только чтение: обновление выдало бы новый refresh-токен и погасило
      // старый, сломав вход у самого pi. В ~/.pi/ мы не пишем никогда.
      if (typeof entry.expires === 'number' && entry.expires <= Date.now()) {
        p.authExpired = true;
        continue;
      }
      p.apiKey = typeof entry.access === 'string' ? entry.access : '';
      continue;
    }

    const stored = typeof entry?.key === 'string' ? entry.key
      : typeof entry?.apiKey === 'string' ? entry.apiKey : '';
    p.apiKey = stored || env[`${p.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`] || '';
  }
```

В разрешении ссылок из Task 3 заменить проверку ключа на различающую причину:

```js
      if (provider.authExpired) {
        notes.push(`${key}: вход через pi истёк, войдите заново — pi auth login ${ref.provider}`);
        continue;
      }
      if (!provider.apiKey) {
        notes.push(`${key}: пропущена, ключ провайдера ${ref.provider} не найден`);
        continue;
      }
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Проверить codex вручную на настоящем токене**

Сеть не задействуется: `fetch` подставной. **В вывод не должно попасть ничего,
кроме булевых значений** — токен не печатать.

```bash
node --input-type=module -e "
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { builtinProviders, getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
const auth = JSON.parse(await readFile(join(homedir(), '.pi/agent/auth.json'), 'utf8'));
const cred = auth['openai-codex'];
console.log('учётка:', !!cred, '| тип:', cred?.type, '| живой:', cred?.expires > Date.now());
const p = builtinProviders().find(x => x.id === 'openai-codex');
const model = getBuiltinModels('openai-codex').find(m => m.id === 'gpt-5.6-luna');
let went = false, hasToken = false;
const fakeFetch = async (url, init) => {
  went = true;
  const h = init?.headers instanceof Headers ? Object.fromEntries(init.headers) : (init?.headers ?? {});
  hasToken = JSON.stringify(h).includes(cred.access);
  return new Response('{}', { status: 401 });
};
const ev = p.stream(model, { systemPrompt: 'с', messages: [{ role:'user', content:'п', timestamp: Date.now() }] },
  { apiKey: cred.access, fetch: fakeFetch, maxTokens: 16, transport: 'sse' });
try { for await (const e of ev) if (e.type === 'error') break; } catch {}
console.log('запрос ушёл:', went, '| токен в заголовках:', hasToken);
"
```

Expected: `учётка: true | тип: oauth | живой: true` и
`запрос ушёл: true | токен в заголовках: true`.

Если `живой: false` — токен истёк; это не отказ реализации, а повод войти
заново через pi. Тогда проверьте, что модели codex скрыты и заметка про
повторный вход появилась.

- [ ] **Step 6: Убедиться, что в `~/.pi/` ничего не пишется**

```bash
ls -l --time-style=full-iso ~/.pi/agent/auth.json ~/.pi/agent/settings.json 2>/dev/null || stat -f "%Sm %N" ~/.pi/agent/auth.json ~/.pi/agent/settings.json
node -e "import('./server/pi-config.js').then(m => m.loadConfig()).then(c => console.log('загружено моделей:', c.models.length))"
stat -f "%Sm %N" ~/.pi/agent/auth.json ~/.pi/agent/settings.json
```

Expected: время изменения обоих файлов до и после загрузки совпадает.

Дополнительно убедитесь поиском, что во всём `server/` нет ни одной записи в
домашний каталог:

```bash
grep -rn "writeFile\|appendFile\|createWriteStream\|\.pi/" server/ || echo "записи нет"
```

Expected: `записи нет`.

- [ ] **Step 7: Коммит**

```bash
git add server/pi-config.js test/pi-config.test.js && git commit -m "feat(config): oauth-учётка только на чтение, без записи в конфиг pi"
```

---

### Task 5: Отправка через поток встроенного провайдера

**Files:**
- Modify: `server/index.js`
- Modify: `test/server.test.js`

- [ ] **Step 1: Написать падающие тесты**

Дописать в `test/server.test.js`:

```js
test('модель встроенного провайдера уходит через его собственный поток', async () => {
  let usedBuiltin = false;
  const provider = { name: 'встроенный', apiKey: 'ключ', builtin: true,
    baseUrl: 'https://пример', streamFn: () => { usedBuiltin = true; return fakeStream([
      { type: 'text_delta', delta: 'x()' },
      { type: 'done', reason: 'stop', message: {} },
    ])(); } };
  const model = { provider: 'встроенный', id: 'м', api: 'openai-responses', maxTokens: 16 };

  const app = createApp({ configPath: '/нет', authPath: '/нет' });
  app.state.config = { models: [model], providers: [provider], notes: [], secrets: new Set(), error: null };
  await app.listen(0);
  try {
    const events = await readSse(await fetch(`http://127.0.0.1:${app.port}/api/commit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: { provider: 'встроенный', id: 'м' }, diff: 'д' }),
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
  const app = createApp({ configPath: '/нет', authPath: '/нет' });
  app.state.config = { models: [], providers: [], notes: [], secrets: new Set(),
    error: null, default: { provider: 'deepseek', id: 'deepseek-v4-pro' } };
  await app.listen(0);
  try {
    const body = await (await fetch(`http://127.0.0.1:${app.port}/api/models`)).json();
    assert.deepEqual(body.default, { provider: 'deepseek', id: 'deepseek-v4-pro' });
  } finally { await app.close(); }
});
```

- [ ] **Step 2: Запустить и убедиться, что падают**

Run: `npm test`
Expected: FAIL — `pickStream` не смотрит на провайдера, `publicView` не отдаёт
умолчание.

- [ ] **Step 3: Правка `server/index.js`**

Заменить `pickStream` и вызов в `collect`:

```js
  function pickStream(model, provider) {
    if (opts.streamFn) return opts.streamFn;
    // Встроенный провайдер несёт собственный поток, поэтому его api-тип
    // (openai-responses, google-generative-ai, openai-codex-responses)
    // не требует от нас адаптера.
    if (provider?.streamFn) return provider.streamFn;
    return model.api === 'anthropic-messages' ? anthropicStream : openaiStream;
  }

  async function collect(model, provider, signal, res) {
    const events = pickStream(model, provider)(
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
```

- [ ] **Step 4: Правка `publicView` в `server/pi-config.js`**

```js
export function publicView(c) {
  return {
    models: publicModels(c.models),
    notes: c.notes.map(n => scrub(n, c.secrets)),
    error: c.error ? scrub(c.error, c.secrets) : null,
    default: c.default ?? null,
  };
}
```

Существующий тест `'GET /api/models отдаёт только provider, id и contextWindow'`
проверяет ключи первой модели, а не ключи ответа целиком — он не сломается.
Если в `test/server.test.js` есть тест, сверяющий `Object.keys` **ответа**,
допишите в ожидание `default`.

- [ ] **Step 5: Запустить тесты**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Коммит**

```bash
git add server/index.js server/pi-config.js test/server.test.js && git commit -m "feat(server): поток встроенного провайдера и умолчание в /api/models"
```

---

### Task 6: Предвыбор умолчания в оболочке

**Files:**
- Modify: `web/shell.js`

- [ ] **Step 1: Правка `loadModels` в `web/shell.js`**

```js
async function loadModels() {
  const r = await fetch('api/models').then(r => r.json());
  modelSel.replaceChildren();
  for (const m of r.models) {
    const o = document.createElement('option');
    o.value = m.provider + ' ' + m.id;
    o.textContent = m.provider + ' / ' + m.id;
    modelSel.append(o);
  }
  // Умолчание из настроек pi. Если такой модели нет в отобранном списке —
  // остаётся первая, как было.
  if (r.default) {
    const want = r.default.provider + ' ' + r.default.id;
    if ([...modelSel.options].some(o => o.value === want)) modelSel.value = want;
  }
  if (r.error) say(r.error);
  else if (r.notes?.length) say(r.notes.join('\n'));
}
```

- [ ] **Step 2: Проверить руками**

```bash
npm start
```

Открыть `http://127.0.0.1:8730`. Expected: в селекторе ровно записи из
`enabledModels`, предвыбран `deepseek / deepseek-v4-pro`. Заметки про
пропущенные модели, если они есть, видны в логе под панелью.

Сервер остановить после проверки.

- [ ] **Step 3: Коммит**

```bash
git add web/shell.js && git commit -m "feat(web): предвыбор модели по умолчанию из настроек pi"
```

---

### Task 7: Сквозная проверка и документы

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Проверить состав селектора**

Запустить `npm start`, открыть `http://127.0.0.1:8730`.

Expected: список совпадает с `enabledModels` пользователя за вычетом тех, что
попали в заметки. Ни одной лишней модели: 346 моделей openrouter в списке быть
не должно.

- [ ] **Step 2: Живой ход на модели openrouter**

Выбрать `openrouter / openrouter/free`, нажать «отправить».

Expected: ход доходит до ответа, код исполняется в образе. Если провайдер
вернул ошибку — она видна в логе и **не содержит ни ключа, ни `baseUrl`**.

- [ ] **Step 3: Проверить, что ключи не утекли**

В DevTools на вкладке Network открыть ответ `GET /api/models`.

Expected: ни `openrouter.ai`, ни какого-либо ключа в теле нет; у каждой модели
ровно три поля плюс `default` на верхнем уровне.

- [ ] **Step 4: Проверить поведение без настроек**

```bash
PI_MODELS_PATH=$HOME/.pi/agent/models.json node -e "import('./server/pi-config.js').then(m => m.loadConfig({ settingsPath: '/нет/settings.json' })).then(c => { console.log('моделей без настроек:', c.models.length); console.log('провайдеры:', [...new Set(c.models.map(x => x.provider))]); })"
```

Expected: прежнее поведение — 12 моделей от четырёх пользовательских
провайдеров, openrouter среди них нет.

- [ ] **Step 5: Дописать README**

В разделе про устройство добавить `server/pi-settings.js` в перечень файлов.
В раздел про запуск добавить абзац:

```markdown
Список моделей берётся из `enabledModels` в `~/.pi/agent/settings.json` —
того же файла, которым вы отбираете модели в самом pi. Поддерживаются и
пользовательские провайдеры из `models.json`, и встроенные в pi, включая
openrouter. Если `enabledModels` пуст или файла нет, показываются все модели
из `models.json` плюс найденные discovery.

Учётки oauth читаются, но никогда не обновляются: dom-agent не пишет в
`~/.pi/` ни при каких условиях. Истёкший вход виден в заметках под панелью.
```

- [ ] **Step 6: Коммит**

```bash
git add README.md && git commit -m "docs: README про enabledModels и oauth только на чтение"
```

---

## Что осталось за рамками

Обновление oauth-токенов и вход через dom-agent. Фильтр или поиск по моделям —
не нужен, пока список отобран в pi. Встроенные провайдеры без отобранного
списка: сознательно не подключаются, иначе селектор получает четыреста
пунктов. `models-store.json` не читается — зашитые в пакет списки совпадают с
ним с точностью до единиц, а лишний файл означал бы лишний источник правды.
