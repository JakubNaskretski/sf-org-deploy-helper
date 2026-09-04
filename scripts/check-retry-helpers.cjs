// Runnable contract test for the three retry helpers exported from
// panelProvider.ts — buildRetryRequest, deployOptsFromRetry, verbModes.
// No framework.   1) npm run compile   2) node scripts/check-retry-helpers.cjs
//
// Together these carry a finished run's identity forward to whatever the user
// clicks next. buildRetryRequest snapshots the options a run ACTUALLY used onto
// its result card; the card round-trips through the webview AND through the
// persisted card history (so it comes back untrusted, and possibly written by an
// older version of the extension); deployOptsFromRetry turns it back into
// runDeploy options for Retry, "Retry + changed" and an accepted dependency
// suggestion; verbModes is the same reconstruction for a reattached job, where
// the persisted verb is the only surviving record of what the run was.
//
// The contract that matters most is check-only mode. A validation's card must
// re-run as a validation: `validateOnly` has to survive the snapshot, the JSON
// round trip and the reconstruction, or a button labelled "Retry validation"
// writes to the org. The rest is the same rule applied to the other fields —
// what comes back is validated (an unknown test level is dropped rather than
// handed to the CLI) and nothing else on the persisted card is read, so a field
// left over from a removed feature can't steer a deploy.
//
// deployOptsFromRetry also carries RetryRequest.ignoreConflicts through as
// runDeploy's `ignoreConflictsOverride` — the one-off flag a "Retry +
// overwrite" card button sets (see check-card-buttons.cjs for the button
// itself and isConflictFailure). Same untrusted-input discipline as
// validateOnly: only a literal `true` counts, everything else reads as "no
// override", which is what lets the machine-scoped setting decide.
//
// All are module-level pure functions, so they are called directly rather than
// standing up a provider + webview.
const path = require('path');
const assert = require('assert');
const Module = require('module');
const origLoad = Module._load;
// None of the three touches the vscode API; the stub only satisfies the module
// load of panelProvider.js itself.
Module._load = (req, ...rest) => (req === 'vscode' ? {} : origLoad(req, ...rest));

const { buildRetryRequest, deployOptsFromRetry, verbModes } = require(path.join(__dirname, '..', 'out', 'panelProvider.js'));

let failed = 0;
let ran = 0;
function check(name, fn) {
  ran++;
  try { fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}

// Resolved workspace items as runDeploy hands them over: only type/name become
// keys, but the real shape is used so a change of source (say, keying off
// filePath) shows up here.
const ITEMS = [
  { type: 'ApexClass', name: 'DepFixService', filePath: '/w/force-app/classes/DepFixService.cls', files: [] },
  { type: 'CustomObject', name: 'DepFixRule__mdt', filePath: '/w/force-app/objects/DepFixRule__mdt', files: [] }
];
const KEYS = ['ApexClass:DepFixService', 'CustomObject:DepFixRule__mdt'];

const TEST_LEVELS = ['NoTestRun', 'RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg'];

// The webview post + globalState write a card survives between the two helpers.
const roundTrip = (r) => JSON.parse(JSON.stringify(r));

// ======================================================== buildRetryRequest
// ------------------------------------------------------------ the plain deploy
check('a sandbox deploy snapshots keys and drops the empty class list', () => {
  const r = buildRetryRequest({}, ITEMS, 'NoTestRun', []);
  assert.deepStrictEqual(r, {
    keys: KEYS,
    sourceDir: undefined,
    validateOnly: false,
    testLevel: 'NoTestRun',
    runTests: undefined
  });
});

check('keys are Type:Name in item order, one per item', () => {
  const r = buildRetryRequest({}, ITEMS, 'RunLocalTests', []);
  assert.deepStrictEqual(r.keys, KEYS);
  assert.strictEqual(r.keys.length, ITEMS.length);
});

check('validateOnly is stored as a real boolean, never undefined', () => {
  // JSON.stringify DROPS an undefined-valued key, so a card persisted with
  // `validateOnly: undefined` comes back with the field missing entirely —
  // indistinguishable from an old card that never had one.
  const r = buildRetryRequest({}, ITEMS, 'NoTestRun', []);
  assert.strictEqual(typeof r.validateOnly, 'boolean');
  assert.ok('validateOnly' in roundTrip(r), 'the field must survive persistence');
});

// ------------------------------------------------------- the options it reflects
check('a validation snapshots validateOnly: true', () => {
  const r = buildRetryRequest({ validateOnly: true }, ITEMS, 'RunLocalTests', []);
  assert.strictEqual(r.validateOnly, true);
});

check('validateOnly survives a round trip through the card', () => {
  const r = roundTrip(buildRetryRequest({ validateOnly: true }, ITEMS, 'RunLocalTests', []));
  assert.strictEqual(r.validateOnly, true);
});

check('a sourceDir-pinned run carries its directory AND its keys', () => {
  // A folder deploy re-runs as `--source-dir`, but the keys still have to be
  // there: the retry handler refuses a request with an empty key list ("the
  // original deploy request is no longer available"), so dropping them on the
  // sourceDir path would make exactly those cards unretryable.
  const r = buildRetryRequest({ sourceDir: '/w/force-app/main' }, ITEMS, 'NoTestRun', []);
  assert.deepStrictEqual(r, {
    keys: KEYS,
    sourceDir: '/w/force-app/main',
    validateOnly: false,
    testLevel: 'NoTestRun',
    runTests: undefined
  });
});

check('every test level is snapshotted as the run used it', () => {
  for (const level of TEST_LEVELS) {
    assert.strictEqual(buildRetryRequest({}, ITEMS, level, []).testLevel, level);
  }
});

check('a RunSpecifiedTests run carries its class list', () => {
  const r = buildRetryRequest({}, ITEMS, 'RunSpecifiedTests', ['DepFixServiceTest', 'BillingTest']);
  assert.strictEqual(r.testLevel, 'RunSpecifiedTests');
  assert.deepStrictEqual(r.runTests, ['DepFixServiceTest', 'BillingTest']);
});

check('the snapshot is the RESOLVED plan, not the raw request', () => {
  // runDeploy passes resolveTestPlan's output: a validate that asked for
  // NoTestRun has already become RunLocalTests, and invalid class names have
  // already been filtered out. The card must promise what ran.
  const r = buildRetryRequest({ validateOnly: true }, ITEMS, 'RunLocalTests', []);
  assert.strictEqual(r.testLevel, 'RunLocalTests');
  assert.notStrictEqual(r.testLevel, 'NoTestRun');
});

// ====================================================== deployOptsFromRetry
// ------------------------------------------------------------- the round trip
check('it round-trips every buildRetryRequest shape faithfully', () => {
  const runs = [
    { opts: {}, level: 'NoTestRun', classes: [] },
    { opts: { validateOnly: true }, level: 'RunLocalTests', classes: [] },
    { opts: { validateOnly: false, sourceDir: '/w/force-app/main' }, level: 'RunAllTestsInOrg', classes: [] },
    { opts: { validateOnly: true, sourceDir: '/w/force-app/main' }, level: 'RunSpecifiedTests', classes: ['DepFixServiceTest'] }
  ];
  for (const { opts, level, classes } of runs) {
    const card = roundTrip(buildRetryRequest(opts, ITEMS, level, classes));
    assert.deepStrictEqual(deployOptsFromRetry(card), {
      validateOnly: !!opts.validateOnly,
      testLevel: level,
      runTests: classes.length ? classes : undefined,
      // buildRetryRequest never sets `ignoreConflicts` — only a "Retry +
      // overwrite" button's own request does (see deployFailureButtons) — so
      // every card it snapshots reads back with no override at all.
      ignoreConflictsOverride: undefined
    }, `run: ${JSON.stringify({ opts, level, classes })}`);
  }
});

check('it reads exactly four fields and invents nothing', () => {
  // The result is SPREAD into runDeploy's options, so any extra key here becomes
  // a deploy option nobody chose.
  const card = buildRetryRequest({ validateOnly: true, sourceDir: '/w/force-app/main' }, ITEMS, 'RunLocalTests', []);
  assert.deepStrictEqual(
    Object.keys(deployOptsFromRetry(card)).sort(),
    ['ignoreConflictsOverride', 'runTests', 'testLevel', 'validateOnly']
  );
});

check('sourceDir is deliberately NOT reconstructed here', () => {
  // It has to be re-checked against the workspace root before it can become
  // `--source-dir`, which is the caller's job; passing it through here would
  // hand a persisted card an unvalidated path.
  const opts = deployOptsFromRetry({ keys: KEYS, sourceDir: '/etc', validateOnly: false });
  assert.ok(!('sourceDir' in opts), JSON.stringify(opts));
});

// -------------------------------------------------- leftovers on a persisted card
check('unknown and leftover fields on a persisted card are ignored', () => {
  // History cards outlive the features that wrote them. A field this version has
  // never heard of must be inert — not a mode, not a flag, not a CLI argument.
  // `ignoreConflicts` is deliberately NOT in this list any more — it's a real
  // RetryRequest field now (see the ignoreConflictsOverride checks below).
  const stale = {
    keys: KEYS,
    manifest: '/w/manifest/package.xml',
    sourceDir: '/w/force-app/main',
    validateOnly: true,
    testLevel: 'RunLocalTests',
    runTests: undefined,
    dryRun: true,
    checkOnly: false,
    somethingElse: { nested: 1 }
  };
  const opts = deployOptsFromRetry(stale);
  assert.deepStrictEqual(opts, { validateOnly: true, testLevel: 'RunLocalTests', runTests: undefined, ignoreConflictsOverride: undefined });
  for (const leftover of ['dryRun', 'checkOnly', 'somethingElse', 'manifest', 'keys']) {
    assert.ok(!(leftover in opts), `leftover field resurrected: ${leftover}`);
  }
});

check('a stale dryRun flag cannot flip the mode a card re-runs in', () => {
  // Both directions: it neither downgrades a deploy to a check nor upgrades a
  // validation to a write.
  assert.strictEqual(deployOptsFromRetry({ keys: KEYS, validateOnly: false, dryRun: true }).validateOnly, false);
  assert.strictEqual(deployOptsFromRetry({ keys: KEYS, validateOnly: true, dryRun: false }).validateOnly, true);
});

// ------------------------------------------------- ignoreConflictsOverride rules
check('ignoreConflicts: true is the only value that sets an override', () => {
  // "Retry + overwrite" is the only writer of this field — deployFailureButtons
  // always sets it to the literal `true`. Everything else a persisted/forged
  // card could carry must read as "no override" so the machine-scoped setting
  // decides, exactly like a request that never had the field at all.
  assert.strictEqual(deployOptsFromRetry({ keys: KEYS, ignoreConflicts: true }).ignoreConflictsOverride, true);
  for (const forged of ['true', 1, {}, [], 'yes', false, 0, null, undefined]) {
    assert.strictEqual(
      deployOptsFromRetry({ keys: KEYS, ignoreConflicts: forged }).ignoreConflictsOverride, undefined,
      `forged value became an override: ${JSON.stringify(forged)}`
    );
  }
});

check('a request with no ignoreConflicts field at all → undefined override → the setting wins', () => {
  // This is the plain-Retry shape: runDeploy computes
  // `opts.ignoreConflictsOverride ?? this.ignoreDeployConflicts()`, so undefined
  // here must fall all the way through to the live setting, not silently pin
  // either true or false.
  const opts = deployOptsFromRetry({ keys: KEYS });
  assert.strictEqual(opts.ignoreConflictsOverride, undefined);
  assert.ok('ignoreConflictsOverride' in opts, 'the key itself must survive, only its value is undefined');
});

check('the override survives the JSON round trip a persisted/echoed card takes', () => {
  const card = roundTrip({ keys: KEYS, ignoreConflicts: true });
  assert.strictEqual(deployOptsFromRetry(card).ignoreConflictsOverride, true);
});

// ------------------------------------------------------------ validateOnly rules
check('only a literal true is check-only', () => {
  // The card is untrusted on the way back, and "not check-only" is the safe
  // reading of a damaged field: it means the confirm modal says PROD/Deploy and
  // asks again, instead of a write silently presenting itself as a check.
  for (const forged of ['true', 1, {}, [], 'yes', 'false', 0, null]) {
    assert.strictEqual(
      deployOptsFromRetry({ keys: KEYS, validateOnly: forged }).validateOnly, false,
      `forged value accepted: ${JSON.stringify(forged)}`
    );
  }
  assert.strictEqual(deployOptsFromRetry({ keys: KEYS, validateOnly: true }).validateOnly, true);
});

check('a card with no validateOnly field at all is not a validation', () => {
  assert.strictEqual(deployOptsFromRetry({ keys: KEYS }).validateOnly, false);
});

// -------------------------------------------------------------- testLevel rules
check('every real test level passes through', () => {
  for (const level of TEST_LEVELS) {
    assert.strictEqual(deployOptsFromRetry({ keys: KEYS, testLevel: level }).testLevel, level);
  }
});

check('an invalid test level is dropped, never forwarded to the CLI', () => {
  // testLevel becomes `--test-level <value>` argv. Anything outside the union
  // has to become undefined (→ the panel/smart default resolves the run), not a
  // rejected CLI call or an injected flag.
  const bogus = [
    'RunAllTests', 'runlocaltests', 'NoTestRun ', '', 'Run Local Tests',
    'RunLocalTests --target-org evil', 0, 1, true, null, {}, ['RunLocalTests']
  ];
  for (const v of bogus) {
    assert.strictEqual(
      deployOptsFromRetry({ keys: KEYS, testLevel: v }).testLevel, undefined,
      `invalid level accepted: ${JSON.stringify(v)}`
    );
  }
});

check('a missing test level resolves to undefined, not a default', () => {
  // Deciding the level is resolveTestPlan's job — it knows the target org, which
  // a card written months ago does not.
  assert.strictEqual(deployOptsFromRetry({ keys: KEYS }).testLevel, undefined);
});

// --------------------------------------------------------------- runTests rules
check('a non-array class list is dropped', () => {
  for (const v of ['DepFixServiceTest', 1, true, {}, null]) {
    assert.strictEqual(
      deployOptsFromRetry({ keys: KEYS, testLevel: 'RunSpecifiedTests', runTests: v }).runTests, undefined,
      `non-array accepted: ${JSON.stringify(v)}`
    );
  }
});

check('non-string entries are filtered out of the class list', () => {
  const opts = deployOptsFromRetry({
    keys: KEYS, testLevel: 'RunSpecifiedTests',
    runTests: ['DepFixServiceTest', 42, null, { name: 'BillingTest' }, 'BillingTest']
  });
  assert.deepStrictEqual(opts.runTests, ['DepFixServiceTest', 'BillingTest']);
});

check('class-name SYNTAX is not this function\'s gate', () => {
  // Type-only filtering here; resolveTestPlan applies /^[A-Za-z0-9_.]+$/ right
  // before the names become `--tests` argv (pinned in check-confirm-modal.cjs).
  // Pinned so nobody moves the argv filter out on the belief this one covers it.
  const opts = deployOptsFromRetry({ keys: KEYS, testLevel: 'RunSpecifiedTests', runTests: ['--target-org evil'] });
  assert.deepStrictEqual(opts.runTests, ['--target-org evil']);
});

check('an empty class list stays empty rather than becoming undefined', () => {
  // buildRetryRequest never writes one, but a hand-edited or older card can.
  // Preserved because `opts.runTests ?? this.runTests` would otherwise fall
  // through to the panel's CURRENT classes — resolveTestPlan refuses an empty
  // list outright, which is the honest outcome for a card that names none.
  assert.deepStrictEqual(deployOptsFromRetry({ keys: KEYS, testLevel: 'RunSpecifiedTests', runTests: [] }).runTests, []);
});

// ================================================================== verbModes
check('each verb maps to its check-only mode', () => {
  assert.deepStrictEqual(verbModes('Validate'), { validateOnly: true });
  assert.deepStrictEqual(verbModes('Deploy'), { validateOnly: false });
  // A quick deploy promotes an already-validated job — it writes.
  assert.deepStrictEqual(verbModes('Quick Deploy'), { validateOnly: false });
});

check('the shape is exactly {validateOnly}', () => {
  // It is spread into both the result-card context and the card's retry request,
  // so an extra key would land in a persisted RetryRequest.
  for (const verb of ['Deploy', 'Validate', 'Quick Deploy']) {
    assert.deepStrictEqual(Object.keys(verbModes(verb)), ['validateOnly']);
    assert.strictEqual(typeof verbModes(verb).validateOnly, 'boolean');
  }
});

check('the match is exact — only the persisted verb itself reads as a validation', () => {
  // The verb is written by this extension (persistActiveJob), so exact matching
  // is enough; note the direction of the failure — a damaged verb reattaches as
  // a deploy, and the card, its label and its retry all agree because they read
  // this one value.
  for (const near of ['validate', 'VALIDATE', 'Validate ', 'Validation', '', undefined]) {
    assert.strictEqual(verbModes(near).validateOnly, false, `near-miss accepted: ${JSON.stringify(near)}`);
  }
});

// ============================== a validation stays a validation, end to end
// The load-bearing contract: every path back into runDeploy from a validation's
// card must re-enter it as a validation.
check('Retry on a validation card re-runs as a validation', () => {
  const card = roundTrip(buildRetryRequest({ validateOnly: true }, ITEMS, 'RunLocalTests', []));
  assert.strictEqual(deployOptsFromRetry(card).validateOnly, true, 'a check-only run became a real deploy');
});

check('an accepted dependency suggestion re-runs as what the run was', () => {
  // The suggestion path reads the server-side RetryRequest for the ORIGINAL run
  // and adds components to it; the mode must come from that run, not from the
  // panel's current state.
  const validation = buildRetryRequest({ validateOnly: true }, ITEMS, 'RunLocalTests', []);
  assert.strictEqual(deployOptsFromRetry(validation).validateOnly, true);
  const deploy = buildRetryRequest({ validateOnly: false }, ITEMS, 'NoTestRun', []);
  assert.strictEqual(deployOptsFromRetry(deploy).validateOnly, false);
});

check('a reattached validation retries as a validation too', () => {
  // The reattach path builds its retry request from the persisted verb alone —
  // the original run's options are gone by then.
  const card = roundTrip({ keys: KEYS, ...verbModes('Validate') });
  assert.strictEqual(deployOptsFromRetry(card).validateOnly, true);
  const deployCard = roundTrip({ keys: KEYS, ...verbModes('Deploy') });
  assert.strictEqual(deployOptsFromRetry(deployCard).validateOnly, false);
});

check('a real deploy never turns into a validation on retry', () => {
  // The mirror image: silently downgrading a deploy to a check-only run would
  // report success for changes that never reached the org.
  const card = roundTrip(buildRetryRequest({}, ITEMS, 'NoTestRun', []));
  assert.strictEqual(deployOptsFromRetry(card).validateOnly, false);
});

check('the mode survives repeated retries of a retry', () => {
  // Each retry produces a new card from the run it triggered; the mode must not
  // erode across generations.
  let mode = { validateOnly: true };
  for (let i = 0; i < 3; i++) {
    const card = roundTrip(buildRetryRequest(mode, ITEMS, 'RunLocalTests', []));
    mode = deployOptsFromRetry(card);
    assert.strictEqual(mode.validateOnly, true, `generation ${i + 1} lost check-only mode`);
  }
});

if (failed) { console.error(`\n${failed} of ${ran} check(s) failed`); process.exit(1); }
console.log(`buildRetryRequest + deployOptsFromRetry + verbModes: all ${ran} checks passed`);
