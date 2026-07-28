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

check('ORG-VERIFIED (user report): FlexiPage missing-field error resolves via bare name', () => {
  // "Record." is the page's assigned object, not a name — bare-name rules apply.
  const items2 = [item('CustomField', 'Widget__c.TotalEstimatedRevenue__c', 'objects/Widget__c/fields/TotalEstimatedRevenue__c.field-meta.xml')];
  const real = "Something went wrong. We couldn't retrieve or load the information on the field: Record.TotalEstimatedRevenue__c";
  assert.deepStrictEqual(
    detectMissingDependencies([real], items2, new Set(['FlexiPage:Widget_Record_Page'])).keys,
    ['CustomField:Widget__c.TotalEstimatedRevenue__c']
  );
  // Wording drift: "of" + trailing period, as reported from the panel.
  const drift = "Something went wrong. We couldnt retrieve or load the information of field. Record.TotalEstimatedRevenue__c.";
  assert.deepStrictEqual(
    detectMissingDependencies([drift], items2, new Set()).keys,
    ['CustomField:Widget__c.TotalEstimatedRevenue__c']
  );
});

check('FlexiPage field error with TWO same-named local fields stays ambiguous', () => {
  const items2 = [
    item('CustomField', 'Widget__c.TotalEstimatedRevenue__c', 'objects/Widget__c/fields/a.field-meta.xml'),
    item('CustomField', 'Order__c.TotalEstimatedRevenue__c', 'objects/Order__c/fields/b.field-meta.xml')
  ];
  const out = detectMissingDependencies(
    ["We couldn't retrieve or load the information on the field: Record.TotalEstimatedRevenue__c"],
    items2, new Set()
  );
  assert.deepStrictEqual(out.keys, [], 'two candidate objects — never guessed');
  assert.ok(out.unresolved[0].includes('ambiguous'), JSON.stringify(out.unresolved));
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

// ============================================== names that contain a SPACE
// A Layout fullName is "<Object>-<Layout Name>" and ALWAYS carries a space, so
// the space-less name capture could never fire: a profile or permission set
// referencing a layout the org doesn't have produced no suggestion AND no
// unresolved line — pure silence. The capture is widened, but it stays bounded
// (no newlines, capped word length, few words, lazy up to the first " found")
// so it cannot run off into the prose around the message.
const LAYOUTS = [
  item('Layout', 'Account-Account Layout', p('layouts', 'Account-Account Layout.layout-meta.xml')),
  item('Layout', 'Widget__c-Widget Sales Layout', p('layouts', 'Widget__c-Widget Sales Layout.layout-meta.xml'))
];

check('THE LAYOUT BLIND SPOT: a space-bearing Layout name resolves', () => {
  const out = detectMissingDependencies(
    ['In field: layout - no Layout named Account-Account Layout found'],
    LAYOUTS, new Set(['PermissionSet:Field_Ops']));
  assert.deepStrictEqual(out.keys, ['Layout:Account-Account Layout']);
  assert.deepStrictEqual(out.unresolved, []);
});

check('a multi-word Layout name resolves too', () => {
  const out = detectMissingDependencies(
    ['no Layout named Widget__c-Widget Sales Layout found'], LAYOUTS, new Set());
  assert.deepStrictEqual(out.keys, ['Layout:Widget__c-Widget Sales Layout']);
});

check('a space-bearing name with no local item is REPORTED, not swallowed', () => {
  // The other half of the fix: silence was the bug, so an absent layout has to
  // reach the user as text even though nothing can be added to the deploy.
  const out = detectMissingDependencies(
    ['no Layout named Ghost__c-Ghost Layout found'], LAYOUTS, new Set());
  assert.deepStrictEqual(out.keys, []);
  assert.deepStrictEqual(out.unresolved, ['Layout:Ghost__c-Ghost Layout']);
});

// --- regressions for every wording the widened capture touches -------------
check('REGRESSION: lowercase "no X named Y found" (FlexiPage/QuickAction) unchanged', () => {
  const out = run('In field: action - no QuickAction named Account.Foo found');
  assert.deepStrictEqual(out.keys, ['QuickAction:Account.Foo']);
  assert.deepStrictEqual(out.unresolved, []);
});

check('REGRESSION: capitalised colon variant "No X named: Y found" unchanged', () => {
  assert.deepStrictEqual(run('No ApexClass named: MyHelper found').keys, ['ApexClass:MyHelper']);
});

check('REGRESSION: the wrong-type case still refuses to mint a key', () => {
  const out = run('no Layout named MyHelper found');
  assert.deepStrictEqual(out.keys, [], 'MyHelper is an ApexClass, not a Layout');
  assert.deepStrictEqual(out.unresolved, ['Layout:MyHelper']);
});

check('REGRESSION: dotted and slashed names still capture whole', () => {
  assert.deepStrictEqual(run('no QuickAction named account.foo found').keys, ['QuickAction:Account.Foo']);
  assert.deepStrictEqual(run('no BogusType named Nothing.Here found').unresolved, ['BogusType:Nothing.Here']);
});

// --- the bounds that keep the widened capture honest -----------------------
check('the capture stops at the FIRST " found", so two referents stay separate', () => {
  const out = detectMissingDependencies(
    ['no ApexClass named MyHelper found, no Layout named Account-Account Layout found'],
    [...ITEMS, ...LAYOUTS], new Set());
  assert.deepStrictEqual(out.keys, ['ApexClass:MyHelper', 'Layout:Account-Account Layout']);
});

check('a newline inside the name is never captured', () => {
  const out = detectMissingDependencies(
    ['no Layout named Account-Account\nLayout found'], LAYOUTS, new Set());
  assert.deepStrictEqual(out.keys, [], 'a name may not span lines');
  assert.deepStrictEqual(out.unresolved, []);
});

check('an absurdly long name is not captured at all', () => {
  const out = run(`no Layout named ${'A'.repeat(300)} found`);
  assert.deepStrictEqual(out.keys, []);
  assert.deepStrictEqual(out.unresolved, [], 'the per-word cap refuses it outright');
});

// The cap above must never sink below a LEGAL fullName, or the widening silently
// re-creates the silence it removed. A dotted CustomField carries no space, so it
// is one "word" as far as the pattern is concerned: 40 (object) + 1 + 43 (field)
// is legal Salesforce, and namespace prefixes push it further. These two pin the
// bound from below against real items, so a future tightening fails loudly.
const LONG_NAMES = [
  item('CustomField',
    'Acme_Product_Allocation_Detail_Record__c.Estimated_Annual_Recurring_Revenue_Amt__c',
    p('objects', 'Acme_Product_Allocation_Detail_Record__c', 'fields', 'Estimated_Annual_Recurring_Revenue_Amt__c.field-meta.xml')),
  item('QuickAction',
    'Acme_Product_Allocation_Detail_Record__c.Log_Estimated_Revenue_Adjustment',
    p('quickActions', 'Acme_Product_Allocation_Detail_Record__c.Log_Estimated_Revenue_Adjustment.quickAction-meta.xml'))
];

check('an 82-char dotted CustomField fullName still resolves to its key', () => {
  const name = LONG_NAMES[0].name;
  assert.ok(name.length > 60, `fixture must exceed the per-word cap under test (len ${name.length})`);
  const out = detectMissingDependencies(
    [`In field: field - no CustomField named ${name} found`], LONG_NAMES, new Set());
  assert.deepStrictEqual(out.keys, [`CustomField:${name}`]);
});

check('a long dotted name with no local item is REPORTED, not silently dropped', () => {
  const out = detectMissingDependencies(
    ['no QuickAction named Acme_Product_Allocation_Detail_Record__c.Log_Missing_Revenue_Adjustment found'],
    LONG_NAMES, new Set());
  assert.deepStrictEqual(out.keys, []);
  assert.deepStrictEqual(out.unresolved,
    ['QuickAction:Acme_Product_Allocation_Detail_Record__c.Log_Missing_Revenue_Adjustment']);
});

check('a space-bearing capture still cannot mint a key for a non-existent item', () => {
  // The security invariant, re-pinned for the widened pattern: prose picked up
  // by accident resolves against nothing and can only ever be display text.
  const out = detectMissingDependencies(
    ['no Layout named Totally Made Up Layout found', 'no ApexClass named Some Other Thing found'],
    [...ITEMS, ...LAYOUTS], new Set());
  assert.deepStrictEqual(out.keys, []);
  const real = new Set([...ITEMS, ...LAYOUTS].map(i => `${i.type}:${i.name}`));
  for (const k of out.keys) assert.ok(real.has(k), `minted a key with no local item: ${k}`);
});

// ================================ request-level ("envelope") failure text
// A deploy can fail with NO per-component rows at all — the org rejected the
// request as a whole. The provider used to feed the detector only the
// per-failure problems, so detection never ran and the card said nothing but
// "Deploy reported failure with no per-component details." The Metadata API's
// own `errorMessage` carries the same parseable wording, so it now goes in as
// one additional problem string; envelopeProblem (panelProvider) is what
// flattens and bounds it first.
const { envelopeProblem, DeployPanelProvider } = require(path.join(__dirname, '..', 'out', 'panelProvider.js'));
const ENVELOPE = { errorMessage: "Deploy failed.\n  MyThing: Invalid type: smth__mdt\r\n" };

check('the envelope text parses exactly like a per-component problem', () => {
  const out = run(envelopeProblem(ENVELOPE), ['ApexClass:MyThing']);
  assert.deepStrictEqual(out.keys, ['CustomObject:smth__mdt']);
});

check('envelopeProblem flattens newlines/tabs/ANSI into one parseable line', () => {
  assert.strictEqual(envelopeProblem(ENVELOPE), 'Deploy failed. MyThing: Invalid type: smth__mdt');
  assert.strictEqual(envelopeProblem({ errorMessage: '[31mInvalid type: smth__mdt[0m' }), 'Invalid type: smth__mdt');
});

check('envelopeProblem is empty for a result that carries no message', () => {
  for (const r of [{}, { errorMessage: '' }, { errorMessage: '   ' }, { errorMessage: 42 }, { errorMessage: null }]) {
    assert.strictEqual(envelopeProblem(r), '', JSON.stringify(r));
  }
});

check('envelopeProblem bounds org-controlled text', () => {
  const out = envelopeProblem({ errorMessage: 'x'.repeat(5000) });
  assert.ok(out.length <= 400, `len ${out.length}`);
  assert.ok(out.endsWith('…'), out.slice(-5));
});

check('an envelope naming a missing layout also reaches the detector', () => {
  // The two holes meet: a permission-set deploy rejected as a whole, naming a
  // layout — space in the name AND no per-component row.
  const out = detectMissingDependencies(
    [envelopeProblem({ errorMessage: 'In field: layout - no Layout named Account-Account Layout found' })],
    LAYOUTS, new Set(['PermissionSet:Field_Ops']));
  assert.deepStrictEqual(out.keys, ['Layout:Account-Account Layout']);
});

// ------------------------------------------------ the WIRING, not the units
// The two checks above compose envelopeProblem and the detector by hand, in this
// file — which proves nothing about whether the PRODUCT composes them. The one
// line that does (`if (envProblem) problemRows.push(...)` in reportDeployResult)
// is what turns a request-level rejection into a suggestion, so it is pinned
// here through the real card builder, driven with a stub `this`: the pure helpers
// run for real, only the side effects (post/toasts/log) are captured.
function failureCard(result, retryKeys) {
  const posted = [];
  const stub = Object.create(DeployPanelProvider.prototype);
  stub.items = ITEMS;
  stub.liveSuggestions = new Map();
  stub.suggestionSeq = 0;
  stub.post = (m) => posted.push(m);
  stub.endCmd = () => undefined;
  stub.failureToast = () => undefined;
  stub.notifySuccessIfPanelHidden = () => undefined;
  const deps = DeployPanelProvider.prototype.reportDeployResult.call(stub, result, {
    items: retryKeys.map(k => item('ApexClass', k.split(':')[1], `classes/${k.split(':')[1]}.cls`)),
    orgOnlySkipped: [], orgLabel: 'acme-dev', org: 'acme-dev-user',
    noun: `${retryKeys.length} component`, cmdId: 'c1', start: Date.now(), validateOnly: false,
    retry: { keys: retryKeys }
  });
  return { card: posted.find(m => m.type === 'status').card, deps };
}

check('WIRING: a rejection with NO component rows still produces a suggestion', () => {
  // The whole point: before the envelope reached the detector this card said
  // "no per-component details" and offered nothing at all.
  const { card, deps } = failureCard(
    { success: false, status: 'Failed', errorMessage: 'Deploy failed.\n  MyThing: Invalid type: smth__mdt' },
    ['ApexClass:MyThing']
  );
  assert.deepStrictEqual(deps.keys, ['CustomObject:smth__mdt']);
  assert.deepStrictEqual(card.suggest.candidates.map(c => c.key), ['CustomObject:smth__mdt']);
  // …and the org's own words are on the card, not just the fact that it failed.
  assert.ok(card.lines.some(l => typeof l === 'string' && l.includes('Invalid type: smth__mdt')), JSON.stringify(card.lines));
});

check('WIRING: the envelope is read even when component rows ARE present', () => {
  // "Every failure, not just the no-rows one" is a decision, not an accident:
  // restricting it to the empty-rows case loses the referent whenever the org
  // sends both a row and a request-level message.
  const { card } = failureCard(
    {
      success: false, status: 'Failed', numberComponentErrors: 1,
      errorMessage: 'Invalid type: smth__mdt',
      details: { componentFailures: [{ type: 'ApexClass', fullName: 'MyThing', state: 'Failed', problem: 'Dependent class is invalid and needs recompilation: Class MyHelper: bad' }] }
    },
    ['ApexClass:MyThing']
  );
  const keys = card.suggest.candidates.map(c => c.key);
  assert.ok(keys.includes('CustomObject:smth__mdt'), `envelope referent lost: ${keys.join(', ')}`);
  assert.ok(keys.includes('ApexClass:MyHelper'), `component-row referent lost: ${keys.join(', ')}`);
});

check('WIRING: an org message naming nothing local still leaves the card honest', () => {
  const { card, deps } = failureCard(
    { success: false, status: 'Failed', errorMessage: 'no Layout named Ghost__c-Ghost Layout found' },
    ['ApexClass:MyThing']
  );
  assert.deepStrictEqual(deps.unresolved, ['Layout:Ghost__c-Ghost Layout']);
  assert.strictEqual(card.suggest, undefined, 'nothing resolved locally — no checkbox list to offer');
  assert.ok(card.lines.some(l => typeof l === 'string' && l.includes('Referenced but not found in your workspace')), JSON.stringify(card.lines));
});

if (failed) { console.error(`\n${failed} of ${ran} check(s) failed`); process.exit(1); }
console.log(`detectMissingDependencies: all ${ran} checks passed`);
