import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

// The same limit that already applies inside the image: a value from the page
// must not travel into the model's context in full.
const MAX_VALUE_LENGTH = 10000;

// The contract with the model is our own system prompt, and it replaces pi's
// base prompt rather than joining it. The base prompt opens with "You are an
// expert coding assistant" and closes its guidelines with "Be concise in your
// responses" — both frame a text reply as the answer, and both used to outrank
// a contract that pi appended last, as a project context file. Once the prompt
// is overridden, pi also drops promptSnippet and promptGuidelines, so everything
// the model has to know lives in this one file.
export const SYSTEM_PROMPT = readFileSync(new URL('./system-prompt.md', import.meta.url), 'utf8');

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));

// The only text a turn may end with. The prompt gives the closing-remark reflex
// this outlet instead of forbidding it outright. The prompt shows the word as
// `done`, and a model may copy the backticks or quotes along with it.
const LOG_WORD = /^[`"']?done[`"']?[.!]?$/i;

// How much of a stray reply the nudge quotes back: enough to point at it, not
// so much that a long reply lands in the context twice in full.
const NUDGE_QUOTE_LENGTH = 300;

function toText(r) {
  if (r === undefined || r === null || typeof r !== 'object') {
    return 'done, no value returned';
  }
  if (!r.ok) {
    const err = r.error === undefined ? 'unknown error' : String(r.error);
    return 'execution error: ' + err;
  }
  if (r.value === undefined) return 'done, no value returned';
  const text = String(r.value);
  return text.length > MAX_VALUE_LENGTH ? text.slice(0, MAX_VALUE_LENGTH) : text;
}

export function createPageTool(callPage) {
  return {
    name: 'page_exec',
    label: 'Page',
    description:
      "Execute JavaScript in the user's page and return the result. " +
      'The only way to read and change what the human sees. ' +
      'The whole DOM and HTML5 are available, including localStorage.',
    parameters: Type.Object({
      code: Type.String({ description: 'JavaScript. The value you return is handed back to you.' }),
    }),
    executionMode: 'sequential',
    async execute(toolCallId, params) {
      let r;
      try {
        r = await callPage(params.code);
      } catch (e) {
        const msg = e && e.message ? e.message : 'the page is unreachable';
        return { content: [{ type: 'text', text: 'the page is unreachable: ' + msg }] };
      }
      return { content: [{ type: 'text', text: toText(r) }] };
    },
  };
}

// The system prompt sits far from the end of a long conversation; a reminder
// inside the latest message is what the model reads last.
export function frameTurn(diff) {
  return 'Changes on the page since your last turn:\n' + diff +
    '\n\nAnswer on the page, in the form that shows it best and editable by the human, ' +
    'then end the turn without text.';
}

// The text the model ended its turn with — which the human never sees. null
// when the turn ended cleanly: with no text, with the log word, or not with a
// finished reply at all (aborted, failed, or the last message is not the
// model's).
export function strayText(messages) {
  const last = Array.isArray(messages) ? messages[messages.length - 1] : undefined;
  if (!last || last.role !== 'assistant') return null;
  if (last.stopReason === 'aborted' || last.stopReason === 'error') return null;
  const blocks = Array.isArray(last.content) ? last.content : [];
  const text = blocks
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim();
  if (text === '' || LOG_WORD.test(text)) return null;
  return text;
}

// A hidden message that sends the stray reply back to the model, so that it
// moves the reply onto the page itself.
export function nudgeMessage(text) {
  const quote = text.length > NUDGE_QUOTE_LENGTH ? text.slice(0, NUDGE_QUOTE_LENGTH) + '…' : text;
  return {
    customType: 'aiborda-nudge',
    display: false,
    content:
      'Your turn ended with text instead of a change to the page. ' +
      'The human did not see it:\n\n' + quote + '\n\n' +
      'Put this on the page now, then end the turn without text.',
  };
}

// This repository's own AGENTS.md is for agents working on the code, not for
// the model behind the page. Context files from elsewhere — the user's global
// one, a parent directory's — stay.
function insidePackage(path) {
  const rel = relative(PACKAGE_ROOT, resolve(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// Built the way createAgentSession builds its default loader, plus the two
// overrides. Call reload() before use.
export function createResourceLoader({ cwd, agentDir = getAgentDir(), settingsManager }) {
  return new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settingsManager ?? SettingsManager.create(cwd, agentDir),
    systemPromptOverride: () => SYSTEM_PROMPT,
    agentsFilesOverride: ({ agentsFiles }) => ({
      agentsFiles: agentsFiles.filter(f => !insidePackage(f.path)),
    }),
  });
}

export async function startSession({ cwd = process.cwd(), callPage } = {}) {
  // One settings manager for the loader and the session, so both read the same
  // settings.
  const root = resolve(cwd);
  const settingsManager = SettingsManager.create(root, getAgentDir());
  const resourceLoader = createResourceLoader({ cwd: root, settingsManager });
  await resourceLoader.reload();
  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: root,
    settingsManager,
    resourceLoader,
    customTools: [createPageTool(callPage)],
  });
  return { session, modelFallbackMessage };
}
