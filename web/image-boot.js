// Исполняется внутри образа и в тестах. Импортов нет: текст этого файла
// инлайнится в srcdoc обычным script-тегом, поэтому здесь только объявления.

function createImage(doc, send, opts) {
  const win = doc.defaultView;
  const options = opts || {};
  const trusted = options.trusted || (e => e.isTrusted);
  const grace = options.grace != null ? options.grace : 250;
  const LIMIT = 10000;

  let execDepth = 0;
  // trustSync: true только в синхронном+микротасковом хвосте прямо после
  // запуска кода модели (до первого реального прохода через макротаск).
  // Пока это так, ни один человек не может вклиниться — вкладка занята
  // синхронным JS. Мутации, увиденные в этом окне, — точно от модели,
  // и их узлы уходят в modelTouched. После первого макротаска (await
  // внутри кода модели, либо весь grace-хвост) доверять execDepth>0
  // самому по себе нельзя: человек мог вклиниться. Поэтому дальше
  // модельными считаются только записи по уже известным узлам.
  let trustSync = false;
  const modelTouched = new Set();
  const recs = [];
  const baseline = new Map();
  const dirty = new Set();

  function recordNodes(type, target, removed, added) {
    if (type === 'attributes' || type === 'characterData') return [target];
    return [target].concat(removed, added);
  }

  const observer = new win.MutationObserver(rs => {
    for (const r of rs) {
      const removed = Array.prototype.slice.call(r.removedNodes);
      const added = Array.prototype.slice.call(r.addedNodes);
      let byModel = false;
      if (execDepth > 0) {
        const nodes = recordNodes(r.type, r.target, removed, added);
        if (trustSync || nodes.some(n => modelTouched.has(n))) {
          byModel = true;
          for (const n of nodes) modelTouched.add(n);
        }
      }
      recs.push({
        type: r.type,
        target: r.target,
        attributeName: r.attributeName,
        oldValue: r.oldValue,
        removed,
        added,
        byModel,
      });
    }
  });

  // M9: путь от id доверяем, только если он однозначно ведёт назад к тому
  // же узлу — иначе дублирующийся или синтаксически кривой id (пробел,
  // ведущая цифра) даст неверный или нерабочий селектор.
  function path(n) {
    if (n.nodeType === 3) n = n.parentNode;
    if (!n || n === doc.documentElement) return 'html';
    // M8: у отсоединённого узла нет надёжного пути — врать про адрес
    // (bare tag может указывать на другой живой узел) хуже, чем пометить.
    if (!n.isConnected) return n.nodeName.toLowerCase() + ' (удалён)';
    if (n.id) {
      let unique = false;
      try { unique = doc.querySelector('#' + n.id) === n; } catch (e) { unique = false; }
      if (unique) return '#' + n.id;
    }
    const p = n.parentNode;
    if (!p || !p.children) return n.nodeName.toLowerCase();
    const i = Array.prototype.indexOf.call(p.children, n) + 1;
    return path(p) + ' > ' + n.tagName.toLowerCase() + ':nth-child(' + i + ')';
  }

  function serialize(n) {
    if (n.nodeType === 3) return JSON.stringify(n.data);
    // I7: строка дифа — одна строка. Схлопываем только переносы (и пробелы
    // вокруг них), внутристрочные отступы не трогаем.
    return n.outerHTML.replace(/\s*\n\s*/g, ' ');
  }

  // C3: одно понятие «состояние поля» и для baseline (focusin), и для
  // сравнения в дифе. undefined — значит поле не отслеживаем (I6:
  // contenteditable и подобное без .value).
  function fieldState(el) {
    if (!el) return undefined;
    const type = (el.type || '').toLowerCase();
    if (el.tagName === 'INPUT' && (type === 'checkbox' || type === 'radio')) return String(el.checked);
    if (el.tagName === 'SELECT' && el.multiple) {
      return Array.prototype.map.call(el.selectedOptions, o => o.value);
    }
    if ('value' in el) return el.value;
    return undefined;
  }

  function clear() {
    recs.length = 0;
    baseline.clear();
    dirty.clear();
    modelTouched.clear();
  }

  // Синхронизация делается на клоне: живой DOM — это память агента,
  // и мутировать его ради сериализации нельзя.
  function snapshot() {
    const clone = doc.body.cloneNode(true);
    const src = doc.body.querySelectorAll('input,textarea,select,option');
    const dst = clone.querySelectorAll('input,textarea,select,option');
    for (let i = 0; i < src.length; i++) {
      const s = src[i], d = dst[i];
      if (s.type === 'checkbox' || s.type === 'radio') d.toggleAttribute('checked', s.checked);
      else if (s.tagName === 'OPTION') d.toggleAttribute('selected', s.selected);
      else if ('value' in s) d.setAttribute('value', s.value);
      if (s.tagName === 'TEXTAREA') d.textContent = s.value;
    }
    return clone.innerHTML;
  }

  function show(v) {
    if (v === undefined) return undefined;
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }

  function clip(s) {
    if (s === undefined) return undefined;
    return s.length > LIMIT ? s.slice(0, LIMIT) : s;
  }

  async function exec(code) {
    execDepth++;
    trustSync = true;
    win.setTimeout(() => { trustSync = false; }, 0);
    try {
      const fn = new win.Function('return (async () => {' + code + '})()');
      return { ok: true, value: clip(show(await fn())) };
    } catch (e) {
      return { ok: false, error: String((e && e.stack) || e) };
    } finally {
      win.setTimeout(() => { execDepth--; }, grace);
    }
  }

  // Запись атрибута/текста копится по ключу (узел [+ атрибут]):
  // - old — oldValue самой первой ЧЕЛОВЕЧЕСКОЙ записи по ключу;
  // - override — если после человеческой записи есть более поздняя
  //   МОДЕЛЬНАЯ запись, override — её oldValue: именно это оставил
  //   человек до того, как модель переписала значение (C2). Новая
  //   человеческая запись сбрасывает override заново.
  // - hasHuman — был ли вообще человек; без этого строка не пишется.
  function applyRecord(entry, r) {
    if (!r.byModel) {
      if (!entry.hasHuman) entry.old = r.oldValue;
      entry.hasHuman = true;
      entry.override = undefined;
    } else if (entry.hasHuman && entry.override === undefined) {
      entry.override = r.oldValue;
    }
  }

  // Коалесцирование обязательно: getAttribute в момент доставки записи
  // возвращает текущее значение, а не значение на момент мутации.
  // Старое берётся из самой ранней человеческой записи, новое — из
  // живого DOM, если модель не переписала значение позже (см. applyRecord).
  function buildDiff() {
    const attrs = new Map();
    const texts = new Map();
    const removed = [];
    const added = new Map();

    for (const r of recs) {
      if (r.type === 'attributes') {
        if (!attrs.has(r.target)) attrs.set(r.target, new Map());
        const m = attrs.get(r.target);
        let entry = m.get(r.attributeName);
        if (!entry) { entry = { old: undefined, hasHuman: false, override: undefined }; m.set(r.attributeName, entry); }
        applyRecord(entry, r);
      } else if (r.type === 'characterData') {
        let entry = texts.get(r.target);
        if (!entry) { entry = { old: undefined, hasHuman: false, override: undefined }; texts.set(r.target, entry); }
        applyRecord(entry, r);
      } else {
        if (r.byModel) continue;
        for (const n of r.removed) removed.push({ node: n, parent: r.target });
        // I5: перестановка узла туда-обратно даёт две записи childList на
        // один и тот же узел — оставляем только последнюю (Map, не массив).
        for (const n of r.added) added.set(n, r.target);
      }
    }

    // M10: узел, добавленный в этом же окне, описывается один раз через
    // serialize() в строке "добавлен" — отдельных строк про его атрибуты
    // и текст (в том числе вложенные добавления, например текстовый узел
    // от .textContent =) быть не должно.
    for (const node of Array.from(added.keys())) {
      for (const other of added.keys()) {
        if (other !== node && other.contains(node)) { added.delete(node); break; }
      }
    }
    const addedNodes = new Set(added.keys());
    function insideAdded(node) {
      for (const an of addedNodes) if (an.contains(node)) return true;
      return false;
    }

    const lines = [];

    // C4: baseline не стирается целиком после сборки — он пересевается
    // текущим состоянием каждого тронутого поля. Иначе следующий ход без
    // повторного фокуса (фокус же не уходил) сравнивает не с чем.
    for (const el of dirty) {
      const state = fieldState(el);
      if (state === undefined) { baseline.delete(el); continue; } // I6
      const was = baseline.has(el) ? baseline.get(el) : (Array.isArray(state) ? [] : '');
      const wasStr = JSON.stringify(was);
      const nowStr = JSON.stringify(state);
      if (wasStr !== nowStr) lines.push(path(el) + '  ' + wasStr + ' -> ' + nowStr);
      baseline.set(el, state);
    }
    for (const [node, m] of attrs) {
      if (!node.isConnected || insideAdded(node)) continue;
      for (const [attr, entry] of m) {
        if (!entry.hasHuman) continue;
        const now = entry.override !== undefined ? entry.override : node.getAttribute(attr);
        if (entry.old === now) continue;
        lines.push(path(node) + '  @' + attr + ': ' + JSON.stringify(entry.old) + ' -> ' + JSON.stringify(now));
      }
    }
    for (const [node, entry] of texts) {
      if (!node.isConnected || insideAdded(node) || !entry.hasHuman) continue;
      const now = entry.override !== undefined ? entry.override : node.data;
      if (entry.old === now) continue;
      lines.push(path(node) + '  текст: ' + JSON.stringify(entry.old) + ' -> ' + JSON.stringify(now));
    }
    for (const item of removed) {
      if (item.node.isConnected || addedNodes.has(item.node)) continue;
      lines.push('удалён из ' + path(item.parent) + ': ' + serialize(item.node));
    }
    for (const [node, parent] of added) {
      if (!node.isConnected) continue;
      lines.push('добавлен в ' + path(parent) + ': ' + serialize(node));
    }

    recs.length = 0;
    dirty.clear();
    modelTouched.clear();
    return lines.join('\n');
  }

  async function handle(m) {
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'exec') {
      const r = await exec(m.code);
      send({ type: 'result', id: m.id, ok: r.ok, value: r.value, error: r.error });
    } else if (m.type === 'diff') {
      send({ type: 'diff', id: m.id, text: buildDiff() });
    } else if (m.type === 'snap') {
      send({ type: 'snap', id: m.id, html: snapshot() });
    }
  }

  function install() {
    observer.observe(doc.documentElement, {
      subtree: true, childList: true, attributes: true, characterData: true,
      attributeOldValue: true, characterDataOldValue: true,
    });
    doc.addEventListener('focusin', e => {
      if (!trusted(e)) return;
      const el = e.target;
      const state = fieldState(el);
      if (state !== undefined && !baseline.has(el)) baseline.set(el, state);
    }, true);
    for (const t of ['input', 'change']) {
      doc.addEventListener(t, e => { if (trusted(e)) dirty.add(e.target); }, true);
    }
    win.addEventListener('message', e => {
      if (e.source !== win.parent) return;
      handle(e.data);
    });
    send({ type: 'ready' });
    return api;
  }

  const api = { install, handle, exec, snapshot, buildDiff, path, clear };
  return api;
}
