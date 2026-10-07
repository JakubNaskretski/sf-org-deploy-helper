// Runnable contract test: Retrieve and Diff of a Profile / Translations /
// CustomObjectTranslation send their companions (src/companions.ts) and never
// write them to the project. Driven through the REAL runRetrieve / runDiff
// (DeployPanelProvider.prototype on an Object.create double) against a real
// project on disk, with `sf` faked at the service boundary: the fake WRITES the
// org's answer into the cwd it is given, exactly where the real CLI puts it, and
// — like the org — fills a profile or translation in only for the components
// named in the same request.
// No framework.   1) npm run compile   2) node scripts/check-context-retrieve.cjs
//
// Pinned here:
//   Retrieve — a selection mixing a context item and a plain one is TWO calls:
//     the plain one into the project as before, the context one with its
//     companions into a throwaway project; only the selected file (or folder,
//     merged) is copied back, to its existing path or else the default package
//     dir; companions never land in the project; the backup covers the context
//     file; the run carries project paths, the companion note and what was
//     copied; a Cancel between the calls stops the second; a failed temp
//     retrieve leaves the local file as it was; the off switch.
//   Diff — the temp retrieve carries the companions (a package.xml with `*` for
//     scope org); a profile opens one editor, companions none, and a companion
//     missing on the org is neither "not on org" nor an error.
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const assert = require('assert');
const Module = require('module');

// ---------------------------------------------------------------- vscode stub
const ui = { warns: [], diffs: [], notices: [] };
const config = {};
const editorListeners = [];
const vscodeStub = {
  window: {
    showWarningMessage: (message, options, ...items) => {
      ui.warns.push({ message, detail: options && options.detail, modal: !!(options && options.modal) });
      return Promise.resolve(options && options.modal ? items[0] : undefined);
    },
    showInformationMessage: (m) => { ui.notices.push(m); return Promise.resolve(undefined); },
    showErrorMessage: () => Promise.resolve(undefined),
    setStatusBarMessage: () => ({ dispose() {} }),
    withProgress: (_o, body) => body({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) }),
    onDidChangeVisibleTextEditors: (fn) => { editorListeners.push(fn); return { dispose() {} }; }
  },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (k in config ? config[k] : d), update: async () => {} }),
    workspaceFolders: []
  },
  commands: {
    executeCommand: async (id, ...args) => {
      if (id === 'vscode.diff') ui.diffs.push({ left: args[0].fsPath, right: args[1].fsPath, title: args[2] });
    }
  },
  Uri: { file: fsPath => ({ fsPath, scheme: 'file' }) },
  ViewColumn: { Active: -1 },
  ProgressLocation: { Notification: 15, Window: 10 },
  ConfigurationTarget: { Global: 1 },
  env: { clipboard: { writeText: async () => {} } },
  extensions: { getExtension: () => undefined }
};
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? vscodeStub : origLoad(req, ...rest));

const ROOT = path.join(__dirname, '..');
const RR = require(path.join(ROOT, 'out', 'runRecords.js'));
// The provider calls retrieveRunFromResult through the module object, so this
// sees exactly the merged result the run is built from.
const finished = [];
const realFromResult = RR.retrieveRunFromResult;
RR.retrieveRunFromResult = (result, input) => { finished.push(JSON.parse(JSON.stringify({ result, input }))); return realFromResult(result, input); };
const { DeployPanelProvider, folderState } = require(path.join(ROOT, 'out', 'panelProvider.js'));
const { SfCliError, SfCliCancelledError } = require(path.join(ROOT, 'out', 'sfCliService.js'));
const proto = DeployPanelProvider.prototype;

let failed = 0;
const queue = [];
const check = (name, fn) => queue.push([name, fn]);

const ORG = 'acme-dev-user';
const reset = () => {
  ui.warns.length = 0; ui.diffs.length = 0; ui.notices.length = 0; finished.length = 0;
  for (const k of Object.keys(config)) delete config[k];
  for (const fn of editorListeners.splice(0)) fn([]);
};

// ------------------------------------------------------------------ the org
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';
const ORG_CLASS = { AcmeService: 'public class AcmeService { /* org */ }', Foo: 'public class Foo {}' };
/** What the org answers for one retrieve, given everything named in it.
 *  `requested` holds Type:Name keys (a `*` member matches the whole type).
 *  `apiVersion` undefined = the org's max: a profile then carries an element
 *  the project's 62.0 can't have, exactly as the real org does. */
function orgAnswer(requested, apiVersion) {
  const has = (type, name) => requested.some(k => k === `${type}:${name}` || k === `${type}:*`);
  const hasType = (type) => requested.some(k => k.startsWith(`${type}:`));
  const out = []; // { type, fullName, rel, body } — rel under <pkg>/main/default
  const missing = [];
  for (const k of requested) {
    const [type, name] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
    if (type === 'ApexClass') {
      for (const n of name === '*' ? Object.keys(ORG_CLASS) : [name]) {
        if (!ORG_CLASS[n]) { missing.push([type, n]); continue; }
        out.push({ type, fullName: n, rel: `classes/${n}.cls`, body: ORG_CLASS[n] });
        out.push({ type, fullName: n, rel: `classes/${n}.cls-meta.xml`, body: '<ApexClass/>' });
      }
    } else if (type === 'Translations') {
      if (!['pl', 'fr'].includes(name)) { missing.push([type, name]); continue; }
      const parts = [];
      if (has('CustomLabels', 'CustomLabels')) parts.push('    <customLabels>\n        <label>Witaj</label>\n        <name>Acme_Greeting</name>\n    </customLabels>');
      if (has('CustomTab', 'Acme_Widget__c')) parts.push('    <customTabs>\n        <label>Widżet</label>\n        <name>Acme_Widget__c</name>\n    </customTabs>');
      out.push({ type, fullName: name, rel: `translations/${name}.translation-meta.xml`, body: `<?xml version="1.0" encoding="UTF-8"?>\n<Translations ${NS}>\n${parts.join('\n')}${parts.length ? '\n' : ''}</Translations>\n` });
    } else if (type === 'CustomLabels') {
      out.push({ type, fullName: 'CustomLabels', rel: 'labels/CustomLabels.labels-meta.xml', body: 'ORG LABELS' });
    } else if (type === 'CustomTab') {
      if (name !== 'Acme_Widget__c' && name !== '*') { missing.push([type, name]); continue; }
      out.push({ type, fullName: 'Acme_Widget__c', rel: 'tabs/Acme_Widget__c.tab-meta.xml', body: 'ORG TAB' });
    } else if (type === 'Profile') {
      if (name !== 'Admin') { missing.push([type, name]); continue; }
      const parts = ['    <userPermissions>\n        <enabled>true</enabled>\n        <name>ApiEnabled</name>\n    </userPermissions>'];
      for (const c of Object.keys(ORG_CLASS)) if (has('ApexClass', c)) parts.push(`    <classAccesses>\n        <apexClass>${c}</apexClass>\n        <enabled>true</enabled>\n    </classAccesses>`);
      if (has('CustomField', 'Product2.Status__c') || has('CustomObject', 'Product2')) parts.push('    <fieldPermissions>\n        <field>Product2.Status__c</field>\n        <readable>true</readable>\n    </fieldPermissions>');
      if (apiVersion === undefined) parts.push('    <objectPermissions>\n        <object>Product2</object>\n        <viewAllFields>false</viewAllFields>\n    </objectPermissions>');
      out.push({ type, fullName: 'Admin', rel: 'profiles/Admin.profile-meta.xml', body: `<?xml version="1.0" encoding="UTF-8"?>\n<Profile ${NS}>\n${parts.join('\n')}\n</Profile>\n` });
    } else if (type === 'CustomObjectTranslation') {
      if (name !== 'Product2-pl') { missing.push([type, name]); continue; }
      // The real CLI reports EVERY file of the folder as a row of the component.
      out.push({ type, fullName: name, rel: `objectTranslations/${name}/${name}.objectTranslation-meta.xml`, body: 'ORG PARENT' });
      if (has('CustomObject', 'Product2')) {
        for (const f of ['Status__c', 'Family']) out.push({ type, fullName: name, rel: `objectTranslations/${name}/${f}.fieldTranslation-meta.xml`, body: `ORG ${f}` });
      }
    } else if (type === 'CustomObject') {
      if (name !== 'Product2' && name !== '*') { missing.push([type, name]); continue; }
      if (name === 'Product2') {
        out.push({ type, fullName: 'Product2', rel: 'objects/Product2/Product2.object-meta.xml', body: 'ORG OBJECT' });
        out.push({ type: 'CustomField', fullName: 'Product2.Status__c', rel: 'objects/Product2/fields/Status__c.field-meta.xml', body: 'ORG FIELD' });
      }
    } else if (type === 'CustomField') {
      if (name !== 'Product2.Status__c' && name !== '*') { missing.push([type, name]); continue; }
      out.push({ type, fullName: 'Product2.Status__c', rel: 'objects/Product2/fields/Status__c.field-meta.xml', body: 'ORG FIELD' });
    } else if (name !== '*') {
      missing.push([type, name]);
    }
  }
  void hasType;
  return { out, missing };
}

/** Members of a package.xml, as Type:Name keys. */
function manifestKeys(xml) {
  const keys = [];
  for (const block of xml.split('<types>').slice(1)) {
    const type = /<name>([^<]+)<\/name>/.exec(block)[1];
    for (const m of block.matchAll(/<members>([^<]+)<\/members>/g)) keys.push(`${type}:${m[1]}`);
  }
  return keys;
}

async function defaultPkg(cwd) {
  const j = JSON.parse(await fsp.readFile(path.join(cwd, 'sfdx-project.json'), 'utf8'));
  return (j.packageDirectories.find(d => d.default) ?? j.packageDirectories[0]).path;
}

/** The fake `sf`: every call recorded; `hooks.before(call, n)` runs while the
 *  call is in flight, `hooks.fail(call, n)` returns an error to reject with. */
function fakeSf(calls, hooks = {}) {
  return {
    retrieveMetadata(metadata, _org, cwd, opts = {}) {
      const call = { metadata: [...metadata], cwd, opts, manifestXml: opts.manifest ? fs.readFileSync(opts.manifest, 'utf8') : undefined, cancelled: false,
        project: JSON.parse(fs.readFileSync(path.join(cwd, 'sfdx-project.json'), 'utf8')) };
      call.requested = call.manifestXml ? manifestKeys(call.manifestXml) : call.metadata;
      // A package.xml <version> wins over the project's sourceApiVersion.
      call.apiVersion = (call.manifestXml && /<version>([^<]+)<\/version>/.exec(call.manifestXml) || [])[1] ?? call.project.sourceApiVersion;
      calls.push(call);
      const n = calls.length;
      const promise = (async () => {
        await new Promise(r => setImmediate(r));
        if (hooks.before) await hooks.before(call, n);
        if (call.cancelled && hooks.honourCancel) throw new SfCliCancelledError();
        const err = hooks.fail && hooks.fail(call, n);
        if (err) throw err;
        const { out, missing } = orgAnswer(call.requested, call.apiVersion);
        const pkg = await defaultPkg(cwd);
        const files = [];
        for (const f of out) {
          // An existing file is overwritten where it is (any package dir); a new one lands in the default.
          const existing = await findExisting(cwd, f.rel);
          const abs = existing ?? path.join(cwd, pkg, 'main', 'default', f.rel);
          await fsp.mkdir(path.dirname(abs), { recursive: true });
          await fsp.writeFile(abs, f.body, 'utf8');
          files.push({ type: f.type, fullName: f.fullName, state: existing ? 'Changed' : 'Created', filePath: abs });
        }
        const messages = missing.map(([t, nm]) => ({ fileName: 'unpackaged/package.xml', problem: `Entity of type '${t}' named '${nm}' cannot be found` }));
        for (const [t, nm] of missing) files.push({ type: t, fullName: nm, state: 'Failed', filePath: null });
        return { result: { status: 0, success: true, inboundFiles: files, messages }, cmd: `sf project retrieve start ${opts.manifest ? `--manifest ${opts.manifest}` : metadata.map(m => `--metadata ${m}`).join(' ')} --target-org ${ORG} --json` };
      })();
      return { promise, cancel: () => { call.cancelled = true; } };
    },
    queryTooling: () => ({ cancel() {}, promise: Promise.resolve({ records: [] }) }),
    runCancellable: () => ({ promise: Promise.resolve({ stdout: 'sf 0.0.0-test', stderr: '', code: 0 }), cancel() {} })
  };
}
async function findExisting(cwd, rel) {
  let j;
  try { j = JSON.parse(await fsp.readFile(path.join(cwd, 'sfdx-project.json'), 'utf8')); } catch { return undefined; }
  for (const d of j.packageDirectories) {
    const abs = path.join(cwd, d.path, 'main', 'default', rel);
    if (fs.existsSync(abs)) return abs;
  }
  return undefined;
}

// --------------------------------------------------------------- the project
let tmp;
const LOCAL_PL = `<?xml version="1.0" encoding="UTF-8"?>\n<Translations ${NS}>\n    <customLabels>\n        <label>Lokalnie</label>\n        <name>Acme_Greeting</name>\n    </customLabels>\n</Translations>\n`;
/** A project: `core` (holds the existing files) and `app` (the DEFAULT package dir). */
async function makeProject(name, opts = {}) {
  const proj = path.join(tmp, name);
  const w = async (rel, body) => { const abs = path.join(proj, rel); await fsp.mkdir(path.dirname(abs), { recursive: true }); await fsp.writeFile(abs, body, 'utf8'); return abs; };
  await w('sfdx-project.json', JSON.stringify({ packageDirectories: [{ path: 'core' }, { path: 'app', default: true }], sourceApiVersion: '62.0' }));
  const items = [];
  const add = (type, nm, filePath, files = []) => items.push({ type, name: nm, filePath, files });
  const D = path.join('core', 'main', 'default');
  if (opts.pl !== false) add('Translations', 'pl', await w(path.join(D, 'translations', 'pl.translation-meta.xml'), LOCAL_PL));
  if (opts.labels !== false) add('CustomLabels', 'CustomLabels', await w(path.join(D, 'labels', 'CustomLabels.labels-meta.xml'), 'LOCAL LABELS'));
  if (opts.tab !== false) add('CustomTab', 'Acme_Widget__c', await w(path.join(D, 'tabs', 'Acme_Widget__c.tab-meta.xml'), 'LOCAL TAB'));
  if (opts.profile) {
    add('Profile', 'Admin', await w(path.join(D, 'profiles', 'Admin.profile-meta.xml'), opts.profile));
    const cls = await w(path.join(D, 'classes', 'AcmeService.cls'), 'public class AcmeService { /* local */ }');
    add('ApexClass', 'AcmeService', cls, [cls, await w(path.join(D, 'classes', 'AcmeService.cls-meta.xml'), '<ApexClass/>')]);
    add('CustomField', 'Product2.Status__c', await w(path.join(D, 'objects', 'Product2', 'fields', 'Status__c.field-meta.xml'), 'LOCAL FIELD'));
    if (opts.missingTab !== false) add('CustomTab', 'Acme_Missing__c', await w(path.join(D, 'tabs', 'Acme_Missing__c.tab-meta.xml'), 'NEVER DEPLOYED'));
  }
  if (opts.cot) {
    // true: an older local copy; 'same': exactly the org's; 'parentSame': the
    // org's parent and Status__c, no Family yet.
    const dir = path.join(proj, D, 'objectTranslations', 'Product2-pl');
    const T = (f) => path.join(D, 'objectTranslations', 'Product2-pl', f);
    const files = opts.cot === 'same' ? [
      await w(T('Product2-pl.objectTranslation-meta.xml'), 'ORG PARENT'),
      await w(T('Status__c.fieldTranslation-meta.xml'), 'ORG Status__c'),
      await w(T('Family.fieldTranslation-meta.xml'), 'ORG Family')
    ] : opts.cot === 'parentSame' ? [
      await w(T('Product2-pl.objectTranslation-meta.xml'), 'ORG PARENT'),
      await w(T('Status__c.fieldTranslation-meta.xml'), 'ORG Status__c')
    ] : [
      await w(T('Product2-pl.objectTranslation-meta.xml'), 'LOCAL PARENT'),
      await w(T('Status__c.fieldTranslation-meta.xml'), 'LOCAL Status__c'),
      await w(T('LocalOnly__c.fieldTranslation-meta.xml'), 'LOCAL ONLY')
    ];
    add('CustomObjectTranslation', 'Product2-pl', dir, files);
  }
  for (let n = 0; n < (opts.classes ?? 0); n++) {
    const cls = await w(path.join(D, 'classes', `AcmeBulk${n}.cls`), `public class AcmeBulk${n} {}`);
    add('ApexClass', `AcmeBulk${n}`, cls, [cls]);
  }
  return { proj, items };
}

/** Every file below `dir` → its content, for before/after comparisons. */
async function snapshot(dir) {
  const out = {};
  const walk = async (d) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full); else out[path.relative(dir, full)] = await fsp.readFile(full, 'utf8');
    }
  };
  await walk(dir);
  return out;
}
function changes(before, after) {
  const added = Object.keys(after).filter(k => !(k in before)).sort();
  const changed = Object.keys(after).filter(k => k in before && before[k] !== after[k]).sort();
  const removed = Object.keys(before).filter(k => !(k in after)).sort();
  return { added, changed, removed };
}

/** A provider on the real prototype, rooted at `proj`. */
function provider(proj, items, extra = {}) {
  const posted = [];
  const kept = {};
  const toasts = [];
  const backups = [];
  const calls = [];
  const counters = { loads: 0 };
  const notices = [];
  const s = Object.create(proto);
  Object.assign(s, {
    busy: false, confirmOpen: false, deployQueue: [], cmdSeq: 0,
    orgMembers: new Map((extra.orgOnly ?? ['ApexClass:Foo']).map(k => [k, true])), orgMembersOrg: ORG,
    items, workspaceRoot: proj,
    orgs: [{ username: ORG, alias: 'acme-dev', instanceUrl: 'https://acme-dev.sandbox.my.salesforce.com', isSandbox: true }],
    orgStore: { get: () => ORG, set: async () => {}, setFromUserPick: async () => {} },
    loadFiles: async () => { counters.loads++; },
    maybeBackupBeforeRetrieve: async (_root, candidates) => { backups.push([...candidates]); return { note: 'Backed up — restore via \'SF Deploy: Restore Retrieve Backup\'.', dir: path.join(tmp, 'backup') }; },
    output: { appendLine: () => {} },
    context: { workspaceState: { get: k => kept[k], update: async (k, v) => { kept[k] = v === undefined ? undefined : JSON.parse(JSON.stringify(v)); } }, globalState: { get: () => undefined, update: async () => {} } },
    view: { visible: true, webview: { postMessage() {} } },
    post: m => posted.push(JSON.parse(JSON.stringify(m))),
    failureToast: (message, lines) => toasts.push({ message, lines })
  });
  s.sf = fakeSf(calls, extra.hooks);
  s.notifySuccessIfPanelHidden = (m) => notices.push(['ok', m]);
  s.notifyIfPanelHidden = (m, kind) => notices.push([kind, m]);
  return { s, posted, kept, toasts, backups, calls, counters, notices };
}
const lastRun = (p) => p.posted.filter(m => m.type === 'runs').slice(-1)[0];
const retrieve = (p, keys) => proto.runRetrieve.call(p.s, keys);
const rel = (p, ...s) => path.join('core', 'main', 'default', ...s);
const tempOf = (call) => path.dirname(call.cwd); // <tmp>/sf-deploy-retrieve-xxx

// ================================================================ retrieve
check('retrieve: Translations:pl + ApexClass:Foo → two calls; only the translation and the class reach the project', async () => {
  reset();
  const { proj, items } = await makeProject('r1');
  const before = await snapshot(proj);
  const p = provider(proj, items);
  await retrieve(p, ['Translations:pl', 'ApexClass:Foo']);
  assert.strictEqual(p.calls.length, 2, JSON.stringify(p.calls.map(c => c.metadata)));
  const [plain, temp] = p.calls;
  assert.strictEqual(plain.cwd, proj);
  assert.deepStrictEqual(plain.metadata, ['ApexClass:Foo'], 'the plain call is unchanged: the class alone, into the project');
  assert.strictEqual(plain.opts.ignoreConflicts, true);
  assert.notStrictEqual(temp.cwd, proj);
  assert.ok(!temp.cwd.startsWith(proj), 'the context call runs in a throwaway project');
  assert.deepStrictEqual(temp.requested, ['Translations:pl', 'CustomLabels:CustomLabels', 'CustomTab:Acme_Widget__c']);
  assert.ok(!temp.opts.ignoreConflicts && !temp.opts.manifest);
  // The copied file must be what a retrieve straight into the project writes: same API version.
  assert.strictEqual(temp.project.sourceApiVersion, '62.0', 'the temp project carries the project\'s sourceApiVersion');

  const after = await snapshot(proj);
  assert.deepStrictEqual(changes(before, after), {
    added: [path.join('app', 'main', 'default', 'classes', 'Foo.cls'), path.join('app', 'main', 'default', 'classes', 'Foo.cls-meta.xml')],
    changed: [rel(p, 'translations', 'pl.translation-meta.xml')],
    removed: []
  });
  assert.ok(after[rel(p, 'translations', 'pl.translation-meta.xml')].includes('<label>Witaj</label>'), 'the org\'s full translation, labels filled in');
  assert.ok(after[rel(p, 'translations', 'pl.translation-meta.xml')].includes('<name>Acme_Widget__c</name>'));
  assert.strictEqual(after[rel(p, 'labels', 'CustomLabels.labels-meta.xml')], 'LOCAL LABELS', 'a companion is never written');
  assert.ok(!fs.existsSync(path.join(proj, 'app', 'main', 'default', 'labels')), 'no labels/ folder appeared');
  assert.ok(!fs.existsSync(tempOf(temp)), 'the throwaway project is removed');
});

check('retrieve: the backup covers the translation; the modal discloses the companions first', async () => {
  reset();
  const { proj, items } = await makeProject('r2');
  const p = provider(proj, items);
  await retrieve(p, ['Translations:pl', 'ApexClass:Foo']);
  assert.strictEqual(p.backups.length, 1);
  assert.ok(p.backups[0].includes(path.join(proj, rel(p, 'translations', 'pl.translation-meta.xml'))), JSON.stringify(p.backups[0]));
  const modal = ui.warns.find(w => w.modal);
  assert.ok(modal && modal.detail.includes('Translations:pl: 2 companions (scope: project) are retrieved alongside, into a temporary project, never written to yours — so it comes back complete.'), modal && modal.detail);
});

check('retrieve: the run carries project paths, the companion note and what was copied — no companion row, no temp path', async () => {
  reset();
  const { proj, items } = await makeProject('r3');
  const p = provider(proj, items);
  await retrieve(p, ['Translations:pl', 'ApexClass:Foo']);
  const { runs: [run], latestRows } = lastRun(p);
  assert.strictEqual(run.status, 'succeeded');
  assert.deepStrictEqual(latestRows.rows.filter(r => r.s === 1).map(r => [r.k, r.o]).sort(), [['ApexClass:Foo', 'created'], ['Translations:pl', 'changed']]);
  assert.ok(!latestRows.rows.some(r => r.k.startsWith('CustomLabels:') || r.k.startsWith('CustomTab:')), JSON.stringify(latestRows.rows));
  assert.ok(run.notes.includes('companions: CustomLabels:CustomLabels, CustomTab:Acme_Widget__c (scope: project)'), JSON.stringify(run.notes));
  assert.ok(run.notes.includes(`copied into your project: ${rel(p, 'translations', 'pl.translation-meta.xml')}`), JSON.stringify(run.notes));
  // The merged result the run was built from: the translation at its project path.
  const { result } = finished[0];
  const tr = result.inboundFiles.find(f => f.type === 'Translations');
  assert.strictEqual(tr.filePath, path.join(proj, rel(p, 'translations', 'pl.translation-meta.xml')));
  const temp = tempOf(p.calls[1]);
  for (const blob of [JSON.stringify(result), JSON.stringify(p.posted.filter(m => m.type === 'runs')), JSON.stringify(p.kept)]) {
    assert.ok(!blob.includes(temp), 'a temp path leaked into the run');
  }
  // Both commands echoed; the second says where it ran.
  const cmds = p.posted.filter(m => m.type === 'cmdLog' || m.type === 'cmd').map(m => JSON.stringify(m));
  const echoed = JSON.stringify(p.posted);
  assert.ok(echoed.includes('--metadata ApexClass:Foo') && echoed.includes('--metadata Translations:pl --metadata CustomLabels:CustomLabels'), echoed.slice(0, 2000));
  assert.ok(echoed.includes(`(in temp project ${p.calls[1].cwd})`), 'the temp cwd is noted on the echoed command');
  assert.deepStrictEqual(p.s.cmdLog.map(e => e.status), ['ok', 'ok'], 'two commands, both ended');
  void cmds;
});

check('retrieve, scope org: a NEW translation lands in the default package dir; the temp call is a package.xml with `*`', async () => {
  reset();
  config.contextScope = 'org';
  const { proj, items } = await makeProject('r4', { pl: false, labels: false, tab: false });
  const before = await snapshot(proj);
  const p = provider(proj, items, { orgOnly: ['ApexClass:Foo', 'Translations:fr'] });
  await retrieve(p, ['Translations:fr', 'ApexClass:Foo']);
  assert.strictEqual(p.calls.length, 2);
  const temp = p.calls[1];
  assert.ok(temp.opts.manifest, 'a `*` member only travels in a package.xml');
  assert.ok(temp.manifestXml.includes('<members>*</members>\n    <name>CustomLabels</name>'), temp.manifestXml);
  assert.ok(temp.manifestXml.includes('<members>fr</members>\n    <name>Translations</name>'), temp.manifestXml);
  assert.ok(temp.manifestXml.includes('<version>62.0</version>'), 'a retrieve\'s package.xml keeps the project\'s API version');
  const after = await snapshot(proj);
  const fr = path.join('app', 'main', 'default', 'translations', 'fr.translation-meta.xml');
  assert.deepStrictEqual(changes(before, after), {
    added: [path.join('app', 'main', 'default', 'classes', 'Foo.cls'), path.join('app', 'main', 'default', 'classes', 'Foo.cls-meta.xml'), fr].sort(),
    changed: [], removed: []
  });
  assert.ok(after[fr].includes('<label>Witaj</label>'));
  assert.ok(!fs.existsSync(temp.manifestXml && path.dirname(temp.opts.manifest)), 'the temp package.xml is removed');
});

/** After the project retrieve wrote the class, the context half stopped: the run
 *  keeps the class, marks the translation alone, rescans, and reads "partial". */
async function assertStoppedAfterClass(p, proj, before, word) {
  const { runs: [run], latestRows } = lastRun(p);
  assert.strictEqual(run.status, 'partial', JSON.stringify(run));
  const rows = Object.fromEntries(latestRows.rows.map(r => [r.k, r]));
  assert.strictEqual(rows['ApexClass:Foo'].o, 'created', 'the class the first call wrote stays on the run');
  assert.strictEqual(rows['Translations:pl'].o, 'failed');
  assert.ok(rows['Translations:pl'].m.startsWith(`${word} before the org answered — the local file was left as it was`), rows['Translations:pl'].m);
  assert.ok(run.notes.includes(`Translations:pl: ${word} before the org answered — its local file was left as it was`), JSON.stringify(run.notes));
  const after = await snapshot(proj);
  assert.strictEqual(after[rel(p, 'translations', 'pl.translation-meta.xml')], before[rel(p, 'translations', 'pl.translation-meta.xml')]);
  assert.ok(path.join('app', 'main', 'default', 'classes', 'Foo.cls') in after, 'the class is on disk');
  assert.strictEqual(p.counters.loads, 1, 'the project is rescanned');
  assert.deepStrictEqual(p.toasts, [], 'the user\'s own Cancel (or the timeout) is no failure toast');
  assert.deepStrictEqual(p.notices, [['warn', `Retrieve from acme-dev: 1 retrieved · 1 ${word} (local file left as it was)`]]);
}

check('retrieve: a Cancel landing as the first call finishes stops the second — the class stays, the translation is left as it was', async () => {
  reset();
  const { proj, items } = await makeProject('r5');
  const before = await snapshot(proj);
  const p = provider(proj, items, { hooks: { before: (call, n) => { if (n === 1) proto.cancelCurrent.call(p.s); } } });
  await retrieve(p, ['Translations:pl', 'ApexClass:Foo']);
  assert.strictEqual(p.calls.length, 1, 'the second call must never start');
  await assertStoppedAfterClass(p, proj, before, 'cancelled');
});

check('retrieve: a Cancel during the temp call, after the project one — partial, the class kept', async () => {
  reset();
  const { proj, items } = await makeProject('r5b');
  const before = await snapshot(proj);
  const p = provider(proj, items, { hooks: { honourCancel: true, before: (call, n) => { if (n === 2) proto.cancelCurrent.call(p.s); } } });
  await retrieve(p, ['Translations:pl', 'ApexClass:Foo']);
  assert.strictEqual(p.calls.length, 2);
  assert.ok(p.calls[1].cancelled, 'the in-flight temp call was killed');
  await assertStoppedAfterClass(p, proj, before, 'cancelled');
  assert.deepStrictEqual(p.s.cmdLog.map(e => e.status), ['ok', 'err']);
});

check('retrieve: the temp call timing out after the project one — partial, the class kept', async () => {
  reset();
  const { proj, items } = await makeProject('r5c');
  const before = await snapshot(proj);
  const p = provider(proj, items, { hooks: { fail: (_c, n) => (n === 2 ? new SfCliError('sf project retrieve start timed out after 180000ms') : undefined) } });
  await retrieve(p, ['Translations:pl', 'ApexClass:Foo']);
  await assertStoppedAfterClass(p, proj, before, 'timed out');
});

check('retrieve: an item project scope can\'t fill is never promised "complete" — the dialog says it comes back nearly empty', async () => {
  reset();
  // A class and a profile, but no labels, apps, tabs, flows, quick actions or report types.
  const { proj, items } = await makeProject('r13', { profile: 'LOCAL PROFILE', labels: false, tab: false, missingTab: false });
  const p = provider(proj, items);
  await retrieve(p, ['Translations:pl', 'Profile:Admin']);
  const lines = ui.warns.find(w => w.modal).detail.split('\n');
  assert.ok(lines.includes('Profile:Admin: 2 companions (scope: project) are retrieved alongside, into a temporary project, never written to yours — so it comes back complete.'), lines.join('\n'));
  assert.ok(!lines.some(l => l.includes('Translations:pl') && l.includes('complete.')), lines.join('\n'));
  assert.ok(lines.includes('project scope found no CustomLabels/CustomApplication/CustomTab/Flow/QuickAction/ReportType in this project — Translations:pl will come back nearly empty; set sfOrgDeployWrapper.contextScope to "org"'), lines.join('\n'));
});

check('retrieve, scope org: the org list\'s standard objects ride beside CustomObject:*, its custom ones never by name', async () => {
  reset();
  config.contextScope = 'org';
  const { proj, items } = await makeProject('r14', { profile: 'LOCAL PROFILE', pl: false, labels: false, tab: false });
  const p = provider(proj, items, { orgOnly: ['CustomObject:Account', 'CustomObject:Opportunity', 'CustomObject:Acme_Widget__c'] });
  await retrieve(p, ['Profile:Admin']);
  const objects = p.calls[0].requested.filter(k => k.startsWith('CustomObject:')).sort();
  assert.deepStrictEqual(objects, ['CustomObject:*', 'CustomObject:Account', 'CustomObject:Opportunity', 'CustomObject:Product2']);
  assert.ok(!lastRun(p).runs[0].notes.some(n => n.startsWith('org list not loaded')), JSON.stringify(lastRun(p).runs[0].notes));
});

check('retrieve: a Cancel during the temp call copies nothing', async () => {
  reset();
  const { proj, items } = await makeProject('r6');
  const before = await snapshot(proj);
  const p = provider(proj, items, { hooks: { honourCancel: true, before: (call, n) => { if (n === 1) proto.cancelCurrent.call(p.s); } } });
  await retrieve(p, ['Translations:pl']);
  assert.strictEqual(p.calls.length, 1);
  assert.ok(p.calls[0].cancelled, 'the in-flight call was killed');
  assert.strictEqual(lastRun(p).runs[0].status, 'cancelled');
  assert.deepStrictEqual(changes(before, await snapshot(proj)), { added: [], changed: [], removed: [] });
});

check('retrieve: a failed temp retrieve leaves the local translation untouched — alone, an error run', async () => {
  reset();
  const { proj, items } = await makeProject('r7');
  const before = await snapshot(proj);
  const p = provider(proj, items, { hooks: { fail: () => new SfCliError('INVALID_SESSION_ID: Session expired or invalid') } });
  await retrieve(p, ['Translations:pl']);
  assert.strictEqual(p.calls.length, 1);
  assert.strictEqual(lastRun(p).runs[0].status, 'error');
  assert.deepStrictEqual(changes(before, await snapshot(proj)), { added: [], changed: [], removed: [] });
  assert.deepStrictEqual(p.s.cmdLog.map(e => e.status), ['err']);
});

check('retrieve: a failed temp retrieve after the project one — the class is kept, the translation fails alone, untouched', async () => {
  reset();
  const { proj, items } = await makeProject('r8');
  const before = await snapshot(proj);
  const p = provider(proj, items, { hooks: { fail: (_c, n) => (n === 2 ? new SfCliError('INVALID_TYPE: something went wrong') : undefined) } });
  await retrieve(p, ['Translations:pl', 'ApexClass:Foo']);
  const { runs: [run], latestRows } = lastRun(p);
  assert.strictEqual(run.status, 'partial');
  assert.deepStrictEqual(latestRows.rows.map(r => [r.k, r.o]).sort(), [['ApexClass:Foo', 'created'], ['Translations:pl', 'failed']]);
  const after = await snapshot(proj);
  assert.strictEqual(after[rel(p, 'translations', 'pl.translation-meta.xml')], LOCAL_PL);
  assert.ok(path.join('app', 'main', 'default', 'classes', 'Foo.cls') in after);
  assert.strictEqual(p.toasts.length, 1);
  assert.deepStrictEqual(p.s.cmdLog.map(e => e.status), ['ok', 'err'], 'both commands logged, the failed one ended as failed');
  void before;
});

check('retrieve: an object translation folder is MERGED — org files overwrite, a local-only file stays; the object never lands', async () => {
  reset();
  const { proj, items } = await makeProject('r9', { cot: true });
  const before = await snapshot(proj);
  const p = provider(proj, items);
  await retrieve(p, ['CustomObjectTranslation:Product2-pl']);
  assert.strictEqual(p.calls.length, 1);
  assert.deepStrictEqual(p.calls[0].requested, ['CustomObjectTranslation:Product2-pl', 'CustomObject:Product2']);
  assert.ok(ui.warns.find(w => w.modal).detail.includes('CustomObjectTranslation:Product2-pl: 1 companion (scope: project) is retrieved alongside, into a temporary project, never written to yours — so it comes back complete.'));
  // The hidden-panel toast counts components, not the folder's three file rows.
  assert.deepStrictEqual(p.notices, [['ok', 'Retrieved 1 component from acme-dev']]);
  const dir = rel(p, 'objectTranslations', 'Product2-pl');
  const after = await snapshot(proj);
  assert.deepStrictEqual(changes(before, after), {
    added: [path.join(dir, 'Family.fieldTranslation-meta.xml')],
    changed: [path.join(dir, 'Product2-pl.objectTranslation-meta.xml'), path.join(dir, 'Status__c.fieldTranslation-meta.xml')],
    removed: []
  });
  assert.strictEqual(after[path.join(dir, 'LocalOnly__c.fieldTranslation-meta.xml')], 'LOCAL ONLY', 'a file only the project has is never deleted');
  assert.ok(!fs.existsSync(path.join(proj, 'app', 'main', 'default', 'objects')), 'the companion object was not written');
  const { runs: [run] } = lastRun(p);
  assert.ok(run.notes.includes(`copied into your project: ${dir}${path.sep} (3 files)`), JSON.stringify(run.notes));
  // Every file row at its project path…
  assert.deepStrictEqual(finished[0].result.inboundFiles.map(f => path.relative(proj, f.filePath)).sort(), [
    path.join(dir, 'Family.fieldTranslation-meta.xml'), path.join(dir, 'Product2-pl.objectTranslation-meta.xml'), path.join(dir, 'Status__c.fieldTranslation-meta.xml')
  ]);
  // …and the folder is ONE component: an existing parent overwritten → changed,
  // even though a field file is new (the strongest-state pick would say created).
  assert.deepStrictEqual(lastRun(p).latestRows.rows.map(r => [r.k, r.o]), [['CustomObjectTranslation:Product2-pl', 'changed']]);
});

check('retrieve: a merged folder\'s row — created when nothing existed, unchanged when identical, changed when files were added', async () => {
  const cases = [
    ['r9b', {}, ['CustomObjectTranslation:Product2-pl'], 'created'],
    ['r9c', { cot: 'same' }, [], 'unchanged'],
    ['r9d', { cot: 'parentSame' }, [], 'changed']
  ];
  for (const [name, opts, orgOnly, want] of cases) {
    reset();
    const { proj, items } = await makeProject(name, { pl: false, labels: false, tab: false, ...opts });
    const p = provider(proj, items, { orgOnly });
    await retrieve(p, ['CustomObjectTranslation:Product2-pl']);
    assert.deepStrictEqual(lastRun(p).latestRows.rows.map(r => [r.k, r.o]), [['CustomObjectTranslation:Product2-pl', want]], name);
    assert.ok(fs.existsSync(path.join(proj, opts.cot ? 'core' : 'app', 'main', 'default', 'objectTranslations', 'Product2-pl', 'Family.fieldTranslation-meta.xml')), name);
  }
  assert.strictEqual(folderState([]), 'Unchanged');
  assert.strictEqual(folderState(['Created', 'Unchanged']), 'Changed');
});

check('retrieve: a profile comes back with what its companions describe; the local class body stays', async () => {
  reset();
  const { proj, items } = await makeProject('r10', { profile: 'LOCAL PROFILE', pl: false, labels: false, tab: false });
  const before = await snapshot(proj);
  const p = provider(proj, items);
  await retrieve(p, ['Profile:Admin']);
  assert.deepStrictEqual(p.calls[0].requested.sort(), ['ApexClass:AcmeService', 'CustomField:Product2.Status__c', 'CustomTab:Acme_Missing__c', 'Profile:Admin']);
  const after = await snapshot(proj);
  assert.deepStrictEqual(changes(before, after), { added: [], changed: [rel(p, 'profiles', 'Admin.profile-meta.xml')], removed: [] });
  assert.ok(after[rel(p, 'profiles', 'Admin.profile-meta.xml')].includes('<apexClass>AcmeService</apexClass>'));
  assert.ok(after[rel(p, 'profiles', 'Admin.profile-meta.xml')].includes('<field>Product2.Status__c</field>'));
  // A companion the org doesn't have is logged, not one of the run's notes.
  const { runs: [run] } = lastRun(p);
  assert.strictEqual(run.status, 'succeeded');
  assert.ok(!(run.notes || []).some(n => n.includes('cannot be found')), JSON.stringify(run.notes));
});

check('retrieve, companions off: ONE call into the project as before, and the run says so', async () => {
  reset();
  config.contextCompanions = false;
  const { proj, items } = await makeProject('r11');
  const p = provider(proj, items);
  await retrieve(p, ['Translations:pl', 'ApexClass:Foo']);
  assert.strictEqual(p.calls.length, 1);
  assert.strictEqual(p.calls[0].cwd, proj);
  assert.deepStrictEqual(p.calls[0].metadata, ['Translations:pl', 'ApexClass:Foo']);
  assert.ok(lastRun(p).runs[0].notes.includes('retrieved without companions'));
});

check('retrieve, project scope with nothing to send: one call, and the LOUD note in the modal and on the run', async () => {
  reset();
  const { proj, items } = await makeProject('r12', { labels: false, tab: false });
  const p = provider(proj, items);
  await retrieve(p, ['Translations:pl']);
  assert.strictEqual(p.calls.length, 1);
  const loud = 'project scope found no CustomLabels/CustomApplication/CustomTab/Flow/QuickAction/ReportType in this project — Translations:pl will come back nearly empty; set sfOrgDeployWrapper.contextScope to "org"';
  assert.ok(ui.warns.find(w => w.modal).detail.includes(loud));
  assert.ok(lastRun(p).runs[0].notes.includes(loud));
});

// ==================================================================== diff
function diffProvider(proj, items, hooks) {
  const p = provider(proj, items, { hooks });
  p.s.view = undefined;
  p.s.reserveBusy = () => true;
  p.s.setBusy = () => {};
  p.s.withWindowProgress = (_t, body) => body(() => {});
  return p;
}
const diffCards = (p) => p.posted.filter(m => m.type === 'status').map(m => m.card);
const ORG_PROFILE_WITH_COMPANIONS = orgAnswer(['Profile:Admin', 'ApexClass:AcmeService', 'CustomField:Product2.Status__c'], '62.0').out[0].body;

check('diff: the retrieve carries the companions; the profile opens ONE editor, companions none, a missing companion is not "not on org"', async () => {
  reset();
  const { proj, items } = await makeProject('d1', { profile: 'LOCAL PROFILE', pl: false, labels: false, tab: false });
  const p = diffProvider(proj, items);
  await proto.runDiff.call(p.s, ['Profile:Admin']);
  assert.strictEqual(p.calls.length, 1);
  assert.deepStrictEqual(p.calls[0].requested.sort(), ['ApexClass:AcmeService', 'CustomField:Product2.Status__c', 'CustomTab:Acme_Missing__c', 'Profile:Admin']);
  assert.strictEqual(ui.diffs.length, 1, JSON.stringify(ui.diffs));
  assert.ok(ui.diffs[0].title.startsWith('Profile:Admin'), ui.diffs[0].title);
  assert.strictEqual(fs.readFileSync(ui.diffs[0].left, 'utf8'), ORG_PROFILE_WITH_COMPANIONS);
  const card = diffCards(p)[0];
  assert.strictEqual(card.kind, 'ok', JSON.stringify(card));
  assert.ok(!card.lines.some(l => l.includes('not on org')), card.lines.join('\n'));
  assert.ok(!card.lines.some(l => l.startsWith('✗')), card.lines.join('\n'));
  assert.ok(card.lines.includes('companions: ApexClass:AcmeService, CustomTab:Acme_Missing__c, CustomField:Product2.Status__c (scope: project)'), card.lines.join('\n'));
  assert.ok(card.lines.includes('1 message about companions only (e.g. one not on the org) — see the SF Deploy output'), card.lines.join('\n'));
  assert.strictEqual(card.meta, '1 differ · 0 in sync · 0 not on org');
  assert.ok(!p.calls[0].opts.manifest, 'four targets: --metadata');
  assert.strictEqual(p.calls[0].project.sourceApiVersion, '62.0', 'the temp project carries the project\'s API version');
});

check('diff: above MANIFEST_THRESHOLD the retrieve is a package.xml, like a retrieve', async () => {
  reset();
  const { proj, items } = await makeProject('d5', { profile: 'LOCAL PROFILE', pl: false, labels: false, tab: false, classes: 30 });
  const p = diffProvider(proj, items);
  await proto.runDiff.call(p.s, ['Profile:Admin']);
  assert.ok(p.calls[0].requested.length > 30, String(p.calls[0].requested.length));
  assert.ok(p.calls[0].opts.manifest, 'over 30 targets must not go as --metadata argv');
  assert.ok(p.calls[0].manifestXml.includes('<members>AcmeBulk29</members>'));
  assert.ok(JSON.stringify(p.posted).includes('--manifest '), 'the echoed command names the package.xml');
});

check('retrieve, then diff the same three: All 3 in sync — in both scopes', async () => {
  for (const scope of ['project', 'org']) {
    reset();
    config.contextScope = scope;
    const { proj, items } = await makeProject(`rd-${scope}`, { profile: 'LOCAL PROFILE', cot: 'parentSame' });
    const keys = ['Translations:pl', 'CustomObjectTranslation:Product2-pl', 'Profile:Admin'];
    await retrieve(provider(proj, items), keys);
    const d = diffProvider(proj, items);
    await proto.runDiff.call(d.s, keys);
    const card = diffCards(d)[0];
    assert.strictEqual(ui.diffs.length, 0, `${scope}: ${JSON.stringify(ui.diffs.map(x => x.title))}`);
    // Translations:pl + Profile:Admin + the folder's 3 files, each just written.
    assert.deepStrictEqual([card.kind, card.title], ['ok', 'All 5 in sync with acme-dev'], `${scope}: ${JSON.stringify(card)}`);
  }
});

check('diff: a profile identical to the org\'s complete one → All 1 in sync (companions are not counted)', async () => {
  reset();
  const { proj, items } = await makeProject('d2', { profile: ORG_PROFILE_WITH_COMPANIONS, pl: false, labels: false, tab: false });
  const p = diffProvider(proj, items);
  await proto.runDiff.call(p.s, ['Profile:Admin']);
  assert.strictEqual(ui.diffs.length, 0);
  const card = diffCards(p)[0];
  assert.deepStrictEqual([card.kind, card.title], ['ok', 'All 1 in sync with acme-dev']);
});

check('diff, scope org: a package.xml with `*` for each type', async () => {
  reset();
  config.contextScope = 'org';
  const { proj, items } = await makeProject('d3', { profile: 'LOCAL PROFILE', pl: false, labels: false, tab: false });
  const p = diffProvider(proj, items);
  await proto.runDiff.call(p.s, ['Profile:Admin']);
  assert.ok(p.calls[0].opts.manifest);
  assert.ok(p.calls[0].manifestXml.includes('<members>*</members>\n    <name>ApexClass</name>'), p.calls[0].manifestXml);
  assert.ok(p.calls[0].manifestXml.includes('<members>Admin</members>\n    <name>Profile</name>'));
  // A diff compares at the PROJECT's API version on both routes, the version
  // the local file was written at.
  assert.ok(p.calls[0].manifestXml.includes('<version>62.0</version>'), p.calls[0].manifestXml);
  assert.strictEqual(p.calls[0].project.sourceApiVersion, '62.0');
  assert.strictEqual(ui.diffs.length, 1);
});

check('diff, companions off: the profile alone, and the card says so', async () => {
  reset();
  config.contextCompanions = false;
  const { proj, items } = await makeProject('d4', { profile: 'LOCAL PROFILE', pl: false, labels: false, tab: false });
  const p = diffProvider(proj, items);
  await proto.runDiff.call(p.s, ['Profile:Admin']);
  assert.deepStrictEqual(p.calls[0].requested, ['Profile:Admin']);
  assert.ok(diffCards(p)[0].lines.includes('retrieved without companions'));
});

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
check('this harness is registered in package.json "check"', () => {
  assert.ok(pkg.scripts.check.includes('node ./scripts/check-context-retrieve.cjs'));
});

(async () => {
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'sf-context-retrieve-')));
  for (const [name, fn] of queue) {
    try { await fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e && e.message}`); }
  }
  for (const fn of editorListeners.splice(0)) fn([]);
  await fsp.rm(tmp, { recursive: true, force: true });
  if (failed) { console.error(`context-retrieve: ${failed}/${queue.length} checks FAILED`); process.exit(1); }
  console.log(`context-retrieve: all ${queue.length} checks passed`);
  process.exit(0);
})();
