// Runnable contract test for "a diff opens only what differs" — every diff, every
// path (Tooling fast path, retrieve slow path).
//   1) npm run compile   2) node scripts/check-diff-sync.cjs
//
// The 0.31.0 report: selecting one object to diff its translation asked "About to
// open 254 diff editors? Open All / First 5" — before the org had even been asked,
// so nothing was known about which of the 254 differed. The cost of a diff is the
// org round trip, not the editor count, so that modal is gone. After the fetch,
// each org/local pair is compared (CRLF→LF and one missing final newline ignored,
// nothing else); identical pairs get NO editor and are counted on the card,
// differing ones get an editor up to sfOrgDeployWrapper.diffEditorCap, the rest are
// named one per line, and an all-identical run says so in a card AND a toast so
// a diff that opens nothing is never a dead click. Pinned here, through the REAL
// runDiff with the org stubbed at the service boundary.
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const assert = require('assert');
const Module = require('module');

// ---------------------------------------------------------------- vscode stub
const ui = { diffs: [], warn: [], notices: [], commands: [] };
const editorListeners = [];
const config = {};
const resetUi = () => {
  for (const k of Object.keys(ui)) ui[k].length = 0;
  editorListeners.length = 0;
  for (const k of Object.keys(config)) delete config[k];
};
const vscodeStub = {
  window: {
    setStatusBarMessage: () => ({ dispose: () => {} }),
    showInformationMessage: () => Promise.resolve(undefined),
    showWarningMessage: (message) => { ui.warn.push(message); return Promise.resolve(undefined); },
    showErrorMessage: () => Promise.resolve(undefined),
    withProgress: (o, body) => { ui.notices.push(o.title); return body({ report: () => {} }, { onCancellationRequested: () => ({ dispose: () => {} }) }); },
    onDidChangeVisibleTextEditors: (fn) => { editorListeners.push(fn); return { dispose: () => {} }; }
  },
  commands: {
    executeCommand: (id, ...args) => {
      ui.commands.push(id);
      if (id === 'vscode.diff') ui.diffs.push({ left: args[0].fsPath, right: args[1].fsPath, title: args[2] });
      return Promise.resolve(undefined);
    }
  },
  workspace: { getConfiguration: () => ({ get: (k, fallback) => (k in config ? config[k] : fallback) }) },
  Uri: { file: (fsPath) => ({ fsPath, scheme: 'file' }) },
  ViewColumn: { Active: -1 },
  ProgressLocation: { Notification: 15 }
};
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? vscodeStub : origLoad(req, ...rest));

const { DeployPanelProvider, ALL_IN_SYNC_LINE, inSyncLine } = require(path.join(__dirname, '..', 'out', 'panelProvider.js'));

let failed = 0;
const queue = [];
const check = (name, fn) => queue.push([name, fn]);

// ------------------------------------------------------------------ fixtures
const PKG = path.join('force-app', 'main', 'default');
let workspace;
const flowBody = (n, label = n) => `<?xml version="1.0" encoding="UTF-8"?>\n<Flow xmlns="http://soap.sforce.com/2006/04/metadata">\n    <label>${label}</label>\n</Flow>\n`;
async function write(root, rel, body) {
  const abs = path.join(root, PKG, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, body, 'utf8');
  return abs;
}
/** A local Flow item; the file is written with `body`. */
async function flow(name, body = flowBody(name)) {
  const filePath = await write(workspace, path.join('flows', `${name}.flow-meta.xml`), body);
  return { type: 'Flow', name, filePath, files: [filePath] };
}
async function apex(name, body) {
  const filePath = await write(workspace, path.join('classes', `${name}.cls`), body);
  return { type: 'ApexClass', name, filePath, files: [filePath] };
}

/** `org` maps a package-relative path to the body the org's retrieve writes there;
 *  `records` feeds the Tooling fast path. */
function diffStub(items, org = {}, records = []) {
  const posted = [];
  const log = [];
  let retrieves = 0;
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
  stub.withWindowProgress = (_t, body) => body(() => {});
  stub.sf = {
    queryTooling: () => ({ cancel: () => {}, promise: Promise.resolve({ records }) }),
    retrieveMetadata: (_keys, _org, proj) => ({
      cancel: () => {},
      promise: (async () => {
        retrieves++;
        for (const [rel, body] of Object.entries(org)) await write(proj, rel, body);
        return { result: { messages: [] }, cmd: 'sf project retrieve start' };
      })()
    })
  };
  return { stub, posted, log, retrieves: () => retrieves };
}
const cards = (posted) => posted.filter(m => m.type === 'status').map(m => m.card);
const drain = () => { for (const fn of editorListeners.splice(0)) fn([]); };
const runDiff = (stub, items) => DeployPanelProvider.prototype.runDiff.call(stub, items.map(i => `${i.type}:${i.name}`));
const orgFlow = (name, body = flowBody(name)) => ({ [path.join('flows', `${name}.flow-meta.xml`)]: body });

// ------------------------------------------------------------------ checks
check('identical component → no editor, counted, and an unmistakable all-in-sync card + toast', async () => {
  resetUi();
  const a = await flow('Acme_Same');
  const { stub, posted } = diffStub([a], orgFlow('Acme_Same'));
  await runDiff(stub, [a]);
  assert.strictEqual(ui.diffs.length, 0, 'an identical file must not open an editor');
  const card = cards(posted)[0];
  assert.deepStrictEqual([card.kind, card.title, card.meta], ['ok', 'All 1 in sync with acme-dev', '0 differ · 1 in sync · 0 not on org']);
  assert.deepStrictEqual(card.lines, [ALL_IN_SYNC_LINE, 'in sync: Flow:Acme_Same']);
  assert.deepStrictEqual(ui.notices, [`SF Deploy: All 1 in sync with acme-dev — ${ALL_IN_SYNC_LINE}`], 'the panel is closed: the toast must say it too');
  assert.strictEqual(ui.warn.length, 0, 'in sync is not a warning');
  drain();
});

check('CRLF-only and final-newline-only differences are in sync; whitespace inside a line is not', async () => {
  resetUi();
  const crlf = await flow('Acme_Crlf');
  const eol = await flow('Acme_Eol');
  const space = await flow('Acme_Space');
  const { stub, posted } = diffStub([crlf, eol, space], {
    ...orgFlow('Acme_Crlf', flowBody('Acme_Crlf').replace(/\n/g, '\r\n')),
    ...orgFlow('Acme_Eol', flowBody('Acme_Eol').replace(/\n$/, '')),
    ...orgFlow('Acme_Space', flowBody('Acme_Space').replace('<label>', '<label> '))
  });
  await runDiff(stub, [crlf, eol, space]);
  assert.deepStrictEqual(ui.diffs.map(d => d.right), [space.filePath]);
  const card = cards(posted)[0];
  assert.strictEqual(card.meta, '1 differ · 2 in sync · 0 not on org');
  assert.ok(card.lines.includes('in sync: Flow:Acme_Crlf, Flow:Acme_Eol'), card.lines.join('\n'));
  assert.ok(!card.lines.includes(ALL_IN_SYNC_LINE), 'something differed — not "all in sync"');
  assert.deepStrictEqual(ui.notices, [], 'an opened editor is the feedback — no toast on top');
  drain();
});

check('vscode.diff order is unchanged: org LEFT (staged copy), local RIGHT', async () => {
  resetUi();
  const a = await flow('Acme_Order', flowBody('Acme_Order', 'local'));
  const { stub } = diffStub([a], orgFlow('Acme_Order', flowBody('Acme_Order', 'org')));
  await runDiff(stub, [a]);
  assert.strictEqual(ui.diffs.length, 1);
  assert.strictEqual(ui.diffs[0].right, a.filePath);
  assert.strictEqual(await fsp.readFile(ui.diffs[0].left, 'utf8'), flowBody('Acme_Order', 'org'));
  // Float-first-diff unchanged: the move follows the FIRST editor, once.
  assert.deepStrictEqual(ui.commands, ['vscode.diff', 'workbench.action.moveEditorToNewWindow']);
  drain();
});

check('no "About to open N editors" modal — the cap applies after the compare, overflow named', async () => {
  resetUi();
  const items = [];
  const org = {};
  for (let i = 0; i < 14; i++) {
    const n = `Acme_F${String(i).padStart(2, '0')}`;
    items.push(await flow(n, flowBody(n, 'local')));
    Object.assign(org, orgFlow(n, flowBody(n, 'org')));
  }
  // Four more that are identical: they must not eat into the cap.
  for (const n of ['Acme_S1', 'Acme_S2', 'Acme_S3', 'Acme_S4']) { items.push(await flow(n)); Object.assign(org, orgFlow(n)); }
  const { stub, posted } = diffStub(items, org);
  await runDiff(stub, items);
  assert.deepStrictEqual(ui.warn, [], `a modal/warning fired: ${ui.warn.join(' | ')}`);
  assert.strictEqual(ui.diffs.length, 10, 'default diffEditorCap is 10');
  const card = cards(posted)[0];
  assert.strictEqual(card.title, 'Diff opened for 10 differing files against acme-dev');
  assert.strictEqual(card.meta, '14 differ · 4 in sync · 0 not on org');
  assert.ok(card.lines.includes('4 more differ — not opened (sfOrgDeployWrapper.diffEditorCap is 10); diff them on their own:'), card.lines.join('\n'));
  assert.deepStrictEqual(card.lines.filter(l => l.startsWith('— differs (not opened): ')),
    ['Acme_F10', 'Acme_F11', 'Acme_F12', 'Acme_F13'].map(n => `— differs (not opened): Flow:${n}`));
  assert.ok(card.lines.includes('in sync: Flow:Acme_S1, Flow:Acme_S2, Flow:Acme_S3, +1 more'), card.lines.join('\n'));
  drain();
});

check('diffEditorCap is read, and clamped (0 → 1, junk → default)', async () => {
  for (const [value, expected] of [[2, 2], [0, 1], ['lots', 10], [1000, 14]]) {
    resetUi();
    config.diffEditorCap = value;
    const items = [];
    const org = {};
    for (let i = 0; i < 14; i++) {
      const n = `Acme_C${i}`;
      items.push(await flow(n, flowBody(n, 'local')));
      Object.assign(org, orgFlow(n, flowBody(n, 'org')));
    }
    const { stub } = diffStub(items, org);
    await runDiff(stub, items);
    assert.strictEqual(ui.diffs.length, expected, `diffEditorCap ${JSON.stringify(value)}`);
    drain();
  }
});

check('Tooling fast path: an identical Apex body opens nothing and costs no retrieve', async () => {
  resetUi();
  const body = 'public class AcmeSvc {\n    void run() {}\n}\n';
  const a = await apex('AcmeSvc', body);
  const { stub, posted, retrieves } = diffStub([a], {}, [{ Name: 'AcmeSvc', NamespacePrefix: null, Body: body.replace(/\n/g, '\r\n') }]);
  await runDiff(stub, [a]);
  assert.strictEqual(ui.diffs.length, 0);
  assert.strictEqual(retrieves(), 0);
  const card = cards(posted)[0];
  assert.deepStrictEqual([card.title, card.lines], ['All 1 in sync with acme-dev', [ALL_IN_SYNC_LINE, 'in sync: ApexClass:AcmeSvc']]);
  drain();
});

check('Tooling fast path: a differing body opens its editor against the org text', async () => {
  resetUi();
  const a = await apex('AcmeDiff', 'public class AcmeDiff { /* local */ }');
  const { stub } = diffStub([a], {}, [{ Name: 'AcmeDiff', NamespacePrefix: null, Body: 'public class AcmeDiff { /* org */ }' }]);
  await runDiff(stub, [a]);
  assert.strictEqual(ui.diffs.length, 1);
  assert.strictEqual(ui.diffs[0].right, a.filePath);
  assert.strictEqual(await fsp.readFile(ui.diffs[0].left, 'utf8'), 'public class AcmeDiff { /* org */ }');
  drain();
});

check('the cap is ONE budget across the fast path and the retrieve', async () => {
  resetUi();
  config.diffEditorCap = 2;
  const cls = await apex('AcmeBudget', 'local');
  const f1 = await flow('Acme_B1', flowBody('Acme_B1', 'local'));
  const f2 = await flow('Acme_B2', flowBody('Acme_B2', 'local'));
  const { stub, posted } = diffStub([cls, f1, f2], { ...orgFlow('Acme_B1', 'org'), ...orgFlow('Acme_B2', 'org') },
    [{ Name: 'AcmeBudget', NamespacePrefix: null, Body: 'org' }]);
  await runDiff(stub, [cls, f1, f2]);
  assert.strictEqual(ui.diffs.length, 2);
  assert.deepStrictEqual(cards(posted)[0].lines.filter(l => l.startsWith('— differs')), ['— differs (not opened): Flow:Acme_B2']);
  drain();
});

check('missing stays "not on org"; with something in sync it is not "all in sync"', async () => {
  resetUi();
  const a = await flow('Acme_Here');
  const b = await flow('Acme_Gone');
  const { stub, posted } = diffStub([a, b], orgFlow('Acme_Here'));
  await runDiff(stub, [a, b]);
  assert.strictEqual(ui.diffs.length, 0);
  const card = cards(posted)[0];
  assert.deepStrictEqual([card.kind, card.title, card.meta], ['warn', 'Diff completed with issues against acme-dev', '0 differ · 1 in sync · 1 not on org']);
  assert.deepStrictEqual(card.lines, ['in sync: Flow:Acme_Here', '— Flow:Acme_Gone — not on org']);
  drain();
});

check('a local file that cannot be read is never called in sync', async () => {
  resetUi();
  const ghost = { type: 'Flow', name: 'Acme_Ghost', filePath: path.join(workspace, PKG, 'flows', 'Acme_Ghost.flow-meta.xml'), files: [] };
  const { stub, posted } = diffStub([ghost], orgFlow('Acme_Ghost'));
  // The retrieve lands the org file; the local one does not exist.
  await runDiff(stub, [ghost]);
  assert.strictEqual(cards(posted)[0].meta, '1 differ · 0 in sync · 0 not on org');
  drain();
});

check('inSyncLine collapses the names into one line', () => {
  assert.strictEqual(inSyncLine([]), undefined);
  assert.strictEqual(inSyncLine(['A']), 'in sync: A');
  assert.strictEqual(inSyncLine(['A', 'B', 'C']), 'in sync: A, B, C');
  assert.strictEqual(inSyncLine(['A', 'B', 'C', 'D', 'E']), 'in sync: A, B, C, +2 more');
});

check('the removed modal stays removed (source)', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'panelProvider.ts'), 'utf8');
  assert.ok(!/About to open \$\{/.test(src) && !src.includes("'First 5'"), 'the pre-retrieve "About to open N diff editors" modal is back');
});

(async () => {
  workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'sf-diff-sync-'));
  for (const [name, fn] of queue) {
    try { await fn(); } catch (err) { failed++; console.error(`FAIL: ${name}\n  ${err && err.message}`); }
  }
  drain();
  await fsp.rm(workspace, { recursive: true, force: true });
  if (failed) { console.error(`diff-sync: ${failed} of ${queue.length} checks failed`); process.exit(1); }
  console.log(`diff-sync: all ${queue.length} checks passed`);
})();
