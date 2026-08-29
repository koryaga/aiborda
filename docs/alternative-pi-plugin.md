# Отложенный вариант: dom-agent как расширение pi

Дата: 2026-08-20. Решение принято в пользу SDK; этот документ сохраняет
рассмотренную альтернативу вместе с проверенными фактами, чтобы к ней можно
было вернуться без повторного исследования.

> **К этому варианту вернулись 2026-08-29.** Актуальное исследование по
> версии pi 0.84.4, разбор UI «как в CLI» и план вех —
> в [pi-plugin-web-brainstorm.md](pi-plugin-web-brainstorm.md). Факты ниже
> проверялись на 0.83 и частично устарели: в 0.84 появился
> `expandPromptTemplates`, позволяющий расширению запускать слэш-команды.

## В чём состоял вариант

Вместо самостоятельного приложения — расширение к `pi`. Пользователь
запускает `pi` в терминале, расширение поднимает HTTP-сервер и отдаёт
страницу. Страница становится второй поверхностью рядом с TUI, в одной сессии.

## Почему выбран не он

Формулировка задачи — «коммуникация с пользователем через html». В варианте с
плагином терминал остаётся главным окном, а страница живёт при нём. SDK даёт
страницу как единственный интерфейс.

Это не отменяет плагин как будущий второй режим запуска: ядро одно и то же,
различается только точка входа.

## Проверенные факты (не перепроверять)

Конвенция объявления расширения — поле `pi` в `package.json`:

```json
"pi": { "extensions": ["./extensions/chrome-profile-bridge/index.ts"] }
```

Точка входа — функция по умолчанию:

```ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI): void { … }
```

Зависимость объявляется как peer и помечается необязательной:

```json
"peerDependencies": { "@earendil-works/pi-coding-agent": "*", "typebox": "*" },
"peerDependenciesMeta": { "@earendil-works/pi-coding-agent": { "optional": true } }
```

Подключается пользователем через `packages` в `~/.pi/agent/settings.json`
(в реальном конфиге записи вида `"npm:pi-chrome"`).

### Что даёт `ExtensionAPI`

Существенное для нашей задачи:

- `registerTool(tool)` — инструменты, доступные модели
- `registerCommand(name, options)` — слэш-команды
- `registerShortcut`, `registerFlag`, `getFlag`
- `sendUserMessage(content, { deliverAs })` — положить сообщение пользователя
  в разговор; **всегда запускает ход**. Это и есть «человек нажал отправить».
- `sendMessage({ customType, content, display })` — служебное сообщение,
  с управлением тем, попадает ли оно в контекст LLM
- `appendEntry(customType, data)` — запись в сессию **без** попадания в контекст
- `getActiveTools()` / `setActiveTools(names)` — включать и выключать
  инструменты на ходу
- `exec(...)` — выполнить команду оболочки
- `registerMessageRenderer`, `registerEntryRenderer`, `registerMarkdownTransformer`
- `setSessionName` / `getSessionName`, `setLabel`

Событий около тридцати пяти, среди полезных:
`session_start`, `session_shutdown`, `turn_start`, `turn_end`,
`message_start`, `message_update`, `message_end`,
`tool_execution_start` / `_update` / `_end`, `tool_call`, `tool_result`,
`context`, `before_provider_request`, `input`, `user_bash`,
`model_select`, `thinking_level_select`, `project_trust`.

### Прецедент

`pi-chrome` версии 0.15.46 — расширение, которое поднимает **собственный
HTTP-сервер** через `node:http` и общается с браузерным расширением в реальном
профиле Chrome, опрашивающим этот сервер за командами. То есть «расширение pi
держит сервер и разговаривает с браузером» — уже работающая схема, а не
предположение.

Полезное оттуда же, если возвращаться к варианту:

- защита от двойной загрузки через флаг на `globalThis` — переживает `/reload`
- разрешение пользователя хранится отдельно от флага загрузки, чтобы `/reload`
  его не сбрасывал
- инструменты регистрируются лениво и включаются через `setActiveTools` только
  после авторизации

## Что пришлось бы делать иначе, чем в варианте с SDK

- Точка входа: `export default function (pi: ExtensionAPI)` вместо
  `createAgentSession(...)`
- Ход запускается через `pi.sendUserMessage(diff)` вместо прямого вызова сессии
- Инструменты страницы регистрируются через `pi.registerTool` вместо
  `customTools` в опциях сессии
- Жизненный цикл сервера привязывается к `session_start` / `session_shutdown`
- Публикация: пакет в npm с полем `pi.extensions`, установка через `packages`

Всё остальное — образ, оболочка, наблюдатель мутаций, сборка дифа — общее и
переносится без изменений.
