// Runnable contract test for registryRules.ts: folder rules read from the sf
// CLI's own metadata registry file, so default-shaped types need neither a CLI
// spawn nor the 7-day learned-rule cache.
// No framework.   1) npm run compile   2) node scripts/check-registry-rules.cjs
//
// Contracts under test:
//  - rulesFromRegistry: emits `{folder, type, primaryExt: ['.<suffix>-meta.xml']}`
//    for default-adapter, non-folder, childless types only; skips child types,
//    static-rule folders, bad charsets; keeps distinct suffixes per folder,
//    dedupes identical folder+suffix; tolerates garbage input.
//  - locateRegistry: follows the `sf` symlink on PATH and finds the registry
//    hoisted beside or nested under the CLI package; undefined otherwise.
//  - Real registry (when a CLI is installed here): sanity on known shapes.
//  - inferItemForPath resolves a registry-only type with those rules.
//  - Source pins: every scan/infer call site in panelProvider.ts goes through
//    ruleSet(); explicit scans refresh, silent ones reuse.
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const Module = require('module');
const origLoad = Module._load;
// scanWorkspace needs project discovery (workspaceFolders + findFiles); the
// rest never touches the stub.
const ws = { folders: [], projectFiles: [] };
const vscodeStub = {
  workspace: {
    get workspaceFolders() { return ws.folders; },
    findFiles: async () => ws.projectFiles.map(f => ({ fsPath: f })),
    asRelativePath: uri => uri.fsPath
  },
  RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
  Uri: { file: fsPath => ({ fsPath, scheme: 'file' }) }
};
Module._load = (req, ...rest) => (req === 'vscode' ? vscodeStub : origLoad(req, ...rest));

const { rulesFromRegistry, locateRegistry, loadRegistryRules, nonDerivableFolders, registryNonDerivable } = require(path.join(__dirname, '..', 'out', 'registryRules.js'));
const { STATIC_RULE_FOLDERS, inferItemForPath, scanWorkspace } = require(path.join(__dirname, '..', 'out', 'metadataScanner.js'));
const { DeployPanelProvider } = require(path.join(__dirname, '..', 'out', 'panelProvider.js'));

let failed = 0;
let ran = 0;
function check(name, fn) {
  ran++;
  return Promise.resolve().then(fn).catch(e => { failed++; console.error(`FAIL ${name}: ${e.message}`); });
}

const STATIC = new Set(['classes', 'lwc', 'objects']);
const FIXTURE = {
  types: {
    alpha: { name: 'Alpha', directoryName: 'alphas', suffix: 'alpha' },
    deflt: { name: 'Deflt', directoryName: 'deflts', suffix: 'deflt', strategies: { adapter: 'default' } },
    bundlish: { name: 'Bundlish', directoryName: 'bundlish', suffix: 'b', strategies: { adapter: 'bundle' } },
    infold: { name: 'Infold', directoryName: 'infolds', suffix: 'infold', inFolder: true },
    parent: { name: 'Parent', directoryName: 'parents', suffix: 'parent', children: { types: {} } },
    kid: { name: 'Kid', directoryName: 'kids', suffix: 'kid' },
    stat: { name: 'Stat', directoryName: 'classes', suffix: 'stat' },
    badname: { name: 'Bad-Name', directoryName: 'bads', suffix: 'bad' },
    baddir: { name: 'BadDir', directoryName: 'bad/dir', suffix: 'bd' },
    nosuffix: { name: 'NoSuffix', directoryName: 'nosuffix' },
    waveA: { name: 'WaveA', directoryName: 'wave', suffix: 'wa' },
    waveB: { name: 'WaveB', directoryName: 'wave', suffix: 'wb' },
    dupe: { name: 'AlphaTwin', directoryName: 'alphas', suffix: 'alpha' },
    junk: null,
  },
  childTypes: { kid: 'parent' },
};

(async () => {
  await check('default-shaped types become -meta.xml rules; everything else is skipped', () => {
    const rules = rulesFromRegistry(FIXTURE, STATIC);
    const byType = Object.fromEntries(rules.map(r => [r.type, r]));
    assert.deepStrictEqual(byType.Alpha, { folder: 'alphas', type: 'Alpha', primaryExt: ['.alpha-meta.xml'] });
    assert.deepStrictEqual(byType.Deflt, { folder: 'deflts', type: 'Deflt', primaryExt: ['.deflt-meta.xml'] });
    // A parent with children but no strategy is still one -meta.xml file (AssignmentRules…).
    assert.deepStrictEqual(byType.Parent, { folder: 'parents', type: 'Parent', primaryExt: ['.parent-meta.xml'] });
    for (const t of ['Bundlish', 'Infold', 'Kid', 'Stat', 'Bad-Name', 'BadDir', 'NoSuffix', 'AlphaTwin']) assert.ok(!byType[t], `${t} must be skipped`);
  });

  await check('nonDerivableFolders: bundle / folder-based types only, static folders and child types excluded', () => {
    const m = nonDerivableFolders(FIXTURE, STATIC);
    assert.deepStrictEqual([...m.entries()].sort(), [['bundlish', 'Bundlish'], ['infolds', 'Infold']]);
    assert.deepStrictEqual([...nonDerivableFolders({ types: { s: { name: 'S', directoryName: 'classes', strategies: { adapter: 'bundle' } } } }, STATIC).keys()], [], 'static folder never listed');
    assert.deepStrictEqual([...nonDerivableFolders(null, STATIC).keys()], []);
    assert.deepStrictEqual([...registryNonDerivable().keys()].length >= 0, true, 'getter is safe before any load');
  });

  await check('two types sharing a folder with different suffixes both get a rule', () => {
    const rules = rulesFromRegistry(FIXTURE, STATIC).filter(r => r.folder === 'wave');
    assert.deepStrictEqual(rules.map(r => r.primaryExt[0]).sort(), ['.wa-meta.xml', '.wb-meta.xml']);
  });

  await check('garbage input yields no rules, never throws', () => {
    for (const bad of [null, undefined, 42, 'x', {}, { types: 'nope' }, { types: { a: 'str' } }, { types: {}, childTypes: 'x' }]) {
      assert.deepStrictEqual(rulesFromRegistry(bad, STATIC), []);
    }
  });

  await check('a directoryName of "." or ".." can never become a folder', () => {
    const reg = { types: { dot: { name: 'Dot', directoryName: '.', suffix: 'dot' }, dots: { name: 'Dots', directoryName: '..', suffix: 'dots' }, ok: { name: 'Ok', directoryName: 'ok.dir', suffix: 'ok' } } };
    assert.deepStrictEqual(rulesFromRegistry(reg, STATIC).map(r => r.folder), ['ok.dir']);
  });

  // ---- mixed folders: registry rules must not shadow other shapes (0.21.2) ----
  const WDS = { folder: 'wave', type: 'WaveDataset', primaryExt: ['.wds-meta.xml'] };
  const WDASH = { folder: 'wave', type: 'WaveDashboard', primaryExt: ['.wdash-meta.xml'] };

  await check('ruleSet keeps a learned rule for the same folder with a different suffix, drops an identical one', () => {
    const fake = { registryRules: [WDS], learnedRules: () => [WDASH, { ...WDS, type: 'WaveDatasetTwin' }] };
    const set = DeployPanelProvider.prototype.ruleSet.call(fake, true);
    assert.deepStrictEqual(set.map(r => r.type), ['WaveDataset', 'WaveDashboard'], JSON.stringify(set));
    const bare = DeployPanelProvider.prototype.ruleSet.call({ learnedRules: () => [WDASH] });
    assert.deepStrictEqual(bare, [WDASH], 'no registry (bare prototype object) → learned rules pass through');
  });

  await check('scanWorkspace: a folder with -meta.xml files no extra rule describes stays unknown; a fully described one does not; static folders never are', async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-mixed-'));
    const pkg = path.join(proj, 'force-app', 'main', 'default');
    fs.mkdirSync(path.join(pkg, 'wave'), { recursive: true });
    fs.mkdirSync(path.join(pkg, 'classes'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }] }));
    fs.writeFileSync(path.join(pkg, 'wave', 'Sales.wds-meta.xml'), '<x/>');
    fs.writeFileSync(path.join(pkg, 'wave', 'Board.wdash-meta.xml'), '<x/>');
    fs.writeFileSync(path.join(pkg, 'classes', 'Acme.cls'), '');
    fs.writeFileSync(path.join(pkg, 'classes', 'Acme.cls-meta.xml'), '<x/>');
    ws.folders = [{ uri: { fsPath: proj }, name: 'mixed', index: 0 }];
    ws.projectFiles = [path.join(proj, 'sfdx-project.json')];
    const partial = await scanWorkspace([WDS]);
    assert.deepStrictEqual(partial.unknownFolders.map(f => path.basename(f)), ['wave'], 'residual .wdash → wave stays unknown');
    assert.deepStrictEqual(partial.items.map(i => `${i.type}:${i.name}`).sort(), ['ApexClass:Acme', 'WaveDataset:Sales']);
    const full = await scanWorkspace([WDS, WDASH]);
    assert.deepStrictEqual(full.unknownFolders, [], 'every -meta.xml described → not unknown');
    assert.deepStrictEqual(full.items.map(i => `${i.type}:${i.name}`).sort(), ['ApexClass:Acme', 'WaveDashboard:Board', 'WaveDataset:Sales']);
    const none = await scanWorkspace([]);
    assert.deepStrictEqual(none.unknownFolders.map(f => path.basename(f)), ['wave'], 'no rule at all → unknown, classes (static) never');
    fs.rmSync(proj, { recursive: true, force: true });
  });

  // ---- locateRegistry against a fake CLI install ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-registry-'));
  const REL = ['node_modules', '@salesforce', 'source-deploy-retrieve', 'lib', 'src', 'registry', 'metadataRegistry.json'];
  const mk = (...p) => { const f = path.join(...p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(FIXTURE)); return f; };
  // Homebrew/npm layout: bin/sf → <cli>/bin/run.js, SDR nested under the CLI package.
  const cli = path.join(tmp, 'lib', 'node_modules', '@salesforce', 'cli');
  fs.mkdirSync(path.join(cli, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(cli, 'bin', 'run.js'), '');
  const nested = mk(cli, ...REL);
  fs.mkdirSync(path.join(tmp, 'bin'));
  fs.symlinkSync(path.join(cli, 'bin', 'run.js'), path.join(tmp, 'bin', 'sf'));
  // Hoisted layout: <prefix>/node_modules/@salesforce/cli/bin/run.js with SDR beside the CLI package.
  const prefix = path.join(tmp, 'hoisted');
  fs.mkdirSync(path.join(prefix, 'node_modules', '@salesforce', 'cli', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(prefix, 'node_modules', '@salesforce', 'cli', 'bin', 'run.js'), '');
  const hoisted = mk(prefix, ...REL);
  fs.mkdirSync(path.join(prefix, 'bin'));
  fs.symlinkSync(path.join(prefix, 'node_modules', '@salesforce', 'cli', 'bin', 'run.js'), path.join(prefix, 'bin', 'sf'));
  const empty = path.join(tmp, 'empty');
  fs.mkdirSync(empty);

  await check('locateRegistry follows the sf symlink to a nested SDR', async () => {
    assert.strictEqual(fs.realpathSync(await locateRegistry({ PATH: path.join(tmp, 'bin') })), fs.realpathSync(nested));
  });
  await check('locateRegistry finds a hoisted SDR beside the CLI package', async () => {
    assert.strictEqual(fs.realpathSync(await locateRegistry({ PATH: path.join(prefix, 'bin') })), fs.realpathSync(hoisted));
  });
  await check('no sf on PATH → undefined; PATH entries that are not dirs are skipped', async () => {
    assert.strictEqual(await locateRegistry({ PATH: [empty, path.join(tmp, 'nope'), ''].join(path.delimiter) }), undefined);
    assert.strictEqual(await locateRegistry({}), undefined);
  });
  await check('loadRegistryRules: cached until refresh; failure → [] not throw', async () => {
    const saved = process.env.PATH;
    try {
      process.env.PATH = path.join(tmp, 'bin');
      const a = await loadRegistryRules(STATIC, { refresh: true });
      assert.ok(a.some(r => r.type === 'Alpha'));
      process.env.PATH = empty;
      assert.strictEqual(await loadRegistryRules(STATIC), a, 'no refresh → same cached array');
      assert.deepStrictEqual(await loadRegistryRules(STATIC, { refresh: true }), [], 'refresh with no CLI → []');
    } finally { process.env.PATH = saved; }
  });

  // ---- real registry, when a CLI is installed on this machine ----
  const real = await locateRegistry();
  if (real) {
    await check('real registry: known default types in, known non-default types out', () => {
      const rules = rulesFromRegistry(JSON.parse(fs.readFileSync(real, 'utf8')), STATIC_RULE_FOLDERS);
      const byType = Object.fromEntries(rules.map(r => [r.type, r]));
      assert.ok(rules.length > 300, `expected hundreds of rules, got ${rules.length}`);
      assert.deepStrictEqual(byType.PermissionSetGroup, { folder: 'permissionsetgroups', type: 'PermissionSetGroup', primaryExt: ['.permissionsetgroup-meta.xml'] });
      // 0.22.1: parents-with-children that are still one file come from the registry.
      assert.deepStrictEqual(byType.AssignmentRules, { folder: 'assignmentRules', type: 'AssignmentRules', primaryExt: ['.assignmentRules-meta.xml'] });
      assert.deepStrictEqual(byType.MatchingRules, { folder: 'matchingRules', type: 'MatchingRules', primaryExt: ['.matchingRule-meta.xml'] });
      for (const t of ['SharingRules', 'EscalationRules', 'AutoResponseRules']) assert.ok(byType[t], `${t} must come from the registry`);
      for (const t of ['ApexClass', 'LightningComponentBundle', 'StaticResource', 'CustomObject', 'CustomObjectTranslation', 'Bot', 'CustomField', 'Report', 'Dashboard', 'EmailTemplate', 'CustomLabels', 'Workflow', 'OmniUiCard', 'Flow', 'Layout']) {
        assert.ok(!byType[t], `${t} must not come from the registry (static rule, decomposed, folder-based or bundle)`);
      }
      const nd = nonDerivableFolders(JSON.parse(fs.readFileSync(real, 'utf8')), STATIC_RULE_FOLDERS);
      assert.strictEqual(nd.get('documents'), 'Document');
      assert.strictEqual(nd.get('experiences'), 'ExperienceBundle');
      assert.strictEqual(nd.get('bots'), 'Bot');
      for (const f of ['reports', 'dashboards', 'email', 'classes', 'lwc', 'objects', 'assignmentRules', 'permissionsetgroups']) assert.ok(!nd.has(f), `${f} must not be listed as non-derivable`);
      for (const r of rules) {
        assert.ok(/^[A-Za-z0-9_]+$/.test(r.type) && /^\.[A-Za-z0-9_]+-meta\.xml$/.test(r.primaryExt[0]), JSON.stringify(r));
        assert.ok(!STATIC_RULE_FOLDERS.has(r.folder), `static folder leaked: ${r.folder}`);
      }
    });
    await check('inferItemForPath resolves a registry-only type with those rules, and not without', () => {
      const rules = rulesFromRegistry(JSON.parse(fs.readFileSync(real, 'utf8')), STATIC_RULE_FOLDERS);
      const p = path.join(tmp, 'proj', 'force-app', 'main', 'default', 'permissionsetgroups', 'Acme_Admins.permissionsetgroup-meta.xml');
      const hit = inferItemForPath(p, rules);
      assert.ok(hit && hit.type === 'PermissionSetGroup' && hit.name === 'Acme_Admins', JSON.stringify(hit));
      assert.strictEqual(inferItemForPath(p, []), undefined);
    });
  } else {
    console.log('registry-rules: no sf CLI on PATH — real-registry checks skipped');
  }

  // ---- source pins ----
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'panelProvider.ts'), 'utf8');
  await check('every scan/infer call site goes through ruleSet(); learnedRules() is only called inside it', () => {
    assert.strictEqual((src.match(/scanWorkspace\(this\.ruleSet\(/g) || []).length, 3, 'fast scan + explicit scan + discovery retry');
    assert.ok(/scanWorkspace\(\[\.\.\.this\.ruleSet\(\), \.\.\.fresh\]\)/.test(src), 'post-resolution rescan');
    assert.ok(/inferItemForPath\(uri\.fsPath, this\.ruleSet\(\)\)/.test(src), 'right-click inference');
    assert.ok(!/scanWorkspace\(this\.learnedRules\(/.test(src) && !/inferItemForPath\([^)]*this\.learnedRules\(/.test(src), 'no call site bypasses the registry');
    assert.ok(/private ruleSet\(includeExpired = false\)[\s\S]*?this\.learnedRules\(includeExpired\)\.filter\(r => !covered\.has\(key\(r\)\)\)/.test(src), 'coverage keyed on folder+suffix, never folder alone');
  });
  await check('known-shape folders skip the CLI and get their own banner; CLI resolutions run 3 at a time', () => {
    assert.ok(/const nonDerivable = registryNonDerivable\(\);/.test(src));
    assert.ok(/const known = nonDerivable\.get\(path\.basename\(folder\)\);\s*\n\s*if \(known\) \{\s*\n\s*this\.markUnresolvable\(folder\);/.test(src), 'known shape → negative-cached without a CLI call');
    assert.ok(/const limit = 3;/.test(src) && /Array\.from\(\{ length: Math\.min\(limit, toResolve\.length\) \}, worker\)/.test(src), 'bounded concurrency');
    assert.ok(/Not shown in the tree \(folder-based or bundle types, deploy via right-click\): \$\{this\.knownShapeSkips\.join\(', '\)\}/.test(src));
    assert.ok(/Couldn't resolve metadata type for: \$\{realFailures\.join\(', '\)\}/.test(src), 'real failures keep the error wording');
  });

  await check('an explicit scan that finds no project retries before believing it; folder changes rescan', () => {
    assert.ok(/if \(!opts\.silent && isProjectNotFound\(scan\)\) \{\s*\n\s*scan = await retryProjectNotFound\(scan, \(\) => scanWorkspace\(this\.ruleSet\(\)\), DeployPanelProvider\.discoveryRetryDelays/.test(src));
    assert.ok(/const DISCOVERY_RETRY_DELAYS_MS = \[1500, 4000, 10000\];/.test(src));
    assert.ok(/static discoveryRetryDelays: number\[\] = DISCOVERY_RETRY_DELAYS_MS;/.test(src), 'harness-overridable');
    assert.ok(/vscode\.workspace\.onDidChangeWorkspaceFolders\(\(\) => \{\s*\n\s*this\.loadFiles\(\)\.catch/.test(src));
  });

  await check('explicit scans refresh the registry rules, silent rescans reuse them', () => {
    assert.ok(/await this\.ensureRegistryRules\(!opts\.silent\);\s*\n\s*let scan = await scanWorkspace\(this\.ruleSet\(!!opts\.silent\)\)/.test(src));
    assert.ok(/await this\.ensureRegistryRules\(\);\s*\n\s*const scan = await scanWorkspace\(this\.ruleSet\(true\)\)/.test(src), 'context-menu fast scan loads (cached) rules first');
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed) { console.error(`registry-rules: ${failed}/${ran} checks FAILED`); process.exit(1); }
  console.log(`registry-rules: all ${ran} checks passed`);
})();
