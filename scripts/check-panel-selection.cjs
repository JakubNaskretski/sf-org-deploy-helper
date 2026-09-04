// Runnable contract test for the WEBVIEW's selection state (src/panel.js).
// No framework.   1) npm run compile   2) node scripts/check-panel-selection.cjs
//
// The checkbox selection is the most expensive thing in the panel to rebuild by
// hand, and it is now durable: written to webview state on every change and
// restored on rebuild. That makes three quiet behaviours worth pinning, none of
// which any provider-side suite can see:
//   1) the round trip — a change persists, and a scan that FINDS something prunes
//      keys that no longer exist and writes the prune back;
//   2) authority — an EMPTY scan (project discovery failed, or the scan hasn't
//      really run) must NOT be treated as proof the components are gone, or one
//      workspace hiccup destroys the selection permanently;
//   3) bounds and semantics — an unbounded key list is not persisted at all, and
//      a `selectKeys` message carrying `replace` sets the selection instead of
//      growing it (a success card's "Select these N" means exactly those N);
//   4) what a BACKGROUND rescan may do. The package directories are watched now, so
//      `files` arrives on any write under them — a scan nobody asked for, which can
//      catch the tree mid-write. It may not prune (a partial list is
//      indistinguishable from a deletion, and the prune is persisted), and an
//      equivalent list may not re-render: every render replaces the tree's
//      innerHTML, and scroll position and keyboard focus go with it;
//   5) the ⟳ Refresh-orgs button: locked while its request is in flight, freed
//      only by the provider's `orgsRefreshed` reply — not by an `orgs` broadcast;
//   6) the type filter: All / None are a static row ABOVE the scrolling list (they
//      used to be its last child, out of view past ~8 types), each row has an
//      "only" shortcut, every write lands in one funnel that keeps the persisted
//      contract ([] = all, ['__none__'] = none, plain names otherwise) — the
//      sentinel never mixes with names, never reads two-of-three as All, and
//      survives the explicit scan a webview rebuild starts with. A type seen for
//      the FIRST time joins a plain-names filter so it shows, and OmniStudio's
//      user-facing names (FlexCard, DataRaptor, …) are searchable aliases;
//   7) Expand all / Collapse all above the tree: every group the CURRENT lens and
//      filters draw, at every depth, in the same key grammar renderTree reads;
//      disabled (with the reason) while the render force-expands anyway;
//   8) double-click guards: a slot-taking click locks its control (and the other
//      slot-taking ones) synchronously until the provider's `busy` reply —
//      Deploy/Validate/Retry queue while busy but never send while pending —
//      Rescan locks until `filesRefreshed`, and a repeated `busy` post is a
//      no-op for the progress card and the Status pane.
//
// panel.js is a browser-only IIFE with no exports, so it is run inside a minimal
// DOM/vscode-API shim and driven the way the provider drives it: by delivering
// messages and reading back what vscode.setState() holds. The shim answers only
// what panel.js actually touches — it is a test double, not a browser.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PANEL_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'panel.js'), 'utf8');

let failed = 0;
let ran = 0;
function check(name, fn) {
  ran++;
  try { fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}

// ------------------------------------------------------------------ DOM shim
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
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter(f => f !== fn); }
  fire(t) {
    for (const fn of this.listeners[t] || []) {
      fn({ target: this, preventDefault() {}, stopPropagation() {} });
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
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  contains() { return false; }
  focus() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 100 }; }
  setAttribute(k, v) { this[k] = v; }
  getAttribute(k) { return this[k]; }
  get offsetHeight() { return 100; }
  get offsetWidth() { return 100; }
  get clientHeight() { return 100; }
  get clientWidth() { return 100; }
  get scrollTop() { return 0; }
  set scrollTop(_v) {}
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
  'typeFilterAll', 'typeFilterNone', 'treeTools', 'expandAll', 'collapseAll'
];

/** Boot one panel instance over the given persisted webview state. */
function panel(persisted) {
  const els = new Map();
  for (const id of IDS) { const e = new El('div'); e.id = id; els.set(id, e); }
  // The three lens tabs are static markup in panelHtml.ts; renderViewModes finds
  // them via querySelectorAll('#viewModes button') and rewrites their text.
  for (const mode of ['all', 'selected', 'changed']) {
    const b = new El('button'); b.dataset.mode = mode; els.get('viewModes').appendChild(b);
  }
  const listeners = {};
  let stored = persisted ? JSON.parse(JSON.stringify(persisted)) : undefined;
  const outbound = [];

  const sandbox = {
    console,
    setTimeout, clearTimeout, clearInterval,
    // The progress card's elapsed clock is a real setInterval; a panel left busy
    // at the end of a check must not keep this process alive.
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref(); return t; },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    acquireVsCodeApi: () => ({
      postMessage: (m) => outbound.push(m),
      getState: () => stored,
      setState: (s) => { stored = s; }
    }),
    document: {
      body: new El('body'),
      getElementById: (id) => els.get(id) || null,
      createElement: (tag) => new El(tag),
      querySelector: () => null,
      querySelectorAll: (sel) => (sel === '#viewModes button' ? els.get('viewModes').children.slice() : []),
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    window: {
      innerHeight: 800,
      innerWidth: 600,
      addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
      removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter(f => f !== fn); }
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(PANEL_JS, sandbox, { filename: 'panel.js' });

  return {
    deliver: (msg) => { for (const fn of listeners.message || []) fn({ data: msg }); },
    // A snapshot, copied out of the sandbox realm so assert.deepStrictEqual
    // compares values rather than tripping over a foreign Array prototype.
    /** What the webview would restore from on the next rebuild. */
    persisted: () => (stored === undefined ? undefined : JSON.parse(JSON.stringify(stored))),
    /** The LIVE selection, read the way the user reads it (toolbar count). */
    liveCount: () => Number(/^(\d+)/.exec(els.get('selCount').textContent)?.[1] ?? -1),
    el: (id) => els.get(id),
    outbound
  };
}

// ------------------------------------------------------------------ fixtures
const cls = (name) => ({ type: 'ApexClass', name, filePath: `/ws/force-app/classes/${name}.cls`, files: [] });
const FILES = (names) => ({ type: 'files', objectChildTypes: [], items: names.map(cls) });
const KEY = (name) => `ApexClass:${name}`;
const THREE = ['AcmeOrderService', 'AcmeOrderServiceTest', 'AcmeInvoiceService'];
const RESTORED = { selected: THREE.map(KEY), expandedGroups: [], filter: '', typeFilter: [], viewMode: 'all', testClasses: '' };

// --------------------------------------------------------- 1) the round trip
check('a restored selection is live after the scan lands', () => {
  const p = panel(RESTORED);
  p.deliver(FILES(THREE));
  assert.strictEqual(p.liveCount(), 3);
  assert.deepStrictEqual(p.persisted().selected.slice().sort(), THREE.map(KEY).sort());
});

check('a key deleted between sessions is pruned by a real scan, and the prune persists', () => {
  const p = panel(RESTORED);
  p.deliver(FILES(['AcmeOrderService', 'AcmeOrderServiceTest'])); // AcmeInvoiceService is gone
  assert.strictEqual(p.liveCount(), 2);
  assert.deepStrictEqual(p.persisted().selected.slice().sort(), [KEY('AcmeOrderService'), KEY('AcmeOrderServiceTest')].sort());
});

check('a selection change is written back immediately', () => {
  const p = panel(RESTORED);
  p.deliver(FILES(THREE));
  p.deliver({ type: 'selectKeys', keys: [] }); // no-op message, nothing should change
  assert.strictEqual(p.persisted().selected.length, 3);
  p.el('clearSel').fire('click');
  assert.deepStrictEqual(p.persisted().selected, []);
  assert.strictEqual(p.liveCount(), 0);
});

// ------------------------------------------------ 2) who may prune (authority)
check('an EMPTY scan does not wipe the restored selection, in memory or on disk', () => {
  // The exact payload applyProjectDiscoveryFailure puts on the wire: project
  // discovery failed (multi-root workspace, sfdx-project.json not synced yet), so
  // there is no scan to prune against — only an absence.
  const p = panel(RESTORED);
  p.deliver({ type: 'files', objectChildTypes: [], items: [] });
  assert.strictEqual(p.liveCount(), 3, 'the live selection was thrown away');
  assert.deepStrictEqual(p.persisted().selected.slice().sort(), THREE.map(KEY).sort(), 'the wipe was persisted');
});

check('…and the selection is still there once the workspace is fixed and rescanned', () => {
  const p = panel(RESTORED);
  p.deliver({ type: 'files', objectChildTypes: [], items: [] });
  p.deliver(FILES(THREE));
  assert.strictEqual(p.liveCount(), 3);
  assert.deepStrictEqual(p.persisted().selected.slice().sort(), THREE.map(KEY).sort());
});

check('the discovery-failure SEQUENCE does not wipe it either', () => {
  // applyProjectDiscoveryFailure posts orgMetadataReset FIRST and the empty
  // `files` second. On a fresh webview localKeys is still empty at the first
  // message, so guarding only the second one would leave the wipe intact.
  const p = panel(RESTORED);
  p.deliver({ type: 'orgMetadataReset' });
  p.deliver({ type: 'files', objectChildTypes: [], items: [] });
  assert.strictEqual(p.liveCount(), 3);
  assert.deepStrictEqual(p.persisted().selected.slice().sort(), THREE.map(KEY).sort());
});

check('an org switch still drops org-only keys once a scan exists', () => {
  // The prune itself must survive the guard: after a real scan, a key that only
  // ever existed on the org has nothing local behind it and has to go.
  const p = panel({ ...RESTORED, selected: [] });
  p.deliver(FILES(['AcmeOrderService']));
  p.deliver({ type: 'orgMetadata', orgLabel: 'acme-dev', orgItems: [{ type: 'ApexClass', name: 'AcmeOrgOnlyService' }] });
  p.deliver({ type: 'selectKeys', keys: [KEY('AcmeOrderService'), KEY('AcmeOrgOnlyService')] });
  assert.strictEqual(p.liveCount(), 2);
  p.deliver({ type: 'orgMetadataReset' });
  assert.deepStrictEqual(p.persisted().selected, [KEY('AcmeOrderService')]);
});

check('an empty scan does not wipe the type filter either', () => {
  const p = panel({ ...RESTORED, typeFilter: ['ApexClass'] });
  p.deliver({ type: 'files', objectChildTypes: [], items: [] });
  assert.deepStrictEqual(p.persisted().typeFilter, ['ApexClass']);
});

// --------------------------------------------------------------- 3a) bounds
check('an unbounded selection is OMITTED from webview state, never truncated', () => {
  // One click on a group checkbox can tick every component under it. A truncated
  // copy would restore fewer components than the user ticked — silently — so past
  // the cap nothing is written at all.
  const many = Array.from({ length: 2500 }, (_, i) => `AcmeGen${i}`);
  const p = panel(null);
  p.deliver(FILES(many));
  p.deliver({ type: 'selectKeys', keys: many.map(KEY) });
  assert.strictEqual(p.liveCount(), 2500, 'the live selection must be untouched by the cap');
  assert.strictEqual(p.persisted().selected, undefined);
  // Other persisted keys still ride along — only the key list is dropped.
  assert.strictEqual(p.persisted().viewMode, 'all');
});

check('a selection back under the cap is persisted again', () => {
  const many = Array.from({ length: 2500 }, (_, i) => `AcmeGen${i}`);
  const p = panel(null);
  p.deliver(FILES(many));
  p.deliver({ type: 'selectKeys', keys: many.map(KEY) });
  p.deliver({ type: 'selectKeys', keys: [KEY('AcmeGen0')], replace: true });
  assert.deepStrictEqual(p.persisted().selected, [KEY('AcmeGen0')]);
});

// ---------------------------------------------------------- 3b) replace vs add
check('selectKeys is ADDITIVE by default (suggestion flow, "Use open tabs")', () => {
  const p = panel({ ...RESTORED, selected: [KEY('AcmeOrderService')] });
  p.deliver(FILES(THREE));
  p.deliver({ type: 'selectKeys', keys: [KEY('AcmeInvoiceService')], scroll: true });
  assert.strictEqual(p.liveCount(), 2);
  assert.deepStrictEqual(p.persisted().selected.slice().sort(), [KEY('AcmeInvoiceService'), KEY('AcmeOrderService')].sort());
});

check('selectKeys with replace SETS the selection (a success card\'s "Select these N")', () => {
  // The card names a count and the follow-ups it exists for — diff or retrieve
  // exactly what just went up — are wrong against a union with unrelated work.
  const p = panel(RESTORED);
  p.deliver(FILES(THREE));
  p.deliver({ type: 'selectKeys', keys: [KEY('AcmeInvoiceService')], scroll: true, replace: true });
  assert.strictEqual(p.liveCount(), 1, 'the selection grew instead of being replaced');
  assert.deepStrictEqual(p.persisted().selected, [KEY('AcmeInvoiceService')]);
});

check('replace also re-snapshots the Selected lens instead of stranding old rows', () => {
  const p = panel({ ...RESTORED, viewMode: 'selected' });
  p.deliver(FILES(THREE));
  p.deliver({ type: 'selectKeys', keys: [KEY('AcmeInvoiceService')], replace: true });
  const rows = [];
  p.el('tree').find(e => { if (e.tagName === 'SPAN' && /Acme/.test(e.textContent)) rows.push(e.textContent); return false; });
  assert.deepStrictEqual(rows, ['AcmeInvoiceService'], `lens still lists: ${rows.join(', ')}`);
});

// ------------------------------------------ the Changed lens's bulk selection
// "Select all (N)" reads the GROUP data, not the DOM, so the render cap can't
// shrink what the button promises — and it is gated to local components, because
// an org-only row has no source to deploy.
function changedPanel() {
  const p = panel({ ...RESTORED, selected: [], viewMode: 'changed' });
  p.deliver(FILES(['AcmeOrderService', 'AcmeInvoiceService']));
  p.deliver({
    type: 'orgMetadata', orgLabel: 'acme-dev',
    orgItems: [{ type: 'ApexClass', name: 'AcmeOrderService' }, { type: 'ApexClass', name: 'AcmeOrgOnlyService' }]
  });
  p.deliver({ type: 'changed', keys: [KEY('AcmeOrderService'), KEY('AcmeInvoiceService'), KEY('AcmeOrgOnlyService')] });
  return { p, button: p.el('tree').find(e => /^Select all/.test(e.textContent)) };
}

check('Select all counts only the components that exist locally', () => {
  const { button } = changedPanel();
  assert.ok(button, 'the Changed lens header offered no Select all');
  assert.strictEqual(button.textContent, 'Select all (2)', 'an org-only row must not be counted');
});

check('Select all selects exactly those, with no duplicates', () => {
  const { p, button } = changedPanel();
  button.fire('click');
  assert.strictEqual(p.liveCount(), 2);
  assert.deepStrictEqual(
    p.persisted().selected.slice().sort(),
    [KEY('AcmeInvoiceService'), KEY('AcmeOrderService')].sort()
  );
});

// ------------------------------------------- 4) what a background rescan may do
// A watcher-driven rescan is marked `silent`. It is not authoritative: it may add
// and remove rows, but it may not delete the user's selection, and it may not
// repaint a tree that would come out identical.
const SILENT = (names) => ({ ...FILES(names), silent: true });
// Object identity of what the tree is built from: renderTree clears innerHTML, so a
// surviving node is proof the tree was NOT rebuilt — which is what scroll position
// and keyboard focus ride on.
const rows = (p) => p.el('tree').children[0];
// Component names rendered as rows (groups are expanded via `expandedGroups`).
const labels = (p) => {
  const out = [];
  p.el('tree').find(e => { if (e.tagName === 'SPAN' && /^Acme/.test(e.textContent)) out.push(e.textContent); return false; });
  return out;
};
const EXPANDED = { ...RESTORED, expandedGroups: ['ApexClass'] };

check('a SILENT rescan may not prune the selection, in memory or on disk', () => {
  // The transient case this exists for: a checkout, a branch switch, an editor
  // writing a temp tree — the walk lands mid-write and reports a PARTIAL list,
  // which is indistinguishable from a real deletion. Acting on it destroys a
  // selection the user built by hand, and persists the loss.
  const p = panel(RESTORED);
  p.deliver(FILES(THREE));
  p.deliver(SILENT(['AcmeOrderService']));
  assert.strictEqual(p.liveCount(), 3, 'a background rescan threw the live selection away');
  assert.deepStrictEqual(p.persisted().selected.slice().sort(), THREE.map(KEY).sort(), 'and persisted the loss');
});

check('…and the next EXPLICIT scan prunes exactly as it always did', () => {
  const p = panel(RESTORED);
  p.deliver(FILES(THREE));
  p.deliver(SILENT(['AcmeOrderService']));
  p.deliver(FILES(['AcmeOrderService']));
  assert.strictEqual(p.liveCount(), 1);
  assert.deepStrictEqual(p.persisted().selected, [KEY('AcmeOrderService')]);
});

check('a silent rescan still SHOWS what changed on disk', () => {
  // Not pruning is not the same as not updating: the new class is the bug the
  // watcher exists for.
  const p = panel({ ...EXPANDED, selected: [] });
  p.deliver(FILES(THREE));
  p.deliver(SILENT([...THREE, 'AcmeShipmentService']));
  assert.ok(labels(p).includes('AcmeShipmentService'), `new component missing from the tree: ${labels(p).join(', ')}`);
});

check('a silent rescan does not touch the type filter either', () => {
  const p = panel({ ...RESTORED, typeFilter: ['ApexTrigger'] });
  p.deliver(FILES(THREE));                 // explicit: ApexTrigger is stale, it goes
  assert.deepStrictEqual(p.persisted().typeFilter, []);
  const q = panel({ ...RESTORED, typeFilter: ['ApexTrigger'] });
  q.deliver(SILENT(THREE));
  assert.deepStrictEqual(q.persisted().typeFilter, ['ApexTrigger'], 'a background scan is not proof the type is gone');
});

check('an identical item list does not rebuild the tree', () => {
  const p = panel(EXPANDED);
  p.deliver(FILES(THREE));
  const before = rows(p);
  assert.ok(before, 'nothing was rendered to begin with');
  p.deliver(SILENT(THREE));
  assert.strictEqual(rows(p), before, 'the tree was rebuilt for an identical list — scroll position and focus are gone');
  p.deliver(FILES(THREE));
  assert.strictEqual(rows(p), before, '…and an explicit rescan finding the same thing is no different');
});

check('a real change renders immediately', () => {
  const p = panel({ ...EXPANDED, selected: [] });
  p.deliver(FILES(THREE));
  const before = rows(p);
  p.deliver(SILENT([...THREE, 'AcmeShipmentService']));
  assert.notStrictEqual(rows(p), before, 'a new component must reach the tree at once');
  p.deliver(SILENT(THREE));
  assert.deepStrictEqual(labels(p).sort(), THREE.slice().sort(), 'a deleted component must leave it');
});

check('a change the tree RENDERS counts as a change, not just the key list', () => {
  // Same components, moved on disk: the row tooltip is the file path, and the
  // multi-file badge counts `files`.
  const p = panel({ ...EXPANDED, selected: [] });
  p.deliver(FILES(THREE));
  const before = rows(p);
  const moved = FILES(THREE);
  moved.items[0] = { ...moved.items[0], filePath: '/ws/force-app/other/AcmeOrderService.cls' };
  p.deliver(moved);
  assert.notStrictEqual(rows(p), before);
  const withMeta = FILES(THREE);
  const after = rows(p);
  withMeta.items[0] = { ...withMeta.items[0], filePath: '/ws/force-app/other/AcmeOrderService.cls', files: ['a', 'b'] };
  p.deliver(withMeta);
  assert.notStrictEqual(rows(p), after);
});

check('the render skip cannot mask the org-only / local merge', () => {
  const p = panel({ ...EXPANDED, selected: [] });
  p.deliver(FILES(THREE));
  p.deliver({ type: 'orgMetadata', orgLabel: 'acme-dev', orgItems: [{ type: 'ApexClass', name: 'AcmeOrgOnlyService' }] });
  assert.ok(labels(p).includes('AcmeOrgOnlyService'), 'the org-only row never rendered');
  p.deliver(SILENT(THREE));
  assert.ok(labels(p).includes('AcmeOrgOnlyService'), 'a background rescan dropped the org-only row');
  // Retrieved since: it exists locally now, and must be one row, not two.
  p.deliver(SILENT([...THREE, 'AcmeOrgOnlyService']));
  assert.deepStrictEqual(labels(p).filter(n => n === 'AcmeOrgOnlyService'), ['AcmeOrgOnlyService']);
});

check('a prune still repaints, even when the item list is identical', () => {
  const p = panel({ ...EXPANDED, selected: [] });
  p.deliver(FILES(THREE));
  p.deliver({ type: 'selectKeys', keys: [KEY('AcmeGhostService')] }); // no scan will vouch for it
  const before = rows(p);
  p.deliver(FILES(THREE));
  assert.strictEqual(p.liveCount(), 0, 'the ghost key survived an explicit scan');
  assert.notStrictEqual(rows(p), before, 'the checkboxes changed — the tree has to be repainted');
});

check('the FIRST payload always renders, empty list included', () => {
  const p = panel(RESTORED);
  p.deliver({ type: 'files', objectChildTypes: [], items: [] });
  assert.ok(rows(p), 'the empty-workspace message never rendered');
});

// --------------------------------------------------- the Changed lens repaints
// Every scan ends by recomputing this lens, so an unconditional render here would
// undo the skip above one message later.
check('an identical Changed payload does not rebuild the tree either', () => {
  const p = panel({ ...EXPANDED, viewMode: 'changed' });
  p.deliver(FILES(THREE));
  p.deliver({ type: 'changed', keys: [KEY('AcmeOrderService')] });
  const before = rows(p);
  p.deliver({ type: 'changed', keys: [KEY('AcmeOrderService')] });
  assert.strictEqual(rows(p), before);
});

check('key ORDER is not a change — git has no reason to be stable about it', () => {
  const p = panel({ ...EXPANDED, viewMode: 'changed' });
  p.deliver(FILES(THREE));
  p.deliver({ type: 'changed', keys: [KEY('AcmeOrderService'), KEY('AcmeInvoiceService')] });
  const before = rows(p);
  p.deliver({ type: 'changed', keys: [KEY('AcmeInvoiceService'), KEY('AcmeOrderService')] });
  assert.strictEqual(rows(p), before);
});

check('a component that just changed appears at once', () => {
  const p = panel({ ...EXPANDED, viewMode: 'changed' });
  p.deliver(FILES(THREE));
  p.deliver({ type: 'changed', keys: [KEY('AcmeOrderService')] });
  const before = rows(p);
  p.deliver({ type: 'changed', keys: [KEY('AcmeOrderService'), KEY('AcmeInvoiceService')] });
  assert.notStrictEqual(rows(p), before);
  assert.deepStrictEqual(labels(p).sort(), ['AcmeInvoiceService', 'AcmeOrderService']);
});

check('change detection going UNAVAILABLE is a change, not an empty list', () => {
  // `null` keys and `[]` keys render different empty states ("change detection
  // unavailable" vs "nothing changed"), so they are different payloads even when
  // nothing else in the message distinguishes them.
  const p = panel({ ...EXPANDED, viewMode: 'changed' });
  p.deliver(FILES(THREE));
  p.deliver({ type: 'changed', keys: [] });
  const before = rows(p);
  p.deliver({ type: 'changed', keys: null });
  assert.notStrictEqual(rows(p), before, 'the tree still claims to know what changed');
  const after = rows(p);
  p.deliver({ type: 'changed', keys: null, reason: 'workspace is not a git repository' });
  assert.notStrictEqual(rows(p), after, 'the reason has to reach the user');
});

check('a base-ref switch repaints even with the same key set', () => {
  // The lens header names the ref it compares against — same keys, different story.
  const p = panel({ ...EXPANDED, viewMode: 'changed' });
  p.deliver(FILES(THREE));
  p.deliver({ type: 'changed', keys: [KEY('AcmeOrderService')] });
  const before = rows(p);
  p.deliver({ type: 'changed', keys: [KEY('AcmeOrderService')], base: 'origin/main' });
  assert.notStrictEqual(rows(p), before);
});

// ------------------------------------------ 5) the ⟳ Refresh-orgs button
// A successful refresh re-renders the same dropdown, so the button itself is
// the feedback: it locks (and spins) on click, stacks no second request, and
// unlocks only on the provider's `orgsRefreshed` reply to that request — an
// `orgs` broadcast (org switch mid-listing) must not free it early.
check('⟳ locks on click, ignores repeats, survives an orgs broadcast, unlocks on its reply', () => {
  const p = panel(undefined);
  const btn = p.el('refreshOrgs');
  const sent = () => p.outbound.filter(m => m.type === 'refreshOrgs').length;
  btn.fire('click');
  assert.strictEqual(sent(), 1);
  assert.strictEqual(btn.disabled, true);
  assert.ok(btn.classList.contains('loading'));
  btn.fire('click'); // repeat while in flight — must not spawn another `sf org list`
  assert.strictEqual(sent(), 1);
  // An org switch mid-listing re-broadcasts `orgs` — that is NOT this request's answer.
  p.deliver({ type: 'orgs', orgs: [], selected: null });
  assert.strictEqual(btn.disabled, true);
  btn.fire('click');
  assert.strictEqual(sent(), 1);
  p.deliver({ type: 'orgsRefreshed' });
  assert.strictEqual(btn.disabled, false);
  assert.ok(!btn.classList.contains('loading'));
  assert.strictEqual(btn.title, 'Refresh org list');
  btn.fire('click'); // and it works again afterwards
  assert.strictEqual(sent(), 2);
});

check('the provider replies orgsRefreshed however the listing ends', () => {
  // The unlock has exactly one trigger, so the reply must be unconditional: the
  // exact shape is pinned — a guard, or a plain await outside a finally, fails here.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'panelProvider.ts'), 'utf8');
  const shape = /case 'refreshOrgs':(?:\n\s*\/\/[^\n]*)*\n\s*try \{ await this\.loadOrgs\(true\); \} finally \{ this\.post\(\{ type: 'orgsRefreshed' \}\); \}\n\s*return;/;
  assert.ok(shape.test(src), "refreshOrgs handler must be exactly: try { await this.loadOrgs(true); } finally { this.post({ type: 'orgsRefreshed' }); }");
});

// ---------------------------------------------------------- 6) the type filter
// Driven the way the user drives it: the static All / None buttons, a row's
// "only" button, and its checkbox (set `checked`, fire 'change' — the shim has
// no click-to-toggle). Read back through the persisted filter, the summary
// label, and the group headers the tree actually built.
const item = (type, name) => ({ type, name, filePath: `/ws/force-app/${type}/${name}`, files: [] });
const TFILES = (items, objectChildTypes = []) => ({ type: 'files', objectChildTypes, items });
const THREE_TYPES = [item('ApexClass', 'AcmeA'), item('ApexTrigger', 'AcmeT'), item('Flow', 'AcmeF')];
const NESTED = [item('CustomObject', 'Acme__c'), item('CustomField', 'Acme__c.Foo__c'), item('ApexClass', 'AcmeA')];
const BASE = { selected: [], expandedGroups: [], filter: '', typeFilter: [], viewMode: 'all', testClasses: '' };
const HTML_TS = fs.readFileSync(path.join(__dirname, '..', 'src', 'panelHtml.ts'), 'utf8');

const label = (p) => p.el('typeFilterLabel').textContent;
const groups = (p) => { const o = []; p.el('tree').find(e => { if (e.className === 'group-header') o.push(e.children[2].textContent); return false; }); return o; };
const names = (p) => { const o = []; p.el('tree').find(e => { if (e.className === 'name') o.push(e.textContent); return false; }); return o; };
const onlyBtn = (p, type) => p.el('typeFilterList').find(e => e.tagName === 'BUTTON' && e.textContent === 'only' && e.title === `Show only ${type}`);
const rowLabel = (p, type) => { const b = onlyBtn(p, type); return b && b.parentNode.children[0]; };
const tab = (p, mode) => p.el('viewModes').children.find(b => b.dataset.mode === mode).textContent;

// ---- 9. lens tab counts honour the type filter (0.22.0) ----
check('Selected / Changed tab counts follow the type filter, like the rows do', () => {
  const p = panel();
  p.deliver({ type: 'files', objectChildTypes: [], items: [item('ApexClass', 'A1'), item('ApexClass', 'A2'), item('Flow', 'F1')] });
  p.deliver({ type: 'selectKeys', keys: ['ApexClass:A1', 'ApexClass:A2', 'Flow:F1'], replace: true });
  p.deliver({ type: 'changed', keys: ['ApexClass:A1', 'Flow:F1'] });
  assert.strictEqual(tab(p, 'selected'), 'Selected (3)');
  assert.strictEqual(tab(p, 'changed'), 'Changed (2)');
  onlyBtn(p, 'Flow').fire('click');
  assert.strictEqual(tab(p, 'selected'), 'Selected (1)', 'only Flow → one selected row visible');
  assert.strictEqual(tab(p, 'changed'), 'Changed (1)');
  assert.strictEqual(p.liveCount(), 3, 'the live selection itself is untouched by the filter');
  p.el('typeFilterNone').fire('click');
  assert.strictEqual(tab(p, 'selected'), 'Selected', 'nothing visible → bare label');
  p.el('typeFilterAll').fire('click');
  assert.strictEqual(tab(p, 'selected'), 'Selected (3)');
  assert.strictEqual(tab(p, 'all'), 'All');
});
const tick = (p, type, on) => { const lbl = rowLabel(p, type); assert.ok(lbl, `no row for ${type}`); const cb = lbl.children[0]; cb.checked = on; cb.fire('change'); };
const treeText = (p) => { const o = []; p.el('tree').find(e => { if (e.className === 'status-empty') o.push(e.textContent); return false; }); return o; };

check('All / None are not inside the scrolling list', () => {
  const p = panel(BASE);
  p.deliver(TFILES(THREE_TYPES));
  assert.ok(!p.el('typeFilterList').find(e => e.classList.contains('type-filter-actions')), 'the action row is still appended to the list');
  for (const c of p.el('typeFilterList').children) assert.strictEqual(c.className, 'type-row', `unexpected list child ${c.tagName}.${c.className}`);
  assert.strictEqual(p.el('typeFilterList').children.length, 3);
});

check('the markup puts #typeFilterActions above #typeFilterList, inside the same <details>', () => {
  const shape = /<details id="typeFilterDetails">\s*<summary>[\s\S]*?<\/summary>\s*<div id="typeFilterActions" class="type-filter-actions">\s*<button id="typeFilterAll"[^>]*>All<\/button>\s*<button id="typeFilterNone"[^>]*>None<\/button>\s*<\/div>\s*<div id="typeFilterList" class="type-filter-list"><\/div>\s*<\/details>/;
  assert.ok(shape.test(HTML_TS), 'panelHtml.ts: All/None must be a static row between <summary> and #typeFilterList');
});

check('the "only" button sits outside the <label>, so its click is not a checkbox toggle', () => {
  const p = panel(BASE);
  p.deliver(TFILES(THREE_TYPES));
  const b = onlyBtn(p, 'ApexClass');
  assert.ok(b, 'no only button');
  assert.strictEqual(b.parentNode.className, 'type-row');
  assert.strictEqual(b.parentNode.children[0].tagName, 'LABEL');
  assert.ok(!b.parentNode.children[0].find(e => e === b), 'the button is a child of the label');
});

check('None empties the tree and persists the sentinel; All restores and persists empty', () => {
  const p = panel(BASE);
  p.deliver(TFILES(THREE_TYPES));
  assert.strictEqual(p.el('typeFilterAll').disabled, true, 'All has nothing to do while every type shows');
  assert.strictEqual(p.el('typeFilterNone').disabled, false);
  p.el('typeFilterNone').fire('click');
  assert.deepStrictEqual(p.persisted().typeFilter, ['__none__']);
  assert.strictEqual(label(p), '0 of 3 types');
  assert.deepStrictEqual(groups(p), []);
  assert.strictEqual(p.el('typeFilterNone').disabled, true);
  assert.strictEqual(p.el('typeFilterAll').disabled, false);
  p.el('typeFilterAll').fire('click');
  assert.deepStrictEqual(p.persisted().typeFilter, []);
  assert.strictEqual(label(p), 'All types (3)');
  assert.deepStrictEqual(groups(p), ['ApexClass', 'ApexTrigger', 'Flow']);
});

check('"only" narrows to one type in one click, and replaces rather than adds', () => {
  const p = panel(BASE);
  p.deliver(TFILES(THREE_TYPES));
  const b = onlyBtn(p, 'ApexTrigger');
  assert.ok(b, 'no only button on the ApexTrigger row');
  b.fire('click');
  assert.deepStrictEqual(p.persisted().typeFilter, ['ApexTrigger']);
  assert.strictEqual(label(p), '1 of 3 types');
  assert.deepStrictEqual(groups(p), ['ApexTrigger']);
  onlyBtn(p, 'Flow').fire('click');
  assert.deepStrictEqual(p.persisted().typeFilter, ['Flow']);
  assert.deepStrictEqual(groups(p), ['Flow']);
});

check('"only" on the single type in the workspace reads as All', () => {
  const p = panel(BASE);
  p.deliver(TFILES([item('ApexClass', 'AcmeA')]));
  onlyBtn(p, 'ApexClass').fire('click');
  assert.deepStrictEqual(p.persisted().typeFilter, []);
  assert.strictEqual(label(p), 'All types (1)');
});

check('None then ticking one type never mixes the sentinel in, and two of three is not All', () => {
  const p = panel(BASE);
  p.deliver(TFILES(THREE_TYPES));
  p.el('typeFilterNone').fire('click');
  tick(p, 'ApexClass', true);
  assert.deepStrictEqual(p.persisted().typeFilter, ['ApexClass']);
  assert.strictEqual(label(p), '1 of 3 types');
  assert.deepStrictEqual(groups(p), ['ApexClass']);
  tick(p, 'ApexTrigger', true);
  assert.deepStrictEqual(p.persisted().typeFilter.slice().sort(), ['ApexClass', 'ApexTrigger']);
  assert.strictEqual(label(p), '2 of 3 types', 'two of three ticked must not read as All');
  assert.deepStrictEqual(groups(p), ['ApexClass', 'ApexTrigger']);
});

check('unticking from All seeds the rest; re-ticking the last collapses back to All; unticking all is None', () => {
  const p = panel(BASE);
  p.deliver(TFILES(THREE_TYPES));
  tick(p, 'Flow', false);
  assert.deepStrictEqual(p.persisted().typeFilter.slice().sort(), ['ApexClass', 'ApexTrigger']);
  assert.strictEqual(label(p), '2 of 3 types');
  tick(p, 'Flow', true);
  assert.deepStrictEqual(p.persisted().typeFilter, []);
  assert.strictEqual(label(p), 'All types (3)');
  tick(p, 'ApexClass', false); tick(p, 'ApexTrigger', false); tick(p, 'Flow', false);
  assert.deepStrictEqual(p.persisted().typeFilter, ['__none__'], 'unticking the last type is None, not All');
});

check('None survives the explicit scan every webview rebuild starts with', () => {
  const p = panel({ ...BASE, typeFilter: ['__none__'] });
  p.deliver(TFILES(THREE_TYPES));
  assert.deepStrictEqual(p.persisted().typeFilter, ['__none__']);
  assert.strictEqual(label(p), '0 of 3 types');
  assert.deepStrictEqual(treeText(p), ['No metadata matches the current filter.']);
});

check('a mixed sentinel persisted by 0.20.x is repaired by the first scan', () => {
  const p = panel({ ...BASE, typeFilter: ['__none__', 'ApexClass'] });
  p.deliver(TFILES(THREE_TYPES));
  assert.deepStrictEqual(p.persisted().typeFilter, ['ApexClass']);
  assert.strictEqual(label(p), '1 of 3 types');
  assert.deepStrictEqual(groups(p), ['ApexClass']);
});

check('a prune that leaves every known type ticked reads as All', () => {
  const p = panel({ ...BASE, typeFilter: ['ApexClass', 'ApexTrigger', 'Flow'] });
  p.deliver(TFILES(THREE_TYPES.slice(0, 2)));
  assert.deepStrictEqual(p.persisted().typeFilter, []);
  assert.strictEqual(label(p), 'All types (2)');
});

check('the type filter gates org-only rows too, and counts org-only types', () => {
  const p = panel({ ...BASE, typeFilter: ['ApexClass'] });
  p.deliver(TFILES(THREE_TYPES));
  p.deliver({ type: 'orgMetadata', orgLabel: 'acme-dev', orgItems: [{ type: 'Layout', name: 'AcmeLayout' }] });
  assert.deepStrictEqual(groups(p), ['ApexClass']);
  assert.strictEqual(label(p), '1 of 4 types');
  onlyBtn(p, 'Layout').fire('click');
  assert.deepStrictEqual(groups(p), ['Layout']);
});

check('the Changed lens owns up to the type / source filter hiding its rows', () => {
  const p = panel({ ...BASE, typeFilter: ['Flow'], viewMode: 'changed' });
  p.deliver(TFILES(THREE_TYPES));
  p.deliver({ type: 'changed', keys: ['ApexClass:AcmeA'] });
  assert.deepStrictEqual(treeText(p), ['No changed component matches the current filter.']);
  const q = panel({ ...BASE, viewMode: 'changed' });
  q.deliver(TFILES(THREE_TYPES));
  q.deliver({ type: 'changed', keys: [] });
  assert.deepStrictEqual(treeText(q), ['No uncommitted git changes in workspace metadata.'], 'no filter, nothing changed: the old text stays');
  const r = panel({ ...BASE, viewMode: 'changed' });
  r.deliver(TFILES(THREE_TYPES));
  r.deliver({ type: 'orgMetadata', orgLabel: 'acme-dev', orgItems: [{ type: 'ApexClass', name: 'AcmeA' }] });
  r.el('sourceFilter').value = 'org-only'; r.el('sourceFilter').fire('change');
  r.deliver({ type: 'changed', keys: ['ApexClass:AcmeA'] });
  assert.deepStrictEqual(treeText(r), ['No changed component matches the current filter.'], 'the source filter hid the row');
});

// ------------------------------------------ 6b) a type that appears LATER
// A persisted plain-names filter used to hide any type that first showed up
// after it was written (OmniUiCard after the org gains OmniStudio): the row was
// simply unticked in a list nobody reopens. New types default to visible — told
// apart from RESTORED ones by the persisted `seenTypes` baseline.
const SEEN = ['ApexClass', 'ApexTrigger', 'Flow'];

check('a type first seen on an org fetch joins a plain-names filter and shows', () => {
  const p = panel({ ...BASE, typeFilter: ['ApexClass'], seenTypes: SEEN });
  p.deliver(TFILES(THREE_TYPES));
  assert.deepStrictEqual(p.persisted().typeFilter, ['ApexClass'], 'restored types are not new');
  p.deliver({ type: 'orgMetadata', orgLabel: 'acme-dev', orgItems: [{ type: 'OmniUiCard', name: 'AcmeCard_Acme_1' }] });
  assert.deepStrictEqual(p.persisted().typeFilter.slice().sort(), ['ApexClass', 'OmniUiCard']);
  assert.strictEqual(label(p), '2 of 4 types');
  assert.deepStrictEqual(groups(p), ['ApexClass', 'OmniUiCard (FlexCard)']);
  assert.ok(p.persisted().seenTypes.includes('OmniUiCard'), 'the newcomer must be recorded, or it is "new" again next time');
});

check('…and one first seen on a scan, explicit or silent', () => {
  const p = panel({ ...BASE, typeFilter: ['ApexClass'], seenTypes: SEEN });
  p.deliver(TFILES([...THREE_TYPES, item('Layout', 'AcmeLayout')]));
  assert.deepStrictEqual(p.persisted().typeFilter.slice().sort(), ['ApexClass', 'Layout']);
  assert.deepStrictEqual(groups(p), ['ApexClass', 'Layout']);
  const q = panel({ ...BASE, typeFilter: ['ApexClass'], seenTypes: SEEN });
  q.deliver(TFILES(THREE_TYPES));
  q.deliver({ ...TFILES([...THREE_TYPES, item('Layout', 'AcmeLayout')]), silent: true });
  assert.deepStrictEqual(q.persisted().typeFilter.slice().sort(), ['ApexClass', 'Layout'], 'showing a new type is additive — a silent scan may do it');
});

check('None is an explicit choice: a new type stays hidden', () => {
  const p = panel({ ...BASE, typeFilter: ['__none__'], seenTypes: SEEN });
  p.deliver(TFILES([...THREE_TYPES, item('Layout', 'AcmeLayout')]));
  assert.deepStrictEqual(p.persisted().typeFilter, ['__none__']);
  assert.deepStrictEqual(groups(p), []);
});

check('a filter with no recorded baseline is left alone — the first session only seeds', () => {
  // State written by 0.20.x has a filter but no seenTypes: every type would look
  // new, and the user's narrowing would silently widen to All on upgrade — on
  // the ready scan, or one message later on the org fetch.
  const p = panel({ ...BASE, typeFilter: ['ApexClass'] });
  p.deliver(TFILES(THREE_TYPES));
  assert.deepStrictEqual(p.persisted().typeFilter, ['ApexClass']);
  assert.deepStrictEqual(p.persisted().seenTypes.slice().sort(), SEEN);
  p.deliver({ type: 'orgMetadata', orgLabel: 'acme-dev', orgItems: [{ type: 'Layout', name: 'AcmeLayout' }] });
  assert.deepStrictEqual(p.persisted().typeFilter, ['ApexClass'], 'the org fetch of the same session must not widen it either');
  assert.ok(p.persisted().seenTypes.includes('Layout'));
  // An empty persisted baseline is no baseline (a discovery-failure session
  // persists seenTypes: [] on any click).
  const q = panel({ ...BASE, typeFilter: ['ApexClass'], seenTypes: [] });
  q.deliver(TFILES(THREE_TYPES));
  assert.deepStrictEqual(q.persisted().typeFilter, ['ApexClass']);
});

check('a newcomer that completes the set reads as All', () => {
  const p = panel({ ...BASE, typeFilter: ['ApexClass'], seenTypes: ['ApexClass', 'Flow'] });
  p.deliver(TFILES([item('ApexClass', 'AcmeA'), item('Layout', 'AcmeLayout')]));
  assert.deepStrictEqual(p.persisted().typeFilter, []);
  assert.strictEqual(label(p), 'All types (2)');
});

// --------------------------------------------- 6c) OmniStudio search aliases
check('the search box knows OmniStudio by its user-facing names', () => {
  const OMNI = [item('OmniUiCard', 'AcmeCard_Acme_1'), item('OmniDataTransform', 'AcmeExtract'), item('OmniIntegrationProcedure', 'Acme_Fetch'), item('OmniScript', 'Acme_Intake_English_1'), item('ApexClass', 'AcmeA')];
  const seen = (filter) => { const p = panel({ ...BASE, filter }); p.deliver(TFILES(OMNI)); return names(p); };
  assert.deepStrictEqual(seen('flexcard'), ['AcmeCard_Acme_1']);
  assert.deepStrictEqual(seen('type:dataraptor'), ['AcmeExtract']);
  assert.deepStrictEqual(seen('t:flexcard'), ['AcmeCard_Acme_1']);
  assert.deepStrictEqual(seen('integration procedure'), ['Acme_Fetch']);
  assert.deepStrictEqual(seen('omniscript'), ['Acme_Intake_English_1']);
  assert.deepStrictEqual(seen('type:apex'), ['AcmeA'], 'a plain type still matches its own name only');
});

check('aliased types are labelled "Type (Alias)" on group headers and filter rows; plain types stay plain', () => {
  const p = panel(BASE);
  p.deliver(TFILES([item('OmniUiCard', 'AcmeCard_Acme_1'), item('OmniScript', 'Acme_Intake_English_1'), item('ApexClass', 'AcmeA')]));
  assert.deepStrictEqual(groups(p), ['ApexClass', 'OmniScript', 'OmniUiCard (FlexCard)']);
  assert.strictEqual(rowLabel(p, 'OmniUiCard').children[1].textContent, 'OmniUiCard (FlexCard)');
  assert.strictEqual(rowLabel(p, 'OmniScript').children[1].textContent, 'OmniScript', 'an alias equal to the type adds nothing');
  assert.strictEqual(rowLabel(p, 'ApexClass').children[1].textContent, 'ApexClass');
  onlyBtn(p, 'OmniUiCard').fire('click'); // the filter still speaks API names
  assert.deepStrictEqual(p.persisted().typeFilter, ['OmniUiCard']);
});

// ------------------------------------------------ 7) Expand all / Collapse all
check('the tools row sits above #tree in the markup', () => {
  assert.ok(/<div id="treeTools" class="mode-head tree-tools"[^>]*>[\s\S]*?<button id="expandAll"[\s\S]*?<button id="collapseAll"[\s\S]*?<\/div>\s*<div id="tree" class="tree">/.test(HTML_TS));
});

check('Expand all opens every group at every depth, and persists', () => {
  const p = panel(BASE);
  p.deliver(TFILES(NESTED, ['CustomField']));
  assert.deepStrictEqual(groups(p), ['Objects', 'ApexClass']);
  p.el('expandAll').fire('click');
  assert.deepStrictEqual(p.persisted().expandedGroups.slice().sort(), ['ApexClass', '__OBJECTS__', 'obj/Acme__c', 'objc/Acme__c/CustomField']);
  assert.deepStrictEqual(groups(p), ['Objects', 'Acme__c', 'Fields', 'ApexClass']);
  assert.deepStrictEqual(names(p), ['⊙ object definition', 'Foo__c', 'AcmeA']);
  // and a rebuild restores it — the keys are the ones renderTree reads
  const q = panel({ ...BASE, expandedGroups: p.persisted().expandedGroups });
  q.deliver(TFILES(NESTED, ['CustomField']));
  assert.deepStrictEqual(names(q), ['⊙ object definition', 'Foo__c', 'AcmeA']);
});

check('Collapse all closes everything and persists an empty set', () => {
  const p = panel({ ...BASE, expandedGroups: ['ApexClass', '__OBJECTS__', 'obj/Acme__c', 'objc/Acme__c/CustomField'] });
  p.deliver(TFILES(NESTED, ['CustomField']));
  assert.deepStrictEqual(names(p), ['⊙ object definition', 'Foo__c', 'AcmeA']);
  p.el('collapseAll').fire('click');
  assert.deepStrictEqual(p.persisted().expandedGroups, []);
  assert.deepStrictEqual(groups(p), ['Objects', 'ApexClass']);
  assert.deepStrictEqual(names(p), []);
});

check('Expand all is scoped to what the filters show; Collapse all clears hidden keys too', () => {
  const p = panel({ ...BASE, typeFilter: ['ApexClass'] });
  p.deliver(TFILES(NESTED, ['CustomField']));
  p.el('expandAll').fire('click');
  assert.deepStrictEqual(p.persisted().expandedGroups, ['ApexClass'], 'hidden Objects groups must not be touched');
  const q = panel({ ...BASE, typeFilter: ['ApexClass'], expandedGroups: ['Flow', 'ApexClass'] });
  q.deliver(TFILES(NESTED, ['CustomField']));
  q.el('collapseAll').fire('click');
  assert.deepStrictEqual(q.persisted().expandedGroups, [], 'a key for a hidden group would reopen it later by itself');
});

check('the controls are disabled, with the reason, while the tree is force-expanded', () => {
  const p = panel({ ...BASE, viewMode: 'selected', selected: ['ApexClass:AcmeA'] });
  p.deliver(TFILES(NESTED, ['CustomField']));
  assert.strictEqual(p.el('expandAll').disabled, true);
  assert.strictEqual(p.el('collapseAll').disabled, true);
  assert.strictEqual(p.el('expandAll').title, 'Groups auto-expand in the Selected and Changed views');
  const q = panel({ ...BASE, filter: 'acme' });
  q.deliver(TFILES(NESTED, ['CustomField']));
  assert.strictEqual(q.el('expandAll').disabled, true);
  assert.strictEqual(q.el('collapseAll').title, 'Groups auto-expand while a filter is typed');
  const r = panel(BASE);
  r.deliver(TFILES(NESTED, ['CustomField']));
  assert.strictEqual(r.el('expandAll').disabled, false);
  assert.strictEqual(r.el('collapseAll').disabled, false);
  assert.strictEqual(r.el('expandAll').title, 'Expand every group');
  assert.strictEqual(r.el('collapseAll').title, 'Collapse every group');
  assert.strictEqual(r.el('treeTools').style.display, 'flex');
});

check('the tools row hides when there is nothing to expand', () => {
  const p = panel(BASE);
  p.deliver({ type: 'files', objectChildTypes: [], items: [] });
  assert.strictEqual(p.el('treeTools').style.display, 'none');
  const q = panel({ ...BASE, typeFilter: ['__none__'] });
  q.deliver(TFILES(THREE_TYPES));
  assert.strictEqual(q.el('treeTools').style.display, 'none', 'an empty filtered tree has no groups either');
  q.el('typeFilterAll').fire('click');
  assert.strictEqual(q.el('treeTools').style.display, 'flex', 'and it comes back with the groups');
});

check('Expand / Collapse all never touch the selection', () => {
  const p = panel({ ...BASE, selected: ['ApexClass:AcmeA'] });
  p.deliver(TFILES(NESTED, ['CustomField']));
  p.el('expandAll').fire('click');
  p.el('collapseAll').fire('click');
  assert.deepStrictEqual(p.persisted().selected, ['ApexClass:AcmeA']);
  assert.strictEqual(p.liveCount(), 1);
});

// ------------------------------------------------ 8) double-click guards
// The provider disables nothing; a button is only ever locked by the `busy`
// reply, and that round trip is wide enough for the second click of a
// double-click to send a twin (a second modal, a duplicate queue entry, a
// misleading "already running" toast). sendAction locks the clicked control —
// and every other slot-taking one — synchronously until ANY `busy` post answers.
const DC = { selected: ['ApexClass:AcmeA', 'ApexClass:AcmeB'], expandedGroups: [], filter: '', typeFilter: [], viewMode: 'all', testClasses: '' };
function armed(opts = {}) {
  const p = panel(DC);
  p.deliver({ type: 'orgs', orgs: [{ username: 'acme-dev-user', alias: 'acme-dev', label: 'acme-dev (acme-dev-user)', kind: 'sandbox' }], selected: 'acme-dev-user' });
  p.deliver(FILES(['AcmeA', 'AcmeB']));
  if (opts.busy) p.deliver({ type: 'busy', busy: true, action: opts.busy });
  return p;
}
// A browser never delivers a click to a disabled or hidden button; the shim's
// fire() would, so gate the way the browser does.
function click(btn) {
  if (!btn || btn.disabled || (btn.style && btn.style.display === 'none')) return false;
  btn.fire('click');
  return true;
}
const sent = (p, type) => p.outbound.filter(m => m.type === type).length;
const findBtn = (p, label) => p.el('status').find(e => e.tagName === 'BUTTON' && e.textContent === label);
const GUARDED = [['deployBtn', 'deploy'], ['validateBtn', 'deploy'], ['retrieveBtn', 'retrieve'], ['diffBtn', 'diff'], ['fetchOrgBtn', 'fetchOrgMetadata'], ['addOrg', 'loginOrg']];

for (const [id, type] of GUARDED) {
  check(`${id}: two clicks send one ${type}; locked ("Sending…") with the other guarded buttons until the busy reply`, () => {
    const p = armed();
    const b = p.el(id);
    assert.ok(click(b));
    assert.strictEqual(sent(p, type), 1);
    assert.strictEqual(b.disabled, true);
    assert.strictEqual(b.title, 'Sending…');
    assert.ok(!click(b));
    b.fire('click'); // even a click forced past the disabled gate is dropped
    assert.strictEqual(sent(p, type), 1);
    for (const [other] of GUARDED) assert.strictEqual(p.el(other).disabled, true, `${other} stayed enabled`);
    p.deliver({ type: 'busy', busy: false });
    assert.strictEqual(b.disabled, false, 'the busy reply must clear the pending lock');
    assert.notStrictEqual(b.title, 'Sending…');
    assert.ok(click(b));
    assert.strictEqual(sent(p, type), 2);
  });
}

check('Deploy queues while busy but never sends while its previous click is unanswered', () => {
  const p = armed({ busy: 'Retrieve' });
  const b = p.el('deployBtn');
  assert.ok(click(b));
  assert.strictEqual(sent(p, 'deploy'), 1);
  assert.strictEqual(b.disabled, true);
  assert.ok(!click(b));
  p.deliver({ type: 'busy', busy: true, action: 'Retrieve' }); // the provider's re-sync: same state
  assert.strictEqual(b.disabled, false);
  assert.strictEqual(b.title, 'Will queue behind Retrieve');
  assert.ok(click(b));
  assert.strictEqual(sent(p, 'deploy'), 2);
  assert.strictEqual(p.el('retrieveBtn').style.display, 'none', 'Retrieve stays hidden while busy');
});

const CARD = (buttons) => ({ type: 'status', card: { kind: 'ok', title: 'Retrieved 2 components', buttons } });
const CARD_BTNS = [
  ['Retry deploy', { type: 'retryDeploy', request: { keys: DC.selected } }, 1],
  ['Resume monitoring', { type: 'resumeDeploy', jobId: '0Af000000000001AAA' }, 1],
  ['Restore backup…', { type: 'restoreBackup', dir: '/backups/x' }, 1],
  ['Discard backup', { type: 'discardBackup', dir: '/backups/x' }, 1],
  ['Select these 2', { type: 'selectDeployed', keys: DC.selected }, 2] // selection-only: never gated
];
for (const [label, send, expect] of CARD_BTNS) {
  check(`card "${label}": two clicks send ${expect} ${send.type}`, () => {
    const p = armed();
    p.deliver(CARD([{ label, send }]));
    click(findBtn(p, label));
    click(findBtn(p, label)); // re-found: a render replaces the element under the cursor
    assert.strictEqual(sent(p, send.type), expect);
    if (expect === 1) {
      assert.strictEqual(findBtn(p, label).disabled, true);
      assert.strictEqual(findBtn(p, label).title, 'Sending…');
      assert.strictEqual(p.el('deployBtn').disabled, true, 'the toolbar locks with the card');
      p.deliver({ type: 'busy', busy: false });
      assert.strictEqual(findBtn(p, label).disabled, false);
      assert.strictEqual(p.el('deployBtn').disabled, false);
    }
  });
}

check('card Retry queues while busy, not while pending', () => {
  const p = armed({ busy: 'Deploy' });
  p.deliver(CARD([{ label: 'Retry deploy', send: { type: 'retryDeploy', request: { keys: DC.selected } } }]));
  assert.ok(click(findBtn(p, 'Retry deploy')));
  assert.strictEqual(sent(p, 'retryDeploy'), 1);
  assert.ok(!click(findBtn(p, 'Retry deploy')));
  p.deliver({ type: 'busy', busy: true, action: 'Deploy' });
  assert.strictEqual(findBtn(p, 'Retry deploy').title, 'Will queue behind Deploy');
  assert.ok(click(findBtn(p, 'Retry deploy')));
  assert.strictEqual(sent(p, 'retryDeploy'), 2);
});

check('Quick Deploy stays one-shot', () => {
  const p = armed();
  p.deliver({ type: 'status', card: { kind: 'ok', title: 'Validation succeeded', quickDeploy: { jobId: '0Af000000000001AAA', label: 'Quick Deploy 2' } } });
  assert.ok(click(findBtn(p, 'Quick Deploy 2')));
  assert.strictEqual(findBtn(p, 'Quick Deploy 2'), null, 'the button must vanish on its one click');
  assert.strictEqual(sent(p, 'quickDeploy'), 1);
});

check('Rescan locks on click until filesRefreshed — a busy broadcast does not free it', () => {
  const p = armed();
  const b = p.el('refreshFiles');
  assert.ok(click(b));
  assert.strictEqual(sent(p, 'refreshFiles'), 1);
  assert.strictEqual(b.disabled, true);
  assert.strictEqual(b.title, 'Rescanning…');
  b.fire('click');
  assert.strictEqual(sent(p, 'refreshFiles'), 1);
  p.deliver({ type: 'busy', busy: false });
  assert.strictEqual(b.disabled, true, 'a busy post is not this request\'s answer');
  p.deliver({ type: 'filesRefreshed' });
  assert.strictEqual(b.disabled, false);
  assert.ok(click(b));
  assert.strictEqual(sent(p, 'refreshFiles'), 2);
});

check('a repeated busy post neither wipes the progress text nor rebuilds the Status pane', () => {
  const p = armed({ busy: 'Deploy' });
  p.deliver({ type: 'progress', text: 'Deploying 2 components to acme-dev…' });
  const progressText = () => {
    const t = p.el('status').find(e => e.classList.contains('title') && e.parentNode && e.parentNode.classList.contains('progress'));
    return t ? t.children[1].textContent : null;
  };
  assert.strictEqual(progressText(), 'Deploying 2 components to acme-dev…');
  const pane = p.el('status').children;
  p.deliver({ type: 'busy', busy: true, action: 'Deploy' });
  assert.strictEqual(p.el('status').children, pane, 'the re-sync rebuilt the Status pane');
  // A reset that was not repainted is invisible until the next render — force one.
  p.deliver({ type: 'status', card: { kind: 'ok', title: 'Unrelated card' } });
  assert.strictEqual(progressText(), 'Deploying 2 components to acme-dev…', 'the re-sync reset the progress text');
  p.deliver({ type: 'busy', busy: false });
  assert.strictEqual(progressText(), null, 'a real transition must still repaint');
});

check('the context-menu paths and the provider\'s Rescan reply share the same guards', () => {
  assert.ok(/function runKeys\([\s\S]*?state\.pendingAction[\s\S]*?sendAction\('deploy'[\s\S]*?sendAction\(kind, \{ keys \}\)/.test(PANEL_JS), 'runKeys must gate on pendingAction and send through sendAction');
  assert.ok(/function runDelete\([\s\S]*?state\.pendingAction[\s\S]*?sendAction\('deleteFromOrg'/.test(PANEL_JS), 'runDelete must gate on pendingAction and send through sendAction');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'panelProvider.ts'), 'utf8');
  const shape = /case 'refreshFiles':(?:\n\s*\/\/[^\n]*)*\n\s*try \{ await this\.refreshFiles\(\); \} finally \{ this\.post\(\{ type: 'filesRefreshed' \}\); \}\n\s*return;/;
  assert.ok(shape.test(src), "refreshFiles handler must be exactly: try { await this.refreshFiles(); } finally { this.post({ type: 'filesRefreshed' }); }");
});

if (failed) { console.error(`\n${failed} of ${ran} check(s) failed`); process.exit(1); }
console.log(`panel selection: all ${ran} checks passed`);
