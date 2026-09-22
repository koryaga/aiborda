// A reader for the current pi session transcript. Run: node log.mjs [-f]
// pi writes a turn to disk message by message, so this is not a token-level
// stream but the full picture: reasoning, tool calls with arguments, results.
import { existsSync, readFileSync, readdirSync, statSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// pi encodes a directory by replacing slashes with dashes: /a/b -> --a-b--
// Underscores are preserved. Should that rule ever change, we look for the
// directory whose transcript records our own cwd.
const root = join(homedir(), '.pi', 'agent', 'sessions');
const guess = join(root, '-' + process.cwd().replaceAll('/', '-') + '--');
const dir = existsSync(guess) ? guess : (readdirSync(root)
  .map(d => join(root, d))
  .filter(d => statSync(d).isDirectory())
  .find(d => readdirSync(d).some(f => f.endsWith('.jsonl') &&
    readFileSync(join(d, f), 'utf8').slice(0, 300).includes('"cwd":"' + process.cwd() + '"'))) ?? guess);

const newest = () => readdirSync(dir).filter(f => f.endsWith('.jsonl'))
  .map(f => ({ f, t: statSync(join(dir, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0]?.f;

const cut = (s, n = 400) => { s = String(s ?? '').replace(/\n/g, ' ⏎ '); return s.length > n ? s.slice(0, n) + '…' : s; };

function render(line) {
  let d; try { d = JSON.parse(line); } catch { return; }
  if (d.type === 'model_change') return console.log(`\n── model: ${d.provider}/${d.modelId}`);
  if (d.type !== 'message') return;
  const m = d.message ?? d;
  const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content ?? []);
  for (const c of content) {
    if (c.type === 'text') console.log(`\n[${m.role}] ${cut(c.text, 600)}`);
    else if (c.type === 'thinking') console.log(`  ·thinking· ${cut(c.thinking, 300)}`);
    else if (c.type === 'toolCall') console.log(`  →${c.name} ${cut(JSON.stringify(c.arguments), 500)}`);
  }
}

let file = newest();
if (!file) { console.log('no sessions for this directory yet:', dir); process.exit(0); }
let seen = 0;
const flush = () => {
  const lines = readFileSync(join(dir, file), 'utf8').split('\n');
  for (const l of lines.slice(seen)) if (l.trim()) render(l);
  seen = lines.length - 1;
};
flush();
if (process.argv.includes('-f')) {
  console.log('\n── following', file, '— Ctrl+C to quit');
  watch(dir, () => { const n = newest(); if (n !== file) { file = n; seen = 0; } flush(); });
}
