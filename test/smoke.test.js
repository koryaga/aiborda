import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

test('jsdom умеет MutationObserver с oldValue', async () => {
  const dom = new JSDOM('<div id="a" class="v1"></div>');
  const doc = dom.window.document;
  const seen = [];
  const obs = new dom.window.MutationObserver(rs => { for (const r of rs) seen.push(r.oldValue); });
  obs.observe(doc.documentElement, { subtree: true, attributes: true, attributeOldValue: true });
  doc.querySelector('#a').setAttribute('class', 'v2');
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(seen, ['v1']);
});
