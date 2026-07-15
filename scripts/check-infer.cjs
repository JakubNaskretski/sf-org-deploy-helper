// Runnable check for inferItemForPath (metadataScanner.ts). No framework.
//   1) npm run compile   2) node scripts/check-infer.cjs
// Stubs the `vscode` import (inferItemForPath is pure path logic, never touches it).
const path = require('path');
const assert = require('assert');
const Module = require('module');
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? {} : origLoad(req, ...rest));

const { inferItemForPath, parseManifestTypes, deriveRule, findItemForPath, foldPathKey, detectMissingDependencies } = require(path.join(__dirname, '..', 'out', 'metadataScanner.js'));
const p = (...s) => s.join(path.sep); // build OS-native paths

const cases = [
  // [input path, expected type, expected name, expected filePath (default = input)]
  [p('any', 'where', 'classes', 'MyClass.cls'), 'ApexClass', 'MyClass'],
  [p('x', 'classes', 'MyClass.cls-meta.xml'), 'ApexClass', 'MyClass'],
  [p('x', 'classes', 'sub', 'Deep.cls'), 'ApexClass', 'Deep'], // org-hint subfolder
  [p('x', 'triggers', 'T.trigger'), 'ApexTrigger', 'T'],
  [p('x', 'layouts', 'Foo__mdt-Some Layout.layout-meta.xml'), 'Layout', 'Foo__mdt-Some Layout'],
  [p('x', 'permissionsets', 'Admin.permissionset-meta.xml'), 'PermissionSet', 'Admin'],
  [p('x', 'flexipages', 'Home.flexipage-meta.xml'), 'FlexiPage', 'Home'],
  [p('x', 'platformEventSubscriberConfigs', 'nameSmth.platformEventSubscriberConfig-meta.xml'), 'PlatformEventSubscriberConfig', 'nameSmth'],
  // bundles: component is the bundle dir, regardless of which inner file was clicked
  [p('a', 'lwc', 'myCmp', 'myCmp.js'), 'LightningComponentBundle', 'myCmp', p('a', 'lwc', 'myCmp')],
  [p('a', 'lwc', 'myCmp', 'sub', 'helper.js'), 'LightningComponentBundle', 'myCmp', p('a', 'lwc', 'myCmp')],
  [p('a', 'aura', 'myApp', 'myApp.cmp'), 'AuraDefinitionBundle', 'myApp', p('a', 'aura', 'myApp')],
  // object children → Object.Child
  [p('o', 'objects', 'Account', 'fields', 'My__c.field-meta.xml'), 'CustomField', 'Account.My__c'],
  [p('o', 'objects', 'Account', 'validationRules', 'R.validationRule-meta.xml'), 'ValidationRule', 'Account.R'],
  [p('o', 'objects', 'Account', 'Account.object-meta.xml'), 'CustomObject', 'Account'],
  // nested email template → Folder/Name
  [p('e', 'email', 'Marketing', 'Welcome.email'), 'EmailTemplate', 'Marketing/Welcome'],
  [p('e', 'email', 'Marketing', 'Welcome.email-meta.xml'), 'EmailTemplate', 'Marketing/Welcome'],
];

let failed = 0;
for (const [input, type, name, filePath] of cases) {
  const got = inferItemForPath(input);
  try {
    assert.ok(got, `expected a match for ${input}`);
    assert.strictEqual(got.type, type, `type for ${input}`);
    assert.strictEqual(got.name, name, `name for ${input}`);
    assert.strictEqual(got.filePath, filePath ?? input, `filePath for ${input}`);
  } catch (e) {
    failed++;
    console.error('FAIL:', e.message, '— got', JSON.stringify(got));
  }
}
// Non-metadata files must not be inferred. Includes a bare email/<Name>.email with no
// folder — it has no valid EmailTemplate fullName, so it must NOT infer a bogus name.
const noMatch = [p('x', 'README.md'), p('x', 'src', 'foo.ts'), p('x', 'classes'), p('e', 'email', 'Welcome.email')];
for (const input of noMatch) {
  if (inferItemForPath(input) !== undefined) { failed++; console.error('FAIL: expected no match for', input); }
}

// Learned (extra) rules must extend inferItemForPath exactly like static ones.
const learned = [{ folder: 'xyzzyConfigs', type: 'XyzzyConfig', primaryExt: ['.xyzzyConfig-meta.xml'] }];
{
  const input = p('x', 'xyzzyConfigs', 'A.xyzzyConfig-meta.xml');
  const got = inferItemForPath(input, learned);
  try {
    assert.ok(got, `expected learned-rule match for ${input}`);
    assert.strictEqual(got.type, 'XyzzyConfig');
    assert.strictEqual(got.name, 'A');
    assert.strictEqual(inferItemForPath(input), undefined, 'must NOT match without the learned rule');
  } catch (e) { failed++; console.error('FAIL:', e.message); }
}

// parseManifestTypes: real CLI output shape (verified live, sf 2.137.7).
{
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types>
        <members>nameSmth</members>
        <members>other</members>
        <name>PlatformEventSubscriberConfig</name>
    </types>
    <types>
        <members>Acme</members>
        <name>ApexClass</name>
    </types>
    <version>61.0</version>
</Package>`;
  try {
    assert.deepStrictEqual(parseManifestTypes(xml), [
      { type: 'PlatformEventSubscriberConfig', members: ['nameSmth', 'other'] },
      { type: 'ApexClass', members: ['Acme'] }
    ]);
    assert.deepStrictEqual(parseManifestTypes('<Package></Package>'), []);
  } catch (e) { failed++; console.error('FAIL parseManifestTypes:', e.message); }
}

// deriveRule: suffix generalization + the shapes that must NOT generalize.
try {
  assert.deepStrictEqual(
    deriveRule('platformEventSubscriberConfigs', 'PlatformEventSubscriberConfig', ['nameSmth'], ['nameSmth.platformEventSubscriberConfig-meta.xml']),
    { folder: 'platformEventSubscriberConfigs', type: 'PlatformEventSubscriberConfig', primaryExt: ['.platformEventSubscriberConfig-meta.xml'] }
  );
  // content/meta pair → prefer the -meta.xml suffix
  assert.deepStrictEqual(
    deriveRule('discovery', 'DiscoveryAIModel', ['M'], ['M.model', 'M.model-meta.xml']).primaryExt,
    ['.model-meta.xml']
  );
  // bundle member (directory, no dot-suffix file) → no rule
  assert.strictEqual(deriveRule('waveTemplates', 'WaveTemplateBundle', ['MyTpl'], ['MyTpl']), undefined);
  // content-only suffix (no -meta.xml sidecar in list) → no rule; a generic
  // suffix like '.xml' must never be learned (would scoop unrelated files)
  assert.strictEqual(deriveRule('fooBars', 'FooBar', ['M'], ['M.foobar']), undefined);
  assert.strictEqual(deriveRule('things', 'Thing', ['M'], ['M.xml']), undefined);
  // nested fullName → no rule
  assert.strictEqual(deriveRule('reports', 'Report', ['Folder/Rep'], ['Rep.report-meta.xml']), undefined);
  // member not prefixing any file → no rule
  assert.strictEqual(deriveRule('somemadeup', 'Whatever', ['A'], ['B.x-meta.xml']), undefined);
} catch (e) { failed++; console.error('FAIL deriveRule:', e.message); }

// foldPathKey + findItemForPath case-folding. Windows filesystems are
// case-insensitive and VS Code's URI sources disagree about drive-letter casing;
// the platform param lets us exercise win32 folding on this non-Windows host.
try {
  // win32: normalize + lowercase, so a case/drive-letter drift folds together
  // (the exact drive-letter case from the audit).
  assert.strictEqual(foldPathKey('C:\\Ws\\a.CLS', 'win32'), foldPathKey('c:\\ws\\A.cls', 'win32'), 'win32 fold must ignore case');
  // darwin: normalize only — case preserved (case-sensitive filesystem).
  const dwn = p('Ws', 'A.CLS');
  assert.strictEqual(foldPathKey(dwn, 'darwin'), path.normalize(dwn), 'darwin fold must keep case');
  assert.notStrictEqual(foldPathKey(p('Ws', 'A.CLS'), 'darwin'), foldPathKey(p('Ws', 'a.cls'), 'darwin'), 'darwin treats differing case as different');

  // findItemForPath honors the fold: a mis-cased query matches under win32, not darwin.
  const item = {
    type: 'ApexClass', name: 'MyClass',
    filePath: p('Ws', 'classes', 'MyClass.cls'),
    files: [p('Ws', 'classes', 'MyClass.cls'), p('Ws', 'classes', 'MyClass.cls-meta.xml')]
  };
  const items = [item];
  // pass 1 (exact primary file), pass 2 (listed sidecar) — mis-cased, win32 matches
  assert.strictEqual(findItemForPath(items, p('ws', 'CLASSES', 'myclass.cls'), 'win32'), item, 'win32 primary-file fold');
  assert.strictEqual(findItemForPath(items, p('WS', 'classes', 'MyClass.CLS-META.XML'), 'win32'), item, 'win32 listed-file fold');
  // darwin: same mis-cased query must NOT match; exact case still does (control)
  assert.strictEqual(findItemForPath(items, p('ws', 'CLASSES', 'myclass.cls'), 'darwin'), undefined, 'darwin must not fold case');
  assert.strictEqual(findItemForPath(items, p('Ws', 'classes', 'MyClass.cls'), 'darwin'), item, 'darwin exact match');
  // pass 3 (containing bundle folder) — mis-cased dir prefix, win32 matches, darwin doesn't
  const bundle = { type: 'LightningComponentBundle', name: 'myCmp', filePath: p('Ws', 'lwc', 'myCmp'), files: [] };
  assert.strictEqual(findItemForPath([bundle], p('ws', 'LWC', 'MYCMP', 'myCmp.js'), 'win32'), bundle, 'win32 bundle-dir fold');
  assert.strictEqual(findItemForPath([bundle], p('ws', 'LWC', 'MYCMP', 'myCmp.js'), 'darwin'), undefined, 'darwin bundle-dir no fold');
} catch (e) { failed++; console.error('FAIL foldPathKey/findItemForPath:', e.message); }

// detectMissingDependencies: org-reported failures resolved against LOCAL items
// only — the error text alone can never mint a key for a component that isn't
// really part of this workspace's scan.
try {
  const items = [
    { type: 'QuickAction', name: 'Account.Foo', filePath: p('x', 'quickActions', 'Account.Foo.quickAction-meta.xml'), files: [] },
    { type: 'ApexClass', name: 'MyHelper', filePath: p('x', 'classes', 'MyHelper.cls'), files: [] }
  ];
  // "no X named Y found" — e.g. a FlexiPage failing to find a QuickAction it references.
  const qaProblem = 'In field: action - no QuickAction named Account.Foo found';
  assert.deepStrictEqual(
    detectMissingDependencies([qaProblem], items, new Set()),
    ['QuickAction:Account.Foo'],
    'QuickAction dependency resolves when the item exists locally'
  );
  // Unresolvable — no matching local item — must yield nothing: a hostile or merely
  // unknown problem string can't mint a key for a component that isn't really there.
  assert.deepStrictEqual(
    detectMissingDependencies(['no BogusType named Nothing.Here found'], items, new Set()),
    [],
    'hostile/unresolvable name yields nothing'
  );
  // Already part of THIS deploy's own key set — it failed for some OTHER reason,
  // it's not "missing", so it must be excluded.
  assert.deepStrictEqual(
    detectMissingDependencies([qaProblem], items, new Set(['QuickAction:Account.Foo'])),
    [],
    'already-deployed key excluded'
  );
  // Recompilation pattern maps to the local ApexClass.
  assert.deepStrictEqual(
    detectMissingDependencies(
      ['Dependent class is invalid and needs recompilation: Class MyHelper: Invalid type: Bar'],
      items, new Set()
    ),
    ['ApexClass:MyHelper'],
    'recompilation pattern maps to the local ApexClass'
  );
  // Case-insensitive fallback: org text differs in NAME casing only (type stays
  // exact) — the result uses the ITEM's canonical local casing, never the error
  // text's.
  assert.deepStrictEqual(
    detectMissingDependencies(['no QuickAction named account.foo found'], items, new Set()),
    ['QuickAction:Account.Foo'],
    'case-insensitive name fallback returns the canonical local casing'
  );
  // Dedupe + first-seen order across multiple problem strings / patterns.
  assert.deepStrictEqual(
    detectMissingDependencies(
      [qaProblem, qaProblem, 'Dependent class is invalid and needs recompilation: Class MyHelper: x'],
      items, new Set()
    ),
    ['QuickAction:Account.Foo', 'ApexClass:MyHelper'],
    'dedupes and preserves first-seen order'
  );
} catch (e) { failed++; console.error('FAIL detectMissingDependencies:', e.message); }

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log(`inferItemForPath/parseManifestTypes/deriveRule/foldPathKey/detectMissingDependencies: all checks passed (${cases.length + noMatch.length} infer cases + learned-rule + parser + derive + fold + dependency-detector)`);
