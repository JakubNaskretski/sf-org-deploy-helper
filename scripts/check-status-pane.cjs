// Runnable contract test for the Status pane's run cards as the webview draws
// them (src/panel.js + src/runView.js in the DOM shim). No framework.
//   1) npm run compile   2) node scripts/check-status-pane.cjs
//
// A green pure-logic suite over a dead UI is the failure this exists for, so
// everything here goes through the drawn DOM and the messages it posts:
//   1) the list is virtual — 11,582 rows put at most a few dozen nodes in the
//      DOM, and scrolling the pane (the list's only scroller) paints exactly the
//      rows in view plus the overscan, down to the very last row, wherever the
//      list sits inside the pane;
//   2) the chips filter, a file link opens only a component the workspace has,
//      and the keyboard walks, folds, opens and copies;
//   3) the Earlier toggle lists older runs and notices, and an older run
//      expands read-only — its only button is Copy;
//   4) a newest run's full list survives a later post without one only while
//      the same run is still the newest;
//   5) with no runs at all, the pane is the plain card list it always was.
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const { panel } = require('./lib/dom-shim.cjs');
const RV = require(path.join(__dirname, '..', 'src', 'runView.js'));
const RR = require(path.join(__dirname, '..', 'out', 'runRecords.js'));
const F = require('./lib/run-fixtures.cjs');

let failed = 0;
let ran = 0;
const waiting = [];
function check(name, fn) {
  ran++;
  const fail = (e) => { failed++; console.error(`FAIL ${name}: ${e.message}`); };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') waiting.push(r.catch(fail));
  } catch (e) { fail(e); }
}
const pause = (ms) => new Promise(r => setTimeout(r, ms));

const NOW = Date.now();
const SC = F.buildScenarios(NOW);
const S = (id) => SC.find(x => x.id === id);
const LOCAL = F.localItems(SC);
const runsMsg = (id, opts) => F.runsMessage(SC, id, Object.assign({ summarize: RR.summarizeRun, cap: 3 }, opts || {}));

function boot(opts = {}) {
  const p = panel({ selected: [], expandedGroups: [], filter: '', typeFilter: [], viewMode: 'all', testClasses: '' });
  p.deliver({ type: 'orgs', orgs: [{ username: 'acme-dev-user', alias: 'acme-dev', label: 'acme-dev (acme-dev-user)', kind: 'sandbox' }], selected: 'acme-dev-user' });
  p.deliver({ type: 'files', objectChildTypes: [], items: opts.items || LOCAL });
  p.el('status').clientHeight = opts.height || 200;
  if (opts.notices) p.deliver({ type: 'statusHistory', cards: opts.notices });
  if (opts.scenario) p.deliver(runsMsg(opts.scenario, opts.msg));
  return p;
}
const has = (e, c) => !!(e && e._classes && e._classes.has(c));
const listOf = (p) => p.el('status').find(e => has(e, 'run-list'));
const rowNodes = (p) => listOf(p).children.filter(e => has(e, 'run-row'));
const idx = (e) => Number(e.id.slice('run-row-'.length));
const painted = (p) => rowNodes(p).map(idx).sort((a, b) => a - b);
const chipBtn = (p, id) => p.el('status').find(e => e.tagName === 'BUTTON' && e.dataset.chip === id);
const actBtn = (p, id) => p.el('status').find(e => e.tagName === 'BUTTON' && e.dataset.act === id);
// Copied out of the page's realm, so deepStrictEqual compares values, not prototypes.
const sent = (p, type) => JSON.parse(JSON.stringify(p.outbound.filter(m => m.type === type)));
const click = (b) => { assert.ok(b, 'no such control'); assert.ok(!b.disabled, `${b.textContent} is disabled`); b.fire('click'); };
const text = (e) => (e ? [e.textContent, ...e.children.map(text)].join('') : '');
/** Scroll the pane and let the frame's repaint run. */
function scrollTo(p, top) { const st = p.el('status'); st.scrollTop = top; st.fire('scroll'); p.flush(); }
/** The rows the view [top, top + height) of the list meets, plus 6 either side
 *  — worked out from the row heights, independently of the paint code. */
function expectedWindow(model, top, height) {
  const n = model.rows.length;
  let first = -1, last = -1;
  for (let i = 0; i < n; i++) {
    const a = model.offsets[i], b = model.offsets[i + 1];
    if (b > top && a < top + height) { if (first < 0) first = i; last = i; }
  }
  if (first < 0) { first = top < 0 ? 0 : n - 1; last = first; }
  const out = [];
  for (let i = Math.max(0, first - 6); i < Math.min(n, last + 7); i++) out.push(i);
  return out;
}

// =================================================== 1) the virtual list
check('11,582 rows, every group open: a ~200 px pane holds a few dozen row nodes, never thousands', () => {
  const p = boot({ scenario: 'fxbigdeploy' });
  click(p.el('status').find(e => e.tagName === 'BUTTON' && e.textContent === 'Expand'));
  assert.strictEqual(listOf(p).style.height, `${25 * 24 + 11582 * 22}px`);
  assert.ok(rowNodes(p).length <= 60, `${rowNodes(p).length} nodes`);
  assert.ok(rowNodes(p).length > 0);
});

check('scrolling paints exactly the rows in view plus the overscan — measured from where the list sits in the pane', () => {
  const p = boot({ scenario: 'fxbigdeploy' });
  click(p.el('status').find(e => e.tagName === 'BUTTON' && e.textContent === 'Expand'));
  const list = listOf(p);
  list.offsetTop = 400; // the card header, Earlier, notices… above the list
  const s = S('fxbigdeploy');
  const model = RV.buildRows(runsMsg('fxbigdeploy').runs[0], s.run.rows, s.run.tests, { filter: 'all', q: '', folds: {}, openAll: true });
  for (const at of [0, 350, 5000, 123457, 200000]) {
    scrollTo(p, 400 + at);
    assert.deepStrictEqual(painted(p), expectedWindow(model, at, 200), `list scrolled to ${at}px`);
    assert.ok(rowNodes(p).length <= 60, `${rowNodes(p).length} nodes at ${at}px`);
  }
  // A row's box is where its offset says: the paint and the layout agree.
  for (const e of rowNodes(p)) assert.strictEqual(e.style.top, `${model.offsets[idx(e)]}px`);
});

check('scrolled to the very bottom, the last row is painted', () => {
  const p = boot({ scenario: 'fxbigdeploy' });
  click(p.el('status').find(e => e.tagName === 'BUTTON' && e.textContent === 'Expand'));
  listOf(p).offsetTop = 300;
  const total = 25 * 24 + 11582 * 22;
  scrollTo(p, 300 + total - 200);
  const last = 11582 + 25 - 1;
  assert.ok(painted(p).includes(last), `last painted ${painted(p).slice(-1)[0]}, want ${last}`);
  assert.strictEqual(painted(p).slice(-1)[0], last);
});

check('a taller pane (the splitter, a resize) repaints to fill it', () => {
  const p = boot({ scenario: 'fxbigdeploy' });
  click(p.el('status').find(e => e.tagName === 'BUTTON' && e.textContent === 'Expand'));
  scrollTo(p, 2000);
  const before = rowNodes(p).length;
  p.el('status').clientHeight = 600;
  assert.ok(p.resizeObservers.length > 0, 'the pane is observed');
  for (const ro of p.resizeObservers) if (ro.targets.has(p.el('status'))) ro.cb([]);
  p.flush();
  assert.ok(rowNodes(p).length > before + 10, `${before} → ${rowNodes(p).length}`);
});

// ============================================== 2) chips, links, keyboard
check('a chip filters the list, presses, and moves the explain line and the Select/Copy labels with it', () => {
  const p = boot({ scenario: 'fxdeployfail' });
  assert.strictEqual(chipBtn(p, 'all').getAttribute('aria-pressed'), 'true');
  click(chipBtn(p, 'failed'));
  assert.strictEqual(chipBtn(p, 'failed').getAttribute('aria-pressed'), 'true');
  assert.strictEqual(chipBtn(p, 'all').getAttribute('aria-pressed'), 'false');
  const leafs = rowNodes(p).filter(e => has(e, 'leaf'));
  assert.ok(leafs.length > 0 && leafs.every(e => has(e.children[0], 'g-err')), 'only failed rows');
  assert.strictEqual(text(p.el('status').find(e => has(e, 'run-explain'))), 'acme-prod rejected these. A deploy is all-or-nothing, so nothing from this run was applied.');
  assert.strictEqual(actBtn(p, 'select').textContent, 'Select 41 failed in tree');
  assert.strictEqual(actBtn(p, 'copy').textContent, 'Copy failed rows');
  click(actBtn(p, 'select'));
  assert.strictEqual(sent(p, 'selectDeployed')[0].keys.length, 41);
});

check('a disabled chip does nothing (Failed 0 on a clean deploy)', () => {
  const p = boot({ scenario: 'fxbigdeploy' });
  const c = chipBtn(p, 'failed');
  assert.strictEqual(c.disabled, true);
  c.fire('click');
  assert.strictEqual(chipBtn(p, 'all').getAttribute('aria-pressed'), 'true');
});

check('a file:line link opens the source — only for a component the workspace has', () => {
  const s = S('fxdeployfail');
  const failing = s.run.rows.filter(r => r.o === 'failed' && r.l);
  const gone = failing[0].k; // pretend this one was deleted from the project since
  // A pane tall enough that all 41 failures are painted at once.
  const p = boot({ scenario: 'fxdeployfail', items: LOCAL.filter(i => `${i.type}:${i.name}` !== gone), height: 5000 });
  click(chipBtn(p, 'failed'));
  const rowFor = (key) => rowNodes(p).find(e => has(e, 'leaf') && e.find(x => has(x, 'run-name') && x.title.startsWith(key + ' ')));
  const local = rowFor(failing[1].k);
  assert.ok(local, 'the local failure is painted');
  const link = local.find(x => has(x, 'run-link'));
  assert.ok(link, 'a local failure has a link');
  link.fire('click');
  assert.deepStrictEqual(sent(p, 'openFile').map(m => [m.key, m.line, m.column]), [[failing[1].k, failing[1].l, failing[1].c]]);
  const orphan = rowFor(gone);
  assert.ok(orphan, 'the missing one is painted too');
  assert.ok(!orphan.find(x => has(x, 'run-link')), 'no link for a component the workspace no longer has');
  assert.ok(orphan.find(x => has(x, 'run-loc')), 'its position is still shown, as text');
  orphan.fire('click');
  assert.strictEqual(sent(p, 'openFile').length, 1, 'clicking it opens nothing');
});

check('keyboard: ↓ moves the focus, End reaches (and paints) the last row, Enter folds a group and opens a local leaf, c copies', () => {
  const p = boot({ scenario: 'fxtestsfail' });
  const list = listOf(p);
  list.fire('focus');
  const focused = () => rowNodes(p).find(e => has(e, 'focused'));
  assert.ok(focused(), 'focusing the list focuses a row');
  const first = idx(focused());
  list.fire('keydown', { key: 'ArrowDown' });
  assert.ok(idx(focused()) > first);
  assert.strictEqual(list.getAttribute('aria-activedescendant'), `run-row-${idx(focused())}`);
  list.fire('keydown', { key: 'End' });
  const model = RV.buildRows(runsMsg('fxtestsfail').runs[0], S('fxtestsfail').run.rows, S('fxtestsfail').run.tests, { filter: 'all', q: '', folds: {} });
  assert.strictEqual(idx(focused()), model.rows.length - 1);
  assert.ok(p.el('status').scrollTop > 0, 'the pane scrolled to show it');
  list.fire('keydown', { key: 'Enter' }); // a test failure in a local class opens at its line
  const t = model.rows[model.rows.length - 1].test;
  assert.deepStrictEqual(sent(p, 'openFile').slice(-1).map(m => [m.key, m.line]), [[`ApexClass:${t.cls}`, t.l]]);
  list.fire('keydown', { key: 'c' });
  assert.ok(sent(p, 'copyText').slice(-1)[0].text.startsWith(`${t.cls}.${t.method} — line ${t.l}`));
  list.fire('keydown', { key: 'Home' });
  const g = focused();
  assert.ok(has(g, 'group'), 'Home lands on the first group');
  const before = g.getAttribute('aria-expanded');
  list.fire('keydown', { key: 'Enter' });
  assert.notStrictEqual(focused().getAttribute('aria-expanded'), before, 'Enter folds / unfolds it');
  list.fire('keydown', { key: before === 'true' ? 'ArrowRight' : 'ArrowLeft' });
  assert.strictEqual(focused().getAttribute('aria-expanded'), before, '← → fold too');
});

check('clicking a group row folds it; the search box narrows the list after a short pause', async () => {
  const p = boot({ scenario: 'fxdeployfail' });
  const g = rowNodes(p).find(e => has(e, 'group'));
  const was = g.getAttribute('aria-expanded');
  g.fire('click');
  assert.notStrictEqual(rowNodes(p).find(e => e.id === g.id).getAttribute('aria-expanded'), was);
  const search = p.el('status').find(e => has(e, 'run-search'));
  assert.ok(search, 'a long list gets a search box');
  const one = S('fxdeployfail').run.rows.find(r => r.o === 'failed');
  search.value = one.k.split(':')[1];
  search.fire('input');
  await pause(150);
  const leafs = rowNodes(p).filter(e => has(e, 'leaf'));
  assert.strictEqual(leafs.length, 1, 'one component matches its own name');
  assert.strictEqual(leafs[0].find(x => has(x, 'run-name')).textContent, one.k.split(':')[1]);
  assert.strictEqual(actBtn(p, 'select').textContent, 'Select 1 in tree', 'the buttons count what the search leaves');
  assert.strictEqual(p.el('status').find(e => has(e, 'run-search')), search, 'the box itself is not rebuilt under the caret');
});

// ======================================== the newest run's buttons, clicked
check('Retry posts the run\'s own request with exactly the sent keys (no skipped row), and locks until answered', () => {
  const p = boot({ scenario: 'fxdeployfail' });
  click(actBtn(p, 'retry'));
  const [m] = sent(p, 'retryDeploy');
  const want = S('fxdeployfail').run.rows.filter(r => r.s === 1).map(r => r.k);
  assert.strictEqual(m.request.keys.length, 3161);
  assert.deepStrictEqual(m.request.keys, want);
  assert.strictEqual(m.request.validateOnly, false);
  assert.strictEqual(m.request.testLevel, 'RunLocalTests');
  assert.strictEqual(m.request.ignoreConflicts, undefined);
  p.flush();
  assert.strictEqual(actBtn(p, 'retry').disabled, true, 'a second click cannot send a twin');
  assert.strictEqual(actBtn(p, 'retry').title, 'Sending…');
  p.deliver({ type: 'busy', busy: true, action: 'Deploy' });
  assert.strictEqual(actBtn(p, 'retry').disabled, false, 'busy: Retry queues, like Deploy');
  assert.strictEqual(actBtn(p, 'retry').title, 'Will queue behind Deploy');
});

check('Quick Deploy posts the validation\'s job id once — the offer is one-shot', () => {
  const p = boot({ scenario: 'fxvalidateqd' });
  click(actBtn(p, 'quickDeploy'));
  assert.deepStrictEqual(sent(p, 'quickDeploy').map(m => m.jobId), ['0AfAc000001kM7pSAE']);
  p.flush();
  p.deliver({ type: 'busy', busy: false });
  assert.ok(!actBtn(p, 'quickDeploy'), 'gone once used');
  assert.ok(!p.el('status').find(e => has(e, 'run-why')), 'and nothing claims it is unavailable');
});

check('Resume monitoring and the backup buttons post what the host re-validates, and wait for the slot', () => {
  const p = boot({ scenario: 'fxlost' });
  click(actBtn(p, 'resume'));
  assert.deepStrictEqual(sent(p, 'resumeDeploy').map(m => m.jobId), ['0AfAc000001kJ3tSAE']);
  const q = boot({ scenario: 'fxretrieve' });
  click(actBtn(q, 'restore'));
  assert.deepStrictEqual(sent(q, 'restoreBackup').map(m => m.dir), [S('fxretrieve').run.backupDir]);
  q.flush();
  q.deliver({ type: 'busy', busy: true, action: 'Retrieve' });
  assert.strictEqual(actBtn(q, 'discard').disabled, true, 'the slot is taken');
});

check('Try with dependencies opens the choices inside the card; Deploy with N posts the ticked keys, Back declines', () => {
  const p = boot({ scenario: 'fxdeployfail' });
  const sug = S('fxdeployfail').live.suggest;
  click(actBtn(p, 'suggest'));
  assert.deepStrictEqual(sent(p, 'suggestionOpened').map(m => m.id), [sug.id]);
  const box = p.el('status').find(e => has(e, 'run-suggest'));
  assert.ok(box, 'state B sits in the card');
  assert.ok(p.el('status').find(e => has(e, 'run-list')), 'the failures stay listed below it');
  const boxes = box.findAll(e => e.tagName === 'INPUT');
  assert.strictEqual(boxes.length, sug.candidates.length);
  boxes[0].checked = false;
  boxes[0].fire('change');
  const deployBtn = p.el('status').find(e => e.tagName === 'BUTTON' && /^Deploy with \d+ selected$/.test(e.textContent));
  assert.strictEqual(deployBtn.textContent, `Deploy with ${sug.candidates.length - 1} selected`);
  click(deployBtn);
  assert.deepStrictEqual(sent(p, 'suggestionDeploy')[0], { type: 'suggestionDeploy', id: sug.id, keys: sug.candidates.slice(1).map(c => c.key) });
  assert.ok(text(p.el('status')).includes('the retry becomes the newest run'));
  p.deliver({ type: 'suggestionReset', id: sug.id });
  assert.ok(actBtn(p, 'suggest'), 'a refused retry makes the suggestion actionable again');
  click(actBtn(p, 'suggest'));
  click(p.el('status').find(e => e.tagName === 'BUTTON' && e.textContent === 'Back'));
  assert.deepStrictEqual(sent(p, 'suggestionDeclined').map(m => m.id), [sug.id]);
  click(p.el('status').find(e => e.tagName === 'BUTTON' && e.textContent === 'Yes — off'));
  assert.deepStrictEqual(sent(p, 'suggestionVerdict')[0], { type: 'suggestionVerdict', id: sug.id, bad: true });
});

check('Select ticks the visible rows that have local source; Copy puts the shown rows on the clipboard', () => {
  const p = boot({ scenario: 'fxretrieve' });
  click(actBtn(p, 'select'));
  const keys = sent(p, 'selectDeployed')[0].keys;
  const local = new Set(LOCAL.map(i => `${i.type}:${i.name}`));
  assert.strictEqual(keys.length, 309, 'the 3 components not on the org have nothing local to tick');
  assert.ok(keys.every(k => local.has(k)));
  click(chipBtn(p, 'missing'));
  assert.ok(!actBtn(p, 'select'), 'nothing local to select among the missing');
  click(actBtn(p, 'copy'));
  const t = sent(p, 'copyText')[0].text;
  assert.ok(t.startsWith('Retrieved from acme-dev · '), t.split('\n')[0]);
  assert.strictEqual((t.match(/ — Not on org — not on the org$/gm) || []).length, 3);
});

check('a running run: progress ticks redraw the bars in place; the toolbar Cancel turns the card to "Cancelling…" at once', () => {
  const p = boot();
  p.deliver({ type: 'busy', busy: true, action: 'Deploy' });
  p.deliver(runsMsg('fxrunning'));
  const head = p.el('status').find(e => has(e, 'run-head'));
  assert.ok(text(head).includes('waiting for the org'), 'no tick yet');
  p.deliver({ type: 'runProgress', id: 'fxrunning', orgStatus: 'InProgress', compDone: 6120, compTotal: 9047, testDone: 0, testTotal: 412, errors: 2 });
  assert.strictEqual(p.el('status').find(e => has(e, 'run-head')), head, 'a tick does not rebuild the card');
  assert.ok(text(head).includes('6,120/9,047') && text(head).includes('412 queued') && text(head).includes('2 errors so far'), text(head));
  p.deliver({ type: 'runProgress', id: 'someotherrun', compDone: 1, compTotal: 1 });
  assert.ok(text(head).includes('6,120/9,047'), "another run's tick is ignored");
  click(p.el('cancelBtn'));
  assert.strictEqual(sent(p, 'cancel').length, 1);
  const title = text(p.el('status').find(e => has(e, 'run-title')));
  assert.ok(title.startsWith('Cancelling on acme-dev'), title);
  assert.ok(text(p.el('status')).includes('The org was asked to stop'));
});

check('a rebuilt webview gets a live suggestion back with the newest run — fully live; an expired one is simply gone', () => {
  const p = boot({ scenario: 'fxdeployfail' });            // the runs post carries the live payload
  click(actBtn(p, 'suggest'));
  assert.ok(p.el('status').find(e => has(e, 'run-suggest')), 'the suggestion opens');
  const q = boot({ scenario: 'fxdeployfail' });
  const msg = runsMsg('fxdeployfail');
  delete msg.runs[0].suggest;                                  // the provider no longer holds it
  q.deliver(msg);
  assert.ok(!actBtn(q, 'suggest'), 'no button for a suggestion the provider no longer holds');
  assert.ok(actBtn(q, 'retry'), 'Retry is still there');
});

// ============================================== 3) Earlier and older runs
check('Earlier (k) lists the older runs and notices; an older run expands read-only — Copy is its only button', () => {
  const notices = F.buildNotices(NOW);
  const p = boot({ scenario: 'fxdeployfail', notices });
  const eb = p.el('statusEarlier');
  const newer = notices.filter(n => n.at > S('fxdeployfail').run.startedAt).length;
  const k = 2 + notices.length - newer;
  assert.strictEqual(eb.style.display, '');
  assert.strictEqual(eb.textContent, `Earlier (${k}) ▸`);
  assert.ok(!p.el('status').find(e => has(e, 'run-earlier')), 'closed by default');
  click(eb);
  const box = p.el('status').find(e => has(e, 'run-earlier'));
  assert.strictEqual(box.children.length, k);
  assert.strictEqual(eb.getAttribute('aria-expanded'), 'true');
  const older = box.children.find(e => has(e, 'run-older'));
  click(older.children[0]);
  const body = p.el('status').find(e => has(e, 'run-older-body'));
  assert.ok(body, 'expanded');
  const buttons = body.findAll(e => e.tagName === 'BUTTON');
  assert.deepStrictEqual(buttons.map(b => b.textContent), ['Copy list'], 'an older run renders no action but Copy');
  assert.ok(text(body).includes('Actions are on the newest run only.'));
  buttons[0].fire('click');
  assert.ok(sent(p, 'copyText').length === 1);
  // The newest run still has its own actions.
  assert.ok(actBtn(p, 'retry'));
});

check('a notice newer than the newest run leads as a one-liner and expands to its card body', () => {
  const p = boot({ scenario: 'fxbigdeploy' });
  p.deliver({ type: 'status', card: { kind: 'err', title: 'Fetch Org failed', errText: 'INVALID_SESSION_ID', at: Date.now() } });
  const notice = p.el('status').children.find(e => has(e, 'run-notice'));
  assert.ok(notice, 'the notice is above the run card');
  assert.ok(p.el('status').children.indexOf(notice) < p.el('status').children.findIndex(e => has(e, 'run-card')));
  click(notice.children[0]);
  const body = p.el('status').find(e => has(e, 'err-text'));
  assert.strictEqual(body && body.textContent, 'INVALID_SESSION_ID');
});

// ============================================== 4) the newest run's full list
check('a runs post without the full list keeps it only while the same run is the newest', () => {
  const p = boot({ scenario: 'fxdeployfail' });
  assert.ok(actBtn(p, 'retry'), 'full list: Retry offered');
  p.deliver(runsMsg('fxdeployfail', { withLatestRows: false }));      // e.g. a status change of the same run
  assert.ok(actBtn(p, 'retry'), 'same run: the full list is kept');
  assert.ok(!p.el('status').find(e => has(e, 'note')), 'nothing reads as missing');
  p.deliver(runsMsg('fxbigdeploy', { withLatestRows: false }));       // another run became the newest
  click(chipBtn(p, 'deployed'));
  const note = p.el('status').find(e => has(e, 'run-row') && has(e, 'note'));
  assert.ok(note && text(note).startsWith('9,047 more rows not listed'), 'a summary: the list says what it lacks');
  p.deliver(runsMsg('fxdeployfail', { withLatestRows: false }));      // back again, but its list is gone
  assert.ok(!actBtn(p, 'retry'), 'no full list, no Retry');
  assert.ok(text(p.el('status').find(e => has(e, 'run-why'))).startsWith('Retry needs the full list of what this run sent'));
});

// ============================================== 5) no runs: the card list
check('with no runs the pane is the plain card list: no run card, no Earlier toggle', () => {
  const p = boot({ notices: F.buildNotices(NOW) });
  assert.ok(!p.el('status').find(e => has(e, 'run-card')));
  assert.strictEqual(p.el('status').children.filter(e => has(e, 'status-card')).length, 4);
  assert.strictEqual(p.el('statusEarlier').style.display, 'none');
  p.deliver(runsMsg('fxbigdeploy'));
  assert.ok(p.el('status').find(e => has(e, 'run-card')), 'the first run switches the pane over');
  click(p.el('clearStatus'));
  assert.ok(!p.el('status').find(e => has(e, 'run-card')), 'Clear empties it');
  assert.strictEqual(sent(p, 'clearStatusHistory').length, 1);
});

check('Clear keeps a run that is still running', () => {
  const p = boot({ scenario: 'fxrunning', notices: F.buildNotices(NOW) });
  assert.strictEqual(p.el('clearStatus').style.display, '');
  click(p.el('clearStatus'));
  assert.ok(p.el('status').find(e => has(e, 'run-card')), 'the running run stays');
  assert.ok(!p.el('status').find(e => has(e, 'run-notice')), 'the notices go');
});

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
check('this harness is registered in package.json "check"', () => {
  assert.ok(pkg.scripts.check.includes('node ./scripts/check-status-pane.cjs'));
});

Promise.all(waiting).then(() => {
  if (failed) { console.error(`status-pane: ${failed}/${ran} checks FAILED`); process.exit(1); }
  console.log(`status-pane: all ${ran} checks passed`);
});
