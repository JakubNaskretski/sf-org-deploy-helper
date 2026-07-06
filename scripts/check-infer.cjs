// Runnable check for inferItemForPath (metadataScanner.ts). No framework.
//   1) npm run compile   2) node scripts/check-infer.cjs
// Stubs the `vscode` import (inferItemForPath is pure path logic, never touches it).
const path = require('path');
const assert = require('assert');
const Module = require('module');
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? {} : origLoad(req, ...rest));

const { inferItemForPath, parseManifestTypes, deriveRule } = require(path.join(__dirname, '..', 'out', 'metadataScanner.js'));
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

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log(`inferItemForPath/parseManifestTypes/deriveRule: all checks passed (${cases.length + noMatch.length} infer cases + learned-rule + parser + derive)`);
