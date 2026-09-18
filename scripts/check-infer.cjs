// Runnable check for inferItemForPath (metadataScanner.ts). No framework.
//   1) npm run compile   2) node scripts/check-infer.cjs
// Stubs the `vscode` import (inferItemForPath is pure path logic, never touches it).
const path = require('path');
const assert = require('assert');
const Module = require('module');
const origLoad = Module._load;
// scanWorkspace (the OmniStudio end-to-end case at the bottom) needs project
// discovery — workspaceFolders + findFiles pointed at a temp project. Everything
// else here is pure path logic and never touches the stub.
const ws = { folders: [], projectFiles: [] };
const vscodeStub = {
  workspace: {
    get workspaceFolders() { return ws.folders; },
    findFiles: async () => ws.projectFiles.map(f => ({ fsPath: f })),
    asRelativePath: uri => uri.fsPath
  },
  RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
  Uri: { file: fsPath => ({ fsPath, scheme: 'file' }) }
};
Module._load = (req, ...rest) => (req === 'vscode' ? vscodeStub : origLoad(req, ...rest));

const { inferItemForPath, parseManifestTypes, deriveRule, deriveRulesForTypes, findItemForPath, isProjectNotFound, retryProjectNotFound, foldPathKey, detectMissingDependencies, selectProjectRoot, listMetaFileNames, detectDataPackExports, scanWorkspace, DATAPACK_WARNING } = require(path.join(__dirname, '..', 'out', 'metadataScanner.js'));
const p = (...s) => s.join(path.sep); // build OS-native paths
let failed = 0;

// Project-root selection: the opened workspace may be a parent of the real SFDX
// project, but zero/multiple project files must never produce a guessed cwd.
try {
  assert.deepStrictEqual(selectProjectRoot([]), { root: undefined, projectFiles: [] });
  const nestedConfig = p('workspace', 'nested', 'salesforce-app', 'sfdx-project.json');
  assert.deepStrictEqual(selectProjectRoot([nestedConfig]), {
    root: p('workspace', 'nested', 'salesforce-app'),
    projectFiles: [nestedConfig]
  });
  // Overlapping VS Code workspace folders can return the same file twice; that is
  // still one project, not an ambiguity.
  assert.deepStrictEqual(selectProjectRoot([nestedConfig, nestedConfig]), {
    root: p('workspace', 'nested', 'salesforce-app'),
    projectFiles: [nestedConfig]
  });
  const otherConfig = p('workspace', 'other-app', 'sfdx-project.json');
  const multiple = selectProjectRoot([otherConfig, nestedConfig]);
  assert.strictEqual(multiple.root, undefined, 'multiple projects must not select a cwd');
  assert.deepStrictEqual(multiple.projectFiles, [nestedConfig, otherConfig].sort((a, b) => a.localeCompare(b)));
} catch (e) { failed++; console.error('FAIL selectProjectRoot:', e.message); }

const cases = [
  // [input path, expected type, expected name, expected filePath (default = input)]
  [p('any', 'where', 'classes', 'MyClass.cls'), 'ApexClass', 'MyClass'],
  [p('x', 'classes', 'MyClass.cls-meta.xml'), 'ApexClass', 'MyClass'],
  [p('x', 'classes', 'sub', 'Deep.cls'), 'ApexClass', 'Deep'], // org-hint subfolder
  [p('x', 'triggers', 'T.trigger'), 'ApexTrigger', 'T'],
  [p('x', 'layouts', 'Foo__mdt-Some Layout.layout-meta.xml'), 'Layout', 'Foo__mdt-Some Layout'],
  [p('x', 'permissionsets', 'Admin.permissionset-meta.xml'), 'PermissionSet', 'Admin'],
  [p('x', 'flexipages', 'Home.flexipage-meta.xml'), 'FlexiPage', 'Home'],
  // Registry spelling (capital P). The rule once said `platformEventSubscriberConfigs`
  // and this line agreed with it, so the harness confirmed the typo: the scan still
  // found the files on macOS, but with the rule's spelling in the path, and the
  // Changed view — matching vscode.git's on-disk path — never saw the component.
  [p('x', 'PlatformEventSubscriberConfigs', 'nameSmth.platformEventSubscriberConfig-meta.xml'), 'PlatformEventSubscriberConfig', 'nameSmth'],
  // Folder case drift in either direction is matched case-insensitively; the
  // suffix stays exact.
  [p('x', 'platformeventsubscriberconfigs', 'nameSmth.platformEventSubscriberConfig-meta.xml'), 'PlatformEventSubscriberConfig', 'nameSmth'],
  [p('x', 'Classes', 'Odd.cls'), 'ApexClass', 'Odd'],
  [p('x', 'LWC', 'myCmp', 'myCmp.js'), 'LightningComponentBundle', 'myCmp', p('x', 'LWC', 'myCmp')],
  [p('x', 'Objects', 'Account', 'Fields', 'My__c.field-meta.xml'), 'CustomField', 'Account.My__c'],
  [p('x', 'Email', 'Marketing', 'Welcome.email'), 'EmailTemplate', 'Marketing/Welcome'],
  // OmniStudio standard-runtime types: static RULES, so NO learned rule is passed
  // here — a tree that only knew them through the registry cache lost every row
  // on the first silent rescan after the cache expired.
  [p('x', 'omniScripts', 'Widget_Intake_English_1.os-meta.xml'), 'OmniScript', 'Widget_Intake_English_1'],
  [p('x', 'omniIntegrationProcedures', 'Widget_Fetch_1.oip-meta.xml'), 'OmniIntegrationProcedure', 'Widget_Fetch_1'],
  [p('x', 'omniDataTransforms', 'WidgetTransform.rpt-meta.xml'), 'OmniDataTransform', 'WidgetTransform'],
  [p('x', 'omniUiCard', 'WidgetCard_1.ouc-meta.xml'), 'OmniUiCard', 'WidgetCard_1'],
  [p('x', 'omniScripts', 'orgHint', 'Widget_Intake_English_2.os-meta.xml'), 'OmniScript', 'Widget_Intake_English_2'], // org-hint subfolder
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
  // deriveRulesForTypes — multi-type folder (wave/): one rule per type when unambiguous
  const WAVE_FILES = ['Sales.wds-meta.xml', 'Board.wdash-meta.xml', 'Board.wdash', 'Sales.wds'];
  assert.deepStrictEqual(
    deriveRulesForTypes('wave', [{ type: 'WaveDataset', members: ['Sales'] }, { type: 'WaveDashboard', members: ['Board'] }], WAVE_FILES),
    [{ folder: 'wave', type: 'WaveDataset', primaryExt: ['.wds-meta.xml'] }, { folder: 'wave', type: 'WaveDashboard', primaryExt: ['.wdash-meta.xml'] }]
  );
  // same-named member in two types → both suffixes bind → refused wholesale
  assert.strictEqual(
    deriveRulesForTypes('wave', [{ type: 'WaveDataset', members: ['Same'] }, { type: 'WaveDashboard', members: ['Same'] }], ['Same.wds-meta.xml', 'Same.wdash-meta.xml']),
    undefined
  );
  // a type with no derivable file → refused (never a partial rule set)
  assert.strictEqual(
    deriveRulesForTypes('wave', [{ type: 'WaveDataset', members: ['Sales'] }, { type: 'WaveLens', members: ['L'] }], ['Sales.wds-meta.xml', 'L.wlens']),
    undefined
  );
  // two types claiming one suffix → refused; nested members ignored
  assert.strictEqual(
    deriveRulesForTypes('x', [{ type: 'A', members: ['A1'] }, { type: 'B', members: ['B1'] }], ['A1.thing-meta.xml', 'B1.thing-meta.xml']),
    undefined
  );
  assert.deepStrictEqual(deriveRulesForTypes('x', [{ type: 'A', members: ['Folder/A1'] }], ['A1.a-meta.xml']), undefined);
  // nested fullName → no rule
  assert.strictEqual(deriveRule('reports', 'Report', ['Folder/Rep'], ['Rep.report-meta.xml']), undefined);
  // member not prefixing any file → no rule
  assert.strictEqual(deriveRule('somemadeup', 'Whatever', ['A'], ['B.x-meta.xml']), undefined);
} catch (e) { failed++; console.error('FAIL deriveRule:', e.message); }

// deriveRule for OmniStudio: the registry answers with the file stem as the member
// and a `<stem>.<suffix>-meta.xml` file. One rule per suffix must derive, so the
// learned path keeps working for a registry newer than the static table.
try {
  for (const [folder, type, member, suffix] of [
    ['omniScripts', 'OmniScript', 'Widget_Intake_English_1', '.os-meta.xml'],
    ['omniIntegrationProcedures', 'OmniIntegrationProcedure', 'Widget_Fetch_1', '.oip-meta.xml'],
    ['omniDataTransforms', 'OmniDataTransform', 'WidgetTransform', '.rpt-meta.xml'],
    ['omniUiCard', 'OmniUiCard', 'WidgetCard_1', '.ouc-meta.xml']
  ]) {
    assert.deepStrictEqual(deriveRule(folder, type, [member], [member + suffix]), { folder, type, primaryExt: [suffix] }, folder);
  }
  // Real `sf project generate manifest --source-dir omniScripts` output (sf 2.137.7)
  // → the members feed deriveRule exactly as learnRulesForFolders does.
  const omniXml = `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types>
        <members>Widget_Intake_English_1</members>
        <name>OmniScript</name>
    </types>
    <version>61.0</version>
</Package>`;
  const [t] = parseManifestTypes(omniXml);
  assert.deepStrictEqual(deriveRule('omniScripts', t.type, t.members, ['Widget_Intake_English_1.os-meta.xml']),
    { folder: 'omniScripts', type: 'OmniScript', primaryExt: ['.os-meta.xml'] });
  // Org-hint layout: a flat readdir of the folder sees only the subfolder NAME and
  // derives nothing (the 7-day negative-cache trap); the recursive basenames
  // listMetaFileNames hands over do derive.
  assert.strictEqual(deriveRule('omniIntegrationProcedures', 'OmniIntegrationProcedure', ['Widget_Fetch_1'], ['orgHint']), undefined,
    'a subfolder name must not derive a rule');
  assert.deepStrictEqual(deriveRule('omniIntegrationProcedures', 'OmniIntegrationProcedure', ['Widget_Fetch_1'], ['Widget_Fetch_1.oip-meta.xml']).primaryExt, ['.oip-meta.xml']);
} catch (e) { failed++; console.error('FAIL deriveRule (OmniStudio):', e.message); }

// foldPathKey + findItemForPath case-folding. Windows AND macOS filesystems are
// case-insensitive by default, and VS Code's URI sources disagree about casing
// (drive letters; a differently-cased opened folder); Linux stays exact. The
// platform param lets us exercise every fold on this one host.
try {
  // win32 / darwin: normalize + lowercase, so a case or drive-letter drift folds
  // together — vscode.git and the scan disagree on both.
  assert.strictEqual(foldPathKey('C:\\Ws\\a.CLS', 'win32'), foldPathKey('c:\\ws\\A.cls', 'win32'), 'win32 fold must ignore case');
  assert.strictEqual(foldPathKey(p('Ws', 'A.CLS'), 'darwin'), foldPathKey(p('ws', 'a.cls'), 'darwin'), 'darwin fold must ignore case');
  // linux: normalize only — case preserved (case-sensitive filesystem).
  const lnx = p('Ws', 'A.CLS');
  assert.strictEqual(foldPathKey(lnx, 'linux'), path.normalize(lnx), 'linux fold must keep case');
  assert.notStrictEqual(foldPathKey(p('Ws', 'A.CLS'), 'linux'), foldPathKey(p('Ws', 'a.cls'), 'linux'), 'linux treats differing case as different');

  // findItemForPath honors the fold: a mis-cased query matches under win32 and darwin, not linux.
  const item = {
    type: 'ApexClass', name: 'MyClass',
    filePath: p('Ws', 'classes', 'MyClass.cls'),
    files: [p('Ws', 'classes', 'MyClass.cls'), p('Ws', 'classes', 'MyClass.cls-meta.xml')]
  };
  const items = [item];
  for (const plat of ['win32', 'darwin']) {
    // pass 1 (exact primary file), pass 2 (listed sidecar) — mis-cased, folded platforms match
    assert.strictEqual(findItemForPath(items, p('ws', 'CLASSES', 'myclass.cls'), plat), item, `${plat} primary-file fold`);
    assert.strictEqual(findItemForPath(items, p('WS', 'classes', 'MyClass.CLS-META.XML'), plat), item, `${plat} listed-file fold`);
  }
  // linux: same mis-cased query must NOT match; exact case still does (control)
  assert.strictEqual(findItemForPath(items, p('ws', 'CLASSES', 'myclass.cls'), 'linux'), undefined, 'linux must not fold case');
  assert.strictEqual(findItemForPath(items, p('Ws', 'classes', 'MyClass.cls'), 'linux'), item, 'linux exact match');
  // pass 3 (containing bundle folder) — mis-cased dir prefix, folded platforms match, linux doesn't
  const bundle = { type: 'LightningComponentBundle', name: 'myCmp', filePath: p('Ws', 'lwc', 'myCmp'), files: [] };
  assert.strictEqual(findItemForPath([bundle], p('ws', 'LWC', 'MYCMP', 'myCmp.js'), 'win32'), bundle, 'win32 bundle-dir fold');
  assert.strictEqual(findItemForPath([bundle], p('ws', 'LWC', 'MYCMP', 'myCmp.js'), 'darwin'), bundle, 'darwin bundle-dir fold');
  assert.strictEqual(findItemForPath([bundle], p('ws', 'LWC', 'MYCMP', 'myCmp.js'), 'linux'), undefined, 'linux bundle-dir no fold');
} catch (e) { failed++; console.error('FAIL foldPathKey/findItemForPath:', e.message); }

// detectMissingDependencies: shape contract only — the exhaustive pattern and
// resolution cases live in scripts/check-missing-deps.cjs.
try {
  const items = [
    { type: 'QuickAction', name: 'Account.Foo', filePath: p('x', 'quickActions', 'Account.Foo.quickAction-meta.xml'), files: [] }
  ];
  const out = detectMissingDependencies(['In field: action - no QuickAction named Account.Foo found'], items, new Set());
  assert.deepStrictEqual(out, { keys: ['QuickAction:Account.Foo'], unresolved: [] }, 'returns {keys, unresolved}');
} catch (e) { failed++; console.error('FAIL detectMissingDependencies:', e.message); }

// The filesystem-backed contracts — listMetaFileNames, detectDataPackExports and
// the whole scan over an OmniStudio project — run on a temp tree.
(async () => {
  const fsp = require('fs/promises');
  const os = require('os');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sf-check-infer-'));
  const w = async (rel, body = '<x/>') => {
    const abs = path.join(tmp, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, body, 'utf8');
  };

  // listMetaFileNames: recursive, basenames only, -meta.xml only, skip dirs honoured.
  try {
    const dir = path.join(tmp, 'omniIntegrationProcedures');
    await w('omniIntegrationProcedures/Widget_Fetch_1.oip-meta.xml');
    await w('omniIntegrationProcedures/orgHint/Widget_Fetch_2.oip-meta.xml');
    await w('omniIntegrationProcedures/orgHint/notes.txt');
    await w('omniIntegrationProcedures/node_modules/Junk.oip-meta.xml');
    await w('omniIntegrationProcedures/.hidden/Junk2.oip-meta.xml');
    assert.deepStrictEqual((await listMetaFileNames(dir)).sort(), ['Widget_Fetch_1.oip-meta.xml', 'Widget_Fetch_2.oip-meta.xml']);
    // End to end: a folder whose ONLY file is nested derives through the helper.
    await fsp.rm(path.join(dir, 'Widget_Fetch_1.oip-meta.xml'));
    assert.deepStrictEqual(
      deriveRule('omniIntegrationProcedures', 'OmniIntegrationProcedure', ['Widget_Fetch_2'], await listMetaFileNames(dir)),
      { folder: 'omniIntegrationProcedures', type: 'OmniIntegrationProcedure', primaryExt: ['.oip-meta.xml'] });
    assert.deepStrictEqual(await listMetaFileNames(path.join(tmp, 'missing')), [], 'an unreadable dir lists nothing, never throws');
  } catch (e) { failed++; console.error('FAIL listMetaFileNames:', e.message); }

  // detectDataPackExports: vlocity/ at the project root or package dir, or any
  // *_DataPack.json below a package dir; only the DECLARED package dirs are walked.
  try {
    const proj = path.join(tmp, 'proj');
    await w('proj/force-app/main/default/classes/A.cls', 'public class A {}');
    assert.strictEqual(await detectDataPackExports(proj, ['force-app']), undefined, 'a plain project has no DataPack warning');
    await w('proj/force-app/main/default/vlocity/OmniScript/Widget/Widget_DataPack.json', '{}');
    assert.strictEqual(await detectDataPackExports(proj, ['force-app']), DATAPACK_WARNING, '*_DataPack.json under a package dir');
    assert.strictEqual(await detectDataPackExports(proj, ['other-app']), undefined, 'only declared package dirs are searched');
    await w('proj/vlocity/README.md', 'exports');
    assert.strictEqual(await detectDataPackExports(proj, ['other-app']), DATAPACK_WARNING, 'a top-level vlocity/ folder');
    assert.match(DATAPACK_WARNING, /OmniScript, OmniIntegrationProcedure, OmniDataTransform and OmniUiCard/, 'the warning names the handled types');
    assert.match(DATAPACK_WARNING, /not Metadata API source/);
  } catch (e) { failed++; console.error('FAIL detectDataPackExports:', e.message); }

  // scanWorkspace over an OmniStudio project WITHOUT learned rules: the four
  // folders are recognised (never reported unknown), the nested file lands too,
  // and the DataPack warning rides on the scan result once exports appear.
  try {
    const proj = path.join(tmp, 'omni');
    const pkg = 'omni/force-app/main/default/';
    await w('omni/sfdx-project.json', JSON.stringify({ packageDirectories: [{ path: 'force-app' }] }));
    await w(pkg + 'omniScripts/Widget_Intake_English_1.os-meta.xml');
    await w(pkg + 'omniScripts/orgHint/Widget_Intake_English_2.os-meta.xml');
    await w(pkg + 'omniIntegrationProcedures/Widget_Fetch_1.oip-meta.xml');
    await w(pkg + 'omniDataTransforms/WidgetTransform.rpt-meta.xml');
    await w(pkg + 'omniUiCard/WidgetCard_1.ouc-meta.xml');
    ws.folders = [{ uri: { fsPath: proj }, name: 'omni', index: 0 }];
    ws.projectFiles = [path.join(proj, 'sfdx-project.json')];
    const scan = await scanWorkspace();
    assert.strictEqual(scan.root, proj);
    assert.deepStrictEqual(scan.unknownFolders, [], 'an Omni folder must never be an unknown folder');
    assert.deepStrictEqual(scan.items.map(i => `${i.type}:${i.name}`), [
      'OmniDataTransform:WidgetTransform',
      'OmniIntegrationProcedure:Widget_Fetch_1',
      'OmniScript:Widget_Intake_English_1',
      'OmniScript:Widget_Intake_English_2',
      'OmniUiCard:WidgetCard_1'
    ]);
    const os1 = scan.items.find(i => i.name === 'Widget_Intake_English_1');
    assert.strictEqual(os1.filePath, path.join(proj, 'force-app', 'main', 'default', 'omniScripts', 'Widget_Intake_English_1.os-meta.xml'));
    assert.deepStrictEqual(os1.files, [os1.filePath], 'single-file type: no sidecar');
    assert.ok(!('warning' in scan), 'no DataPack exports → no warning key');
    await w('omni/vlocity/OmniScript/Widget/Widget_DataPack.json', '{}');
    const again = await scanWorkspace();
    assert.strictEqual(again.warning, DATAPACK_WARNING, 'the scan carries the DataPack warning');
    assert.strictEqual(again.items.length, 5, 'DataPack exports never become items');
  } catch (e) { failed++; console.error('FAIL scanWorkspace (OmniStudio):', e.message); }

  // Folder-based types (0.22.1): reports/dashboards/email folders — nested
  // `Folder/Name` components plus the folder's own depth-1 meta file.
  try {
    const proj = path.join(tmp, 'folders');
    const pkg = 'folders/force-app/main/default/'; // w() resolves relative to tmp
    await w('folders/sfdx-project.json', JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }] }));
    await w(pkg + 'reports/Acme_Reports.reportFolder-meta.xml');
    await w(pkg + 'reports/Acme_Reports/Pipeline.report-meta.xml');
    await w(pkg + 'reports/Acme_Reports/Sub.reportFolder-meta.xml');
    await w(pkg + 'reports/Acme_Reports/Sub/Deep.report-meta.xml'); // nested folder → Folder/Sub/Deep
    await w(pkg + 'dashboards/Acme_Dash.dashboardFolder-meta.xml');
    await w(pkg + 'dashboards/Acme_Dash/Exec.dashboard-meta.xml');
    await w(pkg + 'email/Acme_Mail.emailFolder-meta.xml');
    await w(pkg + 'email/Acme_Mail/Welcome.email');
    await w(pkg + 'email/Acme_Mail/Welcome.email-meta.xml');
    ws.folders = [{ uri: { fsPath: proj }, name: 'folders', index: 0 }];
    ws.projectFiles = [path.join(proj, 'sfdx-project.json')];
    const scan = await scanWorkspace();
    assert.deepStrictEqual(scan.unknownFolders, [], 'reports/dashboards/email are static now');
    assert.deepStrictEqual(scan.items.map(i => `${i.type}:${i.name}`).sort(), [
      'Dashboard:Acme_Dash/Exec', 'DashboardFolder:Acme_Dash', 'EmailFolder:Acme_Mail', 'EmailTemplate:Acme_Mail/Welcome',
      'Report:Acme_Reports/Pipeline', 'Report:Acme_Reports/Sub/Deep', 'ReportFolder:Acme_Reports', 'ReportFolder:Acme_Reports/Sub'
    ]);
    const mail = scan.items.find(i => i.type === 'EmailTemplate');
    assert.ok(mail.metaPath && mail.files.length === 2, 'nested content+meta pair still paired');
  } catch (e) { failed++; console.error('FAIL scanWorkspace (folder-based types):', e.message); }

  // Folder case (0.23.4): type folders match the disk case-insensitively and the
  // scanned paths carry the ON-DISK spelling — what vscode.git, the editor and
  // the watcher report. Asserted under 'linux' (exact compare) so the spelling
  // itself is proven, not merely folded over. Every static folder is owned in
  // any case, so none is ever an unknown folder, and the CustomObject tree and
  // its decomposed children follow the same contract.
  try {
    const proj = path.join(tmp, 'casing');
    const pkg = 'casing/force-app/main/default/';
    await w('casing/sfdx-project.json', JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }] }));
    await w(pkg + 'PlatformEventSubscriberConfigs/MyCfg.platformEventSubscriberConfig-meta.xml'); // registry spelling
    await w(pkg + 'Classes/Odd.cls', 'public class Odd {}'); // drifted spelling
    await w(pkg + 'Classes/Odd.cls-meta.xml');
    await w(pkg + 'LWC/myCmp/myCmp.js');
    await w(pkg + 'LWC/myCmp/myCmp.js-meta.xml');
    await w(pkg + 'Objects/Acme__c/Acme__c.object-meta.xml');
    await w(pkg + 'Objects/Acme__c/Fields/Amount__c.field-meta.xml');
    ws.folders = [{ uri: { fsPath: proj }, name: 'casing', index: 0 }];
    ws.projectFiles = [path.join(proj, 'sfdx-project.json')];
    const scan = await scanWorkspace();
    assert.deepStrictEqual(scan.unknownFolders, [], 'a static folder is owned whatever its case');
    assert.deepStrictEqual(scan.items.map(i => `${i.type}:${i.name}`).sort(), [
      'ApexClass:Odd', 'CustomField:Acme__c.Amount__c', 'CustomObject:Acme__c', 'LightningComponentBundle:myCmp', 'PlatformEventSubscriberConfig:MyCfg'
    ]);
    const dflt = path.join(proj, 'force-app', 'main', 'default');
    const onDisk = {
      'PlatformEventSubscriberConfig:MyCfg': path.join(dflt, 'PlatformEventSubscriberConfigs', 'MyCfg.platformEventSubscriberConfig-meta.xml'),
      'ApexClass:Odd': path.join(dflt, 'Classes', 'Odd.cls'),
      'LightningComponentBundle:myCmp': path.join(dflt, 'LWC', 'myCmp'),
      'CustomObject:Acme__c': path.join(dflt, 'Objects', 'Acme__c'),
      'CustomField:Acme__c.Amount__c': path.join(dflt, 'Objects', 'Acme__c', 'Fields', 'Amount__c.field-meta.xml')
    };
    for (const [key, real] of Object.entries(onDisk)) {
      const it = scan.items.find(i => `${i.type}:${i.name}` === key);
      assert.strictEqual(it.filePath, real, `${key}: path spelled as on disk`);
      assert.ok(it.files.every(f => f.startsWith(dflt + path.sep) && !f.includes(path.sep + 'classes' + path.sep) && !f.includes(path.sep + 'lwc' + path.sep)), `${key}: listed files spelled as on disk`);
      // The git→component mapping under an EXACT compare — the Changed view's
      // real question — now resolves; before, the rule's spelling leaked into
      // the path and this returned undefined on macOS.
      assert.strictEqual(findItemForPath(scan.items, real, 'linux'), it, `${key}: on-disk path maps to the component`);
    }
    assert.strictEqual(findItemForPath(scan.items, path.join(dflt, 'Classes', 'Odd.cls-meta.xml'), 'linux').name, 'Odd', 'sidecar path spelled as on disk');
  } catch (e) { failed++; console.error('FAIL scanWorkspace (folder case):', e.message); }

  // Reading the default dir once must not lose what the per-rule probe found
  // before (0.23.4 review): a SYMLINKED type folder is a directory to fs.access
  // but not to Dirent.isDirectory(), and a default dir that can be traversed but
  // not listed (mode --x, or a transient EACCES/EMFILE) must fall back to the
  // rule's own spelling instead of scanning to nothing.
  try {
    const proj = path.join(tmp, 'edge');
    const pkg = 'edge/force-app/main/default/';
    await w('edge/sfdx-project.json', JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }] }));
    await w('edge/shared/triggers/T.trigger', 'trigger T on Account (before insert) {}');
    await w('edge/shared/triggers/T.trigger-meta.xml');
    await w(pkg + 'classes/A.cls', 'public class A {}');
    await fsp.symlink(path.join(proj, 'shared', 'triggers'), path.join(proj, 'force-app', 'main', 'default', 'triggers'), 'dir');
    ws.folders = [{ uri: { fsPath: proj }, name: 'edge', index: 0 }];
    ws.projectFiles = [path.join(proj, 'sfdx-project.json')];
    const scan = await scanWorkspace();
    assert.deepStrictEqual(scan.items.map(i => `${i.type}:${i.name}`).sort(), ['ApexClass:A', 'ApexTrigger:T'], 'symlinked type folder scans');
    const trig = scan.items.find(i => i.type === 'ApexTrigger');
    assert.strictEqual(trig.filePath, path.join(proj, 'force-app', 'main', 'default', 'triggers', 'T.trigger'), 'through the symlink, not the target');
    assert.strictEqual(trig.metaPath, path.join(proj, 'force-app', 'main', 'default', 'triggers', 'T.trigger-meta.xml'));
    // Unlistable default dir: traversable (x) but no read bit. Root ignores mode
    // bits, so this case is only exercised by an unprivileged run; the assertions
    // hold either way.
    const dflt = path.join(proj, 'force-app', 'main', 'default');
    await fsp.chmod(dflt, 0o311);
    try {
      const blind = await scanWorkspace();
      assert.deepStrictEqual(blind.items.map(i => `${i.type}:${i.name}`).sort(), ['ApexClass:A', 'ApexTrigger:T'], 'unlistable default dir still scans by the rule spelling');
      assert.deepStrictEqual(blind.unknownFolders, [], 'nothing to report when the dir cannot be listed');
    } finally { await fsp.chmod(dflt, 0o755); }
  } catch (e) { failed++; console.error('FAIL scanWorkspace (symlink / unlistable dir):', e.message); }

  // Discovery retry (0.22.1): only the "not found" outcome is retried.
  try {
    const notFound = { projectError: 'No Salesforce DX project found in this workspace. Expected exactly one sfdx-project.json.' };
    const tooMany = { projectError: 'Found more than one Salesforce DX project in this workspace.' };
    const found = { root: '/ws' };
    assert.ok(isProjectNotFound(notFound) && !isProjectNotFound(tooMany) && !isProjectNotFound(found) && !isProjectNotFound({ projectError: 'No workspace folder is open.' }));
    let calls = 0; const waits = [];
    const r1 = await retryProjectNotFound(notFound, async () => (++calls === 2 ? found : notFound), [0, 0, 0], a => waits.push(a));
    assert.strictEqual(r1, found); assert.strictEqual(calls, 2); assert.deepStrictEqual(waits, [1, 2]);
    calls = 0;
    const r2 = await retryProjectNotFound(notFound, async () => { calls++; return notFound; }, [0, 0], () => {});
    assert.strictEqual(r2, notFound); assert.strictEqual(calls, 2, 'gives up after the delays are spent');
    calls = 0;
    assert.strictEqual(await retryProjectNotFound(tooMany, async () => { calls++; return found; }, [0]), tooMany); assert.strictEqual(calls, 0, 'other failures are not retried');
    assert.strictEqual(await retryProjectNotFound(found, async () => { calls++; return notFound; }, [0]), found); assert.strictEqual(calls, 0);
  } catch (e) { failed++; console.error('FAIL retryProjectNotFound:', e.message); }

  await fsp.rm(tmp, { recursive: true, force: true });
  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log(`inferItemForPath/parseManifestTypes/deriveRule/foldPathKey/detectMissingDependencies: all checks passed (${cases.length + noMatch.length} infer cases + learned-rule + parser + derive + fold + dependency-detector + OmniStudio scan/DataPack)`);
})();
