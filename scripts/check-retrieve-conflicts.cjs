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
//  - writeBackup / maybeBackupBeforeRetrieve, driven for real against a tmp
//    workspace: "nothing to save" (org-only candidates) and "candidates existed
//    but none were copyable" (missing / outside the workspace) used to collapse
//    to the same silent `undefined` — the retrieve card said nothing, even
//    though the second case means the safety net the setting promised did NOT
//    fire. They must now read apart: the first stays undefined (there was
//    never anything to back up), the second gets a note (no `dir`, so the
//    conflict-check gate above stays on — there's nothing on disk to vouch for
//    the overwrite).
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const assert = require('assert');
const Module = require('module');
const vscodeStub = {
  workspace: { getConfiguration: () => ({ get: (_k, fallback) => fallback }) },
  Uri: {
    file: fsPath => ({ fsPath }),
    joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) })
  }
};
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? vscodeStub : origLoad(req, ...rest));

const { SfCliService } = require(path.join(__dirname, '..', 'out', 'sfCliService.js'));
const { DeployPanelProvider } = require(path.join(__dirname, '..', 'out', 'panelProvider.js'));

// Queued + awaited (not run inline): the new writeBackup/maybeBackupBeforeRetrieve
// checks below are genuinely async (real fs.lstat/copyFile against a tmp dir), and
// a bare `fn()` would let their assertions fire after this script had already
// exited 0.
let failed = 0;
const queue = [];
function check(name, fn) { queue.push([name, fn]); }

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
  // `dir` is only set on the count>0 branch; disabled / over-cap / nothing-local /
  // nothing-copyable all return without it — so `backupDir !== undefined` is "a
  // backup is on disk".
  const fn = src.slice(src.indexOf('private async maybeBackupBeforeRetrieve('), src.indexOf('private async writeBackup('));
  assert.ok(/if \(!this\.backupsEnabled\(\)\) return undefined;/.test(fn), 'disabled → undefined');
  assert.ok(/if \(result\.count === 0\) \{/.test(fn), 'count===0 branches (offered vs. nothing) instead of a flat return');
  assert.ok(/if \(result\.offered\) \{/.test(fn), 'candidates offered but none copyable gets its own note');
  assert.ok(!/note: `backup skipped — none of[^`]*`,\s*\n\s*dir:/.test(fn), 'the nothing-copyable note must never carry a dir');
  // `dir:` must appear only AFTER the count===0 guard, i.e. never on the over-cap
  // OR nothing-copyable branches.
  const guard = fn.indexOf('if (result.count === 0)');
  assert.ok(guard > 0 && !fn.slice(0, guard).includes('dir:') && fn.slice(guard).includes('dir: result.dir'), 'dir only on the copied branch');
});

// ---- writeBackup / maybeBackupBeforeRetrieve, driven for real ------------

/** A minimal provider: only what writeBackup/maybeBackupBeforeRetrieve touch
 *  (backupsRoot → context.globalStorageUri, output, and vscode's config stub
 *  above for backupsEnabled). Real tmp dirs on disk — this exercises actual
 *  fs.lstat/copyFile/mkdir, not a mock of them. */
function backupProvider(storageDir) {
  return Object.assign(Object.create(DeployPanelProvider.prototype), {
    output: { appendLine: () => {} },
    context: { globalStorageUri: { fsPath: storageDir } }
  });
}
const maybeBackup = (prov, root, paths, org) =>
  DeployPanelProvider.prototype.maybeBackupBeforeRetrieve.call(prov, root, paths, org);

async function withTmpWorkspace(fn) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'sf-backup-'));
  const root = path.join(base, 'ws');
  const storage = path.join(base, 'storage');
  await fsp.mkdir(root, { recursive: true });
  try { await fn(root, storage); } finally { await fsp.rm(base, { recursive: true, force: true }); }
}

check('org-only candidates (no local file at all) → undefined, nothing written', async () => {
  await withTmpWorkspace(async (root, storage) => {
    const prov = backupProvider(storage);
    // '' is exactly what an org-only item contributes to candidatePaths (see
    // runRetrieve: items.flatMap(i => [i.filePath, ...i.files])).
    const result = await maybeBackup(prov, root, ['', ''], 'acme-dev');
    assert.strictEqual(result, undefined);
    assert.ok(!fs.existsSync(storage), 'no backup dir should be created for an empty offer');
  });
});

check('candidates offered but none copyable (missing + outside workspace) → note, no dir', async () => {
  await withTmpWorkspace(async (root, storage) => {
    const prov = backupProvider(storage);
    const missing = path.join(root, 'Missing.cls');
    const outside = path.join(os.tmpdir(), 'not-in-workspace.cls');
    await fsp.writeFile(outside, 'body', 'utf8'); // exists, but not under root
    const result = await maybeBackup(prov, root, [missing, outside], 'acme-dev');
    assert.ok(result, 'a real safety-net gap must not stay silent');
    assert.strictEqual(result.dir, undefined, 'no dir — the CLI conflict check must stay on');
    assert.strictEqual(result.note, "backup skipped — none of 2 local files could be saved (see Output)");
    await fsp.rm(outside, { force: true });
  });
});

check('one offered, none copyable → singular wording', async () => {
  await withTmpWorkspace(async (root, storage) => {
    const prov = backupProvider(storage);
    const result = await maybeBackup(prov, root, [path.join(root, 'Gone.cls')], 'acme-dev');
    assert.strictEqual(result.note, "backup skipped — none of 1 local file could be saved (see Output)");
    assert.strictEqual(result.dir, undefined);
  });
});

check('a real copyable file still backs up normally — dir present, note unchanged', async () => {
  await withTmpWorkspace(async (root, storage) => {
    const prov = backupProvider(storage);
    const real = path.join(root, 'Real.cls');
    await fsp.writeFile(real, 'public class Real {}', 'utf8');
    const result = await maybeBackup(prov, root, [real], 'acme-dev');
    assert.ok(result.dir, 'a copied file must still hand back a dir');
    assert.strictEqual(result.note, "backed up 1 file — restore via 'SF Deploy: Restore Retrieve Backup'");
    assert.ok(fs.existsSync(path.join(result.dir, 'Real.cls')));
  });
});

check('a mix of copyable and non-copyable candidates counts only what was actually saved', async () => {
  await withTmpWorkspace(async (root, storage) => {
    const prov = backupProvider(storage);
    const real = path.join(root, 'Real.cls');
    await fsp.writeFile(real, 'public class Real {}', 'utf8');
    const missing = path.join(root, 'Missing.cls');
    const result = await maybeBackup(prov, root, [real, missing], 'acme-dev');
    // 2 candidates, 1 copyable: this is the "copied branch" (count > 0), not the
    // "none copyable" branch — the dropped candidate is only logged, since the
    // backup as a whole still succeeded and has a dir to restore from.
    assert.ok(result.dir);
    assert.strictEqual(result.note, "backed up 1 file — restore via 'SF Deploy: Restore Retrieve Backup'");
  });
});

check('diff slow-path retrieve is NOT forced', () => {
  const i = src.indexOf('metadataArgs(slowItems)');
  assert.ok(i > 0);
  const window = src.slice(i, i + 600);
  assert.ok(!/ignoreConflicts: true/.test(window), 'diff temp-dir retrieve must not force the flag');
});

check('deploy flag still comes from the setting (with the one-off retry override), never hard-coded', () => {
  assert.ok(!/deployMetadata\([^\n]*ignoreConflicts: true/.test(src), 'deploy must not hard-code ignoreConflicts');
  // runDeploy: the "Retry + overwrite" card button's per-click flag wins when
  // present (opts.ignoreConflictsOverride, sourced ONLY from
  // deployOptsFromRetry ← RetryRequest.ignoreConflicts — see
  // check-retry-helpers.cjs), otherwise the machine-scoped setting decides —
  // exactly as before this feature existed.
  assert.ok(
    /const ignoreConflicts = opts\.ignoreConflictsOverride \?\? this\.ignoreDeployConflicts\(\);/.test(src),
    'runDeploy must read the override before falling back to the setting'
  );
  // A context-menu manifest deploy is untouched by this feature (no discrete key
  // list for a "Retry + overwrite" request to carry — see buildRetryRequest) —
  // it still reads the setting alone, with no override plumbing at all.
  assert.ok(/const ignoreConflicts = this\.ignoreDeployConflicts\(\);\n/.test(src), 'runManifestDeploy must still read the plain setting');
});

check('nothing hard-codes the override to true — only deployOptsFromRetry\'s gated ternary sets it', () => {
  // The literal substring "ignoreConflictsOverride: true" must never appear —
  // deployOptsFromRetry writes `r.ignoreConflicts === true ? true : undefined`,
  // where "true" is never adjacent to the field name. A future edit that
  // collapses that ternary into a bare `ignoreConflictsOverride: true` (there or
  // anywhere else) would force every deploy through the overwrite path.
  const hits = src.match(/ignoreConflictsOverride:\s*true\b/g) || [];
  assert.deepStrictEqual(hits, [], `unexpected hard-coded override(s): ${hits.join(', ')}`);
  assert.ok(src.includes('ignoreConflictsOverride: r.ignoreConflicts === true ? true : undefined'), 'the gated ternary itself must still be there');
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
  }
  if (failed) { console.error(`retrieve-conflicts: ${failed}/${queue.length} checks FAILED`); process.exit(1); }
  console.log(`retrieve-conflicts: all ${queue.length} checks passed`);
})();
