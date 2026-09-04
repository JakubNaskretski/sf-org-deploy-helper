// Runnable contract test for the double-click guards on the PROVIDER side
// (src/panelProvider.ts). No framework.
//   1) npm run compile   2) node scripts/check-double-click.cjs
//
// A panel button posts on click and is only ever disabled by the provider's
// `busy` reply, so the second click of a double-click used to reach the
// provider as a twin message. Driven through the REAL handleMessage on
// out/panelProvider.js with `sf` recorded (its calls never resolve — an op that
// stays running) and every modal / QuickPick deferred, so each check answers
// the dialogs itself:
//   1. deploy / validate / retry ×2 → ONE confirm modal, nothing queued;
//      cancelling it runs nothing (the twin used to become a "Queue:" modal
//      whose confirm deployed with no prompt the user recognised); confirming
//      it runs exactly once;
//   2. the guard is scoped to an OPEN modal: a deploy behind a genuinely
//      running op still queues, and a modal that throws releases the guard;
//   3. the queue refuses a twin (same org, same key SET, same mode) with a
//      toast and no modal, while a different set / the other mode still queues;
//   4. every message is answered with a `busy` re-sync — thrown handler and
//      slot-less early returns included — so the webview's pending lock can't
//      stick;
//   5. Restore backup… / Discard backup hold the slot for their whole flow:
//      ×2 → one QuickPick / one modal, one "Backup discarded" card;
//   6. Rescan is answered with `filesRefreshed` however the scan ends, ⟳ with
//      `orgsRefreshed` (0.19.2 pattern);
//   7. source pins: every deploy-family modal goes through awaitConfirm (the
//      confirmOpen try/finally), the twin check sits at the push, and the
//      message wiring re-syncs in a finally.
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------- vscode stub
const modals = [];     // { message, options, items, resolve }
const picks = [];      // { items, options, resolve }
const toasts = [];     // showInformationMessage / showErrorMessage
const statusBar = [];
let modalThrows = false; // next modal rejects (window closed) — see check 2
const vscodeStub = {
  window: {
    showWarningMessage: (message, options, ...items) => {
      if (options && options.modal) {
        if (modalThrows) { modalThrows = false; return Promise.reject(new Error('window closed')); }
        return new Promise(resolve => modals.push({ message, options, items, resolve }));
      }
      toasts.push('WARN ' + message);
      return Promise.resolve(undefined);
    },
    showInformationMessage: (m) => { toasts.push(m); return Promise.resolve(undefined); },
    showErrorMessage: (m) => { toasts.push('ERR ' + m); return Promise.resolve(undefined); },
    showQuickPick: (items, options) => new Promise(resolve => picks.push({ items, options, resolve })),
    setStatusBarMessage: (m) => { statusBar.push(m); return { dispose() {} }; },
    withProgress: (_o, body) => body({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) })
  },
  workspace: { getConfiguration: () => ({ get: (_k, d) => d, update: async () => {} }) },
  commands: { executeCommand: async () => {} },
  Uri: { file: fsPath => ({ fsPath, scheme: 'file' }) },
  ViewColumn: { Active: -1 },
  ProgressLocation: { Notification: 15 },
  ConfigurationTarget: { Global: 1 },
  env: { clipboard: { writeText: async () => {} } }
};
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? vscodeStub : origLoad(req, ...rest));
const { DeployPanelProvider } = require(path.join(ROOT, 'out', 'panelProvider.js'));
const proto = DeployPanelProvider.prototype;
const src = fs.readFileSync(path.join(ROOT, 'src', 'panelProvider.ts'), 'utf8');

let failed = 0;
const queue = [];
const check = (name, fn) => queue.push([name, fn]);
const tick = () => new Promise(r => setImmediate(r));
const ticks = async (n = 3) => { for (let i = 0; i < n; i++) await tick(); };
function reset() { modals.length = 0; picks.length = 0; toasts.length = 0; statusBar.length = 0; modalThrows = false; }

// ---------------------------------------------------------------- provider
const cls = (name) => ({ type: 'ApexClass', name, filePath: `/ws/force-app/classes/${name}.cls`, files: [`/ws/force-app/classes/${name}.cls`] });
const KEYS = ['ApexClass:AcmeA', 'ApexClass:AcmeB'];
const deploy = (keys = KEYS) => ({ type: 'deploy', keys });
const validate = (keys = KEYS) => ({ type: 'deploy', keys, validateOnly: true });

/** A provider over the real prototype. `sf` records every call and never
 *  resolves it unless `extra.sf` scripts that method. `send` mirrors the
 *  resolveWebviewView wiring exactly (pinned in check 7). */
function provider(extra = {}) {
  const sfCalls = [];
  const posted = [];
  const log = [];
  const never = () => { const p = new Promise(() => {}); p.cancel = () => {}; p.promise = p; return p; };
  const sf = new Proxy(extra.sf || {}, {
    get: (t, name) => t[name] || ((...args) => { sfCalls.push({ name, args }); return never(); })
  });
  const s = Object.create(proto);
  Object.assign(s, {
    busy: false, confirmOpen: false, deployQueue: [], cmdSeq: 0, orgMembers: new Map(), orgMembersOrg: undefined,
    items: [cls('AcmeA'), cls('AcmeB')], workspaceRoot: '/ws', autoFetchDone: true, cardHistoryCache: [],
    liveSuggestions: new Map(), testLevel: undefined, runTests: undefined,
    orgs: [{ username: 'acme-dev-user', alias: 'acme-dev', instanceUrl: 'https://acme-dev.example.invalid' }],
    orgStore: { get: () => 'acme-dev-user', set: async () => {}, setFromUserPick: async () => {} },
    output: { appendLine: (l) => log.push(l) },
    context: {
      workspaceState: { get: () => extra.activeJob, update: async () => {} },
      globalState: { get: () => undefined, update: async () => {} }
    },
    view: { visible: true, webview: { postMessage() {} } },
    sf,
    post: (m) => posted.push(m),
    ...(extra.fields || {})
  });
  const send = (m) => s.handleMessage(m)
    .catch(err => s.reportError(m?.type ?? 'panel action', err))
    .finally(() => s.postBusy());
  const busyPosts = () => posted.filter(m => m.type === 'busy').map(m => ({ busy: m.busy, action: m.action }));
  const cards = () => posted.filter(m => m.type === 'status').map(m => m.card);
  const replies = (type) => posted.filter(m => m.type === type).length;
  return { s, sfCalls, posted, log, send, busyPosts, cards, replies };
}
const deployCalls = (p) => p.sfCalls.filter(c => /deploy/i.test(c.name)).length;
const guardNagged = () => statusBar.some(m => m.includes('answer the open confirmation first'));
const confirmOf = (m) => m.items[0];

// ------------------------------------------ 1) one modal for a double-click
check('deploy ×2: one confirm modal, nothing queued, the twin is told to answer the modal', async () => {
  reset();
  const p = provider();
  p.send(deploy()); p.send(deploy());
  await ticks();
  assert.strictEqual(modals.length, 1, `modals: ${modals.map(m => m.message.split('\n')[0]).join(' | ')}`);
  assert.ok(!modals[0].message.startsWith('Queue:'));
  assert.strictEqual(p.s.deployQueue.length, 0);
  assert.strictEqual(p.s.confirmOpen, true, 'confirmOpen must be held while the modal is up');
  assert.ok(guardNagged(), `status bar: ${statusBar.join(' | ')}`);
  assert.strictEqual(deployCalls(p), 0);
});

check('deploy ×2, cancel the modal: nothing runs, nothing is queued, the slot and the guard are free', async () => {
  reset();
  const p = provider();
  p.send(deploy()); p.send(deploy());
  await ticks();
  modals[0].resolve(undefined);
  await ticks();
  assert.strictEqual(deployCalls(p), 0, 'the twin deployed after the user cancelled');
  assert.strictEqual(p.s.deployQueue.length, 0);
  assert.strictEqual(p.s.busy, false);
  assert.strictEqual(p.s.confirmOpen, false);
  assert.strictEqual(modals.length, 1, 'a second modal appeared');
});

check('deploy ×2, confirm the modal: exactly one deploy, still nothing queued', async () => {
  reset();
  const p = provider();
  p.send(deploy()); p.send(deploy());
  await ticks();
  modals[0].resolve(confirmOf(modals[0]));
  await ticks();
  assert.strictEqual(deployCalls(p), 1);
  assert.strictEqual(p.s.deployQueue.length, 0);
  assert.strictEqual(p.s.busy, true);
  assert.strictEqual(p.s.confirmOpen, false, 'confirmOpen must clear once the modal is answered');
});

check('validate ×2 and retryDeploy ×2: one modal each', async () => {
  reset();
  const v = provider();
  v.send(validate()); v.send(validate());
  await ticks();
  assert.strictEqual(modals.length, 1);
  assert.ok(/validate/i.test(modals[0].message));
  reset();
  const r = provider();
  const request = { keys: KEYS, validateOnly: false };
  r.send({ type: 'retryDeploy', request }); r.send({ type: 'retryDeploy', request });
  await ticks();
  assert.strictEqual(modals.length, 1);
  assert.ok(guardNagged());
  assert.strictEqual(r.s.deployQueue.length, 0);
});

// ------------------------------------------- 2) the guard is scoped to a modal
/** Confirm a deploy so an op is genuinely running (sf never resolves). */
async function running(p) {
  p.send(deploy());
  await ticks();
  modals[0].resolve(confirmOf(modals[0]));
  await ticks();
  assert.strictEqual(p.s.busy, true);
  assert.strictEqual(deployCalls(p), 1);
}

check('a deploy behind a RUNNING op still queues (no modal open → no refusal)', async () => {
  reset();
  const p = provider();
  await running(p);
  p.send(deploy(['ApexClass:AcmeA']));
  await ticks();
  assert.strictEqual(modals.length, 2);
  assert.ok(modals[1].message.startsWith('Queue:'));
  assert.ok(!guardNagged(), 'the guard fired with no modal open');
  modals[1].resolve(confirmOf(modals[1]));
  await ticks();
  assert.strictEqual(p.s.deployQueue.length, 1);
});

check('a modal that throws releases the guard — later deploys are not refused as twins', async () => {
  reset();
  const p = provider();
  modalThrows = true;
  p.send(deploy());
  await ticks();
  assert.strictEqual(p.s.confirmOpen, false);
  assert.strictEqual(p.s.busy, false);
  p.send(deploy());
  await ticks();
  assert.strictEqual(modals.length, 1);
  assert.ok(!guardNagged());
});

// --------------------------------------------------- 3) the queue refuses twins
check('a twin of a queued entry is refused with a toast; a different set or mode still queues', async () => {
  reset();
  const p = provider();
  await running(p);
  const queueModal = async (msg) => {
    const before = modals.length;
    p.send(msg);
    await ticks();
    assert.strictEqual(modals.length, before + 1, 'expected a Queue: modal');
    assert.ok(modals[before].message.startsWith('Queue:'));
    modals[before].resolve(confirmOf(modals[before]));
    await ticks();
  };
  await queueModal(deploy());
  assert.strictEqual(p.s.deployQueue.length, 1);
  // The exact twin — and the same set in the other order — are refused before any modal.
  for (const keys of [KEYS, [...KEYS].reverse()]) {
    const modalsBefore = modals.length;
    toasts.length = 0;
    p.send(deploy(keys));
    await ticks();
    assert.strictEqual(modals.length, modalsBefore, 'the twin got a Queue: modal');
    assert.ok(toasts.some(t => /already queued/i.test(t)), `toasts: ${toasts.join(' | ')}`);
    assert.strictEqual(p.s.deployQueue.length, 1);
  }
  // Same keys, validate-only: a different run.
  await queueModal(validate());
  assert.strictEqual(p.s.deployQueue.length, 2);
  // A subset: a different set.
  await queueModal(deploy(['ApexClass:AcmeA']));
  assert.strictEqual(p.s.deployQueue.length, 3);
  assert.ok(!guardNagged());
  assert.deepStrictEqual(p.s.deployQueue.map(q => q.noun), ['Deploy 2 components', 'Validate 2 components', 'Deploy 1 component']);
});

// ------------------------------------------------ 4) every message is answered
check('a slot-less early return is still answered with a busy re-sync', async () => {
  reset();
  const p = provider(); // no persisted job → resumeDeploy returns before reserveBusy
  p.send({ type: 'resumeDeploy', jobId: '0Af000000000001AAA' });
  await ticks();
  assert.ok(toasts.some(t => /no longer available/.test(t)));
  assert.deepStrictEqual(p.busyPosts(), [{ busy: false, action: undefined }]);
});

check('a handler that throws before touching the slot is still answered', async () => {
  reset();
  const p = provider({ fields: { resolveKeys: () => { throw new Error('boom'); } } });
  p.send({ type: 'openFile', key: 'ApexClass:AcmeA' });
  await ticks();
  assert.deepStrictEqual(p.busyPosts(), [{ busy: false, action: undefined }]);
  assert.ok(p.cards().some(c => c.kind === 'err' && c.title === 'openFile failed'), 'reportError card missing');
});

check('a cancelled Queue: modal is answered with the running op\'s state', async () => {
  reset();
  const p = provider();
  await running(p);
  const before = p.busyPosts().length;
  p.send(deploy(['ApexClass:AcmeA']));
  await ticks();
  modals[1].resolve(undefined);
  await ticks();
  const after = p.busyPosts();
  assert.strictEqual(after.length, before + 1);
  assert.deepStrictEqual(after[after.length - 1], { busy: true, action: 'Deploy' });
  assert.strictEqual(p.s.deployQueue.length, 0);
});

// ------------------------------------------------ 5) restore / discard backup
const backupFields = () => ({
  resolveBackupDir: () => '/ws/.backups/x',
  readBackupManifest: async () => ({ dir: '/ws/.backups/x', at: 0, org: 'acme-dev', fileCount: 1 }),
  listBackupFiles: async () => ['force-app/classes/AcmeA.cls']
});

check('Restore backup… ×2: one file picker, the twin is refused as "already running", slot freed after', async () => {
  reset();
  const p = provider({ fields: backupFields() });
  p.send({ type: 'restoreBackup', dir: '/ws/.backups/x' }); p.send({ type: 'restoreBackup', dir: '/ws/.backups/x' });
  await ticks(4);
  assert.strictEqual(picks.length, 1, 'a second file picker opened');
  assert.strictEqual(p.s.busy, true);
  assert.strictEqual(p.s.currentAction, 'Restore');
  assert.ok(toasts.some(t => /Restore is already running/.test(t)), `toasts: ${toasts.join(' | ')}`);
  picks[0].resolve(undefined); // Esc
  await ticks(4);
  assert.strictEqual(p.s.busy, false);
  assert.strictEqual(picks.length, 1);
});

check('Discard backup ×2: one modal, one "Backup discarded" card, slot freed after', async () => {
  reset();
  const p = provider({ fields: backupFields() });
  p.send({ type: 'discardBackup', dir: '/ws/.backups/x' }); p.send({ type: 'discardBackup', dir: '/ws/.backups/x' });
  await ticks(4);
  assert.strictEqual(modals.length, 1, 'a second Discard modal opened');
  assert.ok(modals[0].message.startsWith('Discard this backup'));
  assert.strictEqual(p.s.currentAction, 'Discard');
  assert.ok(toasts.some(t => /Discard is already running/.test(t)));
  modals[0].resolve('Discard');
  await ticks(4);
  assert.deepStrictEqual(p.cards().map(c => c.title), ['Backup discarded']);
  assert.strictEqual(p.s.busy, false);
});

// ------------------------------------------------ 6) Rescan / ⟳ replies
check('refreshFiles is answered with filesRefreshed — after the scan, when refused mid-op, and when the scan throws', async () => {
  reset();
  let scans = 0; let release;
  const p = provider({ fields: {
    unresolvableFolders: new Set(),
    doLoadFiles: () => { scans++; return new Promise(r => { release = r; }); }
  } });
  p.send({ type: 'refreshFiles' });
  await ticks();
  assert.strictEqual(scans, 1);
  assert.strictEqual(p.replies('filesRefreshed'), 0, 'replied before the scan finished');
  release();
  await ticks(4);
  assert.strictEqual(p.replies('filesRefreshed'), 1);
  // Refused mid-op (palette-style busy refusal) — still answered.
  p.s.reserveBusy('Deploy');
  p.send({ type: 'refreshFiles' });
  await ticks(4);
  assert.strictEqual(scans, 1);
  assert.ok(toasts.some(t => /Deploy is already running/.test(t)));
  assert.strictEqual(p.replies('filesRefreshed'), 2);
  p.s.setBusy(false);
  // A scan that throws — still answered.
  p.s.doLoadFiles = () => Promise.reject(new Error('scan boom'));
  p.send({ type: 'refreshFiles' });
  await ticks(4);
  assert.strictEqual(p.replies('filesRefreshed'), 3);
});

check('refreshOrgs is answered with orgsRefreshed once per request', async () => {
  reset();
  const p = provider({ sf: { listOrgs: async () => [{ username: 'acme-dev-user', alias: 'acme-dev' }] } });
  p.send({ type: 'refreshOrgs' }); p.send({ type: 'refreshOrgs' });
  await ticks(4);
  assert.strictEqual(p.replies('orgsRefreshed'), 2);
});

// --------------------------------------------------------------- 7) source pins
check('every deploy-family modal goes through awaitConfirm, whose try/finally owns confirmOpen', () => {
  const helper = /private async awaitConfirm\([^)]*\)[^{]*\{\n\s*this\.confirmOpen = true;\n\s*try \{ return await vscode\.window\.showWarningMessage\(modal\.message, modal\.options, modal\.confirmLabel\); \}\n\s*finally \{ this\.confirmOpen = false; \}\n\s*\}/;
  assert.ok(helper.test(src), 'awaitConfirm must be exactly: confirmOpen = true; try { return await showWarningMessage(modal…) } finally { confirmOpen = false }');
  assert.strictEqual((src.match(/showWarningMessage\(modal\.message/g) || []).length, 1, 'a deploy-family modal bypasses awaitConfirm');
  assert.strictEqual((src.match(/await this\.awaitConfirm\(modal\)/g) || []).length, 3, 'runDeploy, enqueueDeploy and runManifestDeploy each confirm through awaitConfirm');
});

check('runDeploy refuses the twin BEFORE enqueueing, and the twin check sits at the push', () => {
  const guard = /if \(this\.busy && !opts\.preConfirmed\) \{(?:\n\s*\/\/[^\n]*)*\n\s*if \(this\.confirmOpen\) \{\n\s*vscode\.window\.setStatusBarMessage\('[^']*answer the open confirmation first'[^\n]*\n\s*return ABORTED;\n\s*\}\n\s*await this\.enqueueDeploy\(keys, opts\);/;
  assert.ok(guard.test(src), 'the confirmOpen refusal must precede enqueueDeploy inside the busy branch');
  const push = /if \(this\.twinQueued\(org, entryKeys, validateOnly\)\) \{ this\.notifyAlreadyQueued\(noun, orgLabel, validateOnly\); return; \}\n\s*this\.deployQueue\.push\(\{/;
  assert.ok(push.test(src), 'twinQueued must be re-checked immediately before deployQueue.push');
});

check('the message wiring re-syncs busy in a finally, thrown or not', () => {
  const wiring = /void this\.handleMessage\(m\)\n\s*\.catch\(err => this\.reportError\(m\?\.type \?\? 'panel action', err\)\)(?:\n\s*\/\/[^\n]*)*\n\s*\.finally\(\(\) => this\.postBusy\(\)\);/;
  assert.ok(wiring.test(src), "onDidReceiveMessage must be: handleMessage(m).catch(reportError).finally(() => this.postBusy())");
  const rescan = /case 'refreshFiles':(?:\n\s*\/\/[^\n]*)*\n\s*try \{ await this\.refreshFiles\(\); \} finally \{ this\.post\(\{ type: 'filesRefreshed' \}\); \}\n\s*return;/;
  assert.ok(rescan.test(src), "refreshFiles handler must be exactly: try { await this.refreshFiles(); } finally { this.post({ type: 'filesRefreshed' }); }");
});

(async () => {
  for (const [name, fn] of queue) {
    try {
      await fn();
    } catch (err) {
      failed++;
      console.error(`FAIL: ${name}\n  ${err && err.message}`);
    }
  }
  if (failed) { console.error(`double-click: ${failed} of ${queue.length} checks failed`); process.exit(1); }
  console.log(`double-click: all ${queue.length} checks passed`);
  process.exit(0); // recorded sf calls never resolve; nothing else keeps the loop alive on purpose
})();
