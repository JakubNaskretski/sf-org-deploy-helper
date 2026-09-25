// Runnable contract test for the WEBVIEW's selection state (src/panel.js).
// No framework.   1) npm run compile   2) node scripts/check-panel-selection.cjs
//
// The checkbox selection is the most expensive thing in the panel to rebuild by
// hand, and it is now durable: written to webview state on every change and
// restored on rebuild. That makes three quiet behaviours worth pinning, none of
// which any provider-side suite can see:
//   1) the round trip — a change persists, and a scan that FINDS something prunes
//      keys that no longer exist and writes the prune back, once org membership
//      has had its say (a rebuild's first scan arrives before it);
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
//      no-op for the progress card and the Status pane;
//   9) selection vs the filters: a selection made FOR the user (Use active file,
//      Use open tabs, a card's "Select these N") clears whatever filter would
//      hide it — it used to bump the count and change nothing else — the Selected
//      lens ignores the type and source filters (they are for FINDING components
//      in All) so it can account for the count above it, and a real scan is the
//      one thing that takes stale keys back out of the persisted expandedGroups set.
//
// panel.js is a browser-only IIFE with no exports, so it is run inside a minimal
// DOM/vscode-API shim and driven the way the provider drives it: by delivering
// messages and reading back what vscode.setState() holds. The shim answers only
// what panel.js actually touches — it is a test double, not a browser.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PANEL_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'panel.js'), 'utf8');

let failed = 0;
let ran = 0;
function check(name, fn) {
  ran++;
  try { fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}

// ------------------------------------------------------------------ DOM shim
// scripts/lib/dom-shim.cjs boots src/runView.js then src/panel.js the way the
// page loads them; panel(persisted) returns the driver every check below uses.
const { panel } = require('./lib/dom-shim.cjs');

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

check('a key deleted between sessions is pruned once the scan can be trusted, and the prune persists', () => {
  // Updated in 0.23.2: the FIRST scan of a rebuilt webview lands before org
  // membership does, so it is not yet proof a key is gone — pruning there took
  // every org-only key with it (see "an org-only key survives the rebuild scan"
  // below). Membership completes the picture, and so does the next explicit scan.
  const p = panel(RESTORED);
  p.deliver(FILES(['AcmeOrderService', 'AcmeOrderServiceTest'])); // AcmeInvoiceService is gone
  assert.strictEqual(p.liveCount(), 3, 'nothing can vouch for an org-only key yet');
  p.deliver({ type: 'orgMetadata', orgLabel: 'acme-dev', orgItems: [] });
  assert.strictEqual(p.liveCount(), 2);
  assert.deepStrictEqual(p.persisted().selected.slice().sort(), [KEY('AcmeOrderService'), KEY('AcmeOrderServiceTest')].sort());
  // No org fetch at all: the next explicit scan prunes on its own.
  const q = panel(RESTORED);
  q.deliver(FILES(['AcmeOrderService', 'AcmeOrderServiceTest']));
  q.deliver(FILES(['AcmeOrderService', 'AcmeOrderServiceTest']));
  assert.strictEqual(q.liveCount(), 2);
  assert.deepStrictEqual(q.persisted().selected.slice().sort(), [KEY('AcmeOrderService'), KEY('AcmeOrderServiceTest')].sort());
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

check('an org-only key survives the rebuild scan, and membership does the prune it could not', () => {
  // A rebuild replays `files` BEFORE `orgMetadata`: at the first scan orgKeys is
  // still empty, so pruning against it deleted every key ticked from the Org lens
  // to retrieve — and persisted the deletion seconds before membership arrived.
  const ORG_ONLY = KEY('AcmeOrgOnlyService');
  const GHOST = KEY('AcmeGhostService'); // exists nowhere: local, org, or otherwise
  const p = panel({ ...RESTORED, selected: [KEY('AcmeOrderService'), ORG_ONLY, GHOST] });
  // A watcher scan landing first does not make the next explicit scan "trusted".
  p.deliver({ ...FILES(['AcmeOrderService']), silent: true });
  p.deliver(FILES(['AcmeOrderService']));
  assert.strictEqual(p.liveCount(), 3, 'the first scan pruned keys nothing had been asked about yet');
  assert.ok(p.persisted().selected.includes(ORG_ONLY), 'and persisted the loss');
  p.deliver({ type: 'orgMetadata', orgLabel: 'acme-dev', orgItems: [{ type: 'ApexClass', name: 'AcmeOrgOnlyService' }] });
  assert.deepStrictEqual(
    p.persisted().selected.slice().sort(), [KEY('AcmeOrderService'), ORG_ONLY].sort(),
    'membership is what the ghost key had to be pruned against'
  );
  assert.strictEqual(p.liveCount(), 2);
  // And every later scan prunes exactly as it always did.
  p.deliver(FILES(['AcmeInvoiceService'])); // AcmeOrderService deleted since
  assert.deepStrictEqual(p.persisted().selected, [ORG_ONLY]);
  assert.strictEqual(p.liveCount(), 1);
  // The membership prune answers to the same authority rule as the scan one:
  // after a discovery failure there is no local list, and org membership alone is
  // no proof a local component is gone.
  const q = panel(RESTORED);
  q.deliver({ type: 'files', objectChildTypes: [], items: [] });
  q.deliver({ type: 'orgMetadata', orgLabel: 'acme-dev', orgItems: [{ type: 'ApexClass', name: 'AcmeOrgOnlyService' }] });
  assert.strictEqual(q.liveCount(), 3, 'an empty scan plus org membership is still not evidence');
  assert.deepStrictEqual(q.persisted().selected.slice().sort(), THREE.map(KEY).sort());
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

// -------------------------------------------------- 3c) B4: transient selectKeys
// A suggestion accept reveals what it added to its own retry WITHOUT joining the
// persisted selection — a plain Deploy click right after must not silently pick
// these up, and the user stays in whatever lens/mode they were already in.
check('a transient selectKeys never joins the live selection or persisted state', () => {
  const p = panel(RESTORED);
  p.deliver(FILES(THREE));
  const before = p.persisted().selected.slice().sort();
  p.deliver({ type: 'selectKeys', keys: [KEY('AcmeInvoiceService')], scroll: true, transient: true });
  assert.strictEqual(p.liveCount(), 3, 'a transient key must not join the live selection');
  assert.deepStrictEqual(p.persisted().selected.slice().sort(), before, 'a transient key must not be persisted');
});

check('a transient selectKeys still reveals the row (group auto-expands so it can be scrolled to)', () => {
  const acmeNames = (p) => { const o = []; p.el('tree').find(e => { if (e.tagName === 'SPAN' && /^Acme/.test(e.textContent)) o.push(e.textContent); return false; }); return o; };
  const p = panel({ ...RESTORED, selected: [], expandedGroups: [] });
  p.deliver(FILES(THREE));
  assert.ok(!acmeNames(p).includes('AcmeInvoiceService'), 'row already visible before the reveal — fixture is broken');
  p.deliver({ type: 'selectKeys', keys: [KEY('AcmeInvoiceService')], scroll: true, transient: true });
  assert.ok(acmeNames(p).includes('AcmeInvoiceService'), 'the transient key never became visible');
});

check('a transient selectKeys does not force the user out of the Changed lens (replace/plain selectKeys does)', () => {
  const p = panel({ ...RESTORED, viewMode: 'changed' });
  p.deliver(FILES(THREE));
  p.deliver({ type: 'selectKeys', keys: [KEY('AcmeInvoiceService')], scroll: true, transient: true });
  assert.strictEqual(p.persisted().viewMode, 'changed', 'transient must not switch the lens like a real selection does');
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
  p.deliver(FILES(THREE));                 // the first scan may not judge a name (rebuild rule)…
  p.deliver(FILES(THREE));                 // …explicit and trusted: ApexTrigger is stale, it goes
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

check('Cancel locks on click ("Cancelling…"), ignores repeats, holds on a cancelling re-sync, unlocks when the slot frees', () => {
  const p = panel(undefined);
  const btn = p.el('cancelBtn');
  const sent = () => p.outbound.filter(m => m.type === 'cancel').length;
  p.deliver({ type: 'busy', busy: true, action: 'Fetch Org', cancelling: false });
  assert.strictEqual(btn.style.display, '');
  assert.strictEqual(btn.disabled, false);
  assert.strictEqual(btn.textContent, 'Cancel Fetch Org');
  btn.fire('click');
  assert.strictEqual(sent(), 1);
  assert.strictEqual(btn.disabled, true);
  assert.strictEqual(btn.textContent, 'Cancelling…');
  btn.fire('click'); btn.fire('click'); // spam — the kill must not re-fire
  assert.strictEqual(sent(), 1);
  // The provider answers the cancel message within milliseconds with a busy
  // re-sync (still busy, same op) that says a handler was consumed — that holds.
  p.deliver({ type: 'busy', busy: true, action: 'Fetch Org', cancelling: true });
  assert.strictEqual(btn.disabled, true);
  assert.strictEqual(btn.textContent, 'Cancelling…');
  btn.fire('click');
  assert.strictEqual(sent(), 1);
  p.deliver({ type: 'busy', busy: false, cancelling: false });
  assert.strictEqual(btn.style.display, 'none');
  // The next op gets a fresh Cancel.
  p.deliver({ type: 'busy', busy: true, action: 'Retrieve', cancelling: false });
  assert.strictEqual(btn.disabled, false);
  assert.strictEqual(btn.textContent, 'Cancel Retrieve');
  btn.fire('click');
  assert.strictEqual(sent(), 2);
});

check('a Cancel that hit nothing unlocks on the reply; the notification\'s Cancel locks the panel\'s too', () => {
  const p = panel(undefined);
  const btn = p.el('cancelBtn');
  // A picker holding the slot installs no cancel handler: the click locks for
  // instant feedback, the reply (cancelling:false) says nothing was consumed.
  p.deliver({ type: 'busy', busy: true, action: 'Restore backup', cancelling: false });
  btn.fire('click');
  assert.strictEqual(btn.textContent, 'Cancelling…');
  p.deliver({ type: 'busy', busy: true, action: 'Restore backup', cancelling: false });
  assert.strictEqual(btn.disabled, false, 'a click that cancelled nothing must not strand the button');
  assert.strictEqual(btn.textContent, 'Cancel Restore backup');
  // Cancel pressed on the progress notification instead: the provider posts
  // cancelling:true unasked, and the panel's button follows.
  p.deliver({ type: 'busy', busy: true, action: 'Deploy', cancelling: false });
  assert.strictEqual(btn.disabled, false);
  p.deliver({ type: 'busy', busy: true, action: 'Deploy', cancelling: true });
  assert.strictEqual(btn.disabled, true);
  assert.strictEqual(btn.textContent, 'Cancelling…');
  btn.fire('click');
  assert.strictEqual(p.outbound.filter(m => m.type === 'cancel').length, 1, 'locked — nothing sent');
});

check('the provider replies orgsRefreshed however the listing ends', () => {
  // The unlock has exactly one trigger, so the reply must be unconditional: the
  // exact shape is pinned — a guard, or a plain await outside a finally, fails here.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'panelProvider.ts'), 'utf8');
  const shape = /case 'refreshOrgs':(?:\n\s*\/\/[^\n]*)*\n\s*try \{ await this\.loadOrgs\(true\); \} finally \{ this\.post\(\{ type: 'orgsRefreshed' \}\); \}\n\s*return;/;
  assert.ok(shape.test(src), "refreshOrgs handler must be exactly: try { await this.loadOrgs(true); } finally { this.post({ type: 'orgsRefreshed' }); }");
});

// ------------------------------------------- 5b) the org snapshot's age
// Membership can arrive from a persisted snapshot (Feature: org cache): the note
// beside the source filter and the Fetch Org tooltip must say how old it is, a
// fresh fetch (no `asOf`) reads as now, and an org switch clears it.
const asOfText = (at) => {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `yesterday ${time}`;
};
check('"org as of" shows the snapshot time, reads as now without asOf, clears on reset', () => {
  const p = panel(undefined);
  p.deliver(FILES(THREE));
  const note = p.el('orgAsOf');
  const fetchBtn = p.el('fetchOrgBtn');
  // Noon yesterday — a fixed calendar day, whatever the clock (or DST) says now.
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1); yesterday.setHours(12, 0, 0, 0);
  p.deliver({ type: 'orgMetadata', orgLabel: 'acme-dev', orgItems: [], asOf: yesterday.getTime() });
  assert.strictEqual(note.textContent, `org as of ${asOfText(yesterday)}`);
  assert.ok(note.textContent.startsWith('org as of yesterday '), note.textContent);
  assert.strictEqual(p.el('sourceFilterRow').style.display, 'flex');
  assert.strictEqual(fetchBtn.title, `Re-list acme-dev — badges are as of ${asOfText(yesterday)}`);
  // A fresh fetch posts no asOf: the note is "now" (either side of a minute tick).
  const before = asOfText(Date.now());
  p.deliver({ type: 'orgMetadata', orgLabel: 'acme-dev', orgItems: [] });
  const after = asOfText(Date.now());
  assert.ok([before, after].some(t => note.textContent === `org as of ${t}`), note.textContent);
  p.deliver({ type: 'orgMetadataReset' });
  assert.strictEqual(note.textContent, '');
  assert.strictEqual(p.el('sourceFilterRow').style.display, 'none');
  assert.strictEqual(fetchBtn.title, 'Fetch all metadata from the connected org and merge with local workspace');
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

// ---- 9. lens tab counts match the rows their lens draws (0.22.0; Selected 0.23.2) ----
check('the Changed tab count follows the type filter; Selected counts the whole selection', () => {
  const p = panel();
  p.deliver({ type: 'files', objectChildTypes: [], items: [item('ApexClass', 'A1'), item('ApexClass', 'A2'), item('Flow', 'F1')] });
  p.deliver({ type: 'selectKeys', keys: ['ApexClass:A1', 'ApexClass:A2', 'Flow:F1'], replace: true });
  p.deliver({ type: 'changed', keys: ['ApexClass:A1', 'Flow:F1'] });
  assert.strictEqual(tab(p, 'selected'), 'Selected (3)');
  assert.strictEqual(tab(p, 'changed'), 'Changed (2)');
  onlyBtn(p, 'Flow').fire('click');
  assert.strictEqual(tab(p, 'selected'), 'Selected (3)', 'the Selected lens ignores the type filter, so its count must too');
  assert.strictEqual(tab(p, 'changed'), 'Changed (1)');
  assert.strictEqual(p.liveCount(), 3, 'the live selection itself is untouched by the filter');
  p.el('typeFilterNone').fire('click');
  assert.strictEqual(tab(p, 'changed'), 'Changed', 'nothing visible → bare label');
  assert.strictEqual(tab(p, 'selected'), 'Selected (3)');
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

// ------------------------------------------ 6d) selection vs the filters
// A selection made FOR the user has to be visible, and the Selected lens has to
// account for the count above it.
check('a reveal clears the filters that would hide the row it just ticked', () => {
  // The symptom: "Use active file" / "Use open tabs" / a card's "Select these N"
  // bumped the count and changed nothing else, and Deploy later sent a component
  // that was never on screen.
  const p = panel({ ...BASE, filter: 'flow' });
  p.deliver(TFILES(THREE_TYPES));
  assert.deepStrictEqual(names(p), ['AcmeF'], 'fixture: the text filter must hide the ApexClass');
  p.deliver({ type: 'selectKeys', keys: ['ApexClass:AcmeA'], scroll: true });
  assert.strictEqual(p.el('search').value, '', 'the search box still holds the filter that hid the new row');
  assert.strictEqual(p.persisted().filter, '');
  assert.ok(names(p).includes('AcmeA'), `the newly selected row never rendered: ${names(p).join(', ')}`);
  // The type filter goes the same way — and a filter that hides nothing stays.
  const q = panel({ ...BASE, typeFilter: ['Flow'], filter: 'acme' });
  q.deliver(TFILES(THREE_TYPES));
  q.deliver({ type: 'activeFile', key: 'ApexClass:AcmeA', select: true, scroll: true });
  assert.deepStrictEqual(q.persisted().typeFilter, []);
  assert.strictEqual(q.persisted().filter, 'acme', 'a filter the new row matches must be left alone');
  assert.ok(names(q).includes('AcmeA'), `the newly selected row never rendered: ${names(q).join(', ')}`);
  // Source filter too: an org-only reveal under "local only" is just as invisible.
  const r = panel(BASE);
  r.deliver(TFILES(THREE_TYPES));
  r.deliver({ type: 'orgMetadata', orgLabel: 'acme-dev', orgItems: [{ type: 'ApexClass', name: 'AcmeOrgOnly' }] });
  r.el('sourceFilter').value = 'local-only'; r.el('sourceFilter').fire('change');
  r.deliver({ type: 'selectKeys', keys: ['ApexClass:AcmeOrgOnly'] });
  assert.strictEqual(r.el('sourceFilter').value, 'all');
  assert.ok(names(r).includes('AcmeOrgOnly'), `the newly selected row never rendered: ${names(r).join(', ')}`);
  // A transient reveal (a suggestion accept: rows shown, not ticked) has the same
  // problem — with a filter on there was nothing to look at.
  const t = panel({ ...BASE, filter: 'flow' });
  t.deliver(TFILES(THREE_TYPES));
  t.deliver({ type: 'selectKeys', keys: ['ApexClass:AcmeA'], transient: true, scroll: true });
  assert.strictEqual(t.el('search').value, '', 'a transient reveal left the filter that hid it');
  assert.ok(names(t).includes('AcmeA'), `the revealed row never rendered: ${names(t).join(', ')}`);
  assert.deepStrictEqual(t.persisted().selected, [], 'transient: revealed, not ticked');
  // Inside the Selected lens the type filter hides nothing (the lens ignores it),
  // so a reveal there leaves it alone.
  const s = panel({ ...BASE, typeFilter: ['Flow'], viewMode: 'selected', selected: ['ApexClass:AcmeB'] });
  s.deliver(TFILES(THREE_TYPES));
  s.deliver({ type: 'activeFile', key: 'ApexClass:AcmeA', select: true, scroll: true });
  assert.deepStrictEqual(s.persisted().typeFilter, ['Flow'], 'the Selected lens does not need the type filter cleared');
  assert.ok(names(s).includes('AcmeA'), `the newly selected row never rendered: ${names(s).join(', ')}`);
});

check('the Selected lens ignores the type and source filters — it lists what Deploy would send', () => {
  const THREE_CLASSES = ['ApexClass:AcmeA', 'ApexClass:AcmeB', 'ApexClass:AcmeC'];
  const ITEMS = [item('ApexClass', 'AcmeA'), item('ApexClass', 'AcmeB'), item('ApexClass', 'AcmeC'), item('Flow', 'AcmeF')];
  const p = panel({ ...BASE, typeFilter: ['Flow'], viewMode: 'selected', selected: THREE_CLASSES });
  p.deliver(TFILES(ITEMS));
  assert.deepStrictEqual(names(p).slice().sort(), ['AcmeA', 'AcmeB', 'AcmeC'], '"3 selected" stood above a list that could not account for it');
  assert.strictEqual(tab(p, 'selected'), 'Selected (3)');
  p.deliver({ type: 'orgMetadata', orgLabel: 'acme-dev', orgItems: [] });
  p.el('sourceFilter').value = 'org-only'; p.el('sourceFilter').fire('change');
  assert.deepStrictEqual(names(p).slice().sort(), ['AcmeA', 'AcmeB', 'AcmeC'], 'the source filter is the same kind of tool');
  // The text filter is the user's own search WITHIN the lens, so it still applies…
  const q = panel({ ...BASE, filter: 'acmea', viewMode: 'selected', selected: THREE_CLASSES });
  q.deliver(TFILES(ITEMS));
  assert.deepStrictEqual(names(q), ['AcmeA']);
  // …and the All lens keeps obeying every one of them.
  const r = panel({ ...BASE, typeFilter: ['Flow'], selected: THREE_CLASSES });
  r.deliver(TFILES(ITEMS));
  assert.deepStrictEqual(groups(r), ['Flow'], 'the type filter still narrows the All lens');
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

check('the controls work everywhere — a lens and a filter open groups, they do not freeze them', () => {
  // They used to be disabled here ("groups auto-expand"), which left the whole
  // tree unfoldable under a lens or a filter.
  const p = panel({ ...BASE, viewMode: 'selected', selected: ['ApexClass:AcmeA'] });
  p.deliver(TFILES(NESTED, ['CustomField']));
  assert.strictEqual(p.el('expandAll').disabled, false);
  assert.strictEqual(p.el('collapseAll').disabled, false);
  assert.strictEqual(p.el('expandAll').title, 'Expand every group');
  assert.ok(names(p).includes('AcmeA'), 'a lens still opens its groups to begin with');
  p.el('collapseAll').fire('click');
  assert.deepStrictEqual(names(p), [], 'Collapse all closes them');
  p.el('expandAll').fire('click');
  assert.ok(names(p).includes('AcmeA'), 'and Expand all opens them again');
  const q = panel({ ...BASE, filter: 'acme' });
  q.deliver(TFILES(NESTED, ['CustomField']));
  assert.strictEqual(q.el('expandAll').disabled, false);
  assert.strictEqual(q.el('collapseAll').title, 'Collapse every group');
  q.el('collapseAll').fire('click');
  assert.deepStrictEqual(names(q), [], 'a typed filter opens groups too, and they close');
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

check('a type filter naming an org-only type survives the rebuild scan', () => {
  // Same deferral as the selection: the first scan has not seen the org, so it
  // may not judge a type it cannot know about — it used to empty the filter
  // ("all types") on every reload of a project whose filter named an org-only type.
  const p = panel({ ...BASE, typeFilter: ['Layout'] });
  p.deliver(FILES(['AcmeOrderService']));
  assert.deepStrictEqual(p.persisted().typeFilter, ['Layout'], 'the first scan may not prune a type it has not seen the org for');
  p.deliver({ type: 'orgMetadata', orgLabel: 'acme-dev', orgItems: [{ type: 'Layout', name: 'AcmeLayout' }] });
  assert.deepStrictEqual(p.persisted().typeFilter, ['Layout'], 'membership vouches for it');
  p.deliver(FILES(['AcmeOrderService']));
  assert.deepStrictEqual(p.persisted().typeFilter, ['Layout'], 'and later scans know the org type too');
  // Without membership, the SECOND scan is the one that prunes a truly stale type
  // (a filter left with nothing to name reads as "all", as it always did).
  const q = panel({ ...BASE, typeFilter: ['Layout'] });
  q.deliver(FILES(['AcmeOrderService']));
  q.deliver(FILES(['AcmeOrderService']));
  assert.deepStrictEqual(q.persisted().typeFilter, [], 'nothing vouched for Layout by the second scan');
});

check('a real scan drops expandedGroups keys whose group no longer exists', () => {
  // expandPathForKey adds without checking and "Collapse all" was the only way
  // out, so every deleted or renamed object stayed in webview state for good.
  const STALE = ['__OBJECTS__', 'obj/Gone__c', 'objc/Gone__c/CustomField', 'obj/Acme__c', 'objc/Acme__c/CustomField', 'ApexClass', 'Flow'];
  const p = panel({ ...BASE, expandedGroups: STALE });
  // The first scan of a rebuilt webview cannot vouch for org-only groups (see the
  // rebuild check above), so it leaves the set alone; the next scan prunes.
  p.deliver(TFILES(NESTED, ['CustomField']));
  assert.deepStrictEqual(p.persisted().expandedGroups.slice().sort(), STALE.slice().sort(), 'the first scan may not judge groups it has not seen the org for');
  p.deliver(TFILES(NESTED, ['CustomField']));
  assert.deepStrictEqual(
    p.persisted().expandedGroups.slice().sort(),
    ['ApexClass', '__OBJECTS__', 'obj/Acme__c', 'objc/Acme__c/CustomField'],
    'the deleted object, its child group and a vanished type all go; the rest stays'
  );
  // Groups are kept for org-only types too — the tree draws those rows.
  p.deliver({ type: 'orgMetadata', orgLabel: 'acme-dev', orgItems: [{ type: 'Layout', name: 'AcmeLayout' }] });
  p.el('expandAll').fire('click');
  p.deliver(TFILES(NESTED, ['CustomField']));
  assert.ok(p.persisted().expandedGroups.includes('Layout'), 'an org-only type has a group of its own');
  // A background rescan may not do it, for the same reason it may not prune the
  // selection: a partial list is indistinguishable from a deletion.
  const q = panel({ ...BASE, expandedGroups: ['obj/Gone__c'] });
  q.deliver({ ...TFILES(NESTED, ['CustomField']), silent: true });
  assert.deepStrictEqual(q.persisted().expandedGroups, ['obj/Gone__c']);
  // …and neither may an empty scan, which is no evidence at all.
  const r = panel({ ...BASE, expandedGroups: ['obj/Gone__c'] });
  r.deliver({ type: 'files', objectChildTypes: [], items: [] });
  r.el('clearSel').fire('click'); // any change writes back what is in memory now
  assert.deepStrictEqual(r.persisted().expandedGroups, ['obj/Gone__c']);
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
    p.flush(); // renderActions is deferred (sendAction) — flush before reading DOM state
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

// ---------------------------------------------- 9) click-to-post ordering
// The user-visible symptom (several seconds between clicking Deploy and the
// confirm modal) turned out to be outside the extension-host path — so the fix
// is to remove the only thing on OUR side that could sit between the click and
// the postMessage call: rendering. sendAction now posts first and defers
// renderActions()/renderStatus() to a rAF/setTimeout callback (see check 8's
// flush() above), and stamps clickedAt/clickSpan for the [timing] log
// (panelProvider.ts, debugTiming) to measure the rest of the trip.
check('Deploy click posts before the deferred render runs', () => {
  const p = armed();
  const b = p.el('deployBtn');
  assert.strictEqual(p.pendingRenders.length, 0, 'a render was already pending before the click');
  assert.ok(click(b));
  // The message is already in the outbound queue — the deferred render has not
  // run yet (nothing has flushed it).
  assert.strictEqual(sent(p, 'deploy'), 1, 'sendAction must post before deferring the render');
  assert.strictEqual(p.pendingRenders.length, 1, 'renderActions/renderStatus must be deferred, not run inline');
  assert.strictEqual(b.disabled, false, 'the DOM must not reflect the click yet — the render is still pending');
  p.flush();
  assert.strictEqual(b.disabled, true, 'flushing the deferred render must lock the button');
});

check('every slot-taking action stamps clickedAt/clickSpan as finite, non-negative numbers', () => {
  const p = armed();
  assert.ok(click(p.el('deployBtn')));
  p.flush();
  const [msg] = p.outbound.filter(m => m.type === 'deploy');
  assert.strictEqual(typeof msg.clickedAt, 'number');
  assert.ok(Number.isFinite(msg.clickedAt) && msg.clickedAt > 0, `clickedAt: ${msg.clickedAt}`);
  assert.strictEqual(typeof msg.clickSpan, 'number');
  assert.ok(Number.isFinite(msg.clickSpan) && msg.clickSpan >= 0, `clickSpan: ${msg.clickSpan}`);
});

check('Deploy queues while busy but never sends while its previous click is unanswered', () => {
  const p = armed({ busy: 'Retrieve' });
  const b = p.el('deployBtn');
  assert.ok(click(b));
  assert.strictEqual(sent(p, 'deploy'), 1);
  p.flush(); // renderActions is deferred (sendAction) — flush before reading DOM state
  assert.strictEqual(b.disabled, true);
  assert.ok(!click(b));
  p.deliver({ type: 'busy', busy: true, action: 'Retrieve' }); // the provider's re-sync: same state
  assert.strictEqual(b.disabled, false);
  assert.strictEqual(b.title, 'Will queue behind Retrieve');
  assert.ok(click(b));
  assert.strictEqual(sent(p, 'deploy'), 2);
  assert.strictEqual(p.el('retrieveBtn').style.display, 'none', 'Retrieve stays hidden while busy');
});

// The newest run's buttons go through the same guards (a notice carries none).
/** A `runs` post with one finished run over the two local classes. */
function RUN(fields) {
  const rows = fields.rows || DC.selected.map(k => ({ k, o: fields.o || 'deployed', s: 1 }));
  const run = Object.assign({
    v: 1, id: 'rbtn00001', op: 'deploy', status: 'succeeded', org: 'acme-dev-user', orgLabel: 'acme-dev', orgKind: 'sandbox',
    startedAt: 1, finishedAt: 2, target: 'selection', counts: { sent: rows.length }, rows, rowsComplete: true, tests: []
  }, fields.run || {});
  return { type: 'runs', runs: [run], cap: 3, latestRows: { runId: run.id, rows, tests: [] } };
}
const RUN_BTNS = [
  ['Retry deploy', 'retryDeploy', RUN({ o: 'rolledback', run: { status: 'failed', retry: { validateOnly: false, testLevel: 'NoTestRun' } } }), 1],
  ['Resume monitoring', 'resumeDeploy', RUN({ o: 'pending', run: { status: 'lost', jobId: '0Af000000000001AAA' } }), 1],
  ['Restore backup…', 'restoreBackup', RUN({ o: 'changed', run: { op: 'retrieve', backupDir: '/backups/x' } }), 1],
  ['Discard backup', 'discardBackup', RUN({ o: 'changed', run: { op: 'retrieve', backupDir: '/backups/x' } }), 1],
  ['Select 2 in tree', 'selectDeployed', RUN({}), 2] // selection-only: never gated
];
for (const [label, type, msg, expect] of RUN_BTNS) {
  check(`run card "${label}": two clicks send ${expect} ${type}`, () => {
    const p = armed();
    p.deliver(msg);
    click(findBtn(p, label));
    click(findBtn(p, label)); // re-found: a render replaces the element under the cursor
    assert.strictEqual(sent(p, type), expect);
    p.flush(); // renderActions/renderStatus are deferred (sendAction) — flush before reading DOM state
    if (expect === 1) {
      assert.strictEqual(findBtn(p, label).disabled, true);
      assert.strictEqual(findBtn(p, label).title, 'Sending…');
      assert.strictEqual(p.el('deployBtn').disabled, true, 'the toolbar locks with the run card');
      p.deliver({ type: 'busy', busy: false });
      assert.strictEqual(findBtn(p, label).disabled, false);
      assert.strictEqual(p.el('deployBtn').disabled, false);
    }
  });
}

check('run card Retry queues while busy, not while pending', () => {
  const p = armed({ busy: 'Deploy' });
  p.deliver(RUN_BTNS[0][2]);
  assert.ok(click(findBtn(p, 'Retry deploy')));
  assert.strictEqual(sent(p, 'retryDeploy'), 1);
  p.flush(); // renderActions/renderStatus are deferred (sendAction) — flush before reading DOM state
  assert.ok(!click(findBtn(p, 'Retry deploy')));
  p.deliver({ type: 'busy', busy: true, action: 'Deploy' });
  assert.strictEqual(findBtn(p, 'Retry deploy').title, 'Will queue behind Deploy');
  assert.ok(click(findBtn(p, 'Retry deploy')));
  assert.strictEqual(sent(p, 'retryDeploy'), 2);
});

check('Quick Deploy stays one-shot', () => {
  const p = armed();
  p.deliver(RUN({ o: 'validated', run: { op: 'validate', jobId: '0Af000000000001AAA', testsRan: true, counts: { validated: 2, sent: 2 }, quick: { jobId: '0Af000000000001AAA', until: Date.now() + 864e5 } } }));
  assert.ok(click(findBtn(p, 'Quick Deploy 2 to acme-dev')));
  p.flush(); // renderStatus is deferred (sendAction) — flush before reading DOM state
  assert.strictEqual(findBtn(p, 'Quick Deploy 2 to acme-dev'), null, 'the button must vanish on its one click');
  p.deliver({ type: 'busy', busy: false });
  assert.strictEqual(findBtn(p, 'Quick Deploy 2 to acme-dev'), null, 'and stays gone once the provider answers');
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

// ---------------------------------- 10) B1/B8: dependency-suggestion rendering
// The provider-side contract (liveSuggestions, orgOverride, transient selectKeys,
// the live payload merged into the newest run) is covered end to end in
// check-suggestion-flow.cjs against the REAL provider; this section is the
// webview-only half — panel.js is a browser IIFE with no exports of its own, so
// it can only be driven the way check-panel-selection.cjs already does, by
// delivering messages and reading back the DOM/state.
/** A failed run whose live payload carries a dependency suggestion — the only
 *  place a suggestion shows (a notice never carries one). */
const suggestRun = (suggest = {}) => {
  const rows = [{ k: 'ApexClass:MyThing', o: 'failed', s: 1, m: 'Invalid type: smth__mdt' }];
  const run = {
    v: 1, id: 'rsug00001', op: 'deploy', status: 'failed', org: 'acme-dev-user', orgLabel: 'acme-dev', orgKind: 'sandbox',
    startedAt: 1, finishedAt: 2, target: 'selection', counts: { failed: 1, rolledback: 0, sent: 1 }, rows, rowsComplete: true, tests: [],
    suggestId: 'sug-1000-0',
    suggest: Object.assign({
      id: 'sug-1000-0',
      candidates: [{ key: 'CustomObject:smth__mdt', from: 'ApexClass:MyThing', why: 'Invalid type: smth__mdt' }],
      unresolved: ['Ghost__mdt']
    }, suggest)
  };
  return { type: 'runs', runs: [run], cap: 3, latestRows: { runId: run.id, rows, tests: [] } };
};
const openSuggestBtn = (p) => p.el('status').find(e => e.tagName === 'BUTTON' && /^Try with dependencies/.test(e.textContent));
const statusLines = (p) => { const o = []; p.el('status').find(e => { if (e.tagName === 'LI') o.push(e.textContent); return false; }); return o; };
const suggestWhys = (p) => { const o = []; p.el('status').find(e => { if (e.className === 'suggest-why') o.push(e.textContent); return false; }); return o; };
const suggestRows = (p) => p.el('status').find(e => e.className === 'suggest-rows');
const suggestUnresolved = (p) => p.el('status').find(e => e.className === 'suggest-unresolved');

check('B11: the "Try with dependencies" button renders even when the run offers no Retry', () => {
  const p = panel(null);
  p.deliver(suggestRun()); // no `retry` on the run at all
  assert.ok(openSuggestBtn(p), 'the button must not be gated behind Retry');
});

check('B8: opening the suggestion keeps the org error visible below the checkbox rows', () => {
  const p = panel(null);
  p.el('status').clientHeight = 400;
  p.deliver(suggestRun());
  openSuggestBtn(p).fire('click');
  assert.ok(suggestRows(p), 'checkbox rows did not render');
  const listed = p.el('status').find(e => e._classes && e._classes.has('run-list'));
  const text = (e) => (e ? [e.textContent, ...e.children.map(text)].join('') : '');
  assert.ok(text(listed).includes('Invalid type: smth__mdt'), 'expected the failed row to stay listed');
});

check('B8: the "why" reason renders under its checkbox', () => {
  const p = panel(null);
  p.deliver(suggestRun());
  openSuggestBtn(p).fire('click');
  assert.deepStrictEqual(suggestWhys(p), ['Invalid type: smth__mdt']);
});

check('B8: a candidate with no why renders no suggest-why row (field is optional)', () => {
  const p = panel(null);
  p.deliver(suggestRun({ candidates: [{ key: 'CustomObject:smth__mdt' }], unresolved: [] }));
  openSuggestBtn(p).fire('click');
  assert.deepStrictEqual(suggestWhys(p), []);
});

check('B11: the unresolved wording says "Not found in your workspace (retrieve it, or its type is not scanned)"', () => {
  const p = panel(null);
  p.deliver(suggestRun());
  openSuggestBtn(p).fire('click');
  const el = suggestUnresolved(p);
  assert.ok(el, 'no suggest-unresolved element');
  assert.ok(el.textContent.startsWith('Not found in your workspace (retrieve it, or its type is not scanned): '), el.textContent);
  assert.ok(el.textContent.includes('Ghost__mdt'), el.textContent);
});

check('B1: the old suggestionRestore message is inert — a suggestion now comes back with its run', () => {
  // A kept card is a record with no buttons; the provider merges a still-live
  // suggestion into the newest run whenever it posts the runs (see
  // check-status-pane.cjs), so nothing may re-attach one to a card.
  const p = panel(null);
  p.deliver({
    type: 'statusHistory',
    cards: [{
      kind: 'err', title: 'Deploy failed', at: 1, suggestId: 'sug-2000-0',
      lines: ['Missing but available locally: CustomObject:smth__mdt — add them to the deploy by hand.', 'ApexClass:MyThing — Invalid type: smth__mdt']
    }]
  });
  p.deliver({ type: 'suggestionRestore', id: 'sug-2000-0', candidates: [{ key: 'CustomObject:smth__mdt', from: 'ApexClass:MyThing' }], unresolved: [] });
  assert.ok(!openSuggestBtn(p), 'nothing re-attaches a suggestion to a kept card');
  assert.ok(statusLines(p).some(l => l.startsWith('Missing but available locally')), 'the card still reads as it did');
});

// ---------------------------------- 10) the Changed view's commit sections ----
// A commit used to empty the lens. It now splits it: the uncommitted edits, then
// one collapsible section per commit on this branch, and a catch-all for what the
// base diff reports that no listed commit accounts for. The rows inside a section
// are the ordinary type/object groups, so everything above still applies to them.
const CH_ITEMS = [item('ApexClass', 'AcmeA'), item('ApexClass', 'AcmeB'), item('Flow', 'AcmeF')];
const sectionNodes = (p) => {
  const o = [];
  p.el('tree').find(e => { if (e.classList.contains('section')) o.push(e); return false; });
  return o;
};
const sectionLabels = (p) => sectionNodes(p).map(g => `${g.children[0].children[2].textContent} ${g.children[0].children[3].textContent}`);
const sectionRows = (p, i) => { const o = []; sectionNodes(p)[i].find(e => { if (e.className === 'name') o.push(e.textContent); return false; }); return o; };
const modeHead = (p) => p.el('tree').find(e => e.className === 'mode-head');
const baseBtn = (p) => { const h = modeHead(p); return h && h.children[0]; };
const CHANGED = (extra) => ({
  type: 'changed',
  keys: ['ApexClass:AcmeA', 'ApexClass:AcmeB', 'Flow:AcmeF'],
  uncommitted: ['ApexClass:AcmeA'],
  auto: true,
  commits: [
    { hash: 'a'.repeat(40), short: 'aaaaaaa', subject: 'fix the card', when: 2, keys: ['ApexClass:AcmeB'] },
    { hash: 'b'.repeat(40), short: 'bbbbbbb', subject: 'first cut', when: 1, keys: ['ApexClass:AcmeB', 'Flow:AcmeF'] }
  ],
  ...extra
});

check('no commits to show renders the flat tree exactly as before', () => {
  const p = panel({ ...BASE, viewMode: 'changed' });
  p.deliver(TFILES(CH_ITEMS));
  p.deliver({ type: 'changed', keys: ['ApexClass:AcmeA'], uncommitted: ['ApexClass:AcmeA'], commits: [] });
  assert.deepStrictEqual(sectionNodes(p), [], 'one section would be pure overhead');
  assert.deepStrictEqual(names(p), ['AcmeA']);
  assert.strictEqual(baseBtn(p).textContent, 'Uncommitted only');
});

check('sections run newest work first: uncommitted, each commit, then what no commit accounts for', () => {
  const p = panel({ ...BASE, viewMode: 'changed' });
  p.deliver(TFILES([...CH_ITEMS, item('ApexClass', 'AcmeOld')]));
  p.deliver(CHANGED({ keys: ['ApexClass:AcmeA', 'ApexClass:AcmeB', 'Flow:AcmeF', 'ApexClass:AcmeOld'] }));
  assert.deepStrictEqual(sectionLabels(p), [
    'Uncommitted (1)',
    'aaaaaaa fix the card (1)',
    'bbbbbbb first cut (2)',
    'Other changes (1)'
  ], 'the residue is not necessarily "earlier": under an explicit ref it is whatever no listed commit accounts for');
  assert.strictEqual(baseBtn(p).textContent, 'This branch');
});

check('uncommitted work is open, commits are collapsed, and a section keeps its own expansion', () => {
  const p = panel({ ...BASE, viewMode: 'changed' });
  p.deliver(TFILES(CH_ITEMS));
  p.deliver(CHANGED());
  assert.deepStrictEqual(sectionRows(p, 0), ['AcmeA'], 'the edits you have in hand are the point of the view');
  assert.deepStrictEqual(sectionRows(p, 1), [], 'commits start collapsed — the tab must not become a wall');
  sectionNodes(p)[1].children[0].fire('click');
  assert.deepStrictEqual(sectionRows(p, 1), ['AcmeB']);
  assert.deepStrictEqual(sectionRows(p, 2), [], 'one section opened, not all of them');
  assert.deepStrictEqual(p.persisted().expandedGroups, [], 'commit hashes never enter the persisted group set');
});

check('a commit that is not yours carries its author in the section label', () => {
  const p = panel({ ...BASE, viewMode: 'changed' });
  p.deliver(TFILES(CH_ITEMS));
  p.deliver(CHANGED({
    commits: [
      { hash: 'a'.repeat(40), short: 'aaaaaaa', subject: 'fix the card', when: 2, keys: ['ApexClass:AcmeB'], author: 'Jane' },
      { hash: 'b'.repeat(40), short: 'bbbbbbb', subject: 'first cut', when: 1, keys: ['Flow:AcmeF'] }
    ]
  }));
  assert.deepStrictEqual(sectionLabels(p), [
    'Uncommitted (1)',
    'aaaaaaa fix the card (by Jane) (1)',
    'bbbbbbb first cut (1)'
  ], 'your own commits must not be labelled with your name, and someone else\'s must');
});

check('groups inside a section fold, and fold only inside that section', () => {
  const p = panel({ ...BASE, viewMode: 'changed' });
  p.deliver(TFILES(CH_ITEMS));
  p.deliver(CHANGED({
    uncommitted: ['ApexClass:AcmeA'],
    commits: [
      { hash: 'a'.repeat(40), short: 'aaaaaaa', subject: 'one', when: 2, keys: ['ApexClass:AcmeB'] },
      { hash: 'b'.repeat(40), short: 'bbbbbbb', subject: 'two', when: 1, keys: ['ApexClass:AcmeB'] }
    ]
  }));
  sectionNodes(p)[1].children[0].fire('click');
  sectionNodes(p)[2].children[0].fire('click');
  assert.deepStrictEqual(sectionRows(p, 1), ['AcmeB']);
  // The ApexClass group header inside the first commit section.
  const group = sectionNodes(p)[1].find(e => e.className === 'group-header' && e.children[2].textContent === 'ApexClass');
  assert.ok(group, 'no type group inside the section');
  group.fire('click');
  assert.deepStrictEqual(sectionRows(p, 1), [], 'the group folded');
  assert.deepStrictEqual(sectionRows(p, 2), ['AcmeB'], 'and only in its own section');
  group.fire('click');
  assert.deepStrictEqual(sectionRows(p, 1), ['AcmeB'], 'and unfolds again');
  assert.deepStrictEqual(p.persisted().expandedGroups, [], 'none of this touches the persisted set');
});

check('Collapse all closes the sections; Expand all opens them and their groups', () => {
  const p = panel({ ...BASE, viewMode: 'changed' });
  p.deliver(TFILES(CH_ITEMS));
  p.deliver(CHANGED());
  assert.ok(names(p).includes('AcmeA'), 'the uncommitted section starts open');
  p.el('collapseAll').fire('click');
  assert.deepStrictEqual(names(p), []);
  assert.ok(sectionLabels(p).length >= 3, 'the section headers stay — that is what you reopen');
  p.el('expandAll').fire('click');
  assert.ok(names(p).includes('AcmeA') && names(p).includes('AcmeB'));
});

check('a reveal opens what a FOLD hid, not only what a filter hid', () => {
  // The 0.23.x contract: a reveal nobody can see reveals nothing, and a deploy
  // must never carry a component that was never on screen. A fold hides a row
  // exactly like a filter does.
  const p = panel({ ...BASE, viewMode: 'selected', selected: ['ApexClass:AcmeB'] });
  p.deliver(TFILES([item('ApexClass', 'AcmeA'), item('ApexClass', 'AcmeB')]));
  p.el('tree').find(e => e.className === 'group-header').fire('click');
  assert.deepStrictEqual(names(p), [], 'folded');
  p.deliver({ type: 'activeFile', key: 'ApexClass:AcmeA', select: true, scroll: true });
  assert.ok(names(p).includes('AcmeA'), `the revealed row is still hidden by the fold: ${names(p).join(', ')}`);
  // Same in the All view, where a fold under a typed filter hid the match.
  const q = panel({ ...BASE, filter: 'acme' });
  q.deliver(TFILES([item('ApexClass', 'AcmeA'), item('Flow', 'AcmeF')]));
  q.el('tree').find(e => e.className === 'group-header').fire('click');
  q.deliver({ type: 'selectKeys', keys: ['ApexClass:AcmeA'], transient: true, scroll: true });
  assert.ok(names(q).includes('AcmeA'));
  // A key nothing can render is no reason to unfold anything.
  const r = panel({ ...BASE, viewMode: 'selected', selected: ['ApexClass:AcmeB'] });
  r.deliver(TFILES([item('ApexClass', 'AcmeB')]));
  r.el('tree').find(e => e.className === 'group-header').fire('click');
  r.deliver({ type: 'selectKeys', keys: ['ApexClass:LongGone'], transient: true });
  assert.deepStrictEqual(names(r), [], 'a since-deleted component must not reopen the tree');
});

check('a fold belongs to the search it was made under', () => {
  const p = panel({ ...BASE, filter: 'acme' });
  p.deliver(TFILES([item('ApexClass', 'AcmeA'), item('Flow', 'AcmeF')]));
  p.el('tree').find(e => e.className === 'group-header').fire('click');
  assert.deepStrictEqual(names(p), ['AcmeF'], 'the ApexClass group folded under this search');
  const search = p.el('search');
  search.value = 'acmea';
  search.fire('input');
  // The fold is dropped as the key is typed, not 200 ms later when the debounce
  // fires — so whatever renders first already shows the new search's matches
  // (here a scan landing in between; an identical payload would not re-render).
  p.deliver(TFILES([item('ApexClass', 'AcmeA'), item('Flow', 'AcmeF'), item('ApexClass', 'AcmeZ')]));
  assert.ok(names(p).includes('AcmeA'), `a fold from the previous search swallowed this one: ${names(p).join(', ')}`);
});

check('folds do not leak between views', () => {
  const p = panel({ ...BASE, viewMode: 'selected', selected: ['ApexClass:AcmeA'] });
  p.deliver(TFILES([item('ApexClass', 'AcmeA')]));
  p.deliver({ type: 'changed', keys: ['ApexClass:AcmeA'], uncommitted: ['ApexClass:AcmeA'], commits: [] });
  p.el('tree').find(e => e.className === 'group-header').fire('click');
  assert.deepStrictEqual(names(p), [], 'folded in the Selected lens');
  p.el('viewModes').children.find(b => b.dataset.mode === 'changed').fire('click');
  assert.ok(names(p).includes('AcmeA'), 'the Changed view has its own folds');
});

check('under a filter, Collapse all still means every key once the filter is gone', () => {
  const p = panel({ ...BASE, filter: 'acme', expandedGroups: ['ApexClass', 'Flow', 'GoneType'] });
  p.deliver(TFILES([item('ApexClass', 'AcmeA'), item('Flow', 'AcmeF')]));
  p.el('collapseAll').fire('click');
  assert.deepStrictEqual(names(p), []);
  assert.deepStrictEqual(p.persisted().expandedGroups, [], 'Collapse all clears EVERY key, visible or not — that is what survives the filter');
  p.el('expandAll').fire('click');
  assert.deepStrictEqual(p.persisted().expandedGroups.slice().sort(), ['ApexClass', 'Flow']);
});

check('the Collapse all tooltip says what the click will actually do', () => {
  const p = panel({ ...BASE, viewMode: 'changed' });
  p.deliver(TFILES(CH_ITEMS));
  // Uncommitted-only: no sections exist, so it collapses groups.
  p.deliver({ type: 'changed', keys: ['ApexClass:AcmeA'], uncommitted: ['ApexClass:AcmeA'], commits: [] });
  assert.strictEqual(p.el('collapseAll').title, 'Collapse every group');
  p.deliver(CHANGED());
  assert.strictEqual(p.el('collapseAll').title, 'Collapse every section');
});

check('the header names the branch it is showing', () => {
  const p = panel({ ...BASE, viewMode: 'changed' });
  p.deliver(TFILES(CH_ITEMS));
  p.deliver(CHANGED({ branch: 'feature/acme' }));
  assert.strictEqual(baseBtn(p).textContent, 'feature/acme', '"This branch" named neither the comparison nor the branch');
  // Nothing to name (detached HEAD, or repositories on different branches).
  p.deliver(CHANGED({ branch: undefined, uncommitted: ['ApexClass:AcmeB'] }));
  assert.strictEqual(baseBtn(p).textContent, 'This branch');
});

check('a component touched twice is listed under both commits', () => {
  const p = panel({ ...BASE, viewMode: 'changed' });
  p.deliver(TFILES(CH_ITEMS));
  p.deliver(CHANGED());
  sectionNodes(p)[1].children[0].fire('click');
  sectionNodes(p)[2].children[0].fire('click');
  assert.deepStrictEqual(sectionRows(p, 1), ['AcmeB']);
  assert.deepStrictEqual(sectionRows(p, 2).slice().sort(), ['AcmeB', 'AcmeF']);
});

check('a section whose components are all filtered out renders no header at all', () => {
  const p = panel({ ...BASE, viewMode: 'changed', typeFilter: ['Flow'] });
  p.deliver(TFILES(CH_ITEMS));
  p.deliver(CHANGED());
  assert.deepStrictEqual(sectionLabels(p), ['bbbbbbb first cut (1)'], 'only the commit with a Flow in it');
  assert.strictEqual(tab(p, 'changed'), 'Changed (1)', 'and the tab count agrees with the rows');
});

check('a section header ticks exactly its own components', () => {
  const p = panel({ ...BASE, viewMode: 'changed' });
  p.deliver(TFILES(CH_ITEMS));
  p.deliver(CHANGED());
  sectionNodes(p)[2].children[0].children[0].fire('change'); // "first cut" checkbox
  assert.deepStrictEqual(p.persisted().selected.slice().sort(), ['ApexClass:AcmeB', 'Flow:AcmeF']);
  assert.strictEqual(p.liveCount(), 2);
});

check('the base label is the picker: it names the comparison and asks the provider for a new one', () => {
  const p = panel({ ...BASE, viewMode: 'changed' });
  p.deliver(TFILES(CH_ITEMS));
  p.deliver(CHANGED({ auto: false, base: 'origin/devInt' }));
  assert.strictEqual(baseBtn(p).textContent, 'vs origin/devInt');
  baseBtn(p).fire('click');
  assert.strictEqual(p.outbound.filter(m => m.type === 'pickChangedBase').length, 1, 'one request per click, and nothing else to do webview-side');
});

check('when the automatic comparison gives up, the label says what is on screen', () => {
  // The provider sends `note` when it could not read this branch (a trunk-only
  // checkout, or a branch longer than a branch of work). Claiming "This branch"
  // over a working-tree-only list is the one thing the header must not do.
  const p = panel({ ...BASE, viewMode: 'changed' });
  p.deliver(TFILES(CH_ITEMS));
  p.deliver({
    type: 'changed', keys: ['ApexClass:AcmeA'], uncommitted: ['ApexClass:AcmeA'], commits: [],
    auto: true, note: 'This branch is the whole repository (no other branch to measure against) — showing uncommitted changes only.'
  });
  assert.strictEqual(baseBtn(p).textContent, 'Uncommitted only');
  assert.ok(baseBtn(p).title.includes('whole repository'), 'and the reason is one hover away, not only in the output channel');
  // Auto that DID read the branch keeps its label.
  p.deliver(CHANGED());
  assert.strictEqual(baseBtn(p).textContent, 'This branch');
});

check('a payload that only re-splits the same keys still repaints', () => {
  // Committing moves a component out of "Uncommitted" without changing the key
  // set; the identical-payload shortcut must not swallow that.
  const p = panel({ ...BASE, viewMode: 'changed' });
  p.deliver(TFILES(CH_ITEMS));
  p.deliver({ type: 'changed', keys: ['ApexClass:AcmeB'], uncommitted: ['ApexClass:AcmeB'], auto: true, commits: [] });
  assert.deepStrictEqual(names(p), ['AcmeB']);
  p.deliver({
    type: 'changed', keys: ['ApexClass:AcmeB'], uncommitted: [], auto: true,
    commits: [{ hash: 'c'.repeat(40), short: 'ccccccc', subject: 'commit it', when: 3, keys: ['ApexClass:AcmeB'] }]
  });
  assert.deepStrictEqual(sectionLabels(p), ['ccccccc commit it (1)']);
});

// ------------------------------------------------- 6e) a pasted list of names
// "The deploy error names five classes — show me those, not one at a time."
const LIST = [item('ApexClass', 'AcmeA'), item('ApexClass', 'AcmeAB'), item('ApexClass', 'AcmeB'), item('Flow', 'AcmeF'), item('CustomObject', 'Acme__c')];
const seenList = (filter) => { const p = panel({ ...BASE, filter }); p.deliver(TFILES(LIST)); return names(p); };

check('a list of full names, however separated, shows exactly those', () => {
  assert.deepStrictEqual(seenList('AcmeA, AcmeB'), ['AcmeA', 'AcmeB'], 'commas — and AcmeAB is not dragged in by the substring');
  assert.deepStrictEqual(seenList('AcmeA\nAcmeB\n'), ['AcmeA', 'AcmeB'], 'newlines');
  assert.deepStrictEqual(seenList('AcmeA AcmeB'), ['AcmeA', 'AcmeB'], 'spaces between full names');
  assert.deepStrictEqual(seenList('acmea;AcmeF'), ['AcmeA', 'AcmeF'], 'semicolons, any case, across types');
  assert.deepStrictEqual(seenList('ApexClass:AcmeA, AcmeF'), ['AcmeA', 'AcmeF'], 'a Type:Name key is a name too');
});

check('in a list a partial or a type: clause still searches the usual way', () => {
  assert.deepStrictEqual(seenList('AcmeA, cmeb'), ['AcmeA', 'AcmeB'], 'a partial in the list still finds its component');
  assert.deepStrictEqual(seenList('AcmeA\ncmeb'), ['AcmeA', 'AcmeB'], 'a newline separates clauses even when a token is a stranger');
  assert.deepStrictEqual(seenList('AcmeA, type:flow'), ['AcmeA', 'AcmeF']);
  assert.deepStrictEqual(seenList('AcmeA, zzz'), ['AcmeA'], 'a stranger in the list hides nothing else');
});

check('a single clause keeps the old grammar: substring, tokens AND-ed', () => {
  assert.deepStrictEqual(seenList('AcmeA'), ['AcmeA', 'AcmeAB'], 'one name is still a substring');
  assert.deepStrictEqual(seenList('acme ab'), ['AcmeAB', 'AcmeB'], 'two partial tokens still AND (AcmeB by its initials)');
  assert.deepStrictEqual(seenList('AcmeA zzz'), ['AcmeA'], 'a full name on the line shows even when the rest matches nothing');
  assert.deepStrictEqual(seenList('AcmeA AcmeB zzz'), ['AcmeA', 'AcmeB'], 'two full names are a list; the stranger (a typo) hides nothing');
  assert.deepStrictEqual(seenList('acmea ab'), ['AcmeA', 'AcmeAB'], 'a full name plus a partial: the name, and the old AND result');
});

check('one pasted error row, path or bracketed name finds its component', () => {
  assert.deepStrictEqual(seenList('ApexClass AcmeA Variable does not exist: foo 12:5'), ['AcmeA']);
  assert.deepStrictEqual(seenList("- 'AcmeB.cls' failed to compile"), ['AcmeB']);
  assert.deepStrictEqual(seenList('force-app\\main\\default\\classes\\AcmeA.cls'), ['AcmeA'], 'a Windows path');
  assert.deepStrictEqual(seenList('(AcmeA)'), ['AcmeA']);
});

check('a type: qualifier keeps its scope inside a list', () => {
  const TWO = [item('Flow', 'AcmeF'), item('ApexClass', 'AcmeF'), item('ApexClass', 'AcmeA')];
  const seen = (filter) => { const p = panel({ ...BASE, filter }); p.deliver(TFILES(TWO)); return names(p); };
  assert.deepStrictEqual(seen('type:flow AcmeF'), ['AcmeF'], 'fixture: the Flow only');
  assert.deepStrictEqual(seen('type:flow AcmeF, AcmeA'), ['AcmeA', 'AcmeF'], 'the ApexClass AcmeF must not ride in on the bare name');
  assert.deepStrictEqual(seen('t:apex AcmeF\nAcmeA'), ['AcmeA', 'AcmeF'], 'the Flow AcmeF must not ride in on the bare name');
});

check('a pasted line is read for the name in it', () => {
  const paste = "ApexClass  AcmeA    Variable does not exist: foo  12:5\n- 'AcmeB.cls'\nforce-app/main/default/flows/AcmeF.flow-meta.xml\r\n\n`AcmeAB`,";
  assert.deepStrictEqual(seenList(paste), ['AcmeA', 'AcmeAB', 'AcmeB', 'AcmeF']);
  // An extension is peeled only when what is left is a component: a field keeps its dots.
  const p = panel({ ...BASE, filter: 'Account.Foo__c, Account.Zzz__c' });
  p.deliver(TFILES([item('CustomObject', 'Account'), item('CustomField', 'Account.Foo__c'), item('CustomField', 'Account.Bar__c')]));
  assert.deepStrictEqual(names(p), ['Account.Foo__c'], 'an unknown field must not resolve to its object');
});

check('full names separated by spaces add to the old AND result rather than replacing it', () => {
  // "account case" used to find AccountCaseSync; it still does, plus the two objects.
  const NOUNS = [item('ApexClass', 'Account'), item('ApexClass', 'Case'), item('ApexClass', 'AccountCaseSync')];
  const seen = (filter) => { const p = panel({ ...BASE, filter }); p.deliver(TFILES(NOUNS)); return names(p); };
  assert.deepStrictEqual(seen('account case'), ['Account', 'AccountCaseSync', 'Case']);
  assert.deepStrictEqual(seen('account, case'), ['Account', 'Case'], 'an explicit list is exact');
});

check('an org-only name counts as a full name once the org has loaded', () => {
  const p = panel({ ...BASE, filter: 'AcmeA AcmeOrg' });
  p.deliver(TFILES(LIST));
  assert.deepStrictEqual(names(p), ['AcmeA'], 'fixture: AcmeOrg is nobody yet, so only the local name shows');
  p.deliver({ type: 'orgMetadata', orgLabel: 'acme-dev', orgItems: [{ type: 'ApexClass', name: 'AcmeOrg' }] });
  assert.deepStrictEqual(names(p), ['AcmeA', 'AcmeOrg']);
});

check('the search box grows with a pasted list and shrinks when it is cleared', () => {
  const p = panel(BASE);
  p.deliver(TFILES(LIST));
  const search = p.el('search');
  assert.strictEqual(search.rows, 1);
  search.value = 'AcmeA\nAcmeB\nAcmeF';
  search.fire('input');
  assert.strictEqual(search.rows, 3, 'one row per pasted line, before the debounce');
  search.value = 'x\n'.repeat(20);
  search.fire('input');
  assert.strictEqual(search.rows, 6, 'capped; the rest scrolls');
  assert.strictEqual(panel({ ...BASE, filter: 'AcmeA\nAcmeB' }).el('search').rows, 2, 'a restored list is sized at boot');
  // A reveal that clears the text filter shrinks the box with it.
  const q = panel({ ...BASE, filter: 'AcmeB\nAcmeF' });
  q.deliver(TFILES(LIST));
  assert.strictEqual(q.el('search').rows, 2);
  q.deliver({ type: 'selectKeys', keys: ['ApexClass:AcmeA'], scroll: true });
  assert.strictEqual(q.el('search').value, '');
  assert.strictEqual(q.el('search').rows, 1);
});

// ------------------------------------------------ 6f) Select all in the All view
// "Paste a list, ready to tick" had nothing to tick the whole list with: only the
// Changed header had a Select all. It reads the GROUP data like that one does, so
// collapsed groups and the render cap don't shrink it, but in All it takes the
// org-only rows too — they are listed here to be retrieved, and a group's own
// checkbox ticks them.
const selectAll = (p) => p.el('selectAllRows');
const tabBtn = (p, mode) => p.el('viewModes').children.find(b => b.dataset.mode === mode);

check('the Select all button sits in the tools row, left of Expand all', () => {
  assert.ok(/<div id="treeTools" class="mode-head tree-tools"[^>]*>\s*<span><button id="selectAllRows"[^>]*>[^<]*<\/button><\/span>\s*<button id="expandAll"/.test(HTML_TS));
});

check('Select all ticks every row the All view lists, org-only and collapsed ones included', () => {
  const p = panel(BASE);
  p.deliver(TFILES(NESTED, ['CustomField']));
  p.deliver({ type: 'orgMetadata', orgLabel: 'acme-dev', orgItems: [{ type: 'ApexClass', name: 'AcmeOrgOnly' }] });
  assert.deepStrictEqual(names(p), [], 'fixture: every group starts collapsed, so no row is painted');
  assert.strictEqual(selectAll(p).style.display, '');
  assert.strictEqual(selectAll(p).textContent, 'Select all (4)');
  selectAll(p).fire('click');
  assert.strictEqual(p.liveCount(), 4);
  assert.deepStrictEqual(p.persisted().selected.slice().sort(),
    ['ApexClass:AcmeA', 'ApexClass:AcmeOrgOnly', 'CustomField:Acme__c.Foo__c', 'CustomObject:Acme__c']);
});

check('the filters decide what Select all takes, and it adds to the selection', () => {
  const p = panel({ ...BASE, filter: 'AcmeA, AcmeF', selected: ['ApexTrigger:AcmeT'] });
  p.deliver(TFILES(THREE_TYPES));
  assert.strictEqual(selectAll(p).textContent, 'Select all (2)', 'a pasted list names two');
  selectAll(p).fire('click');
  assert.deepStrictEqual(p.persisted().selected.slice().sort(), ['ApexClass:AcmeA', 'ApexTrigger:AcmeT', 'Flow:AcmeF'],
    'the list is added; the tick it hid is kept');
  const q = panel({ ...BASE, typeFilter: ['Flow'] });
  q.deliver(TFILES(THREE_TYPES));
  assert.strictEqual(selectAll(q).textContent, 'Select all (1)', 'the type filter narrows it');
  selectAll(q).fire('click');
  assert.deepStrictEqual(q.persisted().selected, ['Flow:AcmeF']);
});

check('the "In project (local)" source filter keeps every local row and drops org-only ones', () => {
  // Local-only + in-both, which no single option used to show: with it, Select
  // all ticks exactly what a deploy can send — nothing to skip.
  assert.ok(/<option value="local">In project \(local\)<\/option>/.test(HTML_TS));
  const p = panel(BASE);
  p.deliver(TFILES([item('ApexClass', 'AcmeA'), item('ApexClass', 'AcmeB')]));
  p.deliver({ type: 'orgMetadata', orgLabel: 'acme-dev', orgItems: [{ type: 'ApexClass', name: 'AcmeA' }, { type: 'ApexClass', name: 'AcmeOrgOnly' }] });
  p.el('sourceFilter').value = 'local'; p.el('sourceFilter').fire('change');
  assert.strictEqual(selectAll(p).textContent, 'Select all (2)', 'AcmeA (in both) and AcmeB (local only), not AcmeOrgOnly');
  selectAll(p).fire('click');
  assert.deepStrictEqual(p.persisted().selected.slice().sort(), ['ApexClass:AcmeA', 'ApexClass:AcmeB']);
});

check('the command log starts collapsed, and stays open once opened', () => {
  const folded = (p) => p.el('cmdlog').classList.contains('collapsed');
  assert.ok(/<div id="cmdlog" class="cmdlog collapsed">/.test(HTML_TS), 'no flash of an open log before the script runs');
  assert.ok(folded(panel(BASE)), 'a fresh panel');
  assert.ok(folded(panel({ ...BASE, cmdLogCollapsed: false })), 'an old state that only ever wrote the default');
  const p = panel(BASE);
  p.el('cmdlogHeader').fire('click');
  assert.ok(!folded(p), 'one click opens it');
  assert.strictEqual(p.persisted().cmdLogOpen, true);
  assert.ok(!folded(panel(p.persisted())), 'and a reload keeps it open');
});

check('Select all shows in the All view only', () => {
  const p = panel({ ...BASE, viewMode: 'selected', selected: ['ApexClass:AcmeA'] });
  p.deliver(TFILES(THREE_TYPES));
  assert.strictEqual(selectAll(p).style.display, 'none', 'the Selected lens is the selection already');
  tabBtn(p, 'all').fire('click');
  assert.strictEqual(selectAll(p).style.display, '');
  assert.strictEqual(selectAll(p).textContent, 'Select all (3)');
  tabBtn(p, 'changed').fire('click');
  p.deliver({ type: 'changed', keys: ['ApexClass:AcmeA'] });
  assert.strictEqual(selectAll(p).style.display, 'none', 'Changed keeps its own, in its header');
  assert.ok(p.el('tree').find(e => /^Select all/.test(e.textContent)), 'and that one is still there');
});

if (failed) { console.error(`\n${failed} of ${ran} check(s) failed`); process.exit(1); }
console.log(`panel selection: all ${ran} checks passed`);
