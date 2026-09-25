// A minimal DOM + webview-API shim for running the panel's webview scripts
// (src/runView.js, then src/panel.js — the order the page loads them) in node,
// driven the way the provider drives them: by delivering messages and reading
// back what the page posted and what vscode.setState() holds.
//
// It answers only what those scripts actually touch — a test double, not a
// browser. There is no layout: sizes and offsets are plain settable numbers a
// check sets itself (clientHeight defaults to 100, everything else to 0), events
// do not bubble, and a click fired on a disabled button is still delivered (the
// checks gate that themselves, as a browser would).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'src');

class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.value = '';
    this.textContent = '';
    this.title = '';
    this.checked = false;
    this.indeterminate = false;
    this.disabled = false;
    this.listeners = {};
    this._classes = new Set();
    this.classList = {
      add: (...c) => c.forEach(x => this._classes.add(x)),
      remove: (...c) => c.forEach(x => this._classes.delete(x)),
      contains: (c) => this._classes.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !this._classes.has(c) : !!on;
        if (want) this._classes.add(c); else this._classes.delete(c);
      }
    };
  }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get innerHTML() { return ''; }
  set innerHTML(_v) { this.children = []; }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  get parentNode() { return this._parent || null; }
  get parentElement() { return this._parent || null; }
  appendChild(c) { c._parent = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    c._parent = this;
    const i = this.children.indexOf(ref);
    this.children.splice(i < 0 ? this.children.length : i, 0, c);
    return c;
  }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  remove() { if (this._parent) this._parent.removeChild(this); }
  append(...nodes) { for (const n of nodes) this.appendChild(typeof n === 'string' ? Object.assign(new El('#text'), { textContent: n }) : n); }
  prepend(...nodes) { for (const n of nodes.reverse()) this.insertBefore(n, this.firstChild); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter(f => f !== fn); }
  /** Deliver an event to this element's own listeners (no bubbling); `extra`
   *  adds event fields such as `key` for a keydown. */
  fire(t, extra) {
    for (const fn of this.listeners[t] || []) {
      fn(Object.assign({ target: this, preventDefault() {}, stopPropagation() {} }, extra || {}));
    }
  }
  /** Depth-first search over what a render actually built. */
  find(pred) {
    for (const c of this.children) {
      if (pred(c)) return c;
      const hit = c.find(pred);
      if (hit) return hit;
    }
    return null;
  }
  /** Every match, depth-first. */
  findAll(pred, out = []) {
    for (const c of this.children) {
      if (pred(c)) out.push(c);
      c.findAll(pred, out);
    }
    return out;
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  /** Nearest self-or-ancestor matching a simple selector: `.class`, `#id`,
   *  `[attr]` or a tag name. */
  closest(sel) {
    const test = sel.startsWith('.') ? (e) => e._classes && e._classes.has(sel.slice(1))
      : sel.startsWith('#') ? (e) => e.id === sel.slice(1)
        : sel.startsWith('[') ? (e) => { const a = sel.slice(1, -1); return a.startsWith('data-') ? a.slice(5) in e.dataset : e[a] !== undefined; }
          : (e) => e.tagName === sel.toUpperCase();
    for (let e = this; e; e = e._parent) if (test(e)) return e;
    return null;
  }
  contains() { return false; }
  focus() { if (this._doc) this._doc.activeElement = this; }
  blur() { if (this._doc && this._doc.activeElement === this) this._doc.activeElement = null; }
  scrollIntoView() {}
  getBoundingClientRect() { return { top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 100 }; }
  setAttribute(k, v) {
    if (k === 'class') this.className = v;
    else if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
    this[k] = v;
  }
  getAttribute(k) { return this[k]; }
  hasAttribute(k) { return this[k] !== undefined; }
  removeAttribute(k) { delete this[k]; }
  get offsetHeight() { return 100; }
  get offsetWidth() { return 100; }
  get clientHeight() { return this._clientHeight ?? 100; }
  set clientHeight(v) { this._clientHeight = v; }
  get clientWidth() { return 100; }
  get scrollTop() { return this._scrollTop ?? 0; }
  set scrollTop(v) { this._scrollTop = v; }
  get offsetTop() { return this._offsetTop ?? 0; }
  set offsetTop(v) { this._offsetTop = v; }
}

// Every id panel.js resolves with $() at load or during a render.
const IDS = [
  'actionsBar', 'addOrg', 'banner', 'cancelBtn', 'clearCmdLog', 'clearSel', 'clearStatus', 'cmdlog',
  'cmdlogBody', 'cmdlogCaret', 'cmdlogHeader', 'deployBtn', 'diffBtn', 'fetchOrgBtn',
  'ignoreConflictsControl', 'ignoreDeployConflicts', 'modeAll', 'modeChanged', 'modeSelected',
  'orgSelect', 'queueStrip', 'refreshFiles', 'refreshOrgs', 'retrieveBtn', 'scanBanner', 'search',
  'selCount', 'sourceFilter', 'sourceFilterRow', 'splitter', 'status', 'statusHeader', 'testClasses',
  'testLevel', 'tree', 'typeFilterDetails', 'typeFilterLabel', 'typeFilterList', 'typeFilterRow',
  'useActive', 'useOpenTabs', 'validateBtn', 'viewModes',
  'typeFilterAll', 'typeFilterNone', 'treeTools', 'expandAll', 'collapseAll', 'orgAsOf', 'selectAllRows',
  'statusEarlier'
];

/** Boot one panel instance over the given persisted webview state. */
function panel(persisted) {
  const els = new Map();
  const doc = {
    body: new El('body'),
    activeElement: null,
    getElementById: (id) => els.get(id) || null,
    createElement: (tag) => Object.assign(new El(tag), { _doc: doc }),
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === '#viewModes button' ? els.get('viewModes').children.slice() : []),
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  for (const id of IDS) { const e = new El('div'); e.id = id; e._doc = doc; els.set(id, e); }
  // The three lens tabs are static markup in panelHtml.ts; renderViewModes finds
  // them via querySelectorAll('#viewModes button') and rewrites their text.
  for (const mode of ['all', 'selected', 'changed']) {
    const b = new El('button'); b.dataset.mode = mode; els.get('viewModes').appendChild(b);
  }
  const listeners = {};
  let stored = persisted ? JSON.parse(JSON.stringify(persisted)) : undefined;
  const outbound = [];
  // sendAction defers renderActions()/renderStatus() via requestAnimationFrame
  // (debugTiming/click-latency fix) so the click handler returns right after
  // postMessage — the whole point being that the outbound message exists BEFORE
  // the render runs. Captured here instead of firing immediately, so a check can
  // assert exactly that ordering, then call flush() to run the deferred render
  // and get the old "render already happened" behaviour back.
  const pendingFrames = [];
  // Every ResizeObserver the page creates, so a check can report a resize.
  const resizeObservers = [];
  class ResizeObserver {
    constructor(cb) { this.cb = cb; this.targets = new Set(); resizeObservers.push(this); }
    observe(t) { this.targets.add(t); }
    unobserve(t) { this.targets.delete(t); }
    disconnect() { this.targets.clear(); }
  }

  const sandbox = {
    console,
    setTimeout, clearTimeout, clearInterval,
    // The progress card's elapsed clock is a real setInterval; a panel left busy
    // at the end of a check must not keep this process alive.
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref(); return t; },
    requestAnimationFrame: (fn) => { pendingFrames.push(fn); return pendingFrames.length; },
    cancelAnimationFrame: () => {},
    // panel.js stamps clickSpan with performance.now() (sendAction, debugTiming) —
    // Date.now()-based is precise enough for these checks (they only need a
    // finite, non-negative number, not sub-ms resolution).
    performance: { now: () => Date.now() },
    ResizeObserver,
    acquireVsCodeApi: () => ({
      postMessage: (m) => outbound.push(m),
      getState: () => stored,
      setState: (s) => { stored = s; }
    }),
    document: doc,
    window: {
      innerHeight: 800,
      innerWidth: 600,
      addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
      removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter(f => f !== fn); }
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(SRC, 'runView.js'), 'utf8'), sandbox, { filename: 'runView.js' });
  vm.runInContext(fs.readFileSync(path.join(SRC, 'panel.js'), 'utf8'), sandbox, { filename: 'panel.js' });

  return {
    deliver: (msg) => { for (const fn of listeners.message || []) fn({ data: msg }); },
    // A snapshot, copied out of the sandbox realm so assert.deepStrictEqual
    // compares values rather than tripping over a foreign Array prototype.
    /** What the webview would restore from on the next rebuild. */
    persisted: () => (stored === undefined ? undefined : JSON.parse(JSON.stringify(stored))),
    /** The LIVE selection, read the way the user reads it (toolbar count). */
    liveCount: () => Number(/^(\d+)/.exec(els.get('selCount').textContent)?.[1] ?? -1),
    el: (id) => els.get(id),
    document: doc,
    outbound,
    pendingRenders: pendingFrames,
    resizeObservers,
    flush: () => { while (pendingFrames.length) pendingFrames.shift()(); }
  };
}

module.exports = { El, IDS, panel };
