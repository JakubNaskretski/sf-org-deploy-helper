// Runnable contract test for detectMissingDependencies (metadataScanner.ts).
// No framework.   1) npm run compile   2) node scripts/check-missing-deps.cjs
//
// The function turns org-reported deploy failures into (a) `keys` that are safe
// `--metadata Type:Name` targets and (b) `unresolved` display text for referents
// the workspace doesn't contain. The security invariant under test throughout:
// org-controlled error text can NEVER mint a key for a component that isn't
// really in this workspace's scan.
const path = require('path');
const assert = require('assert');
const Module = require('module');
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? {} : origLoad(req, ...rest));

const { detectMissingDependencies } = require(path.join(__dirname, '..', 'out', 'metadataScanner.js'));
const p = (...s) => s.join(path.sep);

let failed = 0;
let ran = 0;
function check(name, fn) {
  ran++;
  try { fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}

const item = (type, name, file) => ({ type, name, filePath: p('ws', file), files: [] });

// A representative workspace: Apex, a custom metadata type, custom objects with
// decomposed fields (including a DELIBERATE same-field-name-on-two-objects
// collision), and a QuickAction.
const ITEMS = [
  item('ApexClass', 'MyThing', 'classes/MyThing.cls'),
  item('ApexClass', 'MyHelper', 'classes/MyHelper.cls'),
  item('ApexClass', 'Outer', 'classes/Outer.cls'),
  item('CustomObject', 'smth__mdt', 'objects/smth__mdt'),
  item('CustomObject', 'Widget__c', 'objects/Widget__c'),
  item('CustomField', 'Account.Status__c', 'objects/Account/fields/Status__c.field-meta.xml'),
  item('CustomField', 'Case.Status__c', 'objects/Case/fields/Status__c.field-meta.xml'),
  item('CustomField', 'Widget__c.Size__c', 'objects/Widget__c/fields/Size__c.field-meta.xml'),
  item('QuickAction', 'Account.Foo', 'quickActions/Account.Foo.quickAction-meta.xml'),
  // Decoys: an ApexClass whose NAME carries an sObject suffix. Without these, a []
  // result for 'Invalid type: Ghost__c' proves nothing — it could just be absence.
  item('ApexClass', 'Decoy__c', 'classes/Decoy__c.cls'),
  item('CustomObject', 'Plain', 'objects/Plain'),
  // 5-way collision, for the ambiguity rendering + cap interaction.
  item('CustomField', 'Account.Shared__c', 'objects/Account/fields/Shared__c.field-meta.xml'),
  item('CustomField', 'Case.Shared__c', 'objects/Case/fields/Shared__c.field-meta.xml'),
  item('CustomField', 'Lead.Shared__c', 'objects/Lead/fields/Shared__c.field-meta.xml'),
  item('CustomField', 'Widget__c.Shared__c', 'objects/Widget__c/fields/Shared__c.field-meta.xml'),
  item('CustomField', 'Contact.Shared__c', 'objects/Contact/fields/Shared__c.field-meta.xml')
];

const run = (problems, deployed = []) =>
  detectMissingDependencies(Array.isArray(problems) ? problems : [problems], ITEMS, new Set(deployed));

// ---------------------------------------------------------------- return shape
check('returns {keys, unresolved} with both arrays', () => {
  const out = run([]);
  assert.deepStrictEqual(out, { keys: [], unresolved: [] });
});

check('empty and undefined problem strings are skipped, never crash', () => {
  assert.deepStrictEqual(run(['', undefined, null]), { keys: [], unresolved: [] });
});

// ------------------------------------------------- pattern 1: "no X named Y found"
check('QuickAction dependency resolves when the item exists locally', () => {
  const out = run('In field: action - no QuickAction named Account.Foo found');
  assert.deepStrictEqual(out.keys, ['QuickAction:Account.Foo']);
  assert.deepStrictEqual(out.unresolved, []);
});

check('case-insensitive name fallback returns the ITEM canonical casing', () => {
  assert.deepStrictEqual(run('no QuickAction named account.foo found').keys, ['QuickAction:Account.Foo']);
});

check('unknown type/name is reported as unresolved, never minted as a key', () => {
  const out = run('no BogusType named Nothing.Here found');
  assert.deepStrictEqual(out.keys, []);
  assert.deepStrictEqual(out.unresolved, ['BogusType:Nothing.Here']);
});

// ------------------------------------- pattern 2: dependent class recompilation
check('recompilation names the class AND the inner Invalid type is picked up', () => {
  // Both matter: recompiling MyHelper against the local copy is the fix when the
  // org's copy is stale, but smth__mdt is the component that is actually absent.
  const out = run('Dependent class is invalid and needs recompilation: Class MyHelper: Invalid type: smth__mdt');
  assert.deepStrictEqual(out.keys, ['ApexClass:MyHelper', 'CustomObject:smth__mdt']);
});

check('namespaced recompilation class resolves to nothing but is surfaced', () => {
  const out = run('Dependent class is invalid and needs recompilation: Class ns__Remote: x');
  assert.deepStrictEqual(out.keys, []);
  assert.ok(out.unresolved.includes('ApexClass:ns__Remote'), JSON.stringify(out.unresolved));
});

// ------------------------------------------- pattern 3/4: typed field failures
check("No such column resolves to CustomField with its parent entity", () => {
  assert.deepStrictEqual(run("No such column 'Status__c' on entity 'Account'").keys, ['CustomField:Account.Status__c']);
});

check('Invalid field ... for SObject resolves to CustomField', () => {
  assert.deepStrictEqual(run('Invalid field Size__c for SObject Widget__c').keys, ['CustomField:Widget__c.Size__c']);
});

check('typed field failure on an unknown object is unresolved, not guessed', () => {
  const out = run("No such column 'Status__c' on entity 'Opportunity'");
  assert.deepStrictEqual(out.keys, []);
  assert.deepStrictEqual(out.unresolved, ['Opportunity.Status__c']);
});

// ------------------------------------------------- pattern 5: "Invalid type: X"
check('THE REPORTED CASE — Invalid type: smth__mdt resolves to the CustomObject', () => {
  assert.deepStrictEqual(run('Invalid type: smth__mdt').keys, ['CustomObject:smth__mdt']);
});

check('every sObject suffix routes to CustomObject', () => {
  for (const n of ['smth__mdt', 'Widget__c']) {
    assert.deepStrictEqual(run(`Invalid type: ${n}`).keys, [`CustomObject:${n}`], n);
  }
  // Suffixes with no local item must not fall through to an ApexClass guess.
  for (const n of ['Ghost__e', 'Ghost__b', 'Ghost__x', 'Ghost__c']) {
    assert.deepStrictEqual(run(`Invalid type: ${n}`).keys, [], n);
  }
});

check('a bare non-sObject name routes to ApexClass', () => {
  assert.deepStrictEqual(run('Invalid type: MyHelper').keys, ['ApexClass:MyHelper']);
});

check('dotted inner-class reference deploys the OUTER class', () => {
  assert.deepStrictEqual(run('Invalid type: Outer.Inner').keys, ['ApexClass:Outer']);
});

check('sObject-qualified dotted type resolves via its head', () => {
  assert.deepStrictEqual(run('Invalid type: Widget__c.Size__c').keys, ['CustomObject:Widget__c']);
});

check('unknown Invalid type is surfaced as unresolved', () => {
  const out = run('Invalid type: Ghost__mdt');
  assert.deepStrictEqual(out.keys, []);
  assert.deepStrictEqual(out.unresolved, ['Ghost__mdt']);
});

// ----------------------------------------------- pattern 6: method signature
check('Method does not exist ... from the type X resolves X', () => {
  assert.deepStrictEqual(
    run('Method does not exist or incorrect signature: void doIt() from the type MyHelper').keys,
    ['ApexClass:MyHelper']
  );
});

// ------------------------------------------- pattern 7: "Variable does not exist"
check('unique bare field name resolves', () => {
  assert.deepStrictEqual(run('Variable does not exist: Size__c').keys, ['CustomField:Widget__c.Size__c']);
});

check('AMBIGUOUS bare name is NEVER guessed — both candidates are named', () => {
  const out = run('Variable does not exist: Status__c');
  assert.deepStrictEqual(out.keys, [], 'must not pick one of two objects');
  assert.strictEqual(out.unresolved.length, 1);
  assert.ok(out.unresolved[0].includes('ambiguous'), out.unresolved[0]);
  assert.ok(out.unresolved[0].includes('Account.Status__c'), out.unresolved[0]);
  assert.ok(out.unresolved[0].includes('Case.Status__c'), out.unresolved[0]);
});

check('bare name matching a class resolves to that ApexClass', () => {
  assert.deepStrictEqual(run('Variable does not exist: MyHelper').keys, ['ApexClass:MyHelper']);
});

check('ambiguity collapses to unique once the other candidate is already deploying', () => {
  // Account.Status__c is in this deploy already, so Case.Status__c is the only
  // remaining candidate — no longer ambiguous.
  const out = run('Variable does not exist: Status__c', ['CustomField:Account.Status__c']);
  assert.deepStrictEqual(out.keys, ['CustomField:Case.Status__c']);
  assert.deepStrictEqual(out.unresolved, []);
});

check('unknown bare name is unresolved', () => {
  assert.deepStrictEqual(run('Variable does not exist: nope__c').unresolved, ['nope__c']);
});

// --------------------------------------------------------- exclusion / dedupe
check('a key already in THIS deploy is excluded from both lists', () => {
  const out = run('Invalid type: smth__mdt', ['CustomObject:smth__mdt']);
  assert.deepStrictEqual(out.keys, []);
  assert.deepStrictEqual(out.unresolved, [], 'already-deploying is not "missing", nor unresolved');
});

check('dedupes keys and preserves first-seen order', () => {
  const out = run([
    'Invalid type: smth__mdt',
    'Invalid type: MyHelper',
    'Invalid type: smth__mdt'
  ]);
  assert.deepStrictEqual(out.keys, ['CustomObject:smth__mdt', 'ApexClass:MyHelper']);
});

check('dedupes unresolved text too', () => {
  const out = run(['Invalid type: Ghost__mdt', 'Invalid type: Ghost__mdt']);
  assert.deepStrictEqual(out.unresolved, ['Ghost__mdt']);
});

check('multiple failures across several problem strings all contribute', () => {
  const out = run([
    "No such column 'Size__c' on entity 'Widget__c'",
    'Invalid type: smth__mdt',
    'no QuickAction named Account.Foo found'
  ]);
  assert.deepStrictEqual(out.keys, [
    'CustomField:Widget__c.Size__c',
    'CustomObject:smth__mdt',
    'QuickAction:Account.Foo'
  ]);
});

// ------------------------------------------------------------------- hardening
check('unresolved list is capped', () => {
  const out = run(Array.from({ length: 20 }, (_, i) => `Invalid type: Ghost${i}__mdt`));
  assert.ok(out.unresolved.length <= 5, `expected <=5, got ${out.unresolved.length}`);
});

check('unresolved entries are length-capped', () => {
  const out = run(`Invalid type: ${'A'.repeat(300)}__mdt`);
  assert.strictEqual(out.unresolved.length, 1);
  assert.ok(out.unresolved[0].length <= 100, `len ${out.unresolved[0].length}`);
});

// NOTE: there is deliberately no "control characters are stripped" case here.
// Every capture group is charset-restricted ([A-Za-z0-9_.] and friends), so no
// pattern can emit a control character and such a test could never fail.
// sanitizeUnresolved keeps the strip as defence-in-depth for future patterns.

check('a hostile problem string cannot mint a key for a non-existent component', () => {
  const out = run([
    'Invalid type: ../../etc/passwd',
    'no ApexClass named ImaginaryClass found',
    'Variable does not exist: totally_made_up'
  ]);
  assert.deepStrictEqual(out.keys, [], 'nothing local matched, so nothing may be deployed');
});

check('every returned key corresponds to a real local item', () => {
  const real = new Set(ITEMS.map(i => `${i.type}:${i.name}`));
  const out = run([
    'Invalid type: smth__mdt',
    "No such column 'Size__c' on entity 'Widget__c'",
    'Dependent class is invalid and needs recompilation: Class MyHelper: Invalid type: Widget__c',
    'Method does not exist or incorrect signature: void x() from the type Outer'
  ]);
  for (const k of out.keys) assert.ok(real.has(k), `minted a key with no local item: ${k}`);
  assert.ok(out.keys.length > 0, 'sanity: this input should resolve something');
});

check('an empty workspace resolves nothing but still reports what was referenced', () => {
  const out = detectMissingDependencies(['Invalid type: smth__mdt'], [], new Set());
  assert.deepStrictEqual(out.keys, []);
  assert.deepStrictEqual(out.unresolved, ['smth__mdt']);
});

// ------------------------------------------------------- realistic transcripts
check('realistic multi-error Apex compile failure', () => {
  const out = run([
    'Invalid type: smth__mdt',
    'Variable does not exist: Size__c',
    'Dependent class is invalid and needs recompilation: Class MyHelper: Invalid type: smth__mdt'
  ], ['ApexClass:MyThing']);
  assert.deepStrictEqual(out.keys, [
    'CustomObject:smth__mdt',
    'CustomField:Widget__c.Size__c',
    'ApexClass:MyHelper'
  ]);
  assert.deepStrictEqual(out.unresolved, []);
});


// ================================================ robustness and noise control
// Cases pinning the behaviour that real org messages exposed: platform types must
// never be reported as missing, and the real message wordings must actually match.

// --- the TYPE token must match, not just the name -------------------------
check('a real local NAME under the WRONG type is never minted', () => {
  const out = run('no Layout named MyHelper found');
  assert.deepStrictEqual(out.keys, [], 'MyHelper exists, but as an ApexClass, not a Layout');
  assert.deepStrictEqual(out.unresolved, ['Layout:MyHelper']);
});

check('a field failure on an entity that is an ApexClass never escalates to the class', () => {
  assert.deepStrictEqual(run("No such column 'Status__c' on entity 'MyHelper'").keys, []);
});

check('an unknown field on a KNOWN local object never escalates to the parent object', () => {
  const out = run("No such column 'Ghost__c' on entity 'Widget__c'");
  assert.deepStrictEqual(out.keys, [], 'must not fall back to CustomObject:Widget__c');
  assert.deepStrictEqual(out.unresolved, ['Widget__c.Ghost__c']);
});

// --- namespaces must never collapse onto a local component ----------------
check('a namespaced referent never collapses onto the local unnamespaced component', () => {
  const out = run('Invalid type: acme__Widget__c');
  assert.deepStrictEqual(out.keys, [], 'acme__Widget__c is a managed package type, not our Widget__c');
  assert.deepStrictEqual(out.unresolved, ['acme__Widget__c']);
});

// --- the sObject-suffix rule is attributable, not incidental --------------
check('an sObject suffix does NOT fall through to a same-named ApexClass', () => {
  // Decoy__c exists locally as an ApexClass. The suffix rule must route to
  // CustomObject only, so this resolves to nothing rather than the class.
  const out = run('Invalid type: Decoy__c');
  assert.deepStrictEqual(out.keys, [], 'suffix rule must not fall through to ApexClass');
  assert.deepStrictEqual(out.unresolved, ['Decoy__c']);
});

check('a suffix-less name does NOT fall through to a same-named CustomObject', () => {
  const out = run('Invalid type: Plain');
  assert.deepStrictEqual(out.keys, [], 'bare names route to ApexClass only');
});

check('mixed-case sObject suffixes resolve (pins the /i flag and ITEM casing)', () => {
  for (const n of ['smth__mdt', 'SMTH__MDT', 'smth__MDT', 'sMtH__Mdt']) {
    assert.deepStrictEqual(run(`Invalid type: ${n}`).keys, ['CustomObject:smth__mdt'], n);
  }
});

// --- platform types must never be reported as missing components ----------
check('Apex built-ins are never reported as missing', () => {
  const out = run([
    'Method does not exist or incorrect signature: void x() from the type String',
    'Method does not exist or incorrect signature: void x() from the type Database',
    'Invalid type: Blob',
    'Variable does not exist: Id'
  ]);
  assert.deepStrictEqual(out.keys, []);
  assert.deepStrictEqual(out.unresolved, [], 'you cannot retrieve String from an org');
});

check('platform namespaces are never reported as missing', () => {
  const out = run(['Invalid type: System.JSONParser', 'Invalid type: Schema.SObjectType']);
  assert.deepStrictEqual(out.unresolved, []);
});

check('standard objects and standard fields are never reported as missing', () => {
  const out = run([
    'Method does not exist or incorrect signature: void x() from the type Account',
    'Variable does not exist: Name'
  ]);
  assert.deepStrictEqual(out.unresolved, []);
});

check('platform noise never crowds out the one real custom referent', () => {
  // The whole point: the cap is 5, and before the denylist these six platform
  // names consumed every slot and hid smth__mdt.
  const out = run([
    'Method does not exist or incorrect signature: void a() from the type List<String>',
    'Method does not exist or incorrect signature: void b() from the type Map<String,String>',
    'Method does not exist or incorrect signature: void c() from the type String',
    'Method does not exist or incorrect signature: void d() from the type Database',
    'Invalid type: System.JSONParser',
    'Invalid type: Schema.SObjectType',
    'Invalid type: Ghost__mdt'
  ]);
  assert.deepStrictEqual(out.unresolved, ['Ghost__mdt'], JSON.stringify(out.unresolved));
});

// --- generics ------------------------------------------------------------
check('a collection wrapper does not hide the custom type inside it', () => {
  assert.deepStrictEqual(
    run('Method does not exist or incorrect signature: void x() from the type List<smth__mdt>').keys,
    ['CustomObject:smth__mdt']
  );
});

check('a two-arg generic contributes both type arguments', () => {
  const out = run('Invalid type: Map<Id, Widget__c>');
  assert.deepStrictEqual(out.keys, ['CustomObject:Widget__c'], 'Id is a built-in, Widget__c is ours');
});

// --- real-message robustness ---------------------------------------------
check('a trailing period does not corrupt the entity capture', () => {
  // The unquoted phrasing used to capture "Widget__c." and emit "Widget__c..Size__c".
  assert.deepStrictEqual(run('Invalid field Size__c for SObject Widget__c.').keys, ['CustomField:Widget__c.Size__c']);
  assert.deepStrictEqual(
    run('Invalid field Size__c for SObject Widget__c. Please check the field name.').keys,
    ['CustomField:Widget__c.Size__c']
  );
});

check('the CLI-rendered form with a line/column suffix still matches', () => {
  assert.deepStrictEqual(run('Error MyThing Invalid type: smth__mdt (Line: 12, Column: 5)').keys, ['CustomObject:smth__mdt']);
});

check('a CRLF terminator does not break matching', () => {
  assert.deepStrictEqual(run('Invalid type: smth__mdt\r\n').keys, ['CustomObject:smth__mdt']);
});

// --- bare-name edge cases ------------------------------------------------
check('a bare name whose ONLY matches are already deploying is not reported missing', () => {
  const out = run('Variable does not exist: Size__c', ['CustomField:Widget__c.Size__c']);
  assert.deepStrictEqual(out.keys, []);
  assert.deepStrictEqual(out.unresolved, [], 'it IS in the workspace — it is already in this deploy');
});

check('a 5-way ambiguity renders without truncating mid-identifier', () => {
  const out = run('Variable does not exist: Shared__c');
  assert.deepStrictEqual(out.keys, [], 'five candidates must never be guessed between');
  assert.strictEqual(out.unresolved.length, 1);
  const line = out.unresolved[0];
  assert.ok(line.includes('+3 more'), line);
  assert.ok(!line.endsWith('…'), `truncated mid-identifier: ${line}`);
  assert.ok(line.length <= 100, `len ${line.length}`);
});

// --- cap precision -------------------------------------------------------
check('the unresolved cap never suppresses a resolvable key', () => {
  const problems = [];
  for (let i = 0; i < 6; i++) problems.push(`Invalid type: G${i}__mdt`);
  problems.push('Invalid type: smth__mdt');
  const out = run(problems);
  assert.deepStrictEqual(out.keys, ['CustomObject:smth__mdt'], 'a full unresolved list must not stop key resolution');
  assert.strictEqual(out.unresolved.length, 5);
});

check('the cap is exact and preserves first-seen order', () => {
  const out = run(['Invalid type: G0__mdt', 'Invalid type: G1__mdt', 'Invalid type: G2__mdt',
    'Invalid type: G3__mdt', 'Invalid type: G4__mdt', 'Invalid type: G5__mdt']);
  assert.deepStrictEqual(out.unresolved, ['G0__mdt', 'G1__mdt', 'G2__mdt', 'G3__mdt', 'G4__mdt']);
});

// --- performance guard ---------------------------------------------------
check('a failure naming many bare names stays fast on a large workspace', () => {
  // Regression guard for the O(candidates x items) scan that measured 32s.
  const big = ITEMS.slice();
  for (let i = 0; i < 20000; i++) big.push(item('CustomField', `Obj${i}__c.F${i}__c`, `objects/Obj${i}__c/fields/F${i}__c.field-meta.xml`));
  const problems = [];
  for (let i = 0; i < 200; i++) problems.push(`Variable does not exist: Nope${i}__c`);
  const t0 = Date.now();
  detectMissingDependencies(problems, big, new Set());
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `took ${ms}ms — the bare-name lookup regressed to a per-candidate scan`);
});

// ==================================================== org-verified real strings
// Captured verbatim from `sf project deploy start --json` (CLI 2.137) against a
// real org, 2026-07. These pin the EXACT wording the platform emits so the
// patterns can never drift from reality without a test failing.

check('ORG-VERIFIED: Invalid type for a missing __mdt', () => {
  const items2 = [item('CustomObject', 'DepProbeType__mdt', 'objects/DepProbeType__mdt')];
  const out = detectMissingDependencies(
    ['Invalid type: DepProbeType__mdt'], items2, new Set(['ApexClass:DepProbeMissingMdt']));
  assert.deepStrictEqual(out.keys, ['CustomObject:DepProbeType__mdt']);
});

check('ORG-VERIFIED: the cascading System.debug error is suppressed as platform noise', () => {
  // A missing type produces a SECOND failure row naming the System namespace —
  // it must not pollute the report.
  const out = detectMissingDependencies(
    ['Method does not exist or incorrect signature: void debug(DepProbeType__mdt) from the type System'],
    [], new Set());
  assert.deepStrictEqual(out.keys, []);
  assert.deepStrictEqual(out.unresolved, []);
});

check('ORG-VERIFIED: missing field via dot access reports as Variable does not exist', () => {
  // NOT "Invalid field X for SObject Y" — the real compiler emits the bare-name form.
  const items2 = [item('CustomField', 'Account.DepProbeField__c', 'objects/Account/fields/DepProbeField__c.field-meta.xml')];
  const out = detectMissingDependencies(
    ['Variable does not exist: DepProbeField__c'], items2, new Set(['ApexClass:DepProbeFieldDot']));
  assert.deepStrictEqual(out.keys, ['CustomField:Account.DepProbeField__c']);
});

check('ORG-VERIFIED: SOQL missing column arrives inside a multi-line caret block', () => {
  const real = "SELECT Id, DepProbeField__c FROM Account LIMIT\n           ^\nERROR at Row:1:Column:12\nNo such column 'DepProbeField__c' on entity 'Account'. If you are attempting to use a custom field, be sure to append the '__c' after the custom field name. Please reference your WSDL or the describe call for the appropriate names.";
  const items2 = [item('CustomField', 'Account.DepProbeField__c', 'objects/Account/fields/DepProbeField__c.field-meta.xml')];
  const out = detectMissingDependencies([real], items2, new Set(['ApexClass:DepProbeSoql']));
  assert.deepStrictEqual(out.keys, ['CustomField:Account.DepProbeField__c']);
});

check('ORG-VERIFIED: modern files[].error carries a "(line:col)" suffix and still parses', () => {
  const items2 = [item('CustomObject', 'DepProbeType__mdt', 'objects/DepProbeType__mdt')];
  const out = detectMissingDependencies(
    ['Invalid type: DepProbeType__mdt (3:9)'], items2, new Set());
  assert.deepStrictEqual(out.keys, ['CustomObject:DepProbeType__mdt']);
});

check('ORG-VERIFIED: destructive-changes variant "No X named: Y found" matches', () => {
  const items2 = [item('ApexClass', 'DepProbeSoql', 'classes/DepProbeSoql.cls')];
  const out = detectMissingDependencies(['No ApexClass named: DepProbeSoql found'], items2, new Set());
  assert.deepStrictEqual(out.keys, ['ApexClass:DepProbeSoql']);
});

check('ORG-VERIFIED: wrong method signature names the callee type', () => {
  const items2 = [item('ApexClass', 'DepProbeBase', 'classes/DepProbeBase.cls')];
  const out = detectMissingDependencies(
    ['Method does not exist or incorrect signature: void noSuchMethod() from the type DepProbeBase'],
    items2, new Set(['ApexClass:DepProbeWrongMethod']));
  assert.deepStrictEqual(out.keys, ['ApexClass:DepProbeBase']);
});

if (failed) { console.error(`\n${failed} of ${ran} check(s) failed`); process.exit(1); }
console.log(`detectMissingDependencies: all ${ran} checks passed`);
