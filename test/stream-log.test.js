import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatEvent, createPrinter, streamKind } from '../server/stream-log.js';

const plain = ev => formatEvent(ev, { color: false });

test('текст модели идёт как есть, без обрамления', () => {
  const s = plain({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'при' } });
  assert.equal(s, 'при');
});

test('рассуждения приглушаются цветом, а не прячутся', () => {
  const withColor = formatEvent(
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'думаю' } },
    { color: true });
  assert.ok(withColor.includes('думаю'));
  assert.ok(withColor.startsWith('\x1b[2m'), 'должен быть приглушённый цвет');
  assert.equal(plain({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'думаю' } }), 'думаю');
});

test('поток без дельты ничего не печатает', () => {
  assert.equal(plain({ type: 'message_update', assistantMessageEvent: { type: 'text_start' } }), null);
  assert.equal(plain({ type: 'message_update' }), null);
});

test('вызов инструмента показывает имя и аргументы', () => {
  const s = plain({ type: 'tool_execution_start', toolName: 'page_exec', args: { code: 'return 1' } });
  assert.ok(s.includes('page_exec'));
  assert.ok(s.includes('return 1'));
  assert.ok(s.startsWith('\n'), 'вызов начинается с новой строки, чтобы не слипнуться с текстом');
});

test('результат инструмента разворачивается из content', () => {
  const s = plain({ type: 'tool_execution_end', toolName: 'page_exec',
    result: { content: [{ type: 'text', text: 'выполнено' }] }, isError: false });
  assert.ok(s.includes('page_exec'));
  assert.ok(s.includes('выполнено'));
});

test('ошибка инструмента помечается', () => {
  const s = plain({ type: 'tool_execution_end', toolName: 'bash',
    result: { content: [{ type: 'text', text: 'не найдено' }] }, isError: true });
  assert.ok(s.includes('✗'));
});

test('длинные аргументы и результаты усекаются в одну строку', () => {
  const s = plain({ type: 'tool_execution_start', toolName: 'page_exec',
    args: { code: 'x'.repeat(1000) + '\ny' } });
  assert.equal(s.split('\n').filter(Boolean).length, 1, 'должна остаться одна строка');
  assert.ok(s.includes('…'));
});

test('перевод строки внутри результата не ломает одну строку', () => {
  const s = plain({ type: 'tool_execution_end', toolName: 'bash',
    result: { content: [{ type: 'text', text: 'первая\nвторая' }] }, isError: false });
  assert.equal(s.trim().split('\n').length, 1);
});

test('результат строкой тоже понимается', () => {
  const s = plain({ type: 'tool_execution_end', toolName: 'x', result: 'готово', isError: false });
  assert.ok(s.includes('готово'));
});

test('прочие события молчат, мусор не роняет', () => {
  for (const ev of [null, undefined, {}, { type: 42 }, { type: 'message_start' }, { type: 'agent_start' }]) {
    assert.equal(plain(ev), null, 'должно быть null для ' + JSON.stringify(ev));
  }
});

test('turn_start и agent_settled разделяют ходы пустой строкой', () => {
  assert.equal(plain({ type: 'turn_start' }), '\n');
  assert.equal(plain({ type: 'agent_settled' }), '\n');
});

test('createPrinter пишет только то, что форматируется', () => {
  const out = [];
  const print = createPrinter(s => out.push(s), { color: false });
  print({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'а' } });
  print({ type: 'message_start' });
  print({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'б' } });
  assert.deepEqual(out, ['а', 'б']);
});

test('streamKind различает мысли и ответ', () => {
  assert.equal(streamKind({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta' } }), 'thinking');
  assert.equal(streamKind({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' } }), 'text');
  assert.equal(streamKind({ type: 'tool_execution_start' }), null);
});

test('переход от мыслей к ответу разделяется переводом строки', () => {
  const out = [];
  const print = createPrinter(s => out.push(s), { color: false });
  print({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'думаю' } });
  print({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'отвечаю' } });
  assert.deepEqual(out, ['думаю', '\n', 'отвечаю']);
});

test('внутри одного потока лишних переводов строки нет', () => {
  const out = [];
  const print = createPrinter(s => out.push(s), { color: false });
  print({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'а' } });
  print({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'б' } });
  assert.deepEqual(out, ['а', 'б']);
});

test('после вызова инструмента лишний перевод не вставляется', () => {
  const out = [];
  const print = createPrinter(s => out.push(s), { color: false });
  print({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'думаю' } });
  print({ type: 'tool_execution_start', toolName: 't', args: {} });
  print({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ответ' } });
  assert.equal(out.filter(x => x === '\n').length, 0, 'вызов инструмента уже несёт свои переводы строк');
});
