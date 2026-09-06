import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const src = await readFile(new URL('../web/image-boot.js', import.meta.url), 'utf8');
const createImage = new Function(src + '\nreturn createImage;')();
const tick = () => new Promise(r => setTimeout(r, 0));
const wait = ms => new Promise(r => setTimeout(r, ms));

function makeImage(html, grace = 0) {
  const dom = new JSDOM(`<body>${html}</body>`, { runScripts: 'outside-only' });
  const sent = [];
  const img = createImage(dom.window.document, m => sent.push(m), { trusted: () => true, grace });
  img.install();
  return { dom, doc: dom.window.document, img, sent };
}

// M11: a helper next to makeImage instead of seven repeats of
// dispatchEvent(focusin).
function focusIn(dom, el) {
  el.dispatchEvent(new dom.window.Event('focusin', { bubbles: true }));
}

test('an attribute edit lands in the diff', async () => {
  const { doc, img } = makeImage('<div id="out" class="v1"></div>');
  doc.querySelector('#out').setAttribute('class', 'v2');
  await tick();
  assert.equal(img.buildDiff(), '#out  @class: "v1" -> "v2"');
});

test('two edits of one attribute yield a single line with the old value from the first', async () => {
  const { doc, img } = makeImage('<div id="out" class="v1"></div>');
  const el = doc.querySelector('#out');
  el.setAttribute('class', 'v2');
  await tick();
  el.setAttribute('class', 'v3');
  await tick();
  assert.equal(img.buildDiff(), '#out  @class: "v1" -> "v3"');
});

test('an edit that restored the previous value does not reach the diff', async () => {
  const { doc, img } = makeImage('<div id="out" class="v1"></div>');
  const el = doc.querySelector('#out');
  el.setAttribute('class', 'v2');
  await tick();
  el.setAttribute('class', 'v1');
  await tick();
  assert.equal(img.buildDiff(), '');
});

test('a node removal lands in the diff together with its HTML and parent', async () => {
  const { doc, img } = makeImage('<ul id="items"><li id="row-2">second</li></ul>');
  doc.querySelector('#row-2').remove();
  await tick();
  assert.equal(img.buildDiff(), 'removed from #items: <li id="row-2">second</li>');
});

test('a node addition lands in the diff', async () => {
  const { doc, img } = makeImage('<ul id="items"></ul>');
  const li = doc.createElement('li');
  li.id = 'row-3';
  li.textContent = 'third';
  doc.querySelector('#items').append(li);
  await tick();
  assert.equal(img.buildDiff(), 'added to #items: <li id="row-3">third</li>');
});

test('a node added and immediately removed does not show up in the diff', async () => {
  const { doc, img } = makeImage('<ul id="items"></ul>');
  const li = doc.createElement('li');
  doc.querySelector('#items').append(li);
  await tick();
  li.remove();
  await tick();
  assert.equal(img.buildDiff(), '');
});

test('a text edit lands in the diff with an nth-child path', async () => {
  const { doc, img } = makeImage('<ul id="items"><li>first</li></ul>');
  doc.querySelector('#items li').firstChild.data = 'first item';
  await tick();
  assert.equal(img.buildDiff(), '#items > li:nth-child(1)  text: "first" -> "first item"');
});

test("mutations from the model's code do not reach the diff", async () => {
  const { img } = makeImage('<div id="out"></div>');
  await img.exec('document.querySelector("#out").setAttribute("class", "model")');
  await tick();
  assert.equal(img.buildDiff(), '');
});

test('live typing into a field lands in the diff', async () => {
  const { doc, img, dom } = makeImage('<textarea id="q"></textarea>');
  const q = doc.querySelector('#q');
  focusIn(dom, q);
  q.value = 'work out the margin';
  q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await tick();
  assert.equal(img.buildDiff(), '#q  "" -> "work out the margin"');
});

test('after a build the buffers are empty and a repeat diff is empty', async () => {
  const { doc, img } = makeImage('<div id="out" class="v1"></div>');
  doc.querySelector('#out').setAttribute('class', 'v2');
  await tick();
  img.buildDiff();
  assert.equal(img.buildDiff(), '');
});

// --- Beyond the plan (first review round) ---

test('two text children of one parent yield two lines, not one', async () => {
  const { doc, img } = makeImage('<p id="p">first<span>x</span>second</p>');
  const p = doc.querySelector('#p');
  p.firstChild.data = 'edited-first';
  p.lastChild.data = 'edited-second';
  await tick();
  const lines = img.buildDiff().split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines.some(l => l.includes('"first" -> "edited-first"')));
  assert.ok(lines.some(l => l.includes('"second" -> "edited-second"')));
});

test('moving a node yields an addition but no removal', async () => {
  const { doc, img } = makeImage('<ul id="a"><li id="row">a row</li></ul><ul id="b"></ul>');
  const row = doc.querySelector('#row');
  doc.querySelector('#b').append(row);
  await tick();
  const diff = img.buildDiff();
  assert.ok(!diff.includes('removed'), 'there must be no removal line: ' + diff);
  assert.equal(diff, 'added to #b: <li id="row">a row</li>');
});

test("a human edit interleaved with the model's: only human nodes in the diff", async () => {
  const { doc, img } = makeImage('<div id="a"></div><div id="b"></div><div id="c"></div>');
  doc.querySelector('#a').setAttribute('data-x', '1');
  await tick();
  await img.exec('document.querySelector("#b").setAttribute("data-x", "model")');
  await tick();
  doc.querySelector('#c').setAttribute('data-x', '2');
  await tick();
  const lines = img.buildDiff().split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines.some(l => l.startsWith('#a')));
  assert.ok(lines.some(l => l.startsWith('#c')));
  assert.ok(!lines.some(l => l.startsWith('#b')));
});

test('adding and removing an attribute yield readable unquoted nulls', async () => {
  const { doc, img } = makeImage('<div id="out" class="v1"></div>');
  const el = doc.querySelector('#out');
  el.setAttribute('data-new', 'a value');
  el.removeAttribute('class');
  await tick();
  const lines = img.buildDiff().split('\n').sort();
  assert.deepEqual(lines, [
    '#out  @class: "v1" -> null',
    '#out  @data-new: null -> "a value"',
  ]);
});

test('focus without a change of value yields no line', async () => {
  const { doc, img, dom } = makeImage('<textarea id="q"></textarea>');
  const q = doc.querySelector('#q');
  focusIn(dom, q);
  await tick();
  assert.equal(img.buildDiff(), '');
});

test('a field restored to its original value yields no line', async () => {
  const { doc, img, dom } = makeImage('<textarea id="q">original</textarea>');
  const q = doc.querySelector('#q');
  q.value = 'original';
  focusIn(dom, q);
  q.value = 'changed';
  q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  q.value = 'original';
  q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await tick();
  assert.equal(img.buildDiff(), '');
});

test("a field edited by the model's code stays out of the diff, even if the human focused it earlier", async () => {
  const { doc, img, dom } = makeImage('<textarea id="q"></textarea>');
  const q = doc.querySelector('#q');
  focusIn(dom, q);
  await tick();
  await img.exec('document.querySelector("#q").value = "from the model"');
  await tick();
  assert.equal(img.buildDiff(), '');
});

// M11: this used to compare two runs against each other (which passes under any
// ordering, including a wrong one) — replaced with an exact expectation of every
// line.
test('line order is stable: field, attribute, removal — in a fixed order', async () => {
  const { doc, img, dom } = makeImage(
    '<textarea id="q"></textarea><div id="out" class="v1"></div><ul id="items"><li id="row">a row</li></ul>'
  );
  const q = doc.querySelector('#q');
  focusIn(dom, q);
  q.value = 'input';
  q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  doc.querySelector('#out').setAttribute('class', 'v2');
  doc.querySelector('#row').remove();
  await tick();
  assert.equal(
    img.buildDiff(),
    '#q  "" -> "input"\n' +
    '#out  @class: "v1" -> "v2"\n' +
    'removed from #items: <li id="row">a row</li>'
  );
});

// M11: the handle({type:'diff'}) path was not covered (there is an equivalent
// test for exec).
test('handle answers diff with a diff message carrying the text and the same id', async () => {
  const { doc, img, sent } = makeImage('<div id="out" class="v1"></div>');
  doc.querySelector('#out').setAttribute('class', 'v2');
  await tick();
  await img.handle({ type: 'diff', id: 3 });
  assert.deepEqual(sent.at(-1), { type: 'diff', id: 3, text: '#out  @class: "v1" -> "v2"' });
});

// --- Second review round: C1–C4, I5–I7, M8–M11 ---

test('C1: the human edits another node during an await inside exec — it lands in the diff; the model edit does not', async () => {
  const { doc, img } = makeImage('<div id="a"></div><div id="b" class="v1"></div>', 50);
  const p = img.exec(
    'document.querySelector("#a").setAttribute("data-m", "1");' +
    'await new Promise(r => setTimeout(r, 30));'
  );
  await tick(); // let the model touch #a synchronously and go into the await
  doc.querySelector('#b').setAttribute('class', 'v2'); // the "human" edits another node while exec is still in flight
  await p;
  await tick();
  const diff = img.buildDiff();
  assert.ok(diff.includes('#b'), 'expected the human edit on #b: ' + diff);
  assert.ok(!diff.includes('data-m'), 'the model edit must not reach the diff: ' + diff);
});

test('C1: the human edits another node in the grace tail after exec — it lands in the diff; the model edit does not', async () => {
  const { doc, img } = makeImage('<div id="a"></div><div id="b" class="v1"></div>', 50);
  await img.exec('document.querySelector("#a").setAttribute("data-m", "1")');
  await tick(); // let the observer deliver the model's record while execDepth is still > 0
  doc.querySelector('#b').setAttribute('class', 'v2'); // the human edits inside the grace window
  await wait(60); // wait out the grace (50ms)
  const diff = img.buildDiff();
  assert.ok(diff.includes('#b'), 'expected the human edit on #b: ' + diff);
  assert.ok(!diff.includes('data-m'), 'the model edit must not reach the diff: ' + diff);
});

test("C2: the human edits an attribute, then the model does — the diff shows the human's value, not the model's", async () => {
  const { doc, img } = makeImage('<div id="out" class="v1"></div>');
  doc.querySelector('#out').setAttribute('class', 'human');
  await tick();
  await img.exec('document.querySelector("#out").setAttribute("class", "model")');
  await tick();
  assert.equal(img.buildDiff(), '#out  @class: "v1" -> "human"');
});

test('C2: the same for a text node', async () => {
  const { doc, img } = makeImage('<p id="p">original</p>');
  doc.querySelector('#p').firstChild.data = 'human';
  await tick();
  await img.exec('document.querySelector("#p").firstChild.data = "model"');
  await tick();
  assert.equal(img.buildDiff(), '#p  text: "original" -> "human"');
});

test('C2: the reverse order (model first, then human) keeps working correctly', async () => {
  const { doc, img } = makeImage('<div id="out" class="v1"></div>');
  await img.exec('document.querySelector("#out").setAttribute("class", "model")');
  await tick();
  doc.querySelector('#out').setAttribute('class', 'human');
  await tick();
  assert.equal(img.buildDiff(), '#out  @class: "model" -> "human"');
});

test('C3: a checkbox — ticked and unticked', async () => {
  const { doc, img, dom } = makeImage('<input id="c" type="checkbox">');
  const c = doc.querySelector('#c');
  focusIn(dom, c);
  c.checked = true;
  c.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await tick();
  assert.equal(img.buildDiff(), '#c  "false" -> "true"');

  c.checked = false;
  c.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await tick();
  assert.equal(img.buildDiff(), '#c  "true" -> "false"');
});

test('C3: a multiple select — two options picked', async () => {
  const { doc, img, dom } = makeImage(
    '<select id="s" multiple><option value="a">a</option><option value="b">b</option><option value="c">c</option></select>'
  );
  const s = doc.querySelector('#s');
  focusIn(dom, s);
  s.options[0].selected = true;
  s.options[2].selected = true;
  s.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await tick();
  assert.equal(img.buildDiff(), '#s  [] -> ["a","c"]');
});

test('C4: three turns in a row on one field without a repeat focus — correct "was"/"now" every time', async () => {
  const { doc, img, dom } = makeImage('<textarea id="q"></textarea>');
  const q = doc.querySelector('#q');
  focusIn(dom, q);

  q.value = 'hello';
  q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await tick();
  assert.equal(img.buildDiff(), '#q  "" -> "hello"');

  q.value = 'hello world';
  q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await tick();
  assert.equal(img.buildDiff(), '#q  "hello" -> "hello world"');

  q.value = '';
  q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await tick();
  assert.equal(img.buildDiff(), '#q  "hello world" -> ""');
});

test('I5: a node moved twice yields one line with the final parent', async () => {
  const { doc, img } = makeImage('<ul id="a"><li id="row">a row</li></ul><ul id="b"></ul>');
  const row = doc.querySelector('#row');
  doc.querySelector('#b').append(row);
  doc.querySelector('#a').append(row);
  await tick();
  assert.equal(img.buildDiff(), 'added to #a: <li id="row">a row</li>');
});

test('I6: contenteditable yields only the text line, with no field line', async () => {
  const { doc, img, dom } = makeImage('<div id="editor" contenteditable="true">original</div>');
  const editor = doc.querySelector('#editor');
  focusIn(dom, editor);
  editor.firstChild.data = 'changed';
  editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await tick();
  assert.equal(img.buildDiff(), '#editor  text: "original" -> "changed"');
});

test('I7: removing a multi-line element yields exactly one line', async () => {
  const { doc, img } = makeImage('<ul id="items"><li id="row">\n  a row with   indentation\n</li></ul>');
  doc.querySelector('#row').remove();
  await tick();
  assert.equal(img.buildDiff(), 'removed from #items: <li id="row"> a row with   indentation </li>');
});

test('M8: a field removed from the DOM — the path is flagged, the value is not lost', async () => {
  const { doc, img, dom } = makeImage('<div id="wrap"><textarea id="q"></textarea></div>');
  const q = doc.querySelector('#q');
  focusIn(dom, q);
  q.value = 'typed in';
  q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  q.remove();
  await tick();
  assert.equal(
    img.buildDiff(),
    'textarea (detached)  "" -> "typed in"\n' +
    'removed from #wrap: <textarea id="q"></textarea>'
  );
});

test('M9: a duplicated id — the path leads unambiguously to its own node', () => {
  const { doc, img } = makeImage('<ul id="list"><li id="dup"></li><li id="dup"></li></ul>');
  const [first, second] = doc.querySelectorAll('#dup');
  assert.equal(doc.querySelector(img.path(first)), first);
  assert.equal(doc.querySelector(img.path(second)), second);
});

test('M9: an id with a space — the path is syntactically valid and leads to its own node', () => {
  const { doc, img } = makeImage('<div id="my row"></div>');
  const el = doc.querySelector('[id="my row"]');
  let resolved;
  assert.doesNotThrow(() => { resolved = doc.querySelector(img.path(el)); });
  assert.equal(resolved, el);
});

test('M10: a freshly added node with an attribute and text yields a single line', async () => {
  const { doc, img } = makeImage('<ul id="items"></ul>');
  const li = doc.createElement('li');
  doc.querySelector('#items').append(li);
  li.setAttribute('class', 'x');
  li.textContent = 'new';
  await tick();
  assert.equal(img.buildDiff(), 'added to #items: <li class="x">new</li>');
});

test('an added whitespace-only text node does not reach the diff', async () => {
  const { doc, img } = makeImage('<div id="out"></div>');
  doc.querySelector('#out').append(doc.createTextNode('\n   '));
  await tick();
  assert.equal(img.buildDiff(), '');
});

test('a removed whitespace-only text node does not reach the diff', async () => {
  const { doc, img } = makeImage('<div id="out">\n  <span>x</span>\n</div>');
  const out = doc.querySelector('#out');
  const blank = [...out.childNodes].find(n => n.nodeType === 3 && !n.data.trim());
  blank.remove();
  await tick();
  assert.equal(img.buildDiff(), '');
});

test('meaningful text next to whitespace is still visible', async () => {
  const { doc, img } = makeImage('<div id="out"></div>');
  const out = doc.querySelector('#out');
  out.append(doc.createTextNode('\n  '));
  out.append(doc.createTextNode('important'));
  await tick();
  const d = img.buildDiff();
  assert.equal(d.split('\n').length, 1, 'one line must remain: ' + d);
  assert.ok(d.includes('important'));
});

test('whitespace edited into whitespace does not reach the diff, whitespace into text does', async () => {
  const { doc, img } = makeImage('<div id="out">\n  <span>x</span></div>');
  const blank = [...doc.querySelector('#out').childNodes].find(n => n.nodeType === 3);
  blank.data = '\n      ';
  await tick();
  assert.equal(img.buildDiff(), '', 'whitespace into whitespace is formatting');

  blank.data = 'now some text';
  await tick();
  assert.ok(img.buildDiff().includes('now some text'), 'whitespace into text is an edit');
});

test('a whitespace node inside an added subtree yields no extra lines', async () => {
  const { doc, img } = makeImage('<ul id="items"></ul>');
  const li = doc.createElement('li');
  li.append(doc.createTextNode('\n  '));
  li.append(doc.createTextNode('item'));
  doc.querySelector('#items').append(li);
  await tick();
  const d = img.buildDiff();
  assert.equal(d.split('\n').length, 1, 'one addition, not three: ' + d);
  assert.ok(d.startsWith('added to #items'));
});

test('clearInput empties the field after the diff is built', async () => {
  const { doc, img, dom } = makeImage('<input id="q" type="text">');
  const q = doc.querySelector('#q');
  q.dispatchEvent(new dom.window.Event('focusin', { bubbles: true }));
  q.value = 'being sent';
  q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await tick();

  await img.handle({ type: 'diff', id: 1, clearInput: true });
  assert.equal(q.value, '', 'the field must end up empty');
});

test('the clearing does not reach the next diff', async () => {
  const { doc, img, dom } = makeImage('<input id="q" type="text">');
  const q = doc.querySelector('#q');
  q.dispatchEvent(new dom.window.Event('focusin', { bubbles: true }));
  q.value = 'first';
  q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await tick();
  await img.handle({ type: 'diff', id: 1, clearInput: true });
  await tick();
  assert.equal(img.buildDiff(), '', 'a programmatic clear is not a human edit');
});

test('after clearing the baseline is empty: the next input is compared against emptiness', async () => {
  const { doc, img, dom } = makeImage('<input id="q" type="text">');
  const q = doc.querySelector('#q');
  q.dispatchEvent(new dom.window.Event('focusin', { bubbles: true }));
  q.value = 'first';
  q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await tick();
  await img.handle({ type: 'diff', id: 1, clearInput: true });

  // focus never left the field, so no repeat focusin is coming
  q.value = 'second';
  q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await tick();
  assert.equal(img.buildDiff(), '#q  "" -> "second"',
    'the "was" must be empty, not "first"');
});

test('without clearInput the field is left alone', async () => {
  const { doc, img, dom } = makeImage('<input id="q" type="text">');
  const q = doc.querySelector('#q');
  q.dispatchEvent(new dom.window.Event('focusin', { bubbles: true }));
  q.value = 'stays';
  q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await tick();
  await img.handle({ type: 'diff', id: 1 });
  assert.equal(q.value, 'stays');
});

test('clearInput with no #q field does not crash the image', async () => {
  const { img } = makeImage('<div id="out"></div>');
  await img.handle({ type: 'diff', id: 1, clearInput: true });
  assert.ok(true);
});

test('the diff is built before the clearing, and the sent text is in it', async () => {
  const { doc, img, dom, sent } = makeImage('<input id="q" type="text">');
  const q = doc.querySelector('#q');
  q.dispatchEvent(new dom.window.Event('focusin', { bubbles: true }));
  q.value = 'an important request';
  q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await tick();
  await img.handle({ type: 'diff', id: 7, clearInput: true });
  const msg = sent.find(m => m.type === 'diff' && m.id === 7);
  assert.ok(msg.text.includes('an important request'), 'the diff must not lose the text: ' + msg.text);
});
