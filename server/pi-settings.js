import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_SETTINGS_PATH = join(homedir(), '.pi', 'agent', 'settings.json');

// Идентификаторы моделей сами содержат слэши: openrouter/nvidia/nemotron-...
// Поэтому режем по первому, а не последнему и не по всем.
export function splitRef(ref) {
  if (typeof ref !== 'string') return null;
  const i = ref.indexOf('/');
  if (i <= 0 || i === ref.length - 1) return null;
  return { provider: ref.slice(0, i), id: ref.slice(i + 1) };
}

export async function loadSettings({ path = DEFAULT_SETTINGS_PATH } = {}) {
  let raw;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    // Отсутствие файла — штатный случай: отобранного списка просто нет.
    // Битый файл — другое дело, о нём надо сказать.
    const notes = e.code === 'ENOENT' ? [] : [`settings.json не разобран — ${e.message}`];
    return { enabled: [], default: null, notes };
  }

  const obj = raw ?? {};
  const list = Array.isArray(obj.enabledModels) ? obj.enabledModels : [];
  const enabled = [], notes = [];
  for (const ref of list) {
    const parsed = splitRef(ref);
    if (parsed) enabled.push(parsed);
    else notes.push(`enabledModels: запись ${JSON.stringify(ref)} не похожа на провайдер/модель`);
  }

  const def = typeof obj.defaultProvider === 'string' && typeof obj.defaultModel === 'string'
    ? { provider: obj.defaultProvider, id: obj.defaultModel }
    : null;

  return { enabled, default: def, notes };
}
