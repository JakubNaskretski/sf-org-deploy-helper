// Runnable contract test for the DH half of the sf-test-runner ⇄
// sf-org-deploy-wrapper handoff. No framework.
//   1) npm run compile   2) node scripts/check-test-handoff.cjs
//
// Two directions cross the extension boundary here, and both are untrusted
// input in the same way a webview message is:
//   1) `sfOrgDeployWrapper.deployComponents` — sf-test-runner's "Deploy first"
//      calls this with { classNames, targetOrg }. parseHandoffShape (src/
//      handoff.ts) validates the shape before any of it reaches a component
//      lookup or runDeploy; an unknown org gets ONE reload-and-retry of the
//      org list before erroring; a busy slot or an unknown name refuses the
//      WHOLE call, never a partial deploy; the panel is revealed and the
//      deploy itself goes through runDeploy exactly like the panel's own
//      Deploy button — never `preConfirmed`, so the confirm modal and the
//      PROD guard always run — pinned to the CALLER's org via `orgOverride`,
//      and naming the requester in the modal (`requestedBy`).
//   2) `sfTestRunner.runTestsFor` — this plugin's own "Run tests" (toolbar or
//      the newest deploy's Status card) calls INTO sf-test-runner and reads
//      its reply back; parseRunTestsForResult validates that reply the same
//      way, and a malformed one or a thrown executeCommand both degrade to
//      the same "could not read the result" card rather than a throw. Only
//      the card path can truthfully claim `deployed: true` (it just sent
//      exactly these classes there); both paths cap the class list at
//      sf-test-runner's own 200.
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const Module = require('module');

// ---------------------------------------------------------------- vscode stub
const warns = [];
const infos = [];
const statusBar = [];
const TEST_RUNNER_ID = 'Skrety.sf-test-runner';
// sf-test-runner's OWN manifest shape (packageJSON), the way testRunnerAvailable
// reads it — not just "installed or not": a current copy declares runTestsFor;
// an older one (version skew) is installed but doesn't, and must read as
// unavailable the same as not installed at all.
const TR_CURRENT = { contributes: { commands: [{ command: 'sfTestRunner.runSelected' }, { command: 'sfTestRunner.runTestsFor' }] } };
const TR_OLD = { contributes: { commands: [{ command: 'sfTestRunner.runSelected' }] } };
let testRunnerInstalled; // undefined = not installed; else TR_CURRENT/TR_OLD/a test's own shape
let execImpl = async () => undefined; // commands.executeCommand, per check
const execCalls = [];
const vscodeStub = {
  window: {
    // Modal calls (the confirm dialog) auto-accept with the confirm button —
    // same shape check-run-producers.cjs's own stub uses, so the REAL
    // deployConfirmModal/awaitConfirm/PROD-guard machinery can run end to
    // end; a plain (non-modal) call — e.g. requireOrg()'s warning — still
    // just records the text and resolves undefined, exactly as before.
    showWarningMessage: (message, options, ...items) => {
      warns.push({ message, modal: !!(options && options.modal) });
      return Promise.resolve(options && options.modal ? items[0] : undefined);
    },
    showInformationMessage: (m) => { infos.push(m); return Promise.resolve(undefined); },
    showErrorMessage: () => Promise.resolve(undefined),
    setStatusBarMessage: (m) => { statusBar.push(m); return { dispose() {} }; },
    withProgress: (_o, body) => body({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) })
  },
  workspace: { getConfiguration: () => ({ get: (_k, d) => d, update: async () => {} }) },
  commands: {
    executeCommand: (...args) => { execCalls.push(args); return execImpl(...args); }
  },
  Uri: { file: (fsPath) => ({ fsPath, scheme: 'file' }) },
  ProgressLocation: { Notification: 15, Window: 10 },
  ConfigurationTarget: { Global: 1 },
  env: { clipboard: { writeText: async () => {} } },
  extensions: { getExtension: (id) => (id === TEST_RUNNER_ID && testRunnerInstalled ? { packageJSON: testRunnerInstalled } : undefined) }
};
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? vscodeStub : origLoad(req, ...rest));

const OUT = path.join(__dirname, '..', 'out');
const H = require(path.join(OUT, 'handoff.js'));
const P = require(path.join(OUT, 'panelProvider.js'));
const proto = P.DeployPanelProvider.prototype;
const { panel } = require('./lib/dom-shim.cjs');

let failed = 0;
const queue = [];
function check(name, fn) { queue.push([name, fn]); }
function resetToasts() { warns.length = 0; infos.length = 0; statusBar.length = 0; execCalls.length = 0; }

const ORG = 'acme-dev-user';
const ORG2 = 'acme-uat-user';
const cls = (name) => ({ type: 'ApexClass', name, filePath: `/ws/force-app/classes/${name}.cls`, files: [] });
const trg = (name) => ({ type: 'ApexTrigger', name, filePath: `/ws/force-app/triggers/${name}.trigger`, files: [] });
const orgOnlyCls = (name) => ({ type: 'ApexClass', name, filePath: '', files: [] });
const ITEMS = [cls('AcmeOrderService'), cls('AcmeInvoiceService'), trg('AcmeCaseTrigger'), orgOnlyCls('AcmeRemoteOnly')];
const ORGS = [{ username: ORG, alias: 'acme-dev' }, { username: ORG2, alias: 'acme-uat' }];
const manyApexItems = (n) => Array.from({ length: n }, (_, i) => cls(`AcmeBulk${i}`));

// ======================================================= 1) parseHandoffShape / parseHandoffArgs
check('parseHandoffArgs: a valid call', () => {
  const r = H.parseHandoffArgs({ classNames: ['AcmeOrderService', 'AcmeCaseTrigger'], targetOrg: ORG }, [ORG, ORG2]);
  assert.deepStrictEqual(r, { ok: true, value: { classNames: ['AcmeOrderService', 'AcmeCaseTrigger'], targetOrg: ORG } });
});
check('parseHandoffShape: not an object, or null', () => {
  for (const raw of [undefined, null, 'x', 42, ['AcmeOrderService']]) {
    assert.strictEqual(H.parseHandoffShape(raw).ok, false, JSON.stringify(raw));
  }
});
check('parseHandoffShape: classNames must be a non-empty array of plain identifiers, capped at 200', () => {
  assert.strictEqual(H.parseHandoffShape({ classNames: [], targetOrg: ORG }).ok, false, 'empty');
  assert.strictEqual(H.parseHandoffShape({ classNames: 'AcmeOrderService', targetOrg: ORG }).ok, false, 'not an array');
  assert.strictEqual(H.parseHandoffShape({ classNames: ['Acme Order'], targetOrg: ORG }).ok, false, 'a space');
  assert.strictEqual(H.parseHandoffShape({ classNames: ['Acme-Order'], targetOrg: ORG }).ok, false, 'a dash');
  assert.strictEqual(H.parseHandoffShape({ classNames: ['AcmeOrderService', 7], targetOrg: ORG }).ok, false, 'a non-string entry');
  assert.strictEqual(H.parseHandoffShape({ classNames: Array.from({ length: 201 }, (_, i) => `A${i}`), targetOrg: ORG }).ok, false, '201 names');
  assert.strictEqual(H.parseHandoffShape({ classNames: Array.from({ length: 200 }, (_, i) => `A${i}`), targetOrg: ORG }).ok, true, '200 names is fine');
});
check('parseHandoffShape: targetOrg must be a non-empty string that does not look like a CLI flag', () => {
  assert.strictEqual(H.parseHandoffShape({ classNames: ['A'], targetOrg: '' }).ok, false);
  assert.strictEqual(H.parseHandoffShape({ classNames: ['A'], targetOrg: '   ' }).ok, false);
  assert.strictEqual(H.parseHandoffShape({ classNames: ['A'], targetOrg: '--target-org' }).ok, false);
  assert.strictEqual(H.parseHandoffShape({ classNames: ['A'], targetOrg: 7 }).ok, false);
});
check('parseHandoffArgs: targetOrg must be a KNOWN org — the known-org list is an input, not a guess (parseHandoffShape never checks it)', () => {
  const r = H.parseHandoffArgs({ classNames: ['A'], targetOrg: 'nobody@example.com' }, [ORG, ORG2]);
  assert.strictEqual(r.ok, false);
  assert.ok(/not a known org/.test(r.message), r.message);
  assert.strictEqual(H.parseHandoffShape({ classNames: ['A'], targetOrg: 'nobody@example.com' }).ok, true, 'shape alone says nothing about membership');
  assert.strictEqual(H.parseHandoffArgs({ classNames: ['A'], targetOrg: ORG2 }, [ORG, ORG2]).ok, true);
});

// ========================================================= 2) deployComponents
function dcProvider(extra = {}) {
  const runDeployCalls = [];
  const s = Object.create(proto);
  Object.assign(s, {
    busy: false, confirmOpen: false,
    items: 'items' in extra ? extra.items : ITEMS,
    orgs: 'orgs' in extra ? extra.orgs : ORGS,
    loadFiles: async () => { s.items = ITEMS; },
    loadOrgs: async () => { s.orgs = ORGS; },
    runDeploy: async (keys, opts) => { runDeployCalls.push({ keys, opts }); return extra.outcome ?? { status: 'ok' }; },
    output: { appendLine: () => {} }
  });
  return { s, runDeployCalls };
}

check('deployComponents: a parse error never reaches runDeploy', async () => {
  const { s, runDeployCalls } = dcProvider();
  const r = await s.deployComponents({ classNames: [], targetOrg: ORG });
  assert.strictEqual(r.status, 'error');
  assert.ok(r.message);
  assert.strictEqual(runDeployCalls.length, 0);
});

// ---- mutation target: the shape is validated BEFORE either load — a garbage
// call must cost no `sf`/file-scan spawn at all.
check('deployComponents: shape is validated BEFORE loadFiles/loadOrgs — a garbage call never spawns either, even with empty items/orgs to "justify" a load', async () => {
  const { s } = dcProvider({ items: [], orgs: [] });
  let loadFilesCalled = 0;
  let loadOrgsCalled = 0;
  s.loadFiles = async () => { loadFilesCalled++; s.items = ITEMS; };
  s.loadOrgs = async () => { loadOrgsCalled++; s.orgs = ORGS; };
  const r = await s.deployComponents({ classNames: [], targetOrg: ORG }); // bad shape
  assert.strictEqual(r.status, 'error');
  assert.strictEqual(loadFilesCalled, 0, 'a bad shape must never trigger loadFiles');
  assert.strictEqual(loadOrgsCalled, 0, 'a bad shape must never trigger loadOrgs');
});

check('deployComponents: an unknown org is an error, never a runDeploy call', async () => {
  const { s, runDeployCalls } = dcProvider();
  const r = await s.deployComponents({ classNames: ['AcmeOrderService'], targetOrg: 'nobody@example.com' });
  assert.strictEqual(r.status, 'error');
  assert.strictEqual(runDeployCalls.length, 0);
});

// ---- item 7: reload-and-retry on an unknown org
check('deployComponents: an unknown org reloads the org list ONCE and re-checks — a merely-stale list is not the final word', async () => {
  const ORG3 = 'acme-new-user';
  const { s, runDeployCalls } = dcProvider();
  let loadOrgsCalled = 0;
  s.loadOrgs = async () => { loadOrgsCalled++; s.orgs = [...ORGS, { username: ORG3, alias: 'acme-new' }]; };
  const r = await s.deployComponents({ classNames: ['AcmeOrderService'], targetOrg: ORG3 });
  assert.strictEqual(loadOrgsCalled, 1);
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(runDeployCalls[0].opts.orgOverride, ORG3);
});
check('deployComponents: still unknown after the one reload is an honest error — no second reload for the same request', async () => {
  const { s } = dcProvider();
  let loadOrgsCalled = 0;
  s.loadOrgs = async () => { loadOrgsCalled++; };
  const r = await s.deployComponents({ classNames: ['AcmeOrderService'], targetOrg: 'nobody@example.com' });
  assert.strictEqual(r.status, 'error');
  assert.strictEqual(loadOrgsCalled, 1);
});

check('deployComponents: loads files/orgs lazily, only when empty', async () => {
  let loadFilesCalled = 0;
  let loadOrgsCalled = 0;
  const { s } = dcProvider({ items: [], orgs: [] });
  s.loadFiles = async () => { loadFilesCalled++; s.items = ITEMS; };
  s.loadOrgs = async () => { loadOrgsCalled++; s.orgs = ORGS; };
  const r = await s.deployComponents({ classNames: ['AcmeOrderService'], targetOrg: ORG });
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(loadFilesCalled, 1);
  assert.strictEqual(loadOrgsCalled, 1);
  // A second call with items/orgs already populated must not reload.
  const r2 = await s.deployComponents({ classNames: ['AcmeOrderService'], targetOrg: ORG });
  assert.strictEqual(r2.status, 'ok');
  assert.strictEqual(loadFilesCalled, 1);
  assert.strictEqual(loadOrgsCalled, 1);
});

// ---- mutation target: the busy check
check('deployComponents: busy (or an open confirm modal) is an honest `busy`, and never reaches runDeploy — runDeploy would otherwise enqueue it behind a second modal', async () => {
  const { s: busySlot, runDeployCalls: c1 } = dcProvider();
  busySlot.busy = true;
  const r1 = await busySlot.deployComponents({ classNames: ['AcmeOrderService'], targetOrg: ORG });
  assert.strictEqual(r1.status, 'busy');
  assert.strictEqual(c1.length, 0);

  const { s: confirming, runDeployCalls: c2 } = dcProvider();
  confirming.confirmOpen = true;
  const r2 = await confirming.deployComponents({ classNames: ['AcmeOrderService'], targetOrg: ORG });
  assert.strictEqual(r2.status, 'busy');
  assert.strictEqual(c2.length, 0);

  // Not busy at all: the call goes through.
  const { s: free, runDeployCalls: c3 } = dcProvider();
  const r3 = await free.deployComponents({ classNames: ['AcmeOrderService'], targetOrg: ORG });
  assert.strictEqual(r3.status, 'ok');
  assert.strictEqual(c3.length, 1);
});

// ---- mutation target: the busy/confirmOpen slot is RE-CHECKED after the
// panel-focus await, right before runDeploy — that await is the one window
// where something else can take the slot before this call ever reaches it.
check('deployComponents: free when the call starts, but busy by the time the panel-focus await resolves — refused as `busy`, never reaches runDeploy', async () => {
  resetToasts();
  const { s, runDeployCalls } = dcProvider();
  execImpl = async (cmd) => {
    if (cmd === `${P.DeployPanelProvider.viewType}.focus`) s.busy = true; // raced during the await
    return undefined;
  };
  const r = await s.deployComponents({ classNames: ['AcmeOrderService'], targetOrg: ORG });
  assert.strictEqual(r.status, 'busy');
  assert.strictEqual(runDeployCalls.length, 0);
  execImpl = async () => undefined; // restore the default for later checks
});

// ---- mutation target: name → key mapping
check('deployComponents: maps each name to its ApexClass/ApexTrigger item, case-insensitively', async () => {
  const { s, runDeployCalls } = dcProvider();
  await s.deployComponents({ classNames: ['acmeorderservice', 'ACMECASETRIGGER'], targetOrg: ORG });
  assert.deepStrictEqual(runDeployCalls[0].keys.slice().sort(), ['ApexClass:AcmeOrderService', 'ApexTrigger:AcmeCaseTrigger']);
});
check('deployComponents: a name with no ApexClass/ApexTrigger item is an error naming it, and NOTHING deploys — never a partial set', async () => {
  const { s, runDeployCalls } = dcProvider();
  const r = await s.deployComponents({ classNames: ['AcmeOrderService', 'AcmeGhostService'], targetOrg: ORG });
  assert.strictEqual(r.status, 'error');
  assert.ok(/AcmeGhostService/.test(r.message), r.message);
  assert.strictEqual(runDeployCalls.length, 0, 'AcmeOrderService must not have deployed alone');
});
check('deployComponents: an org-only Apex item (no local source) still maps as a key — runDeploy\'s own "no local source" guard (ABORTED) handles that, not a duplicate check here', async () => {
  const { s, runDeployCalls } = dcProvider();
  const r = await s.deployComponents({ classNames: ['AcmeRemoteOnly'], targetOrg: ORG });
  assert.strictEqual(r.status, 'ok');
  assert.deepStrictEqual(runDeployCalls[0].keys, ['ApexClass:AcmeRemoteOnly']);
});
check('deployComponents: a CustomObject sharing a name is never picked — only ApexClass/ApexTrigger', async () => {
  const { s, runDeployCalls } = dcProvider({ items: [...ITEMS, { type: 'CustomObject', name: 'AcmeWidget__c', filePath: '/ws/x', files: [] }] });
  const r = await s.deployComponents({ classNames: ['AcmeWidget__c'], targetOrg: ORG });
  assert.strictEqual(r.status, 'error');
  assert.strictEqual(runDeployCalls.length, 0);
});

// ---- mutation target: never preConfirmed, pinned to the CALLER's org, and names the requester
check('deployComponents: runDeploy is called with orgOverride = targetOrg and requestedBy — and NOTHING else — never preConfirmed', async () => {
  const { s, runDeployCalls } = dcProvider();
  await s.deployComponents({ classNames: ['AcmeOrderService'], targetOrg: ORG2 });
  assert.strictEqual(runDeployCalls.length, 1);
  assert.deepStrictEqual(runDeployCalls[0].opts, {
    orgOverride: ORG2,
    requestedBy: { source: 'SF Test Runner (Deploy first)', names: ['AcmeOrderService'] }
  });
  assert.ok(!('preConfirmed' in runDeployCalls[0].opts), 'the confirm modal and PROD guard must always run for this caller');
});

// ---- item 2: reveal the panel before calling runDeploy
check('deployComponents: reveals the panel (<viewId>.focus) before calling runDeploy, so the user watches it land in the Status pane', async () => {
  resetToasts();
  const order = [];
  execImpl = async (cmd) => { if (cmd === `${P.DeployPanelProvider.viewType}.focus`) order.push('focus'); return undefined; };
  const { s, runDeployCalls } = dcProvider();
  s.runDeploy = async (keys, opts) => { order.push('runDeploy'); runDeployCalls.push({ keys, opts }); return { status: 'ok' }; };
  await s.deployComponents({ classNames: ['AcmeOrderService'], targetOrg: ORG });
  assert.deepStrictEqual(order, ['focus', 'runDeploy']);
});
check('deployComponents: a failed reveal (focus command missing/throws) still lets the deploy run', async () => {
  resetToasts();
  execImpl = async () => { throw new Error('no such command'); };
  const { s, runDeployCalls } = dcProvider();
  const r = await s.deployComponents({ classNames: ['AcmeOrderService'], targetOrg: ORG });
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(runDeployCalls.length, 1);
});

// ---- item 3: outcome mapping — a message only for `failed`
check('deployComponents: outcome mapping — ok passes through bare; a plain (unconfirmed) aborted passes through bare too; failed adds a message naming the Status pane', async () => {
  const { s: ok } = dcProvider({ outcome: { status: 'ok' } });
  assert.deepStrictEqual(await ok.deployComponents({ classNames: ['AcmeOrderService'], targetOrg: ORG }), { status: 'ok' });

  // aborted WITHOUT confirmed: the modal was simply declined/dismissed —
  // nothing was asked of the org, so this stays `aborted` (TR reads it as
  // "the user said no" and stays silent, correctly).
  const { s: declined } = dcProvider({ outcome: { status: 'aborted' } });
  assert.deepStrictEqual(await declined.deployComponents({ classNames: ['AcmeOrderService'], targetOrg: ORG }), { status: 'aborted' });

  const { s: failing } = dcProvider({ outcome: { status: 'failed' } });
  const r = await failing.deployComponents({ classNames: ['AcmeOrderService'], targetOrg: ORG });
  assert.deepStrictEqual(r, { status: 'failed', message: "Deploy to acme-dev failed — see SF Deploy's Status pane." });
});

// ---- mutation target: aborted + confirmed (lost contact / submit error / org
// cancel AFTER the user said yes) must read as `failed`, not a silent `aborted`
check('deployComponents: aborted + confirmed (the user said yes, but nothing landed) reports `failed` with a Status-pane message — TR reads a plain `aborted` as "user declined" and would otherwise stay silent about a real failure', async () => {
  const { s } = dcProvider({ outcome: { status: 'aborted', confirmed: true } });
  const r = await s.deployComponents({ classNames: ['AcmeOrderService'], targetOrg: ORG });
  assert.deepStrictEqual(r, { status: 'failed', message: "Deploy to acme-dev failed — see SF Deploy's Status pane." });
});

// ---- mutation target: the "Requested by" modal line appears only for a handoff deploy
check('handoffRequestNotice / deployConfirmModal: "Requested by …" names the source and classes, ONLY when requestedBy is set — plain deploys never carry it', () => {
  const base = { noun: '2 components', orgLabel: 'acme-dev', isProd: false, validateOnly: false, testNote: '', ignoreConflicts: false };
  const plain = proto.deployConfirmModal.call({}, base, false);
  assert.ok(!/Requested by/.test(plain.options.detail || ''), 'an ordinary deploy must not carry it');

  const handoff = proto.deployConfirmModal.call({}, { ...base, requestedBy: { source: 'SF Test Runner (Deploy first)', names: ['AcmeTest', 'AcmeServiceTest'] } }, false);
  assert.strictEqual(handoff.options.detail, 'Requested by SF Test Runner (Deploy first): AcmeTest, AcmeServiceTest');

  // Also on the PROD-warning shape.
  const prodHandoff = proto.deployConfirmModal.call({}, { ...base, isProd: true, requestedBy: { source: 'SF Test Runner (Deploy first)', names: ['AcmeTest'] } }, false);
  assert.ok(prodHandoff.options.detail.includes('Requested by SF Test Runner (Deploy first): AcmeTest'), prodHandoff.options.detail);

  // Capped past the inline-name limit so a 200-name handoff stays readable.
  const many = Array.from({ length: 25 }, (_, i) => `A${i}`);
  const capped = proto.deployConfirmModal.call({}, { ...base, requestedBy: { source: 'SF Test Runner (Deploy first)', names: many } }, false);
  assert.ok(capped.options.detail.includes('+5 more'), capped.options.detail);

  // An empty names list is the same as no requestedBy at all.
  const empty = proto.deployConfirmModal.call({}, { ...base, requestedBy: { source: 'SF Test Runner (Deploy first)', names: [] } }, false);
  assert.ok(!/Requested by/.test(empty.options.detail || ''));
});

// ================================================ 3) parseRunTestsForResult / testsCard
check('parseRunTestsForResult: accepts every valid shape, trusts nothing else', () => {
  const valid = { status: 'passed', orgAlias: 'acme-dev', testClasses: ['AcmeOrderServiceTest'], passed: 4, failed: 0 };
  assert.deepStrictEqual(P.parseRunTestsForResult(valid), { ...valid, message: undefined });
  for (const raw of [
    undefined, null, 'x', 42,
    { status: 'nope', testClasses: [], passed: 0, failed: 0 },
    { status: 'passed', testClasses: 'AcmeOrderServiceTest', passed: 0, failed: 0 },
    { status: 'passed', testClasses: [], passed: -1, failed: 0 },
    { status: 'passed', testClasses: [], passed: 'NaN', failed: 0 },
    { status: 'passed', testClasses: [], passed: 0, failed: 0, message: 7 },
    { status: 'passed', testClasses: [], passed: 0, failed: 0, orgAlias: 7 }
  ]) {
    assert.strictEqual(P.parseRunTestsForResult(raw), undefined, JSON.stringify(raw));
  }
});
check('parseRunTestsForResult: caps the echoed class list', () => {
  const big = Array.from({ length: 900 }, (_, i) => `A${i}`);
  const out = P.parseRunTestsForResult({ status: 'passed', testClasses: big, passed: 1, failed: 0 });
  assert.strictEqual(out.testClasses.length, 500);
});

// ---- mutation target: result-shape validation — drop bad class names, cap message/orgAlias
check('parseRunTestsForResult: drops class names that are not plain identifiers or are over 255 chars, keeping the good ones (never rejects the whole reply over one bad entry)', () => {
  const tooLong = 'A'.repeat(256);
  const ok255 = 'A'.repeat(255);
  const out = P.parseRunTestsForResult({
    status: 'passed',
    testClasses: ['AcmeGoodTest', 7, 'bad name', 'bad-name', tooLong, ok255, null, undefined],
    passed: 1,
    failed: 0
  });
  assert.ok(out, 'a reply with some bad names is still a valid reply');
  assert.deepStrictEqual(out.testClasses, ['AcmeGoodTest', ok255]);
});
check('parseRunTestsForResult: caps message/orgAlias at 500 chars rather than rejecting the whole reply', () => {
  const long = 'x'.repeat(600);
  const out = P.parseRunTestsForResult({ status: 'error', testClasses: [], passed: 0, failed: 0, message: long, orgAlias: long });
  assert.strictEqual(out.message.length, 500);
  assert.strictEqual(out.orgAlias.length, 500);
});

check('testsCard: passed/failed name the counts, the org and point at SF Tests → Results; busy/noTests/cancelled/error speak their own message or a fallback', () => {
  assert.deepStrictEqual(P.testsCard({ status: 'passed', testClasses: [], passed: 4, failed: 0 }, 'acme-dev'), { kind: 'ok', title: 'Tests on acme-dev: 4 methods passed, 0 failed', meta: 'Details in SF Tests → Results.' });
  assert.deepStrictEqual(P.testsCard({ status: 'failed', orgAlias: 'acme-prod', testClasses: ['A'], passed: 1, failed: 1 }, 'acme-dev'), { kind: 'err', title: 'Tests on acme-prod: 1 test class, 1 method passed, 1 failed', meta: 'Classes: A · Details in SF Tests → Results.' });
  // One deployed test class with seven methods must not read as "7 tests".
  assert.strictEqual(P.testsCard({ status: 'passed', testClasses: ['AcmeServiceTest'], passed: 7, failed: 0 }, 'acme-dev').title, 'Tests on acme-dev: 1 test class, 7 methods passed, 0 failed');
  assert.strictEqual(P.testsCard({ status: 'passed', testClasses: ['A', 'B'], passed: 9, failed: 0 }, 'acme-dev').title, 'Tests on acme-dev: 2 test classes, 9 methods passed, 0 failed');
  assert.strictEqual(P.testsCard({ status: 'busy', testClasses: [], passed: 0, failed: 0, message: 'A test run is already in progress.' }, 'acme-dev').kind, 'warn');
  assert.strictEqual(P.testsCard({ status: 'busy', testClasses: [], passed: 0, failed: 0, message: 'A test run is already in progress.' }, 'acme-dev').title, 'A test run is already in progress.');
  assert.strictEqual(P.testsCard({ status: 'noTests', testClasses: [], passed: 0, failed: 0 }, 'acme-dev').kind, 'warn', 'no message from TR here — this side still needs a title');
  assert.strictEqual(P.testsCard({ status: 'cancelled', testClasses: [], passed: 0, failed: 0 }, 'acme-dev').kind, 'warn');
  assert.strictEqual(P.testsCard({ status: 'error', testClasses: [], passed: 0, failed: 0, message: 'boom' }, 'acme-dev').title, 'boom');
  assert.strictEqual(P.testsCard(undefined, 'acme-dev').kind, 'warn', 'malformed/thrown — the same fallback either way');
});

// ===================================================== 4) the 'runTests' handler
function rtProvider(extra = {}) {
  const posted = [];
  const s = Object.create(proto);
  Object.assign(s, {
    items: 'items' in extra ? extra.items : ITEMS,
    orgs: ORGS,
    orgStore: { get: () => (extra.org === undefined ? ORG : extra.org) },
    lastDeployedApex: extra.lastDeployedApex,
    output: { appendLine: () => {} },
    post: (m) => posted.push(m)
  });
  return { s, posted };
}

check('runTests (toolbar): resolves only the selected ApexClass/ApexTrigger WITH local source, de-duped, calls sfTestRunner.runTestsFor with them and the live org, and omits `deployed`', async () => {
  resetToasts();
  testRunnerInstalled = undefined;
  let seenRaw;
  execImpl = async (cmd, raw) => { seenRaw = { cmd, raw }; return { status: 'passed', orgAlias: 'acme-dev', testClasses: ['AcmeOrderServiceTest'], passed: 3, failed: 0 }; };
  const { s, posted } = rtProvider();
  await proto.handleMessage.call(s, { type: 'runTests', keys: ['ApexClass:AcmeOrderService', 'ApexTrigger:AcmeCaseTrigger', 'ApexClass:AcmeRemoteOnly', 'CustomObject:Nope'] });
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(seenRaw.cmd, 'sfTestRunner.runTestsFor');
  assert.deepStrictEqual(seenRaw.raw.classNames.slice().sort(), ['AcmeCaseTrigger', 'AcmeOrderService']);
  assert.strictEqual(seenRaw.raw.targetOrg, ORG);
  assert.ok(!('deployed' in seenRaw.raw), JSON.stringify(seenRaw.raw));
  assert.strictEqual(posted.length, 1);
  assert.strictEqual(posted[0].type, 'status');
  assert.strictEqual(posted[0].card.kind, 'ok');
});

check('runTests (toolbar): no org selected — the ordinary requireOrg() warning, no executeCommand call', async () => {
  resetToasts();
  const { s, posted } = rtProvider();
  s.orgStore = { get: () => undefined };
  await proto.handleMessage.call(s, { type: 'runTests', keys: ['ApexClass:AcmeOrderService'] });
  assert.strictEqual(execCalls.length, 0);
  assert.strictEqual(posted.length, 0);
  assert.ok(warns.some((w) => /select a salesforce org/i.test(w.message)), JSON.stringify(warns));
});

check('runTests (toolbar): nothing Apex/local selected is a silent no-op', async () => {
  resetToasts();
  const { s, posted } = rtProvider();
  await proto.handleMessage.call(s, { type: 'runTests', keys: ['ApexClass:AcmeRemoteOnly', 'CustomObject:Nope'] });
  assert.strictEqual(execCalls.length, 0);
  assert.strictEqual(posted.length, 0);
});

// ---- mutation target: deployed:true on the card path, omitted on the toolbar path
check('runTests: the Status-card path sends deployed:true (it just put exactly these classes on that org); the toolbar path omits the field entirely', async () => {
  resetToasts();
  let seenCard;
  execImpl = async (_cmd, raw) => { seenCard = raw; return { status: 'passed', testClasses: [], passed: 1, failed: 0 }; };
  const { s: cardS } = rtProvider({ lastDeployedApex: { runId: 'run-d1', org: ORG, keys: ['ApexClass:AcmeOrderService'] } });
  await proto.handleMessage.call(cardS, { type: 'runTests', runId: 'run-d1' });
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(seenCard.deployed, true);

  resetToasts();
  let seenToolbar;
  execImpl = async (_cmd, raw) => { seenToolbar = raw; return { status: 'passed', testClasses: [], passed: 1, failed: 0 }; };
  const { s: toolbarS } = rtProvider();
  await proto.handleMessage.call(toolbarS, { type: 'runTests', keys: ['ApexClass:AcmeOrderService'] });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(!('deployed' in seenToolbar), JSON.stringify(seenToolbar));
});

check('runTests (Status card): resolves against lastDeployedApex by runId — never the webview\'s own names — and uses the PINNED org, not the live selection', async () => {
  resetToasts();
  let seenRaw;
  execImpl = async (_cmd, raw) => { seenRaw = raw; return { status: 'passed', testClasses: ['T'], passed: 1, failed: 0 }; };
  const { s } = rtProvider({ org: ORG2, lastDeployedApex: { runId: 'run-9', org: ORG, keys: ['ApexClass:AcmeOrderService', 'ApexTrigger:AcmeCaseTrigger'] } });
  await proto.handleMessage.call(s, { type: 'runTests', runId: 'run-9', keys: ['ApexClass:ShouldBeIgnored'] });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepStrictEqual(seenRaw.classNames.slice().sort(), ['AcmeCaseTrigger', 'AcmeOrderService']);
  assert.strictEqual(seenRaw.targetOrg, ORG, 'pinned to the run\'s own org, not the current selection (acme-uat)');
});

check('runTests (Status card): a runId that does not match the live record is a no-op (the run fell out of history, or this is a forged id)', async () => {
  resetToasts();
  const { s, posted } = rtProvider({ lastDeployedApex: { runId: 'run-1', org: ORG, keys: ['ApexClass:AcmeOrderService'] } });
  await proto.handleMessage.call(s, { type: 'runTests', runId: 'run-OTHER' });
  assert.strictEqual(execCalls.length, 0);
  assert.strictEqual(posted.length, 0);
});

// ---- mutation target: the 200-class cap, enforced before ever calling out
check('runTests: over 200 classes refuses with a warn card naming the cap, on BOTH paths, and never calls sfTestRunner.runTestsFor', async () => {
  resetToasts();
  const many = manyApexItems(210);
  const keys = many.map((i) => `ApexClass:${i.name}`);
  const { s: toolbarS, posted: toolbarPosted } = rtProvider({ items: many });
  await proto.handleMessage.call(toolbarS, { type: 'runTests', keys });
  assert.strictEqual(execCalls.length, 0);
  assert.strictEqual(toolbarPosted.length, 1);
  assert.strictEqual(toolbarPosted[0].card.kind, 'warn');
  assert.ok(/210/.test(toolbarPosted[0].card.title) && /200/.test(toolbarPosted[0].card.title), toolbarPosted[0].card.title);

  resetToasts();
  const { s: cardS, posted: cardPosted } = rtProvider({ lastDeployedApex: { runId: 'run-big', org: ORG, keys } });
  await proto.handleMessage.call(cardS, { type: 'runTests', runId: 'run-big' });
  assert.strictEqual(execCalls.length, 0);
  assert.strictEqual(cardPosted.length, 1);
  assert.strictEqual(cardPosted[0].card.kind, 'warn');
});
check('runTests: exactly 200 goes through; 201 is refused (the boundary)', async () => {
  resetToasts();
  execImpl = async () => ({ status: 'passed', testClasses: [], passed: 1, failed: 0 });
  const n200 = manyApexItems(200);
  const { s: s200, posted: p200 } = rtProvider({ items: n200 });
  await proto.handleMessage.call(s200, { type: 'runTests', keys: n200.map((i) => `ApexClass:${i.name}`) });
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(execCalls.length, 1);
  assert.strictEqual(p200[0].card.kind, 'ok');

  resetToasts();
  const n201 = manyApexItems(201);
  const { s: s201, posted: p201 } = rtProvider({ items: n201 });
  await proto.handleMessage.call(s201, { type: 'runTests', keys: n201.map((i) => `ApexClass:${i.name}`) });
  assert.strictEqual(execCalls.length, 0);
  assert.strictEqual(p201[0].card.kind, 'warn');
});

check('runTests: resolves BEFORE the stubbed executeCommand settles — fire-and-forget, so the host\'s own busy/pending lock is never held for the run', async () => {
  resetToasts();
  let resolveExec;
  execImpl = () => new Promise((resolve) => { resolveExec = resolve; });
  const { s } = rtProvider();
  let handledSettled = false;
  const handled = proto.handleMessage.call(s, { type: 'runTests', keys: ['ApexClass:AcmeOrderService'] });
  handled.then(() => { handledSettled = true; });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.strictEqual(handledSettled, true, 'handleMessage must have returned already');
  resolveExec({ status: 'passed', testClasses: [], passed: 1, failed: 0 });
  await new Promise((r) => setTimeout(r, 0));
});

check('runTests: a malformed reply (the call worked, the shape didn\'t) is one warn card that still says "unexpected result" — not the executeCommand-failed wording', async () => {
  resetToasts();
  execImpl = async () => ({ status: 'passed' }); // missing testClasses/passed/failed
  const { s, posted } = rtProvider();
  await proto.handleMessage.call(s, { type: 'runTests', keys: ['ApexClass:AcmeOrderService'] });
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(posted.length, 1);
  assert.strictEqual(posted[0].card.kind, 'warn');
  assert.ok(/unexpected result/.test(posted[0].card.title), posted[0].card.title);
  assert.ok(!/call to SF Test Runner failed/.test(posted[0].card.title), posted[0].card.title);
});

check('runTests: executeCommand throwing (sf-test-runner uninstalled mid-session) is one warn card naming the CALL itself, not a throw out of the handler', async () => {
  resetToasts();
  execImpl = async () => { throw new Error('command not found'); };
  const { s, posted } = rtProvider();
  await proto.handleMessage.call(s, { type: 'runTests', keys: ['ApexClass:AcmeOrderService'] });
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(posted.length, 1);
  assert.strictEqual(posted[0].card.kind, 'warn');
  assert.ok(/call to SF Test Runner failed/.test(posted[0].card.title), posted[0].card.title);
});

// ---- mutation target: version skew — installed alone is not enough
check('testRunnerAvailable: not installed → false; installed but missing runTestsFor (an older SF Test Runner) → false; installed and current → true', () => {
  const stub = {};
  testRunnerInstalled = undefined;
  assert.strictEqual(proto.testRunnerAvailable.call(stub), false, 'not installed at all');
  testRunnerInstalled = TR_OLD;
  assert.strictEqual(proto.testRunnerAvailable.call(stub), false, 'installed, but its manifest has no runTestsFor command — version skew');
  testRunnerInstalled = TR_CURRENT;
  assert.strictEqual(proto.testRunnerAvailable.call(stub), true, 'installed and its manifest declares runTestsFor');
  testRunnerInstalled = undefined;
});

check('testsCard: a thrown executeCommand names the call and hints at a version mismatch; a malformed-but-received reply keeps "unexpected result"', () => {
  const thrown = P.testsCard(undefined, 'acme-dev', true);
  assert.strictEqual(thrown.kind, 'warn');
  assert.ok(/call to SF Test Runner failed/.test(thrown.title) && /up to date/.test(thrown.title), thrown.title);
  const malformed = P.testsCard(undefined, 'acme-dev', false);
  assert.strictEqual(malformed.kind, 'warn');
  assert.ok(/unexpected result/.test(malformed.title), malformed.title);
  assert.ok(!/call to SF Test Runner failed/.test(malformed.title), malformed.title);
});

// =============================================== 5) liveRunPayload / lastDeployedApex
function liveProvider(fields = {}) {
  const s = Object.create(proto);
  Object.assign(s, { liveSuggestions: new Map(), lastValidated: undefined, lastDeployedApex: undefined, ...fields });
  return s;
}
const deployRun = (id = 'run-live-1') => ({ id, op: 'deploy', status: 'succeeded', orgLabel: 'acme-dev' });
const validateRun = (id = 'run-live-1') => ({ id, op: 'validate', status: 'succeeded', orgLabel: 'acme-dev' });

check('liveRunPayload: emits runTests only for the matching succeeded DEPLOY run, with sf-test-runner installed', () => {
  testRunnerInstalled = TR_CURRENT;
  const run = deployRun();
  const s1 = liveProvider({ lastDeployedApex: { runId: run.id, org: ORG, keys: ['ApexClass:AcmeOrderService'] } });
  assert.deepStrictEqual(proto.liveRunPayload.call(s1, run), { runTests: { count: 1 } });

  // A different run id (an older run, or one that didn't deploy Apex): nothing.
  const s2 = liveProvider({ lastDeployedApex: { runId: 'some-other-run', org: ORG, keys: ['ApexClass:AcmeOrderService'] } });
  assert.strictEqual(proto.liveRunPayload.call(s2, run), undefined);

  // sf-test-runner not installed: nothing, even with a matching record.
  testRunnerInstalled = undefined;
  const s3 = liveProvider({ lastDeployedApex: { runId: run.id, org: ORG, keys: ['ApexClass:AcmeOrderService'] } });
  assert.strictEqual(proto.liveRunPayload.call(s3, run), undefined);

  // A validate run, even with a (stray) matching record: never — validate never deploys.
  testRunnerInstalled = TR_CURRENT;
  const s4 = liveProvider({ lastDeployedApex: { runId: run.id, org: ORG, keys: ['ApexClass:AcmeOrderService'] } });
  assert.strictEqual(proto.liveRunPayload.call(s4, validateRun(run.id)), undefined);

  // No Apex keys recorded (an empty array): nothing either.
  const s5 = liveProvider({ lastDeployedApex: { runId: run.id, org: ORG, keys: [] } });
  assert.strictEqual(proto.liveRunPayload.call(s5, run), undefined);
});

// ---- harness gap: drive a REAL successful deploy end to end and check the
// assignment itself (not just the pure liveRunPayload function) — deleting
// the `this.lastDeployedApex = …` line in reportDeployResult must fail this.
const JOB = '0AfAc000001kQ9zSAE';
function fullDeployProvider(extra = {}) {
  const posted = [];
  const kept = {};
  const s = Object.create(proto);
  const sf = {
    deployMetadata: () => ({
      promise: Promise.resolve({ result: { id: JOB }, cmd: 'sf project deploy start --json' }),
      cancel: () => undefined
    }),
    deployReport: () => ({
      promise: Promise.resolve({ result: extra.report ?? { id: JOB, status: 'Succeeded', success: true, done: true } }),
      cancel: () => undefined
    })
  };
  Object.assign(s, {
    busy: false, confirmOpen: false, deployQueue: [], cmdSeq: 0,
    orgMembers: new Map(), orgMembersOrg: undefined,
    items: ITEMS, workspaceRoot: '/ws', liveSuggestions: new Map(), suggestionSeq: 0,
    testLevel: undefined, runTests: undefined,
    orgs: [{ username: ORG, alias: 'acme-dev', instanceUrl: 'https://acme-dev.sandbox.my.salesforce.com', isSandbox: true }],
    orgStore: { get: () => ORG, set: async () => {}, setFromUserPick: async () => {} },
    loadFiles: async () => {}, maybeBackupBeforeRetrieve: async () => undefined,
    loadOrgs: async () => {}, sendActiveFile: () => {}, maybeAutoFetchOrg: () => {},
    output: { appendLine: () => {} },
    context: {
      workspaceState: { get: (k) => kept[k], update: async (k, v) => { kept[k] = v === undefined ? undefined : JSON.parse(JSON.stringify(v)); } },
      globalState: { get: () => undefined, update: async () => {} }
    },
    view: { visible: true, webview: { postMessage() {} } },
    sf,
    post: (m) => posted.push(m),
    failureToast: () => {}
  });
  return { s, posted };
}

check('reportDeployResult (driven through a REAL runDeploy): a successful non-validate deploy of Apex sets lastDeployedApex to this run\'s id/org/keys', async () => {
  const { s, posted } = fullDeployProvider();
  const outcome = await proto.runDeploy.call(s, ['ApexClass:AcmeOrderService', 'ApexTrigger:AcmeCaseTrigger'], { orgOverride: ORG });
  assert.strictEqual(outcome.status, 'ok');
  const runId = posted.find((m) => m.type === 'runs').runs[0].id;
  assert.ok(s.lastDeployedApex, 'lastDeployedApex must be set after a successful Apex deploy');
  assert.strictEqual(s.lastDeployedApex.runId, runId);
  assert.strictEqual(s.lastDeployedApex.org, ORG);
  assert.deepStrictEqual(s.lastDeployedApex.keys.slice().sort(), ['ApexClass:AcmeOrderService', 'ApexTrigger:AcmeCaseTrigger']);
});
check('reportDeployResult: a VALIDATE (check-only) run never sets lastDeployedApex, even with Apex in the set', async () => {
  const { s } = fullDeployProvider();
  const outcome = await proto.runDeploy.call(s, ['ApexClass:AcmeOrderService'], { orgOverride: ORG, validateOnly: true, testLevel: 'NoTestRun' });
  assert.strictEqual(outcome.status, 'ok');
  assert.strictEqual(s.lastDeployedApex, undefined);
});
// A real Apex deploy points sf-test-runner at the deployed org, so its own
// Run / CodeLens right after can't land on a different org — but only when
// the installed copy declares followOrg, and never for a check-only run.
check('reportDeployResult: a successful Apex deploy calls sfTestRunner.followOrg with the deploy\'s org — only when the installed sf-test-runner declares it, never for a validate', async () => {
  const TR_FOLLOW = { contributes: { commands: [...TR_CURRENT.contributes.commands, { command: 'sfTestRunner.followOrg' }] } };
  const follows = () => execCalls.filter((c) => c[0] === 'sfTestRunner.followOrg');
  const prev = testRunnerInstalled;
  try {
    testRunnerInstalled = TR_FOLLOW; execCalls.length = 0;
    await proto.runDeploy.call(fullDeployProvider().s, ['ApexClass:AcmeOrderService'], { orgOverride: ORG });
    assert.deepStrictEqual(follows(), [['sfTestRunner.followOrg', { targetOrg: ORG }]]);

    execCalls.length = 0;
    await proto.runDeploy.call(fullDeployProvider().s, ['ApexClass:AcmeOrderService'], { orgOverride: ORG, validateOnly: true, testLevel: 'NoTestRun' });
    assert.strictEqual(follows().length, 0, 'a validate deploys nothing — nothing to follow');

    testRunnerInstalled = TR_CURRENT; execCalls.length = 0;
    await proto.runDeploy.call(fullDeployProvider().s, ['ApexClass:AcmeOrderService'], { orgOverride: ORG });
    assert.strictEqual(follows().length, 0, 'an sf-test-runner without followOrg is never called with it');
  } finally {
    testRunnerInstalled = prev;
  }
});

// ===================================================== 6) webview: the toolbar button + peers
check('panel.js: "Run tests" shows only with peers.testRunner + an Apex/local selection, labels/disables like Diff, clears on peers:false, and sends exactly those keys', () => {
  const THREE = ['AcmeOrderService', 'AcmeOrderServiceTest', 'AcmeInvoiceService'];
  const FILES = { type: 'files', objectChildTypes: [], items: THREE.map((n) => ({ type: 'ApexClass', name: n, filePath: `/ws/${n}.cls`, files: [] })) };
  const p = panel({ selected: [`ApexClass:${THREE[0]}`, `ApexClass:${THREE[1]}`] });
  p.deliver(FILES);
  assert.strictEqual(p.el('runTestsBtn').style.display, 'none', 'no peers message yet — hidden even with a selection');
  p.deliver({ type: 'peers', testRunner: true });
  assert.strictEqual(p.el('runTestsBtn').style.display, '');
  assert.strictEqual(p.el('runTestsBtn').textContent, 'Run tests (2)');
  assert.strictEqual(p.el('runTestsBtn').disabled, false);
  // Busy: stays visible (unlike Diff, which hides), but disabled like Diff.
  p.deliver({ type: 'busy', busy: true, action: 'Deploy', cancelling: false });
  assert.strictEqual(p.el('runTestsBtn').style.display, '');
  assert.strictEqual(p.el('runTestsBtn').disabled, true);
  p.deliver({ type: 'busy', busy: false, cancelling: false });
  assert.strictEqual(p.el('runTestsBtn').disabled, false);
  // Click sends exactly the selected Apex/local keys — never the third, unselected one.
  p.el('runTestsBtn').fire('click');
  const sent = p.outbound.filter((m) => m.type === 'runTests');
  assert.strictEqual(sent.length, 1);
  // Copied out of the VM sandbox's realm first (JSON round trip) — like
  // dom-shim's own persisted(), so deepStrictEqual compares values instead of
  // tripping over a foreign Array/Object prototype.
  const sentKeys = JSON.parse(JSON.stringify(sent[0].keys));
  assert.deepStrictEqual(sentKeys.sort(), [`ApexClass:${THREE[0]}`, `ApexClass:${THREE[1]}`].sort());
  // sf-test-runner goes away mid-session: hidden again, same selection.
  p.deliver({ type: 'peers', testRunner: false });
  assert.strictEqual(p.el('runTestsBtn').style.display, 'none');
});
check('panel.js: with peers.testRunner but nothing Apex/local selected, the button stays hidden', () => {
  const p = panel({});
  p.deliver({ type: 'files', objectChildTypes: [], items: [{ type: 'CustomObject', name: 'AcmeWidget__c', filePath: '/ws/x', files: [] }] });
  p.deliver({ type: 'peers', testRunner: true });
  p.el('selectAllRows') && p.el('selectAllRows').fire('click');
  assert.strictEqual(p.el('runTestsBtn').style.display, 'none');
});

// ---- the `peers` post on 'ready'
function readyProvider() {
  const posted = [];
  const s = Object.create(proto);
  Object.assign(s, {
    busy: false, cmdSeq: 0, cmdLog: [], deployQueue: [], liveSuggestions: new Map(),
    items: [], workspaceRoot: undefined, orgs: [], orgMembers: new Map(),
    output: { appendLine: () => {} },
    context: {
      workspaceState: { get: () => undefined, update: async () => {} },
      globalState: { get: () => undefined, update: async () => {} }
    },
    view: { visible: true, webview: { postMessage: () => {} } },
    loadFiles: async () => {}, loadOrgs: async () => {}, sendActiveFile: () => {},
    maybeReattachDeploy: () => {}, maybeAutoFetchOrg: () => {},
    post: (m) => posted.push(m)
  });
  return { s, posted };
}
check('handleMessage(ready): posts `peers` with the CURRENT testRunner availability — checked fresh, not cached', async () => {
  testRunnerInstalled = TR_CURRENT;
  const { s, posted } = readyProvider();
  await proto.handleMessage.call(s, { type: 'ready' });
  const peersMsgs = posted.filter((m) => m.type === 'peers');
  assert.strictEqual(peersMsgs.length, 1);
  assert.strictEqual(peersMsgs[0].testRunner, true);

  testRunnerInstalled = undefined;
  const { s: s2, posted: posted2 } = readyProvider();
  await proto.handleMessage.call(s2, { type: 'ready' });
  assert.strictEqual(posted2.find((m) => m.type === 'peers').testRunner, false);
});

// ===================================================== wiring sanity
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
check('package.json: deployComponents is declared and hidden from the command palette', () => {
  assert.ok(pkg.contributes.commands.some((c) => c.command === 'sfOrgDeployWrapper.deployComponents'));
  const hidden = (pkg.contributes.menus.commandPalette || []).find((m) => m.command === 'sfOrgDeployWrapper.deployComponents');
  assert.ok(hidden, 'deployComponents must be hidden from the command palette like TR\'s own handoff commands');
  assert.strictEqual(hidden.when, 'false');
});
check('panelHtml.ts: the Run tests button sits between Retrieve and Validate', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'panelHtml.ts'), 'utf8');
  const r = html.indexOf('id="retrieveBtn"');
  const t = html.indexOf('id="runTestsBtn"');
  const v = html.indexOf('id="validateBtn"');
  assert.ok(r > 0 && r < t && t < v, 'runTestsBtn must sit between retrieveBtn and validateBtn');
});

// ---- mutation target: registerSafe RETURNS the handler's result (extension.ts)
check('extension.ts: registerSafe RETURNS the handler\'s promise chain rather than discarding it — deployComponents\' caller (executeCommand) needs the real value back', () => {
  const extSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  const normalized = extSrc.replace(/\s+/g, ' ');
  assert.ok(normalized.includes('return Promise.resolve(fn(...args))'), 'registerSafe must return the handler\'s promise chain');
  assert.ok(!normalized.includes('void Promise.resolve(fn(...args))'), 'reverting to void Promise.resolve(...) silently drops the real result from every caller, including deployComponents\'');
});

check('this harness is registered in package.json "check"', () => {
  assert.ok(pkg.scripts.check.includes('node ./scripts/check-test-handoff.cjs'));
});

(async () => {
  let ran = 0;
  for (const [name, fn] of queue) {
    ran++;
    try { await fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
  }
  if (failed) { console.error(`test-handoff: ${failed}/${ran} checks FAILED`); process.exit(1); }
  console.log(`test-handoff: all ${ran} checks passed`);
})();
