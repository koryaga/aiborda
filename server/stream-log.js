// Turns pi session events into a stream for stdout.
//
// Why a separate file: printing itself is a single write call, but the decision
// about what exactly to print depends on the shape of the event and is worth
// having as a pure function under tests.
//
// The event shapes are taken from pi's types:
//   message_update       { assistantMessageEvent }  — token-level stream
//   tool_execution_start { toolName, args }
//   tool_execution_end   { toolName, result, isError }

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function oneLine(s, limit = 200) {
  const flat = String(s ?? '').replace(/\s*\n\s*/g, ' ');
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat;
}

// A tool result is an AgentToolResult: { content: [{type:'text', text}] }
function resultText(result) {
  if (typeof result === 'string') return result;
  const parts = result?.content;
  if (!Array.isArray(parts)) return '';
  return parts.filter(c => c?.type === 'text').map(c => c.text).join(' ');
}

export function formatEvent(ev, { color = true } = {}) {
  if (!ev || typeof ev.type !== 'string') return null;
  const dim = s => (color ? DIM + s + RESET : s);

  if (ev.type === 'message_update') {
    const a = ev.assistantMessageEvent;
    if (!a?.delta) return null;
    // Reasoning is dimmed, not hidden: without it there is no telling whether
    // the turn is still alive.
    if (a.type === 'thinking_delta') return dim(a.delta);
    if (a.type === 'text_delta') return a.delta;
    return null;
  }

  if (ev.type === 'tool_execution_start') {
    return `\n${dim('→ ' + ev.toolName)} ${oneLine(JSON.stringify(ev.args), 300)}\n`;
  }

  if (ev.type === 'tool_execution_end') {
    const mark = ev.isError ? '✗' : '←';
    return `${dim(mark + ' ' + ev.toolName)} ${oneLine(resultText(ev.result))}\n`;
  }

  if (ev.type === 'turn_start') return '\n';
  if (ev.type === 'agent_settled') return '\n';

  return null;
}

// Which stream is running right now: thinking or answer. Needed to separate
// them with a newline — otherwise they run together into one blob, and without
// color (in a log file, say) there is no telling where one ended and the other
// began.
export function streamKind(ev) {
  if (ev?.type !== 'message_update') return null;
  const t = ev.assistantMessageEvent?.type;
  if (t === 'thinking_delta') return 'thinking';
  if (t === 'text_delta') return 'text';
  return null;
}

export function createPrinter(write = s => process.stdout.write(s), { color } = {}) {
  const useColor = color ?? Boolean(process.stdout.isTTY);
  let last = null;
  return ev => {
    const s = formatEvent(ev, { color: useColor });
    if (!s) return;
    const kind = streamKind(ev);
    if (kind && last && kind !== last) write('\n');
    last = kind;
    write(s);
  };
}
