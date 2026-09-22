import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../server/bridge.js';

test('call sends a request and resolves with the answer carrying the same id', async () => {
  const sent = [];
  const b = createBridge({ send: m => sent.push(m), timeoutMs: 1000 });
  const p = b.call('return 1 + 1');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'page_exec');
  assert.equal(sent[0].code, 'return 1 + 1');
  b.deliver({ id: sent[0].id, ok: true, value: '2' });
  assert.deepEqual(await p, { ok: true, value: '2' });
});

test("an answer with someone else's id is ignored, our own is still awaited", async () => {
  const sent = [];
  const b = createBridge({ send: m => sent.push(m), timeoutMs: 1000 });
  const p = b.call('x');
  b.deliver({ id: 'foreign', ok: true, value: 'forgery' });
  b.deliver({ id: sent[0].id, ok: true, value: 'genuine' });
  assert.deepEqual(await p, { ok: true, value: 'genuine' });
});

test('a duplicate answer for the same id does not break the bridge', async () => {
  const sent = [];
  const b = createBridge({ send: m => sent.push(m), timeoutMs: 1000 });
  const p = b.call('x');
  b.deliver({ id: sent[0].id, ok: true, value: 'first' });
  b.deliver({ id: sent[0].id, ok: true, value: 'second' });
  assert.deepEqual(await p, { ok: true, value: 'first' });
});

test('with no answer the call is rejected on timeout', async () => {
  const b = createBridge({ send: () => {}, timeoutMs: 20 });
  await assert.rejects(b.call('x'), /did not answer/);
});

test('identifiers are not reused', () => {
  const sent = [];
  const b = createBridge({ send: m => sent.push(m), timeoutMs: 1000 });
  // The calls are deliberately never resolved: only the ids in sent matter.
  // The timeout rejection is caught so it does not surface as an
  // unhandledRejection after the test.
  b.call('a').catch(() => {});
  b.call('b').catch(() => {});
  b.call('c').catch(() => {});
  assert.equal(new Set(sent.map(m => m.id)).size, 3);
});

test('an execution error arrives as-is', async () => {
  const sent = [];
  const b = createBridge({ send: m => sent.push(m), timeoutMs: 1000 });
  const p = b.call('bad code');
  b.deliver({ id: sent[0].id, ok: false, error: 'ReferenceError: bad' });
  assert.deepEqual(await p, { ok: false, error: 'ReferenceError: bad' });
});

test('reset rejects every pending call', async () => {
  const sent = [];
  const b = createBridge({ send: m => sent.push(m), timeoutMs: 5000 });
  const p1 = b.call('a'), p2 = b.call('b');
  b.reset('the page was reloaded');
  await assert.rejects(p1, /reloaded/);
  await assert.rejects(p2, /reloaded/);
  assert.equal(b.pendingCount(), 0);
});

test('a call with no shell connected is rejected immediately', async () => {
  const b = createBridge({ send: null, timeoutMs: 1000 });
  await assert.rejects(b.call('x'), /shell is not connected/);
});

// --- Extra tests (self-check) ---

test('the timer is cleared on an answer: pendingCount drops to zero, a repeat deliver does nothing', async () => {
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

test('setSender(null) mid-life: pending calls survive, new ones are rejected immediately', async () => {
  const sent = [];
  const b = createBridge({ send: m => sent.push(m), timeoutMs: 5000 });
  const p = b.call('a');
  b.setSender(null);
  b.deliver({ id: sent[0].id, ok: true, value: 'ok' });
  assert.deepEqual(await p, { ok: true, value: 'ok' });
  await assert.rejects(b.call('b'), /shell is not connected/);
});

test('deliver with junk returns false and does not throw', () => {
  const b = createBridge({ send: () => {}, timeoutMs: 1000 });
  assert.equal(b.deliver(null), false);
  assert.equal(b.deliver(undefined), false);
  assert.equal(b.deliver({}), false);
  assert.equal(b.deliver('a string'), false);
});

test('reset on an empty bridge does not throw', () => {
  const b = createBridge({ send: () => {}, timeoutMs: 1000 });
  assert.doesNotThrow(() => b.reset('a reason'));
  assert.equal(b.pendingCount(), 0);
});
