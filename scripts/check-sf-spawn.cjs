// Runnable contract test for the Windows `sf` launcher resolution
// (src/kit/sfCli.ts: resolveSfCommand / planSpawn — vendored from sf-kit, see the
// file's own banner).   No framework.
//   1) npm run compile   2) node scripts/check-sf-spawn.cjs
//
// The bug: resolveSfCommand's candidate list forced `.ps1` into consideration
// via `|| e === '.ps1'`, regardless of what PATHEXT actually listed — so a
// standalone-installer machine with only an `sf.ps1` shim on PATH (no `.cmd`)
// would resolve to it. planSpawn only knows how to rewrite `.cmd`/`.bat` for
// spawn(..., {shell:false}); a `.ps1` path reaches spawn unrewritten and can't
// launch (a script isn't directly executable). Fix: `.ps1` is never a candidate
// — `.cmd` is what the npm installer actually ships, `.exe` covers a native
// build, and the cmd.exe fallback in planSpawn is the last resort either way.
//
// Pinned here, against the resolver's injectable `{ exists }` predicate (no real
// filesystem or PATH touched):
//   1. `.cmd` is chosen over `.ps1` when both exist on PATH.
//   2. `.ps1` is NEVER returned — not even when it is the only shim found, and
//      not even when PATHEXT itself lists `.ps1` (the old `|| e === '.ps1'`
//      escape hatch is gone for good).
//   3. planSpawn still rewrites `.cmd`/`.bat` (node+run.js, else cmd.exe) and
//      leaves everything else — `.exe`, plain `sf`, non-Windows — untouched.
const path = require('path');
const assert = require('assert');
const Module = require('module');
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? {} : origLoad(req, ...rest));

const { resolveSfCommand, planSpawn } = require(path.join(__dirname, '..', 'out', 'kit', 'sfCli.js'));

let failed = 0;
let ran = 0;
function check(name, fn) {
  ran++;
  try { fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}

// ---- resolveSfCommand ------------------------------------------------------

check('non-Windows always returns the bare name', () => {
  assert.strictEqual(resolveSfCommand('darwin', {}), 'sf');
  assert.strictEqual(resolveSfCommand('linux', { PATH: '/usr/bin' }), 'sf');
});

check('.cmd is chosen over .ps1 when both exist on PATH', () => {
  const resolved = resolveSfCommand(
    'win32',
    { PATH: 'C:\\sf\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    p => p === 'C:\\sf\\bin\\sf.cmd' || p === 'C:\\sf\\bin\\sf.ps1'
  );
  assert.strictEqual(resolved, 'C:\\sf\\bin\\sf.cmd');
});

check('.exe still wins over .cmd (the rare native build)', () => {
  const resolved = resolveSfCommand(
    'win32',
    { PATH: 'C:\\sf\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    p => p === 'C:\\sf\\bin\\sf.exe' || p === 'C:\\sf\\bin\\sf.cmd'
  );
  assert.strictEqual(resolved, 'C:\\sf\\bin\\sf.exe');
});

check('.ps1 is never returned, even as the ONLY shim on PATH', () => {
  // `where` isn't meaningfully mockable here — it runs for real and fails on
  // this (non-Windows) host, so resolution falls through to the honest bare
  // name, same as "no shim found" (never a bogus success on a fake ENOENT).
  const resolved = resolveSfCommand(
    'win32',
    { PATH: 'C:\\sf\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    p => p === 'C:\\sf\\bin\\sf.ps1'
  );
  assert.notStrictEqual(resolved, 'C:\\sf\\bin\\sf.ps1');
  assert.strictEqual(resolved, 'sf');
});

check('.ps1 stays excluded even when PATHEXT itself lists it', () => {
  // The old bug's escape hatch was `|| e === '.ps1'` — independent of PATHEXT.
  // Prove PATHEXT naming .ps1 explicitly still doesn't resolve to it.
  const resolved = resolveSfCommand(
    'win32',
    { PATH: 'C:\\sf\\bin', PATHEXT: '.PS1;.CMD' },
    p => p === 'C:\\sf\\bin\\sf.ps1'
  );
  assert.strictEqual(resolved, 'sf');
});

check('a shim absent from PATHEXT is not tried even if it happens to exist', () => {
  // PATHEXT lists only .CMD — an sf.bat sitting on PATH must not be picked up.
  const resolved = resolveSfCommand(
    'win32',
    { PATH: 'C:\\sf\\bin', PATHEXT: '.CMD' },
    p => p === 'C:\\sf\\bin\\sf.bat'
  );
  assert.strictEqual(resolved, 'sf');
});

check('falls back to the bare name when nothing is found', () => {
  assert.strictEqual(resolveSfCommand('win32', { PATH: 'C:\\nope', PATHEXT: '.CMD' }, () => false), 'sf');
});

// ---- planSpawn ---------------------------------------------------------

check('non-Windows and non-shim commands pass through unchanged', () => {
  assert.deepStrictEqual(planSpawn('sf', ['org', 'list'], 'darwin'), { command: 'sf', args: ['org', 'list'] });
  assert.deepStrictEqual(
    planSpawn('C:\\sf\\bin\\sf.exe', ['org', 'list'], 'win32', {}, () => false),
    { command: 'C:\\sf\\bin\\sf.exe', args: ['org', 'list'] }
  );
});

check('.cmd is rewritten to node + run.js when the npm layout exists', () => {
  const runJs = 'C:\\npm\\node_modules\\@salesforce\\cli\\bin\\run.js';
  const plan = planSpawn('C:\\npm\\sf.cmd', ['org', 'list', '--json'], 'win32', {}, p => p === runJs);
  assert.deepStrictEqual(plan, { command: 'node', args: [runJs, 'org', 'list', '--json'] });
});

check('.cmd falls back to cmd.exe /d /s /c when the npm layout is absent', () => {
  const plan = planSpawn('C:\\npm\\sf.cmd', ['org', 'list'], 'win32', { ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe' }, () => false);
  assert.strictEqual(plan.command, 'C:\\WINDOWS\\system32\\cmd.exe');
  assert.strictEqual(plan.windowsVerbatimArguments, true);
  assert.deepStrictEqual(plan.args.slice(0, 3), ['/d', '/s', '/c']);
});

check('.bat is rewritten the same way .cmd is', () => {
  const plan = planSpawn('C:\\npm\\sf.bat', ['org', 'list'], 'win32', {}, () => false);
  assert.strictEqual(plan.command, 'cmd.exe');
});

check('a bare .ps1 command (hypothetically resolved) is left untouched by planSpawn — it only knows .cmd/.bat', () => {
  // Guards the OTHER half of the original bug: even if something upstream ever
  // resolved a .ps1 again, planSpawn would hand it to spawn as-is (no rewrite),
  // which is exactly the silent-failure mode this fix exists to prevent by never
  // letting resolveSfCommand produce one in the first place.
  assert.deepStrictEqual(
    planSpawn('C:\\sf\\bin\\sf.ps1', ['org', 'list'], 'win32', {}, () => false),
    { command: 'C:\\sf\\bin\\sf.ps1', args: ['org', 'list'] }
  );
});

if (failed) { console.error(`sf-spawn: ${failed}/${ran} checks FAILED`); process.exit(1); }
console.log(`sf-spawn: all ${ran} checks passed`);
