// Runnable contract test for depGraph.ts (stripApexNoise / extractTokens /
// resolveLocalDependencies).   No framework.
//   1) npm run compile   2) node scripts/check-dep-graph.cjs
//
// The module resolves a "Deploy File + Dependencies" set from LOCAL Apex source
// by token matching — deliberately not a parser (false positives deploy an
// unchanged copy and are harmless; misses fall back to the failure card's
// Retry + missing). The contract under test: comments/strings never produce
// tokens, matches come ONLY from the scanned item list (canonical casing, so
// file text can never mint a `--metadata` key that isn't a real workspace
// component), platform names and entry keys are excluded, BFS is transitive,
// cycle-safe and deterministic, and both caps (depth / count) report
// truncation only when they actually cut something.
const path = require('path');
const assert = require('assert');
const Module = require('module');
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? {} : origLoad(req, ...rest));

const {
  stripApexNoise, extractTokens, resolveLocalDependencies, canScanDependencies,
  scanJsStrings, extractLwcModuleRefs, extractLwcTemplateRefs, extractAuraRefs, stripMarkupComments
} = require(path.join(__dirname, '..', 'out', 'depGraph.js'));
const p = (...s) => s.join(path.sep);

let failed = 0;
let ran = 0;
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const item = (type, name, file) => ({ type, name, filePath: p('ws', file), files: [] });

// A representative scanned workspace. The Acme* classes exist only as match
// targets for specific checks; DepFixService → DepFixHelper → DepFixQueue is
// the transitive chain, AcmeLoopA ⇄ AcmeLoopB the cycle.
const ITEMS = [
  item('ApexClass', 'DepFixService', 'classes/DepFixService.cls'),
  item('ApexClass', 'DepFixHelper', 'classes/DepFixHelper.cls'),
  item('ApexClass', 'DepFixQueue', 'classes/DepFixQueue.cls'),
  item('ApexClass', 'AcmeLoopA', 'classes/AcmeLoopA.cls'),
  item('ApexClass', 'AcmeLoopB', 'classes/AcmeLoopB.cls'),
  item('ApexClass', 'AcmeGen0', 'classes/AcmeGen0.cls'),
  item('ApexClass', 'AcmeGen1', 'classes/AcmeGen1.cls'),
  item('ApexClass', 'AcmeGen2', 'classes/AcmeGen2.cls'),
  item('ApexTrigger', 'WidgetTrigger', 'triggers/WidgetTrigger.trigger'),
  item('CustomObject', 'Widget__c', 'objects/Widget__c'),
  item('CustomObject', 'DepFixRule__mdt', 'objects/DepFixRule__mdt'),
  item('CustomField', 'Widget__c.Size__c', 'objects/Widget__c/fields/Size__c.field-meta.xml'),
  item('Layout', 'Widget__c-Widget Layout', 'layouts/Widget__c-Widget Layout.layout-meta.xml')
];

// Fixture sources, keyed by the items' filePath. String literals only — the
// suite must run from a bare checkout with no fixture tree on disk.
const SOURCES = new Map([
  [p('ws', 'classes/DepFixService.cls'),
    'public class DepFixService {\n  public void run() {\n    DepFixHelper.doThing();\n  }\n}\n'],
  [p('ws', 'classes/DepFixHelper.cls'),
    'public class DepFixHelper {\n  public static void doThing() {\n    DepFixQueue q = new DepFixQueue();\n  }\n}\n'],
  [p('ws', 'classes/DepFixQueue.cls'),
    'public class DepFixQueue {\n  Integer size = 0;\n}\n'],
  [p('ws', 'classes/AcmeLoopA.cls'),
    'public class AcmeLoopA {\n  AcmeLoopB other;\n}\n'],
  [p('ws', 'classes/AcmeLoopB.cls'),
    'public class AcmeLoopB {\n  AcmeLoopA other;\n}\n'],
  [p('ws', 'classes/AcmeGen0.cls'), 'public class AcmeGen0 {}\n'],
  [p('ws', 'classes/AcmeGen1.cls'), 'public class AcmeGen1 {}\n'],
  [p('ws', 'classes/AcmeGen2.cls'), 'public class AcmeGen2 {}\n'],
  [p('ws', 'triggers/WidgetTrigger.trigger'),
    'trigger WidgetTrigger on Widget__c (before insert) {\n'
    + '  DepFixRule__mdt cfg = DepFixRule__mdt.getInstance(\'main\');\n'
    + '  Object fld = Widget__c.Size__c;\n'
    + '}\n'],
  // Deliberately Apex-looking content behind a non-Apex item — proves non-Apex
  // entries are never read, not merely that their text happens to match nothing.
  [p('ws', 'layouts/Widget__c-Widget Layout.layout-meta.xml'),
    'DepFixHelper DepFixQueue Widget__c\n']
]);

// ------------------------------------------------------------ bundle fixtures
// LWC/Aura components are DIRECTORIES: the item carries `files`, and the reader
// picks the source files out of that list instead of walking the disk. Names are
// fictional, same corpus as above.
const bfile = (dir, name) => p('ws', dir, name);
const bundle = (type, name, dir, names) =>
  ({ type, name, filePath: p('ws', dir), files: names.map(n => bfile(dir, n)) });
const src = (dir, name, lines) => SOURCES.set(bfile(dir, name), lines.join('\n') + '\n');

ITEMS.push(
  bundle('LightningComponentBundle', 'depFixCard', 'lwc/depFixCard',
    ['depFixCard.js', 'depFixCard.html', 'depFixCard.js-meta.xml', 'depFixCard.css', '__tests__/depFixCard.test.js']),
  bundle('LightningComponentBundle', 'depFixChild', 'lwc/depFixChild', ['depFixChild.js', 'depFixChild.html']),
  bundle('LightningComponentBundle', 'depFixTile', 'lwc/depFixTile', ['depFixTile.js']),
  bundle('LightningComponentBundle', 'depFixHidden', 'lwc/depFixHidden', ['depFixHidden.js']),
  bundle('LightningComponentBundle', 'depFixLoopA', 'lwc/depFixLoopA', ['depFixLoopA.js']),
  bundle('LightningComponentBundle', 'depFixLoopB', 'lwc/depFixLoopB', ['depFixLoopB.js']),
  bundle('AuraDefinitionBundle', 'DepFixPanel', 'aura/DepFixPanel',
    ['DepFixPanel.cmp', 'DepFixPanelController.js', 'DepFixPanel.cmp-meta.xml', 'DepFixPanel.css']),
  bundle('AuraDefinitionBundle', 'DepFixBase', 'aura/DepFixBase', ['DepFixBase.cmp']),
  bundle('AuraDefinitionBundle', 'DepFixHidden', 'aura/DepFixHidden', ['DepFixHidden.cmp']),
  item('LightningMessageChannel', 'DepFixChannel', 'messageChannels/DepFixChannel.messageChannel-meta.xml'),
  item('StaticResource', 'DepFixAssets', 'staticresources/DepFixAssets.resource')
);

// Every import form in one module, each with a scanned target, plus the forms
// that must resolve to NOTHING: a non-c namespace, a managed (namespaced) Apex
// import, and specifiers hidden in a line comment, a block comment and a string.
src('lwc/depFixCard', 'depFixCard.js', [
  "import { LightningElement, wire } from 'lwc';",
  "import getRows from '@salesforce/apex/DepFixHelper.getRows';",
  "import DepFixQueue from '@salesforce/apex/DepFixQueue';",
  "import SIZE_FIELD from '@salesforce/schema/Widget__c.Size__c';",
  "import WIDGET_OBJECT from '@salesforce/schema/Widget__c';",
  "import CHANNEL from '@salesforce/messageChannel/DepFixChannel__c';",
  "import ASSETS from '@salesforce/resourceUrl/DepFixAssets';",
  "import DepFixChild from 'c/depFixChild';",
  "import { NavigationMixin } from 'lightning/navigation';",
  "import ghost from 'acme/depFixChild';",
  "import managed from '@salesforce/apex/acme.DepFixQueue.run';",
  "// import hidden from '@salesforce/apex/AcmeGen1.run';",
  "/* import blocked from '@salesforce/apex/AcmeGen2.run'; */",
  'const doc = "import quoted from \'@salesforce/apex/AcmeLoopA.run\'";',
  // Well-formed specifiers in DATA position: only the module-specifier slot counts.
  "const note = '@salesforce/apex/AcmeGen2.run';",
  "const slot = 'c/depFixHidden';"
]);
src('lwc/depFixCard', 'depFixCard.html', [
  '<template>',
  '  <!-- <c-dep-fix-hidden></c-dep-fix-hidden> -->',
  '  <lightning-card title="DepFixService"></lightning-card>',
  '  <c-dep-fix-tile></c-dep-fix-tile>',
  '</template>'
]);
// Never-read bundle files, each holding a scanned name: an unread file must
// contribute nothing, not merely happen to match nothing.
src('lwc/depFixCard', 'depFixCard.js-meta.xml', ['<LightningComponentBundle><masterLabel>DepFixService</masterLabel></LightningComponentBundle>']);
src('lwc/depFixCard', 'depFixCard.css', ['/* DepFixService */', '.card { color: red; }']);
src('lwc/depFixCard', '__tests__/depFixCard.test.js', ["import spy from '@salesforce/apex/AcmeGen1.run';"]);

src('lwc/depFixChild', 'depFixChild.js', ["import { LightningElement } from 'lwc';"]);
src('lwc/depFixChild', 'depFixChild.html', ['<template></template>']);
src('lwc/depFixTile', 'depFixTile.js', ["import ping from '@salesforce/apex/AcmeGen0.ping';"]);
src('lwc/depFixHidden', 'depFixHidden.js', ["import { LightningElement } from 'lwc';"]);
src('lwc/depFixLoopA', 'depFixLoopA.js', ["import B from 'c/depFixLoopB';"]);
src('lwc/depFixLoopB', 'depFixLoopB.js', ["import A from 'c/depFixLoopA';"]);

src('aura/DepFixPanel', 'DepFixPanel.cmp', [
  '<aura:component controller="DepFixHelper" extends="c:DepFixBase" implements="force:appHostable">',
  '  <!-- <c:DepFixHidden/> -->',
  '  <c:depFixTile/>',
  '  <aura:dependency resource="c:DepFixBase"/>',
  '  <lightning:card title="DepFixService"/>',
  '</aura:component>'
]);
// An Aura controller reaches Apex through component.get('c.method') — a method
// on the component, not a class — so the bundle's .js is deliberately not read.
// $A.createComponent is the one thing that costs (a dynamically created child);
// it is left to the deploy to report, rather than reading JS with markup rules.
src('aura/DepFixPanel', 'DepFixPanelController.js', [
  '({ onInit: function (cmp) {',
  '  cmp.get("c.load");',
  '  $A.createComponent("c:DepFixHidden", {}, function (body) { cmp.set("v.body", body); });',
  '} })'
]);
src('aura/DepFixBase', 'DepFixBase.cmp', ['<aura:component/>']);
src('aura/DepFixHidden', 'DepFixHidden.cmp', ['<aura:component/>']);

const readFile = async fp => SOURCES.get(fp);
const resolve = (entry, opts, items = ITEMS) => resolveLocalDependencies(entry, items, readFile, opts);
const byName = name => ITEMS.find(i => i.name === name);

// ------------------------------------------------------------ stripApexNoise
check('line comment content is blanked, code before/after survives', () => {
  const out = stripApexNoise('DepFixA // DepFixB\nDepFixC');
  assert.ok(!out.includes('DepFixB'), out);
  assert.ok(out.includes('DepFixA') && out.includes('DepFixC'), out);
});

check('block comment content is blanked', () => {
  const out = stripApexNoise('DepFixA /* DepFixB */ DepFixC');
  assert.ok(!out.includes('DepFixB'), out);
  assert.ok(out.includes('DepFixA') && out.includes('DepFixC'), out);
});

check('nested-looking /* */ ends at the FIRST terminator (Apex does not nest)', () => {
  const out = stripApexNoise('/* a /* b */ DepFixHelper');
  assert.ok(out.includes('DepFixHelper'), out);
  assert.ok(!out.includes(' a '), out);
});

check('string literals are blanked, including escaped quotes', () => {
  const out = stripApexNoise("String s = 'it\\'s DepFixB'; DepFixC");
  assert.ok(!out.includes('DepFixB'), out);
  assert.ok(out.includes('DepFixC'), out);
});

check('a removed span never fuses the tokens around it', () => {
  const out = stripApexNoise('DepFix/*x*/Helper');
  assert.ok(!/DepFixHelper/.test(out), out);
  assert.ok(/DepFix\s+Helper/.test(out), out);
});

check('comment markers inside a string do not open a comment', () => {
  const out = stripApexNoise("String u = '// not a comment'; DepFixC");
  assert.ok(out.includes('DepFixC'), out);
});

// ------------------------------------------------------------- extractTokens
check('dotted pair tolerates whitespace around the dot', () => {
  const toks = extractTokens('x = Widget__c . Size__c;');
  assert.ok(toks.dottedPairs.includes('Widget__c.Size__c'), JSON.stringify(toks.dottedPairs));
});

check('a dotted chain yields consecutive pairs', () => {
  const toks = extractTokens('alpha.beta.gamma');
  assert.deepStrictEqual(toks.dottedPairs, ['alpha.beta', 'beta.gamma']);
});

check('identifiers dedupe case-insensitively in first-appearance order', () => {
  const toks = extractTokens('DepFixHelper depfixhelper DepFixQueue');
  assert.deepStrictEqual(toks.identifiers, ['DepFixHelper', 'DepFixQueue']);
});

// ------------------------------------------------- transitive chain & cycles
check('chain A → B → C resolves transitively, entry key excluded', async () => {
  const out = await resolve([ITEMS[0]]); // DepFixService
  assert.deepStrictEqual(out, { keys: ['ApexClass:DepFixHelper', 'ApexClass:DepFixQueue'], truncated: false });
});

check('cycle A ⇄ B terminates without repeating either side', async () => {
  const out = await resolve([ITEMS.find(i => i.name === 'AcmeLoopA')]);
  assert.deepStrictEqual(out, { keys: ['ApexClass:AcmeLoopB'], truncated: false });
});

check('multi-entry: entry keys are excluded even when they reference each other', async () => {
  const out = await resolve([ITEMS[0], ITEMS[1]]); // Service + Helper
  assert.deepStrictEqual(out.keys, ['ApexClass:DepFixQueue']);
});

// ------------------------------------------- sObject / field token matching
check('trigger source: __c and __mdt identifiers match CustomObject, Obj.Field matches CustomField', async () => {
  const out = await resolve([ITEMS.find(i => i.name === 'WidgetTrigger')]);
  // Identifiers land before dotted pairs — that per-file order is the contract.
  assert.deepStrictEqual(out.keys, [
    'CustomObject:Widget__c',
    'CustomObject:DepFixRule__mdt',
    'CustomField:Widget__c.Size__c'
  ]);
  assert.strictEqual(out.truncated, false);
});

check('an sObject-suffixed token with no scanned object matches nothing', async () => {
  const entry = item('ApexClass', 'AcmeGhostRef', 'classes/AcmeGhostRef.cls');
  SOURCES.set(entry.filePath, 'public class AcmeGhostRef { Ghost__c g; Phantom__mdt m; }\n');
  const out = await resolve([entry]);
  assert.deepStrictEqual(out.keys, []);
});

// ---------------------------------------------------- platform-name exclusion
check('platform names never match, even against colliding scanned items', async () => {
  // Decoys make the check meaningful: without them, [] would also mean "absent".
  const decoys = [
    item('ApexClass', 'String', 'classes/String.cls'),
    item('ApexClass', 'Account', 'classes/Account.cls'),
    item('CustomField', 'System.debug', 'objects/System/fields/debug.field-meta.xml'),
    item('ApexClass', 'Ab', 'classes/Ab.cls'),
    item('ApexClass', 'DepFixReal', 'classes/DepFixReal.cls')
  ];
  const entry = item('ApexClass', 'AcmePlat', 'classes/AcmePlat.cls');
  SOURCES.set(entry.filePath,
    'public class AcmePlat {\n'
    + '  void go() { String s; System.debug(s); Account a; Ab b; DepFixReal r; }\n'
    + '}\n');
  SOURCES.set(decoys[4].filePath, 'public class DepFixReal {}\n');
  const out = await resolve([entry], undefined, [...ITEMS, ...decoys]);
  // String → APEX_BUILTIN_TYPES, Account → STANDARD_NAMES, System.debug →
  // PLATFORM_NAMESPACES, Ab → under the 3-char floor. Only the real class joins.
  assert.deepStrictEqual(out.keys, ['ApexClass:DepFixReal']);
});

// --------------------------------------------------------------- string blind
check('an identifier inside a string literal is NOT matched', async () => {
  const entry = item('ApexClass', 'AcmeStr', 'classes/AcmeStr.cls');
  SOURCES.set(entry.filePath, "public class AcmeStr { public String label = 'DepFixQueue is fine'; }\n");
  const out = await resolve([entry]);
  assert.deepStrictEqual(out.keys, []);
});

// ------------------------------------------------------------------ depth cap
check('depth cap stops expansion and reports truncation when it cut something', async () => {
  const out = await resolve([ITEMS[0]], { maxDepth: 1 }); // Service → Helper (→ Queue cut)
  assert.deepStrictEqual(out, { keys: ['ApexClass:DepFixHelper'], truncated: true });
});

check('depth cap that cuts nothing reports truncated false (boundary is probed, not guessed)', async () => {
  const out = await resolve([ITEMS[0]], { maxDepth: 2 }); // Queue at depth 2 references nothing
  assert.deepStrictEqual(out, { keys: ['ApexClass:DepFixHelper', 'ApexClass:DepFixQueue'], truncated: false });
});

// ----------------------------------------------------------------- deps cap
check('maxDeps cap trims in discovery order and flags truncated', async () => {
  const entry = item('ApexClass', 'AcmeGenRoot', 'classes/AcmeGenRoot.cls');
  SOURCES.set(entry.filePath, 'public class AcmeGenRoot { AcmeGen0 a; AcmeGen1 b; AcmeGen2 c; }\n');
  const out = await resolve([entry], { maxDeps: 2 });
  assert.deepStrictEqual(out, { keys: ['ApexClass:AcmeGen0', 'ApexClass:AcmeGen1'], truncated: true });
});

check('a set landing exactly on maxDeps is NOT truncated', async () => {
  const entry = item('ApexClass', 'AcmeGenRoot', 'classes/AcmeGenRoot.cls');
  const out = await resolve([entry], { maxDeps: 3 });
  assert.deepStrictEqual(out, { keys: ['ApexClass:AcmeGen0', 'ApexClass:AcmeGen1', 'ApexClass:AcmeGen2'], truncated: false });
});

// ---------------------------------------------------------- non-Apex entries
check('a non-Apex entry is never read, even when its file content would match', async () => {
  const out = await resolve([ITEMS.find(i => i.type === 'Layout')]);
  assert.deepStrictEqual(out, { keys: [], truncated: false });
});

check('a CustomObject entry is a leaf too', async () => {
  const out = await resolve([ITEMS.find(i => i.name === 'Widget__c')]);
  assert.deepStrictEqual(out, { keys: [], truncated: false });
});

// --------------------------------------------------------- casing & resilience
check('case-insensitive matches return the ITEM canonical casing, never the token', async () => {
  const entry = item('ApexClass', 'AcmeCase', 'classes/AcmeCase.cls');
  SOURCES.set(entry.filePath, 'public class AcmeCase { depfixqueue q; Object o = WIDGET__C.SIZE__C; }\n');
  const out = await resolve([entry]);
  assert.deepStrictEqual(out.keys, ['ApexClass:DepFixQueue', 'CustomObject:Widget__c', 'CustomField:Widget__c.Size__c']);
});

check('an unreadable entry file degrades to no deps, never a throw', async () => {
  const entry = item('ApexClass', 'AcmeMissing', 'classes/AcmeMissing.cls'); // no SOURCES entry
  const out = await resolve([entry]);
  assert.deepStrictEqual(out, { keys: [], truncated: false });
});

// ------------------------------------------------------- LWC module scanning
check('scanJsStrings records specifiers but not ones inside comments', () => {
  const scan = scanJsStrings("// import a from 'c/depFixChild'\nimport b from 'c/depFixTile';");
  assert.deepStrictEqual(scan.strings.map(s => s.value), ['c/depFixTile']);
});

check('a specifier nested in another string is part of THAT literal, never its own', () => {
  const scan = scanJsStrings('const s = "import a from \'c/depFixChild\'";');
  assert.deepStrictEqual(scan.strings.map(s => s.value), ["import a from 'c/depFixChild'"]);
  assert.deepStrictEqual(extractLwcModuleRefs('const s = "import a from \'c/depFixChild\'";'), []);
});

check('an unterminated literal is cut at the newline, so the next line still reads', () => {
  const refs = extractLwcModuleRefs("const bad = 'oops\nimport Child from 'c/depFixChild';");
  assert.deepStrictEqual(refs.map(r => r.tries[0].name), ['depFixChild']);
});

check('every @salesforce family maps to the component it addresses', () => {
  const flat = source => extractLwcModuleRefs(source).map(r => r.tries.map(t => `${t.type}:${t.name}`).join('|'));
  assert.deepStrictEqual(flat([
    "import a from '@salesforce/apex/AcmeSvc.method';",
    "import b from '@salesforce/apex/AcmeSvc';",
    "import c from '@salesforce/schema/Widget__c.Size__c';",
    "import d from '@salesforce/schema/Widget__c';",
    "import e from '@salesforce/resourceUrl/AcmeAssets';",
    "import f from 'c/acmeChild';"
  ].join('\n')), [
    'ApexClass:AcmeSvc',
    'ApexClass:AcmeSvc',
    'CustomField:Widget__c.Size__c',
    'CustomObject:Widget__c',
    'StaticResource:AcmeAssets',
    'LightningComponentBundle:acmeChild'
  ]);
});

check('a messageChannel specifier tries the verbatim name before the __c-stripped one', () => {
  const refs = extractLwcModuleRefs("import c from '@salesforce/messageChannel/AcmeChannel__c';");
  assert.deepStrictEqual(refs[0].tries, [
    { type: 'LightningMessageChannel', name: 'AcmeChannel__c' },
    { type: 'LightningMessageChannel', name: 'AcmeChannel' }
  ]);
});

check('a well-formed specifier in data position is not an import', () => {
  assert.deepStrictEqual(extractLwcModuleRefs([
    "const note = '@salesforce/apex/AcmeSvc.run';",
    "track({ module: 'c/acmeChild' });"
  ].join('\n')), []);
});

check('platform, managed and non-c specifiers name nothing', () => {
  assert.deepStrictEqual(extractLwcModuleRefs([
    "import { LightningElement } from 'lwc';",
    "import { NavigationMixin } from 'lightning/navigation';",
    "import x from 'acme/acmeChild';",
    "import y from '@salesforce/apex/acme.AcmeSvc.method';",
    "import z from '@salesforce/label/c.AcmeLabel';",
    "import u from '@salesforce/user/Id';"
  ].join('\n')), []);
});

// ----------------------------------------------------- LWC template scanning
check('a kebab-case child tag addresses the camelCase bundle; comments and non-c tags do not', () => {
  const refs = extractLwcTemplateRefs([
    '<template>',
    '  <!-- <c-dep-fix-hidden></c-dep-fix-hidden> -->',
    '  <lightning-card></lightning-card>',
    '  <c-dep-fix-tile></c-dep-fix-tile>',
    '</template>'
  ].join('\n'));
  assert.deepStrictEqual(refs.map(r => r.tries[0].name), ['depfixtile']);
});

check('stripMarkupComments blanks the span without fusing the markup around it', () => {
  const out = stripMarkupComments('<a/><!-- <c:Hidden/> --><b/>');
  assert.ok(!out.includes('Hidden'), out);
  assert.ok(/<a\/>\s+<b\/>/.test(out), out);
});

// ------------------------------------------------------------ Aura scanning
check('Aura markup: c: references in appearance order, then the Apex controller', () => {
  const refs = extractAuraRefs([
    '<aura:component controller="AcmeCtrl" extends="c:AcmeBase" implements="force:appHostable">',
    '  <!-- <c:AcmeHidden/> -->',
    '  <c:acmeTile/>',
    '  <lightning:card title="AcmeSvc"/>',
    '</aura:component>'
  ].join('\n'));
  assert.deepStrictEqual(refs.map(r => r.tries.map(t => `${t.type}:${t.name}`).join('|')), [
    'AuraDefinitionBundle:AcmeBase|LightningComponentBundle:AcmeBase',
    'AuraDefinitionBundle:acmeTile|LightningComponentBundle:acmeTile',
    'ApexClass:AcmeCtrl'
  ]);
});

check('a namespace-qualified controller resolves on its last segment', () => {
  const refs = extractAuraRefs('<aura:component controller="acme.AcmeCtrl"/>');
  assert.deepStrictEqual(refs, [{ tries: [{ type: 'ApexClass', name: 'AcmeCtrl' }] }]);
});

// ------------------------------------------------------- bundle resolution
check('an LWC bundle resolves every declared reference and expands child bundles', async () => {
  const out = await resolve([byName('depFixCard')]);
  assert.deepStrictEqual(out, {
    keys: [
      // depFixCard.js, in specifier order …
      'ApexClass:DepFixHelper',
      'ApexClass:DepFixQueue',
      'CustomField:Widget__c.Size__c',
      'CustomObject:Widget__c',
      'LightningMessageChannel:DepFixChannel',
      'StaticResource:DepFixAssets',
      'LightningComponentBundle:depFixChild',
      // … then depFixCard.html (.js is read before .html) …
      'LightningComponentBundle:depFixTile',
      // … then the child bundle's own import.
      'ApexClass:AcmeGen0'
    ],
    truncated: false
  });
  // The absent names are the decoys: AcmeGen1/AcmeGen2/AcmeLoopA sit in a
  // comment or a string, DepFixService only in files that are never read, and
  // depFixHidden only inside an HTML comment.
  for (const gone of ['ApexClass:AcmeGen1', 'ApexClass:AcmeGen2', 'ApexClass:AcmeLoopA',
    'ApexClass:DepFixService', 'LightningComponentBundle:depFixHidden']) {
    assert.ok(!out.keys.includes(gone), `${gone} should not be included`);
  }
});

check('jest files inside a bundle are never read (they are never deployed either)', async () => {
  const entry = bundle('LightningComponentBundle', 'depFixSpec', 'lwc/depFixSpec',
    ['depFixSpec.js', '__tests__/depFixSpec.test.js', '__mocks__/apexStub.js']);
  src('lwc/depFixSpec', 'depFixSpec.js', ["import q from '@salesforce/apex/DepFixQueue.run';"]);
  src('lwc/depFixSpec', '__tests__/depFixSpec.test.js', ["import a from '@salesforce/apex/AcmeGen1.run';"]);
  src('lwc/depFixSpec', '__mocks__/apexStub.js', ["import b from '@salesforce/apex/AcmeGen2.run';"]);
  const out = await resolve([entry]);
  assert.deepStrictEqual(out, { keys: ['ApexClass:DepFixQueue'], truncated: false });
});

check('a child-component cycle terminates and never reports the entry', async () => {
  const out = await resolve([byName('depFixLoopA')]);
  assert.deepStrictEqual(out, { keys: ['LightningComponentBundle:depFixLoopB'], truncated: false });
});

check('an Aura bundle resolves c: tags (Aura or LWC) and its Apex controller', async () => {
  const out = await resolve([byName('DepFixPanel')]);
  assert.deepStrictEqual(out, {
    keys: [
      'AuraDefinitionBundle:DepFixBase',      // extends="c:DepFixBase"
      'LightningComponentBundle:depFixTile',  // <c:depFixTile/> — an Aura tag can address an LWC
      'ApexClass:DepFixHelper',               // controller="DepFixHelper"
      'ApexClass:AcmeGen0',                   // via the tile's own import
      'ApexClass:DepFixQueue'                 // via the controller class
    ],
    truncated: false
  });
  // DepFixService appears only in the bundle's controller .js and in a title
  // attribute; DepFixHidden only inside a markup comment.
  assert.ok(!out.keys.includes('ApexClass:DepFixService'), out.keys.join(','));
  assert.ok(!out.keys.includes('AuraDefinitionBundle:DepFixHidden'), out.keys.join(','));
});

check('bundle references resolve case-insensitively and return the ITEM casing', async () => {
  const entry = bundle('LightningComponentBundle', 'depFixCase', 'lwc/depFixCase', ['depFixCase.js']);
  src('lwc/depFixCase', 'depFixCase.js', [
    "import q from '@salesforce/apex/DEPFIXQUEUE.run';",
    "import child from 'c/DEPFIXCHILD';",
    "import f from '@salesforce/schema/WIDGET__C.SIZE__C';"
  ]);
  const out = await resolve([entry]);
  assert.deepStrictEqual(out.keys, [
    'ApexClass:DepFixQueue',
    'LightningComponentBundle:depFixChild',
    'CustomField:Widget__c.Size__c'
  ]);
});

check('a declared reference to a platform name is still excluded', async () => {
  // Decoys again: without a scanned Account/Account.Name, [] would also mean "absent".
  const decoys = [
    item('CustomObject', 'Account', 'objects/Account'),
    item('CustomField', 'Account.Name', 'objects/Account/fields/Name.field-meta.xml')
  ];
  const entry = bundle('LightningComponentBundle', 'depFixPlat', 'lwc/depFixPlat', ['depFixPlat.js']);
  src('lwc/depFixPlat', 'depFixPlat.js', [
    "import n from '@salesforce/schema/Account.Name';",
    "import a from '@salesforce/schema/Account';",
    "import s from '@salesforce/schema/Widget__c.Size__c';"
  ]);
  const out = await resolve([entry], undefined, [...ITEMS, ...decoys]);
  assert.deepStrictEqual(out.keys, ['CustomField:Widget__c.Size__c']);
});

// ------------------------------------------------------------- bundle caps
check('maxBundleFiles trims the read list (in rank/path order) and flags truncated', async () => {
  // `files` is deliberately unsorted: the reader orders it, the scan does not.
  const entry = bundle('LightningComponentBundle', 'depFixWide', 'lwc/depFixWide',
    ['extra.html', 'depFixWide.html', 'depFixWide.js']);
  src('lwc/depFixWide', 'depFixWide.js', ["import g from '@salesforce/apex/AcmeGen0.ping';"]);
  src('lwc/depFixWide', 'depFixWide.html', ['<template><c-dep-fix-child></c-dep-fix-child></template>']);
  src('lwc/depFixWide', 'extra.html', ['<template><c-dep-fix-tile></c-dep-fix-tile></template>']);
  const cut = await resolve([entry], { maxBundleFiles: 1 });
  assert.deepStrictEqual(cut, { keys: ['ApexClass:AcmeGen0'], truncated: true });
  const whole = await resolve([entry], { maxBundleFiles: 3 });
  assert.deepStrictEqual(whole, {
    keys: ['ApexClass:AcmeGen0', 'LightningComponentBundle:depFixChild', 'LightningComponentBundle:depFixTile'],
    truncated: false
  });
});

check('the depth cap applies to bundle expansion too', async () => {
  const out = await resolve([byName('depFixCard')], { maxDepth: 1 });
  assert.strictEqual(out.keys.length, 8); // everything depFixCard itself declares
  assert.ok(!out.keys.includes('ApexClass:AcmeGen0'), out.keys.join(','));
  assert.strictEqual(out.truncated, true); // the tile's own import is what got cut
});

// ------------------------------------------------------- scannable-type gate
check('canScanDependencies accepts exactly the types with readable source', () => {
  for (const t of ['ApexClass', 'ApexTrigger', 'LightningComponentBundle', 'AuraDefinitionBundle']) {
    assert.strictEqual(canScanDependencies(t), true, t);
  }
  for (const t of ['CustomObject', 'CustomField', 'Layout', 'Flow', 'StaticResource', 'LightningMessageChannel']) {
    assert.strictEqual(canScanDependencies(t), false, t);
  }
});

check('a bundle entry with no readable file degrades to no deps, never a throw', async () => {
  const entry = bundle('LightningComponentBundle', 'depFixBare', 'lwc/depFixBare', ['depFixBare.js-meta.xml']);
  const out = await resolve([entry]);
  assert.deepStrictEqual(out, { keys: [], truncated: false });
});

(async () => {
  for (const { name, fn } of checks) {
    ran++;
    try { await fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
  }
  if (failed) { console.error(`\n${failed} of ${ran} check(s) failed`); process.exit(1); }
  console.log(`depGraph: all ${ran} checks passed`);
})();
