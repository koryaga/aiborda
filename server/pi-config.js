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
      error: `не найден ${path} — создайте его или укажите --pi-config` };
  }

  const { auth, error: authError } = await readAuth(authPath);
  const { providers, models, notes } = flattenModels(raw, { env });
  if (authError) notes.push(`auth.json не разобран — ${authError}`);

  for (const p of providers) {
    if (p.apiKey) continue;
    const entry = auth[p.name];
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

  const secrets = new Set();
  collectSecretCandidates(auth, secrets);
  for (const p of providers) if (p.apiKey) secrets.add(p.apiKey);

  return { providers, models, notes, secrets, error: null };
}

export function publicModels(models) {
  return models.map(m => ({ provider: m.provider, id: m.id, contextWindow: m.contextWindow }));
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
