import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatEvent, createPrinter, streamKind } from '../server/stream-log.js';

const plain = ev => formatEvent(ev, { color: false });

test('the model text goes through as-is, with no framing', () => {
  const s = plain({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hel' } });
  assert.equal(s, 'hel');
});

test('reasoning is dimmed by colour, not hidden', () => {
  const withColor = formatEvent(
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking' } },
    { color: true });
  assert.ok(withColor.includes('thinking'));
  assert.ok(withColor.startsWith('\x1b[2m'), 'it should be dimmed');
  assert.equal(plain({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking' } }), 'thinking');
});

test('a stream with no delta prints nothing', () => {
  assert.equal(plain({ type: 'message_update', assistantMessageEvent: { type: 'text_start' } }), null);
  assert.equal(plain({ type: 'message_update' }), null);
});

test('a tool call shows the name and the arguments', () => {
  const s = plain({ type: 'tool_execution_start', toolName: 'page_exec', args: { code: 'return 1' } });
  assert.ok(s.includes('page_exec'));
  assert.ok(s.includes('return 1'));
  assert.ok(s.startsWith('\n'), 'a call starts on a new line so it does not run into the text');
});

test('a tool result is unwrapped from content', () => {
  const s = plain({ type: 'tool_execution_end', toolName: 'page_exec',
    result: { content: [{ type: 'text', text: 'done' }] }, isError: false });
  assert.ok(s.includes('page_exec'));
  assert.ok(s.includes('done'));
});

test('a tool error is marked', () => {
  const s = plain({ type: 'tool_execution_end', toolName: 'bash',
    result: { content: [{ type: 'text', text: 'not found' }] }, isError: true });
  assert.ok(s.includes('✗'));
});

test('long arguments and results are truncated onto one line', () => {
  const s = plain({ type: 'tool_execution_start', toolName: 'page_exec',
    args: { code: 'x'.repeat(1000) + '\ny' } });
  assert.equal(s.split('\n').filter(Boolean).length, 1, 'one line should remain');
  assert.ok(s.includes('…'));
});

test('a newline inside the result does not break the single line', () => {
  const s = plain({ type: 'tool_execution_end', toolName: 'bash',
    result: { content: [{ type: 'text', text: 'first\nsecond' }] }, isError: false });
  assert.equal(s.trim().split('\n').length, 1);
});

test('a result given as a plain string is understood too', () => {
  const s = plain({ type: 'tool_execution_end', toolName: 'x', result: 'done', isError: false });
  assert.ok(s.includes('done'));
});

test('other events stay silent, junk does not bring it down', () => {
  for (const ev of [null, undefined, {}, { type: 42 }, { type: 'message_start' }, { type: 'agent_start' }]) {
    assert.equal(plain(ev), null, 'should be null for ' + JSON.stringify(ev));
  }
});

test('turn_start and agent_settled separate turns with a blank line', () => {
  assert.equal(plain({ type: 'turn_start' }), '\n');
  assert.equal(plain({ type: 'agent_settled' }), '\n');
});

test('createPrinter writes only what gets formatted', () => {
  const out = [];
  const print = createPrinter(s => out.push(s), { color: false });
  print({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'a' } });
  print({ type: 'message_start' });
  print({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'b' } });
  assert.deepEqual(out, ['a', 'b']);
});

test('streamKind tells reasoning apart from the answer', () => {
  assert.equal(streamKind({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta' } }), 'thinking');
  assert.equal(streamKind({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' } }), 'text');
  assert.equal(streamKind({ type: 'tool_execution_start' }), null);
});

test('the switch from reasoning to the answer is separated by a newline', () => {
  const out = [];
  const print = createPrinter(s => out.push(s), { color: false });
  print({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking' } });
  print({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'answering' } });
  assert.deepEqual(out, ['thinking', '\n', 'answering']);
});

test('there are no stray newlines within a single stream', () => {
  const out = [];
  const print = createPrinter(s => out.push(s), { color: false });
  print({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'a' } });
  print({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'b' } });
  assert.deepEqual(out, ['a', 'b']);
});

test('no stray newline is inserted after a tool call', () => {
  const out = [];
  const print = createPrinter(s => out.push(s), { color: false });
  print({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking' } });
  print({ type: 'tool_execution_start', toolName: 't', args: {} });
  print({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'answer' } });
  assert.equal(out.filter(x => x === '\n').length, 0, 'a tool call already carries its own newlines');
});
