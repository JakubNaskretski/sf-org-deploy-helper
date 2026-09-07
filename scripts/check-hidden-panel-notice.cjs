// Runnable contract test for the "panel is hidden, so the verdict is invisible"
// class of bug (notifyIfPanelHidden + the diff verdict classification).
//   1) npm run compile   2) node scripts/check-hidden-panel-notice.cjs
//
// Every context-menu operation delivers its result as a status CARD, and cards go
// to `this.view`, which VS Code only creates when the panel is first revealed.
// Right-clicking a file with the panel never opened therefore produced literal
// silence for any outcome that wasn't a thrown error — the reported bug being
// "Diff with Org" on a component that isn't on the org.
//
// Four things are pinned here:
//   1. notifyIfPanelHidden's gate and presentation — a warn verdict must NOT be
//      dressed as success ("$(check) Nothing to diff" claims an outcome that did
//      not happen), and a VISIBLE panel must still get nothing at all, since the
//      card is already on screen.
//   2. The auto-dismiss split, and where it STOPS. VS Code has no timeout on
//      showInformationMessage / showWarningMessage and no API to close a
//      notification, and one carrying an action button stays until the user clicks
//      it away — so a SUCCESS verdict runs through a progress notification, which
//      ends when its promise settles. A WARN must NOT: VS Code drops a settled
//      progress notification from the Notification Center entirely, so a warn the
//      user wasn't watching for 20 seconds would leave no trace anywhere and no
//      route to the card holding the detail — which is this bug's own shape, one
//      layer down. Warns and failures (failureToast / reportError) stay persistent
//      and carry 'Show Panel'.
//   3. classifyDiffOutcome — which outcome may stay silent. An opened diff editor
//      IS the feedback; a run that opened nothing is not.
//   4. The wiring, through the real runDiff: an unsupported type (LWC/Aura — the
//      context menu explicitly matches lwc/aura paths) and an all-missing run both
//      reach the notification, and a run that opened editors does not.
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const Module = require('module');

// ---------------------------------------------------------------- vscode stub
// Only the window/command surface these paths touch. Every call is recorded so
// "was the user told anything?" is assertable instead of invisible.
const ui = { status: [], info: [], warn: [], error: [], commands: [], notices: [] };
// Listeners registered by scheduleTmpCleanup — invoked with [] after each wiring
// case so its 10-minute hard-cap timer is cleared and the script can exit.
const editorListeners = [];
const resetUi = () => { for (const k of Object.keys(ui)) ui[k].length = 0; editorListeners.length = 0; };

// withProgress is the auto-dismiss mechanism, so the stub models the part that
// matters: the notification is on screen for exactly as long as the body's promise
// is pending. The provider arms its dismissal with setTimeout INSIDE that body, so
// setTimeout is swapped for the length of the synchronous body call — that captures
// the delay and hands the check a `fire()` to close the notice on demand, instead of
// making this script wait 20 real seconds. The swap is restored immediately, so the
// unrelated timers runDiff arms (scheduleTmpCleanup) are untouched.
const recordProgress = (options, body) => {
  const notice = { title: options.title, options, delay: undefined, unrefed: false, open: true };
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => {
    notice.delay = ms;
    notice.fire = fn;
    // No _onTimeout: the provider's clearTimeout(timer) must no-op on this handle.
    return { unref: () => { notice.unrefed = true; } };
  };
  let promise;
  try {
    promise = Promise.resolve(body({ report: () => {} }, { onCancellationRequested: () => ({ dispose: () => {} }) }));
  } finally {
    global.setTimeout = realSetTimeout;
  }
  // The notification lives until the promise settles — that IS the dismissal.
  void promise.then(() => { notice.open = false; }, () => { notice.open = false; });
  notice.settled = promise;
  ui.notices.push(notice);
  return promise;
};

const vscodeStub = {
  window: {
    setStatusBarMessage: (text, ms) => { ui.status.push({ text, ms }); return { dispose: () => {} }; },
    showInformationMessage: (message, ...items) => { ui.info.push({ message, items }); return Promise.resolve(undefined); },
    showWarningMessage: (message, ...items) => { ui.warn.push({ message, items }); return Promise.resolve(undefined); },
    showErrorMessage: (message, ...items) => { ui.error.push({ message, items }); return Promise.resolve(undefined); },
    withProgress: (options, body) => recordProgress(options, body),
    onDidChangeVisibleTextEditors: (fn) => { editorListeners.push(fn); return { dispose: () => {} }; }
  },
  commands: { executeCommand: (id, ...args) => { ui.commands.push({ id, args }); return Promise.resolve(undefined); } },
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  Uri: { file: (fsPath) => ({ fsPath, scheme: 'file' }) },
  ViewColumn: { Active: -1 },
  ProgressLocation: { Notification: 15, Window: 10 }
};
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? vscodeStub : origLoad(req, ...rest));

const {
  DeployPanelProvider, classifyDiffOutcome, nothingDiffableNotice, notifyHeadline
} = require(path.join(__dirname, '..', 'out', 'panelProvider.js'));
const providerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'panelProvider.ts'), 'utf8');

let failed = 0;
// Checks are queued and run in order: several of them drive the real runDiff and
// assert against the shared `ui` recorder, so overlapping them would race.
const queue = [];
function check(name, fn) { queue.push([name, fn]); }

// ============================================================ the notification
const notify = DeployPanelProvider.prototype.notifyIfPanelHidden;
const notifySuccess = DeployPanelProvider.prototype.notifySuccessIfPanelHidden;
// The success entry point delegates, so `this` must carry the prototype.
const panel = (view) => Object.assign(Object.create(DeployPanelProvider.prototype), { view });

check('a VISIBLE panel is told nothing — the card is already on screen', () => {
  resetUi();
  notify.call(panel({ visible: true }), 'Nothing to diff — not on acme-dev', 'warn');
  notifySuccess.call(panel({ visible: true }), 'Deployed 1 component to acme-dev');
  assert.deepStrictEqual([ui.status.length, ui.notices.length, ui.info.length, ui.warn.length], [0, 0, 0, 0]);
});

check('a NEVER-OPENED panel (view undefined) notifies — the reported bug', () => {
  resetUi();
  notify.call(panel(undefined), 'Nothing to diff — not on acme-dev', 'warn');
  assert.strictEqual(ui.warn.length, 1, 'silent for the never-opened panel');
});

check('an open-but-hidden panel notifies too', () => {
  resetUi();
  notify.call(panel({ visible: false }), 'Nothing to diff — not on acme-dev', 'warn');
  assert.strictEqual(ui.warn.length, 1);
});

check('warn is presented AS a warning — no success icon, and it says so in words', () => {
  resetUi();
  notify.call(panel(undefined), 'Nothing to diff — not on acme-dev', 'warn');
  assert.strictEqual(ui.warn[0].message, 'SF Deploy (warning): Nothing to diff — not on acme-dev');
  assert.strictEqual(ui.status[0].text, '$(warning) Nothing to diff — not on acme-dev');
  assert.ok(!ui.status[0].text.includes('$(check)'), 'a check mark claims an outcome that did not happen');
});

check('a warn notice can never be read as the success form', () => {
  resetUi();
  const message = 'Nothing retrieved from acme-dev — 2 components not found on the org';
  notify.call(panel(undefined), message, 'warn');
  notifySuccess.call(panel(undefined), message);
  // Two different mechanisms now — a persistent warning toast carrying a button vs a
  // self-closing progress notification — with the words saying which is which on top.
  assert.strictEqual(ui.warn.length, 1);
  assert.strictEqual(ui.notices.length, 1);
  assert.notStrictEqual(ui.warn[0].message, ui.notices[0].title, 'warn and success rendered identically');
  assert.ok(ui.warn[0].message.startsWith('SF Deploy (warning): '), ui.warn[0].message);
  assert.ok(ui.notices[0].title.startsWith('SF Deploy: ') && !ui.notices[0].title.includes('warning'), ui.notices[0].title);
  assert.deepStrictEqual(ui.status.map(s => s.text.slice(0, 9)), ['$(warning', '$(check) ']);
});

check('the success presentation keeps its status-bar line byte-for-byte', () => {
  resetUi();
  notifySuccess.call(panel(undefined), 'Deployed 1 component to acme-dev');
  assert.deepStrictEqual(ui.status[0], { text: '$(check) Deployed 1 component to acme-dev', ms: 8000 });
  assert.strictEqual(ui.notices[0].title, 'SF Deploy: Deployed 1 component to acme-dev');
});

check('the default kind is success, so the existing call sites are unchanged', () => {
  resetUi();
  notify.call(panel(undefined), 'Retrieved 2 components from acme-dev');
  assert.strictEqual(ui.notices.length, 1);
  assert.strictEqual(ui.notices[0].title, 'SF Deploy: Retrieved 2 components from acme-dev');
  assert.strictEqual(ui.status[0].text, '$(check) Retrieved 2 components from acme-dev');
});

// ------------------------------------------------------------- the auto-dismiss
// The point of the mechanism: a SUCCESS goes away on its own. Anything carrying an
// action button cannot, which is why 'Show Panel' is gone from that one — and why a
// warn, which needs that button, is not allowed through here.
check('a success verdict uses the self-closing notification, not a sticky toast', () => {
  resetUi();
  notifySuccess.call(panel(undefined), 'Deployed 1 component to acme-dev');
  assert.strictEqual(ui.notices.length, 1);
  assert.deepStrictEqual([ui.info.length, ui.warn.length], [0, 0],
    'showInformationMessage/showWarningMessage stay until dismissed — that is the bug');
  assert.strictEqual(ui.notices[0].options.location, vscodeStub.ProgressLocation.Notification);
  assert.ok(!ui.notices[0].options.cancellable, 'a verdict has nothing to cancel');
});

check('a WARN verdict does NOT auto-dismiss — it waits, with a route to the card', () => {
  // The regression this pins: a settled progress notification is removed from the
  // Notification Center entirely, so a warn nobody watched for 20 seconds would
  // leave no trace at all — and the detail lives on a card in a panel that, by
  // definition of this code path, is not on screen.
  resetUi();
  notify.call(panel(undefined), 'Nothing to diff — not on acme-dev', 'warn');
  assert.strictEqual(ui.notices.length, 0, 'a warn must not expire on its own');
  assert.deepStrictEqual(ui.warn[0], {
    message: 'SF Deploy (warning): Nothing to diff — not on acme-dev',
    items: ['Show Panel']
  });
});

check('the warn button actually opens the panel holding the detail', async () => {
  resetUi();
  const orig = vscodeStub.window.showWarningMessage;
  // The user clicks 'Show Panel'.
  vscodeStub.window.showWarningMessage = (message, ...items) => {
    ui.warn.push({ message, items });
    return Promise.resolve('Show Panel');
  };
  try {
    notify.call(panel(undefined), 'Nothing to diff — not on acme-dev', 'warn');
    await new Promise(r => setImmediate(r));
  } finally {
    vscodeStub.window.showWarningMessage = orig;
  }
  assert.deepStrictEqual(ui.commands.map(c => c.id), ['sfOrgDeployWrapper.panel.focus']);
});

check('a warn is fire-and-forget too — the result path does not await the click', () => {
  resetUi();
  const returned = notify.call(panel(undefined), 'Nothing to diff — not on acme-dev', 'warn');
  assert.strictEqual(returned, undefined);
  assert.strictEqual(ui.warn.length, 1, 'the toast must already be on screen');
});

check('the notice closes itself after 20s, and not before', async () => {
  resetUi();
  notifySuccess.call(panel(undefined), 'Deployed 1 component to acme-dev');
  const notice = ui.notices[0];
  assert.strictEqual(notice.delay, 20000, 'the dismissal window changed');
  await new Promise(r => setImmediate(r));
  assert.strictEqual(notice.open, true, 'the verdict vanished before it could be read');
  notice.fire();
  await notice.settled;
  assert.strictEqual(notice.open, false, 'the notification never closed — the reported bug');
});

check('the dismissal timer is unref\'d — a pending notice cannot hold the host open', () => {
  resetUi();
  notifySuccess.call(panel(undefined), 'Deployed 1 component to acme-dev');
  assert.strictEqual(ui.notices[0].unrefed, true);
});

check('notifyIfPanelHidden is fire-and-forget — it returns before the timer fires', () => {
  resetUi();
  const returned = notifySuccess.call(panel(undefined), 'Deployed 1 component to acme-dev');
  // A result path calls this and must go straight on to its own cleanup: nothing
  // may be awaited, and the notice must already be on screen by the time it returns.
  assert.strictEqual(returned, undefined, 'the result paths do not await this');
  assert.strictEqual(ui.notices.length, 1);
  assert.strictEqual(ui.notices[0].open, true);
});

check('dispose closes outstanding notices instead of stranding them', async () => {
  resetUi();
  const prov = panel(undefined);
  notifySuccess.call(prov, 'Deployed 1 component to acme-dev');
  notifySuccess.call(prov, 'Retrieved 2 components from acme-dev');
  DeployPanelProvider.prototype.dismissTimedNotices.call(prov);
  await Promise.all(ui.notices.map(n => n.settled));
  assert.deepStrictEqual(ui.notices.map(n => n.open), [false, false]);
  assert.strictEqual(prov.noticeDismissers.size, 0, 'the dismissers leaked past dispose');
});

check('dispose on a provider that never notified is a no-op', () => {
  resetUi();
  DeployPanelProvider.prototype.dismissTimedNotices.call(panel(undefined));
  assert.strictEqual(ui.notices.length, 0);
});

// --------------------------------------------------------- failures stay put
// The other half of the split: a deploy failure that vanished mid-read would be
// worse than one that lingers, so these keep the persistent, button-carrying toast.
const failureToast = DeployPanelProvider.prototype.failureToast;
const reportError = DeployPanelProvider.prototype.reportError;
const errProvider = () => Object.assign(panel(undefined), {
  post: () => {},
  output: { appendLine: () => {}, show: () => {} },
  // logSfVersionOnce would otherwise reach for the sf CLI service.
  sfVersionLogged: true
});

check('failureToast stays persistent — a result failure waits to be dismissed', () => {
  resetUi();
  failureToast.call(errProvider(), 'Deploy to acme-dev failed: 2 components.', ['Ghost.cls: Invalid type']);
  assert.deepStrictEqual(ui.error[0], {
    message: 'SF Deploy: Deploy to acme-dev failed: 2 components.',
    items: ['Show Panel', 'Show Output']
  });
  assert.strictEqual(ui.notices.length, 0, 'a failure must not auto-dismiss');
});

check('reportError stays persistent too, buttons intact', () => {
  resetUi();
  reportError.call(errProvider(), 'Deploy to acme-dev', new Error('connection refused'));
  assert.deepStrictEqual(ui.error[0], {
    message: 'SF Deploy: Deploy to acme-dev failed. connection refused',
    items: ['Show Panel', 'Show Output']
  });
  assert.strictEqual(ui.notices.length, 0, 'a thrown error must not auto-dismiss');
});

check('a deploy timeout is a failure, not a warn verdict — it keeps waiting', () => {
  resetUi();
  // The only remaining showWarningMessage with buttons: it reports that the deploy
  // MAY STILL BE RUNNING on the org, which is exactly the text that must not scroll
  // away on its own.
  DeployPanelProvider.prototype.reportDeployTimeout.call(errProvider(), 'Deploy to acme-dev', new Error('timed out after 600000ms'));
  assert.deepStrictEqual(ui.warn[0].items, ['Show Panel', 'Show Output']);
  assert.strictEqual(ui.notices.length, 0, 'a timeout must not auto-dismiss');
});

// ====================================================== the diff classification
// Card text is a contract (it is also the persisted history), so the strings are
// pinned exactly as 0.16.0 rendered them — the notification decision is what's new.
check('all opened → ok card, and NO toast: the diff editor is the feedback', () => {
  const out = classifyDiffOutcome({ opened: 2, missing: 0, errors: 0, unsupported: 0, attempted: 2 }, 'acme-dev');
  assert.deepStrictEqual(out, {
    kind: 'ok',
    title: 'Diff opened for 2 components against acme-dev',
    meta: '2 opened · 0 missing · 0 errors',
    notify: 'none'
  });
});

check('nothing on the org → warn card AND a warn toast (the reported bug)', () => {
  const out = classifyDiffOutcome({ opened: 0, missing: 1, errors: 0, unsupported: 0, attempted: 1 }, 'acme-dev');
  assert.deepStrictEqual(out, {
    kind: 'warn',
    title: 'Nothing to diff — not on acme-dev',
    meta: '0 opened · 1 missing · 0 errors',
    notify: 'warn'
  });
});

check('in-band errors → err card and the failure treatment', () => {
  const out = classifyDiffOutcome({ opened: 0, missing: 0, errors: 2, unsupported: 0, attempted: 2 }, 'acme-dev');
  assert.strictEqual(out.kind, 'err');
  assert.strictEqual(out.notify, 'err');
  assert.strictEqual(out.title, 'Diff completed with issues against acme-dev');
});

check('errors win over opened diffs — a partial org failure still reports', () => {
  const out = classifyDiffOutcome({ opened: 1, missing: 0, errors: 1, unsupported: 0, attempted: 2 }, 'acme-dev');
  assert.strictEqual(out.kind, 'err');
  assert.strictEqual(out.notify, 'err');
  assert.strictEqual(out.title, 'Diff opened for 1 component against acme-dev');
});

check('a partial miss stays a warn CARD but not a second notification', () => {
  // One editor opened, one component absent: the editors are visible feedback, so
  // this deliberately does not toast. The card carries which one was skipped.
  const out = classifyDiffOutcome({ opened: 1, missing: 1, errors: 0, unsupported: 0, attempted: 2 }, 'acme-dev');
  assert.strictEqual(out.kind, 'warn');
  assert.strictEqual(out.notify, 'none');
});

check('"not on org" wording is reserved for a run where EVERYTHING was missing', () => {
  const all = classifyDiffOutcome({ opened: 0, missing: 3, errors: 0, unsupported: 0, attempted: 3 }, 'acme-dev');
  const some = classifyDiffOutcome({ opened: 0, missing: 2, errors: 0, unsupported: 1, attempted: 3 }, 'acme-dev');
  assert.strictEqual(all.title, 'Nothing to diff — not on acme-dev');
  assert.strictEqual(some.title, 'Diff completed with issues against acme-dev');
  assert.strictEqual(some.meta, '0 opened · 2 missing · 0 errors · 1 unsupported');
  assert.strictEqual(some.notify, 'warn');
});

// --------------------------------------------- nothing diffable at all (early return)
// WORDING CHANGED, deliberately. This case used to assert "diff isn't supported for
// LightningComponentBundle yet" — and by pinning that sentence it quietly froze the
// dead click it was written to make audible. A bundle IS diffable now, one file at a
// time (runDiff's focusFile), so the panel path — which has no clicked file — has to
// point at the way that works instead of denying the capability.
check('a folder-typed component points at the way to diff it, not at a refusal', () => {
  assert.strictEqual(
    nothingDiffableNotice(['LightningComponentBundle'], 0),
    'Nothing to diff — LightningComponentBundle has no whole-component diff — right-click a file inside it'
  );
});

check('several unsupported items are counted, not listed', () => {
  assert.strictEqual(
    nothingDiffableNotice(['LightningComponentBundle', 'AuraDefinitionBundle'], 0),
    'Nothing to diff — 2 unsupported metadata types'
  );
});

check('org-only items say what to do about it', () => {
  assert.strictEqual(nothingDiffableNotice([], 1), 'Nothing to diff — 1 org-only component (retrieve first)');
  assert.strictEqual(
    nothingDiffableNotice(['StaticResource'], 2),
    "Nothing to diff — diff isn't supported for StaticResource yet · 2 org-only components (retrieve first)"
  );
});

check('the empty case still says something', () => {
  assert.strictEqual(nothingDiffableNotice([], 0), 'Nothing to diff — nothing comparable was selected');
});

// =============================================================== the WIRING
// The checks above prove the units. This drives the REAL runDiff with the panel
// never opened (`view` undefined) — the only thing that proves the product
// actually calls them.
const item = (type, name, filePath) => ({ type, name, filePath, files: [filePath] });

function diffStub(items, records = []) {
  const posted = [];
  // The provider routes internal failures (a fallback, a caught exception) to its
  // output channel, so keep them for the assertion messages.
  const log = [];
  const stub = Object.create(DeployPanelProvider.prototype);
  stub.view = undefined; // panel never revealed — the bug's precondition
  stub.items = items;
  stub.orgs = [{ username: 'acme-dev-user', alias: 'acme-dev' }];
  stub.cmdSeq = 0;
  stub.post = (m) => posted.push(m);
  stub.reserveBusy = () => true;
  stub.requireRoot = () => path.join(__dirname, '..');
  stub.requireOrg = () => 'acme-dev-user';
  stub.resolveKeys = () => items;
  stub.setBusy = () => {}; // the real one drains the deploy queue — not this test's subject
  stub.output = { appendLine: (l) => log.push(l) };
  // The org round-trip, stubbed at the service boundary: `records` is what the
  // Tooling API "returns" for the requested classes.
  stub.sf = { queryTooling: () => ({ promise: Promise.resolve({ records }), cancel: () => {} }) };
  // The progress wrapper is VS Code UI, not logic — run the body directly.
  stub.withWindowProgress = (_title, body) => body(() => {});
  return { stub, posted, log };
}

// Drain scheduleTmpCleanup's visible-editor listener so its 10-minute timer is
// cleared (an armed timer would keep this script alive) and the staged temp dirs
// are removed.
const drainTmpCleanup = () => { for (const fn of editorListeners.splice(0)) fn([]); };

const cards = (posted) => posted.filter(m => m.type === 'status').map(m => m.card);

// The PANEL path only — a bundle ticked in the tree, with no clicked file to focus on.
// The right-click path this notice was named for now opens a real diff instead; that is
// scripts/check-diff-focus.cjs's subject, and the two must not drift.
check('WIRING: a bundle selected in the PANEL with the panel closed is not silent', async () => {
  resetUi();
  const { stub, posted } = diffStub([item('LightningComponentBundle', 'myCmp', '/w/lwc/myCmp/myCmp.js')]);
  await DeployPanelProvider.prototype.runDiff.call(stub, ['LightningComponentBundle:myCmp']);
  drainTmpCleanup();
  assert.strictEqual(cards(posted).length, 1, 'expected exactly the one verdict card');
  assert.strictEqual(cards(posted)[0].title, 'Nothing to diff');
  assert.deepStrictEqual(ui.warn.map(w => w.message), [
    'SF Deploy (warning): Nothing to diff — LightningComponentBundle has no whole-component diff — right-click a file inside it'
  ]);
  assert.strictEqual(ui.notices.length, 0, 'a warn verdict must not expire on its own');
  assert.strictEqual(ui.error.length, 0, 'an unsupported type is not an error');
});

check('WIRING: an org-only selection says to retrieve first', async () => {
  resetUi();
  const { stub, posted } = diffStub([{ type: 'ApexClass', name: 'OrgOnly', filePath: '', files: [] }]);
  await DeployPanelProvider.prototype.runDiff.call(stub, ['ApexClass:OrgOnly']);
  drainTmpCleanup();
  assert.strictEqual(cards(posted)[0].title, 'Nothing to diff');
  assert.deepStrictEqual(ui.warn.map(w => w.message), [
    'SF Deploy (warning): Nothing to diff — 1 org-only component (retrieve first)'
  ]);
});

check('WIRING: "not on the org" reaches the user — the exact reported bug', async () => {
  resetUi();
  // The org returns no record for the class → it is missing, nothing opens.
  const { stub, posted, log } = diffStub([item('ApexClass', 'Ghost', '/w/classes/Ghost.cls')], []);
  await DeployPanelProvider.prototype.runDiff.call(stub, ['ApexClass:Ghost']);
  drainTmpCleanup();
  const card = cards(posted).find(c => c.title.startsWith('Nothing to diff'));
  assert.ok(card, `no verdict card: ${JSON.stringify(cards(posted))} ${log.join(' | ')}`);
  assert.strictEqual(card.title, 'Nothing to diff — not on acme-dev');
  assert.deepStrictEqual(ui.warn, [{
    message: 'SF Deploy (warning): Nothing to diff — not on acme-dev',
    items: ['Show Panel']
  }], 'the wired verdict must be persistent and offer the panel, like the unit case');
  assert.strictEqual(ui.status[0].text, '$(warning) Nothing to diff — not on acme-dev');
  assert.strictEqual(ui.notices.length, 0, 'a verdict the user misses for 20s must still be findable');
});

check('WIRING: a diff that OPENS an editor adds no toast on top of it', async () => {
  resetUi();
  const { stub, posted, log } = diffStub(
    [item('ApexClass', 'Real', path.join(__dirname, '..', 'package.json'))],
    [{ Name: 'Real', NamespacePrefix: null, Body: 'public class Real {}' }]
  );
  await DeployPanelProvider.prototype.runDiff.call(stub, ['ApexClass:Real']);
  drainTmpCleanup();
  const card = cards(posted).find(c => c.title.startsWith('Diff opened'));
  assert.ok(card, `no opened-diff card: ${JSON.stringify(cards(posted))} ${log.join(' | ')}`);
  assert.ok(ui.commands.some(c => c.id === 'vscode.diff'), 'the diff editor never opened');
  assert.deepStrictEqual([ui.notices.length, ui.warn.length, ui.info.length, ui.error.length], [0, 0, 0, 0],
    'the diff editor IS the feedback — nothing else should fire');
});

// ------------------------------------------------------------- cancellation
const reportCancelled = DeployPanelProvider.prototype.reportCancelled;

check('WIRING: a bare cancel stays quiet — the user pressed Cancel', () => {
  resetUi();
  const posted = [];
  reportCancelled.call(Object.assign(panel(undefined), { post: (m) => posted.push(m) }), 'Diff against acme-dev');
  assert.strictEqual(posted[0].card.title, 'Diff against acme-dev cancelled');
  assert.deepStrictEqual([ui.notices.length, ui.warn.length, ui.info.length], [0, 0, 0]);
});

check('WIRING: a cancel carrying a NOTE surfaces it — the click does not imply it', () => {
  resetUi();
  const posted = [];
  reportCancelled.call(Object.assign(panel(undefined), { post: (m) => posted.push(m) }),
    'Deploy to acme-dev', 'The org-side deploy may still complete — check the org.');
  assert.deepStrictEqual(ui.warn.map(w => w.message), [
    'SF Deploy (warning): Deploy to acme-dev cancelled — The org-side deploy may still complete — check the org.'
  ]);
  assert.strictEqual(ui.notices.length, 0, 'the org may still be deploying — this one waits to be read');
});

// ============================================================ notify() — the flood gate
// The 0.22.1 report: at panel open, several PERSISTENT toasts land within the same
// few seconds — a project-discovery error, a Fetch Org failure, the org-list
// warning, the once-per-session watcher/diff-float notices, all stacking in VS
// Code's non-scrollable notification area until it is unreadable. failureToast,
// reportError, reportDeployTimeout, applyProjectDiscoveryFailure, the org-list
// warning, the watcher warning and the diff-float notice now all go through one
// gate, notify(), pinned here:
//   1. the headline shown is the first non-empty line only, ANSI-stripped and
//      whitespace-collapsed, capped at 140 chars — a multi-line CLI error can no
//      longer render as a wall of text in a toast;
//   2. a VISIBLE panel (the card is already on screen) gets a status-bar line,
//      never a toast — the same rule notifyIfPanelHidden already applies to
//      verdicts, extended to this gate;
//   3. an identical headline within 60s is suppressed and counted, not re-shown;
//   4. more than 3 toasts within 10s collapse the rest into ONE summary toast
//      pointing at the Output channel, since VS Code cannot update one already
//      on screen.
// notify()'s de-dup/rate-limit windows are real seconds/minutes of wall time, so
// the checks below drive it through an overridable now() (a plain field on the
// stub, exactly like withWindowProgress/reserveBusy elsewhere in this file) —
// the same trick as RescanScheduler's injected clock, without which this script
// would have to actually sleep 70+ seconds.
const notifyFn = DeployPanelProvider.prototype.notify;
const withWindowProgress = DeployPanelProvider.prototype.withWindowProgress;

function clockedProvider(view) {
  const log = [];
  let now = 0;
  const p = Object.assign(Object.create(DeployPanelProvider.prototype), {
    view,
    output: { appendLine: (l) => log.push(l), show: () => {} },
    now: () => now
  });
  return { p, log, advance: (ms) => { now += ms; } };
}

check('notifyHeadline: first non-empty line only, ANSI stripped, whitespace collapsed', () => {
  assert.strictEqual(notifyHeadline('[31mLine one[0m\nLine two'), 'Line one');
  assert.strictEqual(notifyHeadline('\n\n  \n  padded   line   here  \nmore'), 'padded line here');
  assert.strictEqual(notifyHeadline(''), '');
});

check('notifyHeadline: capped at 140 chars with an ellipsis, and never longer', () => {
  const long = 'x'.repeat(200);
  const headline = notifyHeadline(long);
  assert.strictEqual(headline.length, 140, 'a capped headline must still fit in one toast line');
  assert.ok(headline.endsWith('…'));
  assert.strictEqual(headline.slice(0, 139), 'x'.repeat(139));
  assert.strictEqual(notifyHeadline('y'.repeat(140)), 'y'.repeat(140), 'exactly at the cap is left alone');
});

check('notify: a VISIBLE panel gets the status bar, never a toast — the card is on screen', () => {
  resetUi();
  const { p } = clockedProvider({ visible: true });
  notifyFn.call(p, 'error', 'Fetch Org failed against acme-dev', { buttons: ['Show Panel', 'Show Output'] });
  assert.deepStrictEqual(ui.status[0], { text: '$(error) SF Deploy: Fetch Org failed against acme-dev', ms: 8000 });
  assert.deepStrictEqual([ui.error.length, ui.warn.length, ui.info.length], [0, 0, 0]);
});

check('notify: the status-bar icon matches the kind', () => {
  resetUi();
  const { p } = clockedProvider({ visible: true });
  notifyFn.call(p, 'warn', 'live file watching is off');
  notifyFn.call(p, 'info', "couldn't open the diff in its own window");
  assert.strictEqual(ui.status[0].text, '$(warning) SF Deploy: live file watching is off');
  assert.strictEqual(ui.status[1].text, "$(info) SF Deploy: couldn't open the diff in its own window");
});

check('notify: force shows a toast even with the panel visible', () => {
  resetUi();
  const { p } = clockedProvider({ visible: true });
  notifyFn.call(p, 'error', 'Forced notice', { force: true });
  assert.strictEqual(ui.status.length, 0);
  assert.strictEqual(ui.error.length, 1);
});

check('notify: hidden panel toasts, with exactly the buttons the caller asked for', () => {
  resetUi();
  const { p } = clockedProvider(undefined);
  notifyFn.call(p, 'error', 'Fetch Org failed against acme-dev', { buttons: ['Show Panel', 'Show Output'] });
  assert.deepStrictEqual(ui.error[0], { message: 'SF Deploy: Fetch Org failed against acme-dev', items: ['Show Panel', 'Show Output'] });
});

check('notify: a never-opened panel (view undefined) toasts too', () => {
  resetUi();
  const { p } = clockedProvider(undefined);
  notifyFn.call(p, 'warn', 'No authenticated Salesforce orgs found.');
  assert.strictEqual(ui.warn.length, 1);
});

check('notify: a multi-line message toasts only its first line — the rest stays in Output/card', () => {
  resetUi();
  const { p } = clockedProvider(undefined);
  notifyFn.call(p, 'error', 'Deploy to acme-dev failed. Line one of stderr\nLine two of stderr\nLine three');
  assert.strictEqual(ui.error[0].message, 'SF Deploy: Deploy to acme-dev failed. Line one of stderr');
});

// ---------------------------------------------------------- de-duplication (60s)
check('notify: an identical headline within 60s is suppressed and counted, not re-shown', () => {
  resetUi();
  const { p, log, advance } = clockedProvider(undefined);
  notifyFn.call(p, 'error', 'Fetch Org failed against acme-dev');
  advance(30_000);
  notifyFn.call(p, 'error', 'Fetch Org failed against acme-dev');
  advance(29_000);
  notifyFn.call(p, 'error', 'Fetch Org failed against acme-dev');
  assert.strictEqual(ui.error.length, 1, 'a repeat within 60s must not toast again');
  assert.ok(log.some(l => l.includes('[notify] suppressed duplicate ×2')), log.join(' | '));
});

check('notify: the same headline AFTER 60s toasts again', () => {
  resetUi();
  const { p, advance } = clockedProvider(undefined);
  notifyFn.call(p, 'error', 'Fetch Org failed against acme-dev');
  advance(60_001);
  notifyFn.call(p, 'error', 'Fetch Org failed against acme-dev');
  assert.strictEqual(ui.error.length, 2);
});

check('notify: a DIFFERENT headline is never suppressed', () => {
  resetUi();
  const { p } = clockedProvider(undefined);
  notifyFn.call(p, 'error', 'Fetch Org failed against acme-dev');
  notifyFn.call(p, 'error', 'Deploy to acme-dev failed');
  assert.strictEqual(ui.error.length, 2);
});

// ---------------------------------------------------------- rate limit (10s / 3)
check('notify: more than 3 toasts within 10s collapse the rest into ONE summary', () => {
  resetUi();
  const { p, log, advance } = clockedProvider(undefined);
  for (let i = 0; i < 6; i++) {
    advance(1); // distinct headlines each time so 60s de-dup never masks this
    notifyFn.call(p, 'error', `Failure #${i}`);
  }
  assert.strictEqual(ui.error.length, 3, 'only the first 3 in the window may toast individually');
  assert.strictEqual(ui.warn.length, 1, 'the rest of the window collapses into one summary');
  assert.ok(/SF Deploy: \d+ more notices? — see Output/.test(ui.warn[0].message), ui.warn[0].message);
  assert.deepStrictEqual(ui.warn[0].items, ['Show Output']);
  assert.ok(log.some(l => l.includes('[notify] rate-limited ×3 this window')),
    'the Output channel must keep counting even after the one summary toast');
});

check('notify: the summary shows once per 10s window; a later window earns its own', () => {
  resetUi();
  const { p, advance } = clockedProvider(undefined);
  for (let i = 0; i < 5; i++) { advance(1); notifyFn.call(p, 'error', `Burst A #${i}`); }
  assert.strictEqual(ui.warn.length, 1);
  advance(10_001); // the overflow window has fully elapsed
  for (let i = 0; i < 5; i++) { advance(1); notifyFn.call(p, 'error', `Burst B #${i}`); }
  assert.strictEqual(ui.warn.length, 2, 'a fresh flood 10s later earns its own summary');
});

check('notify: the visible-panel path never counts against the toast rate limit', () => {
  resetUi();
  const { p } = clockedProvider({ visible: true });
  for (let i = 0; i < 6; i++) notifyFn.call(p, 'error', `Status-only #${i}`);
  assert.strictEqual(ui.status.length, 6, 'status-bar updates are not toasts and must not be throttled');
  assert.deepStrictEqual([ui.error.length, ui.warn.length], [0, 0]);
});

// ---------------------------------------------------- quiet progress (Window vs Notification)
check('withWindowProgress: the default is a cancellable Notification', () => {
  resetUi();
  const p = Object.assign(Object.create(DeployPanelProvider.prototype), { cancelCurrent: () => {} });
  withWindowProgress.call(p, 'Doing a thing', () => Promise.resolve('ok'));
  assert.strictEqual(ui.notices[0].options.location, vscodeStub.ProgressLocation.Notification);
  assert.strictEqual(ui.notices[0].options.cancellable, true);
});

check('withWindowProgress: quiet uses the status-bar spinner, no Cancel button', () => {
  resetUi();
  const p = Object.assign(Object.create(DeployPanelProvider.prototype), { cancelCurrent: () => {} });
  withWindowProgress.call(p, 'Fetching metadata from acme-dev', () => Promise.resolve('ok'), { quiet: true });
  assert.strictEqual(ui.notices[0].options.location, vscodeStub.ProgressLocation.Window);
  assert.strictEqual(ui.notices[0].options.cancellable, false);
});

// The two places quiet must reach, and nowhere else — source-pinned, since driving
// loadOrgMetadata for real needs the full sf.listMetadata/org-store rig that
// check-fetch-org.cjs already owns (its `run()` calls it with no args, so the new
// `quiet = false` default leaves every one of its checks exactly as before).
check('source: exactly one call site passes { quiet } — loadOrgMetadata\'s own progress', () => {
  const count = (providerSrc.match(/\}, \{ quiet \}\);/g) || []).length;
  assert.strictEqual(count, 1, 'loadOrgMetadata must pass quiet to its own withWindowProgress call, and nowhere else');
  const i = providerSrc.indexOf('`Fetching metadata from ${orgLabel}`');
  assert.ok(i > 0 && providerSrc.slice(i, i + 3000).includes('}, { quiet });'),
    'the quiet flag must reach the Fetch Org progress notification');
});

check('source: exactly one call site hardcodes { quiet: true } — background type resolution', () => {
  const count = (providerSrc.match(/, \{ quiet: true \}\);/g) || []).length;
  assert.strictEqual(count, 1, 'only the background registry resolution may hardcode quiet');
  const i = providerSrc.indexOf("'Resolving metadata types (sf registry)'");
  assert.ok(i > 0 && providerSrc.slice(i, i + 300).includes('{ quiet: true }'),
    'the ordinary-scan type-resolution progress must be quiet, not a Notification');
});

check('source: the automatic Fetch Org on open requests quiet; a manual click does not', () => {
  const autoIdx = providerSrc.indexOf('private maybeAutoFetchOrg');
  assert.ok(autoIdx > 0, 'maybeAutoFetchOrg not found');
  assert.ok(/this\.loadOrgMetadata\(true\)/.test(providerSrc.slice(autoIdx, autoIdx + 1400)),
    'maybeAutoFetchOrg must fetch quietly — a Notification firing unasked at panel open is the flood itself');
  const manualIdx = providerSrc.indexOf("case 'fetchOrgMetadata':");
  assert.ok(manualIdx > 0, "'fetchOrgMetadata' case not found");
  assert.ok(/this\.loadOrgMetadata\(\);/.test(providerSrc.slice(manualIdx, manualIdx + 400)),
    'a manual Fetch Org click must keep the full cancellable Notification');
});

void (async () => {
  for (const [name, fn] of queue) {
    try { await fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
  }
  if (failed) { console.error(`\n${failed} of ${queue.length} check(s) failed`); process.exit(1); }
  console.log(`hidden-panel notifications: all ${queue.length} checks passed`);
})();
