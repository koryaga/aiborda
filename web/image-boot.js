// Runs inside the image and in tests. No imports: the text of this file is
// inlined into srcdoc as a plain script tag, so only declarations here.

function createImage(doc, send, opts) {
  const win = doc.defaultView;
  const options = opts || {};
  const trusted = options.trusted || (e => e.isTrusted);
  const grace = options.grace != null ? options.grace : 250;
  const LIMIT = 10000;

  let execDepth = 0;
  // trustSync: true only in the synchronous + microtask tail right after the
  // model's code starts (before the first real macrotask boundary). While that
  // holds, no human can slip in — the tab is busy running synchronous JS.
  // Mutations seen in that window are certainly the model's, and their nodes go
  // into modelTouched. After the first macrotask (an await inside the model's
  // code, or the whole grace tail) execDepth > 0 alone is no longer
  // trustworthy: a human could have slipped in. From then on only writes to
  // already-known nodes count as the model's.
  let trustSync = false;
  const modelTouched = new Set();
  const recs = [];
  const baseline = new Map();
  const dirty = new Set();
  // What the human last pointed at outside #q: { node, selected } — a clicked
  // element (selected is null), or the element around a text selection and the
  // selected text. A question typed into #q is usually about it ("why is this
  // so big?"), so the diff names it on an "about:" line.
  let pointer = null;

  function recordNodes(type, target, removed, added) {
    if (type === 'attributes' || type === 'characterData') return [target];
    return [target].concat(removed, added);
  }

  // Elements the model added in the current page_exec — and elements it put
  // bare text into. makeEditable() goes over them once the call is done.
  const modelAdded = new Set();

  function handleRecords(rs) {
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
      if (byModel && r.type === 'childList') {
        for (const n of added) {
          if (n.nodeType === 1) modelAdded.add(n);
          else if (n.nodeType === 3 && r.target.nodeType === 1) modelAdded.add(r.target);
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
  }

  const observer = new win.MutationObserver(handleRecords);

  // Clicked, not edited: inside an editable block their labels would turn into
  // text under the caret.
  const CLICKED = 'button, a, select, summary, label, input, textarea';
  // Not prose for a human to edit: code, styles, graphics, embedded media.
  const NOT_PROSE = 'script, style, template, noscript, svg, canvas, iframe, video, audio';

  // Everything the model puts on the page is editable by default — the human's
  // second channel of the conversation. The prompt asks the model for it, but a
  // prompt only makes it likely; this makes it so. Each block of text the model
  // added gets contenteditable="true" unless it, or an ancestor, already says
  // otherwise; the attribute is inherited, so only the topmost block needs it.
  // Controls inside an editable block are switched back off so they stay
  // clickable. These writes are the image's own: dropped from the records, they
  // reach neither the diff nor the attribution.
  function makeEditable() {
    // Normally already delivered by now; flushed anyway, so that the takeRecords()
    // at the end can only ever drop the image's own writes.
    handleRecords(observer.takeRecords());
    const roots = [];
    for (const el of modelAdded) {
      if (!el.isConnected || !doc.body || el === doc.body || !doc.body.contains(el)) continue;
      if (el.closest('#q, #notes') || el.closest(NOT_PROSE)) continue;
      let covered = false;
      for (let p = el.parentElement; p && !covered; p = p.parentElement) covered = modelAdded.has(p);
      if (!covered) roots.push(el);
    }
    modelAdded.clear();
    for (const el of roots) {
      if (el.matches(CLICKED)) continue;
      if (!el.closest('[contenteditable]') && el.textContent.trim()) {
        el.setAttribute('contenteditable', 'true');
      }
      const host = el.closest('[contenteditable]');
      if (!host || host.getAttribute('contenteditable') === 'false') continue;
      for (const c of el.querySelectorAll(CLICKED)) {
        if (!c.hasAttribute('contenteditable')) c.setAttribute('contenteditable', 'false');
      }
    }
    observer.takeRecords();
  }

  // A name that can go into a selector as is. Anything else — a space, a
  // leading digit, the colon of a utility class — is left out rather than
  // escaped: CSS.escape is not available everywhere this file runs.
  const IDENT = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;

  // M9: an id stands in for a position only if it is valid and names exactly
  // one node — a duplicated id would make the selector match both.
  function uniqueId(n) {
    if (!n.id || !IDENT.test(n.id)) return false;
    try { return doc.querySelectorAll('#' + n.id).length === 1; } catch (e) { return false; }
  }

  // One step of a path: the tag, then either a unique id, or the classes and
  // the position among siblings. head and body need no position: there is
  // one of each.
  function step(n) {
    const tag = n.tagName.toLowerCase();
    if (uniqueId(n)) return tag + '#' + n.id;
    const cls = Array.prototype.filter.call(n.classList || [], c => IDENT.test(c));
    const s = tag + cls.map(c => '.' + c).join('');
    const p = n.parentNode;
    if (p === doc.documentElement && (tag === 'body' || tag === 'head')) return s;
    return s + ':nth-child(' + (Array.prototype.indexOf.call(p.children, n) + 1) + ')';
  }

  // The full path from <html>, so the model sees where a node sits and not
  // just which one it is: "html > body > div#out > figure#calc > div:nth-child(1)".
  // It is also a selector that matches exactly this node, ready for
  // querySelector as is.
  function path(n) {
    if (n.nodeType === 3) n = n.parentNode;
    if (!n || n === doc.documentElement) return 'html';
    // M8: a detached node has no reliable path — lying about its address (a
    // bare tag may point at a different live node) is worse than flagging it.
    if (!n.isConnected) return n.nodeName.toLowerCase() + ' (detached)';
    const p = n.parentNode;
    if (!p || !p.children) return n.nodeName.toLowerCase();
    return path(p) + ' > ' + step(n);
  }

  // A text node made of nothing but whitespace is markup formatting, not human
  // intent. On real diffs such lines were 22% of the output: "added to
  // html > body:nth-child(2): \"\\n\\n\"" showed up in every other turn of a
  // session. All it does is drown the signal.
  function isBlankText(n) {
    return n && n.nodeType === 3 && !String(n.data ?? '').trim();
  }

  function inInput(node) {
    const el = node && node.nodeType === 3 ? node.parentNode : node;
    return !el || el.nodeType !== 1 || !!el.closest('#q');
  }

  // One line of text, clipped: enough to recognise the node by, not its whole
  // content.
  function excerpt(s, max) {
    const one = String(s ?? '').replace(/\s+/g, ' ').trim();
    return one.length > max ? one.slice(0, max) + '…' : one;
  }

  function aboutLine() {
    if (!pointer || !pointer.node.isConnected) return null;
    const where = 'about: ' + path(pointer.node);
    if (pointer.selected !== null) return where + '  selected: ' + JSON.stringify(excerpt(pointer.selected, 200));
    const text = excerpt(pointer.node.textContent, 80);
    return text ? where + '  ' + JSON.stringify(text) : where;
  }

  function serialize(n) {
    if (n.nodeType === 3) return JSON.stringify(n.data);
    // I7: a diff line is a single line. Collapse newlines only (and the spaces
    // around them); leave intra-line indentation alone.
    return n.outerHTML.replace(/\s*\n\s*/g, ' ');
  }

  // C3: one notion of "field state", used both for the baseline (focusin) and
  // for the comparison in the diff. undefined means the field is not tracked
  // (I6: contenteditable and the like, which have no .value).
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

  // Clearing the input after a commit. It lives here, not in the shell, so that
  // it is atomic with building the diff: were it a separate message, the human
  // could type in the gap and we would wipe what they typed.
  // The baseline is re-seeded with the empty value — otherwise the next diff
  // would say "was <what was just sent>" even though the field is already
  // empty: focusin will not fire again, since focus never left the field.
  function clearInput() {
    const el = doc.getElementById('q');
    if (!el || !('value' in el)) return;
    el.value = '';
    const state = fieldState(el);
    if (state !== undefined) baseline.set(el, state);
    dirty.delete(el);
  }

  function clear() {
    recs.length = 0;
    baseline.clear();
    dirty.clear();
    modelTouched.clear();
    modelAdded.clear();
    pointer = null;
  }

  // Syncing is done on a clone: the live DOM is the agent's memory, and must
  // not be mutated just to serialize it.
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
      // Runs after an error too: whatever the model managed to add before it
      // failed is still on the page.
      makeEditable();
      win.setTimeout(() => { execDepth--; }, grace);
    }
  }

  // Attribute/text writes accumulate per key (node [+ attribute]):
  // - old — the oldValue of the very first HUMAN write for that key;
  // - override — if a later MODEL write follows a human one, override is its
  //   oldValue: exactly what the human left behind before the model rewrote the
  //   value (C2). A new human write resets override again.
  // - hasHuman — whether a human touched it at all; without that, no line is
  //   emitted.
  function applyRecord(entry, r) {
    if (!r.byModel) {
      if (!entry.hasHuman) entry.old = r.oldValue;
      entry.hasHuman = true;
      entry.override = undefined;
    } else if (entry.hasHuman && entry.override === undefined) {
      entry.override = r.oldValue;
    }
  }

  // Coalescing is mandatory: getAttribute at the moment a record is delivered
  // returns the current value, not the value at the time of the mutation.
  // The old value comes from the earliest human write; the new one from the
  // live DOM, unless the model rewrote it later (see applyRecord).
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
        // I5: moving a node there and back yields two childList records for the
        // same node — keep only the last one (a Map, not an array).
        for (const n of r.added) added.set(n, r.target);
      }
    }

    // M10: a node added within this same window is described once, via
    // serialize() on the "added" line — there must be no separate lines about
    // its attributes and text (including nested additions, such as the text
    // node produced by .textContent =).
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

    // C4: the baseline is not wiped wholesale after a build — it is re-seeded
    // with the current state of every touched field. Otherwise the next turn,
    // with no repeat focus (focus never left), would have nothing to compare
    // against.
    for (const el of dirty) {
      const state = fieldState(el);
      if (state === undefined) { baseline.delete(el); continue; } // I6
      const was = baseline.has(el) ? baseline.get(el) : (Array.isArray(state) ? [] : '');
      const wasStr = JSON.stringify(was);
      const nowStr = JSON.stringify(state);
      if (wasStr !== nowStr) {
        lines.push(path(el) + '  ' + wasStr + ' -> ' + nowStr);
        // A question typed into #q gets what it is about right under it.
        if (el.id === 'q') {
          const about = aboutLine();
          if (about) lines.push(about);
        }
      }
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
      // Skip only if both sides are whitespace: "\n " -> "hello" is a real edit.
      if (!String(entry.old ?? '').trim() && !String(now ?? '').trim()) continue;
      lines.push(path(node) + '  text: ' + JSON.stringify(entry.old) + ' -> ' + JSON.stringify(now));
    }
    for (const item of removed) {
      if (item.node.isConnected || addedNodes.has(item.node)) continue;
      if (isBlankText(item.node)) continue;
      lines.push('removed from ' + path(item.parent) + ': ' + serialize(item.node));
    }
    for (const [node, parent] of added) {
      if (!node.isConnected) continue;
      if (isBlankText(node)) continue;
      lines.push('added to ' + path(parent) + ': ' + serialize(node));
    }

    recs.length = 0;
    dirty.clear();
    modelTouched.clear();
    // Reset on every send: a follow-up question must not inherit a stale "this".
    pointer = null;
    return lines.join('\n');
  }

  async function handle(m) {
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'exec') {
      const r = await exec(m.code);
      send({ type: 'result', id: m.id, ok: r.ok, value: r.value, error: r.error });
    } else if (m.type === 'diff') {
      const text = buildDiff();
      if (m.clearInput) clearInput();
      send({ type: 'diff', id: m.id, text });
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
    // Pointing: a click on an element, or a text selection, anywhere but #q.
    // A click on the bare page background points at nothing in particular.
    doc.addEventListener('pointerdown', e => {
      if (!trusted(e)) return;
      const el = e.target;
      if (inInput(el) || el === doc.body || el === doc.documentElement) return;
      pointer = { node: el, selected: null };
    }, true);
    // The model's code can move the selection too, and the browser reports
    // that as a trusted event — so its execution window is excluded. A
    // collapsed selection is ignored rather than clearing the pointer: that is
    // what clicking into #q to type the question does.
    doc.addEventListener('selectionchange', e => {
      if (!trusted(e) || execDepth > 0) return;
      // Chrome reports text selected inside a focused field through the
      // document selection, anchored on the field's parent — selecting words of
      // the question itself would otherwise point at the whole page.
      const active = doc.activeElement;
      if (active && active.closest && active.closest('#q')) return;
      const sel = doc.getSelection ? doc.getSelection() : null;
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const text = String(sel);
      if (!text.trim()) return;
      const node = sel.getRangeAt(0).commonAncestorContainer;
      if (inInput(node)) return;
      pointer = { node: node.nodeType === 3 ? node.parentNode : node, selected: text };
    });
    // Ctrl/Cmd+Enter. A keyboard event does not bubble from the image up into
    // the shell — they are different origins — so the image reports the
    // keypress itself. trusted() filters out synthetic events: otherwise the
    // model's code could commit a turn on the human's behalf just by
    // dispatching a keydown.
    doc.addEventListener('keydown', e => {
      if (!trusted(e)) return;
      if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      send({ type: 'commit' });
    }, true);
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
