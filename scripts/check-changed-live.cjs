// Runnable contract test for the Changed lens staying live through git
// (panelProvider.ts watchGitState). No framework.
//   1) npm run compile   2) node scripts/check-changed-live.cjs
//
// A saved edit used to show in the Changed lens only after re-entering it: the
// save listener re-read vscode.git's in-memory state 500 ms after the save,
// usually before vscode.git had finished its own `git status`; a commit, stash
// or discard — no editor buffer involved — never refreshed at all. The provider
// now also subscribes to every repository's `state.onDidChange` (the moment
// that state IS current) and to repositories opened later. Contract:
//   1. a git state change posts one `changed` payload built from the new state;
//   2. a burst collapses into one post (scheduleChangedRefresh's debounce);
//   3. a repository opened after the watch started is hooked too;
//   4. dispose stops everything — also when it lands while the git extension is
//      still activating; a missing git extension is a silent no-op;
//   5. a refresh falling due while the panel is hidden is held and runs on show
//      (vscode.git runs status on every write under the repo — a background
//      build must not cost a `git diff <changedBaseRef>` per pass);
//   6. source pins: resolveWebviewView wires the watch and the show-again
//      resume, and disposes both with the view.
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------- vscode stub
function emitter() {
  const fns = [];
  const event = (fn) => { fns.push(fn); return { dispose() { const i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); } }; };
  return { event, fire: (v) => { for (const fn of fns.slice()) fn(v); }, get count() { return fns.length; } };
}
function repo(paths) {
  const change = emitter();
  const r = {
    state: { workingTreeChanges: paths.map(p => ({ uri: { fsPath: p } })), indexChanges: [], onDidChange: change.event },
    diffWith: async () => []
  };
  return { r, change };
}
let git; // { api, ext? } or undefined = extension absent; `ext` overrides the (active) extension object
const vscodeStub = {
  extensions: { getExtension: (id) => (id === 'vscode.git' && git ? (git.ext || { isActive: true, exports: { getAPI: () => git.api } }) : undefined) },
  workspace: { getConfiguration: () => ({ get: (_k, d) => d }) },
  Uri: { file: fsPath => ({ fsPath, scheme: 'file' }) }
};
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? vscodeStub : origLoad(req, ...rest));
const { DeployPanelProvider } = require(path.join(ROOT, 'out', 'panelProvider.js'));
const proto = DeployPanelProvider.prototype;
const src = fs.readFileSync(path.join(ROOT, 'src', 'panelProvider.ts'), 'utf8');

const cls = (name) => ({ type: 'ApexClass', name, filePath: `/ws/force-app/classes/${name}.cls`, files: [`/ws/force-app/classes/${name}.cls`] });
const A = '/ws/force-app/classes/AcmeA.cls';
const B = '/ws/force-app/classes/AcmeB.cls';

function provider() {
  const posted = [];
  const log = [];
  const s = Object.create(proto);
  Object.assign(s, { items: [cls('AcmeA'), cls('AcmeB')], output: { appendLine: (l) => log.push(l) }, post: (m) => posted.push(m) });
  return { s, posted, log, changed: () => posted.filter(m => m.type === 'changed').map(m => (m.keys || []).slice().sort()) };
}
const settle = () => new Promise(r => setTimeout(r, 650)); // past the 500 ms debounce
const tick = () => new Promise(r => setImmediate(r));

let failed = 0;
const queue = [];
const check = (name, fn) => queue.push([name, fn]);

// ---------------------------------------------------- 1) + 2) one post per burst
check('a git state change posts the Changed payload once per burst, from the new state', async () => {
  const one = repo([A]);
  const opened = emitter();
  git = { api: { repositories: [one.r], onDidOpenRepository: opened.event } };
  const p = provider();
  const sub = p.s.watchGitState();
  await tick();
  assert.strictEqual(one.change.count, 1, 'hooked the existing repository');
  one.change.fire(); one.change.fire(); one.change.fire();
  await settle();
  assert.deepStrictEqual(p.changed(), [['ApexClass:AcmeA']]);
  // The lens follows git, not the save: a second file turns dirty with no save event.
  one.r.state.workingTreeChanges.push({ uri: { fsPath: B } });
  one.change.fire();
  await settle();
  assert.deepStrictEqual(p.changed()[1], ['ApexClass:AcmeA', 'ApexClass:AcmeB']);
  // …and a commit (state empties) clears it.
  one.r.state.workingTreeChanges.length = 0;
  one.change.fire();
  await settle();
  assert.deepStrictEqual(p.changed()[2], []);
  sub.dispose();
});

// ------------------------------------------------- 3) a repository opened later
check('a repository opened after the watch started is hooked; dispose unhooks everything', async () => {
  const first = repo([]);
  const opened = emitter();
  git = { api: { repositories: [first.r], onDidOpenRepository: opened.event } };
  const p = provider();
  const sub = p.s.watchGitState();
  await tick();
  const late = repo([A]);
  opened.fire(late.r);
  assert.strictEqual(late.change.count, 1, 'hooked the late repository');
  late.change.fire();
  await settle();
  assert.strictEqual(p.changed().length, 1);
  sub.dispose();
  assert.strictEqual(first.change.count + late.change.count + opened.count, 0, 'dispose released every subscription');
  late.change.fire();
  await settle();
  assert.strictEqual(p.changed().length, 1, 'nothing posts after dispose');
});

check('dispose during a late activation: nothing subscribes afterwards', async () => {
  const one = repo([A]);
  const opened = emitter();
  let activated;
  git = {
    api: { repositories: [one.r], onDidOpenRepository: opened.event },
    ext: { isActive: false, activate: () => new Promise(r => { activated = () => r({ getAPI: () => git.api }); }) }
  };
  const p = provider();
  const sub = p.s.watchGitState();
  await tick();
  assert.strictEqual(one.change.count, 0, 'nothing hooked before activation resolves');
  sub.dispose();
  activated();
  await tick(); await tick();
  assert.strictEqual(one.change.count + opened.count, 0, 'activation after dispose must not subscribe');
  one.change.fire();
  await settle();
  assert.strictEqual(p.posted.length, 0);
  assert.deepStrictEqual(p.log, []);
});

// -------------------------------------------------- 5) hidden panel: held
check('a refresh due while the panel is hidden is held, and runs once on show', async () => {
  const one = repo([A]);
  git = { api: { repositories: [one.r], onDidOpenRepository: emitter().event } };
  const p = provider();
  p.s.view = { visible: false };
  const sub = p.s.watchGitState();
  await tick();
  one.change.fire(); one.change.fire();
  await settle();
  assert.strictEqual(p.changed().length, 0, 'hidden → nothing posted');
  assert.strictEqual(p.s.changedRefreshHeld, true);
  // What the onDidChangeVisibility handler does on show:
  p.s.view.visible = true;
  if (p.s.changedRefreshHeld) p.s.scheduleChangedRefresh();
  await settle();
  assert.deepStrictEqual(p.changed(), [['ApexClass:AcmeA']]);
  assert.strictEqual(p.s.changedRefreshHeld, false);
  // Nothing held → showing again re-runs nothing.
  if (p.s.changedRefreshHeld) p.s.scheduleChangedRefresh();
  await settle();
  assert.strictEqual(p.changed().length, 1);
  // No view at all (never resolved) is not "hidden".
  p.s.view = undefined;
  one.change.fire();
  await settle();
  assert.strictEqual(p.changed().length, 2);
  sub.dispose();
});

// -------------------------------------------------- 4) no git extension
check('no git extension: nothing subscribes, nothing throws, nothing is logged as a failure', async () => {
  git = undefined;
  const p = provider();
  const sub = p.s.watchGitState();
  await tick();
  sub.dispose();
  assert.deepStrictEqual(p.log, []);
  assert.strictEqual(p.posted.length, 0);
});

check('a git API that throws is logged, not thrown', async () => {
  git = { api: { get repositories() { throw new Error('boom'); }, onDidOpenRepository: emitter().event } };
  const p = provider();
  p.s.watchGitState().dispose();
  await tick();
  assert.ok(p.log.some(l => l.startsWith('[changed] git state watch failed: boom')), p.log.join('\n'));
});

// ------------------------------------------------------- 5) source pins
check('resolveWebviewView wires the watch and the show-again resume, and disposes both with the view', () => {
  assert.ok(src.includes('const gitSub = this.watchGitState();'));
  assert.ok(src.includes('const visSub = view.onDidChangeVisibility(() => { if (view.visible && this.changedRefreshHeld) this.scheduleChangedRefresh(); });'));
  assert.ok(src.includes('      gitSub.dispose();\n      visSub.dispose();'));
  assert.ok(!src.includes('onDidSaveTextDocument(() => this.scheduleChangedRefresh())'), 'the save listener is gone — it read git state before vscode.git had caught up');
  assert.ok(src.includes('subs.push(repo.state.onDidChange(() => this.scheduleChangedRefresh()));'), 'the git event goes through the same debounce as a save');
  assert.ok(src.includes('subs.push(api.onDidOpenRepository(hook));'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.check.includes('node ./scripts/check-changed-live.cjs'), 'this harness is in `check`');
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
  if (failed) { console.error(`changed-live: ${failed} of ${queue.length} checks failed`); process.exit(1); }
  console.log(`changed-live: all ${queue.length} checks passed`);
})();
