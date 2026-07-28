// Runnable contract test for card buttons that outlive their feature.
//   1) npm run compile   2) node scripts/check-card-buttons.cjs
//
// Status cards are durable history: they are persisted to workspaceState and
// replayed into every rebuilt webview, so a card written months ago still renders
// whatever buttons it carried. "Retry + changed vs branch" was removed in 0.15.1
// on user feedback, but pushCardHistory only ever stripped `quickDeploy` and
// oversized key lists — so cards persisted while the feature existed kept
// advertising it, and the user kept seeing a button for something that no longer
// exists.
//
// Pinned here:
//   1. pruneCardButtons — the rule itself, including that it drops the button but
//      leaves everything else about the card untouched.
//   2. The allow-list is what the provider EMITS, not what it can route. The
//      retryDeployChanged HANDLER deliberately survives (persisted cards, and it
//      may return in some form); the BUTTON must not.
//   3. Drift: the list is re-derived from the `send: { type: '…' }` literals in
//      panelProvider.ts and compared, so deleting the next feature's
//      button-builder fails this check until the entry goes too.
//   4. The wiring, through the real pushCardHistory/cardHistory: a card persisted
//      by an older version heals on restore, not only on write.
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

const { DeployPanelProvider, pruneCardButtons, SUPPORTED_CARD_BUTTON_SENDS } =
  require(path.join(__dirname, '..', 'out', 'panelProvider.js'));

let failed = 0;
const queue = [];
function check(name, fn) { queue.push([name, fn]); }

const btn = (type, extra = {}) => ({ label: type, send: { type, ...extra } });

// ------------------------------------------------------------ the rule itself
check('the removed feature\'s button is dropped, the retry beside it survives', () => {
  const card = { kind: 'err', title: 'Deploy failed', buttons: [btn('retryDeploy'), btn('retryDeployChanged')] };
  const out = pruneCardButtons(card);
  assert.deepStrictEqual(out.buttons.map(b => b.send.type), ['retryDeploy']);
});

check('every button the provider still emits survives a prune', () => {
  const types = ['retryDeploy', 'resumeDeploy', 'restoreBackup', 'discardBackup', 'selectDeployed'];
  const card = { buttons: types.map(t => btn(t)) };
  assert.strictEqual(pruneCardButtons(card), card, 'a clean card should not be rebuilt');
  assert.deepStrictEqual(pruneCardButtons(card).buttons.map(b => b.send.type), types);
});

check('nothing else about the card is touched', () => {
  const card = {
    kind: 'err', title: 'Deploy failed', meta: '2 failures', lines: ['a', 'b'], at: 123,
    buttons: [btn('retryDeployChanged'), btn('selectDeployed', { keys: ['ApexClass:A'] })]
  };
  const out = pruneCardButtons(card);
  assert.deepStrictEqual(
    { ...out, buttons: undefined },
    { kind: 'err', title: 'Deploy failed', meta: '2 failures', lines: ['a', 'b'], at: 123, buttons: undefined }
  );
  assert.deepStrictEqual(out.buttons[0].send.keys, ['ApexClass:A'], 'the surviving button lost its payload');
});

check('a card left with no buttons drops the key rather than keeping an empty array', () => {
  const out = pruneCardButtons({ kind: 'err', buttons: [btn('retryDeployChanged')] });
  assert.ok(!('buttons' in out), JSON.stringify(out));
});

check('the input card is never mutated — the live copy keeps its own buttons', () => {
  const card = { buttons: [btn('retryDeployChanged')] };
  pruneCardButtons(card);
  assert.strictEqual(card.buttons.length, 1);
});

check('a malformed button is dropped too — it could never have posted anything', () => {
  for (const bad of [{ label: 'x' }, { label: 'x', send: null }, { label: 'x', send: { type: 7 } }, null]) {
    const out = pruneCardButtons({ buttons: [bad] });
    assert.ok(!('buttons' in out), JSON.stringify(bad));
  }
});

check('a card with no buttons, or a corrupted buttons value, passes straight through', () => {
  for (const card of [{ kind: 'ok' }, { kind: 'ok', buttons: 'nope' }, { kind: 'ok', buttons: null }]) {
    assert.strictEqual(pruneCardButtons(card), card);
  }
});

// -------------------------------------------------- emitted, not merely routed
check('retryDeployChanged is excluded even though the provider still routes it', () => {
  assert.ok(!SUPPORTED_CARD_BUTTON_SENDS.has('retryDeployChanged'));
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'panelProvider.ts'), 'utf8');
  assert.ok(src.includes("case 'retryDeployChanged'"),
    'the handler was removed — then the allow-list is no longer making the distinction this check is about');
});

check('the allow-list matches the send types the provider actually emits', () => {
  // Comment lines are dropped first: a doc comment that SPELLS the button shape
  // (this rule is documented next to the list it guards) would otherwise read as
  // an emitted button.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'panelProvider.ts'), 'utf8')
    .split('\n').filter(l => !/^\s*(\/\/|\/?\*)/.test(l)).join('\n');
  const emitted = new Set();
  const re = /send:\s*\{\s*type:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src))) emitted.add(m[1]);
  assert.ok(emitted.size > 0, 'the card-button literals moved — this check no longer sees anything');
  assert.deepStrictEqual([...SUPPORTED_CARD_BUTTON_SENDS].sort(), [...emitted].sort(),
    'a card button naming an unemitted message is dead weight; drop it from the list (or add the new one)');
});

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

check('a card persisted while the feature existed heals on RESTORE', () => {
  // The reported bug: this entry was written by 0.15.0 and is still in the store.
  const prov = providerWith([
    { kind: 'err', title: 'Deploy failed against acme-dev', buttons: [btn('retryDeploy'), btn('retryDeployChanged')] }
  ]);
  const restored = readHistory(prov);
  assert.deepStrictEqual(restored[0].buttons.map(b => b.send.type), ['retryDeploy']);
});

check('the healed history is what gets written back on the next push', () => {
  const prov = providerWith([{ kind: 'err', buttons: [btn('retryDeployChanged')] }]);
  pushHistory(prov, { kind: 'ok', title: 'Deployed 1 component' });
  const persisted = prov._state[HISTORY_KEY];
  assert.strictEqual(persisted.length, 2);
  assert.ok(!('buttons' in persisted[1]), JSON.stringify(persisted[1]));
});

check('the legitimate persisted buttons all still survive a reload', () => {
  const prov = providerWith([
    { kind: 'err', buttons: [btn('retryDeploy')] },
    { kind: 'warn', buttons: [btn('resumeDeploy', { jobId: '0Af' })] },
    { kind: 'ok', buttons: [btn('restoreBackup', { dir: '/b' }), btn('discardBackup', { dir: '/b' })] },
    { kind: 'ok', buttons: [btn('selectDeployed', { keys: ['ApexClass:A'] })] }
  ]);
  assert.deepStrictEqual(readHistory(prov).map(c => c.buttons.map(b => b.send.type)), [
    ['retryDeploy'], ['resumeDeploy'], ['restoreBackup', 'discardBackup'], ['selectDeployed']
  ]);
});

check('both persistence rules apply — an unsupported button and an oversized one', () => {
  const prov = providerWith([]);
  pushHistory(prov, {
    kind: 'ok',
    buttons: [
      btn('retryDeployChanged'),
      btn('selectDeployed', { keys: Array.from({ length: 101 }, (_, i) => `ApexClass:A${i}`) }),
      btn('retryDeploy')
    ]
  });
  assert.deepStrictEqual(prov._state[HISTORY_KEY][0].buttons.map(b => b.send.type), ['retryDeploy']);
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

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
  }
  if (failed) { console.error(`\n${failed} of ${queue.length} check(s) failed`); process.exit(1); }
  console.log(`card-buttons: all ${queue.length} checks passed`);
})();
