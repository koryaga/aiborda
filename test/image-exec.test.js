import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const src = await readFile(new URL('../web/image-boot.js', import.meta.url), 'utf8');
const createImage = new Function(src + '\nreturn createImage;')();

function makeImage(html = '<textarea id="q"></textarea><div id="out"></div>') {
  const dom = new JSDOM(`<body>${html}</body>`, { runScripts: 'outside-only' });
  const sent = [];
  const img = createImage(dom.window.document, m => sent.push(m), { trusted: () => true, grace: 0 });
  return { dom, doc: dom.window.document, img, sent };
}

test('exec returns a value', async () => {
  const { img } = makeImage();
  const r = await img.exec('return 1 + 1');
  assert.equal(r.ok, true);
  assert.equal(r.value, '2');
});

test('exec changes the DOM', async () => {
  const { img, doc } = makeImage();
  await img.exec('document.querySelector("#out").textContent = "done"');
  assert.equal(doc.querySelector('#out').textContent, 'done');
});

test('exec returns an error rather than throwing', async () => {
  const { img } = makeImage();
  const r = await img.exec('noSuchObject.field');
  assert.equal(r.ok, false);
  assert.ok(r.error.length > 0);
});

test('exec without a return yields no value', async () => {
  const { img } = makeImage();
  const r = await img.exec('const x = 1;');
  assert.equal(r.ok, true);
  assert.equal(r.value, undefined);
});

test('a value is truncated to 10000 characters', async () => {
  const { img } = makeImage();
  const r = await img.exec('return "y".repeat(20000)');
  assert.equal(r.value.length, 10000);
});

test("snapshot carries a field's live value into the markup", async () => {
  const { img, doc } = makeImage();
  doc.querySelector('#q').value = 'typed in';
  assert.ok(img.snapshot().includes('typed in'));
});

test('snapshot does not mutate the live DOM', async () => {
  const { img, doc } = makeImage();
  const q = doc.querySelector('#q');
  q.value = 'typed in';
  img.snapshot();
  assert.equal(q.getAttribute('value'), null);
});

test('handle answers exec with a result message carrying the same id', async () => {
  const { img, sent } = makeImage();
  await img.handle({ type: 'exec', id: 7, code: 'return 5' });
  assert.deepEqual(sent.at(-1), { type: 'result', id: 7, ok: true, value: '5', error: undefined });
});

// --- Beyond the plan ---

test("exec works with the model's asynchronous code (an await inside)", async () => {
  const { img } = makeImage();
  const r = await img.exec('await new Promise(r => setTimeout(r, 1)); return "done"');
  assert.equal(r.ok, true);
  assert.equal(r.value, 'done');
});

test('exec serializes an object into parseable JSON, not [object Object]', async () => {
  const { img } = makeImage();
  const r = await img.exec('return ({a: 1})');
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(r.value), { a: 1 });
});

test('exec does not crash on a circular reference', async () => {
  const { img } = makeImage();
  const r = await img.exec('const o = {}; o.o = o; return o');
  assert.equal(r.ok, true);
  assert.ok(typeof r.value === 'string' && r.value.length > 0);
});

test('handle ignores garbage and sends nothing', async () => {
  const { img, sent } = makeImage();
  await img.handle(null);
  await img.handle({});
  await img.handle({ type: 'unknown' });
  assert.deepEqual(sent, []);
});

test("snapshot carries a checkbox's checked and an option's selected", async () => {
  const { img, doc } = makeImage(
    '<input id="c" type="checkbox">' +
    '<select id="s"><option value="a">a</option><option value="b">b</option></select>'
  );
  doc.querySelector('#c').checked = true;
  doc.querySelector('#s').value = 'b';
  const html = img.snapshot();
  assert.ok(/id="c"[^>]*checked/.test(html) || /checked[^>]*id="c"/.test(html));
  assert.ok(/value="b"[^>]*selected/.test(html));
});

test('an execution error does not strand execDepth — the next exec works normally', async () => {
  const { img } = makeImage();
  const bad = await img.exec('noSuchObject.field');
  assert.equal(bad.ok, false);
  const good = await img.exec('return 42');
  assert.equal(good.ok, true);
  assert.equal(good.value, '42');
});

function installed(trusted) {
  const dom = new JSDOM('<body><textarea id="q"></textarea></body>', { runScripts: 'outside-only' });
  const sent = [];
  createImage(dom.window.document, m => sent.push(m), { trusted, grace: 0 }).install();
  return { dom, doc: dom.window.document, commits: () => sent.filter(m => m.type === 'commit') };
}

function key(dom, doc, init) {
  doc.querySelector('#q').dispatchEvent(new dom.window.KeyboardEvent('keydown',
    { key: 'Enter', bubbles: true, cancelable: true, ...init }));
}

test('Ctrl+Enter in the image asks the shell to commit a turn', () => {
  const { dom, doc, commits } = installed(() => true);
  key(dom, doc, { ctrlKey: true });
  assert.equal(commits().length, 1);
});

test('Cmd+Enter works the same way', () => {
  const { dom, doc, commits } = installed(() => true);
  key(dom, doc, { metaKey: true });
  assert.equal(commits().length, 1);
});

test('Enter without a modifier does not start a turn', () => {
  const { dom, doc, commits } = installed(() => true);
  key(dom, doc, {});
  assert.equal(commits().length, 0);
});

test('another key with Ctrl does not start a turn', () => {
  const { dom, doc, commits } = installed(() => true);
  doc.querySelector('#q').dispatchEvent(new dom.window.KeyboardEvent('keydown',
    { key: 'a', ctrlKey: true, bubbles: true }));
  assert.equal(commits().length, 0);
});

test("a synthetic Ctrl+Enter from the model's code is ignored", () => {
  const { dom, doc, commits } = installed(e => e.isTrusted);
  key(dom, doc, { ctrlKey: true });
  assert.equal(commits().length, 0, 'the model must not commit a turn on the human behalf');
});
