import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPageTool } from '../server/agent.js';

test('the tool is declared the way pi expects', () => {
  const t = createPageTool(async () => ({ ok: true, value: 'x' }));
  for (const k of ['name', 'label', 'description', 'parameters', 'execute']) {
    assert.ok(k in t, `missing field ${k}`);
  }
  assert.equal(t.name, 'page_exec');
  assert.equal(t.executionMode, 'sequential');
  assert.equal(typeof t.execute, 'function');
});

test('the description explains that this is the only access to the page', () => {
  const t = createPageTool(async () => ({ ok: true }));
  assert.match(t.description, /page/i);
  assert.ok(Array.isArray(t.promptGuidelines) && t.promptGuidelines.length > 0);
  assert.ok(t.promptGuidelines.join(' ').includes('localStorage'),
    'the model must know about persistent storage');
});

test('execute passes the code to the bridge and returns the value as text', async () => {
  let got = null;
  const t = createPageTool(async code => { got = code; return { ok: true, value: '42' }; });
  const r = await t.execute('c1', { code: 'return 42' });
  assert.equal(got, 'return 42');
  assert.deepEqual(r.content, [{ type: 'text', text: '42' }]);
});

test('code that returns no value yields intelligible text, not emptiness', async () => {
  const t = createPageTool(async () => ({ ok: true, value: undefined }));
  const r = await t.execute('c1', { code: 'document.title = "x"' });
  assert.equal(r.content[0].text.length > 0, true);
});

test('an execution error is returned to the model, not thrown', async () => {
  const t = createPageTool(async () => ({ ok: false, error: 'ReferenceError: nope' }));
  const r = await t.execute('c1', { code: 'nope.such' });
  assert.match(r.content[0].text, /ReferenceError/);
});

test('a bridge refusal comes back to the model as text', async () => {
  const t = createPageTool(async () => { throw new Error('shell is not connected'); });
  const r = await t.execute('c1', { code: 'x' });
  assert.match(r.content[0].text, /shell is not connected/);
});

// --- Extra tests (self-check) ---

test('a very long value is truncated to 10000 characters', async () => {
  const long = 'a'.repeat(20000);
  const t = createPageTool(async () => ({ ok: true, value: long }));
  const r = await t.execute('c1', { code: 'x' });
  assert.equal(r.content[0].text.length, 10000);
  assert.equal(r.content[0].text, 'a'.repeat(10000));
});

test('a value of exactly 10000 characters is not truncated and loses no tail', async () => {
  const exact = 'b'.repeat(10000);
  const t = createPageTool(async () => ({ ok: true, value: exact }));
  const r = await t.execute('c1', { code: 'x' });
  assert.equal(r.content[0].text, exact);
});

test('execute does not throw on a synchronous exception in callPage', async () => {
  const t = createPageTool(() => { throw new Error('synchronous blow-up'); });
  const r = await t.execute('c1', { code: 'x' });
  assert.match(r.content[0].text, /synchronous blow-up/);
});

test('execute does not throw on a rejected promise with no message', async () => {
  const t = createPageTool(async () => { throw new Error(); });
  const r = await t.execute('c1', { code: 'x' });
  assert.equal(typeof r.content[0].text, 'string');
  assert.ok(r.content[0].text.length > 0);
});

test('execute does not throw if callPage returned undefined instead of an object', async () => {
  const t = createPageTool(async () => undefined);
  const r = await t.execute('c1', { code: 'x' });
  assert.equal(typeof r.content[0].text, 'string');
});

test('execute does not throw if callPage returned junk with no ok/value/error', async () => {
  const t = createPageTool(async () => ({}));
  const r = await t.execute('c1', { code: 'x' });
  assert.equal(typeof r.content[0].text, 'string');
});

test('the parameter schema is a valid TypeBox TSchema with a required code:string', () => {
  const t = createPageTool(async () => ({ ok: true }));
  assert.equal(t.parameters.type, 'object');
  assert.ok(t.parameters.required.includes('code'));
  assert.equal(t.parameters.properties.code.type, 'string');
});
