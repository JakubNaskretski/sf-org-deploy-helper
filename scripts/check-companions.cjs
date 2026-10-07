// Runnable contract test for the context-companion tables (src/companions.ts).
// No framework.   1) npm run compile   2) node scripts/check-companions.cjs
//
// A Profile, an org-wide Translations file and a CustomObjectTranslation come
// back from the org filled in ONLY for the components named in the same
// retrieve (verified on a live org: `Profile:Admin` alone → user permissions
// only; `Translations:pl` alone → a 104-byte stub; `CustomObjectTranslation:
// Product2-pl` alone → the parent stub, no field files). companionsFor() says
// what has to ride along. Pinned here:
//   - the three tables, for both scopes (project = the project's own members,
//     field-granular; org = `*` per type, the object translation's layouts and
//     quick actions from the org list);
//   - the org-list fallback (not loaded, or never listed those types) → the
//     project's, and the note says so;
//   - dedupe: never a selected component, never twice, never a `Type:Name`
//     beside the same type's `*` — except a STANDARD object, which a
//     CustomObject `*` does not cover (live: `*` alone gave no Product2 field
//     permissions, `*` + `Product2` gave 23);
//   - the loud empty-project-scope note; PermissionSet → nothing;
//   - buildManifestXml keeps `*` verbatim; the settings' declared defaults.
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const Module = require('module');

// metadataScanner (for OBJECT_CHILD_RULES and buildManifestXml) imports vscode.
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? { workspace: {} } : origLoad(req, ...rest));

const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'out', 'companions.js'));
const { OBJECT_CHILD_RULES, buildManifestXml } = require(path.join(ROOT, 'out', 'metadataScanner.js'));
const { companionsFor, CONTEXT_TYPES } = C;

let failed = 0;
let ran = 0;
function check(name, fn) {
  ran++;
  try { fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}

const it = (type, name) => ({ type, name });
const keys = (plan) => plan.companions.map(c => `${c.type}:${c.name}`);
const sorted = (a) => [...a].sort();

// A project with a bit of everything, and one with nothing a companion could use.
const LOCAL = [
  it('CustomLabels', 'CustomLabels'),
  it('CustomApplication', 'Acme_Sales'),
  it('CustomTab', 'Acme_Widget__c'),
  it('Flow', 'Acme_Onboard'),
  it('QuickAction', 'Product2.Acme_Clone'),
  it('QuickAction', 'Account.Acme_Call'),
  it('ReportType', 'Acme_Widgets'),
  it('CustomObject', 'Product2'),
  it('CustomObject', 'Acme_Widget__c'),
  it('CustomField', 'Product2.Status__c'),
  it('CustomField', 'Account.Acme_Tier__c'),
  it('RecordType', 'Acme_Widget__c.Retail'),
  it('ListView', 'Product2.AllProducts'),
  it('ApexClass', 'AcmeService'),
  it('ApexPage', 'AcmePage'),
  it('Layout', 'Product2-Product Layout'),
  it('Layout', 'Product2-Acme Layout'),
  it('Layout', 'Account-Account Layout'),
  it('CustomPermission', 'Acme_Admin'),
  it('ExternalDataSource', 'Acme_Ext'),
  it('CustomMetadata', 'Acme_Rate.Default'),
  it('PermissionSet', 'Acme_Access'),
  it('Translations', 'de')
];
const ORG_LIST = [
  it('Layout', 'Product2-Product Layout'),
  it('Layout', 'Product2-Org Only Layout'),
  it('Layout', 'Product2Ext__c-Layout'), // a different object sharing the prefix
  it('Layout', 'Account-Account Layout'),
  it('QuickAction', 'Product2.Org_Only_Action'),
  it('QuickAction', 'Product2Ext__c.Other'),
  it('ApexClass', 'OrgOnlyClass')
];

check('CONTEXT_TYPES: exactly the three types that come back incomplete alone', () => {
  assert.deepStrictEqual(sorted(CONTEXT_TYPES), ['CustomObjectTranslation', 'Profile', 'Translations']);
});

check('the object-children list is the scanner\'s, type for type', () => {
  assert.deepStrictEqual(sorted(C.PROFILE_OBJECT_CHILD_TYPES), sorted(OBJECT_CHILD_RULES.map(r => r.type)));
});

// ------------------------------------------------- CustomObjectTranslation
check('object translation, project scope: its object always, the project\'s layouts and quick actions of THAT object', () => {
  const plan = companionsFor([it('CustomObjectTranslation', 'Product2-pl')], { scope: 'project', localItems: LOCAL });
  assert.deepStrictEqual(keys(plan), [
    'CustomObject:Product2', 'Layout:Product2-Product Layout', 'Layout:Product2-Acme Layout', 'QuickAction:Product2.Acme_Clone'
  ]);
  assert.deepStrictEqual(plan.note, ['companions: CustomObject:Product2, Layout ×2, QuickAction:Product2.Acme_Clone (scope: project)']);
});

check('object translation: the object rides along even when the project does not have it', () => {
  const plan = companionsFor([it('CustomObjectTranslation', 'Case-pt_BR')], { scope: 'project', localItems: [] });
  assert.deepStrictEqual(keys(plan), ['CustomObject:Case']);
  assert.deepStrictEqual(plan.note, ['companions: CustomObject:Case (scope: project)'], 'not an empty-scope warning: the object alone is enough');
});

check('object translation, org scope: layouts and quick actions from the org list — never another object\'s', () => {
  const plan = companionsFor([it('CustomObjectTranslation', 'Product2-pl')], { scope: 'org', localItems: LOCAL, orgItems: ORG_LIST });
  assert.deepStrictEqual(keys(plan), [
    'CustomObject:Product2', 'Layout:Product2-Product Layout', 'Layout:Product2-Org Only Layout', 'QuickAction:Product2.Org_Only_Action'
  ]);
  assert.ok(!plan.note.some(n => n.includes('org list not loaded')), plan.note.join('\n'));
  assert.strictEqual(plan.note[0], 'companions: CustomObject:Product2, Layout ×2, QuickAction:Product2.Org_Only_Action (scope: org)');
});

check('object translation, org scope without an org list → the project\'s, and the note says so', () => {
  const plan = companionsFor([it('CustomObjectTranslation', 'Product2-pl')], { scope: 'org', localItems: LOCAL });
  assert.deepStrictEqual(keys(plan), [
    'CustomObject:Product2', 'Layout:Product2-Product Layout', 'Layout:Product2-Acme Layout', 'QuickAction:Product2.Acme_Clone'
  ]);
  assert.ok(plan.note.includes('org list not loaded — layouts and quick actions for Product2-pl were taken from the project; Fetch Org for the org\'s full set'), plan.note.join('\n'));
});

check('object translation, org scope, a list with no entries of a type → the project\'s for that type only, no fallback note', () => {
  const orgItems = [it('ApexClass', 'OrgOnlyClass'), it('Layout', 'Product2-Org Only Layout')]; // no QuickAction listed
  const plan = companionsFor([it('CustomObjectTranslation', 'Product2-pl')], { scope: 'org', localItems: LOCAL, orgItems });
  assert.deepStrictEqual(keys(plan), ['CustomObject:Product2', 'Layout:Product2-Org Only Layout', 'QuickAction:Product2.Acme_Clone']);
  assert.ok(!plan.note.some(n => n.startsWith('org list not loaded')), plan.note.join('\n'));
});

// ------------------------------------------------------------ Translations
check('translations, project scope: the project\'s labels, apps, tabs, flows, quick actions and report types', () => {
  const plan = companionsFor([it('Translations', 'pl')], { scope: 'project', localItems: LOCAL });
  assert.deepStrictEqual(keys(plan), [
    'CustomLabels:CustomLabels', 'CustomApplication:Acme_Sales', 'CustomTab:Acme_Widget__c', 'Flow:Acme_Onboard',
    'QuickAction:Product2.Acme_Clone', 'QuickAction:Account.Acme_Call', 'ReportType:Acme_Widgets'
  ]);
  assert.strictEqual(plan.note.length, 1);
});

check('translations, org scope: each type as `*`', () => {
  const plan = companionsFor([it('Translations', 'pl')], { scope: 'org', localItems: LOCAL });
  assert.deepStrictEqual(keys(plan), ['CustomLabels:*', 'CustomApplication:*', 'CustomTab:*', 'Flow:*', 'QuickAction:*', 'ReportType:*']);
  assert.deepStrictEqual(plan.note, ['companions: CustomLabels (all), CustomApplication (all), CustomTab (all), Flow (all), QuickAction (all), ReportType (all) (scope: org)']);
  assert.ok(C.hasWildcard(plan.companions));
});

check('translations, project scope, nothing to send → the LOUD note, no companions', () => {
  const plan = companionsFor([it('Translations', 'pl')], { scope: 'project', localItems: [it('ApexClass', 'AcmeService')] });
  assert.deepStrictEqual(plan.companions, []);
  assert.deepStrictEqual(plan.note, [
    'project scope found no CustomLabels/CustomApplication/CustomTab/Flow/QuickAction/ReportType in this project — Translations:pl will come back nearly empty; set sfOrgDeployWrapper.contextScope to "org"'
  ]);
});

// ----------------------------------------------------------------- Profile
check('profile, project scope: field-granular — the object AND each scanned child, plus every access type', () => {
  const plan = companionsFor([it('Profile', 'Admin')], { scope: 'project', localItems: LOCAL });
  assert.deepStrictEqual(sorted(keys(plan)), sorted([
    'CustomObject:Product2', 'CustomObject:Acme_Widget__c',
    'CustomField:Product2.Status__c', 'CustomField:Account.Acme_Tier__c', 'RecordType:Acme_Widget__c.Retail', 'ListView:Product2.AllProducts',
    'ApexClass:AcmeService', 'ApexPage:AcmePage', 'CustomApplication:Acme_Sales', 'CustomTab:Acme_Widget__c',
    'Layout:Product2-Product Layout', 'Layout:Product2-Acme Layout', 'Layout:Account-Account Layout',
    'CustomPermission:Acme_Admin', 'Flow:Acme_Onboard', 'ExternalDataSource:Acme_Ext'
  ]));
  // customMetadataTypeAccesses come with the `__mdt` CustomObject; records add nothing.
  assert.ok(!keys(plan).some(k => k.startsWith('CustomMetadata:')), keys(plan).join(', '));
  assert.ok(!keys(plan).some(k => k.startsWith('PermissionSet:') || k.startsWith('Translations:') || k.startsWith('CustomLabels:')), keys(plan).join(', '));
});

check('profile, project scope: a lone field (no object file) is sent as the field', () => {
  const plan = companionsFor([it('Profile', 'Admin')], { scope: 'project', localItems: [it('CustomField', 'Product2.Status__c')] });
  assert.deepStrictEqual(keys(plan), ['CustomField:Product2.Status__c']);
});

check('profile, org scope: `*` per type (fields and record types among the children), standard objects named beside the wildcard', () => {
  const plan = companionsFor([it('Profile', 'Admin')], { scope: 'org', localItems: LOCAL });
  assert.deepStrictEqual(keys(plan), [
    'CustomObject:*', 'ApexClass:*', 'ApexPage:*', 'CustomApplication:*', 'CustomTab:*', 'Layout:*',
    'CustomPermission:*', 'Flow:*', 'ExternalDataSource:*', 'CustomField:*', 'RecordType:*',
    // `*` covers custom objects only: the standard ones the project knows are named.
    'CustomObject:Product2', 'CustomObject:Account'
  ]);
  assert.ok(!keys(plan).includes('CustomObject:Acme_Widget__c'), 'a custom object IS covered by the wildcard');
  assert.ok(!keys(plan).includes('CustomMetadata:*'), 'never every custom metadata record on the org');
  assert.ok(plan.note.some(n => n.startsWith('scope "org" asks for every component') && n.includes('slow on big orgs')), plan.note.join('\n'));
});

check('profile, project scope, nothing to send → the LOUD note', () => {
  const plan = companionsFor([it('Profile', 'Admin')], { scope: 'project', localItems: [it('Translations', 'pl')] });
  assert.deepStrictEqual(plan.companions, []);
  assert.strictEqual(plan.note.length, 1);
  assert.ok(plan.note[0].startsWith('project scope found no CustomObject/ApexClass/'), plan.note[0]);
  assert.ok(plan.note[0].includes('Profile:Admin will come back nearly empty; set sfOrgDeployWrapper.contextScope to "org"'), plan.note[0]);
});

// ------------------------------------------------------------------ dedupe
check('dedupe: never a component already selected', () => {
  const selected = [it('Translations', 'pl'), it('CustomLabels', 'CustomLabels'), it('CustomTab', 'Acme_Widget__c')];
  const plan = companionsFor(selected, { scope: 'project', localItems: LOCAL });
  assert.ok(!keys(plan).includes('CustomLabels:CustomLabels') && !keys(plan).includes('CustomTab:Acme_Widget__c'), keys(plan).join(', '));
  assert.ok(keys(plan).includes('Flow:Acme_Onboard'));
});

check('dedupe: two context items never ask for the same companion twice', () => {
  const plan = companionsFor([it('Translations', 'pl'), it('Translations', 'de'), it('Profile', 'Admin'), it('CustomObjectTranslation', 'Product2-pl')], { scope: 'project', localItems: LOCAL });
  assert.strictEqual(new Set(keys(plan)).size, keys(plan).length, keys(plan).join(', '));
  assert.ok(!keys(plan).includes('Translations:de'), 'a selected context item is not its own companion');
});

check('dedupe: a `*` suppresses that type\'s names — a CUSTOM object too, a standard object never', () => {
  // Org-scope Profile (`CustomObject:*`, `Layout:*`) + project-scope-style names from the translations.
  const plan = companionsFor([it('Profile', 'Admin'), it('CustomObjectTranslation', 'Product2-pl'), it('CustomObjectTranslation', 'Acme_Widget__c-pl')], { scope: 'org', localItems: LOCAL, orgItems: ORG_LIST });
  const k = keys(plan);
  assert.ok(!k.some(x => x.startsWith('Layout:') && x !== 'Layout:*'), k.join(', '));
  assert.ok(k.includes('QuickAction:Product2.Org_Only_Action'), 'no QuickAction wildcard here, so the org list\'s action stays');
  assert.ok(!k.includes('CustomObject:Acme_Widget__c'), 'covered by CustomObject:*');
  assert.ok(k.includes('CustomObject:Product2'), 'a standard object is NOT covered by CustomObject:*');
  assert.strictEqual(k.filter(x => x === 'CustomObject:Product2').length, 1);
});

check('nothing for a selection without context types — PermissionSet included', () => {
  for (const scope of ['project', 'org']) {
    const plan = companionsFor([it('PermissionSet', 'Acme_Access'), it('ApexClass', 'AcmeService'), it('GlobalValueSetTranslation', 'ProductForm-pl')], { scope, localItems: LOCAL, orgItems: ORG_LIST });
    assert.deepStrictEqual(plan, { companions: [], note: [] });
  }
});

check('an unknown scope value reads as project', () => {
  const plan = companionsFor([it('Translations', 'pl')], { scope: 'everything', localItems: LOCAL });
  assert.ok(!C.hasWildcard(plan.companions));
  assert.ok(plan.note[0].endsWith('(scope: project)'));
});

check('isCompanionMessage: a companion not on the org is noise, a selected one never is', () => {
  const companions = [it('CustomTab', 'Acme_Widget__c'), it('Layout', '*')];
  const selected = [it('Profile', 'Admin'), it('ApexClass', 'AcmeService')];
  assert.ok(C.isCompanionMessage("Entity of type 'CustomTab' named 'Acme_Widget__c' cannot be found", companions, selected));
  assert.ok(C.isCompanionMessage("Entity of type 'Layout' named 'Account-Old' cannot be found", companions, selected), 'covered by Layout:*');
  assert.ok(C.isCompanionMessage('You do not have the proper permissions to access Layout.', companions, selected));
  assert.ok(!C.isCompanionMessage("Entity of type 'Profile' named 'Admin' cannot be found", companions, selected));
  assert.ok(!C.isCompanionMessage("Entity of type 'ApexClass' named 'AcmeService' cannot be found", companions, selected));
  assert.ok(!C.isCompanionMessage('INVALID_SESSION_ID: Session expired or invalid', companions, selected));
  assert.ok(!C.isCompanionMessage("Entity of type 'CustomTab' named 'Acme_Widget__c' cannot be found", [], selected), 'no companions, no noise');
});

// ------------------------------------------------------------- manifest
check('buildManifestXml keeps `*` verbatim beside named members', () => {
  const xml = buildManifestXml([
    { type: 'Translations', name: 'pl' }, { type: 'CustomLabels', name: '*' },
    { type: 'CustomObject', name: '*' }, { type: 'CustomObject', name: 'Product2' }
  ], '62.0');
  assert.ok(xml.includes('<types>\n    <members>*</members>\n    <name>CustomLabels</name>\n  </types>'), xml);
  assert.ok(xml.includes('<types>\n    <members>*</members>\n    <members>Product2</members>\n    <name>CustomObject</name>\n  </types>'), xml);
  assert.ok(!/&#|&ast;|\\\*/.test(xml), xml);
});

// ------------------------------------------------------------- settings
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const props = pkg.contributes.configuration.properties;
check('settings: contextScope project|org, default project; contextCompanions boolean, default true', () => {
  assert.deepStrictEqual(props['sfOrgDeployWrapper.contextScope'].enum, ['project', 'org']);
  assert.strictEqual(props['sfOrgDeployWrapper.contextScope'].default, 'project');
  assert.strictEqual(C.CONTEXT_SCOPE_DEFAULT, 'project', 'the code\'s fallback matches the declared default');
  assert.strictEqual(props['sfOrgDeployWrapper.contextCompanions'].type, 'boolean');
  assert.strictEqual(props['sfOrgDeployWrapper.contextCompanions'].default, true);
});

check('this harness is registered in package.json "check"', () => {
  assert.ok(pkg.scripts.check.includes('node ./scripts/check-companions.cjs'));
});

if (failed) { console.error(`companions: ${failed}/${ran} checks FAILED`); process.exit(1); }
console.log(`companions: all ${ran} checks passed`);
