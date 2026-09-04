// Per-TYPE contract test for "Compare with Org…": does a diff actually open, and
// against the RIGHT file, for every metadata type this extension can produce?
//   1) npm run compile   2) node scripts/check-diff-matrix.cjs
//
// The LWC bug (right-click Compare on a .js was a dead click) survived a suite of
// 400+ checks because every one of them tested a UNIT — the verdict classifier,
// the notification gate — or a single hand-picked type. Nothing asked the
// type-by-type question. This does, driving the REAL runDiff with the org round
// trip stubbed at the service boundary:
//
//   * local fixture  — built from the path shapes the scanner recognises, with the
//     item derived by the REAL inferItemForPath (so a path→type regression fails
//     here too, not just a diff regression);
//   * org fixture    — written at the SAME relative path, which is the contract of
//     a source-format `sf project retrieve` and the whole reason runDiff matches on
//     basename/suffix rather than converting anything;
//   * every file carries its own path in its body, so "a diff opened" can be
//     checked as "the RIGHT two files were compared" — the failure mode that
//     silently shows you another component's source.
//
// Sidecars are the standing cross-match hazard (`Foo.cls` vs `Foo.cls-meta.xml`),
// so both are written whenever the type has one, and the primary must win. The
// batch case at the end runs every type through ONE retrieve tree, which is where
// a sloppy by-name lookup would pair two components with each other.
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const assert = require('assert');
const Module = require('module');

// ---------------------------------------------------------------- vscode stub
const ui = { diffs: [], warn: [] };
const editorListeners = [];
// What the ">5 diff editors" modal answers. Undefined = the user dismissed it,
// which aborts the run — so the batch cases below have to answer it explicitly.
let modalAnswer;
const resetUi = () => { ui.diffs.length = 0; ui.warn.length = 0; editorListeners.length = 0; modalAnswer = undefined; };

const vscodeStub = {
  window: {
    setStatusBarMessage: () => ({ dispose: () => {} }),
    showInformationMessage: () => Promise.resolve(undefined),
    showWarningMessage: (message) => { ui.warn.push(message); return Promise.resolve(modalAnswer); },
    showErrorMessage: () => Promise.resolve(undefined),
    withProgress: (_o, body) => body({ report: () => {} }, { onCancellationRequested: () => ({ dispose: () => {} }) }),
    onDidChangeVisibleTextEditors: (fn) => { editorListeners.push(fn); return { dispose: () => {} }; }
  },
  commands: {
    executeCommand: (id, ...args) => {
      if (id === 'vscode.diff') ui.diffs.push({ left: args[0].fsPath, right: args[1].fsPath, title: args[2] });
      return Promise.resolve(undefined);
    }
  },
  workspace: { getConfiguration: () => ({ get: (_k, fallback) => fallback }) },
  Uri: { file: (fsPath) => ({ fsPath, scheme: 'file' }) },
  ViewColumn: { Active: -1 },
  ProgressLocation: { Notification: 15 }
};
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? vscodeStub : origLoad(req, ...rest));

const { DeployPanelProvider, DIFF_UNSUPPORTED } = require(path.join(__dirname, '..', 'out', 'panelProvider.js'));
const { inferItemForPath, OBJECT_CHILD_TYPES, DIRECTORY_ITEM_TYPES } = require(path.join(__dirname, '..', 'out', 'metadataScanner.js'));

// ------------------------------------------------------------------ fixtures
// `rel` is relative to the package dir. `meta` is the sidecar written alongside
// (the cross-match decoy). `focus` marks the folder-typed components, where the
// diff must be driven by the file the user right-clicked. `fast` is the Tooling
// API body field for the types that take the fast path.
const FIX = [
  { rel: 'classes/Widget.cls', type: 'ApexClass', name: 'Widget', meta: 'classes/Widget.cls-meta.xml', fast: 'Body' },
  { rel: 'triggers/WidgetTrigger.trigger', type: 'ApexTrigger', name: 'WidgetTrigger', meta: 'triggers/WidgetTrigger.trigger-meta.xml', fast: 'Body' },
  { rel: 'pages/WidgetPage.page', type: 'ApexPage', name: 'WidgetPage', meta: 'pages/WidgetPage.page-meta.xml', fast: 'Markup' },
  { rel: 'components/WidgetCmp.component', type: 'ApexComponent', name: 'WidgetCmp', meta: 'components/WidgetCmp.component-meta.xml', fast: 'Markup' },
  { rel: 'lwc/widgetList/widgetList.js', type: 'LightningComponentBundle', name: 'widgetList', focus: true,
    siblings: ['lwc/widgetList/widgetList.html', 'lwc/widgetList/widgetList.js-meta.xml'] },
  { rel: 'aura/WidgetApp/WidgetApp.cmp', type: 'AuraDefinitionBundle', name: 'WidgetApp', focus: true,
    siblings: ['aura/WidgetApp/WidgetAppController.js', 'aura/WidgetApp/WidgetApp.cmp-meta.xml'] },
  { rel: 'flows/Widget_Flow.flow-meta.xml', type: 'Flow', name: 'Widget_Flow' },
  { rel: 'layouts/Widget__c-Widget Layout.layout-meta.xml', type: 'Layout', name: 'Widget__c-Widget Layout' },
  { rel: 'permissionsets/Widget_Access.permissionset-meta.xml', type: 'PermissionSet', name: 'Widget_Access' },
  { rel: 'profiles/Widget User.profile-meta.xml', type: 'Profile', name: 'Widget User' },
  { rel: 'staticresources/WidgetAssets.resource', type: 'StaticResource', name: 'WidgetAssets', meta: 'staticresources/WidgetAssets.resource-meta.xml', unsupported: true },
  { rel: 'tabs/Widget__c.tab-meta.xml', type: 'CustomTab', name: 'Widget__c' },
  { rel: 'labels/CustomLabels.labels-meta.xml', type: 'CustomLabels', name: 'CustomLabels' },
  { rel: 'customMetadata/WidgetSetting__mdt.Default.md-meta.xml', type: 'CustomMetadata', name: 'WidgetSetting__mdt.Default' },
  { rel: 'queues/Widget_Queue.queue-meta.xml', type: 'Queue', name: 'Widget_Queue' },
  { rel: 'groups/Widget_Group.group-meta.xml', type: 'Group', name: 'Widget_Group' },
  { rel: 'globalValueSets/Widget_Values.globalValueSet-meta.xml', type: 'GlobalValueSet', name: 'Widget_Values' },
  { rel: 'workflows/Widget__c.workflow-meta.xml', type: 'Workflow', name: 'Widget__c' },
  { rel: 'flexipages/Widget_Record_Page.flexipage-meta.xml', type: 'FlexiPage', name: 'Widget_Record_Page' },
  { rel: 'applications/Widget_App.app-meta.xml', type: 'CustomApplication', name: 'Widget_App' },
  { rel: 'quickActions/Widget__c.New_Widget.quickAction-meta.xml', type: 'QuickAction', name: 'Widget__c.New_Widget' },
  { rel: 'customPermissions/Manage_Widgets.customPermission-meta.xml', type: 'CustomPermission', name: 'Manage_Widgets' },
  { rel: 'namedCredentials/Widget_API.namedCredential-meta.xml', type: 'NamedCredential', name: 'Widget_API' },
  { rel: 'externalDataSources/Widget_Source.externalDataSource-meta.xml', type: 'ExternalDataSource', name: 'Widget_Source' },
  { rel: 'remoteSiteSettings/Widget_Site.remoteSiteSetting-meta.xml', type: 'RemoteSiteSetting', name: 'Widget_Site' },
  { rel: 'roles/Widget_Manager.role-meta.xml', type: 'Role', name: 'Widget_Manager' },
  { rel: 'settings/Account.settings-meta.xml', type: 'Settings', name: 'Account' },
  { rel: 'messageChannels/Widget_Channel.messageChannel-meta.xml', type: 'LightningMessageChannel', name: 'Widget_Channel' },
  { rel: 'testSuites/Widget_Suite.testSuite-meta.xml', type: 'ApexTestSuite', name: 'Widget_Suite' },
  { rel: 'platformEventSubscriberConfigs/Widget_Cfg.platformEventSubscriberConfig-meta.xml', type: 'PlatformEventSubscriberConfig', name: 'Widget_Cfg' },
  // OmniStudio (standard runtime): one `<fullName>.<suffix>-meta.xml` per component,
  // no sidecar, no bundle. Names carry the version (and, for OmniScripts, the
  // language) segments the platform bakes into the fullName.
  { rel: 'omniScripts/Widget_Intake_English_1.os-meta.xml', type: 'OmniScript', name: 'Widget_Intake_English_1' },
  { rel: 'omniIntegrationProcedures/Widget_Fetch_1.oip-meta.xml', type: 'OmniIntegrationProcedure', name: 'Widget_Fetch_1' },
  { rel: 'omniDataTransforms/WidgetTransform.rpt-meta.xml', type: 'OmniDataTransform', name: 'WidgetTransform' },
  { rel: 'omniUiCard/WidgetCard_1.ouc-meta.xml', type: 'OmniUiCard', name: 'WidgetCard_1' },
  // Two templates with the SAME leaf name in different folders — legal, because
  // EmailTemplate's fullName is `Folder/Name`, and one retrieve lands both. The only
  // shape in the whole table where two components share a basename outside objects/.
  { rel: 'email/Marketing/Welcome.email', type: 'EmailTemplate', name: 'Marketing/Welcome', meta: 'email/Marketing/Welcome.email-meta.xml', twin: 'email/Sales/Welcome.email' },
  { rel: 'email/Sales/Welcome.email', type: 'EmailTemplate', name: 'Sales/Welcome', meta: 'email/Sales/Welcome.email-meta.xml', twin: 'email/Marketing/Welcome.email' },
  // CustomObject: folder-typed like the bundles — the object-meta.xml is the file.
  { rel: 'objects/Widget__c/Widget__c.object-meta.xml', type: 'CustomObject', name: 'Widget__c', focus: true },
  // Decomposed children. Same basename on a DIFFERENT object is the cross-match
  // hazard here, so each fixture ships a twin under objects/Gadget__c/.
  { rel: 'objects/Widget__c/fields/Size__c.field-meta.xml', type: 'CustomField', name: 'Widget__c.Size__c', twin: 'objects/Gadget__c/fields/Size__c.field-meta.xml' },
  { rel: 'objects/Widget__c/businessProcesses/Standard.businessProcess-meta.xml', type: 'BusinessProcess', name: 'Widget__c.Standard', twin: 'objects/Gadget__c/businessProcesses/Standard.businessProcess-meta.xml' },
  { rel: 'objects/Widget__c/compactLayouts/Compact.compactLayout-meta.xml', type: 'CompactLayout', name: 'Widget__c.Compact', twin: 'objects/Gadget__c/compactLayouts/Compact.compactLayout-meta.xml' },
  { rel: 'objects/Widget__c/fieldSets/Main.fieldSet-meta.xml', type: 'FieldSet', name: 'Widget__c.Main', twin: 'objects/Gadget__c/fieldSets/Main.fieldSet-meta.xml' },
  { rel: 'objects/Widget__c/indexes/ByName.index-meta.xml', type: 'Index', name: 'Widget__c.ByName', twin: 'objects/Gadget__c/indexes/ByName.index-meta.xml' },
  { rel: 'objects/Widget__c/listViews/All.listView-meta.xml', type: 'ListView', name: 'Widget__c.All', twin: 'objects/Gadget__c/listViews/All.listView-meta.xml' },
  { rel: 'objects/Widget__c/recordTypes/Standard.recordType-meta.xml', type: 'RecordType', name: 'Widget__c.Standard', twin: 'objects/Gadget__c/recordTypes/Standard.recordType-meta.xml' },
  { rel: 'objects/Widget__c/sharingReasons/Team.sharingReason-meta.xml', type: 'SharingReason', name: 'Widget__c.Team', twin: 'objects/Gadget__c/sharingReasons/Team.sharingReason-meta.xml' },
  { rel: 'objects/Widget__c/validationRules/Size_Positive.validationRule-meta.xml', type: 'ValidationRule', name: 'Widget__c.Size_Positive', twin: 'objects/Gadget__c/validationRules/Size_Positive.validationRule-meta.xml' },
  { rel: 'objects/Widget__c/webLinks/OpenDocs.webLink-meta.xml', type: 'WebLink', name: 'Widget__c.OpenDocs', twin: 'objects/Gadget__c/webLinks/OpenDocs.webLink-meta.xml' }
];

const PKG = path.join('force-app', 'main', 'default');
const orgBody = (rel) => `ORG ${rel}`;
const localBody = (rel) => `LOCAL ${rel}`;
/** Every file a fixture puts in the ORG's retrieve tree: its own file, its sidecar,
 *  its bundle siblings and its same-named twin on another object. */
const orgFilesFor = (f) => [f.rel, ...(f.meta ? [f.meta] : []), ...(f.siblings ?? []), ...(f.twin ? [f.twin] : [])];

let workspace;
async function writeTree(root, rels, body) {
  for (const rel of rels) {
    const abs = path.join(root, PKG, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, body(rel), 'utf8');
  }
}

// The item under test, derived by the REAL path→type logic.
function itemFor(f) {
  const abs = path.join(workspace, PKG, f.rel);
  const item = inferItemForPath(abs);
  assert.ok(item, `inferItemForPath did not recognise ${f.rel}`);
  assert.strictEqual(`${item.type}:${item.name}`, `${f.type}:${f.name}`,
    `${f.rel} resolved to ${item.type}:${item.name}`);
  return item;
}

/** Provider stub. `orgRels` is what the org "has": the retrieve writes those at the
 *  same relative path a source-format retrieve would. `records` feeds the fast path. */
function diffStub(items, orgRels, records = [], queryFails = false) {
  const posted = [];
  const log = [];
  const stub = Object.create(DeployPanelProvider.prototype);
  stub.view = { visible: true }; // toasts aren't this script's subject
  stub.items = items;
  stub.orgs = [{ username: 'acme-dev-user', alias: 'acme-dev' }];
  stub.cmdSeq = 0;
  stub.post = (m) => posted.push(m);
  stub.reserveBusy = () => true;
  stub.requireRoot = () => workspace;
  stub.requireOrg = () => 'acme-dev-user';
  stub.resolveKeys = () => items;
  stub.setBusy = () => {};
  stub.output = { appendLine: (l) => log.push(l) };
  stub.withWindowProgress = (_t, body) => body(() => {});
  let retrieved = 0;
  stub.sf = {
    queryTooling: () => ({
      cancel: () => {},
      promise: queryFails ? Promise.reject(new Error('tooling query failed')) : Promise.resolve({ records })
    }),
    retrieveMetadata: (_keys, _org, proj) => ({
      cancel: () => {},
      promise: (async () => {
        retrieved++;
        await writeTree(proj, orgRels, orgBody);
        return { result: { messages: [] }, cmd: 'sf project retrieve start' };
      })()
    })
  };
  return { stub, posted, log, retrieves: () => retrieved };
}

const drainTmpCleanup = () => { for (const fn of editorListeners.splice(0)) fn([]); };
const cards = (posted) => posted.filter(m => m.type === 'status').map(m => m.card);
const runDiff = (stub, keys, focusFile) =>
  DeployPanelProvider.prototype.runDiff.call(stub, keys, undefined, focusFile);

let failed = 0;
const queue = [];
const check = (name, fn) => queue.push([name, fn]);

// ------------------------------------------------------------------- per type
for (const f of FIX) {
  check(`${f.type} — the diff opens against the org's own copy of ${path.basename(f.rel)}`, async () => {
    resetUi();
    const item = itemFor(f);
    const local = path.join(workspace, PKG, f.rel);
    const { stub, posted, log } = diffStub(
      [item],
      orgFilesFor(f),
      f.fast ? [{ Name: f.name, NamespacePrefix: null, [f.fast]: orgBody(f.rel) }] : []
    );
    await runDiff(stub, [`${f.type}:${f.name}`], f.focus ? local : undefined);

    if (f.unsupported) {
      drainTmpCleanup();
      assert.strictEqual(ui.diffs.length, 0, 'an unsupported type must not open an editor');
      const card = cards(posted)[0];
      assert.strictEqual(card.title, 'Nothing to diff');
      assert.ok(card.lines[0].includes('diff not supported'), card.lines[0]);
      return;
    }
    assert.strictEqual(ui.diffs.length, 1,
      `no diff opened — card: ${JSON.stringify(cards(posted))} log: ${log.join(' | ')}`);
    assert.strictEqual(ui.diffs[0].right, local, 'the local side must be this component itself');
    // Read BEFORE draining: the cleanup the drain triggers is a fire-and-forget rm.
    assert.strictEqual(await fsp.readFile(ui.diffs[0].left, 'utf8'), orgBody(f.rel),
      'compared against the WRONG org file (sidecar, sibling or same-named twin)');
    drainTmpCleanup();
  });
}

// Fast-path types must not pay for a retrieve — and must still work when the
// Tooling query dies, which is the path a managed/hidden body takes.
for (const f of FIX.filter(x => x.fast)) {
  check(`${f.type} — Tooling fast path, no retrieve`, async () => {
    resetUi();
    const { stub, retrieves } = diffStub([itemFor(f)], orgFilesFor(f),
      [{ Name: f.name, NamespacePrefix: null, [f.fast]: orgBody(f.rel) }]);
    await runDiff(stub, [`${f.type}:${f.name}`]);
    assert.strictEqual(ui.diffs.length, 1);
    assert.strictEqual(retrieves(), 0, 'the fast path must not fall back to a retrieve');
    drainTmpCleanup();
  });

  check(`${f.type} — Tooling query fails, retrieve fallback still diffs`, async () => {
    resetUi();
    const { stub, posted, log, retrieves } = diffStub([itemFor(f)], orgFilesFor(f), [], true);
    await runDiff(stub, [`${f.type}:${f.name}`]);
    assert.strictEqual(retrieves(), 1, 'a failed query must fall back to the retrieve');
    assert.strictEqual(ui.diffs.length, 1,
      `fallback opened nothing — card: ${JSON.stringify(cards(posted))} log: ${log.join(' | ')}`);
    assert.strictEqual(await fsp.readFile(ui.diffs[0].left, 'utf8'), orgBody(f.rel));
    drainTmpCleanup();
  });
}

// ---------------------------------------------------------------- all at once
// One retrieve tree holding every type. This is where a by-name lookup pairs two
// components with each other — invisible in the one-type-at-a-time cases above.
check('BATCH: every retrieve-path type in ONE tree still pairs correctly', async () => {
  resetUi();
  modalAnswer = 'Open All'; // past the >5-editors cap
  const batch = FIX.filter(f => !f.fast && !f.unsupported && !f.focus);
  const items = batch.map(itemFor);
  const orgRels = batch.flatMap(orgFilesFor);
  const { stub, posted, log } = diffStub(items, orgRels);
  await runDiff(stub, batch.map(f => `${f.type}:${f.name}`));
  assert.strictEqual(ui.diffs.length, batch.length,
    `expected ${batch.length} diffs, got ${ui.diffs.length} — card: ${JSON.stringify(cards(posted))} log: ${log.join(' | ')}`);
  for (const f of batch) {
    const local = path.join(workspace, PKG, f.rel);
    const opened = ui.diffs.find(d => d.right === local);
    assert.ok(opened, `${f.type}:${f.name} opened no diff in the batch`);
    assert.strictEqual(await fsp.readFile(opened.left, 'utf8'), orgBody(f.rel),
      `${f.type}:${f.name} was paired with the wrong org file`);
  }
  drainTmpCleanup();
});

// The bug the batch case above caught, pinned by name.
check('REGRESSION: a near-miss in another type\'s folder never beats the exact file', async () => {
  resetUi();
  const tab = FIX.find(f => f.type === 'CustomTab');
  const qa = FIX.find(f => f.type === 'QuickAction');
  // `Widget__c` (tab) is a prefix of `Widget__c.New_Widget` (quick action), and
  // quickActions/ is traversed before tabs/. Retrieving both — one ordinary
  // multi-select diff — used to compare the tab against the quick action's XML.
  // The third file is the same hazard WITHIN the type's own folder: a sibling tab
  // whose name extends this one's, written (and so traversed) first. Only an
  // exact-match-first search picks the right one.
  const sameFolderNearMiss = 'tabs/Widget__c.Extra.tab-meta.xml';
  const { stub } = diffStub([itemFor(tab)], [qa.rel, sameFolderNearMiss, tab.rel]);
  await runDiff(stub, [`${tab.type}:${tab.name}`]);
  assert.strictEqual(ui.diffs.length, 1);
  assert.strictEqual(await fsp.readFile(ui.diffs[0].left, 'utf8'), orgBody(tab.rel),
    'the tab was compared against another component');
  drainTmpCleanup();
});

check('REGRESSION: with the exact file absent, another type\'s near-miss is NOT the answer', async () => {
  resetUi();
  const tab = FIX.find(f => f.type === 'CustomTab');
  const qa = FIX.find(f => f.type === 'QuickAction');
  const { stub, posted } = diffStub([itemFor(tab)], [qa.rel]); // org has no tab at all
  await runDiff(stub, [`${tab.type}:${tab.name}`]);
  drainTmpCleanup();
  assert.strictEqual(ui.diffs.length, 0, 'opened a diff against a different component');
  const card = cards(posted).find(c => c.title.startsWith('Nothing to diff'));
  assert.deepStrictEqual(card && card.lines, ['— CustomTab:Widget__c — not on org']);
});

// A type absent from the org is the other verdict that must stay honest per type.
check('BATCH: types the org does not have report as missing, not as opened', async () => {
  resetUi();
  const batch = FIX.filter(f => !f.fast && !f.unsupported && !f.focus).slice(0, 5);
  const { stub, posted } = diffStub(batch.map(itemFor), []); // org has nothing
  await runDiff(stub, batch.map(f => `${f.type}:${f.name}`));
  drainTmpCleanup();
  assert.strictEqual(ui.diffs.length, 0);
  const card = cards(posted).find(c => c.title.startsWith('Nothing to diff'));
  assert.ok(card, `expected a verdict card: ${JSON.stringify(cards(posted))}`);
  assert.deepStrictEqual(card.lines, batch.map(f => `— ${f.type}:${f.name} — not on org`));
});

// The fixture table is the contract; this keeps it honest as types are added.
check('the fixture table covers every type the diff flow special-cases', () => {
  const covered = new Set(FIX.map(f => f.type));
  for (const t of OBJECT_CHILD_TYPES) assert.ok(covered.has(t), `object child ${t} has no fixture`);
  // The set the focus rule keys on — a new folder-typed component must arrive with a
  // fixture, or the rule that lifts DIFF_UNSUPPORTED for it goes untested.
  for (const t of DIRECTORY_ITEM_TYPES) {
    assert.ok(covered.has(t), `${t} is folder-typed but has no fixture`);
    assert.ok(FIX.find(f => f.type === t).focus, `${t} fixture must exercise the focus rule`);
  }
  for (const t of DIFF_UNSUPPORTED) {
    // StaticResource is the one DIFF_UNSUPPORTED member with no folder-typed
    // escape hatch: source format stores archives as an unzipped FOLDER, so
    // "diff the file you clicked" has no single answer yet.
    assert.ok(covered.has(t), `${t} is DIFF_UNSUPPORTED but has no fixture`);
  }
});

(async () => {
  workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'sf-diff-matrix-'));
  await writeTree(workspace, FIX.flatMap(f => [f.rel, ...(f.meta ? [f.meta] : []), ...(f.siblings ?? [])]), localBody);
  for (const [name, fn] of queue) {
    try {
      await fn();
    } catch (err) {
      failed++;
      console.error(`FAIL: ${name}\n  ${err && err.message}`);
    }
  }
  await fsp.rm(workspace, { recursive: true, force: true });
  if (failed) { console.error(`diff-matrix: ${failed} of ${queue.length} checks failed`); process.exit(1); }
  console.log(`diff-matrix: all ${queue.length} checks passed (${FIX.length} types)`);
})();
