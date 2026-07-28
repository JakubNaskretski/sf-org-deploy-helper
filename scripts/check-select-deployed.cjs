// Runnable contract test for the "Select these N" affordance on a successful
// result card (selectDeployedButtons + selectableScannedKeys, panelProvider.ts).
// No framework.   1) npm run compile   2) node scripts/check-select-deployed.cjs
//
// The button carries the deployed key list through the webview AND through the
// persisted card history, so those keys come back untrusted and possibly stale.
// Contract under test: the button is offered only for components the tree could
// actually tick — items with LOCAL SOURCE, which excludes a manifest deploy's
// synthesized members (`ApexClass:*`) and a reattached job's org-reported rows —
// and never shares its array with the caller's; and on the way back only a key
// that names a CURRENTLY scanned item with local source may reach the tree — a
// forged, renamed, deleted or org-only key is dropped and counted, so the panel
// can say what it lost instead of quietly selecting fewer components than the
// button promised. Same security rule as the suggestion flow: card text can
// never mint a --metadata key.
//
// Both are pure prototype methods that never touch `this`, so they are called
// directly rather than standing up a provider + webview.
const path = require('path');
const assert = require('assert');
const Module = require('module');
const origLoad = Module._load;
// The click path (below) reaches vscode.window for its status-bar/info messages,
// so the module stub answers those two and records what the user would be told.
const toasts = [];
const statusBar = [];
const vscodeStub = {
  window: {
    setStatusBarMessage: (m) => statusBar.push(m),
    showInformationMessage: (m) => toasts.push(m)
  }
};
Module._load = (req, ...rest) => (req === 'vscode' ? vscodeStub : origLoad(req, ...rest));

const { DeployPanelProvider } = require(path.join(__dirname, '..', 'out', 'panelProvider.js'));
const buildButtons = DeployPanelProvider.prototype.selectDeployedButtons;
const selectable = DeployPanelProvider.prototype.selectableScannedKeys;

let failed = 0;
let ran = 0;
function check(name, fn) {
  ran++;
  try { fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}

const buttons = (items) => buildButtons.call(null, items);
const resolve = (raw, items) => selectable.call(null, raw, items);

// A scanned workspace: two classes, an object with a decomposed field, and one
// org-only member (no filePath — retrieved membership, nothing to deploy).
const local = (type, name) => ({ type, name, filePath: `/ws/force-app/${type}/${name}`, files: [] });
const ITEMS = [
  local('ApexClass', 'AcmeOrderService'),
  local('ApexClass', 'AcmeOrderServiceTest'),
  local('CustomObject', 'Widget__c'),
  local('CustomField', 'Widget__c.Size__c'),
  { type: 'PermissionSet', name: 'AcmeOrgOnly', filePath: '', files: [] }
];

// ------------------------------------------------------- button construction
check('empty run offers no button at all (spreads to nothing)', () => {
  assert.deepStrictEqual(buttons([]), {});
});

check('one component gets singular wording, not "Select these 1"', () => {
  const out = buttons([local('ApexClass', 'AcmeOrderService')]);
  assert.strictEqual(out.buttons.length, 1);
  assert.strictEqual(out.buttons[0].label, 'Select this component');
});

check('several components: the label states the count', () => {
  const out = buttons([local('ApexClass', 'AcmeOrderService'), local('CustomObject', 'Widget__c'), local('CustomField', 'Widget__c.Size__c')]);
  assert.strictEqual(out.buttons[0].label, 'Select these 3');
});

check('the payload is the selectDeployed message with the exact key list', () => {
  const out = buttons([local('ApexClass', 'AcmeOrderService'), local('CustomObject', 'Widget__c')]);
  assert.deepStrictEqual(out.buttons[0].send, {
    type: 'selectDeployed',
    keys: ['ApexClass:AcmeOrderService', 'CustomObject:Widget__c']
  });
});

check('the payload owns its array — a later push into the run\'s items cannot grow it', () => {
  const items = [local('ApexClass', 'AcmeOrderService')];
  const out = buttons(items);
  items.push(local('ApexClass', 'AcmeOrderServiceTest'));
  assert.deepStrictEqual(out.buttons[0].send.keys, ['ApexClass:AcmeOrderService']);
});

// ------------------------------------- synthesized runs offer nothing to select
// A manifest deploy builds its items from <members> and a reattached job from the
// org's own report — in both cases filePath is '' and the "key" names nothing the
// tree contains. Offering the button there promises a selection that can only end
// in "none of those are in your workspace", blaming a workspace change that never
// happened; a wildcard member can never match a local file at all.
check('a manifest deploy (wildcard member) offers no button', () => {
  const manifestItems = [{ type: 'ApexClass', name: '*', filePath: '', files: [] }];
  assert.deepStrictEqual(buttons(manifestItems), {});
});

check('a mixed manifest offers nothing — not even the named member', () => {
  const manifestItems = [
    { type: 'ApexClass', name: '*', filePath: '', files: [] },
    { type: 'CustomObject', name: 'Widget__c', filePath: '', files: [] }
  ];
  assert.deepStrictEqual(buttons(manifestItems), {}, 'manifest members carry no local source, wildcard or not');
});

check('a reattached job (org-reported rows) offers no button', () => {
  const reportItems = [{ type: 'ApexClass', name: 'AcmeOrgOnlyService', filePath: '', files: [] }];
  assert.deepStrictEqual(buttons(reportItems), {});
});

check('a mixed run offers exactly the local rows, and counts only those', () => {
  const out = buttons([local('ApexClass', 'AcmeOrderService'), { type: 'PermissionSet', name: 'AcmeOrgOnly', filePath: '', files: [] }]);
  assert.strictEqual(out.buttons[0].label, 'Select this component');
  assert.deepStrictEqual(out.buttons[0].send.keys, ['ApexClass:AcmeOrderService']);
});

// ------------------------------------------------- what may come back (scan gate)
check('returns {keys, dropped}', () => {
  assert.deepStrictEqual(resolve([], ITEMS), { keys: [], dropped: 0 });
});

check('scanned keys pass through in card order', () => {
  const out = resolve(['CustomObject:Widget__c', 'ApexClass:AcmeOrderService'], ITEMS);
  assert.deepStrictEqual(out, { keys: ['CustomObject:Widget__c', 'ApexClass:AcmeOrderService'], dropped: 0 });
});

check('a key deleted/renamed since the card was written is dropped and counted', () => {
  const out = resolve(['ApexClass:AcmeOrderService', 'ApexClass:AcmeGoneService'], ITEMS);
  assert.deepStrictEqual(out.keys, ['ApexClass:AcmeOrderService']);
  assert.strictEqual(out.dropped, 1);
});

check('an org-only member (no local source) is NOT selectable', () => {
  const out = resolve(['PermissionSet:AcmeOrgOnly'], ITEMS);
  assert.deepStrictEqual(out, { keys: [], dropped: 1 });
});

check('a forged key that merely looks scanned cannot enter the selection', () => {
  // Prefix/suffix near-misses and a wrong type for a real name — all rejected:
  // only an exact Type:Name of a scanned item with local source qualifies.
  const out = resolve(
    ['ApexClass:AcmeOrderService2', 'ApexClass:cmeOrderService', 'ApexTrigger:AcmeOrderService', 'ApexClass:AcmeOrderService '],
    ITEMS
  );
  assert.deepStrictEqual(out.keys, []);
  assert.strictEqual(out.dropped, 4);
});

check('duplicates collapse and are not double-counted as dropped', () => {
  const out = resolve(
    ['ApexClass:AcmeOrderService', 'ApexClass:AcmeOrderService', 'ApexClass:AcmeGoneService', 'ApexClass:AcmeGoneService'],
    ITEMS
  );
  assert.deepStrictEqual(out.keys, ['ApexClass:AcmeOrderService']);
  assert.strictEqual(out.dropped, 1);
});

check('non-string entries are ignored, not stringified into keys', () => {
  const out = resolve([null, 7, { key: 'ApexClass:AcmeOrderService' }, ['ApexClass:AcmeOrderService'], 'ApexClass:AcmeOrderService'], ITEMS);
  assert.deepStrictEqual(out, { keys: ['ApexClass:AcmeOrderService'], dropped: 0 });
});

check('a non-array payload degrades to an empty selection', () => {
  for (const raw of [undefined, null, 'ApexClass:AcmeOrderService', 42, { keys: ['ApexClass:AcmeOrderService'] }]) {
    assert.deepStrictEqual(resolve(raw, ITEMS), { keys: [], dropped: 0 }, `raw=${JSON.stringify(raw)}`);
  }
});

check('an empty scan (nothing loaded yet) selects nothing and reports the loss', () => {
  const out = resolve(['ApexClass:AcmeOrderService', 'CustomObject:Widget__c'], []);
  assert.deepStrictEqual(out, { keys: [], dropped: 2 });
});

// ----------------------------------------------------------------- round trip
check('button payload → scan gate: a live card re-selects exactly its own run', () => {
  const deployed = ITEMS.filter(i => !!i.filePath).map(i => `${i.type}:${i.name}`);
  const out = resolve(buttons(ITEMS).buttons[0].send.keys, ITEMS);
  assert.deepStrictEqual(out, { keys: deployed, dropped: 0 });
});

check('a card built from local items never reports a phantom loss', () => {
  // The `dropped` count is shown as "N no longer in the workspace", so it must
  // only ever count REAL losses. Filtering at build time is what guarantees that
  // for an unchanged workspace: nothing that was never local can inflate it.
  const out = resolve(buttons(ITEMS).buttons[0].send.keys, ITEMS);
  assert.strictEqual(out.dropped, 0, 'the org-only member must never have been offered');
});

// ------------------------------------------------------------- the click path
// What the handler actually posts. `replace` is the load-bearing field: the
// webview's selectKeys handler is ADDITIVE by default (correct for the
// suggestion flow and "Use open tabs"), so without it a button labelled "Select
// these 3" leaves the tree holding those 3 PLUS whatever unrelated work was
// already ticked — and a card is durable history, so that is the normal case,
// not the corner one.
async function clickSelectDeployed(keys, items) {
  const posted = [];
  toasts.length = 0;
  statusBar.length = 0;
  const stub = Object.create(DeployPanelProvider.prototype);
  stub.items = items;
  // A non-empty scan with a known root: ensureItemsForMenuAction (real) then
  // short-circuits without touching the filesystem.
  stub.workspaceRoot = '/ws';
  stub.post = (m) => posted.push(m);
  await DeployPanelProvider.prototype.handleMessage.call(stub, { type: 'selectDeployed', keys });
  return { posted, toasts: [...toasts], statusBar: [...statusBar] };
}

const asyncChecks = [
  ['clicking the button REPLACES the selection with that run', async () => {
    const keys = ['ApexClass:AcmeOrderService', 'CustomObject:Widget__c'];
    const { posted } = await clickSelectDeployed(keys, ITEMS);
    assert.deepStrictEqual(posted, [{ type: 'selectKeys', keys, scroll: true, replace: true }]);
  }],
  ['the count the status bar reports is the count that was selected', async () => {
    const { statusBar } = await clickSelectDeployed(['ApexClass:AcmeOrderService'], ITEMS);
    assert.ok(/selected 1 component(?!s)/.test(statusBar[0]), statusBar[0]);
  }],
  ['a stale card says how many it lost, and selects the rest', async () => {
    const { posted, statusBar } = await clickSelectDeployed(['ApexClass:AcmeOrderService', 'ApexClass:AcmeGoneService'], ITEMS);
    assert.deepStrictEqual(posted[0].keys, ['ApexClass:AcmeOrderService']);
    assert.ok(/1 no longer in the workspace/.test(statusBar[0]), statusBar[0]);
  }],
  ['a card whose components are ALL gone never touches the selection', async () => {
    const { posted, toasts } = await clickSelectDeployed(['ApexClass:AcmeGoneService'], ITEMS);
    assert.deepStrictEqual(posted, [], 'an empty replace would have wiped the live selection');
    assert.ok(/None of those components are in the current workspace scan/.test(toasts[0]), toasts.join(' | '));
  }]
];

(async () => {
  for (const [name, fn] of asyncChecks) {
    ran++;
    try { await fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
  }
  console.log(failed === 0 ? `select-deployed: ${ran} assertions passed` : `select-deployed: ${failed}/${ran} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
