// Runnable contract test for the run records behind the Status pane
// (src/runRecords.ts). No framework.   1) npm run compile   2) node scripts/check-run-records.cjs
//
// A run record is what the pane says about one deploy, validation, quick deploy
// or retrieve, and what a reload keeps of it. Four things are pinned here:
//   1) the verdict of every component follows what the ORG said happened. A
//      failed deploy is rolled back as a whole, so a component that was fine on
//      its own reads "rolled back", never "deployed"; a validation applies
//      nothing, so its good components "passed" — calling them rolled back
//      would claim something was undone that was never done;
//   2) a Retry re-sends exactly what the run sent: the rows marked sent are the
//      keys buildRetryRequest has always put on a failure card, never a skipped
//      row (it has no local file) and never a failure the org raised against a
//      component outside the request;
//   3) what survives a reload is bounded — failures first, a taste of skipped
//      rows, counts always exact — because workspaceState is one JSON value per
//      extension, rewritten on every write;
//   4) what comes back from storage is guarded: org, job id and retry options
//      reach a CLI command line when a button is clicked, so a tampered value
//      drops the run instead of being passed along.
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const Module = require('module');
const origLoad = Module._load;
// runRecords itself never loads vscode (asserted below); the stub only satisfies
// panelProvider.js, loaded for buildRetryRequest.
Module._load = (req, ...rest) => (req === 'vscode' ? {} : origLoad(req, ...rest));

const OUT = path.join(__dirname, '..', 'out');
const RR = require(path.join(OUT, 'runRecords.js'));
const { buildRetryRequest, deploySuccessRows: reexported } = require(path.join(OUT, 'panelProvider.js'));

let failed = 0;
let ran = 0;
function check(name, fn) {
  ran++;
  try { fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}

// ------------------------------------------------------------------ fixtures
const T0 = 1_750_000_000_000;
const item = (type, name) => ({ type, name, filePath: `/ws/force-app/main/default/${type}/${name}` });
const key = (i) => `${i.type}:${i.name}`;
const ITEMS = [item('ApexClass', 'AcmeOrderService'), item('ApexClass', 'AcmeInvoiceService'), item('CustomObject', 'AcmeOrder__c')];
const BASE = (over = {}) => ({
  id: 'run0001', op: 'deploy', org: 'acme-dev-user', orgLabel: 'acme-dev', orgKind: 'sandbox',
  startedAt: T0, finishedAt: T0 + 60_000, target: 'selection', items: ITEMS,
  skipped: { orgOnly: [], unread: [] }, testLevel: 'NoTestRun', ...over
});
const ok = (over = {}) => ({ id: '0AfAc000001kQ9zSAE', status: 'Succeeded', success: true, numberComponentErrors: 0, numberComponentsDeployed: 3, numberComponentsTotal: 3, ...over });
// The same component failure in both result shapes the CLI has produced: the
// older `details.componentFailures` (type under componentType, text under
// problem) and the newer `files` list (type under type, text under error).
const DETAIL_FAIL = { componentType: 'ApexClass', fullName: 'AcmeInvoiceService', problem: 'Variable does not exist: acmeTotal', lineNumber: 12, columnNumber: 5, filePath: 'force-app/main/default/classes/AcmeInvoiceService.cls' };
const FILE_FAIL = { type: 'ApexClass', fullName: 'AcmeInvoiceService', state: 'Failed', error: 'Variable does not exist: acmeTotal', lineNumber: 12, columnNumber: 5, filePath: 'force-app/main/default/classes/AcmeInvoiceService.cls' };
const failedDetails = (over = {}) => ({ status: 'Failed', success: false, numberComponentErrors: 1, details: { componentFailures: [DETAIL_FAIL] }, ...over });
const failedFiles = (over = {}) => ({ status: 'Failed', success: false, numberComponentErrors: 1, files: [
  { type: 'ApexClass', fullName: 'AcmeOrderService', state: 'Changed' },
  FILE_FAIL,
  { type: 'CustomObject', fullName: 'AcmeOrder__c', state: 'Unchanged' }
], ...over });
const outcomes = (run) => Object.fromEntries(run.rows.map(r => [r.k, r.o]));

// ============================================ 1) the outcome of every component
check('deploy, org Succeeded: every sent row is deployed, the run succeeded', () => {
  const run = RR.deployRunFromResult(ok(), BASE());
  assert.strictEqual(run.status, 'succeeded');
  assert.deepStrictEqual(Object.values(outcomes(run)), ['deployed', 'deployed', 'deployed']);
  assert.ok(run.rows.every(r => r.s === 1));
  assert.deepStrictEqual(run.counts, { deployed: 3, failed: 0, skipped: 0, sent: 3, orgDeployed: 3, orgTotal: 3, orgErrors: 0 });
  assert.strictEqual(run.jobId, '0AfAc000001kQ9zSAE');
  assert.strictEqual(run.rowsComplete, true);
});

check('quick deploy, org Succeeded: rows come from the org report, all deployed', () => {
  const run = RR.deployRunFromResult(ok({ files: ITEMS.map(i => ({ type: i.type, fullName: i.name, state: 'Changed' })) }),
    BASE({ op: 'quickDeploy', target: 'report', items: undefined, skipped: undefined, fromRunId: 'run0000' }));
  assert.strictEqual(run.status, 'succeeded');
  assert.deepStrictEqual(Object.values(outcomes(run)), ['deployed', 'deployed', 'deployed']);
  assert.strictEqual(run.fromRunId, 'run0000');
  assert.ok(!('skipped' in run.counts), 'a quick deploy knows nothing about skipped rows — the chip must be absent, not 0');
});

check('deploy, org Failed on a component: the failure is failed, everything else ROLLED BACK (all-or-nothing)', () => {
  const run = RR.deployRunFromResult(failedDetails(), BASE());
  assert.strictEqual(run.status, 'failed');
  assert.deepStrictEqual(outcomes(run), {
    'ApexClass:AcmeOrderService': 'rolledback',
    'ApexClass:AcmeInvoiceService': 'failed',
    'CustomObject:AcmeOrder__c': 'rolledback'
  });
  assert.ok(!run.rows.some(r => r.o === 'deployed'), 'nothing of a failed deploy reached the org');
  assert.strictEqual(run.counts.rolledback, 2);
  assert.strictEqual(run.counts.failed, 1);
  assert.ok(!('deployed' in run.counts));
});

check('deploy, org Failed on tests alone: every component rolled back, the test failures are listed', () => {
  const run = RR.deployRunFromResult({
    status: 'Failed', success: false, numberComponentErrors: 0, numberTestsTotal: 40, numberTestsCompleted: 40, numberTestErrors: 2,
    details: { runTestResult: { failures: [
      { name: 'AcmeOrderServiceTest', methodName: 'testTotals', message: 'System.AssertException: Assertion Failed: Expected: 120, Actual: 100', stackTrace: 'Class.AcmeOrderService.total: line 30, column 1\nClass.AcmeOrderServiceTest.testTotals: line 12, column 1' },
      { name: 'AcmeInvoiceServiceTest', methodName: 'testPost', message: '\u001b[31mSystem.NullPointerException\u001b[0m', stackTrace: 'Class.AcmeInvoiceServiceTest.testPost: line 7, column 3' }
    ] } }
  }, BASE({ testLevel: 'RunLocalTests' }));
  assert.strictEqual(run.status, 'failed');
  assert.ok(run.rows.every(r => r.o === 'rolledback'));
  assert.deepStrictEqual(run.tests, [
    // The link opens the TEST class: its own frame wins over the top frame.
    { cls: 'AcmeOrderServiceTest', method: 'testTotals', m: 'System.AssertException: Assertion Failed: Expected: 120, Actual: 100', l: 12, c: 1 },
    { cls: 'AcmeInvoiceServiceTest', method: 'testPost', m: 'System.NullPointerException', l: 7, c: 3 }
  ]);
  assert.strictEqual(run.counts.testsRun, 40);
  assert.strictEqual(run.counts.testsFailed, 2);
});

check('deploy, org SucceededPartial: what landed is deployed, the failure failed, the run is partial', () => {
  const run = RR.deployRunFromResult(failedDetails({ status: 'SucceededPartial' }), BASE());
  assert.strictEqual(run.status, 'partial');
  assert.deepStrictEqual(outcomes(run), {
    'ApexClass:AcmeOrderService': 'deployed',
    'ApexClass:AcmeInvoiceService': 'failed',
    'CustomObject:AcmeOrder__c': 'deployed'
  });
});

check('deploy, org Canceled: cancelled, and nothing is claimed deployed', () => {
  const run = RR.deployRunFromResult({ status: 'Canceled', success: false }, BASE());
  assert.strictEqual(run.status, 'cancelled');
  assert.ok(run.rows.every(r => r.o === 'rolledback'));
});

check('the verdict follows the org status string: success:true with component errors is still a failure', () => {
  const run = RR.deployRunFromResult({ status: 'Failed', success: true, numberComponentErrors: 2 }, BASE());
  assert.strictEqual(run.status, 'failed');
  assert.ok(run.rows.every(r => r.o === 'rolledback'));
});

check('validate, org Succeeded: validated, tests ran', () => {
  const run = RR.deployRunFromResult(ok({ runTestsEnabled: true, numberTestsTotal: 12, numberTestsCompleted: 12, numberTestErrors: 0 }),
    BASE({ op: 'validate', testLevel: 'RunLocalTests', retry: { validateOnly: true, testLevel: 'RunLocalTests' } }));
  assert.strictEqual(run.status, 'succeeded');
  assert.ok(run.rows.every(r => r.o === 'validated'));
  assert.strictEqual(run.testsRan, true);
  assert.deepStrictEqual(run.counts, { validated: 3, failed: 0, skipped: 0, sent: 3, orgDeployed: 3, orgTotal: 3, orgErrors: 0, testsRun: 12, testsFailed: 0 });
});

check('validate with NoTestRun and no runTestsEnabled: tests did not run (so no Quick Deploy later)', () => {
  const run = RR.deployRunFromResult(ok(), BASE({ op: 'validate', testLevel: 'NoTestRun' }));
  assert.strictEqual(run.testsRan, false);
  const prod = RR.deployRunFromResult(ok({ runTestsEnabled: 'true' }), BASE({ op: 'validate', testLevel: 'NoTestRun' }));
  assert.strictEqual(prod.testsRan, true, "the org's own word wins over the picked level (production runs local tests anyway)");
});

check('validate, org Failed: the good components PASSED — never rolled back, never deployed', () => {
  const run = RR.deployRunFromResult(failedFiles(), BASE({ op: 'validate' }));
  assert.strictEqual(run.status, 'failed');
  assert.deepStrictEqual(outcomes(run), {
    'ApexClass:AcmeOrderService': 'passed',
    'ApexClass:AcmeInvoiceService': 'failed',
    'CustomObject:AcmeOrder__c': 'passed'
  });
  assert.ok(!('rolledback' in run.counts));
});

check('validate, org Canceled: cancelled, good rows passed', () => {
  const run = RR.deployRunFromResult({ status: 'Canceled', success: false }, BASE({ op: 'validate' }));
  assert.strictEqual(run.status, 'cancelled');
  assert.ok(run.rows.every(r => r.o === 'passed'));
});

// -------------------------------------------------------------------- retrieve
const RET = (over = {}) => ({ id: 'run0002', org: 'acme-dev-user', orgLabel: 'acme-dev', orgKind: 'sandbox', startedAt: T0, finishedAt: T0 + 9000, target: 'selection', ...over });
check('retrieve: Changed / Created / Unchanged by state, Failed with its problem, asked-for-but-absent is missing', () => {
  const items = [item('ApexClass', 'A'), item('ApexClass', 'B'), item('ApexClass', 'C'), item('ApexClass', 'D'), item('Flow', 'Gone')];
  const run = RR.retrieveRunFromResult({ status: 0, success: true, files: [
    { type: 'ApexClass', fullName: 'A', state: 'Changed' },
    { type: 'ApexClass', fullName: 'B', state: 'Created' },
    { type: 'ApexClass', fullName: 'C', state: 'Unchanged' },
    { type: 'ApexClass', fullName: 'D', state: 'Failed', error: 'entity is locked' }
  ], messages: [{ fileName: 'Flow/Gone', problem: 'Entity of type Flow named Gone cannot be found' }] }, RET({ items, backupDir: '/ws/.backups/1' }));
  assert.deepStrictEqual(outcomes(run), { 'ApexClass:A': 'changed', 'ApexClass:B': 'created', 'ApexClass:C': 'unchanged', 'ApexClass:D': 'failed', 'Flow:Gone': 'missing' });
  assert.strictEqual(run.rows.find(r => r.k === 'ApexClass:D').m, 'entity is locked');
  assert.strictEqual(run.status, 'partial');
  assert.deepStrictEqual(run.counts, { changed: 1, created: 1, unchanged: 1, missing: 1, failed: 1, sent: 5 });
  assert.deepStrictEqual(run.notes, ['Flow/Gone: Entity of type Flow named Gone cannot be found']);
  assert.strictEqual(run.backupDir, '/ws/.backups/1');
});

check('retrieve: one row per component — Failed > Created > Changed > Unchanged across a bundle\'s files', () => {
  const B = 'LightningComponentBundle';
  const files = (states) => states.map((state, i) => ({ type: B, fullName: 'acmeCard', state, filePath: `lwc/acmeCard/f${i}` }));
  const one = (states) => RR.retrieveRunFromResult({ status: 0, success: true, files: files(states) }, RET({ items: [item(B, 'acmeCard')] }));
  assert.deepStrictEqual(one(['Unchanged', 'Changed', 'Unchanged']).rows.map(r => r.o), ['changed']);
  assert.deepStrictEqual(one(['Changed', 'Created']).rows.map(r => r.o), ['created']);
  assert.deepStrictEqual(one(['Created', 'Failed', 'Changed']).rows.map(r => r.o), ['failed']);
  assert.deepStrictEqual(one(['Unchanged']).rows.map(r => r.o), ['unchanged']);
});

check('retrieve: a package.xml wildcard is never reported missing; nothing failed is a success', () => {
  const run = RR.retrieveRunFromResult({ status: 0, success: true, inboundFiles: [{ type: 'ApexClass', fullName: 'A', state: 'Changed' }] },
    RET({ target: 'manifest', items: [{ type: 'ApexClass', name: '*' }] }));
  assert.deepStrictEqual(outcomes(run), { 'ApexClass:A': 'changed' });
  assert.strictEqual(run.status, 'succeeded');
});

// ===================================================== 2) both result shapes
check('details and files shapes produce the same rows, messages and positions', () => {
  const a = RR.deployRunFromResult(failedDetails(), BASE());
  const b = RR.deployRunFromResult(failedFiles(), BASE());
  assert.deepStrictEqual(a.rows, b.rows);
  assert.deepStrictEqual(a.rows.find(r => r.o === 'failed'),
    { k: 'ApexClass:AcmeInvoiceService', o: 'failed', s: 1, m: 'Variable does not exist: acmeTotal', l: 12, c: 5, f: 'AcmeInvoiceService.cls' });
});

check('an empty details array falls through to files (the success-row reader is shared)', () => {
  assert.strictEqual(reexported, RR.deploySuccessRows, 'panelProvider re-exports the moved reader');
  const rows = RR.deploySuccessRows({ details: { componentSuccesses: [] }, files: [{ type: 'ApexClass', fullName: 'A', state: 'Changed' }] });
  assert.deepStrictEqual(rows.map(r => r.fullName), ['A']);
});

check('the org request-level message lands on the run, flattened and bounded', () => {
  const run = RR.deployRunFromResult({ status: 'Failed', success: false, errorMessage: 'Deploy failed.\n\tAcmeThing: Invalid type: acme__mdt' }, BASE());
  assert.strictEqual(run.message, 'Deploy failed. AcmeThing: Invalid type: acme__mdt');
  const long = RR.deployRunFromResult({ status: 'Failed', success: false, errorMessage: 'x'.repeat(5000) }, BASE());
  assert.ok(long.message.length <= 400);
});

// ============================================ 3) mapping failures onto the request
check('localKeyOf maps a bundle file failure onto its component, which becomes the failed row', () => {
  const B = 'LightningComponentBundle';
  const items = [item(B, 'acmeCard'), item('ApexClass', 'AcmeOrderService')];
  const run = RR.deployRunFromResult({ status: 'Failed', success: false, files: [
    { type: B, fullName: 'acmeCard/acmeCard.js', state: 'Failed', error: 'Unexpected token', lineNumber: 3, filePath: 'lwc/acmeCard/acmeCard.js' }
  ] }, BASE({ items, localKeyOf: (f) => (f.fullName.startsWith('acmeCard') ? `${B}:acmeCard` : undefined) }));
  assert.deepStrictEqual(outcomes(run), { [`${B}:acmeCard`]: 'failed', 'ApexClass:AcmeOrderService': 'rolledback' });
  assert.strictEqual(run.rows[0].s, 1);
  assert.strictEqual(run.rows[0].f, 'acmeCard.js');
});

check('an unmapped failure is its own failed row (Type:Name as the org spelled it) and is NOT sent', () => {
  const run = RR.deployRunFromResult({ status: 'Failed', success: false, details: { componentFailures: [
    { componentType: 'ApexClass', fullName: 'AcmeDependent', problem: 'Dependent class is invalid and needs recompilation' }
  ] } }, BASE({ localKeyOf: () => undefined }));
  const row = run.rows.find(r => r.k === 'ApexClass:AcmeDependent');
  assert.ok(row, 'the failure must still be listed');
  assert.strictEqual(row.o, 'failed');
  assert.strictEqual(row.s, undefined, 'it was never part of the request, so a Retry must not send it');
  assert.strictEqual(run.counts.sent, 3);
});

check('a failure mapped to a local component OUTSIDE the request is listed under that key, not sent', () => {
  const run = RR.deployRunFromResult(failedDetails(), BASE({ items: [ITEMS[0]], localKeyOf: () => 'ApexClass:AcmeLocalOther' }));
  const row = run.rows.find(r => r.k === 'ApexClass:AcmeLocalOther');
  assert.ok(row && row.o === 'failed' && row.s === undefined);
});

check('two failures on one component are one row: both messages, the first position', () => {
  const run = RR.deployRunFromResult({ status: 'Failed', success: false, details: { componentFailures: [
    { componentType: 'ApexClass', fullName: 'AcmeInvoiceService', problem: 'first problem' },
    { componentType: 'ApexClass', fullName: 'AcmeInvoiceService', problem: 'second problem', lineNumber: 40, columnNumber: 2 }
  ] } }, BASE());
  const rows = run.rows.filter(r => r.k === 'ApexClass:AcmeInvoiceService');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].m, 'first problem\nsecond problem');
  assert.strictEqual(rows[0].l, 40);
  assert.strictEqual(run.counts.failed, 1);
});

check('failure text is org-controlled: ANSI and control characters out, capped', () => {
  const run = RR.deployRunFromResult({ status: 'Failed', success: false, details: { componentFailures: [
    { componentType: 'ApexClass', fullName: 'AcmeInvoiceService', problem: '\u001b[31mbad\u001b[0m\u0007 thing ' + 'y'.repeat(900) }
  ] } }, BASE());
  const m = run.rows.find(r => r.o === 'failed').m;
  assert.ok(m.startsWith('bad  thing'), JSON.stringify(m.slice(0, 20)));
  assert.ok(m.length <= RR.ROW_MESSAGE_MAX);
});

// ------------------------------------------------------------ the skipped split
check('skipped rows carry why (org / unread), are never sent, and count as skipped', () => {
  const run = RR.deployRunFromResult(ok(), BASE({ skipped: {
    orgOnly: [{ type: 'Report', name: 'AcmeReports/Acme_Pipeline' }, { type: 'Layout', name: 'AcmeOrder__c-Acme Layout' }],
    unread: [{ type: 'Bot', name: 'AcmeHelper' }]
  } }));
  const skipped = run.rows.filter(r => r.o === 'skipped');
  assert.deepStrictEqual(skipped.map(r => [r.k, r.why]), [
    ['Bot:AcmeHelper', 'unread'],
    ['Report:AcmeReports/Acme_Pipeline', 'org'],
    ['Layout:AcmeOrder__c-Acme Layout', 'org']
  ]);
  assert.ok(skipped.every(r => r.s === undefined), 'a skipped row has no local file — it can never be re-sent');
  assert.strictEqual(run.counts.skipped, 3);
  assert.strictEqual(run.counts.sent, 3);
});

check('a run that cannot know its skipped rows has no skipped count at all', () => {
  const run = RR.deployRunFromResult(ok(), BASE({ skipped: undefined }));
  assert.ok(!('skipped' in run.counts));
});

// ------------------------------------------------- Retry keys = today's retry keys
const CASES = [
  ['a success', ok(), {}],
  ['a component failure (details)', failedDetails(), {}],
  ['a component failure (files)', failedFiles(), {}],
  ['an unmapped failure plus skipped rows', failedDetails({ details: { componentFailures: [{ componentType: 'ApexClass', fullName: 'Elsewhere', problem: 'x' }, DETAIL_FAIL] } }),
    { skipped: { orgOnly: [{ type: 'Report', name: 'R' }], unread: [{ type: 'Bot', name: 'B' }] }, localKeyOf: (f) => (f.fullName === 'Elsewhere' ? undefined : `ApexClass:${f.fullName}`) }],
  ['a validation', failedFiles(), { op: 'validate' }],
  ['a single pointed-at file', failedFiles(), { target: 'sourceDir', items: [ITEMS[1]] }]
];
for (const [label, result, over] of CASES) {
  check(`Retry keys equal buildRetryRequest's for ${label}`, () => {
    const input = BASE(over);
    const run = RR.deployRunFromResult(result, input);
    const legacy = buildRetryRequest({ validateOnly: input.op === 'validate', sourceDir: input.target === 'sourceDir' ? '/ws/x' : undefined }, input.items, 'NoTestRun', []);
    assert.deepStrictEqual(RR.sentKeys(run), legacy.keys);
  });
}

check('a reattached report: every non-package.xml row is sent, and an un-itemized org count still shows', () => {
  const run = RR.deployRunFromResult({ status: 'Succeeded', success: true, numberComponentsDeployed: 250, files: [
    { type: 'ApexClass', fullName: 'A', state: 'Changed' },
    { type: 'package.xml', fullName: 'package.xml', state: 'Changed' },
    { type: 'ApexClass', fullName: 'B', state: 'Unchanged' }
  ] }, BASE({ target: 'report', items: undefined, skipped: undefined }));
  assert.deepStrictEqual(RR.sentKeys(run), ['ApexClass:A', 'ApexClass:B']);
  assert.strictEqual(run.counts.deployed, 250, 'the chip shows what the org counted, not the two rows it itemized');
  assert.strictEqual(run.rowsComplete, true);
});

// =========================================================== 4) summary caps
function bigRun({ deployed = 0, failures = 0, skipped = 0, tests = 0, msgLen = 30 } = {}) {
  const rows = [];
  for (let i = 0; i < failures; i++) rows.push({ k: `ApexClass:AcmeFail${i}`, o: 'failed', s: 1, m: `F${i} `.padEnd(msgLen, 'e'), l: i + 1, c: 1, f: `AcmeFail${i}.cls` });
  for (let i = 0; i < deployed; i++) rows.push({ k: `CustomField:AcmeObj__c.AcmeField${i}__c`, o: 'rolledback', s: 1 });
  for (let i = 0; i < skipped; i++) rows.push({ k: `Report:AcmeReports/Acme_Report_${i}`, o: 'skipped', why: 'org' });
  const testRows = [];
  for (let i = 0; i < tests; i++) testRows.push({ cls: `AcmeTest${i}`, method: `testMethod${i}`, m: `T${i} `.padEnd(msgLen, 'a'), l: 3, c: 1 });
  const counts = { rolledback: deployed, failed: failures, skipped, sent: deployed + failures, testsRun: tests + 100, testsFailed: tests };
  return {
    v: 1, id: 'run0big', op: 'deploy', status: 'failed', org: 'acme-prod-user', orgLabel: 'acme-prod', orgKind: 'prod',
    startedAt: T0, finishedAt: T0 + 1, target: 'selection', testLevel: 'RunLocalTests', testsRan: true,
    counts, rows, rowsComplete: true, tests: testRows,
    message: 'M'.repeat(3000), hint: 'retry later', cliActions: ['sf project deploy report'], notes: ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'],
    retry: { validateOnly: false, testLevel: 'RunLocalTests' }, conflict: true, backupDir: '/ws/.backups/2', suggestId: 'sug-1-2', jobId: '0AfAc000001kR2mSAE',
    // Live-only payloads the provider merges in when posting — never persisted.
    suggest: { id: 'sug-1-2', candidates: [], unresolved: [] }, quick: { jobId: '0AfAc000001kR2mSAE', until: T0 }
  };
}

check('a 10k-row run: the newest summary fits 40 KB, an older one 10 KB, counts stay exact', () => {
  const run = bigRun({ deployed: 9000, failures: 300, skipped: 700, tests: 60, msgLen: 500 });
  assert.strictEqual(run.rows.length, 10_000);
  const latest = RR.summarizeRun(run, { latest: true });
  const older = RR.summarizeRun(run, { latest: false });
  assert.ok(RR.packedSize(latest) <= RR.LATEST_SUMMARY_MAX_BYTES, `latest summary is ${RR.packedSize(latest)} bytes`);
  assert.ok(RR.packedSize(older) <= RR.OLDER_SUMMARY_MAX_BYTES, `older summary is ${RR.packedSize(older)} bytes`);
  assert.deepStrictEqual(latest.counts, run.counts);
  assert.deepStrictEqual(older.counts, run.counts);
  assert.strictEqual(latest.rowsComplete, false);
  assert.ok(latest.rows.length > 0 && latest.rows[0].o === 'failed', 'failures lead what survives');
});

check('summary caps are exact: newest 100 failed + 50 skipped + 50 tests; older 25 failed, no skipped, 10 tests', () => {
  const run = bigRun({ deployed: 40, failures: 150, skipped: 80, tests: 70, msgLen: 20 });
  const latest = RR.summarizeRun(run, { latest: true });
  assert.ok(RR.packedSize(latest) <= RR.LATEST_SUMMARY_MAX_BYTES, 'this fixture must stay under the byte budget so the count caps are what is measured');
  assert.strictEqual(latest.rows.filter(r => r.o === 'failed').length, 100);
  assert.strictEqual(latest.rows.filter(r => r.o === 'skipped').length, 50);
  assert.strictEqual(latest.rows.length, 150, 'only failures and skipped rows are summarized');
  assert.strictEqual(latest.tests.length, 50);
  assert.deepStrictEqual(latest.rows.slice(0, 3).map(r => r.k), ['ApexClass:AcmeFail0', 'ApexClass:AcmeFail1', 'ApexClass:AcmeFail2']);
  const older = RR.summarizeRun(run, { latest: false });
  assert.strictEqual(older.rows.length, 25);
  assert.ok(older.rows.every(r => r.o === 'failed'));
  assert.strictEqual(older.tests.length, 10);
});

check('the newest summary keeps what its buttons need; an older one keeps none of it; live payloads never persist', () => {
  const run = bigRun({ failures: 2 });
  const latest = RR.summarizeRun(run, { latest: true });
  assert.deepStrictEqual(latest.retry, { validateOnly: false, testLevel: 'RunLocalTests' });
  assert.strictEqual(latest.conflict, true);
  assert.strictEqual(latest.backupDir, '/ws/.backups/2');
  assert.strictEqual(latest.suggestId, 'sug-1-2');
  assert.strictEqual(latest.message.length, 2000);
  assert.strictEqual(latest.notes.length, 5);
  const older = RR.summarizeRun(run, { latest: false });
  for (const k of ['retry', 'conflict', 'backupDir', 'suggestId', 'notes', 'hint', 'cliActions']) assert.ok(!(k in older), `older run kept ${k}`);
  assert.strictEqual(older.message.length, 1000);
  for (const s of [latest, older]) {
    assert.ok(!('suggest' in s) && !('quick' in s), 'live-only payloads must never reach storage');
    assert.strictEqual(s.jobId, '0AfAc000001kR2mSAE');
  }
});

check('a run whose rows are all failures or skipped keeps them all: the summary is complete', () => {
  const run = bigRun({ failures: 4, skipped: 3 });
  assert.strictEqual(RR.summarizeRun(run, { latest: true }).rowsComplete, true);
  assert.strictEqual(RR.summarizeRun(run, { latest: false }).rowsComplete, false, 'an older run drops its skipped rows');
});

check('summarizing twice changes nothing more', () => {
  const run = bigRun({ deployed: 500, failures: 120, skipped: 60, tests: 55 });
  const once = RR.summarizeRun(run, { latest: true });
  assert.deepStrictEqual(RR.summarizeRun(once, { latest: true }), once);
});

// ============================================================ 5) normalize
const GOOD = () => RR.summarizeRun(RR.deployRunFromResult(failedDetails(), BASE({ retry: { validateOnly: false, testLevel: 'NoTestRun' }, conflict: true })), { latest: true });
const state = (...runs) => ({ v: 1, runs });

check('a valid persisted run round-trips through JSON unchanged', () => {
  const run = GOOD();
  const back = RR.normalizeRunsState(JSON.parse(JSON.stringify(state(run))));
  assert.deepStrictEqual(back.runs, [run]);
});

check('junk state degrades to an empty history, never a throw', () => {
  for (const raw of [undefined, null, 0, 'runs', [], [GOOD()], { runs: [GOOD()] }, { v: 2, runs: [GOOD()] }, { v: 1, runs: 'x' }, { v: 1 }]) {
    assert.deepStrictEqual(RR.normalizeRunsState(raw), { v: 1, runs: [] }, JSON.stringify(raw));
  }
});

const BAD = [
  ['an unknown op', { op: 'delete' }],
  ['an unknown status', { status: 'done' }],
  ['an unknown target', { target: 'everything' }],
  ['a flag-shaped org', { org: '-x' }],
  ['a flag-shaped org (long form)', { org: '--target-org=evil' }],
  ['an org with whitespace', { org: 'acme dev' }],
  ['an empty org', { org: '' }],
  ['a missing org label', { orgLabel: undefined }],
  ['a job id with shell characters', { jobId: '0AfAc000001k;rm -rf' }],
  ['a job id that is not a deploy id', { jobId: '09SAc000001hZ3kMAE' }],
  ['a non-string job id', { jobId: 12345 }],
  ['a run id with capitals', { id: 'RUN0001' }],
  ['a too-short run id', { id: 'r1' }],
  ['a non-numeric start', { startedAt: '2026-09-25' }],
  ['a future version', { v: 2 }],
  ['a non-string backup folder', { backupDir: ['/etc'] }],
  ['a retry that is not an object', { retry: 'deploy everything' }],
  ['a retry test class with shell characters', { retry: { validateOnly: false, runTests: ['AcmeTest; rm'] } }],
  ['a retry sourceDir that is not a string', { retry: { validateOnly: false, sourceDir: 7 } }],
  ['a suggestion id with odd characters', { suggestId: '../../x' }],
  ['a quick-deploy source id that is not a run id', { fromRunId: '--x' }]
];
for (const [label, patch] of BAD) {
  check(`normalize drops a run with ${label}`, () => {
    const run = { ...GOOD(), ...patch };
    const back = RR.normalizeRunsState(state(run, { ...GOOD(), id: 'run0keep' }));
    assert.deepStrictEqual(back.runs.map(r => r.id), ['run0keep']);
  });
}

check('normalize repairs what it can: junk rows, a sent flag on a skipped row, junk counts', () => {
  const run = { ...GOOD(), rows: [
    { k: 'ApexClass:A', o: 'failed', s: 1, m: 'x' },
    { k: 'ApexClass:B', o: 'exploded' },
    { o: 'failed' },
    { k: 'no-colon', o: 'failed' },
    { k: 'Report:R', o: 'skipped', s: 1, why: 'org' },
    { k: 'ApexClass:C', o: 'failed', why: 'org', l: -3, c: 1.5, f: '../../etc/passwd' }
  ], counts: { failed: 2, skipped: -1, sent: 'many', bogus: 3, rolledback: 2 }, rowsComplete: true };
  const [back] = RR.normalizeRunsState(state(run)).runs;
  assert.deepStrictEqual(back.rows, [
    { k: 'ApexClass:A', o: 'failed', s: 1, m: 'x' },
    { k: 'Report:R', o: 'skipped', why: 'org' },
    { k: 'ApexClass:C', o: 'failed' }
  ]);
  assert.deepStrictEqual(back.counts, { failed: 2, rolledback: 2 });
  assert.strictEqual(back.rowsComplete, false, 'rows were dropped, so the list is not complete any more');
});

check('normalize keeps the first of two runs with one id, sorts newest first, keeps at most 10', () => {
  const runs = [];
  for (let i = 0; i < 14; i++) runs.push({ ...GOOD(), id: `run${String(i).padStart(4, '0')}`, startedAt: T0 + i * 1000 });
  runs.push({ ...GOOD(), id: 'run0003', startedAt: T0 + 99_000 });
  const back = RR.normalizeRunsState(state(...runs)).runs;
  assert.strictEqual(back.length, 10);
  assert.strictEqual(back[0].id, 'run0013');
  assert.ok(back.every((r, i) => i === 0 || back[i - 1].startedAt >= r.startedAt));
  assert.ok(!back.some(r => r.startedAt === T0 + 99_000), 'the duplicate id must not replace the first copy');
});

// ============================================================ 6) migration
const legacyCards = () => Array.from({ length: 14 }, (_, i) => ({
  kind: i % 2 ? 'err' : 'ok', title: `Card ${i}`, at: T0 - i * 1000, lines: [`line ${i}`],
  buttons: [{ label: 'Retry deploy', send: { type: 'retryDeploy', request: { keys: Array.from({ length: 3000 }, (_, k) => `ApexClass:K${k}`) } } }],
  quickDeploy: { jobId: '0AfAc000001kM7pSAE', label: 'Quick Deploy' }
}));

check('first start after an upgrade: the 10 newest cards become button-less notices and an empty run history is created', () => {
  const { notices, runsState, migrated } = RR.migrateCardHistory(legacyCards(), undefined);
  assert.strictEqual(migrated, true);
  assert.deepStrictEqual(runsState, { v: 1, runs: [] });
  assert.strictEqual(notices.length, RR.NOTICES_MAX);
  assert.deepStrictEqual(notices.map(n => n.title), legacyCards().slice(0, 10).map(c => c.title));
  assert.ok(notices.every(n => !('buttons' in n) && !('quickDeploy' in n)), 'a notice is a record, never an action');
  assert.ok(RR.packedSize(notices) < 5_000, 'the Retry key lists of old failure cards must not be carried over');
});

check('migration is idempotent: reading its own output changes nothing and writes nothing', () => {
  const first = RR.migrateCardHistory(legacyCards(), undefined);
  const again = RR.migrateCardHistory(JSON.parse(JSON.stringify(first.notices)), JSON.parse(JSON.stringify(first.runsState)));
  assert.strictEqual(again.migrated, false);
  assert.deepStrictEqual(again.notices, first.notices);
  assert.deepStrictEqual(again.runsState, first.runsState);
});

check('a later start heals cards that still carry buttons and normalizes the runs', () => {
  const { notices, runsState, migrated } = RR.migrateCardHistory([...legacyCards(), null, 'x', [1]], state(GOOD(), { op: 'nope' }));
  assert.strictEqual(migrated, false);
  assert.strictEqual(notices.length, 10);
  assert.ok(notices.every(n => !('buttons' in n)));
  assert.strictEqual(runsState.runs.length, 1);
});

// ============================================================ 7) trim + setting
check('trimRuns keeps the newest N and never evicts a running run', () => {
  const r = (id, status) => ({ ...GOOD(), id, status });
  const runs = [r('run0005', 'succeeded'), r('run0004', 'failed'), r('run0003', 'running'), r('run0002', 'failed')];
  assert.deepStrictEqual(RR.trimRuns(runs, 3).map(x => x.id), ['run0005', 'run0004', 'run0003']);
  assert.deepStrictEqual(RR.trimRuns(runs, 1).map(x => x.id), ['run0005', 'run0003']);
  assert.deepStrictEqual(RR.trimRuns(runs, 10).map(x => x.id), ['run0005', 'run0004', 'run0003', 'run0002']);
});

check('the run cap is clamped to 1..10 (VS Code does not enforce a setting\'s bounds)', () => {
  const cases = [[3, 3], [1, 1], [10, 10], [0, 1], [-4, 1], [11, 10], [2.6, 3], ['5', 3], [NaN, 3], [undefined, 3], [Infinity, 3]];
  for (const [raw, want] of cases) assert.strictEqual(RR.clampRunCap(raw), want, String(raw));
});

check('new run ids match the persisted-id guard and differ within one millisecond', () => {
  let n = 0;
  const seq = () => (++n) / 7;
  const a = RR.newRunId(T0, seq);
  const b = RR.newRunId(T0, seq);
  assert.ok(RR.RUN_ID_RE.test(a) && RR.RUN_ID_RE.test(b), `${a} ${b}`);
  assert.notStrictEqual(a, b);
});

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
check('package.json: sfOrgDeployWrapper.statusHistoryRuns is a number, default 3, 1–10, matching the clamp', () => {
  const s = pkg.contributes.configuration.properties['sfOrgDeployWrapper.statusHistoryRuns'];
  assert.ok(s, 'the setting is declared');
  assert.strictEqual(s.type, 'number');
  assert.strictEqual(s.default, RR.RUN_CAP_DEFAULT);
  assert.strictEqual(s.minimum, 1);
  assert.strictEqual(s.maximum, RR.RUN_CAP_MAX);
});

check('runRecords.js loads without vscode (the webview-free harness depends on it)', () => {
  const src = fs.readFileSync(path.join(OUT, 'runRecords.js'), 'utf8');
  assert.ok(!/require\(["']vscode["']\)/.test(src));
});

check('this harness is registered in package.json "check"', () => {
  assert.ok(pkg.scripts.check.includes('node ./scripts/check-run-records.cjs'));
});

if (failed) { console.error(`run-records: ${failed}/${ran} checks FAILED`); process.exit(1); }
console.log(`run-records: all ${ran} checks passed`);
