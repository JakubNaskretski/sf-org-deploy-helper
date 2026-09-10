// Runnable contract test for the manifest fallback in src/sfCliService.ts —
// METADATA_ARGS_BUDGET / metadataArgsLength / metadataFitsCommandLine /
// buildPackageXml, and the deployMetadata / retrieveMetadata route built on
// them.   No framework.   1) npm run compile   2) node scripts/check-manifest-fallback.cjs
//
// The bug: every selected component became one `--metadata Type:Name` argument,
// so a large selection grew the command line until the OS refused to start the
// CLI at all (8,191 characters on Windows cmd.exe; a larger but finite ARG_MAX,
// shared with the environment, on macOS/Linux). The fix writes such a list to a
// generated package.xml and passes `--manifest` — and that manifest MUST name
// exactly what the flag list named, spelled the same, or the org answers
// "An object 'X' of type Y was named in package.xml, but not found in zipped
// directory": a manifest member the CLI cannot match to local source is still
// written into the deploy zip's package.xml, with no file behind it.
//
// Pinned here against a stubbed runJsonCancellable (no CLI, no org):
//   1. the budget decision is by rendered length, not by count, with no
//      platform branch — a Mac takes the same route as Windows
//   2. buildPackageXml mirrors the CLI's own `--metadata` parsing: split on the
//      FIRST colon, trim, bare type → `*`, one <types> per type, members
//      de-duplicated, XML-escaped, and NO <version> (a manifest version would
//      override the project's sourceApiVersion; without one the CLI falls back
//      to sfdx-project.json exactly as it does for `--metadata`)
//   3. a list within budget still runs as `--metadata` (the proven path is
//      untouched); one over budget runs as `--manifest <temp package.xml>` whose
//      content at spawn time is exactly buildPackageXml(list), the reported
//      `cmd` is what ran, and the temp dir is gone once the call settles — on
//      success, on a CLI error envelope, on cancel before spawn (which never
//      spawns) and on cancel after spawn (which kills as usual)
//   4. a caller-supplied manifest or --source-dir still wins over the list
//   5. retrieveMetadata takes the same route, its own flags after the target
//   6. the panel's echo previews the same decision, the diff/retrieve/deploy
//      paths log the route, and `delete source` (no manifest form) refuses an
//      over-budget list before echoing anything
// scripts/check-manifest-cli.cjs then proves, against the real CLI, that the
// generated manifest resolves to byte-identical output with the flag list.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const Module = require('module');
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? {} : origLoad(req, ...rest));

const {
  SfCliService, SfCliCancelledError, SfCliError,
  METADATA_ARGS_BUDGET, metadataArgsLength, metadataFitsCommandLine, buildPackageXml
} = require(path.join(__dirname, '..', 'out', 'sfCliService.js'));
const { parseManifestTypes } = require(path.join(__dirname, '..', 'out', 'metadataScanner.js'));
const { DeployPanelProvider } = require(path.join(__dirname, '..', 'out', 'panelProvider.js'));

let failed = 0;
let ran = 0;
function check(name, fn) {
  ran++;
  try { fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}
// Async checks run one after another: several create and remove temp dirs under
// os.tmpdir(), and the leftover assertions below must see only their own.
let pending = Promise.resolve();
function checkAsync(name, fn) {
  ran++;
  pending = pending.then(() => fn().catch(e => { failed++; console.error(`FAIL ${name}: ${e.message}`); }));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
/** Temp dirs the service leaves behind under os.tmpdir() (none expected). */
const leftovers = prefix => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(prefix));
async function waitGone(dir) {
  for (let i = 0; i < 100 && fs.existsSync(dir); i++) await sleep(20);
  return !fs.existsSync(dir);
}

/** `--metadata` entries whose rendered length totals exactly `total`. Each
 *  `ApexClass:` + k×'A' entry costs 22 + k characters (flag, space, value,
 *  separator), so 24 entries of k = total/24 − 22. */
function entriesOfExactLength(total) {
  const k = total / 24 - 22;
  assert.ok(Number.isInteger(k) && k > 0, `pick a total divisible by 24 (got ${total})`);
  return Array.from({ length: 24 }, () => `ApexClass:${'A'.repeat(k)}`);
}
const LONG = Array.from({ length: 400 }, (_, i) => `ApexClass:Svc${i}`);   // ≈ 10,000 chars
const SHORT = ['ApexClass:A', 'ApexClass:B'];

// ---- 1. the budget --------------------------------------------------------

check('rendered length counts flag + space + value + separator, quotes only for whitespace', () => {
  assert.strictEqual(metadataArgsLength([]), 0);
  assert.strictEqual(metadataArgsLength(['ApexClass:Foo']), '--metadata '.length + 'ApexClass:Foo'.length + 1);
  assert.strictEqual(
    metadataArgsLength(['Layout:Account-Account Layout']),
    '--metadata '.length + 'Layout:Account-Account Layout'.length + 2 + 1
  );
});

check('the decision is by length, not count: at the budget fits, one character past does not', () => {
  const atBudget = entriesOfExactLength(METADATA_ARGS_BUDGET);
  assert.strictEqual(metadataArgsLength(atBudget), METADATA_ARGS_BUDGET);
  assert.strictEqual(metadataFitsCommandLine(atBudget), true);
  const overByOne = [...atBudget.slice(0, -1), atBudget[atBudget.length - 1] + 'X'];
  assert.strictEqual(metadataFitsCommandLine(overByOne), false);
  // Few components with long names trip it just like many short ones.
  assert.strictEqual(metadataFitsCommandLine([`Flow:${'N'.repeat(METADATA_ARGS_BUDGET)}`]), false);
  assert.strictEqual(metadataFitsCommandLine(SHORT), true);
  assert.strictEqual(metadataFitsCommandLine(LONG), false);
});

check('the budget sits under the Windows cmd.exe line cap with headroom, and the decision has no platform branch', () => {
  assert.ok(METADATA_ARGS_BUDGET <= 8191 - 1500, `budget ${METADATA_ARGS_BUDGET} leaves too little for the launcher path and fixed flags`);
  assert.ok(!/platform|win32/.test(metadataFitsCommandLine.toString() + metadataArgsLength.toString()));
});

// ---- 2. buildPackageXml ---------------------------------------------------

check('one <types> per type in first-seen order, members de-duplicated, trimmed, bare type → *, first colon splits', () => {
  const xml = buildPackageXml([
    'ApexClass:Svc1', 'CustomField:Account.Rating2__c', 'ApexClass:Svc2', 'ApexClass:Svc1',
    ' ApexClass : Svc3 ', 'Flow', 'Report:MyReports/Pipeline', 'Odd:with:colons'
  ]);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n'));
  assert.ok(xml.endsWith('</Package>\n'));
  assert.ok(!/<version>/.test(xml), 'no <version> — it would override sourceApiVersion');
  // The extension's own manifest reader (what "Deploy Manifest" parses) reads it back.
  assert.deepStrictEqual(parseManifestTypes(xml), [
    { type: 'ApexClass', members: ['Svc1', 'Svc2', 'Svc3'] },
    { type: 'CustomField', members: ['Account.Rating2__c'] },
    { type: 'Flow', members: ['*'] },
    { type: 'Report', members: ['MyReports/Pipeline'] },
    { type: 'Odd', members: ['with:colons'] }
  ]);
});

check('members and type names are XML-escaped, nothing else is rewritten', () => {
  const xml = buildPackageXml([
    'EmailTemplate:Folder With Space/Bye & Thanks',
    'Layout:Account-Account %28Marketing%29 Layout',
    'Odd<T>:a"b\'c'
  ]);
  assert.ok(xml.includes('<members>Folder With Space/Bye &amp; Thanks</members>'));
  assert.ok(xml.includes('<members>Account-Account %28Marketing%29 Layout</members>'), 'URL-encoded layout names pass through untouched');
  assert.ok(xml.includes('<members>a&quot;b&apos;c</members>'));
  assert.ok(xml.includes('<name>Odd&lt;T&gt;</name>'));
  assert.ok(!xml.replace(/&(amp|lt|gt|quot|apos);/g, '').includes('&'), 'every ampersand is an entity');
});

check('empty and type-less entries are dropped rather than emitted as broken XML', () => {
  const xml = buildPackageXml(['', '   ', ':Name', 'ApexClass:Real']);
  assert.deepStrictEqual(parseManifestTypes(xml), [{ type: 'ApexClass', members: ['Real'] }]);
});

// ---- 3–5. the service route ------------------------------------------------

/** A service whose CLI is a stub: records every spawn (and the manifest file's
 *  content AT spawn time), answers with `envelope` (an Error rejects; the 'hold'
 *  sentinel stays pending until cancel). */
function stubbed(envelope) {
  const svc = new SfCliService({ defaultTimeoutMs: 1000, killEscalationMs: 1 });
  const calls = [];
  svc.runJsonCancellable = (args, opts) => {
    const at = args.indexOf('--manifest');
    const manifestPath = at >= 0 ? args[at + 1] : undefined;
    calls.push({
      args, opts, manifestPath,
      manifestContent: manifestPath && fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : undefined
    });
    let rejectFn = () => undefined;
    const promise = new Promise((resolve, reject) => {
      rejectFn = reject;
      if (envelope instanceof Error) reject(envelope);
      else if (envelope !== 'hold') resolve(envelope);
    });
    return { promise, cancel: () => rejectFn(new SfCliCancelledError()) };
  };
  return { svc, calls };
}
const OK = { status: 0, result: { id: '0Af000000000001', status: 'Queued', success: true } };

checkAsync('within budget: the per-component --metadata list runs unchanged, no temp file', async () => {
  const { svc, calls } = stubbed(OK);
  const before = leftovers('sfodw-deploy-').length;
  const { result, cmd } = await svc.deployMetadata(SHORT, 'me@x', '/w', { timeoutMs: 5 }).promise;
  assert.deepStrictEqual(calls[0].args, ['project', 'deploy', 'start', '--metadata', 'ApexClass:A', '--metadata', 'ApexClass:B', '--target-org', 'me@x', '--json']);
  assert.deepStrictEqual(calls[0].opts, { timeoutMs: 5, cwd: '/w' });
  assert.strictEqual(cmd, 'sf project deploy start --metadata ApexClass:A --metadata ApexClass:B --target-org me@x');
  assert.deepStrictEqual(result, OK.result);
  assert.strictEqual(leftovers('sfodw-deploy-').length, before);
});

checkAsync('over budget: --manifest <temp package.xml> replaces the list, content is buildPackageXml(list), every other flag stays', async () => {
  const { svc, calls } = stubbed(OK);
  const handle = svc.deployMetadata(LONG, 'me@x', '/w', {
    timeoutMs: 7, validateOnly: true, ignoreConflicts: true, testLevel: 'RunSpecifiedTests', runTests: ['T1', 'T2'], background: true
  });
  const { result, cmd } = await handle.promise;
  const call = calls[0];
  assert.ok(call.manifestPath, `no --manifest in ${call.args.join(' ')}`);
  assert.strictEqual(path.basename(call.manifestPath), 'package.xml');
  assert.ok(path.dirname(call.manifestPath).startsWith(path.join(os.tmpdir(), 'sfodw-deploy-')), call.manifestPath);
  assert.deepStrictEqual(call.args, [
    'project', 'deploy', 'validate', '--manifest', call.manifestPath, '--target-org', 'me@x',
    '--ignore-conflicts', '--test-level', 'RunSpecifiedTests', '--tests', 'T1', '--tests', 'T2', '--async', '--json'
  ]);
  assert.ok(!call.args.includes('--metadata'));
  assert.strictEqual(call.manifestContent, buildPackageXml(LONG), 'the file the CLI read is exactly the generated manifest');
  assert.deepStrictEqual(parseManifestTypes(call.manifestContent), [{ type: 'ApexClass', members: LONG.map(k => k.slice('ApexClass:'.length)) }]);
  assert.deepStrictEqual(call.opts, { timeoutMs: 7, cwd: '/w' });
  assert.strictEqual(cmd, `sf project deploy validate --manifest ${call.manifestPath} --target-org me@x --ignore-conflicts --test-level RunSpecifiedTests --tests T1 --tests T2 --async`);
  assert.deepStrictEqual(result, OK.result);
  assert.ok(await waitGone(path.dirname(call.manifestPath)), 'temp dir removed after the run');
});

checkAsync('a CLI error envelope still rejects as SfCliError, and the temp dir is removed', async () => {
  const { svc, calls } = stubbed({ status: 1, name: 'SourceConflictError', message: 'Conflicts detected' });
  await assert.rejects(svc.deployMetadata(LONG, 'me@x', '/w').promise, e => e instanceof SfCliError && /SourceConflictError: Conflicts detected/.test(e.message));
  assert.ok(await waitGone(path.dirname(calls[0].manifestPath)));
});

checkAsync('cancel before the process starts never spawns, rejects as cancelled, leaves no temp dir', async () => {
  const { svc, calls } = stubbed(OK);
  const before = leftovers('sfodw-deploy-');
  const handle = svc.deployMetadata(LONG, 'me@x', '/w');
  handle.cancel(); // the manifest is still being written — nothing to kill yet
  await assert.rejects(handle.promise, e => e instanceof SfCliCancelledError);
  assert.strictEqual(calls.length, 0, 'the CLI must not have been started');
  await sleep(100);
  assert.deepStrictEqual(leftovers('sfodw-deploy-'), before);
});

checkAsync('cancel after the process starts is forwarded to it, and the temp dir is removed', async () => {
  const { svc, calls } = stubbed('hold');
  const handle = svc.deployMetadata(LONG, 'me@x', '/w');
  for (let i = 0; i < 100 && calls.length === 0; i++) await sleep(10);
  assert.strictEqual(calls.length, 1, 'the CLI was started');
  handle.cancel();
  await assert.rejects(handle.promise, e => e instanceof SfCliCancelledError);
  assert.ok(await waitGone(path.dirname(calls[0].manifestPath)));
});

checkAsync('a caller-supplied manifest wins over any list, long or short — nothing generated', async () => {
  const { svc, calls } = stubbed(OK);
  const before = leftovers('sfodw-deploy-').length;
  await svc.deployMetadata(LONG, 'me@x', '/w', { manifest: '/w/manifest/package.xml' }).promise;
  assert.deepStrictEqual(calls[0].args, ['project', 'deploy', 'start', '--manifest', '/w/manifest/package.xml', '--target-org', 'me@x', '--json']);
  assert.strictEqual(leftovers('sfodw-deploy-').length, before);
});

checkAsync('--source-dir wins over the list too (a pointed-at file outside the package dirs)', async () => {
  const { svc, calls } = stubbed(OK);
  await svc.deployMetadata(LONG, 'me@x', '/w', { sourceDirs: ['/elsewhere/Foo.cls'] }).promise;
  assert.deepStrictEqual(calls[0].args, ['project', 'deploy', 'start', '--source-dir', '/elsewhere/Foo.cls', '--target-org', 'me@x', '--json']);
});

checkAsync('retrieve: same route, own flags after the target, own temp prefix, cleaned up', async () => {
  const { svc, calls } = stubbed({ status: 0, result: { status: 0, success: true, files: [] } });
  const { cmd } = await svc.retrieveMetadata(LONG, 'me@x', '/w', { timeoutMs: 3, outputDir: '/out', ignoreConflicts: true }).promise;
  const call = calls[0];
  assert.ok(call.manifestPath && path.dirname(call.manifestPath).startsWith(path.join(os.tmpdir(), 'sfodw-retrieve-')), call.args.join(' '));
  assert.deepStrictEqual(call.args, [
    'project', 'retrieve', 'start', '--manifest', call.manifestPath, '--target-org', 'me@x',
    '--target-metadata-dir', '/out', '--unzip', '--ignore-conflicts', '--json'
  ]);
  assert.strictEqual(call.manifestContent, buildPackageXml(LONG));
  assert.deepStrictEqual(call.opts, { timeoutMs: 3, cwd: '/w' });
  assert.strictEqual(cmd, `sf project retrieve start --manifest ${call.manifestPath} --target-org me@x --target-metadata-dir /out --unzip --ignore-conflicts`);
  assert.ok(await waitGone(path.dirname(call.manifestPath)));
});

checkAsync('retrieve within budget is untouched', async () => {
  const { svc, calls } = stubbed({ status: 0, result: { status: 0, success: true, files: [] } });
  await svc.retrieveMetadata(['ApexClass:A'], 'me@x', '/w').promise;
  assert.deepStrictEqual(calls[0].args, ['project', 'retrieve', 'start', '--metadata', 'ApexClass:A', '--target-org', 'me@x', '--json']);
});

// ---- 6. the panel side -----------------------------------------------------

const items = keys => keys.map(k => ({ type: k.slice(0, k.indexOf(':')), name: k.slice(k.indexOf(':') + 1), filePath: '/w/x', files: [] }));

check('the echoed command previews the same decision: --metadata list within budget, a --manifest placeholder past it', () => {
  // metadataArgs reads nothing off the provider — call it as the prototype method it is.
  const echo = DeployPanelProvider.prototype.metadataArgs;
  assert.strictEqual(echo.call({}, items(SHORT)), '--metadata ApexClass:A --metadata ApexClass:B');
  assert.strictEqual(echo.call({}, items(LONG)), `--manifest <generated package.xml: ${LONG.length} components>`);
  const atBudget = entriesOfExactLength(METADATA_ARGS_BUDGET);
  assert.ok(echo.call({}, items(atBudget)).startsWith('--metadata '), 'at the budget the list is still echoed');
});

check('the Output channel explains the route once, and only when it is taken', () => {
  const lines = [];
  const note = DeployPanelProvider.prototype.noteManifestRoute;
  note.call({ output: { appendLine: l => lines.push(l) } }, 'deploy', items(SHORT));
  assert.deepStrictEqual(lines, []);
  note.call({ output: { appendLine: l => lines.push(l) } }, 'deploy', items(LONG));
  assert.strictEqual(lines.length, 1);
  assert.ok(/^\[deploy\] 400 components: a --metadata list of \d+ characters exceeds the 6000-character command-line budget — running with a generated package\.xml \(--manifest\)/.test(lines[0]), lines[0]);
});

const providerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'panelProvider.ts'), 'utf8');

check('deploy, retrieve and the diff slow path all log the route before echoing their command', () => {
  const sites = providerSrc.split('\n').filter(l => /this\.noteManifestRoute\(/.test(l));
  assert.strictEqual(sites.length, 3, sites.join('\n'));
  assert.ok(sites.some(l => /'retrieve'/.test(l)) && sites.some(l => /'diff'/.test(l)) && sites.some(l => /'validate' : 'deploy'/.test(l)), sites.join('\n'));
});

check('delete source has no manifest form, so an over-budget list is refused before the dry-run echo', () => {
  const fn = providerSrc.slice(providerSrc.indexOf('private async runDelete('), providerSrc.indexOf('private async afterDelete('));
  const guard = fn.indexOf('if (!metadataFitsCommandLine(metadata))');
  const echo = fn.indexOf('--no-prompt --dry-run');
  assert.ok(guard > 0 && echo > 0 && guard < echo, 'guard must sit before the dry-run echo');
  assert.ok(/too many to delete in one command/.test(fn.slice(guard, echo)));
});

pending.then(() => {
  if (failed) { console.error(`\n${failed}/${ran} checks failed`); process.exit(1); }
  console.log(`check-manifest-fallback: ${ran} checks passed`);
});
