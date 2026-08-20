// Незакрытый <think>/<thinking> (модель оборвалась на середине рассуждения)
// срезается до конца ответа: нежадный [\s\S]*? останавливается либо на
// закрывающем теге, либо, если его нет, на конце строки — это единственный
// вариант, если кода после незакрытого блока всё равно быть не может.
const THINK_RE = /<think(?:ing)?>[\s\S]*?(?:<\/think(?:ing)?>|$)/gi;

export function stripThinking(text) {
  return String(text ?? '').replace(THINK_RE, '');
}

const INTRO_RE = /^\s*(?:вот код|вот|here(?:'s| is) the code|here(?:'s| is))\s*[:：]?[^\S\n]*\n?/i;
const FENCED_RE = /^```(?:js|javascript)?[^\S\n]*\n([\s\S]*?)\n?```$/i;
const INLINE_BACKTICK_RE = /^`([^`]*)`$/;

export function extractCode(text) {
  let s = stripThinking(text).trim();
  if (!s) return '';
  // Сначала вводный префикс, потом обёртка из кавычек: если снимать кавычки
  // первыми якорем ^...$, текст перед ними («Вот код:») собьёт якорь.
  s = s.replace(INTRO_RE, '');
  const fenced = FENCED_RE.exec(s);
  if (fenced) {
    s = fenced[1];
  } else {
    const inline = INLINE_BACKTICK_RE.exec(s);
    if (inline) s = inline[1];
  }
  return s.trim();
}

// Проверка обязана совпадать с тем, как код оборачивается в образе,
// иначе верхнеуровневый await ложно объявляется синтаксической ошибкой.
// Ловит только синтаксис: код, синтаксически валидный, но обречённый бросить
// при исполнении (например, обращение к несуществующему объекту), — это ok.
export function checkParsable(code) {
  if (!code) return { ok: true };
  try {
    new Function('return (async () => {' + code + '})()');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message) };
  }
}
