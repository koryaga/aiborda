import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getBuiltinModels, builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { loadSettings, DEFAULT_SETTINGS_PATH } from './pi-settings.js';

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

export async function discoverModels(provider, fetchImpl = globalThis.fetch) {
  if (provider.api !== 'openai-completions') return { models: [], notes: [] };
  const url = provider.baseUrl.replace(/\/+$/, '') + '/models';
  const headers = provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {};
  const res = await fetchImpl(url, { headers });
  // baseUrl намеренно не попадает в текст ошибки — заметки уходят в браузер как есть.
  if (!res.ok) throw new Error(`ответил ${res.status}`);
  const body = await res.json();
  const list = Array.isArray(body?.data) ? body.data : [];
  const models = [], notes = [];
  for (const d of list) {
    if (typeof d?.id !== 'string' || d.id === '') {
      notes.push(`провайдер ${provider.name}: модель без id пропущена`);
      continue;
    }
    models.push(toModel(provider, { id: d.id }));
  }
  return { models, notes };
}

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

async function readAuth(path) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch { return { auth: {}, error: null }; } // отсутствие файла — не ошибка
  try { return { auth: JSON.parse(text) ?? {}, error: null }; }
  catch (e) { return { auth: {}, error: e.message }; }
}

// Ложные срабатывания (email, URL, id модели) собираются сюда нарочно:
// пропустить настоящий секрет хуже, чем лишний раз заменить безобидную строку.
function collectSecretCandidates(value, out) {
  if (typeof value === 'string') { if (value.length >= 8) out.add(value); return out; }
  if (value && typeof value === 'object') for (const v of Object.values(value)) collectSecretCandidates(v, out);
  return out;
}

export async function loadConfig({
  path = DEFAULT_MODELS_PATH,
  authPath = DEFAULT_AUTH_PATH,
  settingsPath = DEFAULT_SETTINGS_PATH,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  let raw;
  try { raw = JSON.parse(await readFile(path, 'utf8')); }
  catch (e) {
    // Текст error фиксирован спецификацией дословно. Причину — только если models.json
    // на месте, но не разбирается (JSON.parse кидает SyntaxError); отсутствие файла молчит.
    const notes = e instanceof SyntaxError ? [`models.json не разобран — ${e.message}`] : [];
    return { providers: [], models: [], notes, secrets: new Set(),
      default: null,
      error: `не найден ${path} — создайте его или укажите --pi-config` };
  }

  const { auth, error: authError } = await readAuth(authPath);
  const { providers, models, notes } = flattenModels(raw, { env });
  if (authError) notes.push(`auth.json не разобран — ${authError}`);

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

  for (const p of providers) {
    if (!p.supported || !p.dynamic) continue;
    try {
      const found = await discoverModels(p, fetchImpl);
      models.push(...found.models);
      notes.push(...found.notes);
    } catch (e) { notes.push(`провайдер ${p.name}: список моделей не получен — ${e.message}`); }
  }

  let finalModels = models;
  if (settings.enabled.length) {
    const byRef = new Map(models.map(m => [m.provider + '/' + m.id, m]));
    const byName = new Map(providers.map(p => [p.name, p]));
    const resolved = [];
    const seen = new Set();
    for (const ref of settings.enabled) {
      const key = ref.provider + '/' + ref.id;
      if (seen.has(key)) continue;
      seen.add(key);

      const custom = byRef.get(key);
      if (custom) { resolved.push(custom); continue; }

      const provider = byName.get(ref.provider);
      if (!provider) {
        notes.push(`${key}: провайдер не найден ни в models.json, ни среди встроенных`);
        continue;
      }
      if (provider.authExpired) {
        notes.push(`${key}: вход через pi истёк, войдите заново — pi auth login ${ref.provider}`);
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

  // «secrets» — не только ключи, несмотря на имя (не переименовываем: на него
  // уже завязаны другие задачи). Сюда же попадает baseUrl каждого провайдера:
  // это второе, что не должно уйти в браузер, и полагаться на дисциплину
  // авторов текста в пяти местах, где пишутся заметки, не вышло — Task 3 закрыл
  // только ветку !res.ok, а когда fetchImpl бросает сам (сеть, битый URL без
  // схемы), сообщение чужое и baseUrl в нём никак не подавлен. Через secrets
  // scrub закрывает обе половины требования структурно, на выходе.
  const secrets = new Set();
  collectSecretCandidates(auth, secrets);
  for (const p of providers) {
    if (p.apiKey) secrets.add(p.apiKey);
    if (p.baseUrl) secrets.add(p.baseUrl);
  }

  return { providers, models: finalModels, notes, secrets, default: settings.default, error: null };
}

export function publicModels(models) {
  return models.map(m => ({ provider: m.provider, id: m.id, contextWindow: m.contextWindow }));
}

// Единственная точка, где решается, что из конфига уходит наружу в браузер:
// models — через allow-list publicModels, notes/error — через scrub тем же
// набором secrets. Живёт здесь, а не в server/index.js, чтобы весь периметр
// читался в одном файле рядом с тем, что в secrets кладётся.
export function publicView(c) {
  return {
    models: publicModels(c.models),
    notes: c.notes.map(n => scrub(n, c.secrets)),
    error: c.error ? scrub(c.error, c.secrets) : null,
    default: c.default ?? null,
  };
}

export function scrub(text, secrets) {
  let out = String(text ?? '');
  // Порог длины здесь намеренно отсутствует: секреты уже отфильтрованы на входе
  // в collectSecretCandidates. Сортировка по убыванию длины не даёт короткому секрету,
  // который является префиксом более длинного, оставить хвост незачищенным.
  const ordered = [...(secrets ?? [])].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const s of ordered) out = out.split(s).join('***');
  return out;
}
