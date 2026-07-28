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
  ProgressLocation: { Notification: 15 }
};
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? vscodeStub : origLoad(req, ...rest));

const {
  DeployPanelProvider, classifyDiffOutcome, nothingDiffableNotice
} = require(path.join(__dirname, '..', 'out', 'panelProvider.js'));

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
check('a single unsupported type is named outright — the LWC right-click case', () => {
  assert.strictEqual(
    nothingDiffableNotice(['LightningComponentBundle'], 0),
    "Nothing to diff — diff isn't supported for LightningComponentBundle yet"
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

check('WIRING: right-clicking an LWC with the panel closed is no longer silent', async () => {
  resetUi();
  const { stub, posted } = diffStub([item('LightningComponentBundle', 'myCmp', '/w/lwc/myCmp/myCmp.js')]);
  await DeployPanelProvider.prototype.runDiff.call(stub, ['LightningComponentBundle:myCmp']);
  drainTmpCleanup();
  assert.strictEqual(cards(posted).length, 1, 'expected exactly the one verdict card');
  assert.strictEqual(cards(posted)[0].title, 'Nothing to diff');
  assert.deepStrictEqual(ui.warn.map(w => w.message), [
    "SF Deploy (warning): Nothing to diff — diff isn't supported for LightningComponentBundle yet"
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

void (async () => {
  for (const [name, fn] of queue) {
    try { await fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
  }
  if (failed) { console.error(`\n${failed} of ${queue.length} check(s) failed`); process.exit(1); }
  console.log(`hidden-panel notifications: all ${queue.length} checks passed`);
})();
