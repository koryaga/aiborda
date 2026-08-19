import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const src = await readFile(new URL('../web/image-boot.js', import.meta.url), 'utf8');
const createImage = new Function(src + '\nreturn createImage;')();
const tick = () => new Promise(r => setTimeout(r, 0));

function makeImage(html) {
  const dom = new JSDOM(`<body>${html}</body>`, { runScripts: 'outside-only' });
  const sent = [];
  const img = createImage(dom.window.document, m => sent.push(m), { trusted: () => true, grace: 0 });
  img.install();
  return { dom, doc: dom.window.document, img, sent };
}

test('правка атрибута попадает в диф', async () => {
  const { doc, img } = makeImage('<div id="out" class="v1"></div>');
  doc.querySelector('#out').setAttribute('class', 'v2');
  await tick();
  assert.equal(img.buildDiff(), '#out  @class: "v1" -> "v2"');
});

test('две правки одного атрибута дают одну строку со старым от первой', async () => {
  const { doc, img } = makeImage('<div id="out" class="v1"></div>');
  const el = doc.querySelector('#out');
  el.setAttribute('class', 'v2');
  await tick();
  el.setAttribute('class', 'v3');
  await tick();
  assert.equal(img.buildDiff(), '#out  @class: "v1" -> "v3"');
});

test('правка, вернувшая прежнее значение, в диф не идёт', async () => {
  const { doc, img } = makeImage('<div id="out" class="v1"></div>');
  const el = doc.querySelector('#out');
  el.setAttribute('class', 'v2');
  await tick();
  el.setAttribute('class', 'v1');
  await tick();
  assert.equal(img.buildDiff(), '');
});

test('удаление узла попадает в диф вместе с его HTML и родителем', async () => {
  const { doc, img } = makeImage('<ul id="items"><li id="row-2">второй</li></ul>');
  doc.querySelector('#row-2').remove();
  await tick();
  assert.equal(img.buildDiff(), 'удалён из #items: <li id="row-2">второй</li>');
});

test('добавление узла попадает в диф', async () => {
  const { doc, img } = makeImage('<ul id="items"></ul>');
  const li = doc.createElement('li');
  li.id = 'row-3';
  li.textContent = 'третий';
  doc.querySelector('#items').append(li);
  await tick();
  assert.equal(img.buildDiff(), 'добавлен в #items: <li id="row-3">третий</li>');
});

test('узел, добавленный и сразу удалённый, в дифе не появляется', async () => {
  const { doc, img } = makeImage('<ul id="items"></ul>');
  const li = doc.createElement('li');
  doc.querySelector('#items').append(li);
  await tick();
  li.remove();
  await tick();
  assert.equal(img.buildDiff(), '');
});

test('правка текста попадает в диф с путём через nth-child', async () => {
  const { doc, img } = makeImage('<ul id="items"><li>первый</li></ul>');
  doc.querySelector('#items li').firstChild.data = 'первый пункт';
  await tick();
  assert.equal(img.buildDiff(), '#items > li:nth-child(1)  текст: "первый" -> "первый пункт"');
});

test('мутации кода модели в диф не попадают', async () => {
  const { img } = makeImage('<div id="out"></div>');
  await img.exec('document.querySelector("#out").setAttribute("class", "модель")');
  await tick();
  assert.equal(img.buildDiff(), '');
});

test('живой ввод в поле попадает в диф', async () => {
  const { doc, img, dom } = makeImage('<textarea id="q"></textarea>');
  const q = doc.querySelector('#q');
  q.dispatchEvent(new dom.window.Event('focusin', { bubbles: true }));
  q.value = 'посчитай маржу';
  q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await tick();
  assert.equal(img.buildDiff(), '#q  "" -> "посчитай маржу"');
});

test('после сборки буферы пусты и повторный диф пуст', async () => {
  const { doc, img } = makeImage('<div id="out" class="v1"></div>');
  doc.querySelector('#out').setAttribute('class', 'v2');
  await tick();
  img.buildDiff();
  assert.equal(img.buildDiff(), '');
});

// --- Дополнительно к плану ---

test('два текстовых потомка одного родителя дают две строки, а не одну', async () => {
  const { doc, img } = makeImage('<p id="p">первый<span>x</span>второй</p>');
  const p = doc.querySelector('#p');
  p.firstChild.data = 'изменён-первый';
  p.lastChild.data = 'изменён-второй';
  await tick();
  const lines = img.buildDiff().split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines.some(l => l.includes('"первый" -> "изменён-первый"')));
  assert.ok(lines.some(l => l.includes('"второй" -> "изменён-второй"')));
});

test('перемещение узла даёт добавление, но не удаление', async () => {
  const { doc, img } = makeImage('<ul id="a"><li id="row">строка</li></ul><ul id="b"></ul>');
  const row = doc.querySelector('#row');
  doc.querySelector('#b').append(row);
  await tick();
  const diff = img.buildDiff();
  assert.ok(!diff.includes('удалён'), 'не должно быть строки про удаление: ' + diff);
  assert.equal(diff, 'добавлен в #b: <li id="row">строка</li>');
});

test('правка человека вперемешку с правкой модели: в дифе только человеческие узлы', async () => {
  const { doc, img } = makeImage('<div id="a"></div><div id="b"></div><div id="c"></div>');
  doc.querySelector('#a').setAttribute('data-x', '1');
  await tick();
  await img.exec('document.querySelector("#b").setAttribute("data-x", "модель")');
  await tick();
  doc.querySelector('#c').setAttribute('data-x', '2');
  await tick();
  const lines = img.buildDiff().split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines.some(l => l.startsWith('#a')));
  assert.ok(lines.some(l => l.startsWith('#c')));
  assert.ok(!lines.some(l => l.startsWith('#b')));
});

test('добавление и удаление атрибута дают читаемые null без кавычек', async () => {
  const { doc, img } = makeImage('<div id="out" class="v1"></div>');
  const el = doc.querySelector('#out');
  el.setAttribute('data-new', 'значение');
  el.removeAttribute('class');
  await tick();
  const lines = img.buildDiff().split('\n').sort();
  assert.deepEqual(lines, [
    '#out  @class: "v1" -> null',
    '#out  @data-new: null -> "значение"',
  ]);
});

test('фокус без изменения значения не даёт строки', async () => {
  const { doc, img, dom } = makeImage('<textarea id="q"></textarea>');
  const q = doc.querySelector('#q');
  q.dispatchEvent(new dom.window.Event('focusin', { bubbles: true }));
  await tick();
  assert.equal(img.buildDiff(), '');
});

test('поле, возвращённое к исходному значению, не даёт строки', async () => {
  const { doc, img, dom } = makeImage('<textarea id="q">исходно</textarea>');
  const q = doc.querySelector('#q');
  q.value = 'исходно';
  q.dispatchEvent(new dom.window.Event('focusin', { bubbles: true }));
  q.value = 'изменено';
  q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  q.value = 'исходно';
  q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await tick();
  assert.equal(img.buildDiff(), '');
});

test('правка поля кодом модели не попадает в диф, даже если человек ранее фокусировался в нём', async () => {
  const { doc, img, dom } = makeImage('<textarea id="q"></textarea>');
  const q = doc.querySelector('#q');
  q.dispatchEvent(new dom.window.Event('focusin', { bubbles: true }));
  await tick();
  await img.exec('document.querySelector("#q").value = "от модели"');
  await tick();
  assert.equal(img.buildDiff(), '');
});

test('порядок строк устойчив при повторных прогонах: поле, атрибут, удаление', async () => {
  const build = async () => {
    const { doc, img, dom } = makeImage('<textarea id="q"></textarea><div id="out" class="v1"></div><ul id="items"><li id="row">строка</li></ul>');
    const q = doc.querySelector('#q');
    q.dispatchEvent(new dom.window.Event('focusin', { bubbles: true }));
    q.value = 'ввод';
    q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    doc.querySelector('#out').setAttribute('class', 'v2');
    doc.querySelector('#row').remove();
    await tick();
    return img.buildDiff();
  };
  const first = await build();
  const second = await build();
  assert.equal(first, second);
});
