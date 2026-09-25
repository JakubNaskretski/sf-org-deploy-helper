// Runnable contract test for the runs a deploy or validation produces — driven
// through the REAL runDeploy / runManifestDeploy / reattach / quick-deploy code
// (panelProvider.ts) on a prototype double, with `sf` scripted. No framework.
//   1) npm run compile   2) node scripts/check-run-producers.cjs
//
// A run starts the moment the deploy is confirmed and every way the call can end
// must finish that same run — a run left "running" would sit on the Status pane
// until the next reload. Pinned here, one path each:
//   - start: what it sends (no verdict yet) and what it skipped, posted with its
//     full list; poll ticks become counts only;
//   - the org's result: succeeded / failed (+ its suggestion) / cancelled by the
//     org, each on the SAME run id;
//   - no result: lost contact (Resume), a refused submit (+ Retry + overwrite for
//     a conflict), a timed-out submit, a killed submit, a failed package.xml
//     write — each keeps what was sent, so a Retry can send it again;
//   - Quick Deploy's offer on a validation that ran tests, and its "used" state;
//   - after a window reload: the job's own run stays running and the reattach
//     finishes that SAME run (skipped rows and count kept, Retry at the original
//     test level); a run with no job left, or whose job is too old, is
//     "interrupted"; a lost run's Resume picks the same run up again;
//   - a reattached job no run began (an older version's) and a package.xml deploy.
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const warns = [];
const vscodeStub = {
  window: {
    showWarningMessage: (message, options, ...items) => {
      warns.push({ message, modal: !!(options && options.modal) });
      return Promise.resolve(options && options.modal ? items[0] : undefined);
    },
    showInformationMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
    setStatusBarMessage: () => ({ dispose() {} }),
    withProgress: (_o, body) => body({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) })
  },
  workspace: { getConfiguration: () => ({ get: (k, d) => d, update: async () => {} }) },
  commands: { executeCommand: async () => {} },
  Uri: { file: fsPath => ({ fsPath, scheme: 'file' }) },
  ProgressLocation: { Notification: 15, Window: 10 },
  ConfigurationTarget: { Global: 1 },
  env: { clipboard: { writeText: async () => {} } }
};
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? vscodeStub : origLoad(req, ...rest));

const { DeployPanelProvider } = require(path.join(ROOT, 'out', 'panelProvider.js'));
const { SfCliError, SfCliCancelledError } = require(path.join(ROOT, 'out', 'sfCliService.js'));
const RR = require(path.join(ROOT, 'out', 'runRecords.js'));
const RV = require(path.join(ROOT, 'src', 'runView.js'));
const proto = DeployPanelProvider.prototype;

let failed = 0;
const queue = [];
const check = (name, fn) => queue.push([name, fn]);

const ORG = 'acme-dev-user';
const JOB = '0AfAc000001kQ9zSAE';
const cls = (name) => ({ type: 'ApexClass', name, filePath: `/ws/force-app/main/default/classes/${name}.cls`, files: [] });
const ITEMS = [cls('AcmeOrderService'), cls('AcmeInvoiceService'), cls('AcmeLedgerSync')];
const KEYS = ITEMS.map(i => `${i.type}:${i.name}`);
const ORG_ONLY = 'ApexClass:AcmeOrgOnly';

/** A provider on the real prototype. `submit` / `report` script the CLI;
 *  `poll` replaces the poll loop when a check needs an outcome the real loop
 *  only reaches after minutes (lost contact, an unconfirmed cancel). */
function provider(extra = {}) {
  const posted = [];
  const kept = extra.state ? JSON.parse(JSON.stringify(extra.state)) : {};
  const toasts = [];
  const s = Object.create(proto);
  const sf = {
    deployMetadata: () => ({
      promise: extra.submitError ? Promise.reject(extra.submitError) : Promise.resolve({ result: { id: JOB }, cmd: 'sf project deploy start --json' }),
      cancel: () => undefined
    }),
    deployReport: () => ({ promise: Promise.resolve({ result: extra.report ?? { id: JOB, status: 'Succeeded', success: true, done: true } }), cancel: () => undefined }),
    quickDeploy: () => ({ promise: Promise.resolve({ result: { id: '0AfAc000001kQuickAE' }, cmd: 'sf project deploy quick --json' }), cancel: () => undefined }),
    runCancellable: () => ({ promise: Promise.resolve({ stdout: 'sf 0.0.0-test', stderr: '', code: 0 }), cancel: () => undefined })
  };
  Object.assign(s, {
    busy: false, confirmOpen: false, deployQueue: [], cmdSeq: 0,
    orgMembers: new Map([[ORG_ONLY, {}]]), orgMembersOrg: ORG,
    items: ITEMS, workspaceRoot: '/ws', liveSuggestions: new Map(), suggestionSeq: 0,
    testLevel: undefined, runTests: undefined,
    orgs: [{ username: ORG, alias: 'acme-dev', instanceUrl: 'https://acme-dev.sandbox.my.salesforce.com', isSandbox: true }],
    learnedRules: () => [],
    orgStore: { get: () => ORG, set: async () => {}, setFromUserPick: async () => {} },
    output: { appendLine: () => {} },
    context: {
      workspaceState: { get: k => kept[k], update: async (k, v) => { kept[k] = v === undefined ? undefined : JSON.parse(JSON.stringify(v)); } },
      globalState: { get: () => undefined, update: async () => {} }
    },
    view: { visible: true, webview: { postMessage() {} } },
    sf,
    post: m => posted.push(JSON.parse(JSON.stringify(m))),
    failureToast: (message) => toasts.push(message),
    ...(extra.poll ? { pollDeployJob: extra.poll } : {}),
    ...(extra.fields || {})
  });
  return { s, posted, kept, toasts };
}
const runsPosts = (p) => p.posted.filter(m => m.type === 'runs');
const last = (p) => runsPosts(p).slice(-1)[0];
const deploy = (p, keys = [...KEYS, ORG_ONLY], opts = {}) => proto.runDeploy.call(p.s, keys, opts);

// ================================================================ the start
check('confirmed: a running run with what it sends (no verdict yet) and what it skipped, posted with its full list', async () => {
  let seen;
  const p = provider({ poll: async function () { seen = JSON.parse(JSON.stringify(p.kept.statusRuns)); return { kind: 'terminal', result: { id: JOB, status: 'Succeeded', success: true, done: true } }; } });
  await deploy(p);
  const begun = runsPosts(p)[0];
  const run = begun.runs[0];
  assert.strictEqual(run.status, 'running');
  assert.strictEqual(run.op, 'deploy');
  assert.strictEqual(run.orgKind, 'sandbox');
  assert.deepStrictEqual(begun.latestRows.rows.map(r => [r.k, r.o, r.s ?? null, r.why ?? null]), [
    ...KEYS.map(k => [k, 'pending', 1, null]),
    [ORG_ONLY, 'skipped', null, 'org']
  ]);
  assert.deepStrictEqual(run.counts, { pending: 3, sent: 3, skipped: 1 });
  assert.deepStrictEqual(run.retry, { validateOnly: false, testLevel: 'NoTestRun' }, 'what a Retry would re-run with — never the keys themselves');
  assert.strictEqual(seen.runs[0].status, 'running');
  assert.strictEqual(seen.runs[0].jobId, JOB, 'the job id is kept with the run once the org has one');
});

check('a poll tick is posted as counts only, and never rewrites workspaceState', async () => {
  let writesAtTick;
  const p = provider({
    poll: async function (_jobId, _org, _root, progress) {
      const before = JSON.stringify(p.kept);
      progress({ status: 'InProgress', numberComponentsDeployed: 2, numberComponentsTotal: 3, numberTestsCompleted: 0, numberTestsTotal: 4, numberComponentErrors: 1, details: { componentFailures: [{ fullName: 'x' }] } });
      writesAtTick = JSON.stringify(p.kept) === before;
      return { kind: 'terminal', result: { id: JOB, status: 'Succeeded', success: true, done: true } };
    }
  });
  await deploy(p);
  const tick = p.posted.find(m => m.type === 'runProgress');
  assert.deepStrictEqual(Object.keys(tick).sort(), ['compDone', 'compTotal', 'errors', 'id', 'orgStatus', 'testDone', 'testTotal', 'type']);
  assert.deepStrictEqual([tick.compDone, tick.compTotal, tick.testDone, tick.testTotal, tick.errors, tick.orgStatus], [2, 3, 0, 4, 1, 'InProgress']);
  assert.strictEqual(tick.id, runsPosts(p)[0].runs[0].id);
  assert.ok(writesAtTick, 'a tick must not write');
});

// ============================================================ the org's result
check('succeeded: the SAME run finishes, every sent row deployed, the skipped row still skipped', async () => {
  const p = provider();
  await deploy(p);
  const id = runsPosts(p)[0].runs[0].id;
  const done = last(p);
  assert.strictEqual(done.runs[0].id, id, 'one run, from start to result');
  assert.strictEqual(done.runs[0].status, 'succeeded');
  assert.deepStrictEqual(done.latestRows.rows.map(r => r.o), ['deployed', 'deployed', 'deployed', 'skipped']);
  assert.strictEqual(p.kept.statusRuns.runs.length, 1);
  assert.strictEqual(p.kept.statusRuns.runs[0].status, 'succeeded');
  assert.ok(!p.posted.some(m => m.type === 'status'), 'a deploy result is a run, not a card');
});

check('failed: rolled back and failed rows on the same run, the toast still fires, Retry sends exactly what was sent', async () => {
  const p = provider({ report: { id: JOB, status: 'Failed', success: false, done: true, numberComponentErrors: 1, details: { componentFailures: [
    { componentType: 'ApexClass', fullName: 'AcmeInvoiceService', problem: 'Variable does not exist: acmeTotal', lineNumber: 7 }
  ] } } });
  const outcome = await deploy(p);
  assert.strictEqual(outcome.status, 'failed');
  const { runs: [run], latestRows } = last(p);
  assert.strictEqual(run.status, 'failed');
  assert.deepStrictEqual(latestRows.rows.map(r => r.o), ['rolledback', 'failed', 'rolledback', 'skipped']);
  assert.strictEqual(p.toasts.length, 1, 'failureToast still mirrors the failure');
  const retry = RV.actionsFor(run, { isLatest: true, complete: true, sent: RR.sentKeys({ rows: latestRows.rows }) }).buttons.find(b => b.id === 'retry');
  assert.deepStrictEqual(retry.message.request.keys, KEYS, 'never the skipped org-only row');
});

check('failed with a dependency the workspace has: the suggestion rides the run (id kept, payload live)', async () => {
  const withObj = [...ITEMS, { type: 'CustomObject', name: 'AcmeRate__mdt', filePath: '/ws/force-app/main/default/objects/AcmeRate__mdt', files: [] }];
  const p = provider({ fields: { items: withObj }, report: { id: JOB, status: 'Failed', success: false, done: true, errorMessage: 'AcmeOrderService: Invalid type: AcmeRate__mdt' } });
  await deploy(p);
  const run = last(p).runs[0];
  assert.ok(run.suggest && run.suggest.candidates.some(c => c.key === 'CustomObject:AcmeRate__mdt'), JSON.stringify(run.suggest));
  assert.strictEqual(p.kept.statusRuns.runs[0].suggestId, run.suggest.id);
  assert.ok(!('suggest' in p.kept.statusRuns.runs[0]), 'the payload is never stored');
});

check('the org cancelled it: an honest "cancelled" run, rolled back — no failure toast', async () => {
  const p = provider({ report: { id: JOB, status: 'Canceled', success: false, done: true } });
  const outcome = await deploy(p);
  assert.strictEqual(outcome.status, 'aborted');
  assert.strictEqual(last(p).runs[0].status, 'cancelled');
  assert.ok(last(p).latestRows.rows.filter(r => r.s === 1).every(r => r.o === 'rolledback'));
  assert.strictEqual(p.toasts.length, 0);
});

// ================================================================ no result
check('lost contact: the run is "lost", keeps its job id and what it sent — Resume monitoring, never a new deploy', async () => {
  const p = provider({ poll: async () => ({ kind: 'lost' }) });
  await deploy(p);
  const { runs: [run], latestRows } = last(p);
  assert.strictEqual(run.status, 'lost');
  assert.strictEqual(run.jobId, JOB);
  assert.deepStrictEqual(latestRows.rows.filter(r => r.s === 1).map(r => r.k), KEYS);
  const acts = RV.actionsFor(run, { isLatest: true, complete: true, sent: KEYS });
  assert.deepStrictEqual(acts.buttons.find(b => b.id === 'resume').message, { type: 'resumeDeploy', jobId: JOB });
  assert.ok(!p.posted.some(m => m.type === 'status'), 'no separate lost-contact card');
  assert.strictEqual(p.toasts.length, 1, 'the toast still says so');
});

check('a submit refused by the conflict check: an "error" run with the CLI\'s words, the hint, and Retry + overwrite', async () => {
  const err = new SfCliError('SourceConflictError: 2 conflicts detected');
  err.errorName = 'SourceConflictError';
  err.actions = ['Retrieve the conflicting components first.'];
  const p = provider({ submitError: err });
  const outcome = await deploy(p);
  assert.strictEqual(outcome.status, 'aborted');
  assert.strictEqual(outcome.confirmed, true);
  const { runs: [run], latestRows } = last(p);
  assert.strictEqual(run.status, 'error');
  assert.strictEqual(run.conflict, true);
  assert.ok(run.message.includes('2 conflicts detected'));
  assert.ok(/conflict/i.test(run.hint));
  assert.deepStrictEqual(run.cliActions, ['Retrieve the conflicting components first.']);
  const acts = RV.actionsFor(run, { isLatest: true, complete: true, sent: RR.sentKeys({ rows: latestRows.rows }) });
  const over = acts.buttons.find(b => b.id === 'retryOverwrite');
  assert.deepStrictEqual(over.message.request, { validateOnly: false, testLevel: 'NoTestRun', keys: KEYS, ignoreConflicts: true });
  assert.ok(!p.posted.some(m => m.type === 'status'), 'no separate error card');
});

check('a validation refused the same way offers no overwrite (it writes nothing)', async () => {
  const err = new SfCliError('SourceConflictError: 1 conflict detected');
  err.errorName = 'SourceConflictError';
  const p = provider({ submitError: err });
  await deploy(p, KEYS, { validateOnly: true, testLevel: 'RunLocalTests' });
  const { runs: [run], latestRows } = last(p);
  assert.strictEqual(run.op, 'validate');
  const ids = RV.actionsFor(run, { isLatest: true, complete: true, sent: RR.sentKeys({ rows: latestRows.rows }) }).buttons.map(b => b.id);
  assert.ok(ids.includes('retry') && !ids.includes('retryOverwrite'), ids.join(','));
});

check('a submit that timed out: a "timeout" run that says the org may still finish it', async () => {
  const p = provider({ submitError: new SfCliError('Command timed out after 180000ms') });
  await deploy(p);
  const run = last(p).runs[0];
  assert.strictEqual(run.status, 'timeout');
  assert.ok(/commandTimeoutMs/.test(run.hint), run.hint);
});

check('a submit killed by Cancel: the run says the org may still have taken it', async () => {
  const p = provider({ submitError: new SfCliCancelledError() });
  await deploy(p);
  const run = last(p).runs[0];
  assert.strictEqual(run.status, 'cancelUnconfirmed');
  assert.deepStrictEqual(run.notes, ['The org-side deploy may still complete — check the org.']);
});

check('a cancel the org could not confirm: "cancelUnconfirmed" with the reason', async () => {
  const p = provider({ poll: async () => ({ kind: 'cancelled', note: 'Asked the org to cancel the deploy — it\'s still finishing cancellation; check the org\'s Deployment Status (Setup).' }) });
  await deploy(p);
  const run = last(p).runs[0];
  assert.strictEqual(run.status, 'cancelUnconfirmed');
  assert.ok(run.notes[0].includes('still finishing cancellation'));
});

check('the package.xml for a large deploy could not be written: an "error" run, still confirmed, nothing left running', async () => {
  const many = Array.from({ length: 31 }, (_, i) => cls(`AcmeBulk${i}`));
  const p = provider({ fields: { items: many, writeTempManifest: async () => { throw new Error('ENOSPC: no space left on device'); } } });
  const outcome = await deploy(p, many.map(i => `${i.type}:${i.name}`));
  assert.strictEqual(outcome.confirmed, true);
  const run = last(p).runs[0];
  assert.strictEqual(run.status, 'error');
  assert.ok(run.message.includes('ENOSPC'));
  assert.ok(!p.kept.statusRuns.runs.some(r => r.status === 'running'));
});

check('whatever happens, a confirmed deploy never leaves its run running', async () => {
  const outcomes = [
    provider(), provider({ report: { id: JOB, status: 'Failed', success: false, done: true } }),
    provider({ poll: async () => ({ kind: 'lost' }) }), provider({ submitError: new Error('boom') })
  ];
  for (const p of outcomes) {
    await deploy(p);
    assert.ok(!p.kept.statusRuns.runs.some(r => r.status === 'running'), JSON.stringify(p.kept.statusRuns.runs.map(r => r.status)));
  }
});

// ================================================================ Quick Deploy
check('a validation that ran tests offers Quick Deploy live, until the window reload; using it marks the offer used', async () => {
  const p = provider({ report: { id: JOB, status: 'Succeeded', success: true, done: true, runTestsEnabled: true, numberTestsTotal: 4, numberTestsCompleted: 4 } });
  await deploy(p, KEYS, { validateOnly: true, testLevel: 'RunLocalTests' });
  const run = last(p).runs[0];
  assert.strictEqual(run.quick.jobId, JOB);
  assert.ok(!('quick' in p.kept.statusRuns.runs[0]), 'the offer is never stored: it does not survive a reload');
  await proto.runQuickDeploy.call(p.s, JOB);
  const after = runsPosts(p).find((m, i, all) => i > all.indexOf(runsPosts(p).find(x => x.runs[0].quick && !x.runs[0].quick.used)) && m.runs[0].quick && m.runs[0].quick.used);
  assert.ok(after, 'the run is re-posted with the offer used');
  const acts = RV.actionsFor(after.runs[0], { isLatest: true, complete: true, quick: undefined, quickUsed: true });
  assert.ok(!acts.buttons.some(b => b.id === 'quickDeploy') && !acts.why, 'no button, and no "why not" either');
});

check('a validation without tests offers no Quick Deploy — the run says why', async () => {
  const p = provider();
  await deploy(p, KEYS, { validateOnly: true, testLevel: 'NoTestRun' });
  const run = last(p).runs[0];
  assert.strictEqual(run.quick, undefined);
  assert.strictEqual(run.testsRan, false);
  assert.ok(RV.actionsFor(run, { isLatest: true, complete: true }).why.includes('no Apex tests ran'));
});

// ============================================================ after a reload
const SKIPS = Array.from({ length: 60 }, (_, i) => `ApexClass:AcmeOrgOnly${String(i).padStart(2, '0')}`);
const MEMBERS = new Map(SKIPS.map(k => [k, {}]));
/** What a window reload finds when it happens mid-run: the state as the poll
 *  loop starts (the run running, its job persisted). */
async function stateMidRun(opts = {}) {
  let state;
  const p = provider({ fields: { orgMembers: MEMBERS }, poll: async function () { state = JSON.parse(JSON.stringify(p.kept)); return { kind: 'lost' }; } });
  await deploy(p, [...KEYS, ...SKIPS], opts);
  return { state, id: runsPosts(p)[0].runs[0].id };
}
const FAILED_VALIDATION = { id: JOB, status: 'Failed', success: false, done: true, numberComponentErrors: 1, runTestsEnabled: true, details: {
  componentSuccesses: [{ componentType: 'ApexClass', fullName: 'AcmeOrderService' }],
  componentFailures: [{ componentType: 'ApexClass', fullName: 'AcmeInvoiceService', problem: 'Variable does not exist: acmeTotal', lineNumber: 7 }]
} };

check('reload mid-validation: the job\'s run stays running, and the reattach finishes the SAME run — skipped rows and count kept, Retry at its test level', async () => {
  const { state, id } = await stateMidRun({ validateOnly: true, testLevel: 'RunLocalTests' });
  assert.strictEqual(state.activeDeployJob.runId, id, 'the job knows its run');
  assert.strictEqual(state.activeDeployJob.testLevel, 'RunLocalTests');
  const p = provider({ state, fields: { orgMembers: MEMBERS }, report: FAILED_VALIDATION });
  assert.strictEqual(p.s.runStore.runs()[0].status, 'running', 'the run whose job is persisted is not "interrupted" by the reload');
  await proto.reattachDeployJob.call(p.s, proto.readActiveJob.call(p.s));
  const { runs, latestRows } = last(p);
  assert.deepStrictEqual(runs.map(r => r.id), [id], 'one run for one job — never a second one');
  const run = runs[0];
  assert.strictEqual(run.status, 'failed');
  assert.strictEqual(run.op, 'validate');
  assert.strictEqual(run.counts.skipped, 60, 'the exact count from before the reload');
  assert.strictEqual(latestRows.rows.filter(r => r.o === 'skipped').length, 50, 'the skipped rows its summary kept');
  assert.ok(run.notes.includes('Re-attached after a window reload: rows are what acme-dev reported; 60 skipped rows are from when it started.'), JSON.stringify(run.notes));
  const retry = RV.actionsFor(run, { isLatest: true, complete: true, sent: RR.sentKeys({ rows: latestRows.rows }) }).buttons.find(b => b.id === 'retry');
  assert.deepStrictEqual(retry.message.request, { validateOnly: true, testLevel: 'RunLocalTests', keys: ['ApexClass:AcmeOrderService', 'ApexClass:AcmeInvoiceService'] });
  const notes = RV.buildRows(run, latestRows.rows, latestRows.tests, { filter: 'all', folds: {} }, { complete: true }).rows.filter(r => r.k === 'note').map(r => r.text);
  assert.deepStrictEqual(notes, ['10 more skipped rows not listed — only 50 were kept across the window reload.']);
  assert.ok(!('activeDeployJob' in p.kept) || p.kept.activeDeployJob === undefined, 'the finished job is cleared');
});

check('reload with no job left for a running run: it is "interrupted" (and stays so), with the org to check', async () => {
  const { state, id } = await stateMidRun();
  delete state.activeDeployJob;
  const p = provider({ state });
  const run = p.s.runStore.runs()[0];
  assert.strictEqual(run.id, id);
  assert.strictEqual(run.status, 'interrupted');
  assert.ok(run.notes.some(n => n.includes('Check Deployment Status in the org')));
  assert.strictEqual(p.kept.statusRuns.runs[0].status, 'interrupted', 'the correction is persisted');
});

check('a job too old to pick up again: cleared without a report call, and its run is "interrupted"', async () => {
  const { state } = await stateMidRun();
  state.activeDeployJob.startedAt = Date.now() - 2 * 24 * 60 * 60 * 1000;
  let reports = 0;
  const p = provider({ state });
  p.s.sf.deployReport = () => { reports++; return { promise: new Promise(() => {}), cancel() {} }; };
  assert.strictEqual(p.s.runStore.runs()[0].status, 'running');
  proto.maybeReattachDeploy.call(p.s);
  assert.strictEqual(p.kept.activeDeployJob, undefined);
  assert.strictEqual(p.s.runStore.runs()[0].status, 'interrupted');
  assert.strictEqual(last(p).runs[0].status, 'interrupted', 'and the pane is told');
  assert.strictEqual(reports, 0);
});

check('lost contact, then Resume monitoring: the SAME run goes back to running and finishes, every skipped row kept', async () => {
  const p = provider({ fields: { orgMembers: MEMBERS }, poll: async () => ({ kind: 'lost' }), report: { id: JOB, status: 'Succeeded', success: true, done: true, details: {
    componentSuccesses: KEYS.map(k => ({ componentType: 'ApexClass', fullName: k.split(':')[1] }))
  } } });
  await deploy(p, [...KEYS, ...SKIPS]);
  const lost = last(p).runs[0];
  assert.strictEqual(lost.status, 'lost');
  delete p.s.pollDeployJob; // the real poll loop from here on
  const posts = runsPosts(p).length;
  await proto.reattachDeployJob.call(p.s, proto.readActiveJob.call(p.s));
  const after = runsPosts(p).slice(posts);
  assert.strictEqual(after[0].runs[0].status, 'running', 'back to running first');
  const { runs, latestRows } = last(p);
  assert.deepStrictEqual(runs.map(r => [r.id, r.status]), [[lost.id, 'succeeded']]);
  assert.strictEqual(runs[0].counts.skipped, 60);
  assert.strictEqual(latestRows.rows.filter(r => r.o === 'skipped').length, 60, 'this window still holds all of them');
  assert.ok(runs[0].notes.includes('Picked up again after contact was lost: rows are what acme-dev reported; 60 skipped rows are from when it started.'), JSON.stringify(runs[0].notes));
});

check('a run id in the persisted job that is not one of ours is dropped; the job still reattaches, as a run of its own', async () => {
  const p = provider({ state: { activeDeployJob: { jobId: JOB, org: ORG, orgLabel: 'acme-dev', startedAt: Date.now(), verb: 'Deploy', noun: '2 components', runId: '../../x', testLevel: 'RunEverything!' } } });
  const job = proto.readActiveJob.call(p.s);
  assert.ok(job && !('runId' in job) && !('testLevel' in job), JSON.stringify(job));
  await proto.reattachDeployJob.call(p.s, job);
  assert.strictEqual(last(p).runs[0].target, 'report');
  assert.ok(RR.RUN_ID_RE.test(last(p).runs[0].id));
});

// ============================================================ runs nothing began
check('a reattached job becomes its own run from the org\'s report: no skipped count, and it says so', async () => {
  const p = provider({ report: { id: JOB, status: 'Succeeded', success: true, done: true, numberComponentsDeployed: 2, files: [
    { type: 'ApexClass', fullName: 'AcmeOrderService', state: 'Changed' }, { type: 'ApexClass', fullName: 'AcmeLedgerSync', state: 'Unchanged' }
  ] } });
  await proto.reattachDeployJob.call(p.s, { jobId: JOB, org: ORG, orgLabel: 'acme-dev', startedAt: Date.now() - 60_000, verb: 'Deploy', noun: '2 components' });
  const { runs: [run], latestRows } = last(p);
  assert.strictEqual(run.target, 'report');
  assert.strictEqual(run.status, 'succeeded');
  assert.ok(!('skipped' in run.counts), 'the Skipped chip is absent, not zero');
  assert.deepStrictEqual(latestRows.rows.map(r => r.k), ['ApexClass:AcmeOrderService', 'ApexClass:AcmeLedgerSync']);
  assert.ok(run.notes.some(n => n.startsWith('Re-attached after a window reload')));
});

check('a package.xml deploy is a run of its own: rows from the org, and its Retry sends the manifest, never keys', async () => {
  const p = provider({ report: { id: JOB, status: 'Failed', success: false, done: true, numberComponentErrors: 1, files: [
    { type: 'ApexClass', fullName: 'AcmeOrderService', state: 'Failed', error: 'bad' }, { type: 'ApexClass', fullName: 'AcmeLedgerSync', state: 'Changed' }
  ] } });
  await proto.runManifestDeploy.call(p.s, '/ws/manifest/package.xml', [{ type: 'ApexClass', members: ['*'] }]);
  const begun = runsPosts(p)[0].runs[0];
  assert.strictEqual(begun.status, 'running');
  assert.strictEqual(begun.target, 'manifest');
  const { runs: [run], latestRows } = last(p);
  assert.strictEqual(run.id, begun.id);
  assert.deepStrictEqual(latestRows.rows.map(r => [r.k, r.o]), [['ApexClass:AcmeOrderService', 'failed'], ['ApexClass:AcmeLedgerSync', 'rolledback']]);
  const retry = RV.actionsFor(run, { isLatest: true, complete: true, sent: RR.sentKeys({ rows: latestRows.rows }) }).buttons.find(b => b.id === 'retry');
  assert.deepStrictEqual(retry.message.request, { validateOnly: false, testLevel: run.retry.testLevel, manifest: '/ws/manifest/package.xml' });
});

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
check('this harness is registered in package.json "check"', () => {
  assert.ok(pkg.scripts.check.includes('node ./scripts/check-run-producers.cjs'));
});

process.exitCode = 1;
(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
  }
  if (failed) { console.error(`run-producers: ${failed}/${queue.length} checks FAILED`); process.exit(1); }
  console.log(`run-producers: all ${queue.length} checks passed`);
  process.exit(0);
})();
