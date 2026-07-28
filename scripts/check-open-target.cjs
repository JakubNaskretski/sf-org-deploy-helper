// Runnable contract test for "the thing you clicked is a folder, not a file".
//   1) npm run compile   2) node scripts/check-open-target.cjs
//
// metadataScanner records `filePath` as the bundle/object FOLDER for the three
// directory-typed components (CustomObject, LightningComponentBundle,
// AuraDefinitionBundle) — deliberately, because deploy targeting, diff, retrieve
// backups and findItemForPath all address that folder. The cost is that anything
// handing `filePath` to an editor gets a directory: clicking an object row in the
// tree produced VS Code's "cannot open ... that is actually a directory".
//
// Pinned here:
//   1. bundleDefinitionFile — the resolution itself. It must be EXPLICIT (the
//      file named after the folder), never "first file in the list": a
//      CustomObject's `files` also carries its decomposed children, so a blind
//      first-file would open some field's -meta.xml and show a different
//      component's source.
//   2. The wiring, through the real openFile handler: a directory resolves to the
//      definition file, a plain file is untouched, and a folder with nothing to
//      open says so instead of throwing at the user.
//   3. DIFF_UNSUPPORTED ⊇ DIRECTORY_ITEM_TYPES — runDiff hands `item.filePath`
//      straight to `vscode.diff`, so that containment is the ONLY thing keeping
//      the second caller off the same wall.
const path = require('path');
const assert = require('assert');
const Module = require('module');

// ---------------------------------------------------------------- vscode stub
const ui = { info: [], opened: [], shown: [] };
const resetUi = () => { for (const k of Object.keys(ui)) ui[k].length = 0; };
// The last check drives the REAL scanWorkspace, which discovers its root through
// the workspace API — hence the findFiles surface alongside the editor one.
const ws = { folders: [], projectFiles: [] };
const vscodeStub = {
  window: {
    showInformationMessage: (message, ...items) => { ui.info.push({ message, items }); return Promise.resolve(undefined); },
    showWarningMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
    setStatusBarMessage: () => ({ dispose: () => {} }),
    showTextDocument: (doc, opts) => { ui.shown.push({ doc, opts }); return Promise.resolve({}); }
  },
  workspace: {
    openTextDocument: (p) => { ui.opened.push(p); return Promise.resolve({ uri: p }); },
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    get workspaceFolders() { return ws.folders; },
    findFiles: async () => ws.projectFiles.map(f => ({ fsPath: f })),
    asRelativePath: (uri) => uri.fsPath
  },
  RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
  commands: { executeCommand: () => Promise.resolve(undefined) },
  Uri: { file: (fsPath) => ({ fsPath, scheme: 'file' }) },
  Range: class { constructor(a, b, c, d) { Object.assign(this, { a, b, c, d }); } },
  ViewColumn: { Active: -1 },
  ProgressLocation: { Notification: 15 }
};
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? vscodeStub : origLoad(req, ...rest));

const { bundleDefinitionFile, DIRECTORY_ITEM_TYPES, scanWorkspace } =
  require(path.join(__dirname, '..', 'out', 'metadataScanner.js'));
const { DeployPanelProvider, DIFF_UNSUPPORTED } =
  require(path.join(__dirname, '..', 'out', 'panelProvider.js'));

let failed = 0;
const queue = [];
function check(name, fn) { queue.push([name, fn]); }
const p = (...s) => s.join(path.sep);

// ------------------------------------------------------ bundleDefinitionFile
// Shapes mirror what scanWorkspace actually produces: `filePath` is the folder,
// `files` is listAllFiles of that folder (recursive, so a CustomObject's field
// files are in there too).
const objectItem = {
  type: 'CustomObject', name: 'Smth__mdt', filePath: p('ws', 'objects', 'Smth__mdt'),
  files: [
    p('ws', 'objects', 'Smth__mdt', 'fields', 'OldField__c.field-meta.xml'),
    p('ws', 'objects', 'Smth__mdt', 'Smth__mdt.object-meta.xml')
  ]
};

check('a CustomObject folder opens its own .object-meta.xml, not a field', () => {
  assert.strictEqual(bundleDefinitionFile(objectItem), p('ws', 'objects', 'Smth__mdt', 'Smth__mdt.object-meta.xml'));
});

check('the field file listed FIRST does not win — resolution is by name, not order', () => {
  // The reported bug's exact shape: the scan lists the decomposed child first,
  // so "first file" would open OldField__c and look like a different bug.
  assert.notStrictEqual(bundleDefinitionFile(objectItem), objectItem.files[0]);
});

check('an LWC folder opens the module, not the template or the -meta.xml', () => {
  const it = {
    type: 'LightningComponentBundle', name: 'depFixCard', filePath: p('ws', 'lwc', 'depFixCard'),
    files: [
      p('ws', 'lwc', 'depFixCard', 'depFixCard.css'),
      p('ws', 'lwc', 'depFixCard', 'depFixCard.js-meta.xml'),
      p('ws', 'lwc', 'depFixCard', 'depFixCard.html'),
      p('ws', 'lwc', 'depFixCard', 'depFixCard.js')
    ]
  };
  assert.strictEqual(bundleDefinitionFile(it), p('ws', 'lwc', 'depFixCard', 'depFixCard.js'));
});

check('an LWC with no .js falls back to the template before the sidecar', () => {
  const it = {
    type: 'LightningComponentBundle', name: 'depFixCard', filePath: p('ws', 'lwc', 'depFixCard'),
    files: [p('ws', 'lwc', 'depFixCard', 'depFixCard.js-meta.xml'), p('ws', 'lwc', 'depFixCard', 'depFixCard.html')]
  };
  assert.strictEqual(bundleDefinitionFile(it), p('ws', 'lwc', 'depFixCard', 'depFixCard.html'));
});

check('an Aura folder opens the .cmp, not the controller or the css', () => {
  const it = {
    type: 'AuraDefinitionBundle', name: 'DepFixPanel', filePath: p('ws', 'aura', 'DepFixPanel'),
    files: [
      p('ws', 'aura', 'DepFixPanel', 'DepFixPanelController.js'),
      p('ws', 'aura', 'DepFixPanel', 'DepFixPanel.css'),
      p('ws', 'aura', 'DepFixPanel', 'DepFixPanel.cmp-meta.xml'),
      p('ws', 'aura', 'DepFixPanel', 'DepFixPanel.cmp')
    ]
  };
  assert.strictEqual(bundleDefinitionFile(it), p('ws', 'aura', 'DepFixPanel', 'DepFixPanel.cmp'));
});

check('an Aura app bundle resolves to the .app', () => {
  const it = {
    type: 'AuraDefinitionBundle', name: 'DepFixApp', filePath: p('ws', 'aura', 'DepFixApp'),
    files: [p('ws', 'aura', 'DepFixApp', 'DepFixApp.app-meta.xml'), p('ws', 'aura', 'DepFixApp', 'DepFixApp.app')]
  };
  assert.strictEqual(bundleDefinitionFile(it), p('ws', 'aura', 'DepFixApp', 'DepFixApp.app'));
});

check('a tokens bundle resolves to its .tokens file', () => {
  // The scanner treats `<name>.tokens-meta.xml` as a bundle marker, so a bundle
  // whose root is a .tokens file is reachable and needs a ranked entry of its own.
  const it = {
    type: 'AuraDefinitionBundle', name: 'DepFixTheme', filePath: p('ws', 'aura', 'DepFixTheme'),
    files: [p('ws', 'aura', 'DepFixTheme', 'DepFixTheme.tokens-meta.xml'), p('ws', 'aura', 'DepFixTheme', 'DepFixTheme.tokens')]
  };
  assert.strictEqual(bundleDefinitionFile(it), p('ws', 'aura', 'DepFixTheme', 'DepFixTheme.tokens'));
});

check('a design bundle resolves to its .design file', () => {
  const it = {
    type: 'AuraDefinitionBundle', name: 'DepFixDesign', filePath: p('ws', 'aura', 'DepFixDesign'),
    files: [p('ws', 'aura', 'DepFixDesign', 'DepFixDesign.design-meta.xml'), p('ws', 'aura', 'DepFixDesign', 'DepFixDesign.design')]
  };
  assert.strictEqual(bundleDefinitionFile(it), p('ws', 'aura', 'DepFixDesign', 'DepFixDesign.design'));
});

check('a NAME-prefixed sibling is not the bundle — the separating dot is required', () => {
  // `DepFixPanelController.js` starts with the bundle name but is a different
  // file; only `<name>.<ext>` is the bundle's own definition. With no ranked
  // extension present, a prefix-only match would hand back the controller.
  const it = {
    type: 'AuraDefinitionBundle', name: 'DepFixPanel', filePath: p('ws', 'aura', 'DepFixPanel'),
    files: [p('ws', 'aura', 'DepFixPanel', 'DepFixPanelController.js'), p('ws', 'aura', 'DepFixPanel', 'DepFixPanel.auradoc')]
  };
  assert.strictEqual(bundleDefinitionFile(it), p('ws', 'aura', 'DepFixPanel', 'DepFixPanel.auradoc'));
});

check('casing drift between folder name and file name still resolves', () => {
  const it = {
    type: 'CustomObject', name: 'Smth__mdt', filePath: p('ws', 'objects', 'Smth__mdt'),
    files: [p('ws', 'objects', 'Smth__mdt', 'SMTH__MDT.object-meta.xml')]
  };
  assert.strictEqual(bundleDefinitionFile(it), p('ws', 'objects', 'Smth__mdt', 'SMTH__MDT.object-meta.xml'));
});

check('a nested file is never mistaken for the folder\'s own definition', () => {
  const it = {
    type: 'CustomObject', name: 'Widget__c', filePath: p('ws', 'objects', 'Widget__c'),
    files: [
      p('ws', 'objects', 'Widget__c', 'listViews', 'All.listView-meta.xml'),
      // Same STEM as the folder, but a level down — a name match alone must not
      // promote it over the plain first-file fallback.
      p('ws', 'objects', 'Widget__c', 'fields', 'Widget__c.field-meta.xml')
    ]
  };
  assert.strictEqual(bundleDefinitionFile(it), it.files[0]);
});

check('metaPath is preferred over an unrelated direct child', () => {
  const it = {
    type: 'CustomObject', name: 'Widget__c', filePath: p('ws', 'objects', 'Widget__c'),
    metaPath: p('ws', 'objects', 'Widget__c', 'sidecar-meta.xml'),
    files: [p('ws', 'objects', 'Widget__c', 'unrelated.xml')]
  };
  assert.strictEqual(bundleDefinitionFile(it), p('ws', 'objects', 'Widget__c', 'sidecar-meta.xml'));
});

check('a folder with no files at all resolves to undefined, never a directory', () => {
  const it = { type: 'CustomObject', name: 'Empty__c', filePath: p('ws', 'objects', 'Empty__c'), files: [] };
  assert.strictEqual(bundleDefinitionFile(it), undefined);
});

// ------------------------------------------------------------- the type sets
check('DIRECTORY_ITEM_TYPES is exactly the three folder-shaped types', () => {
  assert.deepStrictEqual([...DIRECTORY_ITEM_TYPES].sort(),
    ['AuraDefinitionBundle', 'CustomObject', 'LightningComponentBundle']);
});

check('every directory-typed component is DIFF_UNSUPPORTED', () => {
  // runDiff passes item.filePath to vscode.diff with no directory handling of its
  // own; this containment is what keeps that call off the same wall as openFile.
  for (const t of DIRECTORY_ITEM_TYPES) {
    assert.ok(DIFF_UNSUPPORTED.has(t), `${t} would reach vscode.diff with a directory path`);
  }
});

// ------------------------------------------------------------- the real wiring
// openTargetFor stats the path, so these run against a real temp tree.
const fs = require('fs');
const os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-open-target-'));
const objDir = path.join(tmp, 'objects', 'Smth__mdt');
fs.mkdirSync(path.join(objDir, 'fields'), { recursive: true });
fs.writeFileSync(path.join(objDir, 'Smth__mdt.object-meta.xml'), '<CustomObject/>');
fs.writeFileSync(path.join(objDir, 'fields', 'OldField__c.field-meta.xml'), '<CustomField/>');
const clsFile = path.join(tmp, 'classes', 'DepFixSvc.cls');
fs.mkdirSync(path.dirname(clsFile), { recursive: true });
fs.writeFileSync(clsFile, 'public class DepFixSvc {}');

// Minimal provider: openFile only needs resolveKeys, which reads this.items.
const provider = (items) => Object.assign(Object.create(DeployPanelProvider.prototype), {
  items,
  view: { visible: true },
  resolveKeys(keys) { return keys.map(k => items.find(i => `${i.type}:${i.name}` === k)).filter(Boolean); }
});
const handle = (prov, msg) => DeployPanelProvider.prototype.handleMessage.call(prov, msg);

check('clicking a CustomObject row opens the object-meta.xml, not the folder', async () => {
  resetUi();
  const item = {
    type: 'CustomObject', name: 'Smth__mdt', filePath: objDir,
    files: [path.join(objDir, 'fields', 'OldField__c.field-meta.xml'), path.join(objDir, 'Smth__mdt.object-meta.xml')]
  };
  await handle(provider([item]), { type: 'openFile', key: 'CustomObject:Smth__mdt' });
  assert.deepStrictEqual(ui.opened, [path.join(objDir, 'Smth__mdt.object-meta.xml')]);
  assert.strictEqual(ui.info.length, 0, 'the click must not degrade into a message');
});

check('a file-backed component is opened exactly as before', async () => {
  resetUi();
  const item = { type: 'ApexClass', name: 'DepFixSvc', filePath: clsFile, files: [clsFile] };
  await handle(provider([item]), { type: 'openFile', key: 'ApexClass:DepFixSvc' });
  assert.deepStrictEqual(ui.opened, [clsFile]);
});

check('an error-card line still lands the cursor on the reported position', async () => {
  resetUi();
  const item = { type: 'ApexClass', name: 'DepFixSvc', filePath: clsFile, files: [clsFile] };
  await handle(provider([item]), { type: 'openFile', key: 'ApexClass:DepFixSvc', line: 12, column: 4 });
  assert.ok(ui.shown[0].opts.selection, 'selection dropped');
  assert.deepStrictEqual([ui.shown[0].opts.selection.a, ui.shown[0].opts.selection.b], [11, 3]);
});

check('a folder with nothing openable reports it instead of handing over a directory', async () => {
  resetUi();
  const emptyDir = path.join(tmp, 'objects', 'Empty__c');
  fs.mkdirSync(emptyDir, { recursive: true });
  const item = { type: 'CustomObject', name: 'Empty__c', filePath: emptyDir, files: [] };
  await handle(provider([item]), { type: 'openFile', key: 'CustomObject:Empty__c' });
  assert.deepStrictEqual(ui.opened, []);
  assert.strictEqual(ui.info.length, 1);
  assert.ok(/folder with no source file/.test(ui.info[0].message), ui.info[0].message);
});

check('a SYMLINKED bundle folder still resolves — the check follows links', async () => {
  // A package directory reached through a symlink is a normal monorepo shape; an
  // lstat here would call the link a file and hand the directory straight to the
  // editor. Skipped where the platform refuses to make one (Windows privileges).
  const link = path.join(tmp, 'linked-Smth__mdt');
  try { fs.symlinkSync(objDir, link, 'dir'); } catch { return; }
  resetUi();
  const item = {
    type: 'CustomObject', name: 'Smth__mdt', filePath: link,
    files: [path.join(link, 'Smth__mdt.object-meta.xml')]
  };
  await handle(provider([item]), { type: 'openFile', key: 'CustomObject:Smth__mdt' });
  assert.deepStrictEqual(ui.opened, [path.join(link, 'Smth__mdt.object-meta.xml')]);
});

check('a path that no longer exists is passed through so the real error surfaces', async () => {
  resetUi();
  const gone = path.join(tmp, 'classes', 'Gone.cls');
  const item = { type: 'ApexClass', name: 'Gone', filePath: gone, files: [gone] };
  await handle(provider([item]), { type: 'openFile', key: 'ApexClass:Gone' });
  assert.deepStrictEqual(ui.opened, [gone]);
});

// -------------------------------------------- the scan really does this shape
check('a scanned CustomObject genuinely carries a DIRECTORY filePath', async () => {
  // Against the real scanner on a real tree — the fix rests on this shape, so it
  // is proven here rather than assumed from the hand-built fixtures above.
  const root = path.join(tmp, 'proj');
  const objs = path.join(root, 'force-app', 'main', 'default', 'objects', 'Smth__mdt');
  fs.mkdirSync(path.join(objs, 'fields'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app' }] }));
  fs.writeFileSync(path.join(objs, 'Smth__mdt.object-meta.xml'), '<CustomObject/>');
  fs.writeFileSync(path.join(objs, 'fields', 'OldField__c.field-meta.xml'), '<CustomField/>');
  ws.folders = [{ uri: { fsPath: root }, name: 'proj', index: 0 }];
  ws.projectFiles = [path.join(root, 'sfdx-project.json')];
  const scan = await scanWorkspace();
  const obj = scan.items.find(i => i.type === 'CustomObject' && i.name === 'Smth__mdt');
  assert.ok(obj, 'the object was not scanned at all');
  assert.ok(fs.statSync(obj.filePath).isDirectory(), 'filePath is expected to be the object FOLDER');
  assert.strictEqual(bundleDefinitionFile(obj), path.join(objs, 'Smth__mdt.object-meta.xml'));
  // The decomposed child is its own item and keeps its own FILE path — the
  // Changed-lens mapping depends on that split and must not be disturbed.
  const fld = scan.items.find(i => i.type === 'CustomField' && i.name === 'Smth__mdt.OldField__c');
  assert.ok(fld && !fs.statSync(fld.filePath).isDirectory(), 'the field lost its file path');
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed) { console.error(`\n${failed} of ${queue.length} check(s) failed`); process.exit(1); }
  console.log(`open-target: all ${queue.length} checks passed`);
})();
