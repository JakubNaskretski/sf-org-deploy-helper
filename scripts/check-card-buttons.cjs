// Runnable contract test for the buttons of the Status pane: which messages a
// button may post, and where buttons may live at all.
//   1) npm run compile   2) node scripts/check-card-buttons.cjs
//
// Status cards are kept across reloads, and a kept card used to replay whatever
// buttons it carried — a Retry re-sending a request months old, a button for a
// feature since removed ("Retry + changed vs branch", 0.15.1). Now the actions of
// a deploy, validation or retrieve live on the newest RUN alone, and a kept card
// is a notice: a record with no buttons.
//
// Pinned here:
//   1. The wiring, through the real pushCardHistory/cardHistory: a kept card
//      carries NO button at all, and a card persisted by an older version heals
//      on restore, not only on write; the live card keeps its own.
//   2. Drift: every message a run card can post — runView.actionsFor's buttons
//      and the webview's own sends from the run card (suggestion view, Copy,
//      file links, Select) — has a `case` in the provider's handleMessage, so a
//      button can never promise an action nothing performs.
//   3. isConflictFailure (Feature: conflict-blocked deploy retry) — what counts
//      as a client-side conflict failure: bounded, never a generic "conflict"
//      substring. It decides whether the run offers "Retry + overwrite"
//      (runView.actionsFor, pinned in check-run-view.cjs).
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Module = require('module');

const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? {
  window: { showInformationMessage: () => Promise.resolve(undefined) },
  workspace: { getConfiguration: () => ({ get: (_k, f) => f }) },
  commands: { executeCommand: () => Promise.resolve(undefined) },
  Uri: { file: (fsPath) => ({ fsPath }) }
} : origLoad(req, ...rest));

const { DeployPanelProvider, isConflictFailure } = require(path.join(__dirname, '..', 'out', 'panelProvider.js'));
// Same module the compiled panelProvider.js itself requires (by resolved path,
// so `instanceof` below sees the identical class), used only to build realistic
// SfCliError fixtures for isConflictFailure.
const { SfCliError } = require(path.join(__dirname, '..', 'out', 'sfCliService.js'));

let failed = 0;
const queue = [];
function check(name, fn) { queue.push([name, fn]); }

const btn = (type, extra = {}) => ({ label: type, send: { type, ...extra } });
const RETRY = { keys: ['ApexClass:OrderService'], validateOnly: false, testLevel: 'NoTestRun' };

// ------------------------------------------------------------- the real wiring
const HISTORY_KEY = 'statusCardHistory';
function providerWith(stored) {
  const state = { [HISTORY_KEY]: stored };
  return Object.assign(Object.create(DeployPanelProvider.prototype), {
    context: {
      workspaceState: {
        get: (key, fallback) => (key in state ? state[key] : fallback),
        update: (key, value) => { state[key] = value; return Promise.resolve(); }
      }
    },
    output: { appendLine: () => {} },
    _state: state
  });
}
const readHistory = (prov) => DeployPanelProvider.prototype.cardHistory.call(prov);
const pushHistory = (prov, card) => DeployPanelProvider.prototype.pushCardHistory.call(prov, card);

check('a card persisted while the feature existed heals on RESTORE — every button goes', () => {
  // The reported bug: this entry was written by 0.15.0 and is still in the store.
  const prov = providerWith([
    { kind: 'err', title: 'Deploy failed against acme-dev', buttons: [btn('retryDeploy'), btn('retryDeployChanged')] }
  ]);
  const restored = readHistory(prov);
  assert.ok(!('buttons' in restored[0]), JSON.stringify(restored[0]));
  assert.strictEqual(restored[0].title, 'Deploy failed against acme-dev', 'the record itself survives');
});

check('the healed history is what gets written back on the next push', () => {
  const prov = providerWith([{ kind: 'err', buttons: [btn('retryDeployChanged')] }]);
  pushHistory(prov, { kind: 'ok', title: 'Deployed 1 component' });
  const persisted = prov._state[HISTORY_KEY];
  assert.strictEqual(persisted.length, 2);
  assert.ok(!('buttons' in persisted[1]), JSON.stringify(persisted[1]));
});

check('a restored notice carries no button, even one the provider still routes — actions live on the newest run', () => {
  const prov = providerWith([
    { kind: 'err', buttons: [btn('retryDeploy')] },
    { kind: 'warn', buttons: [btn('resumeDeploy', { jobId: '0Af' })] },
    { kind: 'ok', buttons: [btn('restoreBackup', { dir: '/b' }), btn('discardBackup', { dir: '/b' })] },
    { kind: 'ok', buttons: [btn('selectDeployed', { keys: ['ApexClass:A'] })] }
  ]);
  const restored = readHistory(prov);
  assert.strictEqual(restored.length, 4);
  assert.ok(restored.every(c => !('buttons' in c)), JSON.stringify(restored));
});

check('a pushed card is kept without any of its buttons — the removed one, an oversized one, a plain Retry', () => {
  const prov = providerWith([]);
  pushHistory(prov, {
    kind: 'ok',
    buttons: [
      btn('retryDeployChanged'),
      btn('selectDeployed', { keys: Array.from({ length: 101 }, (_, i) => `ApexClass:A${i}`) }),
      btn('retryDeploy')
    ]
  });
  assert.ok(!('buttons' in prov._state[HISTORY_KEY][0]), JSON.stringify(prov._state[HISTORY_KEY][0]));
});

check('quickDeploy is still stripped, and the live card keeps everything', () => {
  const prov = providerWith([]);
  const live = { kind: 'ok', quickDeploy: { jobId: '0Af' }, buttons: [btn('retryDeploy'), btn('retryDeployChanged')] };
  pushHistory(prov, live);
  assert.ok(!('quickDeploy' in prov._state[HISTORY_KEY][0]));
  assert.strictEqual(live.buttons.length, 2, 'the live card was mutated');
  assert.ok(live.quickDeploy, 'the live card was mutated');
});

check('a corrupted stored history still degrades to empty, not a throw', () => {
  assert.deepStrictEqual(readHistory(providerWith('nonsense')), []);
  assert.deepStrictEqual(readHistory(providerWith([null, 7, { kind: 'ok' }])), [{ kind: 'ok' }]);
});

// ============================================================== drift check
const SRC = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
/** Message types in `type: '…'` literals inside `text` (comments dropped first,
 *  so a doc comment spelling a message is never read as code). */
function messageTypes(text) {
  const code = text.split('\n').filter(l => !/^\s*(\/\/|\/?\*)/.test(l)).join('\n');
  const out = new Set();
  const re = /type:\s*'([A-Za-z]+)'/g;
  let m;
  while ((m = re.exec(code))) out.add(m[1]);
  return out;
}
/** The webview's run-card sends: send('x', …) / sendAction('x', …) from the
 *  suggestion view the run card shares and the run-card code itself. */
function runCardSends() {
  const panel = SRC('panel.js');
  const from = panel.indexOf('function renderSuggestAfter(');
  const to = panel.indexOf('function renderCmdLog(');
  assert.ok(from > 0 && to > from && panel.indexOf('// ---- Run cards ----') > from, 'the run-card code moved — this check no longer sees it');
  const section = panel.slice(from, to);
  const out = new Set();
  const re = /send(?:Action)?\('([A-Za-z]+)'/g;
  let m;
  while ((m = re.exec(section))) out.add(m[1]);
  return out;
}

check('every message a run card can post has a handler in the provider', () => {
  const actions = SRC('runView.js');
  const fromActions = messageTypes(actions.slice(actions.indexOf('function actionsFor('), actions.indexOf('// ---- copy ----')));
  const fromPanel = runCardSends();
  for (const t of ['retryDeploy', 'quickDeploy', 'resumeDeploy', 'restoreBackup', 'discardBackup', 'selectDeployed']) {
    assert.ok(fromActions.has(t), `actionsFor no longer posts ${t} — this list is out of date`);
  }
  for (const t of ['copyText', 'openFile', 'suggestionOpened', 'suggestionDeploy', 'suggestionDeclined', 'suggestionVerdict']) {
    assert.ok(fromPanel.has(t), `the run card no longer sends ${t} — this list is out of date`);
  }
  const provider = SRC('panelProvider.ts');
  const handled = new Set([...provider.matchAll(/case '([A-Za-z]+)':/g)].map(m => m[1]));
  for (const t of [...fromActions, ...fromPanel]) {
    assert.ok(handled.has(t), `a run-card button posts '${t}', which handleMessage has no case for`);
  }
});

check('no card is built with buttons for the deploy family any more — its actions are the run\'s', () => {
  const provider = SRC('panelProvider.ts').split('\n').filter(l => !/^\s*(\/\/|\/?\*)/.test(l)).join('\n');
  for (const t of ['retryDeploy', 'selectDeployed', 'quickDeploy']) {
    assert.ok(!new RegExp(`send:\\s*\\{\\s*type:\\s*'${t}'`).test(provider), `a card still carries a ${t} button`);
  }
});

// ======================================================== isConflictFailure
// "Retry + overwrite" (Feature: conflict-blocked deploy retry) offers a
// destructive re-run — it must fire ONLY for the CLI's own client-side
// source-conflict check, never for a generic failure that happens to mention
// the word "conflict" in an unrelated sense.
const CONFLICT_ERROR = () => { const e = new SfCliError('SourceConflictError: 3 conflicts detected'); e.errorName = 'SourceConflictError'; return e; };

check('positive: errorName alone is enough, regardless of message wording', () => {
  const e = new SfCliError('Deploy failed for an unrelated reason');
  e.errorName = 'SourceConflictError';
  assert.strictEqual(isConflictFailure(e), true);
});

check('positive: the CLI\'s own submit-time error (name + message)', () => {
  assert.strictEqual(isConflictFailure(CONFLICT_ERROR()), true);
});

check('positive: message-only fallback, both bounded phrases, case-insensitive', () => {
  assert.strictEqual(isConflictFailure(new SfCliError('1 conflict detected on ApexClass:OrderService')), true);
  assert.strictEqual(isConflictFailure(new SfCliError('CONFLICTS DETECTED — aborting')), true);
  assert.strictEqual(isConflictFailure(new SfCliError('Source Conflict Error: see below')), true);
  assert.strictEqual(isConflictFailure(new Error('source conflict on 2 components')), true);
});

check('positive: a terminal DeployResult carries the same wording in errorMessage', () => {
  assert.strictEqual(isConflictFailure({ success: false, status: 'Failed', errorMessage: '2 conflicts detected' }), true);
});

check('negative: a bare "conflict" substring never matches — the phrase must be bounded', () => {
  // A real, unrelated failure can legitimately use the word "conflict" without
  // being the CLI's source-tracking check (a naming/permission-set conflict,
  // for instance) — a loose substring match would offer overwrite for it.
  assert.strictEqual(isConflictFailure(new SfCliError('Field naming conflict on Account.Name__c')), false);
  assert.strictEqual(isConflictFailure({ errorMessage: 'Merge conflict markers found in file' }), false);
});

check('negative: an unrelated deploy failure', () => {
  assert.strictEqual(isConflictFailure(new SfCliError('Invalid type: Foo__mdt')), false);
  assert.strictEqual(isConflictFailure({ success: false, status: 'Failed', errorMessage: 'Invalid type: Foo__mdt' }), false);
});

check('negative: errorName set to something else entirely', () => {
  const e = new SfCliError('some message');
  e.errorName = 'NamedOrgNotFound';
  assert.strictEqual(isConflictFailure(e), false);
});

check('negative: nothing to read at all', () => {
  for (const v of [undefined, null, 7, 'plain string', {}, [], { errorMessage: 42 }]) {
    assert.strictEqual(isConflictFailure(v), false, `unexpected match: ${JSON.stringify(v)}`);
  }
});

check('bounded: a 10k-char hostile message without the phrase never matches (and returns fast)', () => {
  const hostile = 'x'.repeat(10_000);
  const start = Date.now();
  assert.strictEqual(isConflictFailure(new SfCliError(hostile)), false);
  assert.strictEqual(isConflictFailure({ errorMessage: hostile }), false);
  assert.ok(Date.now() - start < 500, 'isConflictFailure must not be a ReDoS surface');
});

check('bounded: the phrase is still found buried inside a 10k-char message', () => {
  // Proves the check reads the whole string rather than only a truncated prefix.
  const buried = `${'x'.repeat(9_000)} 4 conflicts detected ${'y'.repeat(900)}`;
  assert.strictEqual(isConflictFailure(new SfCliError(buried)), true);
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
  }
  if (failed) { console.error(`\n${failed} of ${queue.length} check(s) failed`); process.exit(1); }
  console.log(`card-buttons: all ${queue.length} checks passed`);
})();
