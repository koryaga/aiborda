import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripThinking, extractCode, checkParsable } from '../server/parse.js';

test('вырезает блок рассуждений', () => {
  assert.equal(stripThinking('<think>подумаю</think>const a = 1').trim(), 'const a = 1');
  assert.equal(stripThinking('<thinking>ага</thinking>x()').trim(), 'x()');
});

test('снимает обёртку из обратных кавычек', () => {
  assert.equal(extractCode('```js\nconst a = 1\n```'), 'const a = 1');
  assert.equal(extractCode('```\nconst a = 1\n```'), 'const a = 1');
});

test('отрезает вводные префиксы', () => {
  assert.equal(extractCode('Вот код:\nconst a = 1'), 'const a = 1');
  assert.equal(extractCode('Here is the code:\nconst a = 1'), 'const a = 1');
});

test('снимает рассуждения и кавычки вместе', () => {
  assert.equal(extractCode('<think>э</think>\n```js\nconst a = 1\n```'), 'const a = 1');
});

test('пустой ответ даёт пустую строку', () => {
  assert.equal(extractCode('   \n  '), '');
  assert.equal(extractCode('<think>только мысли</think>'), '');
});

test('checkParsable принимает код с верхнеуровневым await', () => {
  assert.deepEqual(checkParsable('await Promise.resolve(1)'), { ok: true });
});

test('checkParsable ловит синтаксическую ошибку', () => {
  const r = checkParsable('const = ;');
  assert.equal(r.ok, false);
  assert.ok(r.error.length > 0);
});

test('пустой код считается разбираемым', () => {
  assert.deepEqual(checkParsable(''), { ok: true });
});

// --- Дополнительно ---

test('незакрытый <think> срезается до конца ответа', () => {
  assert.equal(stripThinking('<think>я думаю').trim(), '');
  assert.equal(extractCode('<think>я думаю, что тут надо\nвызвать x()'), '');
});

test('несколько блоков рассуждений подряд вырезаются все', () => {
  assert.equal(
    stripThinking('<think>раз</think><think>два</think>const a = 1').trim(),
    'const a = 1'
  );
  assert.equal(
    extractCode('<think>раз</think>\n<thinking>два</thinking>\nconst a = 1'),
    'const a = 1'
  );
});

test('обратные кавычки внутри кода не портятся', () => {
  const src = '```js\nconst t = `привет ${name}`\n```';
  assert.equal(extractCode(src), 'const t = `привет ${name}`');
});

test('блок кода не с начала ответа: снимаются и префикс, и кавычки', () => {
  assert.equal(extractCode('Вот код:\n```js\nx()\n```'), 'x()');
  assert.equal(extractCode('Here is the code:\n```\nx()\n```'), 'x()');
});

test('checkParsable пропускает код, который бросит только при исполнении', () => {
  assert.deepEqual(checkParsable('нетТакогоОбъекта.поле'), { ok: true });
});

test('одиночные обратные кавычки без языка и без переводов строк снимаются', () => {
  assert.equal(extractCode('`x()`'), 'x()');
});
