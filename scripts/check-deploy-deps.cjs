// Runnable contract test for "SF Deploy: Deploy File + Dependencies" — the one
// command whose deploy set is mostly NOT what the user selected.
//   1) npm run compile   2) node scripts/check-deploy-deps.cjs
//
// The user right-clicks ONE file; depGraph adds the rest by token/declaration
// matching. That is fine as long as the set is judgeable, which is what the two
// disclosures under test provide:
//   - BEFORE: the confirm modal is told how many components were auto-included on
//     top of the file that was picked (the count on its own is what read as panel
//     state gone wrong when ~25 components appeared).
//   - AFTER: the result card names each auto-included component AND the component
//     whose source referenced it, so an over-inclusion is traceable to one bad
//     match instead of indicting the whole set.
//
// Everything the command does with the org is stubbed; the dependency scan runs
// for real against a temp source tree, because the attribution has to come out of
// the actual resolver rather than a hand-fed list.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const Module = require('module');

const ui = { info: [] };
// Deferred modal support (for the real-runDeploy integration checks further
// down): a check sets `confirmChoiceFn` to auto-answer showWarningMessage
// synchronously; every OTHER check leaves it null, so a real confirm modal
// they never expected to see resolves to undefined (dismissed) exactly like
// the ORIGINAL bare stub did — none of the mocked-runDeploy checks above ever
// reach a real modal, so this is a no-op for them.
let confirmChoiceFn = null;
// A13 settings-clamp checks set this to simulate a hand-edited settings.json
// value outside the schema's min/max (VS Code's own UI enforces it; a raw
// settings.json edit does not) — every other check leaves it empty, so
// getConfiguration keeps returning the plain fallback default as before.
let configOverrides = {};
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? {
  window: {
    showInformationMessage: (message) => { ui.info.push(message); return Promise.resolve(undefined); },
    showWarningMessage: (_message, _options, ...items) =>
      Promise.resolve(confirmChoiceFn ? confirmChoiceFn(items) : undefined),
    showErrorMessage: () => Promise.resolve(undefined),
    setStatusBarMessage: () => ({ dispose: () => {} }),
    withProgress: (_o, body) => body({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) })
  },
  workspace: { getConfiguration: () => ({ get: (k, f) => (k in configOverrides ? configOverrides[k] : f) }) },
  commands: { executeCommand: () => Promise.resolve(undefined) },
  Uri: { file: (fsPath) => ({ fsPath, scheme: 'file' }) },
  ProgressLocation: { Notification: 15, Window: 10 }
} : origLoad(req, ...rest));

const { DeployPanelProvider, autoIncludedNotice } = require(path.join(__dirname, '..', 'out', 'panelProvider.js'));
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'panelProvider.ts'), 'utf8');

let failed = 0;
const queue = [];
function check(name, fn) { queue.push([name, fn]); }

// --------------------------------------------------------------- source tree
// OrderSvc → OrderHelper → OrderUtil, plus a field reference. Real files: the
// resolver reads them off disk exactly as the command does.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-deploy-deps-'));
const classes = path.join(tmp, 'classes');
fs.mkdirSync(classes, { recursive: true });
const cls = (name, body) => {
  const p = path.join(classes, `${name}.cls`);
  fs.writeFileSync(p, body);
  return { type: 'ApexClass', name, filePath: p, files: [p] };
};
const ITEMS = [
  cls('OrderSvc', 'public class OrderSvc { void go() { OrderHelper.run(); Object f = Widget__c.Size__c; } }'),
  cls('OrderHelper', 'public class OrderHelper { public static void run() { new OrderUtil(); } }'),
  cls('OrderUtil', 'public class OrderUtil {}'),
  {
    type: 'CustomField', name: 'Widget__c.Size__c',
    filePath: path.join(tmp, 'objects', 'Widget__c', 'fields', 'Size__c.field-meta.xml'), files: []
  }
];
const ENTRY = ITEMS[0];
// An entry whose file is never written (A10 — the entry itself is unreadable,
// as opposed to a plain "this class references nothing").
const GHOST = { type: 'ApexClass', name: 'OrderGhost', filePath: path.join(classes, 'OrderGhost.cls'), files: [] };
ITEMS.push(GHOST);

function provider(overrides = {}) {
  const rec = { deploys: [], cards: [] };
  const prov = Object.assign(Object.create(DeployPanelProvider.prototype), {
    items: ITEMS,
    orgs: [{ username: 'acme-dev-user', alias: 'acme-dev' }],
    workspaceRoot: tmp,
    output: { appendLine: () => {} },
    ensureItemsForMenuAction: async () => true,
    runDeploy: async (keys, opts) => { rec.deploys.push({ keys, opts }); return { status: 'ok' }; },
    post: (msg) => { rec.cards.push(msg); },
    ...overrides
  });
  return { prov, rec };
}
const run = (prov, item = ENTRY) =>
  DeployPanelProvider.prototype.deployFileWithDeps.call(prov, { fsPath: item.filePath });
// A11: explorer multi-selection — `uri` is just the clicked file, `uris` the
// whole selection (VS Code's own contract).
const runMulti = (prov, entryItems) => DeployPanelProvider.prototype.deployFileWithDeps.call(
  prov, { fsPath: entryItems[0].filePath }, entryItems.map(i => ({ fsPath: i.filePath }))
);

// ------------------------------------------------------- what actually deploys
check('the entry deploys together with its resolved dependencies, entry first', async () => {
  const { prov, rec } = provider();
  await run(prov);
  assert.deepStrictEqual(rec.deploys.length, 1);
  assert.deepStrictEqual(rec.deploys[0].keys, [
    'ApexClass:OrderSvc', 'ApexClass:OrderHelper', 'CustomField:Widget__c.Size__c', 'ApexClass:OrderUtil'
  ]);
});

// ------------------------------------------------------ disclosure BEFORE
check('the confirm modal is told how many were auto-included, and onto what', async () => {
  const { prov, rec } = provider();
  await run(prov);
  // Three added — the count the user can check against "I picked one file".
  // A1/A13: the full shape now carries per-key attribution and the caps used.
  assert.deepStrictEqual(rec.deploys[0].opts.autoIncluded, {
    count: 3,
    entryKey: 'ApexClass:OrderSvc',
    truncated: false,
    dropped: 0,
    refs: [
      { key: 'ApexClass:OrderHelper', from: 'ApexClass:OrderSvc' },
      { key: 'CustomField:Widget__c.Size__c', from: 'ApexClass:OrderSvc' },
      { key: 'ApexClass:OrderUtil', from: 'ApexClass:OrderHelper' }
    ],
    maxDepth: 2,
    maxComponents: 40
  });
});

check('the modal notice built from that shape lists the names and stays under the line cap', async () => {
  const { prov, rec } = provider();
  await run(prov);
  const notice = autoIncludedNotice(rec.deploys[0].opts.autoIncluded);
  assert.ok(notice.includes('ApexClass:OrderHelper — via ApexClass:OrderSvc'), notice);
  assert.ok(notice.includes('ApexClass:OrderUtil — via ApexClass:OrderHelper'), notice);
  assert.ok(!/hit its limits/.test(notice), 'nothing was truncated — no cap sentence expected: ' + notice);
});

check('the auto-included count excludes the file the user picked', async () => {
  const { prov, rec } = provider();
  await run(prov);
  assert.strictEqual(rec.deploys[0].opts.autoIncluded.count, rec.deploys[0].keys.length - 1);
});

check('a file with no dependencies claims none — the plain count is then the truth', async () => {
  const { prov, rec } = provider();
  await run(prov, ITEMS[2]); // OrderUtil references nothing
  assert.deepStrictEqual(rec.deploys[0].keys, ['ApexClass:OrderUtil']);
  assert.strictEqual(rec.deploys[0].opts.autoIncluded, undefined);
});

// ------------------------------------------------------- disclosure AFTER
check('the result card names every auto-included component AND its referrer', async () => {
  const { prov, rec } = provider();
  await run(prov);
  const card = rec.cards.find(m => m.type === 'status').card;
  assert.strictEqual(card.title, 'Auto-included 3 local dependencies of ApexClass:OrderSvc');
  assert.deepStrictEqual(card.lines, [
    'ApexClass:OrderHelper — referenced by ApexClass:OrderSvc',
    'CustomField:Widget__c.Size__c — referenced by ApexClass:OrderSvc',
    'ApexClass:OrderUtil — referenced by ApexClass:OrderHelper (depth 2)'
  ]);
});

check('no card at all when the scan added nothing', async () => {
  const { prov, rec } = provider();
  await run(prov, ITEMS[2]);
  assert.deepStrictEqual(rec.cards, []);
});

// A5: a DISMISSED confirm (or any request that never reached one — no org, a
// refused busy slot…) posts nothing — `confirmed` stays falsy either way.
check('a dismissed confirm posts no card — nothing was auto-included anywhere', async () => {
  const { prov, rec } = provider({ runDeploy: async () => ({ status: 'aborted' }) });
  await run(prov);
  assert.deepStrictEqual(rec.cards, []);
});

// A5: the fix — a QUEUED run (the user said yes to the "Queue: " modal) and a
// submit that THREW after confirm (a conflict) both post the card. From
// deployFileWithDeps' side these look identical (aborted + confirmed); what
// actually sets `confirmed` on each path is pinned separately below via
// enqueueDeploy's own return value and a source pin on runDeploy's returns.
check('a queued dependency deploy still posts the attribution card', async () => {
  const { prov, rec } = provider({ runDeploy: async () => ({ status: 'aborted', confirmed: true }) });
  await run(prov);
  const card = rec.cards.find(m => m.type === 'status');
  assert.ok(card, 'expected the attribution card for a queued run');
  assert.strictEqual(card.card.kind, 'warn');
});

check('a submit that threw after confirm (a conflict) still posts the attribution card', async () => {
  // Same outcome shape as queued — the submit's own failure card is reported
  // separately (reportError, not exercised by this stub); this pins only that
  // deployFileWithDeps' OWN gate treats it as confirmed.
  const { prov, rec } = provider({ runDeploy: async () => ({ status: 'aborted', confirmed: true }) });
  await run(prov);
  assert.ok(rec.cards.some(m => m.type === 'status'), 'expected the attribution card for a post-confirm throw');
});

check('a failed deploy still explains the set — that is when the user most needs it', async () => {
  const { prov, rec } = provider({ runDeploy: async () => ({ status: 'failed' }) });
  await run(prov);
  const card = rec.cards.find(m => m.type === 'status').card;
  assert.strictEqual(card.kind, 'warn');
  assert.strictEqual(card.lines.length, 3);
});

// Source pins (A5): the two ABORTED-but-confirmed returns runDeploy actually
// makes — a queued enqueue and every post-confirm path that never reached a
// terminal result (submit throw, timeout, org-side cancel) — plus the plain
// ABORTED returns that must stay UNCONFIRMED (dismissed modal, no root/org).
check('runDeploy: enqueue success and the post-confirm fallback both return confirmed:true', () => {
  assert.ok(/return queued \? ABORTED_CONFIRMED : ABORTED;/.test(src), 'enqueue result must decide confirmed via enqueueDeploy\'s own return value');
  assert.ok(/return sawTerminal \? \{ status: 'ok' \} : ABORTED_CONFIRMED;/.test(src), 'the final fallback (submit threw / timed out / org-cancelled) must be confirmed:true — it is always past the confirm gate');
  assert.ok(/this\.reportError\(`\$\{verb\} \$\{orgPrep\(verb\)\} \$\{orgLabel\}`, err, retry\);\n\s*\/\/ Past the confirm gate above[^\n]*\n\s*return ABORTED_CONFIRMED;/.test(src), 'a writeTempManifest failure (post-confirm) must also be confirmed:true');
});

check('runDeploy: a dismissed modal and a refused busy-slot twin stay plain ABORTED (unconfirmed)', () => {
  assert.ok(/if \(!confirm\) return ABORTED;/.test(src), 'a dismissed confirm modal must NOT be confirmed:true');
  assert.ok(/if \(this\.confirmOpen\) \{\n\s*vscode\.window\.setStatusBarMessage\('[^']*answer the open confirmation first'[^\n]*\n\s*return ABORTED;/.test(src), 'a refused busy-slot twin must NOT be confirmed:true');
});

// A5, real integration: enqueueDeploy itself only reports `true` (queued) when
// the entry actually landed on the queue — a dismissed "Queue: " modal must
// not look like a successful queue to runDeploy's caller.
check('enqueueDeploy returns true only when the entry is actually pushed', async () => {
  const pushed = [];
  const eprov = Object.assign(Object.create(DeployPanelProvider.prototype), {
    items: ITEMS, orgs: [{ username: 'acme-dev-user', alias: 'acme-dev' }],
    orgStore: { get: () => 'acme-dev-user' }, workspaceRoot: tmp,
    busy: true, deployQueue: [], output: { appendLine: () => {} },
    post: (msg) => pushed.push(msg)
  });
  confirmChoiceFn = () => undefined; // dismiss
  const dismissed = await DeployPanelProvider.prototype.enqueueDeploy.call(eprov, ['ApexClass:OrderSvc'], {});
  assert.strictEqual(dismissed, false);
  assert.strictEqual(eprov.deployQueue.length, 0);
  confirmChoiceFn = (items) => items[0]; // confirm
  const queued = await DeployPanelProvider.prototype.enqueueDeploy.call(eprov, ['ApexClass:OrderSvc'], {});
  confirmChoiceFn = null;
  assert.strictEqual(queued, true);
  assert.strictEqual(eprov.deployQueue.length, 1);
});

// --------------------------------------------------------- unscannable types
check('a type with no readable source deploys alone and says so', async () => {
  const { prov, rec } = provider();
  await run(prov, ITEMS[3]); // CustomField — canScanDependencies is false
  assert.deepStrictEqual(rec.deploys[0].keys, ['CustomField:Widget__c.Size__c']);
  assert.strictEqual(rec.deploys[0].opts, undefined);
  assert.ok(ui.info.some(m => /Dependency scanning follows Apex, LWC and Aura/.test(m)), ui.info.join(' | '));
});

// -------------------------------------------------------------- A11: multi-select
check('multiple selected entries each seed their own scan — entries are never each other\'s deps', async () => {
  const { prov, rec } = provider();
  await runMulti(prov, [ITEMS[0], ITEMS[2]]); // OrderSvc + OrderUtil
  // OrderUtil is BOTH an entry (deployed once, first) and what OrderHelper
  // references — the entry pre-seeds the seen-set, so it is never reported a
  // second time as a "dependency".
  assert.deepStrictEqual(rec.deploys[0].keys, [
    'ApexClass:OrderSvc', 'ApexClass:OrderUtil', 'ApexClass:OrderHelper', 'CustomField:Widget__c.Size__c'
  ]);
  assert.strictEqual(rec.deploys[0].opts.autoIncluded.entryKey, '2 selected files');
});

// ------------------------------------------------------------------- A10
check('an unreadable entry is reported (Output + card), never mistaken for "no dependencies"', async () => {
  const log = [];
  const { prov, rec } = provider({ output: { appendLine: (l) => log.push(l) } });
  await run(prov, GHOST); // file never written to disk
  assert.deepStrictEqual(rec.deploys[0].keys, ['ApexClass:OrderGhost']);
  assert.strictEqual(rec.deploys[0].opts.autoIncluded, undefined, 'nothing was auto-included — the read simply failed');
  assert.ok(log.some(l => /could not read/.test(l) && l.includes('OrderGhost.cls')), log.join(' | '));
  const card = rec.cards.find(m => m.type === 'status');
  assert.ok(card, 'expected a card even though the scan found zero dependencies');
  assert.strictEqual(card.card.kind, 'warn');
  assert.ok(card.card.lines.some(l => /could not read/.test(l)), JSON.stringify(card.card.lines));
});

// --------------------------------------------------------- A13: settings clamp
// VS Code's settings UI enforces the schema's minimum/maximum, but a
// hand-edited settings.json does not — the provider clamps defensively, same
// pattern as fetchConcurrency/commandTimeoutMs.
check('dependencyMaxDepth clamps to [1,3] and falls back to the default (2)', () => {
  const prov = Object.create(DeployPanelProvider.prototype);
  configOverrides = { dependencyMaxDepth: 0 };
  assert.strictEqual(DeployPanelProvider.prototype.dependencyMaxDepth.call(prov), 1);
  configOverrides = { dependencyMaxDepth: 99 };
  assert.strictEqual(DeployPanelProvider.prototype.dependencyMaxDepth.call(prov), 3);
  configOverrides = { dependencyMaxDepth: 3 };
  assert.strictEqual(DeployPanelProvider.prototype.dependencyMaxDepth.call(prov), 3);
  configOverrides = {};
  assert.strictEqual(DeployPanelProvider.prototype.dependencyMaxDepth.call(prov), 2);
});

check('dependencyMaxComponents clamps to [5,200] and falls back to the default (40)', () => {
  const prov = Object.create(DeployPanelProvider.prototype);
  configOverrides = { dependencyMaxComponents: 0 };
  assert.strictEqual(DeployPanelProvider.prototype.dependencyMaxComponents.call(prov), 5);
  configOverrides = { dependencyMaxComponents: 10000 };
  assert.strictEqual(DeployPanelProvider.prototype.dependencyMaxComponents.call(prov), 200);
  configOverrides = {};
  assert.strictEqual(DeployPanelProvider.prototype.dependencyMaxComponents.call(prov), 40);
});

check('deployFileWithDeps actually threads the configured (clamped) depth through the scan', async () => {
  const { prov, rec } = provider();
  configOverrides = { dependencyMaxDepth: 1 }; // Service -> Helper survives; Helper -> Util is cut
  await run(prov);
  assert.deepStrictEqual(rec.deploys[0].keys, [
    'ApexClass:OrderSvc', 'ApexClass:OrderHelper', 'CustomField:Widget__c.Size__c'
  ]);
  assert.strictEqual(rec.deploys[0].opts.autoIncluded.truncated, true);
  assert.strictEqual(rec.deploys[0].opts.autoIncluded.maxDepth, 1);
  assert.ok(rec.deploys[0].opts.autoIncluded.dropped >= 1, JSON.stringify(rec.deploys[0].opts.autoIncluded));
});

(async () => {
  for (const [name, fn] of queue) {
    ui.info.length = 0;
    confirmChoiceFn = null; // a check that throws before resetting it must not leak into the next
    configOverrides = {};
    try { await fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed) { console.error(`\n${failed} of ${queue.length} check(s) failed`); process.exit(1); }
  console.log(`deploy-with-dependencies: all ${queue.length} checks passed`);
})();
