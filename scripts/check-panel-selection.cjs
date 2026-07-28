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
//      innerHTML, and scroll position and keyboard focus go with it.
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
  'useActive', 'useOpenTabs', 'validateBtn', 'viewModes'
];

/** Boot one panel instance over the given persisted webview state. */
function panel(persisted) {
  const els = new Map();
  for (const id of IDS) { const e = new El('div'); e.id = id; els.set(id, e); }
  const listeners = {};
  let stored = persisted ? JSON.parse(JSON.stringify(persisted)) : undefined;
  const outbound = [];

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
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
      querySelectorAll: () => [],
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

if (failed) { console.error(`\n${failed} of ${ran} check(s) failed`); process.exit(1); }
console.log(`panel selection: all ${ran} checks passed`);
