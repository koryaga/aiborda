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
