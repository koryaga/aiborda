import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPageTool,
  createResourceLoader,
  frameTurn,
  nudgeMessage,
  strayText,
  SYSTEM_PROMPT,
} from '../server/agent.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

function assistant(content, stopReason = 'stop') {
  return { role: 'assistant', content, stopReason };
}

test('the tool is declared the way pi expects', () => {
  const t = createPageTool(async () => ({ ok: true, value: 'x' }));
  for (const k of ['name', 'label', 'description', 'parameters', 'execute']) {
    assert.ok(k in t, `field ${k} is missing`);
  }
  assert.equal(t.name, 'page_exec');
  assert.equal(t.executionMode, 'sequential');
  assert.equal(typeof t.execute, 'function');
});

test('the description explains that this is the only access to the page', () => {
  const t = createPageTool(async () => ({ ok: true }));
  assert.match(t.description, /page/i);
});

// --- The contract: system prompt, turn framing, the nudge ---

test('the system prompt says the human sees only the page and names the log word', () => {
  assert.match(SYSTEM_PROMPT, /The human sees only the page/);
  assert.match(SYSTEM_PROMPT, /`done`/);
  assert.ok(SYSTEM_PROMPT.includes('localStorage'), 'the model must know about persistent storage');
  assert.ok(!/expert coding assistant/i.test(SYSTEM_PROMPT));
});

test('the diff format the prompt documents is the one the real page produces', async () => {
  // The prompt shows the model what a diff looks like; if image-boot.js changes
  // its paths and the prompt does not, the model is taught one shape and sent
  // another. Built on the real scaffold, the same way the browser loads it.
  const { JSDOM } = await import('jsdom');
  const html = await readFile(new URL('../web/image.html', import.meta.url), 'utf8');
  const boot = await readFile(new URL('../web/image-boot.js', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const doc = dom.window.document;
  const img = new Function(boot + '\nreturn createImage;')()(doc, () => {}, { trusted: () => true });
  img.install();
  const q = doc.querySelector('#q');
  q.dispatchEvent(new dom.window.Event('focusin', { bubbles: true }));
  q.value = 'what is 17 × 23?';
  q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const line = img.buildDiff();
  assert.equal(line, 'html > body > input#q  "" -> "what is 17 × 23?"');
  assert.ok(SYSTEM_PROMPT.includes(line), 'the prompt must show the line the page really sends');
  assert.match(SYSTEM_PROMPT, /about: html > body > /);
});

test('the system prompt makes editability a rule, not a default', () => {
  assert.match(SYSTEM_PROMPT, /\*\*Everything you put on the page is editable\.\*\*/);
  assert.match(SYSTEM_PROMPT, /This is a rule, not a default you may skip/);
  assert.match(SYSTEM_PROMPT, /could they edit every piece of\s+text in it in place/);
  assert.ok(SYSTEM_PROMPT.includes('contenteditable="true"'));
});

test('the system prompt asks for a visual answer built with scoped, theme-safe HTML/CSS', () => {
  assert.match(SYSTEM_PROMPT, /## Make it visual/);
  assert.match(SYSTEM_PROMPT, /last resort/);
  for (const needle of ['<style id=', 'light-dark()', '<details>', 'SVG']) {
    assert.ok(SYSTEM_PROMPT.includes(needle), 'missing: ' + needle);
  }
});

test('the loader hands pi our system prompt and drops this repository\'s AGENTS.md', async () => {
  // A throwaway agent dir: the test must not pick up a developer's own
  // ~/.pi/agent — extensions from there would run inside the test.
  const agentDir = await mkdtemp(join(tmpdir(), 'aiborda-agent-'));
  try {
    const loader = createResourceLoader({ cwd: REPO_ROOT, agentDir });
    await loader.reload();
    assert.equal(loader.getSystemPrompt(), SYSTEM_PROMPT);
    const paths = loader.getAgentsFiles().agentsFiles.map(f => f.path);
    assert.ok(!paths.includes(join(REPO_ROOT, 'AGENTS.md')), 'got: ' + JSON.stringify(paths));
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test('a turn carries the diff verbatim and ends with the reminder', () => {
  const diff = '#q  "" -> "hello"\nadded to #items: <li>milk</li>';
  const framed = frameTurn(diff);
  assert.ok(framed.includes(diff));
  assert.match(framed,
    /Answer on the page, in the form that shows it best and editable by the human, then end the turn without text\.$/);
});

test('a turn that ends with no text, or only with the log word, is clean', () => {
  const call = { type: 'toolCall', id: 't1', name: 'page_exec', arguments: {} };
  assert.equal(strayText([assistant([call])]), null);
  assert.equal(strayText([assistant([])]), null);
  assert.equal(strayText([assistant([{ type: 'text', text: '  \n' }])]), null);
  for (const word of ['done', 'Done.', 'DONE!', ' done\n', '`done`', '"done".']) {
    assert.equal(strayText([assistant([{ type: 'text', text: word }])]), null, word);
  }
});

test('a turn that ends with prose is stray, whatever else the message holds', () => {
  const msg = assistant([
    { type: 'thinking', thinking: 'the human wants stars' },
    { type: 'text', text: 'Done — the starry sky is running in #out.' },
    { type: 'text', text: '800 stars.' },
  ]);
  assert.equal(strayText([{ role: 'user', content: 'x' }, msg]),
    'Done — the starry sky is running in #out.\n800 stars.');
});

test('an aborted or failed turn, or one not ending with the model, is never nudged', () => {
  const text = [{ type: 'text', text: 'partial answer' }];
  assert.equal(strayText([assistant(text, 'aborted')]), null);
  assert.equal(strayText([assistant(text, 'error')]), null);
  assert.equal(strayText([assistant(text), { role: 'toolResult', content: [] }]), null);
  assert.equal(strayText([]), null);
  assert.equal(strayText(undefined), null);
});

test('the nudge is hidden, quotes the stray text and cuts a long one', () => {
  const short = nudgeMessage('The answer is 42.');
  assert.equal(short.display, false);
  assert.ok(short.content.includes('The answer is 42.'));
  assert.match(short.content, /Put this on the page now/);

  const long = nudgeMessage('x'.repeat(1000));
  assert.ok(long.content.includes('x'.repeat(300) + '…'));
  assert.ok(!long.content.includes('x'.repeat(301)));
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

test('an execution error is returned to the model rather than thrown', async () => {
  const t = createPageTool(async () => ({ ok: false, error: 'ReferenceError: nope' }));
  const r = await t.execute('c1', { code: 'no.such.thing' });
  assert.match(r.content[0].text, /ReferenceError/);
});

test('a bridge refusal is returned to the model as text', async () => {
  const t = createPageTool(async () => { throw new Error('the shell is not connected'); });
  const r = await t.execute('c1', { code: 'x' });
  assert.match(r.content[0].text, /the shell is not connected/);
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

test('execute does not throw if callPage returned garbage with no ok/value/error', async () => {
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
