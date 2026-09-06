import { createAgentSession } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

// The same limit that already applies inside the image: a value from the page
// must not travel into the model's context in full.
const MAX_VALUE_LENGTH = 10000;

// The contract with the model is expressed through pi's own facilities:
// promptSnippet and promptGuidelines land in the system prompt whenever the
// tool is active. The product framing lives in AGENTS.md, which pi reads as a
// context file.
const GUIDELINES = [
  'The page is the only interface with the human. Answer by changing the DOM, not with text: write into #out, change elements, create new ones.',
  'page_exec both reads and writes. Read and write in a single call; do not spend a separate step on reading.',
  'Keep interface state in the DOM. Keep long-lived state in localStorage: it survives a page reload, the DOM does not.',
  'Write notes to yourself into the hidden #notes.',
  "The human's edits arrive as a diff. You are never sent a snapshot of the page — if you need the state, read it via page_exec.",
];

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
    promptSnippet: "page_exec — read and change the user's page",
    promptGuidelines: GUIDELINES,
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

export async function startSession({ cwd = process.cwd(), callPage } = {}) {
  const { session, modelFallbackMessage } = await createAgentSession({
    cwd,
    customTools: [createPageTool(callPage)],
  });
  return { session, modelFallbackMessage };
}
