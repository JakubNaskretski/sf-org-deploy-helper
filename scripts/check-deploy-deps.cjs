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
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? {
  window: {
    showInformationMessage: (message) => { ui.info.push(message); return Promise.resolve(undefined); },
    showWarningMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
    setStatusBarMessage: () => ({ dispose: () => {} })
  },
  workspace: { getConfiguration: () => ({ get: (_k, f) => f }) },
  commands: { executeCommand: () => Promise.resolve(undefined) },
  Uri: { file: (fsPath) => ({ fsPath, scheme: 'file' }) },
  ProgressLocation: { Notification: 15 }
} : origLoad(req, ...rest));

const { DeployPanelProvider } = require(path.join(__dirname, '..', 'out', 'panelProvider.js'));

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

function provider(overrides = {}) {
  const rec = { deploys: [], cards: [] };
  const prov = Object.assign(Object.create(DeployPanelProvider.prototype), {
    items: ITEMS,
    orgs: [{ username: 'acme-dev-user', alias: 'acme-dev' }],
    workspaceRoot: tmp,
    ensureItemsForMenuAction: async () => true,
    runDeploy: async (keys, opts) => { rec.deploys.push({ keys, opts }); return { status: 'ok' }; },
    post: (msg) => { rec.cards.push(msg); },
    ...overrides
  });
  return { prov, rec };
}
const run = (prov, item = ENTRY) =>
  DeployPanelProvider.prototype.deployFileWithDeps.call(prov, { fsPath: item.filePath });

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
  assert.deepStrictEqual(rec.deploys[0].opts.autoIncluded, { count: 3, entryKey: 'ApexClass:OrderSvc' });
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

check('an aborted deploy posts no card — nothing was auto-included anywhere', async () => {
  const { prov, rec } = provider({ runDeploy: async () => ({ status: 'aborted' }) });
  await run(prov);
  assert.deepStrictEqual(rec.cards, []);
});

check('a failed deploy still explains the set — that is when the user most needs it', async () => {
  const { prov, rec } = provider({ runDeploy: async () => ({ status: 'failed' }) });
  await run(prov);
  const card = rec.cards.find(m => m.type === 'status').card;
  assert.strictEqual(card.kind, 'warn');
  assert.strictEqual(card.lines.length, 3);
});

// --------------------------------------------------------- unscannable types
check('a type with no readable source deploys alone and says so', async () => {
  const { prov, rec } = provider();
  await run(prov, ITEMS[3]); // CustomField — canScanDependencies is false
  assert.deepStrictEqual(rec.deploys[0].keys, ['CustomField:Widget__c.Size__c']);
  assert.strictEqual(rec.deploys[0].opts, undefined);
  assert.ok(ui.info.some(m => /Dependency scanning follows Apex, LWC and Aura/.test(m)), ui.info.join(' | '));
});

(async () => {
  for (const [name, fn] of queue) {
    ui.info.length = 0;
    try { await fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed) { console.error(`\n${failed} of ${queue.length} check(s) failed`); process.exit(1); }
  console.log(`deploy-with-dependencies: all ${queue.length} checks passed`);
})();
