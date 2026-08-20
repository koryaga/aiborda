export const SYSTEM_PROMPT = `Ты управляешь HTML-страницей. Отвечай ТОЛЬКО кодом JavaScript.
Без markdown, без объяснений, без обратных кавычек.

Код исполняется в контексте страницы, тебе доступен document.
Отвечай пользователю не текстом, а изменением DOM: пиши в #out, меняй
элементы, создавай новые. Форму ответа выбираешь сама.

Страница создана из такой заготовки:
  <textarea id="q">   свободный ввод пользователя
  <ul id="items">     список
  <div id="out">      область вывода
  <div id="notes">    твои заметки, скрыт от пользователя
Ты и пользователь с тех пор могли изменить что угодно, включая эти узлы.

Снимка страницы тебе никто не присылает. Если нужно знать состояние —
верни нужное из кода, результат придёт следующим ходом:
  return [...document.querySelectorAll('[id]')].map(n => n.id).join()
  return document.querySelector('#items').innerHTML

Не трать ход на чтение, если можешь прочитать и изменить в одном коде:
  const box = document.querySelector('#items') ?? make('#items')
  if (box.children.length) { ... } else { ... }

Состояние храни в DOM — в узлах и data-* атрибутах. Заметки себе пиши
в #notes. Между ходами ничего кроме DOM не сохраняется.

Пользователь правит страницу руками — в полях ввода и через инструменты
разработчика браузера. Его правки приходят тебе дифом.

Ничего делать не обязательно: пустой ответ — законный ход.`;

const EMPTY_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 4);
}

export function createHistory() {
  const messages = [];
  return {
    messages,
    pushDiff(diff) {
      messages.push({ role: 'user', content: String(diff ?? ''), timestamp: Date.now() });
    },
    pushResult(value) {
      if (value === undefined || value === null) return;
      messages.push({ role: 'user', content: 'результат: ' + value, timestamp: Date.now() });
    },
    // В историю кладётся только код: рассуждения модели не переиспользуются
    // и ломали бы неизменность префикса, на которой держится KV-кэш.
    // Пустой код тоже кладётся — пустой ответ есть законный ход, запись о
    // нём учит модель примером.
    pushCode(code, model) {
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: String(code ?? '') }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        // Каждый вызов создаёт собственные объекты usage/cost — не
        // расшаривать их по ссылке между сообщениями.
        usage: { ...EMPTY_USAGE, cost: { ...EMPTY_USAGE.cost } },
        stopReason: 'stop',
        timestamp: Date.now(),
      });
    },
    reset() { messages.length = 0; },
    size() {
      return estimateTokens(SYSTEM_PROMPT) + messages.reduce((n, m) => n + estimateTokens(
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content)), 0);
    },
  };
}
