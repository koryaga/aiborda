import { createAgentSession } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

// Тот же лимит, что уже действует в образе: значение из страницы не должно
// уезжать в контекст модели целиком.
const MAX_VALUE_LENGTH = 10000;

// Контракт с моделью задаётся штатными средствами pi: promptSnippet и
// promptGuidelines попадают в системный промпт, когда инструмент активен.
// Продуктовая рамка — в AGENTS.md, его pi читает как контекстный файл.
const GUIDELINES = [
  'Страница — единственный интерфейс с человеком. Отвечай не текстом, а изменением DOM: пиши в #out, меняй элементы, создавай новые.',
  'page_exec и читает, и меняет. Читай и меняй в одном вызове, не трать на чтение отдельный шаг.',
  'Состояние интерфейса храни в DOM. Долговременное состояние — в localStorage: он переживает перезагрузку страницы, а DOM нет.',
  'Заметки себе пиши в скрытый #notes.',
  'Правки человека приходят дифом. Снимок страницы тебе не присылают — если нужно состояние, прочитай его через page_exec.',
];

function toText(r) {
  if (r === undefined || r === null || typeof r !== 'object') {
    return 'выполнено, значение не возвращено';
  }
  if (!r.ok) {
    const err = r.error === undefined ? 'неизвестная ошибка' : String(r.error);
    return 'ошибка исполнения: ' + err;
  }
  if (r.value === undefined) return 'выполнено, значение не возвращено';
  const text = String(r.value);
  return text.length > MAX_VALUE_LENGTH ? text.slice(0, MAX_VALUE_LENGTH) : text;
}

export function createPageTool(callPage) {
  return {
    name: 'page_exec',
    label: 'Страница',
    description:
      'Исполнить JavaScript в странице пользователя и вернуть результат. ' +
      'Единственный способ читать и менять то, что видит человек. ' +
      'Доступен весь DOM и HTML5, включая localStorage.',
    promptSnippet: 'page_exec — читать и менять страницу пользователя',
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      code: Type.String({ description: 'JavaScript. Значение из return вернётся тебе.' }),
    }),
    executionMode: 'sequential',
    async execute(toolCallId, params) {
      let r;
      try {
        r = await callPage(params.code);
      } catch (e) {
        const msg = e && e.message ? e.message : 'страница недоступна';
        return { content: [{ type: 'text', text: 'страница недоступна: ' + msg }] };
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
