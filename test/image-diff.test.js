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

// M11: хелпер рядом с makeImage вместо семи повторов dispatchEvent(focusin).
function focusIn(dom, el) {
  el.dispatchEvent(new dom.window.Event('focusin', { bubbles: true }));
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
  focusIn(dom, q);
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

// --- Дополнительно к плану (первый круг ревью) ---

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
  focusIn(dom, q);
  await tick();
  assert.equal(img.buildDiff(), '');
});

test('поле, возвращённое к исходному значению, не даёт строки', async () => {
  const { doc, img, dom } = makeImage('<textarea id="q">исходно</textarea>');
  const q = doc.querySelector('#q');
  q.value = 'исходно';
  focusIn(dom, q);
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
  focusIn(dom, q);
  await tick();
  await img.exec('document.querySelector("#q").value = "от модели"');
  await tick();
  assert.equal(img.buildDiff(), '');
});

// M11: было сравнение двух прогонов между собой (проходит при любом порядке,
// включая неверный) — заменено на точное ожидание всех строк.
test('порядок строк устойчив: поле, атрибут, удаление — в фиксированном порядке', async () => {
  const { doc, img, dom } = makeImage(
    '<textarea id="q"></textarea><div id="out" class="v1"></div><ul id="items"><li id="row">строка</li></ul>'
  );
  const q = doc.querySelector('#q');
  focusIn(dom, q);
  q.value = 'ввод';
  q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  doc.querySelector('#out').setAttribute('class', 'v2');
  doc.querySelector('#row').remove();
  await tick();
  assert.equal(
    img.buildDiff(),
    '#q  "" -> "ввод"\n' +
    '#out  @class: "v1" -> "v2"\n' +
    'удалён из #items: <li id="row">строка</li>'
  );
});

// M11: путь handle({type:'diff'}) не был покрыт (для exec аналогичный тест есть).
test('handle отвечает на diff сообщением diff с текстом и тем же id', async () => {
  const { doc, img, sent } = makeImage('<div id="out" class="v1"></div>');
  doc.querySelector('#out').setAttribute('class', 'v2');
  await tick();
  await img.handle({ type: 'diff', id: 3 });
  assert.deepEqual(sent.at(-1), { type: 'diff', id: 3, text: '#out  @class: "v1" -> "v2"' });
});

// --- Второй круг ревью: C1–C4, I5–I7, M8–M11 ---

test('C1: человек правит другой узел во время await внутри exec — попадает в диф; правка модели — нет', async () => {
  const { doc, img } = makeImage('<div id="a"></div><div id="b" class="v1"></div>', 50);
  const p = img.exec(
    'document.querySelector("#a").setAttribute("data-m", "1");' +
    'await new Promise(r => setTimeout(r, 30));'
  );
  await tick(); // дать модели синхронно тронуть #a и уйти в await
  doc.querySelector('#b').setAttribute('class', 'v2'); // "человек" правит другой узел, пока exec ещё висит
  await p;
  await tick();
  const diff = img.buildDiff();
  assert.ok(diff.includes('#b'), 'ожидали правку человека по #b: ' + diff);
  assert.ok(!diff.includes('data-m'), 'правка модели не должна попасть в диф: ' + diff);
});

test('C1: человек правит другой узел в grace-хвосте после exec — попадает в диф; правка модели — нет', async () => {
  const { doc, img } = makeImage('<div id="a"></div><div id="b" class="v1"></div>', 50);
  await img.exec('document.querySelector("#a").setAttribute("data-m", "1")');
  await tick(); // дать наблюдателю доставить запись модели, пока execDepth ещё > 0
  doc.querySelector('#b').setAttribute('class', 'v2'); // человек правит в grace-окне
  await wait(60); // дождаться конца grace (50мс)
  const diff = img.buildDiff();
  assert.ok(diff.includes('#b'), 'ожидали правку человека по #b: ' + diff);
  assert.ok(!diff.includes('data-m'), 'правка модели не должна попасть в диф: ' + diff);
});

test('C2: человек правит атрибут, затем модель — в дифе значение человека, а не модели', async () => {
  const { doc, img } = makeImage('<div id="out" class="v1"></div>');
  doc.querySelector('#out').setAttribute('class', 'человек');
  await tick();
  await img.exec('document.querySelector("#out").setAttribute("class", "модель")');
  await tick();
  assert.equal(img.buildDiff(), '#out  @class: "v1" -> "человек"');
});

test('C2: то же для текстового узла', async () => {
  const { doc, img } = makeImage('<p id="p">исходно</p>');
  doc.querySelector('#p').firstChild.data = 'человек';
  await tick();
  await img.exec('document.querySelector("#p").firstChild.data = "модель"');
  await tick();
  assert.equal(img.buildDiff(), '#p  текст: "исходно" -> "человек"');
});

test('C2: обратный порядок (сначала модель, потом человек) продолжает работать верно', async () => {
  const { doc, img } = makeImage('<div id="out" class="v1"></div>');
  await img.exec('document.querySelector("#out").setAttribute("class", "модель")');
  await tick();
  doc.querySelector('#out').setAttribute('class', 'человек');
  await tick();
  assert.equal(img.buildDiff(), '#out  @class: "модель" -> "человек"');
});

test('C3: чекбокс — поставили и сняли галочку', async () => {
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

test('C3: select multiple — выбраны два варианта', async () => {
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

test('C4: три хода подряд по одному полю без повторного фокуса — каждый раз верные "было"/"стало"', async () => {
  const { doc, img, dom } = makeImage('<textarea id="q"></textarea>');
  const q = doc.querySelector('#q');
  focusIn(dom, q);

  q.value = 'привет';
  q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await tick();
  assert.equal(img.buildDiff(), '#q  "" -> "привет"');

  q.value = 'привет мир';
  q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await tick();
  assert.equal(img.buildDiff(), '#q  "привет" -> "привет мир"');

  q.value = '';
  q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await tick();
  assert.equal(img.buildDiff(), '#q  "привет мир" -> ""');
});

test('I5: узел, переставленный дважды, даёт одну строку с конечным родителем', async () => {
  const { doc, img } = makeImage('<ul id="a"><li id="row">строка</li></ul><ul id="b"></ul>');
  const row = doc.querySelector('#row');
  doc.querySelector('#b').append(row);
  doc.querySelector('#a').append(row);
  await tick();
  assert.equal(img.buildDiff(), 'добавлен в #a: <li id="row">строка</li>');
});

test('I6: contenteditable даёт только строку про текст, без строки про поле', async () => {
  const { doc, img, dom } = makeImage('<div id="editor" contenteditable="true">исходно</div>');
  const editor = doc.querySelector('#editor');
  focusIn(dom, editor);
  editor.firstChild.data = 'изменено';
  editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await tick();
  assert.equal(img.buildDiff(), '#editor  текст: "исходно" -> "изменено"');
});

test('I7: удаление многострочного элемента даёт ровно одну строку', async () => {
  const { doc, img } = makeImage('<ul id="items"><li id="row">\n  строка с   отступами\n</li></ul>');
  doc.querySelector('#row').remove();
  await tick();
  assert.equal(img.buildDiff(), 'удалён из #items: <li id="row"> строка с   отступами </li>');
});

test('M8: поле удалено из DOM — путь помечен, значение не потеряно', async () => {
  const { doc, img, dom } = makeImage('<div id="wrap"><textarea id="q"></textarea></div>');
  const q = doc.querySelector('#q');
  focusIn(dom, q);
  q.value = 'набрано';
  q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  q.remove();
  await tick();
  assert.equal(
    img.buildDiff(),
    'textarea (удалён)  "" -> "набрано"\n' +
    'удалён из #wrap: <textarea id="q"></textarea>'
  );
});

test('M9: дублирующийся id — путь однозначно ведёт к своему узлу', () => {
  const { doc, img } = makeImage('<ul id="list"><li id="dup"></li><li id="dup"></li></ul>');
  const [first, second] = doc.querySelectorAll('#dup');
  assert.equal(doc.querySelector(img.path(first)), first);
  assert.equal(doc.querySelector(img.path(second)), second);
});

test('M9: id с пробелом — путь синтаксически валиден и ведёт к своему узлу', () => {
  const { doc, img } = makeImage('<div id="моя строка"></div>');
  const el = doc.querySelector('[id="моя строка"]');
  let resolved;
  assert.doesNotThrow(() => { resolved = doc.querySelector(img.path(el)); });
  assert.equal(resolved, el);
});

test('M10: только что добавленный узел с атрибутом и текстом даёт одну строку', async () => {
  const { doc, img } = makeImage('<ul id="items"></ul>');
  const li = doc.createElement('li');
  doc.querySelector('#items').append(li);
  li.setAttribute('class', 'x');
  li.textContent = 'новый';
  await tick();
  assert.equal(img.buildDiff(), 'добавлен в #items: <li class="x">новый</li>');
});
