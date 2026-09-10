// Runnable proof, against the REAL Salesforce CLI, that the package.xml the
// manifest fallback generates (src/sfCliService.ts buildPackageXml) names
// exactly what the `--metadata Type:Name` list it replaces named — so a large
// deploy rerouted through it reaches the org with the same components, never
// with "An object 'X' of type Y was named in package.xml, but not found in
// zipped directory".   No framework.
//   1) npm run compile   2) node scripts/check-manifest-cli.cjs
//
// Needs `sf` on PATH (resolved the way the extension resolves it, .cmd shim on
// Windows included); without it the check SKIPS with a note and exits 0 — the
// stubbed contract in check-manifest-fallback.cjs still ran. No org is needed:
// `sf project convert source` runs the same component-set build a deploy runs
// and writes the zip's package.xml plus files to a directory, so the two forms
// can be diffed byte for byte. The test project mixes the shapes a manifest can
// get wrong: decomposed object children, URL-encoded layout names, folder types
// with spaces and ampersands, bundles, labels, a second package directory.
//
// Also pinned: the version-less manifest inherits the project's sourceApiVersion
// (the CLI fills <version> in), and a member with no local source ends up in
// package.xml with no file behind it for BOTH forms — the failure mode the
// fallback must never manufacture on its own.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const Module = require('module');
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? {} : origLoad(req, ...rest));

const { buildPackageXml } = require(path.join(__dirname, '..', 'out', 'sfCliService.js'));
const { resolveSfCommand, planSpawn } = require(path.join(__dirname, '..', 'out', 'kit', 'sfCli.js'));

let failed = 0;
let ran = 0;
function check(name, fn) {
  ran++;
  try { fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}

const sfCommand = resolveSfCommand();
const env = { ...process.env, SF_DISABLE_TELEMETRY: 'true', SF_AUTOUPDATE_DISABLE: 'true', SF_DISABLE_AUTOUPDATE: 'true' };
/** Run `sf …` and parse its JSON envelope; `undefined` when the CLI isn't installed. */
function sf(args, cwd) {
  const plan = planSpawn(sfCommand, [...args, '--json']);
  const r = spawnSync(plan.command, plan.args, {
    cwd, env, encoding: 'utf8', windowsVerbatimArguments: plan.windowsVerbatimArguments, timeout: 120_000
  });
  if (r.error && r.error.code === 'ENOENT') return undefined;
  if (r.error) throw r.error;
  const start = (r.stdout || '').indexOf('{');
  if (start < 0) throw new Error(`sf ${args.join(' ')} produced no JSON (exit ${r.status}): ${(r.stderr || '').slice(0, 400)}`);
  return JSON.parse(r.stdout.slice(start));
}

const probe = sf(['version']);
if (probe === undefined) {
  console.log('check-manifest-cli: skipped — `sf` not found on PATH (the stubbed contract in check-manifest-fallback.cjs still applies)');
  process.exit(0);
}

// ---- a throwaway SFDX project ------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfodw-cli-check-'));
const w = (rel, content) => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};
const meta = (tag, inner) => `<?xml version="1.0" encoding="UTF-8"?><${tag} xmlns="http://soap.sforce.com/2006/04/metadata">${inner}</${tag}>`;
w('sfdx-project.json', JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }, { path: 'extra-pkg' }], namespace: '', sourceApiVersion: '61.0' }));
const M = 'force-app/main/default';
const classMeta = meta('ApexClass', '<apiVersion>61.0</apiVersion><status>Active</status>');
for (let i = 1; i <= 40; i++) { w(`${M}/classes/Svc${i}.cls`, `public class Svc${i} {}`); w(`${M}/classes/Svc${i}.cls-meta.xml`, classMeta); }
w('extra-pkg/main/default/classes/ExtraPkgClass.cls', 'public class ExtraPkgClass {}'); w('extra-pkg/main/default/classes/ExtraPkgClass.cls-meta.xml', classMeta);
w(`${M}/triggers/AccountTrg.trigger`, 'trigger AccountTrg on Account (before insert) {}');
w(`${M}/triggers/AccountTrg.trigger-meta.xml`, meta('ApexTrigger', '<apiVersion>61.0</apiVersion><status>Active</status>'));
w(`${M}/objects/Account/fields/Rating2__c.field-meta.xml`, meta('CustomField', '<fullName>Rating2__c</fullName><label>Rating2</label><type>Text</type><length>10</length>'));
w(`${M}/objects/Broker__c/Broker__c.object-meta.xml`, meta('CustomObject', '<label>Broker</label><pluralLabel>Brokers</pluralLabel><nameField><label>Name</label><type>Text</type></nameField><deploymentStatus>Deployed</deploymentStatus><sharingModel>ReadWrite</sharingModel>'));
w(`${M}/objects/Broker__c/fields/Email__c.field-meta.xml`, meta('CustomField', '<fullName>Email__c</fullName><label>Email</label><type>Email</type>'));
w(`${M}/objects/Broker__c/validationRules/Email_Required.validationRule-meta.xml`, meta('ValidationRule', '<fullName>Email_Required</fullName><active>true</active><errorConditionFormula>ISBLANK(Email__c)</errorConditionFormula><errorMessage>Required</errorMessage>'));
w(`${M}/layouts/Account-Account %28Marketing%29 Layout.layout-meta.xml`, meta('Layout', '<layoutSections/>'));
w(`${M}/layouts/Broker__c-Broker Layout.layout-meta.xml`, meta('Layout', '<layoutSections/>'));
w(`${M}/email/MyTemplates.emailFolder-meta.xml`, meta('EmailFolder', '<accessType>Public</accessType><name>MyTemplates</name><publicFolderAccess>ReadWrite</publicFolderAccess>'));
w(`${M}/email/MyTemplates/Welcome.email`, 'Hello');
w(`${M}/email/MyTemplates/Welcome.email-meta.xml`, meta('EmailTemplate', '<available>true</available><encodingKey>UTF-8</encodingKey><name>Welcome</name><style>none</style><subject>Hi</subject><type>text</type>'));
w(`${M}/email/Folder With Space.emailFolder-meta.xml`, meta('EmailFolder', '<accessType>Public</accessType><name>Folder With Space</name><publicFolderAccess>ReadWrite</publicFolderAccess>'));
w(`${M}/email/Folder With Space/Bye & Thanks.email`, 'Bye');
w(`${M}/email/Folder With Space/Bye & Thanks.email-meta.xml`, meta('EmailTemplate', '<available>true</available><encodingKey>UTF-8</encodingKey><name>Bye &amp; Thanks</name><style>none</style><subject>Bye</subject><type>text</type>'));
w(`${M}/lwc/myCard/myCard.js`, "import { LightningElement } from 'lwc'; export default class MyCard extends LightningElement {}");
w(`${M}/lwc/myCard/myCard.html`, '<template></template>');
w(`${M}/lwc/myCard/myCard.js-meta.xml`, meta('LightningComponentBundle', '<apiVersion>61.0</apiVersion><isExposed>false</isExposed>'));
w(`${M}/aura/myApp/myApp.app`, '<aura:application></aura:application>');
w(`${M}/aura/myApp/myApp.app-meta.xml`, meta('AuraDefinitionBundle', '<apiVersion>61.0</apiVersion>'));
w(`${M}/staticresources/logo.png`, 'PNGDATA');
w(`${M}/staticresources/logo.resource-meta.xml`, meta('StaticResource', '<cacheControl>Public</cacheControl><contentType>image/png</contentType>'));
w(`${M}/labels/CustomLabels.labels-meta.xml`, meta('CustomLabels', '<labels><fullName>Greeting</fullName><language>en_US</language><protected>false</protected><shortDescription>Greeting</shortDescription><value>Hi</value></labels><labels><fullName>Farewell</fullName><language>en_US</language><protected>false</protected><shortDescription>Farewell</shortDescription><value>Bye</value></labels>'));
w(`${M}/customMetadata/Setting.Default.md-meta.xml`, meta('CustomMetadata', '<label>Default</label><protected>false</protected>'));
w(`${M}/flows/Onboard.flow-meta.xml`, meta('Flow', '<apiVersion>61.0</apiVersion><label>Onboard</label><processType>AutoLaunchedFlow</processType><status>Draft</status><start><locationX>0</locationX><locationY>0</locationY></start>'));
w(`${M}/permissionsets/Broker_Admin.permissionset-meta.xml`, meta('PermissionSet', '<label>Broker Admin</label>'));
w(`${M}/reports/MyReports.reportFolder-meta.xml`, meta('ReportFolder', '<accessType>Public</accessType><name>MyReports</name><publicFolderAccess>ReadWrite</publicFolderAccess>'));
w(`${M}/reports/MyReports/Pipeline.report-meta.xml`, meta('Report', '<format>Tabular</format><name>Pipeline</name><reportType>Opportunity</reportType>'));
w(`${M}/documents/MyDocs.documentFolder-meta.xml`, meta('DocumentFolder', '<accessType>Public</accessType><name>MyDocs</name><publicFolderAccess>ReadWrite</publicFolderAccess>'));
w(`${M}/documents/MyDocs/banner.png`, 'PNG');
w(`${M}/documents/MyDocs/banner.png-meta.xml`, meta('Document', '<internalUseOnly>false</internalUseOnly><name>banner</name><public>false</public>'));
w(`${M}/tabs/Broker__c.tab-meta.xml`, meta('CustomTab', '<customObject>true</customObject><motif>Custom1: Heart</motif>'));

// The exact Type:Name keys the extension would have passed one `--metadata` at a time.
const KEYS = [
  ...Array.from({ length: 40 }, (_, i) => `ApexClass:Svc${i + 1}`), 'ApexClass:ExtraPkgClass', 'ApexTrigger:AccountTrg',
  'CustomField:Account.Rating2__c', 'CustomField:Broker__c.Email__c', 'CustomObject:Broker__c', 'ValidationRule:Broker__c.Email_Required',
  'Layout:Account-Account %28Marketing%29 Layout', 'Layout:Broker__c-Broker Layout',
  'EmailTemplate:MyTemplates/Welcome', 'EmailTemplate:Folder With Space/Bye & Thanks', 'EmailFolder:Folder With Space',
  'LightningComponentBundle:myCard', 'AuraDefinitionBundle:myApp', 'StaticResource:logo', 'CustomLabel:Greeting',
  'CustomMetadata:Setting.Default', 'Flow:Onboard', 'PermissionSet:Broker_Admin', 'Report:MyReports/Pipeline', 'ReportFolder:MyReports',
  'Document:MyDocs/banner', 'CustomTab:Broker__c'
];

/** Every file under `dir` as { relative path → content }. */
function snapshot(dir) {
  const out = {};
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(dir, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}
function convert(targetArgs, outName) {
  const outDir = path.join(root, 'out', outName);
  const json = sf(['project', 'convert', 'source', ...targetArgs, '--output-dir', outDir], root);
  assert.strictEqual(json.status, 0, `${json.name ?? ''}: ${json.message ?? ''}`);
  return snapshot(outDir);
}

try {
  const manifestPath = path.join(root, 'generated', 'package.xml');
  w('generated/package.xml', buildPackageXml(KEYS));

  const viaFlags = convert(KEYS.flatMap(k => ['--metadata', k]), 'flags');
  const viaManifest = convert(['--manifest', manifestPath], 'manifest');

  check(`the generated manifest converts to byte-identical output with the --metadata list (${KEYS.length} keys, ${Object.keys(viaFlags).length} files)`, () => {
    assert.ok(Object.keys(viaFlags).length > 40, 'the flag form resolved the project');
    assert.deepStrictEqual(Object.keys(viaManifest).sort(), Object.keys(viaFlags).sort());
    for (const f of Object.keys(viaFlags)) assert.strictEqual(viaManifest[f], viaFlags[f], `content differs: ${f}`);
  });

  check('the version-less manifest inherits sourceApiVersion from sfdx-project.json, like --metadata does', () => {
    assert.ok(!/<version>/.test(buildPackageXml(KEYS)));
    assert.ok(viaManifest['package.xml'].includes('<version>61.0</version>'), viaManifest['package.xml']);
  });

  check('every key landed in the converted package.xml under its own type (nothing silently dropped)', () => {
    const pkg = viaManifest['package.xml'];
    for (const k of KEYS) {
      const [type, name] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
      // Folder types are listed by the CLI under their content type (EmailFolder → EmailTemplate, with a trailing slash for Report folders).
      if (type === 'EmailFolder' || type === 'ReportFolder') continue;
      const block = pkg.slice(0, pkg.indexOf(`<name>${type}</name>`));
      const escaped = name.replace(/&/g, '&amp;');
      assert.ok(block.lastIndexOf(`<members>${escaped}</members>`) >= 0, `${k} missing from converted package.xml`);
    }
  });

  check('a member with no local source is named in package.xml with no file behind it — for BOTH forms alike', () => {
    const missing = ['ApexClass:Svc1', 'ApexClass:DoesNotExist', 'CustomField:Account.Nope__c'];
    w('generated/missing.xml', buildPackageXml(missing));
    const a = convert(missing.flatMap(k => ['--metadata', k]), 'missing-flags');
    const b = convert(['--manifest', path.join(root, 'generated', 'missing.xml')], 'missing-manifest');
    assert.deepStrictEqual(Object.keys(a).sort(), ['classes/Svc1.cls', 'classes/Svc1.cls-meta.xml', 'package.xml']);
    assert.deepStrictEqual(Object.keys(b).sort(), Object.keys(a).sort());
    assert.strictEqual(b['package.xml'], a['package.xml']);
    assert.ok(a['package.xml'].includes('<members>DoesNotExist</members>'), 'this is the org-side "not found in zipped directory" shape');
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

if (failed) { console.error(`\n${failed}/${ran} checks failed`); process.exit(1); }
console.log(`check-manifest-cli: ${ran} checks passed against ${sfCommand} (${probe.cliVersion ?? probe.result?.cliVersion ?? 'version unknown'})`);
