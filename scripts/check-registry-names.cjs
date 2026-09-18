// Registry-vs-code naming check. Every hard-coded Salesforce metadata type
// name, type folder and file suffix in this extension must match the sf CLI's
// own registry (@salesforce/source-deploy-retrieve's metadataRegistry.json)
// BYTE-FOR-BYTE, case included.
//
// Why (0.23.4): one static rule spelled `platformEventSubscriberConfigs` where
// the registry says `PlatformEventSubscriberConfigs`. The type name and the
// suffix were right, the scan still found the files on macOS, and the only
// symptom was the component missing from the Changed view — a check that asks
// "does this type exist?" passes that. Two more rules had never matched a real
// project at all (ExternalDataSource: folder AND suffix; RemoteSiteSetting:
// suffix), silently, because the static folder also blocked the registry rule.
// This check compares the strings, so drift fails the build instead of a view.
//
// No framework.   1) npm run compile   2) node scripts/check-registry-names.cjs
// FAILS — does not skip — when no sf CLI registry can be located on PATH: the
// check is only meaningful against the real file (locateRegistry, same lookup
// the extension uses at runtime).
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const Module = require('module');
const origLoad = Module._load;
// panelProvider/depGraph import vscode at module load; nothing here calls it.
const vscodeStub = {
  workspace: { getConfiguration: () => ({ get: (_k, d) => d }), workspaceFolders: [], onDidChangeConfiguration: () => ({ dispose() {} }) },
  window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
  Uri: { file: fsPath => ({ fsPath, scheme: 'file' }) },
  RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
  Disposable: class { constructor(fn) { this.dispose = fn || (() => {}); } },
  ThemeIcon: class {}, ThemeColor: class {}, TreeItem: class {}, ProgressLocation: {}, ViewColumn: {}, StatusBarAlignment: {}
};
Module._load = (req, ...rest) => (req === 'vscode' ? vscodeStub : origLoad(req, ...rest));

const out = p => path.join(__dirname, '..', 'out', p);
const { locateRegistry } = require(out('registryRules.js'));
const { RULES, OBJECT_CHILD_RULES, OBJECT_CHILD_TYPES, DIRECTORY_ITEM_TYPES } = require(out('metadataScanner.js'));
const { FETCH_ORG_TYPES, FOLDERED_TYPES, DIFF_UNSUPPORTED, FAST_DIFF_FIELD } = require(out('panelProvider.js'));
const { INDEXED_TYPES } = require(out('depGraph.js'));

const failures = [];
const fail = msg => failures.push(msg);

(async () => {
  // SF_METADATA_REGISTRY=<path to metadataRegistry.json> overrides the PATH
  // lookup for a machine where `sf` is a version-manager shim locateRegistry
  // can't follow. Still a real registry file — never a fixture.
  const registryPath = process.env.SF_METADATA_REGISTRY || await locateRegistry();
  assert.ok(registryPath && fs.existsSync(registryPath), 'no sf CLI registry found — install the sf CLI so `sf` on PATH resolves to it, or set SF_METADATA_REGISTRY=<path>/metadataRegistry.json; this check only means something against the real file');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  let version = 'unknown';
  try { version = JSON.parse(fs.readFileSync(path.join(path.dirname(registryPath), '..', '..', '..', 'package.json'), 'utf8')).version; } catch { /* informational */ }

  // name → {directoryName, suffix, parent?}, top-level types and every parent's
  // decomposed children (the registry's `childTypes` only maps child id → parent id).
  const byName = new Map();
  for (const t of Object.values(registry.types)) {
    byName.set(t.name, { directoryName: t.directoryName, suffix: t.suffix });
    for (const c of Object.values(t.children?.types ?? {})) byName.set(c.name, { directoryName: c.directoryName, suffix: c.suffix, parent: t.name });
  }
  assert.ok(byName.size > 300, `registry looks truncated: ${byName.size} types`);
  const describe = t => `directoryName=${t.directoryName} suffix=${t.suffix}${t.parent ? ` (child of ${t.parent})` : ''}`;

  // 1. Static folder rules: folder = directoryName, suffixes = the registry suffix
  //    (`.<suffix>` content file and/or `.<suffix>-meta.xml`), all exact.
  assert.ok(RULES.length >= 40, `RULES not exported / shrank: ${RULES.length}`); // 40 at 0.23.4 — raise as rules are added, never lower
  for (const r of RULES) {
    const t = byName.get(r.type);
    if (!t) { fail(`RULES ${r.type}: type not in registry`); continue; }
    if (r.folder !== t.directoryName) fail(`RULES ${r.type}: folder '${r.folder}' ≠ registry directoryName '${t.directoryName}'`);
    if (r.bundle) { if (r.primaryExt || r.metaSuffix) fail(`RULES ${r.type}: a bundle rule carries suffixes`); continue; }
    if (!t.suffix) { fail(`RULES ${r.type}: registry has no suffix, rule has ${JSON.stringify(r.primaryExt)}`); continue; }
    const allowed = [`.${t.suffix}`, `.${t.suffix}-meta.xml`];
    for (const ext of r.primaryExt ?? []) if (!allowed.includes(ext)) fail(`RULES ${r.type}: primaryExt '${ext}' ≠ registry suffix '${t.suffix}' (expected one of ${allowed.join(', ')})`);
    if (r.metaSuffix && r.metaSuffix !== `.${t.suffix}-meta.xml`) fail(`RULES ${r.type}: metaSuffix '${r.metaSuffix}' ≠ '.${t.suffix}-meta.xml'`);
    if (!(r.primaryExt ?? []).length) fail(`RULES ${r.type}: no primaryExt`);
  }

  // 2. Decomposed CustomObject children: folder and suffix from the child entry.
  assert.strictEqual(OBJECT_CHILD_RULES.length, 10, 'OBJECT_CHILD_RULES not exported / unexpected size');
  for (const r of OBJECT_CHILD_RULES) {
    const t = byName.get(r.type);
    if (!t) { fail(`OBJECT_CHILD_RULES ${r.type}: type not in registry`); continue; }
    if (t.parent !== 'CustomObject') fail(`OBJECT_CHILD_RULES ${r.type}: not a CustomObject child in the registry (${describe(t)})`);
    if (r.folder !== t.directoryName) fail(`OBJECT_CHILD_RULES ${r.type}: folder '${r.folder}' ≠ '${t.directoryName}'`);
    if (r.suffix !== `.${t.suffix}-meta.xml`) fail(`OBJECT_CHILD_RULES ${r.type}: suffix '${r.suffix}' ≠ '.${t.suffix}-meta.xml'`);
  }

  // 3. Every other hard-coded type name: must be a registry type, exact case.
  const lists = {
    FETCH_ORG_TYPES: [...FETCH_ORG_TYPES],
    FOLDERED_TYPES: [...Object.keys(FOLDERED_TYPES), ...Object.values(FOLDERED_TYPES)],
    DIFF_UNSUPPORTED: [...DIFF_UNSUPPORTED],
    FAST_DIFF_FIELD: Object.keys(FAST_DIFF_FIELD),
    INDEXED_TYPES: [...INDEXED_TYPES],
    OBJECT_CHILD_TYPES: [...OBJECT_CHILD_TYPES],
    DIRECTORY_ITEM_TYPES: [...DIRECTORY_ITEM_TYPES]
  };
  let names = 0;
  for (const [list, values] of Object.entries(lists)) {
    assert.ok(values.length > 0, `${list} is empty — export lost?`);
    for (const n of values) {
      names++;
      if (byName.has(n)) continue;
      const near = [...byName.keys()].find(k => k.toLowerCase() === n.toLowerCase());
      fail(`${list}: '${n}' not in registry${near ? ` (registry spells it '${near}')` : ''}`);
    }
  }
  // Every scanned type is also fetched: a static rule for a type Fetch Org never
  // lists would show local rows that can never gain org status.
  for (const r of RULES) if (r.type !== 'EmailFolder' && r.type !== 'ReportFolder' && r.type !== 'DashboardFolder' && !FETCH_ORG_TYPES.includes(r.type)) fail(`RULES ${r.type}: scanned locally but absent from FETCH_ORG_TYPES`);

  // 4. Harness fixtures that spell real-world paths: check-diff-matrix's FIX list
  //    (rel: '<folder>/<Name>.<suffix>-meta.xml' per type) must use registry spellings.
  const matrixSrc = fs.readFileSync(path.join(__dirname, 'check-diff-matrix.cjs'), 'utf8');
  const fixtures = [...matrixSrc.matchAll(/rel: '([^']+)', type: '([^']+)'/g)];
  // Every `{ rel:` entry must have parsed — a fixture whose shape drifted from
  // the regex would otherwise silently leave the pinned surface.
  const entries = (matrixSrc.match(/\{ rel: '/g) ?? []).length;
  assert.ok(fixtures.length >= 40 && fixtures.length === entries, `check-diff-matrix.cjs FIX list: parsed ${fixtures.length} of ${entries} entries`);
  for (const [, rel, type] of fixtures) {
    const t = byName.get(type);
    if (!t) { fail(`check-diff-matrix ${type}: type not in registry`); continue; }
    const [folder, ...rest] = rel.split('/');
    const file = rest[rest.length - 1];
    if (t.parent) {
      // Decomposed child: `<parentDir>/<Object>/<childDir>/<Name>.<suffix>-meta.xml`.
      const parentDir = byName.get(t.parent).directoryName;
      if (folder !== parentDir) fail(`check-diff-matrix ${type}: fixture folder '${folder}' ≠ parent directoryName '${parentDir}'`);
      if (rest[1] !== t.directoryName) fail(`check-diff-matrix ${type}: fixture child folder '${rest[1]}' ≠ '${t.directoryName}'`);
    } else if (folder !== t.directoryName) fail(`check-diff-matrix ${type}: fixture folder '${folder}' ≠ '${t.directoryName}'`);
    // A bundle fixture ends in a folder (no dot); every file fixture carries the suffix.
    if (t.suffix && file.includes('.') && !(file.endsWith(`.${t.suffix}-meta.xml`) || file.endsWith(`.${t.suffix}`))) fail(`check-diff-matrix ${type}: fixture '${file}' does not carry suffix '${t.suffix}'`);
  }

  if (failures.length) {
    console.error(`check-registry-names: ${failures.length} mismatch(es) against registry ${registryPath} (SDR ${version}):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`check-registry-names: ${RULES.length} rules, ${OBJECT_CHILD_RULES.length} child rules, ${names} type names, ${fixtures.length} diff-matrix fixtures match the sf CLI registry byte-for-byte (SDR ${version})`);
})().catch(e => { console.error(`FAIL check-registry-names: ${e.message}`); process.exit(1); });
