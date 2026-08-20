import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistory, SYSTEM_PROMPT, estimateTokens } from '../server/context.js';

const MODEL = { id: 'g:1', api: 'openai-completions', provider: 'ollama' };

test('системный промпт требует только код и объясняет чтение состояния', () => {
  assert.ok(SYSTEM_PROMPT.includes('ТОЛЬКО кодом JavaScript'));
  assert.ok(SYSTEM_PROMPT.includes('return'));
  assert.ok(SYSTEM_PROMPT.includes('#notes'));
});

test('порядок сообщений: результат, диф, код', () => {
  const h = createHistory();
  h.pushResult('42');
  h.pushDiff('#q  "" -> "привет"');
  h.pushCode('document.title = "x"', MODEL);
  assert.deepEqual(h.messages.map(m => m.role), ['user', 'user', 'assistant']);
  assert.equal(h.messages[0].content, 'результат: 42');
  assert.equal(h.messages[1].content, '#q  "" -> "привет"');
  assert.deepEqual(h.messages[2].content, [{ type: 'text', text: 'document.title = "x"' }]);
});

test('undefined-результат сообщения не добавляет', () => {
  const h = createHistory();
  h.pushResult(undefined);
  h.pushResult(null);
  assert.equal(h.messages.length, 0);
});

test('сообщение модели содержит поля, обязательные для pi-ai', () => {
  const h = createHistory();
  h.pushCode('x()', MODEL);
  const m = h.messages[0];
  for (const k of ['role', 'content', 'api', 'provider', 'model', 'usage', 'stopReason', 'timestamp']) {
    assert.ok(k in m, `нет поля ${k}`);
  }
  assert.equal(typeof m.usage.totalTokens, 'number');
});

test('reset очищает историю', () => {
  const h = createHistory();
  h.pushDiff('a');
  h.reset();
  assert.equal(h.messages.length, 0);
});

test('оценка токенов — четыре символа на токен', () => {
  assert.equal(estimateTokens('12345678'), 2);
});

// --- Дополнительно ---

test('usage не расшаривается по ссылке между сообщениями', () => {
  const h = createHistory();
  h.pushCode('a()', MODEL);
  h.pushCode('b()', MODEL);
  const [m1, m2] = h.messages;
  assert.notEqual(m1.usage, m2.usage);
  assert.notEqual(m1.usage.cost, m2.usage.cost);
  m1.usage.totalTokens = 999;
  m1.usage.cost.input = 999;
  assert.equal(m2.usage.totalTokens, 0);
  assert.equal(m2.usage.cost.input, 0);
});

test('пустой код кладётся в историю как законный ход', () => {
  const h = createHistory();
  h.pushCode('', MODEL);
  assert.equal(h.messages.length, 1);
  assert.deepEqual(h.messages[0].content, [{ type: 'text', text: '' }]);
});

test('size() растёт с историей и учитывает системный промпт', () => {
  const h = createHistory();
  const empty = h.size();
  assert.ok(empty > 0);
  h.pushDiff('#q "" -> "привет"');
  h.pushCode('document.title = "x"', MODEL);
  assert.ok(h.size() > empty);
});

test('pushResult(0) и pushResult("") добавляют сообщения', () => {
  const h = createHistory();
  h.pushResult(0);
  h.pushResult('');
  assert.equal(h.messages.length, 2);
  assert.equal(h.messages[0].content, 'результат: 0');
  assert.equal(h.messages[1].content, 'результат: ');
});

test('messages — тот же массив, reset очищает его на месте', () => {
  const h = createHistory();
  const ref = h.messages;
  h.pushDiff('a');
  h.pushDiff('b');
  assert.equal(h.messages, ref);
  h.reset();
  assert.equal(h.messages, ref);
  assert.equal(ref.length, 0);
});
