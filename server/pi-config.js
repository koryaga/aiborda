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
    cost: merged.cost ?? { ...ZERO_COST },
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
    for (const spec of p.models ?? []) models.push(toModel(provider, spec));
  }
  return { providers, models, notes };
}
