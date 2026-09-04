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
Module._load = (req, ...rest) => (req === 'vscode' ? {} : origLoad(req, ...rest));

const { rulesFromRegistry, locateRegistry, loadRegistryRules } = require(path.join(__dirname, '..', 'out', 'registryRules.js'));
const { STATIC_RULE_FOLDERS, inferItemForPath } = require(path.join(__dirname, '..', 'out', 'metadataScanner.js'));

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
    for (const t of ['Bundlish', 'Infold', 'Parent', 'Kid', 'Stat', 'Bad-Name', 'BadDir', 'NoSuffix', 'AlphaTwin']) assert.ok(!byType[t], `${t} must be skipped`);
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
      for (const t of ['ApexClass', 'LightningComponentBundle', 'StaticResource', 'CustomObject', 'CustomField', 'Report', 'EmailTemplate', 'CustomLabels', 'OmniUiCard', 'Flow', 'Layout']) {
        assert.ok(!byType[t], `${t} must not come from the registry (static rule or non-default shape)`);
      }
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
    assert.strictEqual((src.match(/scanWorkspace\(this\.ruleSet\(/g) || []).length, 2, 'fast scan + explicit scan');
    assert.ok(/scanWorkspace\(\[\.\.\.this\.ruleSet\(\), \.\.\.fresh\]\)/.test(src), 'post-resolution rescan');
    assert.ok(/inferItemForPath\(uri\.fsPath, this\.ruleSet\(\)\)/.test(src), 'right-click inference');
    assert.ok(!/scanWorkspace\(this\.learnedRules\(/.test(src) && !/inferItemForPath\([^)]*this\.learnedRules\(/.test(src), 'no call site bypasses the registry');
    assert.ok(/private ruleSet\(includeExpired = false\)[\s\S]*?this\.learnedRules\(includeExpired\)\.filter\(r => !covered\.has\(r\.folder\)\)/.test(src));
  });
  await check('explicit scans refresh the registry rules, silent rescans reuse them', () => {
    assert.ok(/await this\.ensureRegistryRules\(!opts\.silent\);\s*\n\s*let scan = await scanWorkspace\(this\.ruleSet\(!!opts\.silent\)\)/.test(src));
    assert.ok(/await this\.ensureRegistryRules\(\);\s*\n\s*const scan = await scanWorkspace\(this\.ruleSet\(true\)\)/.test(src), 'context-menu fast scan loads (cached) rules first');
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed) { console.error(`registry-rules: ${failed}/${ran} checks FAILED`); process.exit(1); }
  console.log(`registry-rules: all ${ran} checks passed`);
})();
