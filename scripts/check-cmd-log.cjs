// Runnable contract test: the panel's command log survives a webview rebuild
// (panelProvider.ts beginCmd/updateCmd/endCmd → postCmd, and the `ready` replay).
//   1) npm run compile   2) node scripts/check-cmd-log.cjs
//
// The bug: begin/update/end only POSTED `{type:'cmd', entry}` and kept nothing, so
// a rebuilt webview (the view moved between the sidebar and the panel area; the
// sidebar itself is retained when collapsed) came back with an empty log — while
// the Status pane beside it replayed its whole history. A window reload restarts
// the extension host too, so the log starts over there by design. Worse, a command
// still running across the rebuild finished into the fresh webview as an END entry,
// which deliberately carries no `command` text (so a completion can't wipe the text
// of the entry it merges into): with nothing to merge onto, the webview unshifted it
// as a row with a blank command and a duration.
//
// The fix is host-side only: postCmd keeps the merged entries (bounded at
// CMD_LOG_MAX = the webview's own 50) and `ready` re-posts them oldest→newest as
// ordinary `cmd` messages, so the webview's existing merge-by-id + unshift + cap
// rebuild exactly the list it had.
//
// Everything is driven through the REAL DeployPanelProvider prototype (the "prototype
// method + plain object" pattern check-large-selection.cjs/check-suggestion-flow.cjs
// use). The webview side is not imported — its reducer is mirrored here (`applyCmd`,
// three lines, copied from panel.js's 'cmd' case) so the assertions are about the
// LIST A USER ENDS UP LOOKING AT, not about the message stream in isolation.
const path = require('path');
const assert = require('assert');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------- vscode stub
const vscodeStub = {
  window: {
    showWarningMessage: () => Promise.resolve(undefined),
    showInformationMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
    setStatusBarMessage: () => ({ dispose() {} }),
    withProgress: (_o, body) => body({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) }),
    activeTextEditor: undefined
  },
  workspace: { getConfiguration: () => ({ get: (_k, fallback) => fallback, update: async () => {} }) },
  commands: { executeCommand: async () => {} },
  Uri: { file: fsPath => ({ fsPath, scheme: 'file' }) },
  ProgressLocation: { Notification: 15, Window: 10 },
  ConfigurationTarget: { Global: 1 }
};
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? vscodeStub : origLoad(req, ...rest));

const { DeployPanelProvider } = require(path.join(ROOT, 'out', 'panelProvider.js'));
const proto = DeployPanelProvider.prototype;

let failed = 0;
const queue = [];
const check = (name, fn) => queue.push([name, fn]);

/** The webview's own 'cmd' handling (src/panel.js): merge by id when the entry is
 *  already there, otherwise unshift, then cap at 50. Newest first. */
function applyCmd(log, entry) {
  const at = log.findIndex(e => e.id === entry.id);
  if (at >= 0) log[at] = { ...log[at], ...entry };
  else log.unshift(entry);
  if (log.length > 50) log.length = 50;
  return log;
}
const render = messages => messages.filter(m => m.type === 'cmd').reduce((log, m) => applyCmd(log, m.entry), []);

function provider() {
  const posted = [];
  const s = Object.create(proto);
  Object.assign(s, {
    busy: false, cmdSeq: 0, cmdLog: [], deployQueue: [], liveSuggestions: new Map(),
    items: [], workspaceRoot: undefined, cardHistoryCache: [],
    orgs: [], orgMembers: new Map(),
    testLevel: undefined, runTests: undefined,
    output: { appendLine: () => {} },
    context: {
      workspaceState: { get: () => undefined, update: async () => {} },
      globalState: { get: () => undefined, update: async () => {} }
    },
    view: { visible: true, webview: { postMessage: m => posted.push(m) } },
    // `ready`-only stubs: this script is about the command log, not the scan/org
    // subsystems the rest of that handler drives.
    loadFiles: async () => {}, loadOrgs: async () => {}, sendActiveFile: () => {},
    maybeReattachDeploy: () => {}, maybeAutoFetchOrg: () => {},
    post: m => posted.push(m)
  });
  return {
    s,
    posted,
    begin: cmd => proto.beginCmd.call(s, cmd),
    update: (id, cmd) => proto.updateCmd.call(s, id, cmd),
    end: (id, ok, ms) => proto.endCmd.call(s, id, ok, ms),
    /** The webview rebuild: a fresh panel with an empty log sends `ready`. */
    rebuild: async () => { posted.length = 0; await proto.handleMessage.call(s, { type: 'ready' }); }
  };
}

check('a rebuilt panel gets the log back — command text, statuses and order intact', async () => {
  const p = provider();
  const a = p.begin('sf project deploy start --metadata ApexClass:OrderService --target-org acme-dev');
  p.update(a, 'sf project deploy start --metadata ApexClass:OrderService --target-org acme-dev --json');
  p.end(a, true, 1200);
  const b = p.begin('sf project retrieve start --metadata ApexClass:OrderService --target-org acme-dev');
  const live = render(p.posted);

  await p.rebuild();
  const replayed = p.posted.filter(m => m.type === 'cmd');
  assert.strictEqual(replayed.length, 2, `expected both commands replayed, got ${replayed.length}`);
  assert.deepStrictEqual(replayed.map(m => m.entry.id), [a, b], 'replay must run oldest→newest — the webview unshifts');
  assert.deepStrictEqual(replayed.map(m => m.entry.status), ['ok', 'run']);
  assert.strictEqual(replayed[0].entry.command,
    'sf project deploy start --metadata ApexClass:OrderService --target-org acme-dev --json',
    'the REAL echoed command (updateCmd) must be what comes back, not beginCmd\'s guess');
  assert.strictEqual(replayed[0].entry.durationMs, 1200);
  assert.deepStrictEqual(render(p.posted), live, 'the rebuilt panel must show exactly the list it had');
});

check('a command that finishes AFTER the rebuild is not a blank row', async () => {
  const p = provider();
  const a = p.begin('sf project deploy start --manifest /tmp/x/package.xml --target-org acme-dev');
  await p.rebuild();          // window reload while the deploy is still running
  p.end(a, true, 4300);       // …and it finishes into the fresh webview
  const rebuilt = render(p.posted);
  assert.strictEqual(rebuilt.length, 1, 'the completion must merge, not add a second row');
  assert.strictEqual(rebuilt[0].status, 'ok');
  assert.strictEqual(rebuilt[0].command, 'sf project deploy start --manifest /tmp/x/package.xml --target-org acme-dev',
    'end entries carry no `command` by design — without the replay this row renders blank');
});

check('a failed command replays as failed', async () => {
  const p = provider();
  const a = p.begin('sf project delete source --metadata ApexClass:Gone --target-org acme-dev --no-prompt');
  p.end(a, false, 300);
  await p.rebuild();
  assert.deepStrictEqual(p.posted.filter(m => m.type === 'cmd').map(m => m.entry.status), ['err']);
});

check('the kept log is bounded at 50, newest kept', async () => {
  const p = provider();
  const ids = [];
  for (let i = 0; i < 60; i++) ids.push(p.begin(`sf org list --json # ${i}`));
  await p.rebuild();
  const replayed = p.posted.filter(m => m.type === 'cmd').map(m => m.entry.id);
  assert.strictEqual(replayed.length, 50, 'an unbounded log is a leak, and the webview keeps 50 anyway');
  assert.deepStrictEqual(replayed, ids.slice(-50), 'the OLDEST entries are the ones dropped, order preserved');
});

check('the replay is the FIRST thing ready posts — before its awaits, so a command ending meanwhile merges into its row', async () => {
  // `ready` awaits the file scan and the org list before it replays the Status
  // pane. A command that ends inside that window used to reach the fresh webview
  // before its own replayed row, which then landed ABOVE it: [c1, c2] came back
  // as c1 over c2. Replaying before the first await closes the window.
  const p = provider();
  p.s.cardHistoryCache = [{ kind: 'ok', title: 'Deployed 1 component', at: 1 }];
  p.begin('sf project deploy start --metadata ApexClass:A --target-org acme-dev');
  await p.rebuild();
  const types = p.posted.map(m => m.type);
  assert.ok(types.includes('statusHistory'), 'fixture broken: no status history replayed');
  assert.strictEqual(types[0], 'cmd', types.join(','));
  assert.ok(types.indexOf('cmd') < types.indexOf('statusHistory'), types.join(','));
});

check('an end for an id the cap already evicted is not kept — it would replay as a blank row', async () => {
  // A deploy polled for minutes while 50 newer commands ran: its end entry has
  // nothing to merge into and carries no command text by design.
  const p = provider();
  const slow = p.begin('sf project deploy start --metadata ApexClass:Slow --target-org acme-dev');
  for (let i = 0; i < 60; i++) p.end(p.begin(`sf org list metadata --metadata-type T${i} --target-org acme-dev`), true, 1);
  p.end(slow, true, 90_000);
  await p.rebuild();
  const replayed = p.posted.filter(m => m.type === 'cmd').map(m => m.entry);
  assert.strictEqual(replayed.length, 50, 'the cap still holds');
  assert.ok(replayed.every(e => e.command), 'a replayed entry without command text renders as a blank row');
});

// A check whose promise never settles would drain the loop and exit 0 with no
// output — green for the wrong reason. The exit code is a failure until the
// summary line has actually run.
process.exitCode = 1;
(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
  }
  if (failed) { console.error(`cmd-log: ${failed}/${queue.length} checks FAILED`); process.exit(1); }
  console.log(`cmd-log: all ${queue.length} checks passed`);
  process.exitCode = 0;
})();
