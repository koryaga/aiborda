// Превращает события сессии pi в поток для stdout.
//
// Зачем отдельный файл: сама печать — один вызов write, а вот решение, что
// именно печатать, зависит от формы события и стоит того, чтобы быть чистой
// функцией под тестами.
//
// Формы событий сняты с типов pi:
//   message_update       { assistantMessageEvent }  — токен-левел поток
//   tool_execution_start { toolName, args }
//   tool_execution_end   { toolName, result, isError }

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function oneLine(s, limit = 200) {
  const flat = String(s ?? '').replace(/\s*\n\s*/g, ' ');
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat;
}

// Результат инструмента — AgentToolResult: { content: [{type:'text', text}] }
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
    // Рассуждения приглушаем, а не прячем: без них непонятно, жив ли ход.
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

// Какой поток идёт сейчас: мысли или ответ. Нужно, чтобы разделить их
// переводом строки — иначе они слипаются в одну кашу, и без цвета
// (например, в файле лога) не понять, где кончилось одно и началось другое.
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
