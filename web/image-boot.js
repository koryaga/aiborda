// Исполняется внутри образа и в тестах. Импортов нет: текст этого файла
// инлайнится в srcdoc обычным script-тегом, поэтому здесь только объявления.

function createImage(doc, send, opts) {
  const win = doc.defaultView;
  const options = opts || {};
  const trusted = options.trusted || (e => e.isTrusted);
  const grace = options.grace != null ? options.grace : 250;
  const LIMIT = 10000;

  let execDepth = 0;
  const recs = [];
  const baseline = new Map();
  const dirty = new Set();

  const observer = new win.MutationObserver(rs => {
    for (const r of rs) recs.push({
      type: r.type,
      target: r.target,
      attributeName: r.attributeName,
      oldValue: r.oldValue,
      removed: Array.prototype.slice.call(r.removedNodes),
      added: Array.prototype.slice.call(r.addedNodes),
      byModel: execDepth > 0,
    });
  });

  function path(n) {
    if (n.nodeType === 3) n = n.parentNode;
    if (!n || n === doc.documentElement) return 'html';
    if (n.id) return '#' + n.id;
    const p = n.parentNode;
    if (!p || !p.children) return n.nodeName.toLowerCase();
    const i = Array.prototype.indexOf.call(p.children, n) + 1;
    return path(p) + ' > ' + n.tagName.toLowerCase() + ':nth-child(' + i + ')';
  }

  function serialize(n) {
    return n.nodeType === 3 ? JSON.stringify(n.data) : n.outerHTML;
  }

  function clear() {
    recs.length = 0;
    baseline.clear();
    dirty.clear();
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
    try {
      const fn = new win.Function('return (async () => {' + code + '})()');
      return { ok: true, value: clip(show(await fn())) };
    } catch (e) {
      return { ok: false, error: String((e && e.stack) || e) };
    } finally {
      win.setTimeout(() => { execDepth--; }, grace);
    }
  }

  // Коалесцирование обязательно: getAttribute в момент доставки записи
  // возвращает текущее значение, а не значение на момент мутации.
  // Старое берётся из самой ранней записи, новое — из живого DOM.
  function buildDiff() {
    const attrs = new Map();
    const texts = new Map();
    const removed = [];
    const added = [];

    for (const r of recs) {
      if (r.byModel) continue;
      if (r.type === 'attributes') {
        if (!attrs.has(r.target)) attrs.set(r.target, new Map());
        const m = attrs.get(r.target);
        if (!m.has(r.attributeName)) m.set(r.attributeName, r.oldValue);
      } else if (r.type === 'characterData') {
        if (!texts.has(r.target)) texts.set(r.target, r.oldValue);
      } else {
        for (const n of r.removed) removed.push({ node: n, parent: r.target });
        for (const n of r.added) added.push({ node: n, parent: r.target });
      }
    }

    const addedNodes = new Set(added.map(a => a.node));
    const lines = [];

    for (const el of dirty) {
      const was = baseline.has(el) ? baseline.get(el) : '';
      if (el.value === was) continue;
      lines.push(path(el) + '  ' + JSON.stringify(was) + ' -> ' + JSON.stringify(el.value));
    }
    for (const [node, m] of attrs) {
      if (!node.isConnected) continue;
      for (const [attr, old] of m) {
        const now = node.getAttribute(attr);
        if (old === now) continue;
        lines.push(path(node) + '  @' + attr + ': ' + JSON.stringify(old) + ' -> ' + JSON.stringify(now));
      }
    }
    for (const [node, old] of texts) {
      if (!node.isConnected || node.data === old) continue;
      lines.push(path(node) + '  текст: ' + JSON.stringify(old) + ' -> ' + JSON.stringify(node.data));
    }
    for (const item of removed) {
      if (item.node.isConnected || addedNodes.has(item.node)) continue;
      lines.push('удалён из ' + path(item.parent) + ': ' + serialize(item.node));
    }
    for (const item of added) {
      if (!item.node.isConnected) continue;
      lines.push('добавлен в ' + path(item.parent) + ': ' + serialize(item.node));
    }

    clear();
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
      if (el && 'value' in el && !baseline.has(el)) baseline.set(el, el.value);
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
