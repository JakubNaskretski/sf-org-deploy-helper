// Runnable contract test for the "Try with dependencies" suggestion flow
// (panelProvider.ts suggestionOpened/suggestionDeploy/suggestionDeclined/
// suggestionVerdict handlers, liveSuggestions, and the live payload merged into
// the newest run whenever the runs are posted). No framework.
//   1) npm run compile   2) node scripts/check-suggestion-flow.cjs
//
// Findings fixed here (2026-09-08):
//   B1 a hidden/rebuilt panel still gets the feature — the failed run keeps the
//      suggestion's id (never its payload), and every runs post, including the
//      one a rebuilt webview gets on `ready`, carries the payload for as long as
//      the provider still holds it;
//   B3 the expired and no-picks paths post `suggestionReset` (mirroring busy);
//   B4 an accepted suggestion's selectKeys carries `transient: true` — it must
//      never join the persisted selection;
//   B5 the retry is pinned to the CARD's org (orgOverride), not the panel's
//      current selector, and the log records the org that actually ran;
//   B6 the confirm modal discloses the auto-included count (autoIncluded);
//   B7 busy is re-checked after the writeSuggestionEntry await, so a retry can
//      never silently land in the queue.
//
// Driven through the REAL handleMessage on out/panelProvider.js (pattern:
// check-double-click.cjs) with `sf` recorded and modals captured/answered by
// hand, so each check controls exactly what the org "does" and when.
const path = require('path');
const assert = require('assert');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------- vscode stub
const modals = [];     // { message, options, items, resolve }
const statusBar = [];  // notify()'s panel-visible path
const toasts = [];     // notify()'s panel-hidden path (unused here — panel stays visible)
const vscodeStub = {
  window: {
    showWarningMessage: (message, options, ...items) => {
      if (options && options.modal) return new Promise(resolve => modals.push({ message, options, items, resolve }));
      toasts.push('WARN ' + message);
      return Promise.resolve(undefined);
    },
    showInformationMessage: (m) => { toasts.push(m); return Promise.resolve(undefined); },
    showErrorMessage: (m) => { toasts.push('ERR ' + m); return Promise.resolve(undefined); },
    setStatusBarMessage: (m) => { statusBar.push(m); return { dispose() {} }; },
    withProgress: (_o, body) => body({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) })
  },
  workspace: {
    getConfiguration: () => ({ get: (_k, d) => d, update: async () => {} })
  },
  commands: { executeCommand: async () => {} },
  Uri: { file: fsPath => ({ fsPath, scheme: 'file' }) },
  ViewColumn: { Active: -1 },
  ProgressLocation: { Notification: 15, Window: 10 },
  ConfigurationTarget: { Global: 1 },
  env: { clipboard: { writeText: async () => {} } }
};
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? vscodeStub : origLoad(req, ...rest));
const { DeployPanelProvider, autoIncludedNotice } = require(path.join(ROOT, 'out', 'panelProvider.js'));
const proto = DeployPanelProvider.prototype;

let failed = 0;
const queue = [];
const check = (name, fn) => queue.push([name, fn]);
const tick = () => new Promise(r => setImmediate(r));
const ticks = async (n = 4) => { for (let i = 0; i < n; i++) await tick(); };
function reset() { modals.length = 0; statusBar.length = 0; toasts.length = 0; }

// ---------------------------------------------------------------- fixtures
const cls = (name) => ({ type: 'ApexClass', name, filePath: `/ws/force-app/classes/${name}.cls`, files: [] });
const obj = (name) => ({ type: 'CustomObject', name, filePath: `/ws/force-app/objects/${name}`, files: [] });
const ITEMS = [cls('MyThing'), obj('smth__mdt')];
const DEV = { username: 'acme-dev-user', alias: 'acme-dev', instanceUrl: 'https://acme-dev.example.invalid' };
const UAT = { username: 'acme-uat-user', alias: 'acme-uat', instanceUrl: 'https://acme-uat.example.invalid' };

/** A provider over the real prototype. `sf.deployMetadata` never resolves by
 *  default (a modal-inspection test controls it by hand); pass extra.sf to
 *  script a completing deploy. `currentOrg` is what the panel's LIVE selector
 *  reads — deliberately independent of the org a liveSuggestions entry pins. */
function provider(extra = {}) {
  const sfCalls = [];
  const posted = [];
  const globalWrites = [];
  const never = () => { const p = new Promise(() => {}); p.cancel = () => {}; p.promise = p; return p; };
  const sf = new Proxy(extra.sf || {}, {
    get: (t, name) => t[name] || ((...args) => { sfCalls.push({ name, args }); return never(); })
  });
  let releaseGlobalUpdate;
  const gate = extra.gateGlobalUpdate ? new Promise(r => { releaseGlobalUpdate = r; }) : undefined;
  // A real, mutating store — not a fixed stub — so a SECOND writeSuggestionEntry
  // call (the later outcome/verdict patch) merges onto what the first one wrote,
  // exactly like the real workspaceState-backed suggestion log does.
  let logStore = extra.suggestionLog ? extra.suggestionLog.slice() : [];
  const kept = {}; // workspaceState, where the Status history is persisted
  const s = Object.create(proto);
  Object.assign(s, {
    busy: false, confirmOpen: false, deployQueue: [], cmdSeq: 0,
    orgMembers: new Map(), orgMembersOrg: undefined,
    items: ITEMS, workspaceRoot: '/ws',
    liveSuggestions: new Map(), suggestionSeq: 0,
    testLevel: undefined, runTests: undefined,
    orgs: [DEV, UAT],
    orgStore: { get: () => extra.currentOrg ?? DEV.username, set: async () => {}, setFromUserPick: async () => {} },
    output: { appendLine: () => {} },
    context: {
      workspaceState: { get: (k) => kept[k], update: async (k, v) => { kept[k] = v === undefined ? undefined : JSON.parse(JSON.stringify(v)); } },
      globalState: {
        get: () => logStore,
        update: (_k, v) => {
          globalWrites.push(v);
          logStore = v;
          // Only the FIRST write is gated (the 'accepted' entry) — every later
          // write in the same test resolves immediately, matching the real
          // sequence of one gated await followed by ordinary ones.
          if (gate && globalWrites.length === 1) return gate.then(() => undefined);
          return Promise.resolve();
        }
      }
    },
    // No `post` override here — the REAL prototype method runs (pushCardHistory
    // included), so its persisted-history side effects
    // are genuinely exercised. Captured one layer down, at the webview boundary.
    view: { visible: true, webview: { postMessage: (m) => posted.push(m) } },
    // 'ready'-only stubs — no-ops so handleMessage({type:'ready'}) can run without
    // pulling in the whole scan/org-fetch subsystem (unrelated to this feature).
    loadFiles: async () => {}, loadOrgs: async () => {},
    maybeReattachDeploy: () => {}, maybeAutoFetchOrg: () => {},
    sf,
    ...(extra.fields || {})
  });
  const send = (m) => s.handleMessage(m)
    .catch(err => s.reportError(m?.type ?? 'panel action', err))
    .finally(() => s.postBusy());
  const suggestionLogEntries = () => logStore;
  return { s, sfCalls, posted, globalWrites, kept, send, releaseGlobalUpdate: () => releaseGlobalUpdate && releaseGlobalUpdate(), suggestionLogEntries };
}

/** Populate liveSuggestions the way a real failed deploy would — through the
 *  REAL reportDeployResult, so the run's `suggest` and the map entry are exactly
 *  what production builds. `org`/`orgLabel` are the ORIGINAL failure's org
 *  (independent of `currentOrg` on the returned provider). */
function seedSuggestion(p, { org = UAT.username, orgLabel = UAT.alias, retryKeys = ['ApexClass:MyThing'] } = {}) {
  const retry = { keys: retryKeys, sourceDir: undefined, validateOnly: false, testLevel: 'NoTestRun', runTests: undefined };
  proto.reportDeployResult.call(p.s, {
    success: false, status: 'Failed', errorMessage: 'Invalid type: smth__mdt'
  }, {
    items: retryKeys.map(k => cls(k.split(':')[1])), orgOnlySkipped: [], orgLabel, org,
    noun: `${retryKeys.length} component`, cmdId: 'c1', start: Date.now(), validateOnly: false, retry
  });
  const run = lastRunsPost(p).runs[0];
  assert.ok(run.suggest, 'seedSuggestion: no suggestion candidate resolved — fixture is broken');
  return { id: run.suggest.id, run };
}
/** The last `runs` post: the history as the webview has it. */
const lastRunsPost = (p) => p.posted.filter(m => m.type === 'runs').slice(-1)[0];
const suggestResets = (p) => p.posted.filter(m => m.type === 'suggestionReset');
const deployCalls = (p) => p.sfCalls.filter(c => c.name === 'deployMetadata');
const confirmOf = (m) => m.items[0];

// =================================================================== B3
check('expired suggestion (unknown id): reset posted, nothing else happens', async () => {
  reset();
  const p = provider();
  p.send({ type: 'suggestionDeploy', id: 'sug-unknown-0', keys: ['CustomObject:smth__mdt'] });
  await ticks();
  assert.strictEqual(suggestResets(p).length, 1);
  assert.strictEqual(suggestResets(p)[0].id, 'sug-unknown-0');
  assert.strictEqual(modals.length, 0);
  assert.strictEqual(deployCalls(p).length, 0);
});

check('no picks selected: reset posted, nothing runs', async () => {
  reset();
  const p = provider();
  const { id } = seedSuggestion(p);
  p.send({ type: 'suggestionDeploy', id, keys: [] });
  await ticks();
  assert.strictEqual(suggestResets(p).filter(m => m.id === id).length, 1);
  assert.strictEqual(modals.length, 0);
  assert.strictEqual(deployCalls(p).length, 0);
});

check('every picked key is filtered against the server-side candidate list — a forged key resets too if nothing survives', async () => {
  reset();
  const p = provider();
  const { id } = seedSuggestion(p);
  p.send({ type: 'suggestionDeploy', id, keys: ['ApexClass:NotOffered'] });
  await ticks();
  assert.strictEqual(suggestResets(p).filter(m => m.id === id).length, 1);
  assert.strictEqual(modals.length, 0);
});

// =================================================================== B7
check('busy-after-await: writeSuggestionEntry\'s await lets another op grab the slot — the retry is refused, reset, and nothing is queued', async () => {
  reset();
  const p = provider({ gateGlobalUpdate: true });
  const { id } = seedSuggestion(p);
  p.send({ type: 'suggestionDeploy', id, keys: ['CustomObject:smth__mdt'] });
  await ticks();
  // Still inside the gated 'accepted' write — nothing has run yet.
  assert.strictEqual(modals.length, 0);
  // Another operation grabs the slot in this exact window.
  p.s.busy = true;
  p.releaseGlobalUpdate();
  await ticks();
  assert.strictEqual(modals.length, 0, 'the retry proceeded to a confirm modal despite busy');
  assert.strictEqual(deployCalls(p).length, 0);
  assert.strictEqual(p.s.deployQueue.length, 0, 'a refused retry must not land in the queue either');
  assert.strictEqual(suggestResets(p).filter(m => m.id === id).length, 1);
  const entries = p.suggestionLogEntries();
  const entry = entries.find(e => e.action === 'accepted');
  assert.strictEqual(entry.outcome, 'aborted', 'the log must say the retry never ran');
});

check('busy BEFORE the click at all (no race — the plain top-of-handler guard) still refuses and resets', async () => {
  reset();
  const p = provider();
  const { id } = seedSuggestion(p);
  p.s.busy = true;
  p.send({ type: 'suggestionDeploy', id, keys: ['CustomObject:smth__mdt'] });
  await ticks();
  assert.strictEqual(modals.length, 0);
  assert.strictEqual(suggestResets(p).filter(m => m.id === id).length, 1);
});

// =================================================================== B4
check('accepting posts selectKeys with transient:true — scroll/reveal only, never persisted', async () => {
  reset();
  const p = provider();
  const { id } = seedSuggestion(p);
  p.send({ type: 'suggestionDeploy', id, keys: ['CustomObject:smth__mdt'] });
  await ticks();
  const sel = p.posted.find(m => m.type === 'selectKeys');
  assert.ok(sel, 'no selectKeys posted');
  assert.deepStrictEqual(sel.keys, ['CustomObject:smth__mdt']);
  assert.strictEqual(sel.scroll, true);
  assert.strictEqual(sel.transient, true, 'the acceptance must be marked transient (B4)');
  assert.strictEqual(sel.replace, undefined, 'transient is not replace — the two flags are independent');
});

// =================================================================== B5 + B6
check('orgOverride pins the retry to the failed run\'s org, even when the live selector has moved on; the modal names it; the log records it', async () => {
  reset();
  // The failure happened on acme-uat; the panel's current selector has since
  // moved to acme-dev — the bug this fixes sent the retry to acme-dev anyway.
  const p = provider({ currentOrg: DEV.username });
  const { id } = seedSuggestion(p, { org: UAT.username, orgLabel: UAT.alias });
  p.send({ type: 'suggestionDeploy', id, keys: ['CustomObject:smth__mdt'] });
  await ticks();
  assert.strictEqual(modals.length, 1, 'expected exactly one confirm modal');
  const modal = modals[0];
  assert.ok(modal.message.includes(UAT.alias), `modal must name the failed run's org (${UAT.alias}): ${modal.message}`);
  assert.ok(!modal.message.includes(DEV.alias), `modal must NOT name the live selector's org: ${modal.message}`);
  // B6: the confirm modal discloses the auto-included count.
  const detail = modal.options.detail || '';
  assert.ok(detail.includes(autoIncludedNotice({ count: 1, entryKey: 'ApexClass:MyThing' })), detail);
  modal.resolve(confirmOf(modal));
  await ticks();
  assert.strictEqual(deployCalls(p).length, 1);
  assert.strictEqual(deployCalls(p)[0].args[1], UAT.username, 'the deploy must target the failed run\'s org, not the live selector');
  const entries = p.suggestionLogEntries();
  const accepted = entries.find(e => e.action === 'accepted');
  assert.strictEqual(accepted.org, UAT.alias, 'the log must name the org that actually ran, not the live selector');
});

check('a suggestion accepted while the selector already agrees still targets the failed run\'s org (no regression on the common case)', async () => {
  reset();
  const p = provider({ currentOrg: DEV.username });
  const { id } = seedSuggestion(p, { org: DEV.username, orgLabel: DEV.alias });
  p.send({ type: 'suggestionDeploy', id, keys: ['CustomObject:smth__mdt'] });
  await ticks();
  modals[0].resolve(confirmOf(modals[0]));
  await ticks();
  assert.strictEqual(deployCalls(p)[0].args[1], DEV.username);
});

// ------------------------------------------------ end-to-end: outcome + log
check('a completed retry deletes the live suggestion and logs the resolved org and outcome', async () => {
  reset();
  const sf = {
    deployMetadata: (metadata, targetOrg) => ({
      cancel: () => undefined,
      promise: Promise.resolve({ result: { id: 'JOB1' }, cmd: 'sf project deploy start --json' })
    }),
    deployReport: () => ({
      cancel: () => undefined,
      promise: Promise.resolve({ result: { id: 'JOB1', status: 'Succeeded', success: true, done: true } })
    })
  };
  const p = provider({ currentOrg: DEV.username, sf });
  const { id } = seedSuggestion(p, { org: UAT.username, orgLabel: UAT.alias });
  p.send({ type: 'suggestionDeploy', id, keys: ['CustomObject:smth__mdt'] });
  await ticks();
  modals[0].resolve(confirmOf(modals[0]));
  await ticks(10);
  assert.strictEqual(p.s.liveSuggestions.has(id), false, 'a terminal outcome must consume the live suggestion');
  const entries = p.suggestionLogEntries();
  const entry = entries.find(e => e.action === 'accepted');
  assert.strictEqual(entry.outcome, 'worked');
  assert.strictEqual(entry.org, UAT.alias);
});

check('a dismissed confirm modal keeps the suggestion alive and resets the run\'s suggestion view', async () => {
  reset();
  const p = provider();
  const { id } = seedSuggestion(p);
  p.send({ type: 'suggestionDeploy', id, keys: ['CustomObject:smth__mdt'] });
  await ticks();
  modals[0].resolve(undefined); // Cancel
  await ticks();
  assert.strictEqual(p.s.liveSuggestions.has(id), true, 'a dismissed confirm must not consume the suggestion');
  assert.strictEqual(suggestResets(p).filter(m => m.id === id).length, 1);
  const entries = p.suggestionLogEntries();
  assert.strictEqual(entries.find(e => e.action === 'accepted').outcome, 'aborted');
});

// =================================================================== eviction
check('a 10-entry cap evicts the OLDEST liveSuggestions entry (first-in-first-out)', () => {
  reset();
  const p = provider();
  const ids = [];
  for (let i = 0; i < 11; i++) {
    const id = `sug-${1000 + i}-0`;
    ids.push(id);
    p.s.rememberSuggestion(id, {
      candidates: [{ key: 'CustomObject:smth__mdt' }], unresolved: [], retry: { keys: ['ApexClass:MyThing'] },
      orgLabel: UAT.alias, org: UAT.username
    });
  }
  assert.strictEqual(p.s.liveSuggestions.size, 10);
  assert.strictEqual(p.s.liveSuggestions.has(ids[0]), false, 'the oldest entry must be evicted');
  for (const id of ids.slice(1)) assert.strictEqual(p.s.liveSuggestions.has(id), true, `${id} should still be live`);
});

// =================================================================== B1(a)
check('a hidden/rebuilt panel: the kept run carries the suggestion\'s id, never its payload, and the org\'s own words', () => {
  reset();
  const p = provider();
  const { id } = seedSuggestion(p);
  const kept = p.kept.statusRuns.runs[0];
  assert.strictEqual(kept.suggest, undefined, 'the live payload must never be persisted');
  assert.strictEqual(kept.suggestId, id, 'the id must survive so a later post can bring the payload back');
  assert.ok((kept.message || '').includes('Invalid type: smth__mdt'), `the org's message must survive: ${JSON.stringify(kept.message)}`);
  assert.ok(!(kept.notes || []).some(n => n.includes('Missing but available locally')),
    'with a live suggestion the guidance is the suggestion itself, not a note');
});

check('without a suggestion view to carry it, the diagnosis is kept as the run\'s notes', () => {
  reset();
  const p = provider();
  // A sourceDir-pinned retry can't be extended automatically: no suggestion,
  // so the diagnosis must still reach the user.
  proto.reportDeployResult.call(p.s, { success: false, status: 'Failed', errorMessage: 'Invalid type: smth__mdt' }, {
    items: [cls('MyThing')], orgOnlySkipped: [], orgLabel: UAT.alias, org: UAT.username,
    noun: '1 component', cmdId: 'c1', start: Date.now(), validateOnly: false,
    retry: { keys: ['ApexClass:MyThing'], sourceDir: '/ws/force-app/classes', validateOnly: false, testLevel: 'NoTestRun' }
  });
  const run = lastRunsPost(p).runs[0];
  assert.strictEqual(run.suggest, undefined);
  assert.ok((run.notes || []).some(n => n.startsWith('Missing but available locally: CustomObject:smth__mdt')), JSON.stringify(run.notes));
  assert.ok((p.kept.statusRuns.runs[0].notes || []).length > 0, 'the notes are kept across a reload');
});

// =================================================================== B1(b)
check('ready: the newest run comes back with its live suggestion (after the notices)', async () => {
  reset();
  const p = provider();
  const { id, run } = seedSuggestion(p);
  // Simulate the rebuild: a fresh webview gets the history replayed.
  p.posted.length = 0;
  p.send({ type: 'ready' });
  await ticks();
  const runsIdx = p.posted.findIndex(m => m.type === 'runs');
  assert.ok(runsIdx >= 0, 'expected a runs replay');
  const historyIdx = p.posted.findIndex(m => m.type === 'statusHistory');
  if (historyIdx >= 0) assert.ok(runsIdx > historyIdx, 'the runs follow the notices');
  const back = p.posted[runsIdx].runs[0];
  assert.strictEqual(back.suggest.id, id);
  assert.deepStrictEqual(back.suggest.candidates, run.suggest.candidates);
  assert.deepStrictEqual(back.suggest.unresolved, run.suggest.unresolved);
  assert.ok(!p.posted.some(m => m.type === 'suggestionRestore'), 'the old restore message is retired');
});

check('ready: a consumed (deleted) suggestion never comes back', async () => {
  reset();
  const p = provider();
  const { id } = seedSuggestion(p);
  p.s.liveSuggestions.delete(id);
  p.posted.length = 0;
  p.send({ type: 'ready' });
  await ticks();
  const back = p.posted.find(m => m.type === 'runs').runs[0];
  assert.strictEqual(back.suggestId, id, 'the run still names it');
  assert.strictEqual(back.suggest, undefined, 'but the provider no longer offers it');
});

// =================================================================== B3 (declined/verdict untouched)
check('suggestionDeclined and suggestionVerdict still work exactly as before (no reset needed — nothing to undo)', async () => {
  reset();
  const p = provider();
  const { id } = seedSuggestion(p);
  p.send({ type: 'suggestionDeclined', id });
  await ticks();
  let entries = p.suggestionLogEntries();
  assert.strictEqual(entries.find(e => e.id === id).action, 'declined');
  p.send({ type: 'suggestionVerdict', id, bad: true });
  await ticks();
  entries = p.suggestionLogEntries();
  assert.strictEqual(entries.find(e => e.id === id).verdict, 'bad');
  assert.strictEqual(suggestResets(p).length, 0, 'decline/verdict never needed a reset');
});

(async () => {
  for (const [name, fn] of queue) {
    try {
      await fn();
    } catch (err) {
      failed++;
      console.error(`FAIL: ${name}\n  ${err && err.stack ? err.stack : err}`);
    }
  }
  if (failed) { console.error(`suggestion-flow: ${failed} of ${queue.length} checks failed`); process.exit(1); }
  console.log(`suggestion-flow: all ${queue.length} checks passed`);
  process.exit(0); // recorded sf calls never resolve by default; nothing else keeps the loop alive
})();
