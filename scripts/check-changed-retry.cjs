// Runnable contract test for mergeChangedKeys (metadataScanner.ts).
// No framework.   1) npm run compile   2) node scripts/check-changed-retry.cjs
//
// The function unions a failed deploy's own key set with the branch's changed
// components for the "Retry + changed vs branch" card button. Contract under
// test: retry keys lead unfiltered, changed keys join only when they name a
// component with local source (`deployableKeys`), everything is deduped in
// first-seen order, and an addition past `cap` flags `capped` (with `added`
// kept complete so the caller's refusal can state the real count). The security
// angle mirrors detectMissingDependencies: a key that never matched a scanned
// workspace item cannot enter the deploy set through the changed list.
const path = require('path');
const assert = require('assert');
const Module = require('module');
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? {} : origLoad(req, ...rest));

const { mergeChangedKeys } = require(path.join(__dirname, '..', 'out', 'metadataScanner.js'));

let failed = 0;
let ran = 0;
function check(name, fn) {
  ran++;
  try { fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}

// A representative deployable-workspace key set: the retried class, the fixture
// dependency pair a branch typically carries together, and assorted extras.
const DEPLOYABLE = new Set([
  'ApexClass:DepFixService',
  'ApexClass:DepFixHelper',
  'CustomObject:DepFixRule__mdt',
  'CustomField:Widget__c.Size__c',
  'LightningComponentBundle:acmeCard',
  'ApexClass:AcmeQueue'
]);

const CAP = 100;
const run = (retry, changed, deployable = DEPLOYABLE, cap = CAP) =>
  mergeChangedKeys(retry, changed, deployable, cap);

// ---------------------------------------------------------------- return shape
check('returns {keys, added, capped}', () => {
  const out = run([], []);
  assert.deepStrictEqual(out, { keys: [], added: [], capped: false });
});

check('no changed keys → retry keys pass through, nothing added', () => {
  const out = run(['ApexClass:DepFixService'], []);
  assert.deepStrictEqual(out, { keys: ['ApexClass:DepFixService'], added: [], capped: false });
});

// ----------------------------------------------------------------------- merge
check('a deployable changed key is appended after the retry keys', () => {
  const out = run(['ApexClass:DepFixService'], ['CustomObject:DepFixRule__mdt']);
  assert.deepStrictEqual(out.keys, ['ApexClass:DepFixService', 'CustomObject:DepFixRule__mdt']);
  assert.deepStrictEqual(out.added, ['CustomObject:DepFixRule__mdt']);
  assert.strictEqual(out.capped, false);
});

check('a changed key already in the retry set is not added again', () => {
  const out = run(
    ['ApexClass:DepFixService', 'CustomObject:DepFixRule__mdt'],
    ['CustomObject:DepFixRule__mdt', 'ApexClass:DepFixHelper']
  );
  assert.deepStrictEqual(out.keys, ['ApexClass:DepFixService', 'CustomObject:DepFixRule__mdt', 'ApexClass:DepFixHelper']);
  assert.deepStrictEqual(out.added, ['ApexClass:DepFixHelper'], 'only the genuinely new key counts as added');
});

check('every retry key survives even when the changed list is disjoint', () => {
  const out = run(['ApexClass:DepFixService', 'ApexClass:DepFixHelper'], ['LightningComponentBundle:acmeCard']);
  assert.deepStrictEqual(out.keys, ['ApexClass:DepFixService', 'ApexClass:DepFixHelper', 'LightningComponentBundle:acmeCard']);
});

// ---------------------------------------------------------------------- dedupe
check('duplicate retry keys collapse to one, keeping first-seen order', () => {
  const out = run(['ApexClass:DepFixService', 'ApexClass:DepFixHelper', 'ApexClass:DepFixService'], []);
  assert.deepStrictEqual(out.keys, ['ApexClass:DepFixService', 'ApexClass:DepFixHelper']);
});

check('duplicate changed keys collapse to one addition', () => {
  const out = run(['ApexClass:DepFixService'], ['ApexClass:DepFixHelper', 'ApexClass:DepFixHelper']);
  assert.deepStrictEqual(out.added, ['ApexClass:DepFixHelper']);
  assert.deepStrictEqual(out.keys, ['ApexClass:DepFixService', 'ApexClass:DepFixHelper']);
});

// ----------------------------------------------------------------------- order
check('order is retry keys first, then additions in changed-list order', () => {
  const out = run(
    ['ApexClass:DepFixHelper', 'ApexClass:DepFixService'],
    ['ApexClass:AcmeQueue', 'CustomField:Widget__c.Size__c', 'CustomObject:DepFixRule__mdt']
  );
  assert.deepStrictEqual(out.keys, [
    'ApexClass:DepFixHelper',
    'ApexClass:DepFixService',
    'ApexClass:AcmeQueue',
    'CustomField:Widget__c.Size__c',
    'CustomObject:DepFixRule__mdt'
  ]);
});

// --------------------------------------------------------- org-only exclusion
check('a changed key with no local source is excluded from keys AND added', () => {
  // e.g. an org-only component the Changed lens can still name — --metadata
  // can't deploy what has no local file.
  const out = run(['ApexClass:DepFixService'], ['ApexClass:OrgOnlyThing', 'ApexClass:DepFixHelper']);
  assert.deepStrictEqual(out.keys, ['ApexClass:DepFixService', 'ApexClass:DepFixHelper']);
  assert.deepStrictEqual(out.added, ['ApexClass:DepFixHelper']);
});

check('retry keys are NOT filtered through deployableKeys', () => {
  // They already passed one deploy's resolution — dropping one here would
  // silently shrink the retry. runDeploy re-resolves and re-splits anyway.
  const out = run(['ApexClass:NotScannedAnymore'], ['ApexClass:DepFixHelper']);
  assert.deepStrictEqual(out.keys, ['ApexClass:NotScannedAnymore', 'ApexClass:DepFixHelper']);
});

check('a changed list of only non-deployable keys adds nothing', () => {
  const out = run(['ApexClass:DepFixService'], ['ApexClass:Ghost', 'CustomObject:Phantom__c']);
  assert.deepStrictEqual(out.added, []);
  assert.deepStrictEqual(out.keys, ['ApexClass:DepFixService']);
  assert.strictEqual(out.capped, false);
});

check('an empty deployable set blocks every changed key', () => {
  const out = run(['ApexClass:DepFixService'], ['ApexClass:DepFixHelper'], new Set());
  assert.deepStrictEqual(out.added, []);
});

check('SECURITY: no changed-list string can enter keys without a deployable match', () => {
  // The changed list is derived from git paths, but the invariant must hold
  // regardless of what feeds it: only keys matching a scanned local item join.
  const hostile = ['ApexClass:../../etc/passwd', '--target-org evil', 'ApexClass:DepFixHelper'];
  const out = run(['ApexClass:DepFixService'], hostile);
  assert.deepStrictEqual(out.added, ['ApexClass:DepFixHelper'], 'only the real workspace item may join');
  for (const k of out.keys) {
    assert.ok(k === 'ApexClass:DepFixService' || DEPLOYABLE.has(k), `non-workspace key entered the deploy set: ${k}`);
  }
});

// ---------------------------------------------------------------- cap boundary
check('an addition of exactly cap is NOT capped', () => {
  const changed = [];
  const deployable = new Set();
  for (let i = 0; i < 3; i++) { changed.push(`ApexClass:AcmeGen${i}`); deployable.add(`ApexClass:AcmeGen${i}`); }
  const out = run(['ApexClass:DepFixService'], changed, deployable, 3);
  assert.strictEqual(out.capped, false);
  assert.strictEqual(out.added.length, 3);
});

check('an addition of cap+1 IS capped, and added stays complete for the count', () => {
  const changed = [];
  const deployable = new Set();
  for (let i = 0; i < 4; i++) { changed.push(`ApexClass:AcmeGen${i}`); deployable.add(`ApexClass:AcmeGen${i}`); }
  const out = run(['ApexClass:DepFixService'], changed, deployable, 3);
  assert.strictEqual(out.capped, true);
  assert.strictEqual(out.added.length, 4, 'added must not be truncated — the refusal states the real count');
});

check('retry keys never count against the cap', () => {
  const retry = [];
  for (let i = 0; i < 10; i++) retry.push(`ApexClass:AcmeRetry${i}`);
  const out = run(retry, ['ApexClass:DepFixHelper'], DEPLOYABLE, 3);
  assert.strictEqual(out.capped, false, 'only the ADDITION is capped');
});

check('excluded keys (dupes, non-deployable) never count against the cap', () => {
  const out = run(
    ['ApexClass:DepFixService'],
    ['ApexClass:DepFixService', 'ApexClass:Ghost', 'ApexClass:DepFixHelper'],
    DEPLOYABLE,
    1
  );
  assert.strictEqual(out.capped, false);
  assert.deepStrictEqual(out.added, ['ApexClass:DepFixHelper']);
});

check('cap 0 flags any addition at all', () => {
  const out = run(['ApexClass:DepFixService'], ['ApexClass:DepFixHelper'], DEPLOYABLE, 0);
  assert.strictEqual(out.capped, true);
  assert.deepStrictEqual(out.added, ['ApexClass:DepFixHelper']);
});

// ------------------------------------------------------------------ edge cases
check('empty retry set still merges the changed additions', () => {
  // The handler refuses an empty retry list before ever calling this — pure
  // function stays total anyway.
  const out = run([], ['ApexClass:DepFixHelper']);
  assert.deepStrictEqual(out.keys, ['ApexClass:DepFixHelper']);
  assert.deepStrictEqual(out.added, ['ApexClass:DepFixHelper']);
});

check('inputs are not mutated', () => {
  const retry = ['ApexClass:DepFixService'];
  const changed = ['ApexClass:DepFixHelper'];
  run(retry, changed);
  assert.deepStrictEqual(retry, ['ApexClass:DepFixService']);
  assert.deepStrictEqual(changed, ['ApexClass:DepFixHelper']);
});

if (failed) { console.error(`\n${failed} of ${ran} check(s) failed`); process.exit(1); }
console.log(`mergeChangedKeys: all ${ran} checks passed`);
