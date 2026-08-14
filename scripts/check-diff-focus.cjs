// Runnable contract test for "Compare with Org…" on a file INSIDE a bundle.
//   1) npm run compile   2) node scripts/check-diff-focus.cjs
//
// LightningComponentBundle / AuraDefinitionBundle / CustomObject are
// DIRECTORY_ITEM_TYPES: their scanned `filePath` is the FOLDER, which cannot go to
// `vscode.diff` — hence DIFF_UNSUPPORTED, hence right-clicking any .js in lwc/
// produced only a "Nothing to diff" card. The context menu's when-clause matches
// those paths, so that dead click was the common case, not a corner.
//
// runDiff's `focusFile` is the way past that set: the clicked file replaces the
// folder as the local side. Pinned here:
//   1. The clicked file is what opens — against ITS counterpart in the retrieve
//      tree, matched on the bundle-relative path. Sibling cross-match is the real
//      hazard (the generic lookup's prefix fallback would answer `myCmp.js` for a
//      clicked `myCmp.html`), so the staged content is asserted, not just the call.
//   2. A file the org's copy of the bundle doesn't have reports as that FILE.
//      "LightningComponentBundle:myCmp — not on org" would be a false verdict when
//      the bundle is on the org and only this file isn't.
//   3. No focus (panel selection) and a click on the FOLDER itself keep the old
//      unsupported verdict — the escape hatch needs a real file to be legitimate.
const path = require('path');
const fsp = require('fs/promises');
const assert = require('assert');
const Module = require('module');

// ---------------------------------------------------------------- vscode stub
const ui = { diffs: [], warn: [] };
const editorListeners = [];
const resetUi = () => { ui.diffs.length = 0; ui.warn.length = 0; editorListeners.length = 0; };

const vscodeStub = {
  window: {
    setStatusBarMessage: () => ({ dispose: () => {} }),
    showInformationMessage: () => Promise.resolve(undefined),
    showWarningMessage: (message) => { ui.warn.push(message); return Promise.resolve(undefined); },
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
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  Uri: { file: (fsPath) => ({ fsPath, scheme: 'file' }) },
  ViewColumn: { Active: -1 },
  ProgressLocation: { Notification: 15 }
};
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? vscodeStub : origLoad(req, ...rest));

const { DeployPanelProvider } = require(path.join(__dirname, '..', 'out', 'panelProvider.js'));

// ------------------------------------------------------------------- fixtures
// A real local bundle on disk: vscode.diff gets file paths, and the staged org
// side is a real copy, so the assertions read actual bytes.
const ORG_FILES = {
  'myCmp.js': 'export default class MyCmp { /* ORG js */ }',
  'myCmp.html': '<template><!-- ORG html --></template>',
  'myCmp.js-meta.xml': '<LightningComponentBundle><isExposed>true</isExposed></LightningComponentBundle>'
};

// The object side. CustomObject is the type where the two producers of an item
// DISAGREE: scanWorkspace records the FOLDER, inferItemForPath (used for anything
// outside the package directories) records the `.object-meta.xml`. The focus rule has
// to be right for both, and only one of them was covered before.
const OBJECT_META = '<CustomObject><label>ORG Widget</label></CustomObject>';

let workspace;
let bundleDir;
let objectDir;
let objectMeta;
let strayLwcFile;
async function setupWorkspace() {
  workspace = await fsp.mkdtemp(path.join(require('os').tmpdir(), 'sf-diff-focus-'));
  const pkg = path.join(workspace, 'force-app', 'main', 'default');
  bundleDir = path.join(pkg, 'lwc', 'myCmp');
  await fsp.mkdir(bundleDir, { recursive: true });
  for (const name of Object.keys(ORG_FILES)) {
    await fsp.writeFile(path.join(bundleDir, name), `LOCAL ${name}`, 'utf8');
  }
  // Present locally, absent from the org copy — case 2.
  await fsp.writeFile(path.join(bundleDir, 'helper.js'), 'LOCAL helper.js', 'utf8');

  objectDir = path.join(pkg, 'objects', 'Widget__c');
  objectMeta = path.join(objectDir, 'Widget__c.object-meta.xml');
  await fsp.mkdir(path.join(objectDir, 'fields'), { recursive: true });
  await fsp.writeFile(objectMeta, '<CustomObject><label>LOCAL Widget</label></CustomObject>', 'utf8');

  // A config file sitting directly under lwc/ — not metadata, but inferItemForPath
  // mints `LightningComponentBundle:jsconfig.json` for it, filePath === the file.
  strayLwcFile = path.join(pkg, 'lwc', 'jsconfig.json');
  await fsp.writeFile(strayLwcFile, '{ "LOCAL": true }', 'utf8');
}

const bundleItem = () => ({
  type: 'LightningComponentBundle',
  name: 'myCmp',
  filePath: bundleDir, // the FOLDER — what the scanner records
  files: Object.keys(ORG_FILES).map(n => path.join(bundleDir, n))
});
/** What scanWorkspace records for an in-project object: the FOLDER. */
const scannedObjectItem = () => ({
  type: 'CustomObject', name: 'Widget__c', filePath: objectDir, files: [objectMeta]
});
/** What inferItemForPath records for an object outside the package dirs: the FILE. */
const inferredObjectItem = () => ({
  type: 'CustomObject', name: 'Widget__c', filePath: objectMeta, files: [objectMeta]
});
/** The bogus item inferItemForPath mints for lwc/jsconfig.json: filePath IS the file. */
const strayBundleItem = () => ({
  type: 'LightningComponentBundle', name: 'jsconfig.json', filePath: strayLwcFile, files: [strayLwcFile]
});

/** Provider stub whose retrieve materializes the org's bundle in the throwaway
 *  project, exactly where the real CLI puts it. */
function diffStub(items) {
  const posted = [];
  const log = [];
  let retrieved = 0;
  const stub = Object.create(DeployPanelProvider.prototype);
  stub.view = undefined;
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
  stub.withWindowProgress = (_title, body) => body(() => {});
  stub.sf = {
    queryTooling: () => ({ promise: Promise.resolve({ records: [] }), cancel: () => {} }),
    retrieveMetadata: (_keys, _org, proj) => ({
      cancel: () => {},
      promise: (async () => {
        retrieved++;
        const pkg = path.join(proj, 'force-app', 'main', 'default');
        const dir = path.join(pkg, 'lwc', 'myCmp');
        await fsp.mkdir(dir, { recursive: true });
        for (const [name, body] of Object.entries(ORG_FILES)) {
          await fsp.writeFile(path.join(dir, name), body, 'utf8');
        }
        // The org's object comes back decomposed: the parent plus its children.
        const objDir = path.join(pkg, 'objects', 'Widget__c');
        await fsp.mkdir(path.join(objDir, 'fields'), { recursive: true });
        await fsp.writeFile(path.join(objDir, 'Widget__c.object-meta.xml'), OBJECT_META, 'utf8');
        await fsp.writeFile(path.join(objDir, 'fields', 'Size__c.field-meta.xml'), '<CustomField>ORG field</CustomField>', 'utf8');
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
function check(name, fn) { queue.push([name, fn]); }

// ------------------------------------------------------------------- checks
check('the clicked .js diffs against the ORG js — not a sibling in the bundle', async () => {
  resetUi();
  const { stub, posted, log } = diffStub([bundleItem()]);
  const clicked = path.join(bundleDir, 'myCmp.js');
  await runDiff(stub, ['LightningComponentBundle:myCmp'], clicked);
  assert.strictEqual(ui.diffs.length, 1, `no diff opened: ${JSON.stringify(cards(posted))} ${log.join(' | ')}`);
  assert.strictEqual(ui.diffs[0].right, clicked, 'the local side must be the file the user clicked');
  const orgSide = await fsp.readFile(ui.diffs[0].left, 'utf8');
  assert.strictEqual(orgSide, ORG_FILES['myCmp.js'], 'cross-matched a sibling instead of the clicked file');
  assert.ok(ui.diffs[0].title.includes('myCmp.js'), `title must name the file: ${ui.diffs[0].title}`);
  assert.ok(cards(posted)[0].title.startsWith('Diff opened'), `unexpected card: ${cards(posted)[0].title}`);
  drainTmpCleanup();
});

check('clicking the .html gets the html — the prefix fallback must not answer', async () => {
  resetUi();
  const { stub } = diffStub([bundleItem()]);
  await runDiff(stub, ['LightningComponentBundle:myCmp'], path.join(bundleDir, 'myCmp.html'));
  assert.strictEqual(ui.diffs.length, 1);
  assert.strictEqual(await fsp.readFile(ui.diffs[0].left, 'utf8'), ORG_FILES['myCmp.html']);
  drainTmpCleanup();
});

check('a file the org bundle lacks is reported as THAT FILE, not as the bundle', async () => {
  resetUi();
  const { stub, posted } = diffStub([bundleItem()]);
  await runDiff(stub, ['LightningComponentBundle:myCmp'], path.join(bundleDir, 'helper.js'));
  assert.strictEqual(ui.diffs.length, 0, 'nothing should open — the org has no helper.js');
  const card = cards(posted).find(c => c.title.startsWith('Nothing to diff'));
  assert.ok(card, `expected a verdict card: ${JSON.stringify(cards(posted))}`);
  assert.deepStrictEqual(card.lines, ['— LightningComponentBundle:myCmp/helper.js — not on org']);
  drainTmpCleanup();
});

check('no focus file (panel selection) keeps the unsupported verdict', async () => {
  resetUi();
  const { stub, posted } = diffStub([bundleItem()]);
  await runDiff(stub, ['LightningComponentBundle:myCmp'], undefined);
  assert.strictEqual(ui.diffs.length, 0);
  assert.strictEqual(cards(posted)[0].title, 'Nothing to diff');
  // …and says so HONESTLY: the type is diffable one file at a time, so the line must
  // point at that instead of claiming the type isn't supported.
  assert.ok(cards(posted)[0].lines[0].includes('no whole-component diff'), cards(posted)[0].lines[0]);
  assert.ok(!cards(posted)[0].lines[0].includes('not supported'), 'stale "unsupported type" wording');
  drainTmpCleanup();
});

check('right-clicking the bundle FOLDER stays unsupported — no file to diff', async () => {
  resetUi();
  const { stub, posted } = diffStub([bundleItem()]);
  await runDiff(stub, ['LightningComponentBundle:myCmp'], bundleDir);
  assert.strictEqual(ui.diffs.length, 0, 'a directory must never reach vscode.diff');
  assert.strictEqual(cards(posted)[0].title, 'Nothing to diff');
  drainTmpCleanup();
});

// ------------------------------------------------- CustomObject, both item shapes
check('CustomObject as the SCANNER records it (folder) — the clicked object-meta.xml diffs', async () => {
  resetUi();
  const { stub, posted, log } = diffStub([scannedObjectItem()]);
  await runDiff(stub, ['CustomObject:Widget__c'], objectMeta);
  assert.strictEqual(ui.diffs.length, 1, `no diff opened: ${JSON.stringify(cards(posted))} ${log.join(' | ')}`);
  assert.strictEqual(ui.diffs[0].right, objectMeta);
  assert.strictEqual(await fsp.readFile(ui.diffs[0].left, 'utf8'), OBJECT_META,
    'paired with a decomposed child instead of the object itself');
  drainTmpCleanup();
});

check('CustomObject as inferItemForPath records it (the FILE) — same result, and still labelled', async () => {
  resetUi();
  const { stub, posted } = diffStub([inferredObjectItem()]);
  await runDiff(stub, ['CustomObject:Widget__c'], objectMeta);
  assert.strictEqual(ui.diffs.length, 1, `no diff opened: ${JSON.stringify(cards(posted))}`);
  assert.strictEqual(await fsp.readFile(ui.diffs[0].left, 'utf8'), OBJECT_META);
  // The retrieve landed the object AND its fields; exactly one file was compared. A
  // bare "CustomObject:Widget__c" would claim the fields and validation rules matched,
  // so an empty diff editor would read as "in sync" when children may differ.
  assert.ok(ui.diffs[0].title.includes('Widget__c.object-meta.xml'),
    `title must name the compared file: ${ui.diffs[0].title}`);
  assert.deepStrictEqual(cards(posted)[0].lines,
    ['✓ opened diff: CustomObject:Widget__c/Widget__c.object-meta.xml']);
  drainTmpCleanup();
});

check('lwc/jsconfig.json is not a component — no focus, and no org round trip', async () => {
  resetUi();
  // inferItemForPath mints LightningComponentBundle:jsconfig.json for any file directly
  // under lwc/. Lifting the gate for it would spend a real retrieve on a component that
  // cannot exist, so the equality case stays reserved for CustomObject.
  const { stub, posted, retrieves } = diffStub([strayBundleItem()]);
  await runDiff(stub, ['LightningComponentBundle:jsconfig.json'], strayLwcFile);
  drainTmpCleanup();
  assert.strictEqual(ui.diffs.length, 0);
  assert.strictEqual(retrieves(), 0, 'burned an org retrieve on a non-component');
  assert.strictEqual(cards(posted)[0].title, 'Nothing to diff');
});

check('a file OUTSIDE the item folder is ignored as a focus', async () => {
  resetUi();
  const { stub, posted } = diffStub([bundleItem()]);
  await runDiff(stub, ['LightningComponentBundle:myCmp'], path.join(workspace, 'elsewhere', 'other.js'));
  assert.strictEqual(ui.diffs.length, 0);
  assert.strictEqual(cards(posted)[0].title, 'Nothing to diff');
  drainTmpCleanup();
});

(async () => {
  await setupWorkspace();
  for (const [name, fn] of queue) {
    try {
      await fn();
    } catch (err) {
      failed++;
      console.error(`FAIL: ${name}\n  ${err && err.message}`);
    }
  }
  await fsp.rm(workspace, { recursive: true, force: true });
  if (failed) { console.error(`diff-focus: ${failed} check(s) failed`); process.exit(1); }
  console.log(`diff-focus: all ${queue.length} checks passed`);
})();
