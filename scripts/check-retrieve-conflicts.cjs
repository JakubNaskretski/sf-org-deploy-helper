// Runnable contract test: a confirmed retrieve passes `--ignore-conflicts` exactly
// when a pre-retrieve backup was written to disk.
// No framework.   1) npm run compile   2) node scripts/check-retrieve-conflicts.cjs
//
// Why: the retrieve confirm modal already says "This will overwrite your local
// files" and a backup is taken first, so the CLI's own source-tracking conflict
// check protects nothing extra — it only BLOCKS the retrieve with "Source
// Conflict Error" on tracked orgs. Without a backup on disk (setting off, or
// skipped as over the file cap) the CLI check is the LAST safety net and must
// stay. Deploy keeps its opt-in toggle (there the overwrite hits the org).
//
// Contracts under test:
//  - SfCliService.retrieveMetadata: `ignoreConflicts: true` adds the flag once,
//    after the targets and before `--json`; omitted/false adds nothing (the diff
//    slow path retrieves into a temp dir and must stay flag-free).
//  - Source pins: BOTH user-facing retrieve call sites (selection + manifest)
//    derive the flag from `backupDir !== undefined` — never a literal `true` —
//    and the manifest site additionally requires no unresolved folder types
//    (its backup set comes from the scan, which can't see those). The command
//    echoed on the card is keyed on the same variable, so what the user sees is
//    what ran. The deploy path is untouched: its flag is still gated on the
//    setting, never hard-coded.
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const Module = require('module');
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? {} : origLoad(req, ...rest));

const { SfCliService } = require(path.join(__dirname, '..', 'out', 'sfCliService.js'));

let failed = 0;
let ran = 0;
function check(name, fn) {
  ran++;
  try { fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}

// Capture argv instead of spawning `sf`.
function capture() {
  const sf = new SfCliService();
  const calls = [];
  sf.runJsonCancellable = (args) => { calls.push(args); return { promise: new Promise(() => undefined), cancel: () => undefined }; };
  return { sf, calls };
}

// ---- runtime: argv shape --------------------------------------------------

check('ignoreConflicts:true → flag present once, before --json', () => {
  const { sf, calls } = capture();
  sf.retrieveMetadata(['ApexClass:OrderService'], 'acme-dev', '/ws', { ignoreConflicts: true });
  const args = calls[0];
  assert.strictEqual(args.filter(a => a === '--ignore-conflicts').length, 1, args.join(' '));
  assert.strictEqual(args[args.length - 1], '--json');
  assert.ok(args.indexOf('--ignore-conflicts') > args.indexOf('--target-org'));
});

check('manifest retrieve carries the flag too', () => {
  const { sf, calls } = capture();
  sf.retrieveMetadata([], 'acme-dev', '/ws', { manifest: '/ws/manifest/package.xml', ignoreConflicts: true });
  assert.ok(calls[0].includes('--manifest') && calls[0].includes('--ignore-conflicts'), calls[0].join(' '));
});

check('omitted / false → no flag (diff temp-dir retrieve stays plain)', () => {
  const { sf, calls } = capture();
  sf.retrieveMetadata(['ApexClass:A'], 'acme-dev', '/ws', { outputDir: '/tmp/x' });
  sf.retrieveMetadata(['ApexClass:A'], 'acme-dev', '/ws', { ignoreConflicts: false });
  sf.retrieveMetadata(['ApexClass:A'], 'acme-dev', '/ws');
  for (const args of calls) assert.ok(!args.includes('--ignore-conflicts'), args.join(' '));
});

check('echoed cmd string (formatCmd of the argv) carries the flag', () => {
  const { sf, calls } = capture();
  sf.retrieveMetadata(['ApexClass:A'], 'acme-dev', '/ws', { ignoreConflicts: true });
  const cmd = sf.formatCmd(calls[0]);
  assert.ok(/--target-org acme-dev --ignore-conflicts$/.test(cmd), cmd);
});

// ---- source pins: the call sites ------------------------------------------

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'panelProvider.ts'), 'utf8');

const GATE_SELECTION = 'const ignoreConflicts = backupDir !== undefined;';
// Manifest: the backup set is derived from the scan, so an unresolved folder type
// (local files the scan can't see) means the backup can't vouch for the manifest.
const GATE_MANIFEST = 'const ignoreConflicts = backupDir !== undefined && this.unresolvable().size === 0;';

check('flag is derived from the backup actually written, at both call sites', () => {
  assert.strictEqual(src.split(GATE_SELECTION).length - 1, 1, `expected exactly 1 occurrence of: ${GATE_SELECTION}`);
  assert.strictEqual(src.split(GATE_MANIFEST).length - 1, 1, `expected exactly 1 occurrence of: ${GATE_MANIFEST}`);
  assert.ok(src.indexOf(GATE_SELECTION) < src.indexOf(GATE_MANIFEST), 'selection gate precedes manifest gate (runRetrieve before runManifestRetrieve)');
  assert.ok(!/retrieveMetadata\([^\n]*ignoreConflicts: true/.test(src), 'retrieve must never hard-code ignoreConflicts: true');
});

check('selection retrieve passes the gated variable', () => {
  const m = src.match(/this\.sf\.retrieveMetadata\(items\.map\([^\n]*\{[^\n]*\}\);/);
  assert.ok(m, 'selection retrieve call not found');
  assert.ok(/[{,] ignoreConflicts \}\);$/.test(m[0]), m[0]);
});

check('manifest retrieve passes the gated variable', () => {
  const m = src.match(/this\.sf\.retrieveMetadata\(\[\], org, root, \{[^\n]*\}\);/);
  assert.ok(m, 'manifest retrieve call not found');
  assert.ok(/[{,] ignoreConflicts \}\);$/.test(m[0]), m[0]);
});

check('both user-facing retrieve cards echo the flag keyed on the same variable', () => {
  // Whole lines: the manifest echo nests backticks inside `${...}`, so a
  // [^`]* match would stop early.
  const echoes = src.split('\n').filter(l => l.includes('beginCmd(`sf project retrieve start'));
  const userFacing = echoes.filter(e => !/metadataArgs\(slowItems\)/.test(e)); // diff slow path excluded
  assert.strictEqual(userFacing.length, 2, echoes.join('\n'));
  for (const e of userFacing) assert.ok(/--target-org \$\{org\}\$\{ignoreConflicts \? ' --ignore-conflicts' : ''\}`\);$/.test(e.trim()), e);
});

check('the gate reads the value maybeBackupBeforeRetrieve returns (dir only when files were copied)', () => {
  // `dir` is only set on the count>0 branch; disabled / over-cap / nothing-local
  // return without it — so `backupDir !== undefined` is "a backup is on disk".
  const fn = src.slice(src.indexOf('private async maybeBackupBeforeRetrieve('), src.indexOf('private async writeBackup('));
  assert.ok(/if \(!this\.backupsEnabled\(\)\) return undefined;/.test(fn), 'disabled → undefined');
  assert.ok(/if \(result\.count === 0\) return undefined;/.test(fn), 'nothing local → undefined');
  // `dir:` must appear only AFTER the count===0 guard, i.e. never on the over-cap branch.
  const guard = fn.indexOf('if (result.count === 0)');
  assert.ok(guard > 0 && !fn.slice(0, guard).includes('dir:') && fn.slice(guard).includes('dir: result.dir'), 'dir only on the copied branch');
});

check('diff slow-path retrieve is NOT forced', () => {
  const i = src.indexOf('metadataArgs(slowItems)');
  assert.ok(i > 0);
  const window = src.slice(i, i + 600);
  assert.ok(!/ignoreConflicts: true/.test(window), 'diff temp-dir retrieve must not force the flag');
});

check('deploy flag still comes from the setting, never hard-coded', () => {
  assert.ok(!/deployMetadata\([^\n]*ignoreConflicts: true/.test(src), 'deploy must not hard-code ignoreConflicts');
  assert.ok(/const ignoreConflicts = this\.ignoreDeployConflicts\(\);/.test(src));
});

if (failed) { console.error(`retrieve-conflicts: ${failed}/${ran} checks FAILED`); process.exit(1); }
console.log(`retrieve-conflicts: all ${ran} checks passed`);
