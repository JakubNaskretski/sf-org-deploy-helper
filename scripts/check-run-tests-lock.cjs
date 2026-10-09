// Runnable contract test for the "Run tests" in-flight lock. No framework.
//   1) npm run compile   2) node scripts/check-run-tests-lock.cjs
//
// A "Run tests" click hands the deploy's Apex to sf-test-runner and waits for
// its reply for the whole run (minutes) — deliberately outside this panel's
// busy slot, so nothing else in the panel freezes. A second click while that
// handoff is out used to be handed over again and came back as sf-test-runner's
// "A test run is already in progress", read as an error. So:
//   1) the provider holds ONE handoff at a time: a second Run tests (the same
//      card, or the toolbar) is refused here — no second executeCommand — with
//      a transient info note (shown, never kept as a notice) and an Output
//      line naming where it came from; the lock ends when the reply is in,
//      whatever it was;
//   2) while ANY handoff is out every Run tests button is locked: the newest
//      deploy's run payload carries `running`, drawn as "Running tests in SF
//      Tests…" — through the real runs post and the real panel.js, not just
//      the view function — and the busy posts carry `testsRunning`, which
//      disables the toolbar's; the card's button also locks itself on the
//      click, so a double click is handed over once;
//   3) a `busy` reply (the user's own run in SF Tests) is a warning in this
//      panel's words, not a failure, and the button is usable again after it;
//   4) a passed/failed card carries sf-test-runner's own note as a line.
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const Module = require('module');

// ---------------------------------------------------------------- vscode stub
const TEST_RUNNER_ID = 'Skrety.sf-test-runner';
const TR_CURRENT = { contributes: { commands: [{ command: 'sfTestRunner.runSelected' }, { command: 'sfTestRunner.runTestsFor' }] } };
let execImpl = async () => undefined;
const execCalls = [];
const vscodeStub = {
  window: {
    showWarningMessage: () => Promise.resolve(undefined),
    showInformationMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
    setStatusBarMessage: () => ({ dispose() {} })
  },
  workspace: { getConfiguration: () => ({ get: (_k, d) => d, update: async () => {} }) },
  commands: { executeCommand: (...args) => { execCalls.push(args); return execImpl(...args); } },
  Uri: { file: (fsPath) => ({ fsPath, scheme: 'file' }) },
  extensions: { getExtension: (id) => (id === TEST_RUNNER_ID ? { packageJSON: TR_CURRENT } : undefined) }
};
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? vscodeStub : origLoad(req, ...rest));

const OUT = path.join(__dirname, '..', 'out');
const P = require(path.join(OUT, 'panelProvider.js'));
const proto = P.DeployPanelProvider.prototype;
const RV = require(path.join(__dirname, '..', 'src', 'runView.js'));
const { panel } = require('./lib/dom-shim.cjs');

let failed = 0;
const queue = [];
function check(name, fn) { queue.push([name, fn]); }
const settle = () => new Promise((r) => setTimeout(r, 0));

const ORG = 'acme-dev-user';
const ORGS = [{ username: ORG, alias: 'acme-dev' }];
const cls = (name) => ({ type: 'ApexClass', name, filePath: `/ws/force-app/classes/${name}.cls`, files: [] });
const ITEMS = [cls('AcmeOrderService'), cls('AcmeInvoiceService')];
const RUN_ID = 'run-lock-1';
const NOW = Date.now();
const deployRun = () => ({
  v: 1, id: RUN_ID, op: 'deploy', status: 'succeeded', org: ORG, orgLabel: 'acme-dev', orgKind: 'sandbox',
  startedAt: NOW - 60_000, finishedAt: NOW - 30_000, target: 'selection',
  counts: { deployed: 2 }, rows: [{ k: 'ApexClass:AcmeOrderService', o: 'deployed', s: 1 }, { k: 'ApexClass:AcmeInvoiceService', o: 'deployed', s: 1 }],
  rowsComplete: true, tests: []
});
const PASSED = { status: 'passed', orgAlias: 'acme-dev', testClasses: ['AcmeOrderServiceTest'], passed: 3, failed: 0 };

/** A provider on a bare prototype (class field initializers never run), with
 *  the REAL RunStore behind it, holding one succeeded deploy that sent Apex. */
function provider() {
  const posted = [];
  const logs = [];
  const s = Object.create(proto);
  Object.assign(s, {
    items: ITEMS,
    orgs: ORGS,
    orgStore: { get: () => ORG },
    liveSuggestions: new Map(),
    lastDeployedApex: { runId: RUN_ID, org: ORG, keys: ['ApexClass:AcmeOrderService', 'ApexClass:AcmeInvoiceService'] },
    output: { appendLine: (l) => logs.push(l) },
    post: (m) => posted.push(m)
  });
  s.runStore.finish(deployRun());
  posted.length = 0;
  return { s, posted, logs };
}
/** sf-test-runner's reply, held until the check releases it. */
function heldReply() {
  let release;
  execImpl = () => new Promise((resolve) => { release = resolve; });
  return (reply) => release(reply);
}
const cards = (posted) => posted.filter((m) => m.type === 'status').map((m) => m.card);
const runsPosts = (posted) => posted.filter((m) => m.type === 'runs');
const headRunTests = (m) => m.runs[0] && m.runs[0].runTests;
const cardClick = (s) => proto.handleMessage.call(s, { type: 'runTests', runId: RUN_ID });
const toolbarClick = (s) => proto.handleMessage.call(s, { type: 'runTests', keys: ['ApexClass:AcmeOrderService'] });

// ============================================================ 1) the lock
check('a second card click while the handoff is out: no second executeCommand, one info card, a log line naming the card; after the reply a click goes through again', async () => {
  execCalls.length = 0;
  const release = heldReply();
  const { s, posted, logs } = provider();
  await cardClick(s);
  assert.strictEqual(execCalls.length, 1, 'the first click hands over');
  await cardClick(s);
  assert.strictEqual(execCalls.length, 1, 'the second click must not reach sf-test-runner');
  const info = cards(posted);
  assert.strictEqual(info.length, 1, JSON.stringify(info));
  assert.strictEqual(info[0].kind, 'info');
  assert.strictEqual(info[0].transient, true, 'a refused click is a note, never a kept notice');
  assert.strictEqual(info[0].title, 'Run tests was clicked twice — sent to SF Tests once');
  assert.ok(logs.some((l) => l.startsWith(`[runTests] refused duplicate source=card runId=${RUN_ID} — the handoff runId=${RUN_ID} started `)), logs.join('\n'));
  release(PASSED);
  await settle();
  assert.strictEqual(cards(posted).length, 2, 'the result card follows');
  assert.strictEqual(cards(posted)[1].kind, 'ok');
  await cardClick(s);
  assert.strictEqual(execCalls.length, 2, 'once the reply is in, the lock is gone');
  release(PASSED);
  await settle();
});

check('the lock is cleared whatever the reply: a throw from executeCommand frees it too', async () => {
  execCalls.length = 0;
  execImpl = async () => { throw new Error('command not found'); };
  const { s } = provider();
  await cardClick(s);
  await settle();
  assert.strictEqual(s.testsInFlight, undefined);
  await cardClick(s);
  await settle();
  assert.strictEqual(execCalls.length, 2);
});

check('the toolbar is refused too while a handoff is out — logged as "toolbar", and its card does not claim these are this deploy\'s tests', async () => {
  execCalls.length = 0;
  const release = heldReply();
  const { s, posted, logs } = provider();
  await cardClick(s);
  await toolbarClick(s);
  assert.strictEqual(execCalls.length, 1);
  assert.ok(logs.some((l) => l.startsWith(`[runTests] refused duplicate source=toolbar runId=(toolbar) — the handoff runId=${RUN_ID} started `)), logs.join('\n'));
  const info = cards(posted);
  assert.strictEqual(info.length, 1);
  assert.strictEqual(info[0].kind, 'info');
  assert.strictEqual(info[0].transient, true);
  assert.ok(/already running in SF Tests/.test(info[0].title) && !/clicked twice/.test(info[0].title), info[0].title);
  release(PASSED);
  await settle();
});

check('a toolbar handoff holds the lock as well: a second toolbar click is refused', async () => {
  execCalls.length = 0;
  const release = heldReply();
  const { s, logs } = provider();
  await toolbarClick(s);
  await toolbarClick(s);
  assert.strictEqual(execCalls.length, 1);
  assert.ok(logs.some((l) => l.startsWith('[runTests] refused duplicate source=toolbar runId=(toolbar) — the handoff runId=(toolbar) started ')), logs.join('\n'));
  release(PASSED);
  await settle();
  await toolbarClick(s);
  assert.strictEqual(execCalls.length, 2);
  release(PASSED);
  await settle();
});

check('the Output names each handoff: started with runId, requestId, org and class count; finished with the reply\'s status and how long it took', async () => {
  execCalls.length = 0;
  const release = heldReply();
  const { s, logs } = provider();
  await cardClick(s);
  assert.ok(logs.includes(`[runTests] handoff started runId=${RUN_ID} requestId=${RUN_ID} org=${ORG} classes=2`), logs.join('\n'));
  release({ status: 'failed', testClasses: ['AcmeOrderServiceTest'], passed: 2, failed: 1 });
  await settle();
  assert.ok(logs.some((l) => /^\[runTests\] handoff finished status=failed in \d+ms$/.test(l)), logs.join('\n'));
  await toolbarClick(s);
  assert.ok(logs.includes(`[runTests] handoff started runId=(toolbar) requestId=(none) org=${ORG} classes=1`), logs.join('\n'));
  release(PASSED);
  await settle();
});

// ============================================================ 2) the payload + the drawn button
check('the runs payload: `running` (with its start) is posted the moment the lock is taken, and a post without it follows the result card', async () => {
  const release = heldReply();
  const { s, posted } = provider();
  const run = deployRun();
  assert.deepStrictEqual(proto.liveRunPayload.call(s, run), { runTests: { count: 2 } });
  await cardClick(s);
  const taken = runsPosts(posted);
  assert.strictEqual(taken.length, 1, 'the lock re-posts the runs at once');
  assert.strictEqual(headRunTests(taken[0]).running, true);
  assert.strictEqual(typeof headRunTests(taken[0]).startedAt, 'number');
  assert.strictEqual(proto.liveRunPayload.call(s, run).runTests.running, true);
  release(PASSED);
  await settle();
  const all = runsPosts(posted);
  assert.strictEqual(all.length, 2, 'and again when it clears');
  assert.ok(!headRunTests(all[1]).running, JSON.stringify(headRunTests(all[1])));
  assert.ok(posted.indexOf(all[1]) > posted.findIndex((m) => m.type === 'status'), 'cleared after the result card is posted');
  assert.deepStrictEqual(proto.liveRunPayload.call(s, run), { runTests: { count: 2 } });
});

check('a toolbar handoff locks the newest deploy card too — its click would only be refused — as `waiting` (not this card\'s run, so no start time of its own), with runs posts at take and clear', async () => {
  const release = heldReply();
  const { s, posted } = provider();
  await toolbarClick(s);
  assert.deepStrictEqual(proto.liveRunPayload.call(s, deployRun()).runTests, { count: 2, waiting: true });
  assert.strictEqual(runsPosts(posted).length, 1, 'the runs are re-posted when a toolbar handoff takes the lock');
  assert.strictEqual(headRunTests(runsPosts(posted)[0]).waiting, true);
  release(PASSED);
  await settle();
  assert.strictEqual(runsPosts(posted).length, 2, 'and when it clears');
  assert.deepStrictEqual(headRunTests(runsPosts(posted)[1]), { count: 2 });
});

check('a newer deploy finishing during a card handoff gets `waiting`, never the other card\'s "running" and start time', async () => {
  const release = heldReply();
  const { s } = provider();
  await cardClick(s);
  const newer = Object.assign(deployRun(), { id: 'run-lock-2' });
  s.lastDeployedApex = { runId: newer.id, org: ORG, keys: ['ApexClass:AcmeInvoiceService'] };
  assert.deepStrictEqual(proto.liveRunPayload.call(s, newer).runTests, { count: 1, waiting: true });
  release(PASSED);
  await settle();
  assert.deepStrictEqual(proto.liveRunPayload.call(s, newer).runTests, { count: 1 });
});

check('a throwing runs re-post at take still drops the lock and tells the toolbar — never a lock left set for the window\'s life', async () => {
  execCalls.length = 0;
  execImpl = async () => PASSED;
  const { s, posted, logs } = provider();
  s.runStore.refreshLive = () => { throw new Error('runs post failed'); };
  await cardClick(s);
  await settle();
  assert.strictEqual(s.testsInFlight, undefined, 'the lock is dropped');
  const busy = posted.filter((m) => m.type === 'busy');
  assert.ok(busy.length && busy[busy.length - 1].testsRunning === false, JSON.stringify(busy));
  assert.ok(logs.some((l) => l === '[runTests] runs post failed'), logs.join('\n'));
  delete s.runStore.refreshLive;
  await cardClick(s);
  assert.strictEqual(s.testsInFlight === undefined, false, 'a new click takes the lock again');
  await settle();
});

check('a throwing runs re-post at clear: the result card is out, the lock dropped, the busy post says testsRunning false', async () => {
  execCalls.length = 0;
  const release = heldReply();
  const { s, posted } = provider();
  await cardClick(s);
  s.runStore.refreshLive = () => { throw new Error('runs post failed'); };
  release(PASSED);
  await settle();
  assert.strictEqual(execCalls.length, 1);
  assert.strictEqual(cards(posted).length, 1);
  assert.strictEqual(cards(posted)[0].kind, 'ok');
  assert.strictEqual(s.testsInFlight, undefined);
  const busy = posted.filter((m) => m.type === 'busy');
  assert.strictEqual(busy[busy.length - 1].testsRunning, false);
  delete s.runStore.refreshLive;
});

check('the busy posts carry testsRunning: true from the moment the lock is taken, false once the result card is out', async () => {
  const release = heldReply();
  const { s, posted } = provider();
  await toolbarClick(s);
  const busy = () => posted.filter((m) => m.type === 'busy');
  assert.strictEqual(busy().length, 1, JSON.stringify(posted.map((m) => m.type)));
  assert.strictEqual(busy()[0].testsRunning, true);
  release(PASSED);
  await settle();
  const last = busy()[busy().length - 1];
  assert.strictEqual(last.testsRunning, false);
  assert.ok(posted.indexOf(last) > posted.findIndex((m) => m.type === 'status'), 'after the result card');
});

const hm = (t) => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
check('runView: running draws a locked "Running tests in SF Tests…" saying the clock time it started (a tooltip never re-renders by itself); otherwise the usual "Run tests (N)"', () => {
  const base = Object.assign(deployRun(), { runTests: { count: 3, running: true, startedAt: NOW - 75_000 } });
  const ctx = { isLatest: true, busy: false, pending: false, complete: true, sent: [], selectKeys: [] };
  const b = RV.actionsFor(base, ctx).buttons.find((x) => x.id === 'runTests');
  assert.strictEqual(b.label, 'Running tests in SF Tests…');
  assert.strictEqual(b.disabled, true);
  assert.strictEqual(b.title, `Started at ${hm(NOW - 75_000)}; the result card appears here when it finishes`);
  // The webview's own click lock, before the provider has answered.
  const clicked = Object.assign(deployRun(), { runTests: { count: 3 } });
  const c = RV.actionsFor(clicked, Object.assign({}, ctx, { runTestsClickedAt: NOW })).buttons.find((x) => x.id === 'runTests');
  assert.strictEqual(c.label, 'Running tests in SF Tests…');
  assert.strictEqual(c.disabled, true);
  assert.strictEqual(c.title, `Started at ${hm(NOW)}; the result card appears here when it finishes`);
  const waiting = Object.assign(deployRun(), { runTests: { count: 3, waiting: true } });
  const w = RV.actionsFor(waiting, ctx).buttons.find((x) => x.id === 'runTests');
  assert.strictEqual(w.label, 'Waiting for SF Tests…');
  assert.strictEqual(w.disabled, true);
  assert.strictEqual(w.title, 'Another test run is in progress; this card\'s Run tests unlocks when it finishes');
  const noStart = Object.assign(deployRun(), { runTests: { count: 3, running: true } });
  assert.strictEqual(RV.actionsFor(noStart, ctx).buttons.find((x) => x.id === 'runTests').title, 'The result card appears here when it finishes');
  const idle = Object.assign(deployRun(), { runTests: { count: 3 } });
  const i = RV.actionsFor(idle, ctx).buttons.find((x) => x.id === 'runTests');
  assert.strictEqual(i.label, 'Run tests (3)');
  assert.strictEqual(i.disabled, false);
});

function boot() {
  const p = panel({ selected: [], expandedGroups: [], filter: '', typeFilter: [], viewMode: 'all', testClasses: '' });
  p.deliver({ type: 'orgs', orgs: [{ username: ORG, alias: 'acme-dev', label: 'acme-dev (acme-dev-user)', kind: 'sandbox' }], selected: ORG });
  p.deliver({ type: 'files', objectChildTypes: [], items: ITEMS });
  p.el('status').clientHeight = 200;
  return p;
}
const actBtn = (p, id) => p.el('status').find((e) => e.tagName === 'BUTTON' && e.dataset.act === id);

check('panel.js, fed the provider\'s own runs posts: the button locks while the handoff is out (a click sends nothing) and comes back after the reply', async () => {
  const release = heldReply();
  const { s, posted } = provider();
  const p = boot();
  // The history as a rebuilt webview would get it.
  s.runStore.refreshLive();
  p.deliver(JSON.parse(JSON.stringify(runsPosts(posted).pop())));
  assert.strictEqual(actBtn(p, 'runTests').textContent, 'Run tests (2)');
  assert.strictEqual(actBtn(p, 'runTests').disabled, false);
  posted.length = 0;
  await cardClick(s);
  for (const m of posted) p.deliver(JSON.parse(JSON.stringify(m)));
  const locked = actBtn(p, 'runTests');
  assert.strictEqual(locked.textContent, 'Running tests in SF Tests…');
  assert.strictEqual(locked.disabled, true);
  assert.ok(/^Started /.test(locked.title), locked.title);
  const before = p.outbound.filter((m) => m.type === 'runTests').length;
  locked.fire('click');
  assert.strictEqual(p.outbound.filter((m) => m.type === 'runTests').length, before, 'a locked button sends nothing');
  posted.length = 0;
  release(PASSED);
  await settle();
  for (const m of posted) p.deliver(JSON.parse(JSON.stringify(m)));
  const back = actBtn(p, 'runTests');
  assert.strictEqual(back.textContent, 'Run tests (2)');
  assert.strictEqual(back.disabled, false);
  back.fire('click');
  const sent = JSON.parse(JSON.stringify(p.outbound.filter((m) => m.type === 'runTests')));
  assert.deepStrictEqual(sent[sent.length - 1], { type: 'runTests', runId: RUN_ID });
});

check('panel.js: a double click on the card\'s Run tests sends ONE runTests — the button locks itself on the click — and a provider answer with no runs (a no-op) unlocks it', () => {
  const { s, posted } = provider();
  const p = boot();
  s.runStore.refreshLive();
  p.deliver(JSON.parse(JSON.stringify(runsPosts(posted).pop())));
  const btn = actBtn(p, 'runTests');
  btn.fire('click');
  btn.fire('click');
  assert.strictEqual(p.outbound.filter((m) => m.type === 'runTests').length, 1, 'a double click hands the tests over once');
  const drawn = actBtn(p, 'runTests');
  assert.strictEqual(drawn.textContent, 'Running tests in SF Tests…');
  assert.strictEqual(drawn.disabled, true);
  assert.ok(/^Started at \d\d:\d\d; /.test(drawn.title), drawn.title);
  drawn.fire('click');
  assert.strictEqual(p.outbound.filter((m) => m.type === 'runTests').length, 1);
  // The provider answered without taking the lock (a stale run id, say): its busy re-sync unlocks.
  p.deliver({ type: 'busy', busy: false, cancelling: false, testsRunning: false });
  assert.strictEqual(actBtn(p, 'runTests').textContent, 'Run tests (2)');
  assert.strictEqual(actBtn(p, 'runTests').disabled, false);
  // A runs post is an answer too.
  actBtn(p, 'runTests').fire('click');
  assert.strictEqual(actBtn(p, 'runTests').disabled, true);
  s.runStore.refreshLive();
  p.deliver(JSON.parse(JSON.stringify(runsPosts(posted).pop())));
  assert.strictEqual(actBtn(p, 'runTests').disabled, false);
});

check('panel.js: the toolbar\'s Run tests is disabled while busy says testsRunning, and a click then sends nothing', () => {
  const p = panel({ selected: ['ApexClass:AcmeOrderService'], expandedGroups: [], filter: '', typeFilter: [], viewMode: 'all', testClasses: '' });
  p.deliver({ type: 'files', objectChildTypes: [], items: ITEMS });
  p.deliver({ type: 'peers', testRunner: true });
  const tb = p.el('runTestsBtn');
  assert.strictEqual(tb.style.display, '');
  assert.strictEqual(tb.disabled, false);
  p.deliver({ type: 'busy', busy: false, cancelling: false, testsRunning: true });
  assert.strictEqual(tb.disabled, true);
  assert.ok(/running in SF Tests/.test(tb.title), tb.title);
  tb.fire('click');
  assert.strictEqual(p.outbound.filter((m) => m.type === 'runTests').length, 0);
  p.deliver({ type: 'busy', busy: false, cancelling: false, testsRunning: false });
  assert.strictEqual(tb.disabled, false);
  tb.fire('click');
  assert.strictEqual(p.outbound.filter((m) => m.type === 'runTests').length, 1);
});

// ============================================================ 1b) the refusal note is never kept
check('a refused click\'s note goes through the real post() without becoming a notice; a real result card is still kept', async () => {
  const release = heldReply();
  const webview = [];
  const s = Object.create(proto);
  Object.assign(s, {
    items: ITEMS, orgs: ORGS, orgStore: { get: () => ORG }, liveSuggestions: new Map(),
    lastDeployedApex: { runId: RUN_ID, org: ORG, keys: ['ApexClass:AcmeOrderService'] },
    output: { appendLine: () => {} },
    view: { webview: { postMessage: (m) => webview.push(m) } }
  });
  s.runStore.finish(deployRun());
  await cardClick(s);
  await cardClick(s);
  const note = webview.find((m) => m.type === 'status');
  assert.ok(note && note.card.transient === true && typeof note.card.at === 'number', JSON.stringify(note));
  assert.strictEqual(s.runStore.notices().length, 0, 'the refusal must not be kept');
  release(PASSED);
  await settle();
  assert.strictEqual(s.runStore.notices().length, 1, 'the result card is');
  assert.strictEqual(s.runStore.notices()[0].kind, 'ok');
});

check('panel.js: a transient note shows without taking a kept card\'s place, and a newer one replaces it', () => {
  const p = panel({ selected: [], expandedGroups: [], filter: '', typeFilter: [], viewMode: 'all', testClasses: '' });
  const kept = [3, 2, 1].map((n) => ({ kind: 'ok', title: `Kept ${n}`, at: NOW - n * 1000 }));
  p.deliver({ type: 'statusHistory', cards: kept, cap: 3 });
  const titles = () => p.el('status').findAll((e) => e._classes && e._classes.has('status-card')).map((e) => e.find((x) => x.tagName === 'SPAN' && /^(Kept|Run tests|Fresh)/.test(x.textContent))).map((x) => x && x.textContent);
  p.deliver({ type: 'status', card: { kind: 'info', transient: true, title: 'Run tests was clicked twice — sent to SF Tests once', at: NOW } });
  assert.deepStrictEqual(titles(), ['Run tests was clicked twice — sent to SF Tests once', 'Kept 3', 'Kept 2', 'Kept 1']);
  p.deliver({ type: 'status', card: { kind: 'info', transient: true, title: 'Run tests was clicked twice — sent to SF Tests once', at: NOW + 1 } });
  assert.strictEqual(titles().length, 4, 'one transient note at a time');
  p.deliver({ type: 'status', card: { kind: 'ok', title: 'Fresh', at: NOW + 2 } });
  assert.deepStrictEqual(titles(), ['Fresh', 'Run tests was clicked twice — sent to SF Tests once', 'Kept 3', 'Kept 2']);
  // The handoff it was about is still out: the note stays.
  p.deliver({ type: 'busy', busy: false, cancelling: false, testsRunning: true });
  assert.strictEqual(titles().length, 4);
  // It is over: the note goes with it.
  p.deliver({ type: 'busy', busy: false, cancelling: false, testsRunning: false });
  assert.deepStrictEqual(titles(), ['Fresh', 'Kept 3', 'Kept 2']);
});

// ============================================================ 3) busy
const BUSY = { status: 'busy', testClasses: ['AcmeOrderServiceTest'], passed: 0, failed: 0, message: 'A test run is already in progress. Wait for it to finish.' };
check('a busy reply is a warning in this panel\'s words — nothing failed, the tests were not started — and the button is usable again after it', async () => {
  const release = heldReply();
  const { s, posted } = provider();
  await cardClick(s);
  release(BUSY);
  await settle();
  const c = cards(posted);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].kind, 'warn', 'not the failure (err) styling');
  assert.strictEqual(c[0].title, 'SF Tests is already running tests — wait for that run; this deploy\'s tests were not started');
  const runs = runsPosts(posted);
  assert.ok(!headRunTests(runs[runs.length - 1]).running);
  const btn = RV.actionsFor(Object.assign(deployRun(), proto.liveRunPayload.call(s, deployRun())), { isLatest: true, complete: true, sent: [], selectKeys: [] }).buttons.find((b) => b.id === 'runTests');
  assert.strictEqual(btn.label, 'Run tests (2)');
  assert.strictEqual(btn.disabled, false);
});
check('testsCard(busy): from the toolbar it says "these tests", never "this deploy\'s"', () => {
  const t = P.testsCard(BUSY, 'acme-dev', false, false);
  assert.strictEqual(t.kind, 'warn');
  assert.strictEqual(t.title, 'SF Tests is already running tests — wait for that run; these tests were not started');
  assert.strictEqual(t.meta, 'Classes: AcmeOrderServiceTest');
});

// ============================================================ 4) the runner's note on passed/failed
check('testsCard: passed/failed carry sf-test-runner\'s message as a card line; no message, no lines', () => {
  const note = 'AcmeHelper: @isTest, but the org found no test methods in it';
  const ok = P.testsCard({ status: 'passed', testClasses: ['AcmeHelper', 'AcmeOrderServiceTest'], passed: 3, failed: 0, message: note }, 'acme-dev');
  assert.strictEqual(ok.kind, 'ok');
  assert.deepStrictEqual(ok.lines, [note]);
  const bad = P.testsCard({ status: 'failed', testClasses: ['AcmeOrderServiceTest'], passed: 1, failed: 2, message: note }, 'acme-dev');
  assert.strictEqual(bad.kind, 'err');
  assert.deepStrictEqual(bad.lines, [note]);
  assert.ok(!('lines' in P.testsCard(PASSED, 'acme-dev')), 'no note, no empty line');
});
check('the note reaches the posted card, and panel.js draws it as a line', async () => {
  const note = 'AcmeHelper: @isTest, but the org found no test methods in it';
  execImpl = async () => Object.assign({}, PASSED, { message: note });
  const { s, posted } = provider();
  await cardClick(s);
  await settle();
  const card = cards(posted)[0];
  assert.deepStrictEqual(card.lines, [note]);
  const p = boot();
  p.deliver({ type: 'status', card: JSON.parse(JSON.stringify(card)) });
  const li = p.el('status').find((e) => e.tagName === 'LI' && e.textContent === note);
  assert.ok(li, 'the note is drawn as a card line');
});

// ============================================================ wiring
check('the info card kind has an icon and a colour in the webview', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'panel.js'), 'utf8');
  assert.ok(/CARD_ICONS = \{[^}]*\binfo:/.test(js), 'CARD_ICONS.info');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'panelHtml.ts'), 'utf8');
  assert.ok(html.includes('.status-card.info {'), '.status-card.info');
});
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
check('this harness is registered in package.json "check"', () => {
  assert.ok(pkg.scripts.check.includes('node ./scripts/check-run-tests-lock.cjs'));
});

(async () => {
  let ran = 0;
  for (const [name, fn] of queue) {
    ran++;
    try { await fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
  }
  if (failed) { console.error(`run-tests-lock: ${failed}/${ran} checks FAILED`); process.exit(1); }
  console.log(`run-tests-lock: all ${ran} checks passed`);
})();
