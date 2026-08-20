import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPageTool } from '../server/agent.js';

test('инструмент объявлен так, как ждёт pi', () => {
  const t = createPageTool(async () => ({ ok: true, value: 'x' }));
  for (const k of ['name', 'label', 'description', 'parameters', 'execute']) {
    assert.ok(k in t, `нет поля ${k}`);
  }
  assert.equal(t.name, 'page_exec');
  assert.equal(t.executionMode, 'sequential');
  assert.equal(typeof t.execute, 'function');
});

test('описание объясняет, что это единственный доступ к странице', () => {
  const t = createPageTool(async () => ({ ok: true }));
  assert.match(t.description, /страниц/i);
  assert.ok(Array.isArray(t.promptGuidelines) && t.promptGuidelines.length > 0);
  assert.ok(t.promptGuidelines.join(' ').includes('localStorage'),
    'модель должна знать про постоянное хранилище');
});

test('execute передаёт код в мост и возвращает значение текстом', async () => {
  let got = null;
  const t = createPageTool(async code => { got = code; return { ok: true, value: '42' }; });
  const r = await t.execute('c1', { code: 'return 42' });
  assert.equal(got, 'return 42');
  assert.deepEqual(r.content, [{ type: 'text', text: '42' }]);
});

test('код без возвращённого значения даёт внятный текст, а не пустоту', async () => {
  const t = createPageTool(async () => ({ ok: true, value: undefined }));
  const r = await t.execute('c1', { code: 'document.title = "x"' });
  assert.equal(r.content[0].text.length > 0, true);
});

test('ошибка исполнения возвращается модели, а не бросается', async () => {
  const t = createPageTool(async () => ({ ok: false, error: 'ReferenceError: нет' }));
  const r = await t.execute('c1', { code: 'нет.такого' });
  assert.match(r.content[0].text, /ReferenceError/);
});

test('отказ моста возвращается модели текстом', async () => {
  const t = createPageTool(async () => { throw new Error('оболочка не подключена'); });
  const r = await t.execute('c1', { code: 'x' });
  assert.match(r.content[0].text, /оболочка не подключена/);
});

// --- Дополнительные тесты (самопроверка) ---

test('очень длинное значение усекается до 10000 символов', async () => {
  const long = 'a'.repeat(20000);
  const t = createPageTool(async () => ({ ok: true, value: long }));
  const r = await t.execute('c1', { code: 'x' });
  assert.equal(r.content[0].text.length, 10000);
  assert.equal(r.content[0].text, 'a'.repeat(10000));
});

test('значение ровно 10000 символов не усекается и не теряет хвост', async () => {
  const exact = 'b'.repeat(10000);
  const t = createPageTool(async () => ({ ok: true, value: exact }));
  const r = await t.execute('c1', { code: 'x' });
  assert.equal(r.content[0].text, exact);
});

test('execute не бросает при синхронном исключении в callPage', async () => {
  const t = createPageTool(() => { throw new Error('синхронный обвал'); });
  const r = await t.execute('c1', { code: 'x' });
  assert.match(r.content[0].text, /синхронный обвал/);
});

test('execute не бросает при отклонённом промисе без сообщения', async () => {
  const t = createPageTool(async () => { throw new Error(); });
  const r = await t.execute('c1', { code: 'x' });
  assert.equal(typeof r.content[0].text, 'string');
  assert.ok(r.content[0].text.length > 0);
});

test('execute не бросает, если callPage вернул undefined вместо объекта', async () => {
  const t = createPageTool(async () => undefined);
  const r = await t.execute('c1', { code: 'x' });
  assert.equal(typeof r.content[0].text, 'string');
});

test('execute не бросает, если callPage вернул мусор без ok/value/error', async () => {
  const t = createPageTool(async () => ({}));
  const r = await t.execute('c1', { code: 'x' });
  assert.equal(typeof r.content[0].text, 'string');
});

test('схема параметров — валидный TypeBox TSchema с обязательным code:string', () => {
  const t = createPageTool(async () => ({ ok: true }));
  assert.equal(t.parameters.type, 'object');
  assert.ok(t.parameters.required.includes('code'));
  assert.equal(t.parameters.properties.code.type, 'string');
});
