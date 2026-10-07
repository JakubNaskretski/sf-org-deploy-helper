// Runnable contract test for the context companions (src/companions.ts).
// No framework.   1) npm run compile   2) node scripts/check-companions.cjs
//
// A Profile, an org-wide Translations file and a CustomObjectTranslation come
// back from the org filled in ONLY for the components named in the same
// retrieve (verified on a live org: `Profile:Admin` alone → user permissions
// only; `Translations:pl` alone → a 104-byte stub; `CustomObjectTranslation:
// Product2-pl` alone → the parent stub, no field files). For a Translations
// file or a Profile the user picks what rides along, at type level, in a quick
// pick (pickRows); an object translation's companions are fixed. Pinned here:
//   - the row model: per companion type a `this project's (N)` row (absent when
//     the project has none) and an `all on the org` row; ONE row for the labels;
//     no picker for an object translation;
//   - the default ticks: every project row, the labels when the project has them;
//   - companionsFor with picks: the org row wins over the project row of the
//     same type; a type with nothing ticked is left out; nothing ticked at all
//     → no companions, "nearly empty";
//   - describeContext: what each file is fetched with and what is left out, the
//     plan's own example word for word; "complete" only when every type is an
//     org row (and the org list named the standard objects);
//   - the object translation's fixed companions from the org list, the
//     fallback to the project's (said so);
//   - dedupe: never a selected component, never twice, never a `Type:Name`
//     beside the same type's `*` — except a STANDARD object, which a
//     CustomObject `*` does not cover (live: `*` alone gave no Product2 field
//     permissions, `*` + `Product2` gave 23);
//   - buildManifestXml keeps `*` verbatim; the settings: contextScope is gone
//     everywhere, contextCompanionPrompt always|remembered.
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
const { companionsFor, describeContext, pickRows, defaultPicks, CONTEXT_TYPES } = C;

let failed = 0;
let ran = 0;
function check(name, fn) {
  ran++;
  try { fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}

const it = (type, name) => ({ type, name });
const keys = (plan) => plan.companions.map(c => `${c.type}:${c.name}`);
const sorted = (a) => [...a].sort();
const rowKeys = (row) => row.companions.map(c => `${c.type}:${c.name}`);

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
const TR = it('Translations', 'pl');
const PROFILE = it('Profile', 'Admin');
const COT = it('CustomObjectTranslation', 'Product2-pl');
/** The plan for `selected` with `picks` (row ids per Type:Name; absent = the default ticks). */
const planFor = (selected, picks, extra = {}) => companionsFor(selected, { picks, localItems: LOCAL, ...extra });

check('CONTEXT_TYPES: exactly the three types that come back incomplete alone', () => {
  assert.deepStrictEqual(sorted(CONTEXT_TYPES), ['CustomObjectTranslation', 'Profile', 'Translations']);
});

check('the object-children list is the scanner\'s, type for type', () => {
  assert.deepStrictEqual(sorted(C.PROFILE_OBJECT_CHILD_TYPES), sorted(OBJECT_CHILD_RULES.map(r => r.type)));
});

// ================================================================ the rows
check('rows, Translations: ONE labels row, then two rows per type — this project\'s (N) and all on the org — in picker order', () => {
  const rows = pickRows(TR, { localItems: LOCAL, orgLabel: 'acme-dev' });
  assert.deepStrictEqual(rows.map(r => r.id), [
    'CustomLabels:org',
    'CustomApplication:project', 'CustomApplication:org', 'CustomTab:project', 'CustomTab:org',
    'Flow:project', 'Flow:org', 'QuickAction:project', 'QuickAction:org', 'ReportType:project', 'ReportType:org'
  ]);
  assert.strictEqual(rows.filter(r => r.type === 'CustomLabels').length, 1, 'the labels are ONE row: the project\'s file and the org\'s are the same request');
  const [labels] = rows;
  assert.deepStrictEqual([labels.label, labels.description, rowKeys(labels)], ['Labels', 'the labels file — every custom label on acme-dev', ['CustomLabels:CustomLabels']]);
  const qa = rows.filter(r => r.type === 'QuickAction');
  assert.deepStrictEqual(qa.map(r => [r.label, r.description]), [
    ['Quick actions: this project\'s (2)', 'Product2.Acme_Clone, Account.Acme_Call'],
    ['Quick actions: all on the org', 'every quick action on acme-dev']
  ]);
  assert.deepStrictEqual(rowKeys(qa[0]), ['QuickAction:Product2.Acme_Clone', 'QuickAction:Account.Acme_Call']);
  assert.deepStrictEqual(rowKeys(qa[1]), ['QuickAction:*']);
  assert.ok(rows.every(r => r.id === `${r.type}:${r.kind}`));
});

check('rows: no project row for a type the project has none of; up to 3 names, then +K more', () => {
  const local = ['A', 'B', 'C', 'D', 'E'].map(n => it('CustomTab', `Acme_${n}`));
  const rows = pickRows(TR, { localItems: local, orgLabel: 'acme-dev' });
  assert.deepStrictEqual(rows.map(r => r.id), [
    'CustomLabels:org', 'CustomApplication:org', 'CustomTab:project', 'CustomTab:org', 'Flow:org', 'QuickAction:org', 'ReportType:org'
  ]);
  const tabs = rows.find(r => r.id === 'CustomTab:project');
  assert.deepStrictEqual([tabs.label, tabs.description], ['Tabs: this project\'s (5)', 'Acme_A, Acme_B, Acme_C +2 more']);
});

check('default ticks: every project row, and the labels only when the project has a labels file', () => {
  assert.deepStrictEqual(defaultPicks(pickRows(TR, { localItems: LOCAL })), [
    'CustomLabels:org', 'CustomApplication:project', 'CustomTab:project', 'Flow:project', 'QuickAction:project', 'ReportType:project'
  ]);
  assert.deepStrictEqual(defaultPicks(pickRows(TR, { localItems: [it('CustomTab', 'Acme_A')] })), ['CustomTab:project']);
  assert.deepStrictEqual(defaultPicks(pickRows(TR, { localItems: [] })), [], 'nothing in the project → nothing ticked');
});

check('rows, Profile: the objects\' project row is field-granular; the org row is the wildcards plus the standard objects by name', () => {
  const orgItems = [...ORG_LIST, it('CustomObject', 'Account'), it('CustomObject', 'Opportunity'), it('CustomObject', 'Acme_Other__c')];
  const rows = pickRows(PROFILE, { localItems: LOCAL, orgItems, orgLabel: 'acme-dev' });
  assert.deepStrictEqual(rows.map(r => r.id), [
    'CustomObject:project', 'CustomObject:org', 'ApexClass:project', 'ApexClass:org', 'ApexPage:project', 'ApexPage:org',
    'CustomApplication:project', 'CustomApplication:org', 'CustomTab:project', 'CustomTab:org', 'Layout:project', 'Layout:org',
    'CustomPermission:project', 'CustomPermission:org', 'Flow:project', 'Flow:org', 'ExternalDataSource:project', 'ExternalDataSource:org'
  ]);
  const [proj, org] = rows;
  assert.strictEqual(proj.label, 'Objects: this project\'s (3)');
  assert.strictEqual(proj.description, 'Product2, Acme_Widget__c, Account · with 2 fields, 1 record type, 1 list view');
  // An object file AND each scanned child: the profile comes back with entries for exactly those.
  assert.deepStrictEqual(sorted(rowKeys(proj)), sorted([
    'CustomObject:Product2', 'CustomObject:Acme_Widget__c', 'CustomField:Product2.Status__c', 'CustomField:Account.Acme_Tier__c',
    'RecordType:Acme_Widget__c.Retail', 'ListView:Product2.AllProducts'
  ]));
  assert.deepStrictEqual(rowKeys(org), ['CustomObject:*', 'CustomField:*', 'RecordType:*', 'CustomObject:Account', 'CustomObject:Opportunity', 'CustomObject:Product2']);
  assert.strictEqual(org.description, 'every custom object, field and record type on acme-dev + 2 standard objects from the Fetch Org list');
  const noList = pickRows(PROFILE, { localItems: LOCAL, orgLabel: 'acme-dev' })[1];
  assert.strictEqual(noList.description, 'every custom object, field and record type on acme-dev + this project\'s standard objects (Fetch Org to name the org\'s)');
  // customMetadataTypeAccesses come with the `__mdt` CustomObject; records add nothing.
  assert.ok(!rows.some(r => r.type === 'CustomMetadata' || r.type === 'PermissionSet'));
});

check('no picker for an object translation — nor for anything but Translations and Profile', () => {
  assert.deepStrictEqual(Object.keys(C.PICK_TYPES).sort(), ['Profile', 'Translations']);
  assert.strictEqual(C.pickTypesFor('CustomObjectTranslation'), undefined);
  assert.strictEqual(C.pickTypesFor('constructor'), undefined, 'an own key, never an inherited one');
  for (const item of [COT, it('PermissionSet', 'Acme_Access'), it('ApexClass', 'AcmeService')]) {
    assert.deepStrictEqual(pickRows(item, { localItems: LOCAL, orgItems: ORG_LIST }), [], item.type);
  }
});

// ============================================================ the picks
check('Enter with no change (no picks): every project row — the project\'s own members, field-granular', () => {
  const plan = planFor([TR]);
  assert.deepStrictEqual(keys(plan), [
    'CustomLabels:CustomLabels', 'CustomApplication:Acme_Sales', 'CustomTab:Acme_Widget__c', 'Flow:Acme_Onboard',
    'QuickAction:Product2.Acme_Clone', 'QuickAction:Account.Acme_Call', 'ReportType:Acme_Widgets'
  ]);
  assert.ok(!C.hasWildcard(plan.companions), 'never the whole org unless an org row is ticked');
  const profile = planFor([PROFILE]);
  assert.deepStrictEqual(sorted(keys(profile)), sorted([
    'CustomObject:Product2', 'CustomObject:Acme_Widget__c',
    'CustomField:Product2.Status__c', 'CustomField:Account.Acme_Tier__c', 'RecordType:Acme_Widget__c.Retail', 'ListView:Product2.AllProducts',
    'ApexClass:AcmeService', 'ApexPage:AcmePage', 'CustomApplication:Acme_Sales', 'CustomTab:Acme_Widget__c',
    'Layout:Product2-Product Layout', 'Layout:Product2-Acme Layout', 'Layout:Account-Account Layout',
    'CustomPermission:Acme_Admin', 'Flow:Acme_Onboard', 'ExternalDataSource:Acme_Ext'
  ]));
  assert.ok(!keys(profile).some(k => k.startsWith('CustomMetadata:') || k.startsWith('PermissionSet:') || k.startsWith('CustomLabels:')), keys(profile).join(', '));
});

check('the org row wins over the project row of the same type — sent, and said', () => {
  const plan = planFor([TR], { 'Translations:pl': ['CustomTab:project', 'CustomTab:org', 'Flow:project'] });
  assert.deepStrictEqual(keys(plan), ['CustomTab:*', 'Flow:Acme_Onboard']);
  assert.deepStrictEqual(plan.chosen['Translations:pl'].map(c => [c.type, c.kind]), [['CustomTab', 'org'], ['Flow', 'project']]);
  assert.deepStrictEqual(describeContext([TR], plan), [
    'Translations:pl: fetched with 1 flow (project), all tabs on the org — labels, apps, quick actions and report types left out'
  ]);
  // A profile's objects: the org row has no list views, so a project-row child
  // the wildcards can't absorb shows whether the project row was dropped.
  const profile = planFor([PROFILE], { 'Profile:Admin': ['CustomObject:project', 'CustomObject:org'] });
  assert.ok(!keys(profile).includes('ListView:Product2.AllProducts'), keys(profile).join(', '));
  assert.ok(!keys(profile).includes('CustomObject:Acme_Widget__c'), 'covered by CustomObject:*');
});

check('a type with nothing ticked is left out — and the line names it', () => {
  const plan = planFor([TR], { 'Translations:pl': ['CustomLabels:org'] });
  assert.deepStrictEqual(keys(plan), ['CustomLabels:CustomLabels']);
  assert.deepStrictEqual(plan.leftOut['Translations:pl'], ['CustomApplication', 'CustomTab', 'Flow', 'QuickAction', 'ReportType']);
  assert.deepStrictEqual(describeContext([TR], plan), ['Translations:pl: fetched with the labels — apps, tabs, flows, quick actions and report types left out']);
  assert.ok(C.fetchedPartly(plan));
});

check('nothing ticked at all: no companions, and the line says it comes back nearly empty', () => {
  const plan = planFor([TR, PROFILE], { 'Translations:pl': [], 'Profile:Admin': ['ApexClass:project'] });
  assert.deepStrictEqual(keys(plan), ['ApexClass:AcmeService']);
  assert.deepStrictEqual(plan.incomplete, ['Translations:pl']);
  assert.deepStrictEqual(describeContext([TR, PROFILE], plan), [
    'Translations:pl: fetched alone — nothing ticked to fetch it with, so it comes back nearly empty',
    'Profile:Admin: fetched with 1 class (project) — objects, pages, apps, tabs, layouts, custom permissions, flows and data sources left out'
  ]);
});

check('a remembered id with no row any more (the project lost its tabs) is ignored — that type is left out', () => {
  const plan = companionsFor([TR], { picks: { 'Translations:pl': ['CustomTab:project', 'Flow:org'] }, localItems: [it('Flow', 'Acme_Onboard')] });
  assert.deepStrictEqual(keys(plan), ['Flow:*']);
  assert.ok(plan.leftOut['Translations:pl'].includes('CustomTab'));
});

check('describe: the plan\'s own example, word for word', () => {
  const local = [it('CustomLabels', 'CustomLabels'), ...Array.from({ length: 11 }, (_, n) => it('CustomTab', `Acme_Tab${n}__c`)), it('Flow', 'Acme_Onboard')];
  const plan = companionsFor([TR], { picks: { 'Translations:pl': ['CustomLabels:org', 'CustomTab:project', 'Flow:org'] }, localItems: local });
  assert.deepStrictEqual(describeContext([TR], plan), [
    'Translations:pl: fetched with the labels, 11 tabs (project), all flows on the org — apps, quick actions and report types left out'
  ]);
});

const ALL_ORG = (item, extra = {}) => pickRows(item, { localItems: LOCAL, ...extra }).filter(r => r.kind === 'org').map(r => r.id);
check('"complete" ONLY when every type is an org row — one project row or one type left out, and it is not said', () => {
  const all = planFor([TR], { 'Translations:pl': ALL_ORG(TR) });
  assert.deepStrictEqual(keys(all), ['CustomLabels:CustomLabels', 'CustomApplication:*', 'CustomTab:*', 'Flow:*', 'QuickAction:*', 'ReportType:*']);
  assert.deepStrictEqual(describeContext([TR], all), ['Translations:pl: fetched with the labels, all apps, tabs, flows, quick actions and report types on the org so it comes back complete']);
  assert.ok(!C.fetchedPartly(all));
  const oneProject = planFor([TR], { 'Translations:pl': [...ALL_ORG(TR).filter(id => id !== 'Flow:org'), 'Flow:project'] });
  const noLabels = planFor([TR], { 'Translations:pl': ALL_ORG(TR).filter(id => id !== 'CustomLabels:org') });
  for (const plan of [oneProject, noLabels]) {
    const [line] = describeContext([TR], plan);
    assert.ok(!/complete/.test(line), line);
    assert.ok(C.fetchedPartly(plan));
  }
  assert.strictEqual(describeContext([TR], noLabels)[0], 'Translations:pl: fetched with all apps, tabs, flows, quick actions and report types on the org — labels left out');
});

check('profile, every org row: complete with the org list\'s standard objects; without them, "only for what the project knows"', () => {
  const orgItems = [...ORG_LIST, it('CustomObject', 'Account'), it('CustomObject', 'Opportunity'), it('CustomObject', 'Acme_Other__c'), it('CustomObject', 'Acme_Rate__mdt')];
  const withList = planFor([PROFILE], { 'Profile:Admin': ALL_ORG(PROFILE) }, { orgItems });
  assert.deepStrictEqual(keys(withList).filter(k => k.startsWith('CustomObject:')), ['CustomObject:*', 'CustomObject:Account', 'CustomObject:Opportunity', 'CustomObject:Product2']);
  assert.ok(!keys(withList).includes('CustomMetadata:*'), 'never every custom metadata record on the org');
  assert.deepStrictEqual(withList.partial, []);
  assert.deepStrictEqual(describeContext([PROFILE], withList), [
    'Profile:Admin: fetched with all objects, classes, pages, apps, tabs, layouts, custom permissions, flows and data sources on the org so it comes back complete'
  ]);
  const noList = planFor([PROFILE], { 'Profile:Admin': ALL_ORG(PROFILE) });
  assert.deepStrictEqual(noList.partial, ['Profile:Admin']);
  assert.ok(keys(noList).includes('CustomObject:Product2') && keys(noList).includes('CustomObject:Account'), 'the project\'s standard objects, as an object file or a child\'s parent');
  assert.deepStrictEqual(describeContext([PROFILE], noList), [
    'Profile:Admin: fetched with all objects, classes, pages, apps, tabs, layouts, custom permissions, flows and data sources on the org — complete only for what the project knows'
  ]);
  assert.ok(noList.note.includes('org list not loaded — standard objects for Profile:Admin were taken from the project; Fetch Org to include the org\'s standard objects'), noList.note.join('\n'));
  // A loaded list naming no STANDARD object can't fill them either.
  const customOnly = planFor([PROFILE], { 'Profile:Admin': ALL_ORG(PROFILE) }, { orgItems: [...ORG_LIST, it('CustomObject', 'Acme_Other__c')] });
  assert.ok(customOnly.note.includes('no standard objects in the org list — standard objects for Profile:Admin were taken from the project; Fetch Org to include the org\'s standard objects'), customOnly.note.join('\n'));
  // The objects' org row NOT ticked: no standard-object caveat at all.
  const noObjects = planFor([PROFILE], { 'Profile:Admin': ['ApexClass:org'] });
  assert.deepStrictEqual([noObjects.partial, noObjects.note.filter(n => n.includes('standard objects'))], [[], []]);
});

// ================================================== CustomObjectTranslation
check('object translation: its object, and the org list\'s layouts and quick actions of THAT object — complete', () => {
  const plan = companionsFor([COT], { localItems: LOCAL, orgItems: ORG_LIST });
  assert.deepStrictEqual(keys(plan), [
    'CustomObject:Product2', 'Layout:Product2-Product Layout', 'Layout:Product2-Org Only Layout', 'QuickAction:Product2.Org_Only_Action'
  ]);
  assert.deepStrictEqual(plan.note, ['companions: CustomObject:Product2, Layout ×2, QuickAction:Product2.Org_Only_Action']);
  assert.deepStrictEqual(describeContext([COT], plan), ['CustomObjectTranslation:Product2-pl: fetched with its object and the org\'s 2 layouts, 1 quick action so it comes back complete']);
  // Picks are for picker items only — an object translation ignores them.
  assert.deepStrictEqual(keys(companionsFor([COT], { picks: { 'CustomObjectTranslation:Product2-pl': [] }, localItems: LOCAL, orgItems: ORG_LIST })), keys(plan));
});

check('object translation: the object rides along even when the project does not have it', () => {
  const plan = companionsFor([it('CustomObjectTranslation', 'Case-pt_BR')], { localItems: [], orgItems: ORG_LIST });
  assert.deepStrictEqual(keys(plan), ['CustomObject:Case']);
});

check('object translation without an org list → the project\'s, partial, and the note says so', () => {
  const plan = companionsFor([COT], { localItems: LOCAL });
  assert.deepStrictEqual(keys(plan), [
    'CustomObject:Product2', 'Layout:Product2-Product Layout', 'Layout:Product2-Acme Layout', 'QuickAction:Product2.Acme_Clone'
  ]);
  assert.deepStrictEqual(plan.partial, ['CustomObjectTranslation:Product2-pl']);
  assert.ok(plan.note.includes('org list not loaded — layouts and quick actions for Product2-pl were taken from the project; Fetch Org for the org\'s full set'), plan.note.join('\n'));
  assert.deepStrictEqual(describeContext([COT], plan), ['CustomObjectTranslation:Product2-pl: fetched with its object and 2 layouts, 1 quick action — complete only for what the project knows']);
});

check('object translation, a list with no entries of a type → the project\'s for that type only, no fallback note', () => {
  const orgItems = [it('ApexClass', 'OrgOnlyClass'), it('Layout', 'Product2-Org Only Layout')]; // no QuickAction listed
  const plan = companionsFor([COT], { localItems: LOCAL, orgItems });
  assert.deepStrictEqual(keys(plan), ['CustomObject:Product2', 'Layout:Product2-Org Only Layout', 'QuickAction:Product2.Acme_Clone']);
  assert.ok(!plan.note.some(n => n.startsWith('org list not loaded')), plan.note.join('\n'));
  assert.deepStrictEqual(plan.partial, [], 'zero quick actions is an ordinary org');
});

check('object translation, a loaded list with NO Layout at all (its fetch failed) → partial, and said so', () => {
  const noLayouts = [it('QuickAction', 'Product2.Org_Only_Action'), it('ApexClass', 'OrgOnlyClass')];
  const plan = companionsFor([COT], { localItems: LOCAL, orgItems: noLayouts });
  assert.deepStrictEqual(keys(plan), ['CustomObject:Product2', 'Layout:Product2-Product Layout', 'Layout:Product2-Acme Layout', 'QuickAction:Product2.Org_Only_Action']);
  assert.deepStrictEqual(plan.partial, ['CustomObjectTranslation:Product2-pl']);
  assert.ok(plan.note.includes('no Layout entries in the org list — layouts for Product2-pl were taken from the project; Fetch Org again for the org\'s full set'), plan.note.join('\n'));
});

// ================================================================== dedupe
check('dedupe: never a component already selected', () => {
  const selected = [TR, it('CustomLabels', 'CustomLabels'), it('CustomTab', 'Acme_Widget__c')];
  const plan = planFor(selected);
  assert.ok(!keys(plan).includes('CustomLabels:CustomLabels') && !keys(plan).includes('CustomTab:Acme_Widget__c'), keys(plan).join(', '));
  assert.ok(keys(plan).includes('Flow:Acme_Onboard'));
});

check('dedupe: two context items never ask for the same companion twice', () => {
  const plan = planFor([TR, it('Translations', 'de'), PROFILE, COT], undefined, { orgItems: ORG_LIST });
  assert.strictEqual(new Set(keys(plan)).size, keys(plan).length, keys(plan).join(', '));
  assert.ok(!keys(plan).includes('Translations:de'), 'a selected context item is not its own companion');
});

check('dedupe: a `*` suppresses that type\'s names — a CUSTOM object too, a standard object never', () => {
  const plan = planFor([PROFILE, COT, it('CustomObjectTranslation', 'Acme_Widget__c-pl')], { 'Profile:Admin': ALL_ORG(PROFILE) }, { orgItems: ORG_LIST });
  const k = keys(plan);
  assert.ok(!k.some(x => x.startsWith('Layout:') && x !== 'Layout:*'), k.join(', '));
  assert.ok(k.includes('QuickAction:Product2.Org_Only_Action'), 'no QuickAction wildcard here, so the org list\'s action stays');
  assert.ok(!k.includes('CustomObject:Acme_Widget__c'), 'covered by CustomObject:*');
  assert.ok(k.includes('CustomObject:Product2'), 'a standard object is NOT covered by CustomObject:*');
  assert.strictEqual(k.filter(x => x === 'CustomObject:Product2').length, 1);
});

check('nothing for a selection without context types — PermissionSet included', () => {
  const plan = planFor([it('PermissionSet', 'Acme_Access'), it('ApexClass', 'AcmeService'), it('GlobalValueSetTranslation', 'ProductForm-pl')], undefined, { orgItems: ORG_LIST });
  assert.deepStrictEqual(plan, { companions: [], note: [], incomplete: [], partial: [], own: {}, chosen: {}, leftOut: {} });
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
  // Named without the "type X named Y" shape — a standard object the org list
  // brought along that the org can't retrieve.
  const withObj = [...companions, it('CustomObject', 'ConversationEntryCopy')];
  assert.ok(C.isCompanionMessage('Not a registered filter type: ConversationEntryCopy (see FilterType.java)', withObj, selected));
  assert.ok(!C.isCompanionMessage('Not a registered filter type: ConversationEntryCopyX (see FilterType.java)', [it('CustomObject', 'ConversationEntryCopy')], selected), 'a whole name, not a prefix');
  assert.ok(!C.isCompanionMessage('Admin: ConversationEntryCopy could not be read', withObj, selected), 'a message that names the selection is never noise');
});

check('countPhrase: the labels without a count, nouns pluralised', () => {
  assert.strictEqual(C.countPhrase([it('CustomLabels', 'CustomLabels'), it('CustomTab', 'A'), it('CustomTab', 'B'), it('ApexClass', 'X')]), 'the labels, 2 tabs, 1 class');
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
check('settings: the contextScope switch is gone — from package.json, the README and the code', () => {
  assert.ok(!('sfOrgDeployWrapper.contextScope' in props), 'still declared');
  assert.ok(!JSON.stringify(pkg).includes('contextScope'), 'still referenced in package.json');
  assert.ok(!fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').includes('contextScope'), 'still in the README');
  for (const f of fs.readdirSync(path.join(ROOT, 'src')).filter(f => f.endsWith('.ts'))) {
    assert.ok(!fs.readFileSync(path.join(ROOT, 'src', f), 'utf8').includes('contextScope'), `still in src/${f}`);
  }
  assert.strictEqual(C.CONTEXT_SCOPE_DEFAULT, undefined);
});

check('settings: contextCompanionPrompt always|remembered, default always; contextCompanions boolean, default true', () => {
  const prompt = props['sfOrgDeployWrapper.contextCompanionPrompt'];
  assert.deepStrictEqual([prompt.type, prompt.enum, prompt.default], ['string', ['always', 'remembered'], 'always']);
  assert.strictEqual(prompt.enumDescriptions.length, 2);
  assert.strictEqual(props['sfOrgDeployWrapper.contextCompanions'].type, 'boolean');
  assert.strictEqual(props['sfOrgDeployWrapper.contextCompanions'].default, true);
});

check('this harness is registered in package.json "check"', () => {
  assert.ok(pkg.scripts.check.includes('node ./scripts/check-companions.cjs'));
});

if (failed) { console.error(`companions: ${failed}/${ran} checks FAILED`); process.exit(1); }
console.log(`companions: all ${ran} checks passed`);
