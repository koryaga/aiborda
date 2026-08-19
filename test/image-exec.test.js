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

test('exec возвращает значение', async () => {
  const { img } = makeImage();
  const r = await img.exec('return 1 + 1');
  assert.equal(r.ok, true);
  assert.equal(r.value, '2');
});

test('exec меняет DOM', async () => {
  const { img, doc } = makeImage();
  await img.exec('document.querySelector("#out").textContent = "готово"');
  assert.equal(doc.querySelector('#out').textContent, 'готово');
});

test('exec возвращает ошибку, а не бросает', async () => {
  const { img } = makeImage();
  const r = await img.exec('нетТакогоОбъекта.поле');
  assert.equal(r.ok, false);
  assert.ok(r.error.length > 0);
});

test('exec без return не даёт значения', async () => {
  const { img } = makeImage();
  const r = await img.exec('const x = 1;');
  assert.equal(r.ok, true);
  assert.equal(r.value, undefined);
});

test('значение усекается до 10000 символов', async () => {
  const { img } = makeImage();
  const r = await img.exec('return "я".repeat(20000)');
  assert.equal(r.value.length, 10000);
});

test('snapshot переносит живое значение поля в разметку', async () => {
  const { img, doc } = makeImage();
  doc.querySelector('#q').value = 'набрано';
  assert.ok(img.snapshot().includes('набрано'));
});

test('snapshot не мутирует живой DOM', async () => {
  const { img, doc } = makeImage();
  const q = doc.querySelector('#q');
  q.value = 'набрано';
  img.snapshot();
  assert.equal(q.getAttribute('value'), null);
});

test('handle отвечает на exec сообщением result с тем же id', async () => {
  const { img, sent } = makeImage();
  await img.handle({ type: 'exec', id: 7, code: 'return 5' });
  assert.deepEqual(sent.at(-1), { type: 'result', id: 7, ok: true, value: '5', error: undefined });
});

// --- Дополнительно к плану ---

test('exec работает с асинхронным кодом модели (await внутри)', async () => {
  const { img } = makeImage();
  const r = await img.exec('await new Promise(r => setTimeout(r, 1)); return "готово"');
  assert.equal(r.ok, true);
  assert.equal(r.value, 'готово');
});

test('exec сериализует объект в разбираемый JSON, а не [object Object]', async () => {
  const { img } = makeImage();
  const r = await img.exec('return ({а: 1})');
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(r.value), { а: 1 });
});

test('exec не роняется на циклической ссылке', async () => {
  const { img } = makeImage();
  const r = await img.exec('const o = {}; o.o = o; return o');
  assert.equal(r.ok, true);
  assert.ok(typeof r.value === 'string' && r.value.length > 0);
});

test('handle игнорирует мусор и ничего не отправляет', async () => {
  const { img, sent } = makeImage();
  await img.handle(null);
  await img.handle({});
  await img.handle({ type: 'неизвестно' });
  assert.deepEqual(sent, []);
});

test('snapshot переносит checked у флажка и selected у опции', async () => {
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

test('ошибка исполнения не роняет execDepth — следующий exec работает нормально', async () => {
  const { img } = makeImage();
  const bad = await img.exec('нетТакогоОбъекта.поле');
  assert.equal(bad.ok, false);
  const good = await img.exec('return 42');
  assert.equal(good.ok, true);
  assert.equal(good.value, '42');
});
