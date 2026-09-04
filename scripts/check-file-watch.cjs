// Runnable contract test for the package-directory file watcher.
//   1) npm run compile   2) node scripts/check-file-watch.cjs
//
// The reported bug: a NEW Apex class was invisible to the panel — missing from
// the tree, unavailable as a dependency suggestion, absent from the Changed lens
// — until a manual Refresh Metadata Files, because nothing but four explicit
// paths (webview ready, Refresh, post-retrieve, post-restore) ever rebuilt
// `this.items`. There was no file system watcher anywhere in the extension.
//
// What is pinned here:
//   1. watchTargets / watchTargetsKey — WHICH directories get watched, and when
//      a re-resolution counts as "the same set" (the check that keeps every scan
//      from tearing live watchers down and building them again).
//   2. affectsItemList — which create/delete notifications are worth a rescan.
//      Deliberately permissive, so the interesting assertions are the rejections
//      (.git, node_modules, dot-files, editor scratch) that would otherwise turn
//      one `git checkout` into a rescan storm.
//   3. RescanScheduler — the coalescing itself, on an injected clock: one rescan
//      per burst, never while an operation holds the busy slot, never re-entrant.
//   4. The provider wiring, through the REAL DeployPanelProvider: one watcher per
//      package dir with change events ignored, an unchanged root left alone, a
//      changed root disposing exactly what it replaces, no root = no watcher.
//   5. The silence contract of a watcher-triggered scan: no `sf` spawn behind a
//      progress notification, a discovery failure that does NOT empty the tree or
//      pop an error toast, and a scan that came back EMPTY that is not published as
//      the truth (a walk can land mid-checkout; the webview prunes its persisted
//      selection against whatever it is handed).
//
// Not testable here: the vscode watcher API itself. Only VS Code emits real
// create/delete events, applies its own glob and exclusion semantics, and
// decides what a bulk filesystem operation delivers. Everything below drives our
// side of that boundary against a stub — the boundary itself is taken on faith.
const path = require('path');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const Module = require('module');

// ---------------------------------------------------------------- vscode stub
const ui = { error: [], warn: [], info: [], progress: [] };
const ws = { folders: [], projectFiles: [] };
// Every watcher the stub hands out, with its constructor args and disposal state
// — the leak assertions read this.
const watchers = [];
const resetUi = () => { for (const k of Object.keys(ui)) ui[k].length = 0; };

class StubWatcher {
  constructor(pattern, ignoreCreate, ignoreChange, ignoreDelete) {
    Object.assign(this, { pattern, ignoreCreate, ignoreChange, ignoreDelete });
    this.disposed = 0;
    this.subs = [];
    this.onCreate = [];
    this.onDelete = [];
    this.onChange = [];
  }
  dispose() { this.disposed++; }
  onDidCreate(fn) { this.onCreate.push(fn); return this.sub(); }
  onDidDelete(fn) { this.onDelete.push(fn); return this.sub(); }
  onDidChange(fn) { this.onChange.push(fn); return this.sub(); }
  sub() { const s = { disposed: 0, dispose() { this.disposed++; } }; this.subs.push(s); return s; }
}

const vscodeStub = {
  window: {
    showErrorMessage: (message, ...items) => { ui.error.push({ message, items }); return Promise.resolve(undefined); },
    showWarningMessage: (message, ...items) => { ui.warn.push({ message, items }); return Promise.resolve(undefined); },
    showInformationMessage: (message, ...items) => { ui.info.push({ message, items }); return Promise.resolve(undefined); },
    setStatusBarMessage: () => ({ dispose: () => {} }),
    withProgress: (opts, body) => { ui.progress.push(opts); return body({ report: () => {} }, { onCancellationRequested: () => ({ dispose: () => {} }) }); }
  },
  workspace: {
    get workspaceFolders() { return ws.folders; },
    findFiles: async () => ws.projectFiles.map(f => ({ fsPath: f })),
    asRelativePath: uri => uri.fsPath,
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    createFileSystemWatcher: (...args) => { const w = new StubWatcher(...args); watchers.push(w); return w; }
  },
  RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
  Uri: { file: fsPath => ({ fsPath, scheme: 'file' }) },
  ViewColumn: { Active: -1 },
  ProgressLocation: { Notification: 15 }
};
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? vscodeStub : origLoad(req, ...rest));

const { RescanScheduler, affectsItemList, watchTargets, watchTargetsKey } =
  require(path.join(__dirname, '..', 'out', 'fileWatch.js'));
const { DeployPanelProvider } = require(path.join(__dirname, '..', 'out', 'panelProvider.js'));
const providerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'panelProvider.ts'), 'utf8');

let failed = 0;
const queue = [];
function check(name, fn) { queue.push([name, fn]); }

check('source: the once-per-session flag is declared, and the toast sits inside syncFileWatchers\' catch', () => {
  assert.ok(/private watchFailureWarned = false;/.test(providerSrc), 'watchFailureWarned field not found');
  const catchBlock = providerSrc.slice(
    providerSrc.indexOf('could not watch the package directories'),
    providerSrc.indexOf('could not watch the package directories') + 600
  );
  assert.ok(/if \(!this\.watchFailureWarned\) \{/.test(catchBlock), 'toast must be gated on the flag');
  assert.ok(/this\.watchFailureWarned = true;/.test(catchBlock), 'the flag must be set before/inside the toast, not after');
  assert.ok(/vscode\.window\.showWarningMessage\(/.test(catchBlock), 'the toast call itself must be inside the catch');
});
const p = (...s) => path.join(...s);
const flush = () => new Promise(r => setImmediate(r));
// Project roots are always absolute in practice (discovery hands back a real
// directory), and watchTargets resolves against them.
const PROJ = path.resolve(p('ws', 'proj'));
const OTHER = path.resolve(p('ws', 'other'));

// ------------------------------------------------------------- watchTargets
check('package dirs resolve against the project root and watch everything below', () => {
  const t = watchTargets(PROJ, ['force-app']);
  assert.deepStrictEqual(t, [{ base: p(PROJ, 'force-app'), pattern: '**/*' }]);
});

check('several package dirs each get their own target', () => {
  const t = watchTargets(PROJ, ['force-app', 'shared-app']);
  assert.deepStrictEqual(t.map(x => x.base), [p(PROJ, 'force-app'), p(PROJ, 'shared-app')]);
});

check('duplicate and equivalent spellings collapse to one watcher', () => {
  // `./force-app`, `force-app/` and `force-app` are the same directory; two
  // watchers on it would deliver every event twice.
  const t = watchTargets(PROJ, ['force-app', './force-app', 'force-app' + path.sep]);
  assert.strictEqual(t.length, 1);
});

check('a package dir nested inside another listed one is dropped', () => {
  const t = watchTargets(PROJ, ['force-app', p('force-app', 'main')]);
  assert.deepStrictEqual(t.map(x => x.base), [p(PROJ, 'force-app')]);
});

check('a sibling that merely shares a name PREFIX is not treated as nested', () => {
  // `force-app-extra` starts with `force-app` as a string but is not inside it —
  // a prefix test without the separator would silently stop watching it.
  const t = watchTargets(PROJ, ['force-app', 'force-app-extra']);
  assert.deepStrictEqual(t.map(x => x.base), [p(PROJ, 'force-app'), p(PROJ, 'force-app-extra')]);
});

check('an absolute package dir is honored as given', () => {
  const abs = path.resolve(p('elsewhere', 'pkg'));
  assert.deepStrictEqual(watchTargets(PROJ, [abs]).map(x => x.base), [abs]);
});

check('no project root means no targets at all', () => {
  assert.deepStrictEqual(watchTargets(undefined, ['force-app']), []);
  assert.deepStrictEqual(watchTargets('', ['force-app']), []);
});

check('junk package entries are ignored, not resolved to the root', () => {
  // A blank entry would resolve to the project ROOT and quietly widen the watch
  // to the whole repo (.git included).
  assert.deepStrictEqual(watchTargets(PROJ, ['', '   ', null, undefined, 42]), []);
});

check('the target order does not depend on the order package dirs were listed', () => {
  const a = watchTargets(PROJ, ['b-app', 'a-app']);
  const b = watchTargets(PROJ, ['a-app', 'b-app']);
  assert.deepStrictEqual(a, b);
});

check('case-only duplicates collapse on win32 and stay distinct elsewhere', () => {
  const win = watchTargets(PROJ, ['force-app', 'FORCE-APP'], 'win32');
  assert.strictEqual(win.length, 1);
  const posix = watchTargets(PROJ, ['force-app', 'FORCE-APP'], 'darwin');
  assert.strictEqual(posix.length, 2);
});

check('nesting is detected across win32 casing too', () => {
  // sfdx-project.json is hand-written: `force-app` and `FORCE-APP/main` are the
  // same tree on Windows, and an unfolded containment test would watch both.
  const win = watchTargets(PROJ, ['force-app', p('FORCE-APP', 'main')], 'win32');
  assert.deepStrictEqual(win.map(x => x.base), [p(PROJ, 'force-app')]);
  const posix = watchTargets(PROJ, ['force-app', p('FORCE-APP', 'main')], 'darwin');
  assert.strictEqual(posix.length, 2, 'on a case-sensitive filesystem they really are two trees');
});

// ---------------------------------------------------------- watchTargetsKey
check('the same directories produce the same key (watchers are left alone)', () => {
  const key = watchTargetsKey(watchTargets(PROJ, ['force-app']));
  assert.strictEqual(key, watchTargetsKey(watchTargets(PROJ, ['./force-app'])));
});

check('a different directory produces a different key', () => {
  assert.notStrictEqual(
    watchTargetsKey(watchTargets(PROJ, ['force-app'])),
    watchTargetsKey(watchTargets(OTHER, ['force-app']))
  );
});

check('adjacent targets cannot run together into an identical key', () => {
  // Without a separator, base `/x/ab` + pattern `p` and base `/x/a` + pattern
  // `bp` would both spell "/x/abp" — the panel would then keep watching a stale
  // directory because the key claimed nothing had changed.
  const a = watchTargetsKey([{ base: p('x', 'ab'), pattern: 'p' }]);
  const b = watchTargetsKey([{ base: p('x', 'a'), pattern: 'bp' }]);
  assert.notStrictEqual(a, b);
  const two = watchTargetsKey([{ base: p('x', 'a'), pattern: 'p' }, { base: p('x', 'b'), pattern: 'p' }]);
  const one = watchTargetsKey([{ base: p('x', 'a'), pattern: 'p' + p('x', 'b') + 'p' }]);
  assert.notStrictEqual(two, one);
});

check('an empty target set has its own stable key', () => {
  assert.strictEqual(watchTargetsKey([]), watchTargetsKey([]));
  assert.notStrictEqual(watchTargetsKey([]), watchTargetsKey(watchTargets(PROJ, ['force-app'])));
});

// ---------------------------------------------------------- affectsItemList
check('a brand-new Apex class is relevant — the reported bug', () => {
  assert.strictEqual(affectsItemList(p(PROJ, 'force-app', 'main', 'default', 'classes', 'DepFixSvc.cls')), true);
});

check('a new bundle FOLDER is relevant', () => {
  assert.strictEqual(affectsItemList(p(PROJ, 'force-app', 'main', 'default', 'lwc', 'depFixCard')), true);
});

check('a file under a metadata folder no rule covers is still relevant', () => {
  // The scan reports such folders as `unknownFolders`; pretending they cannot
  // matter would re-create the reported bug for every new metadata type.
  assert.strictEqual(affectsItemList(p(PROJ, 'force-app', 'main', 'default', 'mysteryType', 'Thing.mystery-meta.xml')), true);
});

check('git internals are never worth a rescan', () => {
  // The burst that makes debouncing necessary: a checkout writes thousands of
  // these, and none of them is metadata.
  assert.strictEqual(affectsItemList(p(PROJ, '.git', 'index')), false);
  assert.strictEqual(affectsItemList(p(PROJ, '.git', 'objects', 'ab', 'cdef')), false);
});

check('node_modules and sfdx scratch directories are ignored', () => {
  assert.strictEqual(affectsItemList(p(PROJ, 'node_modules', 'pkg', 'index.js')), false);
  assert.strictEqual(affectsItemList(p(PROJ, 'force-app', '.sfdx', 'tools', 'x.json')), false);
  assert.strictEqual(affectsItemList(p(PROJ, '.localdevserver', 'x')), false);
});

check('the skip test is per path SEGMENT, not a substring match', () => {
  // `node_modules_backup` is an ordinary directory; a substring test would stop
  // watching everything under it.
  assert.strictEqual(affectsItemList(p(PROJ, 'node_modules_backup', 'classes', 'DepFixSvc.cls')), true);
});

check('dot-files next to real sources are ignored', () => {
  assert.strictEqual(affectsItemList(p('ws', 'classes', '.DS_Store')), false);
  assert.strictEqual(affectsItemList(p('ws', 'classes', '.eslintrc')), false);
  assert.strictEqual(affectsItemList(p('ws', 'classes', '.DepFixSvc.cls.swp')), false);
});

check('editor scratch files are ignored', () => {
  assert.strictEqual(affectsItemList(p('ws', 'classes', 'DepFixSvc.cls~')), false);
  assert.strictEqual(affectsItemList(p('ws', 'classes', 'DepFixSvc.cls.tmp')), false);
  assert.strictEqual(affectsItemList(p('ws', 'classes', 'DepFixSvc.cls.swx')), false);
});

check('a real class is not mistaken for scratch because of its extension', () => {
  assert.strictEqual(affectsItemList(p('ws', 'classes', 'DepFixSvc.cls')), true);
  assert.strictEqual(affectsItemList(p('ws', 'classes', 'Tmp.cls')), true);
});

check('a missing path is never relevant', () => {
  assert.strictEqual(affectsItemList(undefined), false);
  assert.strictEqual(affectsItemList(''), false);
});

check('windows-style separators are understood', () => {
  assert.strictEqual(affectsItemList('C:\\ws\\proj\\force-app\\main\\default\\classes\\DepFixSvc.cls'), true);
  assert.strictEqual(affectsItemList('C:\\ws\\proj\\.git\\index'), false);
});

// -------------------------------------------------------- RescanScheduler
// Injected clock: timers fire only when the test says so, so the coalescing is
// asserted rather than slept on.
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: id => { timers.delete(id); },
    pending: () => timers.size,
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = target;
      await flush();
    }
  };
}

const scheduler = (over = {}) => {
  const clock = fakeClock();
  const state = { runs: 0, errors: [], busy: false, block: null };
  const s = new RescanScheduler({
    delayMs: 600,
    isBusy: () => state.busy,
    run: async () => { state.runs++; if (state.block) await state.block; },
    onError: err => state.errors.push(err),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...over
  });
  return { s, clock, state };
};

check('a burst of notifications produces exactly one rescan', async () => {
  const { s, clock, state } = scheduler();
  for (let i = 0; i < 500; i++) s.schedule();
  assert.strictEqual(state.runs, 0, 'nothing may run before the window closes');
  await clock.advance(600);
  assert.strictEqual(state.runs, 1);
});

check('each notification restarts the window (trailing debounce)', async () => {
  const { s, clock, state } = scheduler();
  s.schedule();
  await clock.advance(500);
  s.schedule();               // 100ms before the first window would have closed
  await clock.advance(500);   // the original deadline passes...
  assert.strictEqual(state.runs, 0, 'the second notification must push the deadline out');
  await clock.advance(100);
  assert.strictEqual(state.runs, 1);
});

check('a rescan never runs while an operation holds the busy slot', async () => {
  const { s, clock, state } = scheduler();
  state.busy = true;
  s.schedule();
  await clock.advance(600 * 5);
  assert.strictEqual(state.runs, 0, 'a deploy must not have the item list swapped underneath it');
  state.busy = false;
  await clock.advance(600);
  assert.strictEqual(state.runs, 1, 'the deferred rescan must still happen once the slot frees');
});

check('deferring while busy does not multiply into several rescans', async () => {
  const { s, clock, state } = scheduler();
  state.busy = true;
  for (let i = 0; i < 20; i++) s.schedule();
  await clock.advance(600 * 10);
  state.busy = false;
  await clock.advance(600 * 10);
  assert.strictEqual(state.runs, 1);
});

check('notifications during a rescan produce exactly one more rescan', async () => {
  const { s, clock, state } = scheduler();
  let release;
  state.block = new Promise(r => { release = r; });
  s.schedule();
  await clock.advance(600);
  assert.strictEqual(state.runs, 1);
  for (let i = 0; i < 10; i++) s.schedule();       // arrive mid-scan
  await clock.advance(600 * 3);
  assert.strictEqual(state.runs, 1, 'scans must never overlap');
  state.block = null;
  release();
  await flush();
  await clock.advance(600);
  assert.strictEqual(state.runs, 2, 'changes seen mid-scan must not be lost');
  await clock.advance(600 * 5);
  assert.strictEqual(state.runs, 2, 'and must not repeat forever');
});

check('a failing rescan is reported, not thrown, and the scheduler keeps working', async () => {
  const { s, clock, state } = scheduler({ run: async () => { state.runs++; throw new Error('scan blew up'); } });
  s.schedule();
  await clock.advance(600);
  assert.strictEqual(state.runs, 1);
  assert.strictEqual(state.errors.length, 1);
  s.schedule();
  await clock.advance(600);
  assert.strictEqual(state.runs, 2, 'one failure must not wedge the watcher for the session');
});

check('a synchronous throw from the rescan is caught too', async () => {
  const { s, clock, state } = scheduler({ run: () => { state.runs++; throw new Error('sync blow-up'); } });
  s.schedule();
  await clock.advance(600);
  assert.strictEqual(state.errors.length, 1);
  s.schedule();
  await clock.advance(600);
  assert.strictEqual(state.runs, 2);
});

check('dispose cancels a pending rescan and ignores later notifications', async () => {
  const { s, clock, state } = scheduler();
  s.schedule();
  assert.strictEqual(clock.pending(), 1);
  s.dispose();
  assert.strictEqual(clock.pending(), 0, 'the armed timer must be cleared, not left to fire after shutdown');
  s.schedule();
  assert.strictEqual(clock.pending(), 0, 'a notification after shutdown must not arm a new timer either');
  await clock.advance(600 * 5);
  assert.strictEqual(state.runs, 0);
});

check('dispose during a rescan stops the follow-up', async () => {
  const { s, clock, state } = scheduler();
  let release;
  state.block = new Promise(r => { release = r; });
  s.schedule();
  await clock.advance(600);
  s.schedule();     // queued behind the running scan
  s.dispose();
  state.block = null;
  release();
  await flush();
  await clock.advance(600 * 5);
  assert.strictEqual(state.runs, 1);
});

// ------------------------------------------------------- the provider wiring
// A minimal object on the real prototype: syncFileWatchers only needs the
// watcher list, the key, the output channel and the scheduler.
const provider = (over = {}) => Object.assign(Object.create(DeployPanelProvider.prototype), {
  fileWatchers: [],
  watchedTargetsKey: undefined,
  watchFailureWarned: false,
  items: [],
  output: { appendLine: () => {} },
  rescanScheduler: { scheduled: 0, schedule() { this.scheduled++; } },
  ...over
});
const sync = (prov, root) => DeployPanelProvider.prototype.syncFileWatchers.call(prov, root);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-file-watch-'));
const projA = path.join(tmp, 'projA');
const projB = path.join(tmp, 'projB');
fs.mkdirSync(projA, { recursive: true });
fs.mkdirSync(projB, { recursive: true });
fs.writeFileSync(path.join(projA, 'sfdx-project.json'),
  JSON.stringify({ packageDirectories: [{ path: 'force-app' }, { path: 'shared-app' }] }));
fs.writeFileSync(path.join(projB, 'sfdx-project.json'),
  JSON.stringify({ packageDirectories: [{ path: 'force-app' }] }));

check('one watcher per package directory, anchored at that directory', async () => {
  watchers.length = 0;
  const prov = provider();
  await sync(prov, projA);
  assert.strictEqual(watchers.length, 2);
  assert.deepStrictEqual(watchers.map(w => w.pattern.base.fsPath).sort(),
    [path.join(projA, 'force-app'), path.join(projA, 'shared-app')]);
  assert.ok(watchers.every(w => w.pattern.pattern === '**/*'));
});

check('CHANGE events are ignored; create and delete are subscribed', async () => {
  watchers.length = 0;
  const prov = provider();
  await sync(prov, projA);
  for (const w of watchers) {
    assert.strictEqual(w.ignoreChange, true, 'editing a file body cannot change the item list — a rescan per save is pure cost');
    assert.strictEqual(w.ignoreCreate, false, 'a created file is the reported bug');
    assert.strictEqual(w.ignoreDelete, false, 'a deleted component must leave the tree');
    assert.strictEqual(w.onCreate.length, 1);
    assert.strictEqual(w.onDelete.length, 1);
    assert.strictEqual(w.onChange.length, 0);
  }
});

check('re-syncing the same root leaves the live watchers running', async () => {
  watchers.length = 0;
  const prov = provider();
  await sync(prov, projA);
  const first = watchers.slice();
  await sync(prov, projA);
  assert.strictEqual(watchers.length, 2, 'no new watcher may be created for an unchanged target set');
  assert.ok(first.every(w => w.disposed === 0));
});

check('a changed root disposes the old watchers AND their subscriptions', async () => {
  watchers.length = 0;
  const prov = provider();
  await sync(prov, projA);
  const old = watchers.slice();
  await sync(prov, projB);
  assert.ok(old.every(w => w.disposed === 1), 'a re-created watcher must not leak the one it replaces');
  assert.ok(old.every(w => w.subs.every(s => s.disposed === 1)), 'the create/delete subscriptions leak otherwise');
  const live = watchers.slice(old.length);
  assert.strictEqual(live.length, 1);
  assert.ok(live.every(w => w.disposed === 0));
  assert.strictEqual(prov.fileWatchers.length, 3, 'watcher + its two subscriptions must all be held for disposal');
});

check('no project root means no watcher, and tears the current one down', async () => {
  watchers.length = 0;
  const prov = provider();
  await sync(prov, projA);
  const old = watchers.slice();
  await sync(prov, undefined);
  assert.ok(old.every(w => w.disposed === 1));
  assert.strictEqual(watchers.length, old.length, 'nothing may be watched without a valid project root');
  assert.strictEqual(prov.fileWatchers.length, 0);
  // …and a recovered root really does re-arm rather than being mistaken for
  // the empty set that is already 'in place'.
  await sync(prov, projA);
  assert.strictEqual(prov.fileWatchers.length, 6);
});

check('a watcher API failure leaves nothing half-wired', async () => {
  watchers.length = 0;
  resetUi();
  const prov = provider();
  const orig = vscodeStub.workspace.createFileSystemWatcher;
  vscodeStub.workspace.createFileSystemWatcher = () => { throw new Error('watcher refused'); };
  try {
    await sync(prov, projA);
  } finally {
    vscodeStub.workspace.createFileSystemWatcher = orig;
  }
  assert.strictEqual(prov.fileWatchers.length, 0);
  assert.strictEqual(prov.watchedTargetsKey, undefined, 'the next scan must retry rather than believe it is watching');
  // …and the retry really does re-arm.
  await sync(prov, projA);
  assert.strictEqual(prov.fileWatchers.length, 6);
});

check('a watcher failure toasts ONCE per session; every failure still logs, a second failure does not re-toast', async () => {
  // The bug: this failure was logged to Output only — the tree then silently
  // went stale (new/deleted files invisible) until a manual Refresh, with no
  // signal that watching had stopped at all.
  watchers.length = 0;
  resetUi();
  const prov = provider();
  const orig = vscodeStub.workspace.createFileSystemWatcher;
  vscodeStub.workspace.createFileSystemWatcher = () => { throw new Error('watcher refused'); };
  try {
    await sync(prov, projA);
    assert.strictEqual(ui.warn.length, 1, 'the first failure this session must toast');
    assert.match(ui.warn[0].message, /live file watching is off/i);
    assert.match(ui.warn[0].message, /Refresh Metadata Files/);
    assert.strictEqual(prov.watchFailureWarned, true);

    await sync(prov, projB); // a second, distinct failure this session
    assert.strictEqual(ui.warn.length, 1, 'a second failure must not toast again — logging alone covers it');
  } finally {
    vscodeStub.workspace.createFileSystemWatcher = orig;
  }
});

check('a fresh provider (new session) toasts again on its own first failure', async () => {
  watchers.length = 0;
  resetUi();
  const prov = provider(); // watchFailureWarned: false — a distinct session
  const orig = vscodeStub.workspace.createFileSystemWatcher;
  vscodeStub.workspace.createFileSystemWatcher = () => { throw new Error('watcher refused'); };
  try {
    await sync(prov, projA);
  } finally {
    vscodeStub.workspace.createFileSystemWatcher = orig;
  }
  assert.strictEqual(ui.warn.length, 1);
});

// A failure on the SECOND package directory is the interesting one: the first
// watcher is already live, and the field it would be disposed through was emptied
// before the creation loop started.
const failingWatchers = (shouldFail) => {
  const orig = vscodeStub.workspace.createFileSystemWatcher;
  let n = 0;
  vscodeStub.workspace.createFileSystemWatcher = (...args) => {
    if (shouldFail(n++)) throw new Error('watcher refused');
    return orig(...args);
  };
  return () => { vscodeStub.workspace.createFileSystemWatcher = orig; };
};

check('a failure PART WAY through disposes the watchers this attempt created', async () => {
  watchers.length = 0;
  const prov = provider();
  const restore = failingWatchers(n => n === 1); // projA has two package dirs
  try { await sync(prov, projA); } finally { restore(); }
  assert.strictEqual(watchers.length, 1, 'the first package dir was watched before the failure');
  assert.strictEqual(watchers[0].disposed, 1,
    'an orphaned watcher is unreachable but still delivering events — it can only be disposed by name');
  assert.ok(watchers[0].subs.every(s => s.disposed === 1), 'its create/delete subscriptions leak with it');
  assert.strictEqual(prov.fileWatchers.length, 0);
  assert.strictEqual(prov.watchedTargetsKey, undefined, 'the next scan must retry rather than believe it is watching');
});

check('an orphan cannot keep scheduling the rescans that leak the next one', async () => {
  // The compounding shape: every orphan still fires create/delete events, each one
  // schedules a rescan, each rescan re-syncs and strands another set.
  watchers.length = 0;
  const prov = provider();
  const restore = failingWatchers(n => n % 2 === 1);
  try { for (let i = 0; i < 6; i++) await sync(prov, projA); } finally { restore(); }
  const live = watchers.filter(w => w.disposed === 0);
  assert.strictEqual(live.length, 0, `${live.length} watcher(s) still alive after 6 failed attempts`);
  for (const w of watchers) {
    assert.strictEqual(w.disposed, 1, 'a watcher was disposed twice — the failure path is double-handling it');
  }
});

check('a failure AFTER the watchers are handed over disposes them exactly once', async () => {
  // The other end of the same window: everything was created and assigned, and the
  // logging line is what threw. `created` and the field are then the SAME watchers,
  // so a failure path that disposes both lists would dispose each one twice.
  watchers.length = 0;
  let throwOnce = 1;
  const prov = provider({
    output: { appendLine: () => { if (throwOnce-- > 0) throw new Error('output channel closed'); } }
  });
  await sync(prov, projA);
  assert.strictEqual(watchers.length, 2);
  assert.ok(watchers.every(w => w.disposed === 1),
    `disposed ${watchers.map(w => w.disposed).join('/')} times — the failure path is double-handling the same watchers`);
  assert.strictEqual(prov.fileWatchers.length, 0);
  assert.strictEqual(prov.watchedTargetsKey, undefined);
});

check('a failure BEFORE anything is created still disposes the previous set, once', async () => {
  watchers.length = 0;
  const prov = provider();
  await sync(prov, projA);
  const old = watchers.slice();
  const restore = failingWatchers(() => true);
  try { await sync(prov, projB); } finally { restore(); }
  assert.ok(old.every(w => w.disposed === 1), 'the watchers for the abandoned root must not be stranded');
  assert.strictEqual(prov.fileWatchers.length, 0);
});

check('a project-discovery failure stops the watching entirely', async () => {
  watchers.length = 0;
  const prov = provider({
    projectDiscoveryError: undefined,
    workspaceRoot: projA,
    resetOrgMetadata: () => {},
    postFiles: () => {},
    post: () => {}
  });
  await sync(prov, projA);
  const old = watchers.slice();
  DeployPanelProvider.prototype.applyProjectDiscoveryFailure.call(prov, 'two projects, no way to choose');
  assert.ok(old.every(w => w.disposed === 1), 'the package dirs of a project the extension rejected must stop being watched');
  // …and the watching really resumes once the workspace is valid again. This is
  // what a stale target key would silently prevent: an unchanged key reads as
  // "already watching" and skips creating anything.
  await sync(prov, projA);
  assert.strictEqual(watchers.length, old.length + 2, 'a recovered project must be re-watched');
  assert.ok(watchers.slice(old.length).every(w => w.disposed === 0));
});

check('a create event on a source file schedules a rescan; git noise does not', async () => {
  watchers.length = 0;
  const prov = provider();
  await sync(prov, projA);
  const w = watchers[0];
  w.onCreate[0]({ fsPath: path.join(projA, 'force-app', 'main', 'default', 'classes', 'DepFixSvc.cls') });
  assert.strictEqual(prov.rescanScheduler.scheduled, 1);
  w.onDelete[0]({ fsPath: path.join(projA, 'force-app', 'main', 'default', 'classes', 'DepFixSvc.cls') });
  assert.strictEqual(prov.rescanScheduler.scheduled, 2, 'a deleted component must refresh too');
  w.onCreate[0]({ fsPath: path.join(projA, 'force-app', '.git', 'index') });
  w.onCreate[0]({ fsPath: undefined });
  assert.strictEqual(prov.rescanScheduler.scheduled, 2);
});

check('the rescan does not run when project discovery has left no root', async () => {
  let calls = 0;
  const prov = provider({ workspaceRoot: undefined, loadFiles: () => { calls++; return Promise.resolve(); } });
  await DeployPanelProvider.prototype.rescanAfterFileChange.call(prov);
  assert.strictEqual(calls, 0);
  prov.workspaceRoot = projA;
  await DeployPanelProvider.prototype.rescanAfterFileChange.call(prov);
  assert.strictEqual(calls, 1);
});

check('the rescan asks for a SILENT scan', async () => {
  const seen = [];
  const prov = provider({ workspaceRoot: projA, loadFiles: opts => { seen.push(opts); return Promise.resolve(); } });
  await DeployPanelProvider.prototype.rescanAfterFileChange.call(prov);
  assert.deepStrictEqual(seen, [{ silent: true }]);
});

// ------------------------------------------------- the silence of a rescan
// A real project tree with a metadata folder no static rule covers: the normal
// scan resolves it through the sf CLI registry behind a progress notification —
// which is exactly what a background rescan may not do.
const proj = path.join(tmp, 'silent');
const unknownDir = path.join(proj, 'force-app', 'main', 'default', 'mysteryType');
fs.mkdirSync(unknownDir, { recursive: true });
fs.mkdirSync(path.join(proj, 'force-app', 'main', 'default', 'classes'), { recursive: true });
fs.writeFileSync(path.join(proj, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app' }] }));
fs.writeFileSync(path.join(unknownDir, 'Thing.mystery-meta.xml'), '<Mystery/>');
fs.writeFileSync(path.join(proj, 'force-app', 'main', 'default', 'classes', 'DepFixSvc.cls'), 'public class DepFixSvc {}');

const scanProvider = (over = {}) => {
  const calls = { progress: 0, learned: [], posted: [], files: [], discoveryFailures: [], watchers: [] };
  const prov = provider({
    workspaceRoot: undefined,
    projectDiscoveryError: undefined,
    unresolvableFolders: new Set(),
    learnedRules: () => [],
    unresolvable() { return this.unresolvableFolders; },
    withWindowProgress: (title, body) => { calls.progress++; return body(() => {}); },
    learnRulesForFolders: async () => [],
    clearProjectDiscoveryError: () => {},
    applyProjectDiscoveryFailure: msg => { calls.discoveryFailures.push(msg); },
    post: msg => { calls.posted.push(msg); },
    postFiles: (items, opts) => { calls.files.push({ items, opts }); },
    postChangedComponents: async () => {},
    syncFileWatchers: async root => { calls.watchers.push(root); },
    ...over
  });
  return { prov, calls };
};
const doLoad = (prov, opts) => DeployPanelProvider.prototype.doLoadFiles.call(prov, opts);

check('a silent rescan never spawns the sf registry behind a progress notification', async () => {
  ws.folders = [{ uri: { fsPath: proj }, name: 'silent', index: 0 }];
  ws.projectFiles = [path.join(proj, 'sfdx-project.json')];
  const { prov, calls } = scanProvider();
  await doLoad(prov, { silent: true });
  assert.strictEqual(calls.progress, 0, 'a background rescan must not interrupt with a progress notification');
  assert.ok(prov.items.some(i => i.type === 'ApexClass' && i.name === 'DepFixSvc'), 'the tree must still be refreshed');
  assert.strictEqual(calls.watchers.length, 1, 'the watcher must be re-pointed at the scanned root');
});

check('an explicit scan still resolves unknown folders through the CLI', async () => {
  ws.folders = [{ uri: { fsPath: proj }, name: 'silent', index: 0 }];
  ws.projectFiles = [path.join(proj, 'sfdx-project.json')];
  const { prov, calls } = scanProvider();
  await doLoad(prov, {});
  assert.strictEqual(calls.progress, 1, 'the explicit path is what learns new metadata folder types');
});

check('a silent rescan keeps the banner an earlier real scan earned', async () => {
  const { foldPathKey } = require(path.join(__dirname, '..', 'out', 'metadataScanner.js'));
  ws.folders = [{ uri: { fsPath: proj }, name: 'silent', index: 0 }];
  ws.projectFiles = [path.join(proj, 'sfdx-project.json')];
  const { prov, calls } = scanProvider({ unresolvableFolders: new Set([foldPathKey(unknownDir)]) });
  await doLoad(prov, { silent: true });
  const banner = calls.posted.find(m => m.type === 'scanBanner');
  assert.ok(banner, 'no scan banner was posted at all');
  assert.match(banner.message, /Couldn't resolve metadata type for: mysteryType/,
    'a silent rescan must not wipe a resolution failure it never retried');
});

check('a silent rescan does not escalate a project-discovery failure', async () => {
  resetUi();
  ws.folders = [];              // discovery now fails
  ws.projectFiles = [];
  const { prov, calls } = scanProvider({
    workspaceRoot: proj,
    items: [{ type: 'ApexClass', name: 'DepFixSvc', filePath: 'x', files: ['x'] }]
  });
  await doLoad(prov, { silent: true });
  assert.deepStrictEqual(calls.discoveryFailures, [], 'a stray file event must not empty the tree');
  assert.strictEqual(prov.items.length, 1, 'the last good item list must survive');
  assert.strictEqual(prov.workspaceRoot, proj);
  assert.strictEqual(ui.error.length, 0, 'and it must not pop an error toast nobody asked for');
});

check('an explicit scan still reports a project-discovery failure', async () => {
  ws.folders = [];
  ws.projectFiles = [];
  const { prov, calls } = scanProvider({ workspaceRoot: proj });
  await doLoad(prov, {});
  assert.strictEqual(calls.discoveryFailures.length, 1);
});

// ------------------------------------------------- an EMPTY background rescan
// A valid project whose package directory is not there: exactly what a walk sees
// mid-`git checkout`, mid-branch-switch, or while an editor swaps a tree. The root
// is fine, so none of the discovery guards above fire — the scan simply finds
// nothing.
const vanished = path.join(tmp, 'vanished');
fs.mkdirSync(vanished, { recursive: true });
fs.writeFileSync(path.join(vanished, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app' }] }));
const atVanished = () => {
  ws.folders = [{ uri: { fsPath: vanished }, name: 'vanished', index: 0 }];
  ws.projectFiles = [path.join(vanished, 'sfdx-project.json')];
};
const ONE_ITEM = () => [{ type: 'ApexClass', name: 'DepFixSvc', filePath: 'x', files: ['x'] }];

check('a silent rescan that came back EMPTY is not published as the truth', async () => {
  // Publishing it empties the tree AND, because the webview prunes its persisted
  // selection against whatever list it is handed (auto Fetch Org keeps org
  // membership non-empty, so that prune stays armed), deletes a selection nobody
  // can get back.
  resetUi();
  atVanished();
  const { prov, calls } = scanProvider({ workspaceRoot: vanished, items: ONE_ITEM() });
  await doLoad(prov, { silent: true });
  assert.deepStrictEqual(calls.files, [], 'the empty list reached the webview');
  assert.strictEqual(prov.items.length, 1, 'the last good item list must survive');
  assert.ok(!calls.posted.some(m => m.type === 'scanBanner'),
    'and the tree must not be labelled empty either');
  assert.strictEqual(ui.error.length, 0);
  assert.deepStrictEqual(calls.watchers, [vanished], 'the watcher is still re-pointed at the scanned root');
});

check('an explicit Refresh that genuinely finds nothing behaves exactly as before', async () => {
  atVanished();
  const { prov, calls } = scanProvider({ workspaceRoot: vanished, items: ONE_ITEM() });
  await doLoad(prov, {});
  assert.deepStrictEqual(calls.files.map(f => f.items), [[]], 'the user asked; an empty workspace is the answer');
  assert.strictEqual(prov.items.length, 0);
  const banner = calls.posted.find(m => m.type === 'scanBanner');
  assert.ok(banner && /No metadata found/.test(banner.message), `scan banner was: ${banner && banner.message}`);
  assert.deepStrictEqual(calls.discoveryFailures, [], 'the root is valid — this is not a discovery failure');
});

check('a silent rescan that finds SOMETHING publishes normally', async () => {
  // The guard is about zero, not about being silent: the watcher's whole job is to
  // get a new component into the tree without being asked.
  ws.folders = [{ uri: { fsPath: proj }, name: 'silent', index: 0 }];
  ws.projectFiles = [path.join(proj, 'sfdx-project.json')];
  const { prov, calls } = scanProvider({ workspaceRoot: proj, items: ONE_ITEM() });
  await doLoad(prov, { silent: true });
  assert.strictEqual(calls.files.length, 1);
  assert.ok(calls.files[0].items.some(i => i.name === 'DepFixSvc'));
});

check('an empty FIRST scan still publishes — there is no last good list to keep', async () => {
  atVanished();
  const { prov, calls } = scanProvider({ workspaceRoot: vanished, items: [] });
  await doLoad(prov, { silent: true });
  assert.deepStrictEqual(calls.files.map(f => f.items), [[]], 'the webview would otherwise never hear anything');
});

check('the silent flag rides along on the files message — the webview needs it', () => {
  // The other half of the protection lives in panel.js: a silent post must not
  // prune (and persist) the selection. It can only do that if the wire says so.
  const posted = [];
  const prov = provider({ post: m => posted.push(m) });
  DeployPanelProvider.prototype.postFiles.call(prov, [], { silent: true });
  DeployPanelProvider.prototype.postFiles.call(prov, [], {});
  DeployPanelProvider.prototype.postFiles.call(prov, []);
  assert.deepStrictEqual(posted.map(m => m.silent), [true, undefined, undefined]);
  assert.ok(posted.every(m => m.type === 'files' && Array.isArray(m.items)), 'the payload shape must not have changed');
});

check('a silent scan marks its post, an explicit one does not', async () => {
  ws.folders = [{ uri: { fsPath: proj }, name: 'silent', index: 0 }];
  ws.projectFiles = [path.join(proj, 'sfdx-project.json')];
  const { prov: a, calls: ca } = scanProvider();
  await doLoad(a, { silent: true });
  const { prov: b, calls: cb } = scanProvider();
  await doLoad(b, {});
  assert.deepStrictEqual(ca.files.map(f => f.opts), [{ silent: true }]);
  assert.deepStrictEqual(cb.files.map(f => f.opts), [{ silent: false }]);
});

// ------------------------------------------------------- loadFiles chaining
const loadProvider = () => {
  const calls = [];
  let resolveCurrent;
  const prov = provider({
    loadFilesInflight: undefined,
    loadFilesInflightSilent: false,
    doLoadFiles: opts => {
      calls.push(opts);
      return new Promise(r => { resolveCurrent = r; });
    }
  });
  return { prov, calls, finish: () => { const r = resolveCurrent; r(); } };
};
const load = (prov, opts) => DeployPanelProvider.prototype.loadFiles.call(prov, opts);

check('concurrent scan requests share one scan', async () => {
  const { prov, calls, finish } = loadProvider();
  const a = load(prov, { silent: true });
  const b = load(prov, { silent: true });
  assert.strictEqual(calls.length, 1);
  finish();
  await Promise.all([a, b]);
});

check('a full scan is never answered by the silent one it landed on', async () => {
  // The silent scan skips CLI type resolution; a panel `ready` that joined it
  // would silently lose the unknown-folder resolution it is responsible for.
  const { prov, calls, finish } = loadProvider();
  const silent = load(prov, { silent: true });
  const full = load(prov, {});
  assert.strictEqual(calls.length, 1, 'the full scan must wait rather than start a second concurrent walk');
  finish();
  await silent;
  await flush();
  assert.strictEqual(calls.length, 2, 'and then run for real');
  assert.ok(!calls[1] || !calls[1].silent);
  finish();
  await full;
});

check('a silent request joins a full scan already running', async () => {
  const { prov, calls, finish } = loadProvider();
  const full = load(prov, {});
  const silent = load(prov, { silent: true });
  assert.strictEqual(calls.length, 1, 'a full scan is at least as fresh — no reason to run twice');
  finish();
  await Promise.all([full, silent]);
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed) { console.error(`\n${failed} of ${queue.length} check(s) failed`); process.exit(1); }
  console.log(`file-watch: all ${queue.length} checks passed`);
})();
