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
