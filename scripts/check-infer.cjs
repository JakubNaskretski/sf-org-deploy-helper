// Runnable check for inferItemForPath (metadataScanner.ts). No framework.
//   1) npm run compile   2) node scripts/check-infer.cjs
// Stubs the `vscode` import (inferItemForPath is pure path logic, never touches it).
const path = require('path');
const assert = require('assert');
const Module = require('module');
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? {} : origLoad(req, ...rest));

const { inferItemForPath } = require(path.join(__dirname, '..', 'out', 'metadataScanner.js'));
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

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log(`inferItemForPath: all ${cases.length + noMatch.length} checks passed`);
