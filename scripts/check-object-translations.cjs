// Runnable contract test for CustomObjectTranslation as a scanned, folder-typed
// component, and for its whole-folder diff.
//   1) npm run compile   2) node scripts/check-object-translations.cjs
//
// In source format an object translation is a FOLDER — the
// `<Object>-<lang>.objectTranslation-meta.xml` parent plus one
// `<Field>.fieldTranslation-meta.xml` per translated field, side by side. The
// registry calls the shape "decomposed", which no registry-derived per-file rule
// can describe, so before 0.31.0 the folder was reported as an unknown folder,
// never listed, and every translation in a project read as "org only": no diff,
// no deploy, no validate from the panel. Pinned here:
//   1. the scan: one item per folder, name = folder name, filePath = the folder,
//      files = everything inside; the folder is static, so never "unknown", and
//      the registry's non-derivable cache no longer claims it;
//   2. path → item both ways (findItemForPath for a scanned project,
//      inferItemForPath for anything outside it), folder and file inside;
//   3. the whole-folder diff: pairing BY PATH INSIDE THE FOLDER (every translation
//      of one object holds the same field file names, so a by-basename lookup
//      pairs Product2-pl with Product2-de), identical files skipped, CRLF-only and
//      final-newline-only differences identical, one-sided files diffed against an
//      empty staged file, the editor cap honoured with the overflow named, and
//      never a directory handed to vscode.diff;
//   4. a right-click on one file inside still diffs just that file.
// The org round trip is stubbed at the service boundary: the fake retrieve writes
// the org's tree into the throwaway project exactly where the real CLI puts it.
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const assert = require('assert');
const Module = require('module');

// ---------------------------------------------------------------- vscode stub
const ws = { folders: [], projectFiles: [] };
const ui = { diffs: [], notices: [], warn: [] };
const editorListeners = [];
const config = {};
const resetUi = () => {
  ui.diffs.length = 0; ui.notices.length = 0; ui.warn.length = 0; editorListeners.length = 0;
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
      if (id === 'vscode.diff') ui.diffs.push({ left: args[0].fsPath, right: args[1].fsPath, title: args[2] });
      return Promise.resolve(undefined);
    }
  },
  workspace: {
    getConfiguration: () => ({ get: (k, fallback) => (k in config ? config[k] : fallback) }),
    get workspaceFolders() { return ws.folders; },
    findFiles: async () => ws.projectFiles.map(f => ({ fsPath: f })),
    asRelativePath: uri => uri.fsPath
  },
  RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
  Uri: { file: (fsPath) => ({ fsPath, scheme: 'file' }) },
  ViewColumn: { Active: -1 },
  ProgressLocation: { Notification: 15 }
};
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? vscodeStub : origLoad(req, ...rest));

const out = (f) => path.join(__dirname, '..', 'out', f);
const {
  scanWorkspace, findItemForPath, inferItemForPath, bundleDefinitionFile, STATIC_RULE_FOLDERS, DIRECTORY_ITEM_TYPES
} = require(out('metadataScanner.js'));
const { DeployPanelProvider, pairFolderFiles, sameAfterEol, ALL_IN_SYNC_LINE, WHOLE_FOLDER_DIFF_TYPES } = require(out('panelProvider.js'));
const { locateRegistry, nonDerivableFolders } = require(out('registryRules.js'));

let failed = 0;
const queue = [];
const check = (name, fn) => queue.push([name, fn]);

// ------------------------------------------------------------------ fixtures
const PKG = path.join('force-app', 'main', 'default');
const xml = (root, body) => `<?xml version="1.0" encoding="UTF-8"?>\n<${root} xmlns="http://soap.sforce.com/2006/04/metadata">\n${body}\n</${root}>\n`;
const parent = (label) => xml('CustomObjectTranslation', `    <webLinks>\n        <label>${label}</label>\n        <name>Acme_Send</name>\n    </webLinks>`);
const field = (name, label) => xml('CustomFieldTranslation', `    <label>${label}</label>\n    <name>${name}</name>`);

let tmp;
let proj;
let dir; // the local Product2-pl folder
const rel = (...s) => path.join(PKG, 'objectTranslations', ...s);
async function write(root, relPath, body) {
  const abs = path.join(root, relPath);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, body, 'utf8');
  return abs;
}

// The LOCAL folder, and what the org has for each file. Every case below that
// writes the org tree starts from this table and edits a copy.
const LOCAL = {
  'Product2-pl.objectTranslation-meta.xml': parent('Wyślij'),
  'Acme_Status__c.fieldTranslation-meta.xml': field('Acme_Status__c', 'Status lokalny'),
  'Acme_Crlf__c.fieldTranslation-meta.xml': field('Acme_Crlf__c', 'Koszt'),
  'Acme_Eol__c.fieldTranslation-meta.xml': field('Acme_Eol__c', 'Marża'),
  'Acme_Space__c.fieldTranslation-meta.xml': field('Acme_Space__c', 'Typ'),
  'Acme_LocalOnly__c.fieldTranslation-meta.xml': field('Acme_LocalOnly__c', 'Nowe')
};
const ORG = {
  'Product2-pl.objectTranslation-meta.xml': LOCAL['Product2-pl.objectTranslation-meta.xml'], // identical
  'Acme_Status__c.fieldTranslation-meta.xml': field('Acme_Status__c', 'Status z organizacji'), // differs
  'Acme_Crlf__c.fieldTranslation-meta.xml': LOCAL['Acme_Crlf__c.fieldTranslation-meta.xml'].replace(/\n/g, '\r\n'), // CRLF only
  'Acme_Eol__c.fieldTranslation-meta.xml': LOCAL['Acme_Eol__c.fieldTranslation-meta.xml'].replace(/\n$/, ''), // final newline only
  'Acme_Space__c.fieldTranslation-meta.xml': LOCAL['Acme_Space__c.fieldTranslation-meta.xml'].replace('<label>Typ', '<label> Typ'), // whitespace inside a line counts
  'Acme_OrgOnly__c.fieldTranslation-meta.xml': field('Acme_OrgOnly__c', 'Tylko w organizacji')
};
// A second translation of the SAME object in the same retrieve tree, carrying the
// same field file names with different content — the cross-match decoy.
const DECOY = Object.fromEntries(Object.keys(ORG).filter(f => f.startsWith('Acme_')).map(f => [f, field(f.split('.')[0], 'DECOY de')]));
DECOY['Product2-de.objectTranslation-meta.xml'] = parent('Senden');

async function setup() {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sf-object-translations-'));
  proj = path.join(tmp, 'proj');
  await write(proj, 'sfdx-project.json', JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }] }));
  for (const [f, body] of Object.entries(LOCAL)) await write(proj, rel('Product2-pl', f), body);
  // Not metadata: never an "only local" file in the diff.
  await write(proj, rel('Product2-pl', '.DS_Store'), 'finder junk');
  // A second local translation, so the scan has to tell folders apart.
  await write(proj, rel('Widget__c-de', 'Widget__c-de.objectTranslation-meta.xml'), parent('Widget'));
  await write(proj, rel('Widget__c-de', 'Size__c.fieldTranslation-meta.xml'), field('Size__c', 'Größe'));
  // A plain class beside it — the folder must not change anything else.
  await write(proj, path.join(PKG, 'classes', 'AcmeService.cls'), 'public class AcmeService {}');
  dir = path.join(proj, rel('Product2-pl'));
  ws.folders = [{ uri: { fsPath: proj }, name: 'proj', index: 0 }];
  ws.projectFiles = [path.join(proj, 'sfdx-project.json')];
}

// ------------------------------------------------------------------ 1. the scan
let scanned;
check('scan: one CustomObjectTranslation per folder — name, filePath = the folder, files = everything inside', async () => {
  const scan = await scanWorkspace();
  scanned = scan.items;
  const keys = scan.items.map(i => `${i.type}:${i.name}`);
  assert.deepStrictEqual(keys, ['ApexClass:AcmeService', 'CustomObjectTranslation:Product2-pl', 'CustomObjectTranslation:Widget__c-de']);
  const it = scan.items.find(i => i.name === 'Product2-pl');
  assert.strictEqual(it.filePath, dir, 'filePath must be the FOLDER');
  assert.ok(fs.statSync(it.filePath).isDirectory());
  assert.deepStrictEqual([...it.files].sort(), [...Object.keys(LOCAL), '.DS_Store'].map(f => path.join(dir, f)).sort(),
    'files = every file inside the folder');
  assert.ok(DIRECTORY_ITEM_TYPES.has('CustomObjectTranslation'), 'folder-typed, like an object or a bundle');
  assert.ok(WHOLE_FOLDER_DIFF_TYPES.has('CustomObjectTranslation'));
});

check('scan: objectTranslations is a static folder — never an unknown folder', async () => {
  assert.ok(STATIC_RULE_FOLDERS.has('objectTranslations'));
  const scan = await scanWorkspace();
  // Before 0.31.0 this listed `<pkg>/objectTranslations`: the folder went to the
  // registry/CLI resolution path, which can only ever answer "not derivable".
  assert.deepStrictEqual(scan.unknownFolders, []);
});

check('scan: the folder matches whatever its case on disk, path spelled as on disk', async () => {
  const other = path.join(tmp, 'casing');
  await write(other, 'sfdx-project.json', JSON.stringify({ packageDirectories: [{ path: 'force-app' }] }));
  await write(other, path.join(PKG, 'ObjectTranslations', 'Account-fr', 'Account-fr.objectTranslation-meta.xml'), parent('Envoyer'));
  const saved = [ws.folders, ws.projectFiles];
  ws.folders = [{ uri: { fsPath: other }, name: 'casing', index: 0 }];
  ws.projectFiles = [path.join(other, 'sfdx-project.json')];
  try {
    const scan = await scanWorkspace();
    assert.deepStrictEqual(scan.items.map(i => `${i.type}:${i.name}`), ['CustomObjectTranslation:Account-fr']);
    assert.strictEqual(scan.items[0].filePath, path.join(other, PKG, 'ObjectTranslations', 'Account-fr'));
    assert.deepStrictEqual(scan.unknownFolders, []);
  } finally { [ws.folders, ws.projectFiles] = saved; }
});

check('registry: the non-derivable negative cache no longer claims objectTranslations', async () => {
  const registryPath = process.env.SF_METADATA_REGISTRY || await locateRegistry();
  assert.ok(registryPath && fs.existsSync(registryPath), 'no sf CLI registry found — install the sf CLI or set SF_METADATA_REGISTRY');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  // Proof the registry WOULD report it — the decomposed adapter is non-derivable —
  // so the next assertion is the static rule's doing, not the registry's.
  const withoutRule = new Set([...STATIC_RULE_FOLDERS].filter(f => f !== 'objectTranslations'));
  assert.strictEqual(nonDerivableFolders(registry, withoutRule).get('objecttranslations'), 'CustomObjectTranslation');
  assert.ok(!nonDerivableFolders(registry, STATIC_RULE_FOLDERS).has('objecttranslations'));
});

check('bundleDefinitionFile: a click on the row opens the parent .objectTranslation-meta.xml', () => {
  const it = scanned.find(i => i.name === 'Product2-pl');
  assert.strictEqual(bundleDefinitionFile(it), path.join(dir, 'Product2-pl.objectTranslation-meta.xml'));
});

// ---------------------------------------------------------- 2. path → item
check('findItemForPath: a field translation file belongs to its folder item', () => {
  const hit = findItemForPath(scanned, path.join(dir, 'Acme_Status__c.fieldTranslation-meta.xml'));
  assert.strictEqual(hit && `${hit.type}:${hit.name}`, 'CustomObjectTranslation:Product2-pl');
  // …and a file added after the scan (not in `files`) still lands on it — containment.
  const added = findItemForPath(scanned, path.join(dir, 'Acme_New__c.fieldTranslation-meta.xml'));
  assert.strictEqual(added && added.name, 'Product2-pl');
  assert.strictEqual(findItemForPath(scanned, dir).name, 'Product2-pl', 'the folder itself');
  assert.strictEqual(findItemForPath(scanned, path.join(proj, rel('Widget__c-de', 'Size__c.fieldTranslation-meta.xml'))).name, 'Widget__c-de');
});

check('inferItemForPath: the folder and any file inside resolve to the folder component', () => {
  const outside = path.join(tmp, 'elsewhere', 'objectTranslations', 'Case-pl');
  for (const p of [outside, path.join(outside, 'Case-pl.objectTranslation-meta.xml'), path.join(outside, 'Acme_Reason__c.fieldTranslation-meta.xml')]) {
    const it = inferItemForPath(p);
    assert.ok(it, `not recognised: ${p}`);
    assert.deepStrictEqual([it.type, it.name, it.filePath], ['CustomObjectTranslation', 'Case-pl', outside], p);
  }
  // Not the object rule: `objectTranslations` is not `objects`.
  assert.notStrictEqual(inferItemForPath(path.join(outside, 'Case-pl.objectTranslation-meta.xml')).type, 'CustomObject');
});

// ---------------------------------------------------------- 3. pairing units
check('sameAfterEol: CRLF and one missing final newline are ignored, nothing else', () => {
  const b = (s) => Buffer.from(s, 'utf8');
  assert.ok(sameAfterEol(b('a\nb\n'), b('a\r\nb\r\n')), 'CRLF vs LF');
  assert.ok(sameAfterEol(b('a\nb\n'), b('a\nb')), 'missing final newline');
  assert.ok(!sameAfterEol(b('a\nb\n'), b('a \nb\n')), 'whitespace inside a line is a difference');
  assert.ok(!sameAfterEol(b('a\nb\n\n'), b('a\nb')), 'only ONE final newline is forgiven');
  assert.ok(!sameAfterEol(b('a\nb'), b('a\nc')));
  // Byte-exact for binary content: two different invalid UTF-8 bytes must differ.
  assert.ok(!sameAfterEol(Buffer.from([0xff]), Buffer.from([0xfe])), 'a lossy decode would call these equal');
});

check('pairFolderFiles: by path inside the folder, both one-sided kinds kept, definition first', () => {
  const L = path.join('l', 'objectTranslations', 'Product2-pl');
  const O = path.join('o', 'force-app', 'main', 'default', 'objectTranslations', 'Product2-pl');
  const pairs = pairFolderFiles(L, [path.join(L, 'B__c.fieldTranslation-meta.xml'), path.join(L, 'Product2-pl.objectTranslation-meta.xml'), path.join(L, 'Local__c.fieldTranslation-meta.xml')],
    O, [path.join(O, 'b__c.fieldTranslation-meta.xml'), path.join(O, 'Product2-pl.objectTranslation-meta.xml'), path.join(O, 'Org__c.fieldTranslation-meta.xml')], 'Product2-pl');
  assert.deepStrictEqual(pairs.map(p => [p.rel, !!p.local, !!p.org]), [
    ['Product2-pl.objectTranslation-meta.xml', true, true],
    ['B__c.fieldTranslation-meta.xml', true, true], // case-insensitive: the CLI's spelling vs the disk's
    ['Local__c.fieldTranslation-meta.xml', true, false],
    ['Org__c.fieldTranslation-meta.xml', false, true]
  ]);
  assert.strictEqual(pairs[1].org, path.join(O, 'b__c.fieldTranslation-meta.xml'));
});

// ---------------------------------------------------------- 4. the folder diff
/** Provider stub whose retrieve writes `orgFolders` ({ folderName: { file: body } })
 *  under objectTranslations/ in the throwaway project, like the real CLI. */
function diffStub(items, orgFolders) {
  const posted = [];
  const log = [];
  const retrieved = [];
  const stub = Object.create(DeployPanelProvider.prototype);
  stub.view = undefined; // panel closed: the toast path is under test too
  stub.items = items;
  stub.orgs = [{ username: 'acme-dev-user', alias: 'acme-dev' }];
  stub.cmdSeq = 0;
  stub.post = (m) => posted.push(m);
  stub.reserveBusy = () => true;
  stub.requireRoot = () => proj;
  stub.requireOrg = () => 'acme-dev-user';
  stub.resolveKeys = () => items;
  stub.setBusy = () => {};
  stub.output = { appendLine: (l) => log.push(l) };
  stub.withWindowProgress = (_t, body) => body(() => {});
  stub.sf = {
    queryTooling: () => ({ cancel: () => {}, promise: Promise.resolve({ records: [] }) }),
    retrieveMetadata: (keys, _org, tmpProj) => ({
      cancel: () => {},
      promise: (async () => {
        retrieved.push(keys);
        for (const [folder, files] of Object.entries(orgFolders)) {
          for (const [f, body] of Object.entries(files)) await write(tmpProj, rel(folder, f), body);
        }
        return { result: { messages: [] }, cmd: 'sf project retrieve start' };
      })()
    })
  };
  return { stub, posted, log, retrieved };
}
const cards = (posted) => posted.filter(m => m.type === 'status').map(m => m.card);
const drain = () => { for (const fn of editorListeners.splice(0)) fn([]); };
const runDiff = (stub, keys, focusFile) => DeployPanelProvider.prototype.runDiff.call(stub, keys, undefined, focusFile);
const item = () => scanned.find(i => i.name === 'Product2-pl');
const read = (f) => fsp.readFile(f, 'utf8');
const assertNoDirectoryReachedDiff = () => {
  for (const d of ui.diffs) {
    assert.ok(!fs.statSync(d.left).isDirectory() && !fs.statSync(d.right).isDirectory(), `a directory reached vscode.diff: ${JSON.stringify(d)}`);
  }
};

check('folder diff: only the differing files open — paired with THIS translation, never the decoy', async () => {
  resetUi();
  const { stub, posted, log, retrieved } = diffStub([item()], { 'Product2-pl': ORG, 'Product2-de': DECOY });
  await runDiff(stub, ['CustomObjectTranslation:Product2-pl']);
  assert.deepStrictEqual(retrieved, [['CustomObjectTranslation:Product2-pl']], 'one retrieve of the component itself');
  const byFile = Object.fromEntries(ui.diffs.map(d => [d.title.split(' — ')[0], d]));
  assert.deepStrictEqual(Object.keys(byFile).sort(), [
    'CustomObjectTranslation:Product2-pl/Acme_LocalOnly__c.fieldTranslation-meta.xml (only local)',
    'CustomObjectTranslation:Product2-pl/Acme_OrgOnly__c.fieldTranslation-meta.xml (only on org)',
    'CustomObjectTranslation:Product2-pl/Acme_Space__c.fieldTranslation-meta.xml',
    'CustomObjectTranslation:Product2-pl/Acme_Status__c.fieldTranslation-meta.xml'
  ], `wrong editors — card: ${JSON.stringify(cards(posted))} log: ${log.join(' | ')}`);
  assertNoDirectoryReachedDiff();
  // Differing pair: org LEFT (staged copy of the -pl file, not the -de decoy), local RIGHT.
  const status = byFile['CustomObjectTranslation:Product2-pl/Acme_Status__c.fieldTranslation-meta.xml'];
  assert.strictEqual(await read(status.left), ORG['Acme_Status__c.fieldTranslation-meta.xml'], 'paired with the wrong org file');
  assert.strictEqual(status.right, path.join(dir, 'Acme_Status__c.fieldTranslation-meta.xml'));
  // One-sided: an empty staged twin on the missing side.
  const localOnly = byFile['CustomObjectTranslation:Product2-pl/Acme_LocalOnly__c.fieldTranslation-meta.xml (only local)'];
  assert.strictEqual(await read(localOnly.left), '', 'the org side of a local-only file is empty');
  assert.strictEqual(localOnly.right, path.join(dir, 'Acme_LocalOnly__c.fieldTranslation-meta.xml'));
  const orgOnly = byFile['CustomObjectTranslation:Product2-pl/Acme_OrgOnly__c.fieldTranslation-meta.xml (only on org)'];
  assert.strictEqual(await read(orgOnly.left), ORG['Acme_OrgOnly__c.fieldTranslation-meta.xml']);
  assert.strictEqual(await read(orgOnly.right), '', 'the local side of an org-only file is an empty staged file');
  assert.ok(!orgOnly.right.startsWith(dir), 'never a file invented inside the project');
  assert.ok(!fs.existsSync(path.join(dir, 'Acme_OrgOnly__c.fieldTranslation-meta.xml')), 'the project was not written to');

  const card = cards(posted)[0];
  assert.strictEqual(card.kind, 'ok');
  assert.strictEqual(card.title, 'Diff opened for 4 differing files against acme-dev');
  assert.strictEqual(card.meta, '4 differ · 3 in sync · 0 not on org');
  assert.ok(card.lines.includes('CustomObjectTranslation:Product2-pl — 3 identical · 2 differ · 1 only on org · 1 only local'), card.lines.join('\n'));
  assert.ok(card.lines.includes('in sync: CustomObjectTranslation:Product2-pl/Product2-pl.objectTranslation-meta.xml, CustomObjectTranslation:Product2-pl/Acme_Crlf__c.fieldTranslation-meta.xml, CustomObjectTranslation:Product2-pl/Acme_Eol__c.fieldTranslation-meta.xml'), card.lines.join('\n'));
  assert.ok(!card.lines.some(l => l.includes('.DS_Store')), 'a dotfile is not a translation');
  drain();
});

check('folder diff: the editor cap is honoured and every file past it is named', async () => {
  resetUi();
  config.diffEditorCap = 3;
  const { stub, posted } = diffStub([item()], { 'Product2-pl': ORG });
  await runDiff(stub, ['CustomObjectTranslation:Product2-pl']);
  assert.strictEqual(ui.diffs.length, 3, 'opened past the cap');
  const card = cards(posted)[0];
  const notOpened = card.lines.filter(l => l.startsWith('— differs (not opened): '));
  assert.strictEqual(notOpened.length, 1, card.lines.join('\n'));
  assert.ok(card.lines.includes('1 more differs — not opened (sfOrgDeployWrapper.diffEditorCap is 3); diff it on its own:'), card.lines.join('\n'));
  // Opened + named = every differing file, none twice.
  const named = [...card.lines.filter(l => l.startsWith('✓ opened diff: ')).map(l => l.slice(15)), ...notOpened.map(l => l.slice(24))];
  assert.strictEqual(new Set(named).size, 4);
  assert.strictEqual(card.meta, '4 differ · 3 in sync · 0 not on org', 'the cap bounds editors, never the comparison');
  assert.ok(card.lines.includes('CustomObjectTranslation:Product2-pl — 3 identical · 2 differ · 1 only on org · 1 only local'));
  drain();
});

check('folder diff: the default cap is 10', async () => {
  resetUi();
  const many = { ...ORG };
  for (let i = 0; i < 12; i++) many[`Acme_Extra${i}__c.fieldTranslation-meta.xml`] = field(`Acme_Extra${i}__c`, 'org');
  const { stub, posted } = diffStub([item()], { 'Product2-pl': many });
  await runDiff(stub, ['CustomObjectTranslation:Product2-pl']);
  assert.strictEqual(ui.diffs.length, 10);
  const card = cards(posted)[0];
  assert.strictEqual(card.lines.filter(l => l.startsWith('— differs (not opened): ')).length, 16 - 10);
  assert.strictEqual(card.meta, '16 differ · 3 in sync · 0 not on org');
  drain();
});

check('folder diff: an org without the folder reports the component as not on org', async () => {
  resetUi();
  const { stub, posted } = diffStub([item()], { 'Product2-de': DECOY });
  await runDiff(stub, ['CustomObjectTranslation:Product2-pl']);
  assert.strictEqual(ui.diffs.length, 0);
  const card = cards(posted)[0];
  assert.strictEqual(card.title, 'Nothing to diff — not on acme-dev');
  assert.deepStrictEqual(card.lines, ['— CustomObjectTranslation:Product2-pl — not on org']);
  drain();
});

check('folder diff: everything identical → All N in sync, nothing opened, and the toast says so', async () => {
  resetUi();
  const same = Object.fromEntries(Object.entries(LOCAL).map(([f, body]) => [f, body.replace(/\n/g, '\r\n')]));
  const { stub, posted } = diffStub([item()], { 'Product2-pl': same, 'Product2-de': DECOY });
  await runDiff(stub, ['CustomObjectTranslation:Product2-pl']);
  assert.strictEqual(ui.diffs.length, 0, 'an identical file must not open an editor');
  const card = cards(posted)[0];
  assert.deepStrictEqual([card.kind, card.title, card.meta], ['ok', 'All 6 in sync with acme-dev', '0 differ · 6 in sync · 0 not on org']);
  assert.strictEqual(card.lines[0], ALL_IN_SYNC_LINE);
  assert.ok(card.lines.includes('CustomObjectTranslation:Product2-pl — 6 identical · 0 differ · 0 only on org · 0 only local'));
  assert.deepStrictEqual(ui.notices, [`SF Deploy: All 6 in sync with acme-dev — ${ALL_IN_SYNC_LINE}`]);
  drain();
});

check('focus: a right-click on one field translation diffs just that file', async () => {
  resetUi();
  const { stub, posted, log } = diffStub([item()], { 'Product2-pl': ORG, 'Product2-de': DECOY });
  const clicked = path.join(dir, 'Acme_Status__c.fieldTranslation-meta.xml');
  await runDiff(stub, ['CustomObjectTranslation:Product2-pl'], clicked);
  assert.strictEqual(ui.diffs.length, 1, `card: ${JSON.stringify(cards(posted))} log: ${log.join(' | ')}`);
  assert.strictEqual(ui.diffs[0].right, clicked);
  assert.strictEqual(await read(ui.diffs[0].left), ORG['Acme_Status__c.fieldTranslation-meta.xml'], 'cross-matched the decoy');
  assert.ok(ui.diffs[0].title.startsWith('CustomObjectTranslation:Product2-pl/Acme_Status__c.fieldTranslation-meta.xml — '), ui.diffs[0].title);
  assert.deepStrictEqual(cards(posted)[0].lines, ['✓ opened diff: CustomObjectTranslation:Product2-pl/Acme_Status__c.fieldTranslation-meta.xml']);
  drain();
});

check('focus: a right-click on an identical file opens nothing and says in sync', async () => {
  resetUi();
  const { stub, posted } = diffStub([item()], { 'Product2-pl': ORG });
  await runDiff(stub, ['CustomObjectTranslation:Product2-pl'], path.join(dir, 'Acme_Crlf__c.fieldTranslation-meta.xml'));
  assert.strictEqual(ui.diffs.length, 0);
  const card = cards(posted)[0];
  assert.deepStrictEqual([card.title, card.lines], ['All 1 in sync with acme-dev', [ALL_IN_SYNC_LINE, 'in sync: CustomObjectTranslation:Product2-pl/Acme_Crlf__c.fieldTranslation-meta.xml']]);
  drain();
});

check('focus: a right-click on the FOLDER diffs the whole folder', async () => {
  resetUi();
  const { stub, posted } = diffStub([item()], { 'Product2-pl': ORG });
  await runDiff(stub, ['CustomObjectTranslation:Product2-pl'], dir);
  assert.strictEqual(ui.diffs.length, 4);
  assertNoDirectoryReachedDiff();
  assert.strictEqual(cards(posted)[0].meta, '4 differ · 3 in sync · 0 not on org');
  drain();
});

(async () => {
  await setup();
  for (const [name, fn] of queue) {
    try { await fn(); } catch (err) { failed++; console.error(`FAIL: ${name}\n  ${err && err.message}`); }
  }
  drain();
  await fsp.rm(tmp, { recursive: true, force: true });
  if (failed) { console.error(`object-translations: ${failed} of ${queue.length} checks failed`); process.exit(1); }
  console.log(`object-translations: all ${queue.length} checks passed`);
})();
