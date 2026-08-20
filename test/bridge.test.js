import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../server/bridge.js';

test('call отправляет запрос и разрешается ответом с тем же id', async () => {
  const sent = [];
  const b = createBridge({ send: m => sent.push(m), timeoutMs: 1000 });
  const p = b.call('return 1 + 1');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'page_exec');
  assert.equal(sent[0].code, 'return 1 + 1');
  b.deliver({ id: sent[0].id, ok: true, value: '2' });
  assert.deepEqual(await p, { ok: true, value: '2' });
});

test('ответ с чужим id игнорируется, свой всё ещё ждёт', async () => {
  const sent = [];
  const b = createBridge({ send: m => sent.push(m), timeoutMs: 1000 });
  const p = b.call('x');
  b.deliver({ id: 'чужой', ok: true, value: 'подделка' });
  b.deliver({ id: sent[0].id, ok: true, value: 'настоящий' });
  assert.deepEqual(await p, { ok: true, value: 'настоящий' });
});

test('повторный ответ на тот же id не ломает мост', async () => {
  const sent = [];
  const b = createBridge({ send: m => sent.push(m), timeoutMs: 1000 });
  const p = b.call('x');
  b.deliver({ id: sent[0].id, ok: true, value: 'первый' });
  b.deliver({ id: sent[0].id, ok: true, value: 'второй' });
  assert.deepEqual(await p, { ok: true, value: 'первый' });
});

test('без ответа вызов отклоняется по таймауту', async () => {
  const b = createBridge({ send: () => {}, timeoutMs: 20 });
  await assert.rejects(b.call('x'), /не ответил/);
});

test('идентификаторы не повторяются', () => {
  const sent = [];
  const b = createBridge({ send: m => sent.push(m), timeoutMs: 1000 });
  // Вызовы намеренно не разрешаются: интересуют только id в sent. Ловим
  // отказ по таймауту, чтобы он не всплыл unhandledRejection после теста.
  b.call('a').catch(() => {});
  b.call('b').catch(() => {});
  b.call('c').catch(() => {});
  assert.equal(new Set(sent.map(m => m.id)).size, 3);
});

test('ошибка исполнения доходит как есть', async () => {
  const sent = [];
  const b = createBridge({ send: m => sent.push(m), timeoutMs: 1000 });
  const p = b.call('плохой код');
  b.deliver({ id: sent[0].id, ok: false, error: 'ReferenceError: плохой' });
  assert.deepEqual(await p, { ok: false, error: 'ReferenceError: плохой' });
});

test('reset отклоняет все ожидающие вызовы', async () => {
  const sent = [];
  const b = createBridge({ send: m => sent.push(m), timeoutMs: 5000 });
  const p1 = b.call('a'), p2 = b.call('b');
  b.reset('страница перезагружена');
  await assert.rejects(p1, /перезагружена/);
  await assert.rejects(p2, /перезагружена/);
  assert.equal(b.pendingCount(), 0);
});

test('вызов без подключённой оболочки отклоняется сразу', async () => {
  const b = createBridge({ send: null, timeoutMs: 1000 });
  await assert.rejects(b.call('x'), /оболочка не подключена/);
});

// --- Дополнительные тесты (самопроверка) ---

test('таймер снимается при ответе: pendingCount падает в ноль, повторный deliver не срабатывает', async () => {
  const sent = [];
  const b = createBridge({ send: m => sent.push(m), timeoutMs: 5000 });
  const p = b.call('x');
  assert.equal(b.pendingCount(), 1);
  const first = b.deliver({ id: sent[0].id, ok: true, value: '1' });
  assert.equal(first, true);
  assert.equal(b.pendingCount(), 0);
  await p;
  const second = b.deliver({ id: sent[0].id, ok: true, value: '2' });
  assert.equal(second, false);
});

test('setSender(null) посреди жизни: ожидающие вызовы не ломаются, новые отклоняются сразу', async () => {
  const sent = [];
  const b = createBridge({ send: m => sent.push(m), timeoutMs: 5000 });
  const p = b.call('a');
  b.setSender(null);
  b.deliver({ id: sent[0].id, ok: true, value: 'ok' });
  assert.deepEqual(await p, { ok: true, value: 'ok' });
  await assert.rejects(b.call('b'), /оболочка не подключена/);
});

test('deliver с мусором возвращает false и не бросает', () => {
  const b = createBridge({ send: () => {}, timeoutMs: 1000 });
  assert.equal(b.deliver(null), false);
  assert.equal(b.deliver(undefined), false);
  assert.equal(b.deliver({}), false);
  assert.equal(b.deliver('строка'), false);
});

test('reset на пустом мосте не бросает', () => {
  const b = createBridge({ send: () => {}, timeoutMs: 1000 });
  assert.doesNotThrow(() => b.reset('причина'));
  assert.equal(b.pendingCount(), 0);
});
