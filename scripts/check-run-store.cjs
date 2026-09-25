// Runnable contract test for the Status pane's history store (src/runStore.ts)
// and its wiring in the provider. No framework.
//   1) npm run compile   2) node scripts/check-run-store.cjs
//
// The store decides what survives a window reload, and workspaceState is one
// JSON value per extension, rewritten on every write — so the rules are about
// weight and trust as much as about content:
//   1) only summaries are persisted: the newest run keeps its failures, some
//      skipped rows and what its buttons need; an older run keeps what its
//      one-liner shows, never a retry request or a backup folder; live payloads
//      (a suggestion, the Quick Deploy offer) are posted, never stored; a poll
//      tick is posted, never stored;
//   2) the newest run's full list goes to one file, read back only for that
//      same run and only if it passes its guard — anything else falls back to
//      the summary;
//   3) the history holds the setting's N runs and never evicts a running one;
//      Clear keeps a running one too;
//   4) the first start after an upgrade carries the old cards over as ten
//      button-less notices, once; junk in storage is an empty history, never a
//      throw; a run left `running` by a reload is marked interrupted.
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const assert = require('assert');
const Module = require('module');

let cfgRuns; // the statusHistoryRuns setting as the provider reads it
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? {
  window: { showInformationMessage: () => Promise.resolve(undefined), setStatusBarMessage: () => ({ dispose() {} }) },
  workspace: { getConfiguration: () => ({ get: (k, f) => (k === 'statusHistoryRuns' && cfgRuns !== undefined ? cfgRuns : f) }) },
  commands: { executeCommand: () => Promise.resolve(undefined) },
  Uri: { file: (fsPath) => ({ fsPath }) }
} : origLoad(req, ...rest));

const OUT = path.join(__dirname, '..', 'out');
const { RunStore, RUNS_KEY, NOTICES_KEY, ROWS_FILE } = require(path.join(OUT, 'runStore.js'));
const RR = require(path.join(OUT, 'runRecords.js'));
const { DeployPanelProvider } = require(path.join(OUT, 'panelProvider.js'));

let failed = 0;
const queue = [];
const check = (name, fn) => queue.push([name, fn]);

// ------------------------------------------------------------------ doubles
const T0 = 1_750_000_000_000;
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function host(opts = {}) {
  const state = clone(opts.state || {});
  const posted = [];
  const logs = [];
  const writes = [];
  const h = {
    memento: {
      get: (k) => state[k],
      update: (k, v) => { state[k] = clone(v); writes.push(k); return Promise.resolve(); }
    },
    storageDir: opts.dir,
    post: (m) => posted.push(clone(m)),
    log: (l) => logs.push(l),
    cap: () => (opts.cap === undefined ? 3 : typeof opts.cap === 'function' ? opts.cap() : opts.cap),
    live: opts.live,
    activeRunId: opts.activeRunId
  };
  return { h, state, posted, logs, writes, store: () => new RunStore(h) };
}
const runsPosts = (x) => x.posted.filter(m => m.type === 'runs');
const lastRuns = (x) => runsPosts(x).slice(-1)[0];

/** A run record the way the result builders make them: `failures` failed rows,
 *  `ok` rolled-back rows, `skipped` skipped rows, `tests` failed tests. */
function run(id, { at = T0, status = 'failed', failures = 0, ok = 0, skipped = 0, tests = 0, msgLen = 40, op = 'deploy', extra = {} } = {}) {
  const rows = [];
  for (let i = 0; i < failures; i++) rows.push({ k: `ApexClass:${id}Fail${i}`, o: 'failed', s: 1, m: `problem ${i} `.padEnd(msgLen, 'x'), l: i + 1, c: 1, f: `${id}Fail${i}.cls` });
  for (let i = 0; i < ok; i++) rows.push({ k: `CustomField:Acme__c.${id}F${i}__c`, o: status === 'succeeded' ? 'deployed' : 'rolledback', s: 1 });
  for (let i = 0; i < skipped; i++) rows.push({ k: `Report:AcmeReports/${id}R${i}`, o: 'skipped', why: 'org' });
  const testRows = Array.from({ length: tests }, (_, i) => ({ cls: `${id}Test${i}`, method: `test${i}`, m: 'Assertion Failed', l: 3, c: 1 }));
  const counts = { failed: failures, skipped, sent: failures + ok };
  counts[status === 'succeeded' ? 'deployed' : 'rolledback'] = ok;
  return Object.assign({
    v: 1, id, op, status, org: 'acme-prod-user', orgLabel: 'acme-prod', orgKind: 'prod',
    startedAt: at, finishedAt: status === 'running' ? undefined : at + 1000, target: 'selection', testLevel: 'RunLocalTests',
    counts, rows, rowsComplete: true, tests: testRows,
    retry: { validateOnly: false, testLevel: 'RunLocalTests' }, conflict: true, backupDir: '/ws/.backups/x', suggestId: 'sug-1-1',
    jobId: '0AfAc000001kR2mSAE', notes: ['a note'], message: 'M'.repeat(1500)
  }, extra);
}
async function tmpDir() { return fsp.mkdtemp(path.join(os.tmpdir(), 'run-store-')); }

// ============================================== 1) what is persisted
check('a 10k-row run is persisted as a summary (the full list only in the post), well under 40 KB', () => {
  const x = host();
  const s = x.store();
  const big = run('runbig01', { failures: 300, ok: 9000, skipped: 700, tests: 60, msgLen: 500 });
  s.finish(big);
  const kept = x.state[RUNS_KEY];
  assert.strictEqual(kept.v, 1);
  assert.strictEqual(kept.runs.length, 1);
  assert.ok(kept.runs[0].rows.length <= 150, `${kept.runs[0].rows.length} rows persisted`);
  assert.ok(RR.packedSize(kept) <= RR.LATEST_SUMMARY_MAX_BYTES + 100, `${RR.packedSize(kept)} bytes persisted`);
  assert.deepStrictEqual(kept.runs[0].counts, big.counts, 'counts stay exact');
  const post = lastRuns(x);
  assert.strictEqual(post.latestRows.runId, 'runbig01');
  assert.strictEqual(post.latestRows.rows.length, 10_000, 'the webview gets every row');
});

check('when a newer run arrives, the old newest is re-summarized: no retry, no backup, no suggestion, no conflict, 25 failures', () => {
  const x = host();
  const s = x.store();
  s.finish(run('runold01', { at: T0, failures: 60, skipped: 30 }));
  s.finish(run('runnew01', { at: T0 + 5000, failures: 2 }));
  const [newest, older] = x.state[RUNS_KEY].runs;
  assert.deepStrictEqual([newest.id, older.id], ['runnew01', 'runold01']);
  for (const k of ['retry', 'backupDir', 'suggestId', 'conflict', 'notes']) assert.ok(!(k in older), `older run kept ${k}`);
  assert.strictEqual(older.rows.length, 25);
  assert.ok(older.rows.every(r => r.o === 'failed'));
  assert.ok(RR.packedSize(older) <= RR.OLDER_SUMMARY_MAX_BYTES);
  assert.deepStrictEqual(newest.retry, { validateOnly: false, testLevel: 'RunLocalTests' }, 'the newest keeps what Retry needs');
  assert.strictEqual(newest.backupDir, '/ws/.backups/x');
});

check('live payloads are posted with the newest run and never stored', () => {
  const x = host({ live: (r) => (r.id === 'runqd001' ? { quick: { jobId: '0AfAc000001kM7pSAE', until: T0 + 10 }, suggest: { id: 'sug-1-1', candidates: [{ key: 'ApexClass:A' }], unresolved: [] } } : undefined) });
  const s = x.store();
  s.finish(run('runqd001', { status: 'succeeded', ok: 3, op: 'validate' }));
  const posted = lastRuns(x).runs[0];
  assert.strictEqual(posted.quick.jobId, '0AfAc000001kM7pSAE');
  assert.strictEqual(posted.suggest.id, 'sug-1-1');
  const kept = x.state[RUNS_KEY].runs[0];
  assert.ok(!('quick' in kept) && !('suggest' in kept), JSON.stringify(Object.keys(kept)));
});

check('a poll tick is posted as numbers only, and never written', () => {
  const x = host();
  const s = x.store();
  s.begin(run('runlive1', { status: 'running', skipped: 5 }));
  const writes = x.writes.length;
  s.progress('runlive1', { orgStatus: 'InProgress', compDone: 12, compTotal: 40, testDone: 0, testTotal: 9, errors: 1, details: { componentFailures: [{}] } });
  assert.strictEqual(x.writes.length, writes, 'a tick must not rewrite workspaceState');
  assert.deepStrictEqual(x.posted.slice(-1)[0], { type: 'runProgress', id: 'runlive1', orgStatus: 'InProgress', compDone: 12, compTotal: 40, testDone: 0, testTotal: 9, errors: 1 });
});

check('begin persists the running run and posts its known rows; update persists a job id', () => {
  const x = host();
  const s = x.store();
  s.begin(run('runlive2', { status: 'running', ok: 5, skipped: 3, extra: { jobId: undefined } }));
  assert.strictEqual(x.state[RUNS_KEY].runs[0].status, 'running');
  assert.strictEqual(lastRuns(x).latestRows.rows.length, 8);
  s.update('runlive2', { jobId: '0AfAc000001kS4vSAE' });
  assert.strictEqual(x.state[RUNS_KEY].runs[0].jobId, '0AfAc000001kS4vSAE');
  s.update('nosuchrun', { jobId: '0AfAc000001kS4vSAE' });
});

check('end: a begun run finishes with what was known at the start, rows complete', () => {
  const x = host();
  const s = x.store();
  s.begin(run('runlost1', { status: 'running', ok: 40, skipped: 2 }));
  assert.strictEqual(s.end('runlost1', { status: 'lost', finishedAt: T0 + 9 }), true);
  const post = lastRuns(x);
  assert.strictEqual(post.runs[0].status, 'lost');
  assert.strictEqual(post.latestRows.rows.length, 42);
  assert.strictEqual(x.state[RUNS_KEY].runs[0].status, 'lost');
  assert.strictEqual(s.end('nosuchrun', { status: 'error' }), false, 'an unknown run is reported some other way');
});

// ====================================================== 2) the rows file
check('the newest run\'s full list goes to the rows file and comes back after a reload — only for that run', async () => {
  const dir = await tmpDir();
  try {
    const a = host({ dir });
    const s = a.store();
    s.finish(run('runfile1', { failures: 3, ok: 500, skipped: 2 }));
    await s.whenWritten();
    const file = path.join(dir, ROWS_FILE);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(onDisk.runId, 'runfile1');
    assert.strictEqual(onDisk.rows.length, 505);
    assert.ok(!fs.existsSync(`${file}.tmp`), 'the temp file is renamed away');

    // The reload: a new store over the same state and folder.
    const b = host({ dir, state: a.state });
    await b.store().postReady();
    const post = lastRuns(b);
    assert.strictEqual(post.latestRows.runId, 'runfile1');
    assert.strictEqual(post.latestRows.rows.length, 505);
    // The next result replaces the file whole (a new file renamed over it), so a
    // reader never meets a half-written one: the directory entry points at a new
    // inode rather than the old file rewritten in place.
    const before = fs.statSync(file).ino;
    s.finish(run('runfile2', { ok: 3 }));
    await s.whenWritten();
    if (before !== 0) assert.notStrictEqual(fs.statSync(file).ino, before, 'the rows file was rewritten in place');
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).runId, 'runfile2');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

check('a rows file for another run, a corrupt one or none at all: the newest run falls back to its summary', async () => {
  const dir = await tmpDir();
  try {
    const a = host({ dir });
    const sa = a.store();
    sa.finish(run('runfilea', { ok: 50 }));
    await sa.whenWritten();
    // The history now says another run is the newest, but the file is still A's.
    const state = clone(a.state);
    state[RUNS_KEY].runs[0] = RR.summarizeRun(run('runfileb', { ok: 7 }), { latest: true });
    const mismatch = host({ dir, state });
    await mismatch.store().postReady();
    assert.strictEqual(lastRuns(mismatch).runs[0].id, 'runfileb', 'fixture: the history must hold the other run');
    assert.ok(!('latestRows' in lastRuns(mismatch)), 'another run\'s rows must never be shown as this run\'s');
    fs.writeFileSync(path.join(dir, ROWS_FILE), '{"v":1,"runId":"runfilea","rows":[{"k":');
    const corrupt = host({ dir, state: a.state });
    await corrupt.store().postReady();
    assert.strictEqual(lastRuns(corrupt).runs[0].id, 'runfilea', 'fixture: the history must hold the run');
    assert.ok(!('latestRows' in lastRuns(corrupt)));
    assert.ok(corrupt.logs.some(l => /rows file read failed/.test(l)), 'a corrupt file is logged');
    fs.rmSync(path.join(dir, ROWS_FILE));
    const missing = host({ dir, state: a.state });
    await missing.store().postReady();
    assert.ok(!('latestRows' in lastRuns(missing)));
    assert.ok(!missing.logs.length, 'a missing file is not an error');
    const nowhere = host({ state: a.state });
    await nowhere.store().postReady();
    assert.ok(!('latestRows' in lastRuns(nowhere)));
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

check('rows read back from the file pass the same guard as the history', async () => {
  const dir = await tmpDir();
  try {
    const a = host({ dir });
    const sg = a.store();
    sg.finish(run('runguard', { ok: 1 }));
    await sg.whenWritten();
    fs.writeFileSync(path.join(dir, ROWS_FILE), JSON.stringify({ v: 1, runId: 'runguard', rows: [
      { k: 'ApexClass:Fine', o: 'deployed', s: 1 }, { k: 'no-colon', o: 'deployed' }, { k: 'ApexClass:X', o: 'exploded' }, { k: 'ApexClass:Y', o: 'failed', f: '../../etc/passwd' }
    ], tests: [{ cls: 'T', method: 'm', m: 'x' }, { cls: 7 }] }));
    const b = host({ dir, state: a.state });
    await b.store().postReady();
    assert.deepStrictEqual(lastRuns(b).latestRows.rows, [{ k: 'ApexClass:Fine', o: 'deployed', s: 1 }, { k: 'ApexClass:Y', o: 'failed' }]);
    assert.deepStrictEqual(lastRuns(b).latestRows.tests, [{ cls: 'T', method: 'm', m: 'x' }]);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

check('only the newest run writes the file: finishing an older run leaves it alone', async () => {
  const dir = await tmpDir();
  try {
    const x = host({ dir });
    const s = x.store();
    s.finish(run('runolder', { at: T0, ok: 1 }));
    s.begin(run('runnewer', { at: T0 + 10, status: 'running', ok: 2 }));
    s.finish(run('runolder', { at: T0, ok: 99 }));   // a late result for the older run
    await s.whenWritten();
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, ROWS_FILE), 'utf8')).runId, 'runolder', 'its first finish wrote while it was newest');
    const rows = JSON.parse(fs.readFileSync(path.join(dir, ROWS_FILE), 'utf8')).rows.length;
    assert.strictEqual(rows, 1, 'the late finish (99 rows) of a run that is no longer newest must not overwrite the file');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

// ================================================== 3) N, trim, Clear
check('the history keeps the setting\'s N runs, newest first — never evicting a running one', () => {
  let cap = 2;
  const x = host({ cap: () => cap });
  const s = x.store();
  s.finish(run('runcap01', { at: T0 + 1 }));
  s.finish(run('runcap02', { at: T0 + 2 }));
  s.finish(run('runcap03', { at: T0 + 3 }));
  assert.deepStrictEqual(x.state[RUNS_KEY].runs.map(r => r.id), ['runcap03', 'runcap02']);
  s.begin(run('runcap04', { at: T0 + 4, status: 'running' }));
  cap = 1;
  s.setCap();
  assert.deepStrictEqual(x.state[RUNS_KEY].runs.map(r => r.id), ['runcap04']);
  assert.deepStrictEqual(lastRuns(x).runs.map(r => r.id), ['runcap04'], 'the change is posted');
  assert.strictEqual(lastRuns(x).cap, 1);
  cap = 99;
  s.setCap();
  assert.strictEqual(lastRuns(x).cap, 10, 'the setting is clamped');
});

check('a running run is kept even when N newer finished runs push it out', () => {
  const x = host({ cap: 1 });
  const s = x.store();
  s.begin(run('runlong1', { at: T0, status: 'running' }));
  s.finish(run('runafter', { at: T0 + 5 }));
  assert.deepStrictEqual(x.state[RUNS_KEY].runs.map(r => r.id), ['runafter', 'runlong1']);
});

check('Clear drops notices, finished runs and the rows file; a running run stays', async () => {
  const dir = await tmpDir();
  try {
    const x = host({ dir });
    const s = x.store();
    s.pushNotice({ kind: 'ok', title: 'Fetched 10 components' });
    s.finish(run('runclr01', { at: T0, ok: 3 }));
    await s.whenWritten();
    assert.ok(fs.existsSync(path.join(dir, ROWS_FILE)));
    s.begin(run('runclr02', { at: T0 + 1, status: 'running', skipped: 2 }));
    await s.clear();
    assert.deepStrictEqual(x.state[NOTICES_KEY], []);
    assert.deepStrictEqual(x.state[RUNS_KEY].runs.map(r => r.id), ['runclr02']);
    assert.ok(!fs.existsSync(path.join(dir, ROWS_FILE)), 'the rows file is deleted');
    assert.deepStrictEqual(lastRuns(x).runs.map(r => r.id), ['runclr02']);
    await s.clear();
    assert.deepStrictEqual(x.state[RUNS_KEY].runs.map(r => r.id), ['runclr02'], 'Clear never drops the running run');
    // A write cut off before its rename leaves a temp file: Clear takes it too.
    fs.writeFileSync(path.join(dir, `${ROWS_FILE}.tmp`), '{"v":1');
    await s.clear();
    assert.ok(!fs.existsSync(path.join(dir, `${ROWS_FILE}.tmp`)), 'the leftover temp file is deleted');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

check('resume: an interrupted run runs again without the "wasn\'t recorded" note, and keeps its other notes', () => {
  const r = run('runres01', { status: 'running' });
  r.notes = ['Re-attached after a window reload: only what acme-dev\'s report contains.'];
  const x = host({ state: { [RUNS_KEY]: { v: 1, runs: [r] }, [NOTICES_KEY]: [] } });
  const s = x.store();
  assert.strictEqual(s.runs()[0].status, 'interrupted');
  assert.ok(RR.INTERRUPTED_NOTES.includes(s.runs()[0].notes[0]));
  assert.strictEqual(s.resume('runres01'), true);
  assert.strictEqual(s.runs()[0].status, 'running');
  assert.deepStrictEqual(s.runs()[0].notes, r.notes);
  assert.deepStrictEqual(lastRuns(x).runs[0].notes, r.notes, 'and the pane is told');
});

check('a run with only its summary\'s rows is never posted or written as the full list', async () => {
  const dir = await tmpDir();
  try {
    const x = host({ dir });
    const s = x.store();
    const partial = Object.assign(run('runprt01', { skipped: 60 }), { rowsComplete: false });
    partial.rows = partial.rows.slice(0, 50);
    s.finish(partial);
    await s.whenWritten();
    assert.ok(!('latestRows' in lastRuns(x)), 'no full list to post');
    assert.ok(!fs.existsSync(path.join(dir, ROWS_FILE)), 'and none written');
    assert.strictEqual(lastRuns(x).runs[0].rowsComplete, false);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

// ============================================ 4) migration, junk, interruption
const LEGACY = () => Array.from({ length: 50 }, (_, i) => ({
  kind: i % 3 ? 'ok' : 'err', title: `Card ${i}`, at: T0 - i,
  buttons: [{ label: 'Retry deploy', send: { type: 'retryDeploy', request: { keys: Array.from({ length: 5000 }, (_, k) => `ApexClass:K${k}`) } } }],
  quickDeploy: { jobId: '0AfAc000001kM7pSAE' }
}));

check('first start after an upgrade: 50 old cards become the 10 newest, button-less; the new history is written', () => {
  const x = host({ state: { [NOTICES_KEY]: LEGACY() } });
  const s = x.store();
  assert.deepStrictEqual(s.notices().map(n => n.title), LEGACY().slice(0, 10).map(c => c.title));
  assert.ok(s.notices().every(n => !('buttons' in n) && !('quickDeploy' in n)));
  assert.deepStrictEqual(x.state[RUNS_KEY], { v: 1, runs: [] });
  assert.strictEqual(x.state[NOTICES_KEY].length, 10, 'the carried-over notices are written back, bounded');
  assert.ok(RR.packedSize(x.state[NOTICES_KEY]) < 5000, 'no old Retry key list survives');
});

check('the carry-over happens once: a second start rewrites nothing', () => {
  const first = host({ state: { [NOTICES_KEY]: LEGACY() } });
  first.store().notices();
  const again = host({ state: first.state });
  const s = again.store();
  assert.deepStrictEqual(s.notices(), first.state[NOTICES_KEY]);
  assert.deepStrictEqual(s.runs(), []);
  assert.deepStrictEqual(again.writes, [], 'a second start must not write');
});

check('junk in storage is an empty history, never a throw', () => {
  for (const state of [
    { [NOTICES_KEY]: 'nonsense', [RUNS_KEY]: 'nonsense' },
    { [NOTICES_KEY]: [null, 7, 'x'], [RUNS_KEY]: { v: 1, runs: 'x' } },
    { [RUNS_KEY]: { v: 1, runs: [{ id: 'bad' }, null, 5] } },
    { [RUNS_KEY]: { v: 2, runs: [run('runfut01')] } }
  ]) {
    const s = host({ state }).store();
    assert.deepStrictEqual(s.runs(), [], JSON.stringify(state).slice(0, 80));
    assert.ok(Array.isArray(s.notices()));
  }
  const throwing = new RunStore({ memento: { get: () => { throw new Error('db locked'); }, update: () => undefined }, post: () => {}, log: () => {}, cap: () => 3 });
  assert.deepStrictEqual(throwing.runs(), []);
});

check('a run left running by a reload is marked interrupted (and persisted); the one this window drives is not', () => {
  const kept = { v: 1, runs: [
    RR.summarizeRun(run('runint01', { at: T0 + 2, status: 'running', skipped: 2 }), { latest: true }),
    RR.summarizeRun(run('runint02', { at: T0 + 1, status: 'running', op: 'retrieve' }), { latest: false })
  ] };
  const x = host({ state: { [RUNS_KEY]: kept, [NOTICES_KEY]: [] } });
  const [a, b] = x.store().runs();
  assert.strictEqual(a.status, 'interrupted');
  assert.strictEqual(a.notes[0], "The window closed while this ran; its result wasn't recorded. Check Deployment Status in the org.");
  assert.strictEqual(b.notes[0], "The window closed while this ran; its result wasn't recorded, and files may be partly written.");
  assert.strictEqual(x.state[RUNS_KEY].runs[0].status, 'interrupted', 'the correction is persisted');
  const live = host({ state: { [RUNS_KEY]: kept, [NOTICES_KEY]: [] }, activeRunId: () => 'runint01' });
  assert.strictEqual(live.store().runs()[0].status, 'running');
});

check('notices are bounded to 10, newest first, buttons and Quick Deploy stripped, the live card untouched', () => {
  const x = host();
  const s = x.store();
  const live = { kind: 'ok', title: 'Retrieved 2', quickDeploy: { jobId: 'x' }, buttons: [{ label: 'Restore backup…', send: { type: 'restoreBackup', dir: '/b' } }], errText: 'e'.repeat(9000), lines: Array.from({ length: 150 }, (_, i) => `line ${i}`) };
  for (let i = 0; i < 11; i++) s.pushNotice({ kind: 'ok', title: `N${i}` });
  s.pushNotice(live);
  const kept = x.state[NOTICES_KEY];
  assert.strictEqual(kept.length, 10);
  assert.strictEqual(kept[0].title, 'Retrieved 2');
  assert.ok(!('buttons' in kept[0]) && !('quickDeploy' in kept[0]));
  assert.ok(kept[0].errText.length < 8100 && kept[0].errText.endsWith('(truncated in history)'));
  assert.strictEqual(kept[0].lines.length, 101);
  assert.strictEqual(live.buttons.length, 1, 'the live card keeps its buttons');
});

// ============================================ the provider's wiring
function provider(state, extra = {}) {
  const posted = [];
  const s = Object.create(DeployPanelProvider.prototype);
  Object.assign(s, {
    busy: false, cmdSeq: 0, cmdLog: [], deployQueue: [], liveSuggestions: new Map(),
    items: [], workspaceRoot: undefined, orgs: [], orgMembers: new Map(),
    output: { appendLine: () => {} },
    context: {
      workspaceState: { get: (k) => state[k], update: (k, v) => { state[k] = clone(v); return Promise.resolve(); } },
      globalState: { get: () => undefined, update: async () => {} },
      storageUri: extra.dir ? { fsPath: extra.dir } : undefined
    },
    view: { visible: true, webview: { postMessage: () => {} } },
    loadFiles: async () => {}, loadOrgs: async () => {}, sendActiveFile: () => {},
    maybeReattachDeploy: () => {}, maybeAutoFetchOrg: () => {},
    post: m => posted.push(clone(m))
  });
  return { s, posted, state };
}

check('ready posts the notices, then the runs with the newest run\'s full list from the rows file', async () => {
  const dir = await tmpDir();
  try {
    const first = provider({}, { dir });
    const store = first.s.runStore;
    store.pushNotice({ kind: 'ok', title: 'Fetched 3 components', at: T0 });
    store.finish(run('runready', { ok: 20, failures: 1 }));
    await store.whenWritten();
    const reload = provider(first.state, { dir });
    await DeployPanelProvider.prototype.handleMessage.call(reload.s, { type: 'ready' });
    const types = reload.posted.map(m => m.type);
    assert.ok(types.indexOf('statusHistory') >= 0 && types.indexOf('statusHistory') < types.indexOf('runs'), types.join(','));
    const r = reload.posted.find(m => m.type === 'runs');
    assert.strictEqual(r.runs[0].id, 'runready');
    assert.strictEqual(r.latestRows.rows.length, 21);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

check('clearStatusHistory clears notices and finished runs through the store', async () => {
  const p = provider({});
  p.s.runStore.pushNotice({ kind: 'ok', title: 'x' });
  p.s.runStore.finish(run('runclr09'));
  await DeployPanelProvider.prototype.handleMessage.call(p.s, { type: 'clearStatusHistory' });
  assert.deepStrictEqual(p.state[NOTICES_KEY], []);
  assert.deepStrictEqual(p.state[RUNS_KEY].runs, []);
  assert.deepStrictEqual(p.posted.filter(m => m.type === 'runs').slice(-1)[0].runs, []);
});

check('the statusHistoryRuns setting trims the history when it changes (read through VS Code\'s configuration)', () => {
  const p = provider({});
  cfgRuns = 3;
  for (let i = 1; i <= 3; i++) p.s.runStore.finish(run(`runset0${i}`, { at: T0 + i }));
  cfgRuns = 1;
  p.s.runStore.setCap();
  assert.deepStrictEqual(p.state[RUNS_KEY].runs.map(r => r.id), ['runset03']);
  cfgRuns = undefined;
});

check('the setting change is wired: the provider listens for sfOrgDeployWrapper.statusHistoryRuns', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'panelProvider.ts'), 'utf8');
  assert.ok(src.includes("if (e.affectsConfiguration('sfOrgDeployWrapper.statusHistoryRuns')) this.runStore.setCap();"));
});

check('runStore.js loads without vscode', () => {
  const src = fs.readFileSync(path.join(OUT, 'runStore.js'), 'utf8');
  assert.ok(!/require\(["']vscode["']\)/.test(src));
});

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
check('this harness is registered in package.json "check"', () => {
  assert.ok(pkg.scripts.check.includes('node ./scripts/check-run-store.cjs'));
});

process.exitCode = 1;
(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
  }
  if (failed) { console.error(`run-store: ${failed}/${queue.length} checks FAILED`); process.exit(1); }
  console.log(`run-store: all ${queue.length} checks passed`);
  process.exitCode = 0;
})();
