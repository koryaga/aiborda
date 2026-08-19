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
