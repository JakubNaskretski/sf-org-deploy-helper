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
//   5) with no runs at all, the pane is the plain card list it always was;
//   6) an org message too long for its two lines (a row) or three (the card)
//      gets a "more" toggle that opens all of it without opening the file, and
//      stays open when the same run is delivered again;
//   7) an older run's failure is one cut line, its tooltip carries the whole
//      message, and a long or multi-line one opens in place the same way;
//   8) with a classic scrollbar (Windows) the pane settles after a draw: the
//      observer's first report never redraws it again and again, a real width
//      change redraws it once, and the toggles are decided at the width the
//      filled pane has.
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
  const p = panel({ selected: [], expandedGroups: [], filter: '', typeFilter: [], viewMode: 'all', testClasses: '' }, opts.shim);
  p.deliver({ type: 'orgs', orgs: [{ username: 'acme-dev-user', alias: 'acme-dev', label: 'acme-dev (acme-dev-user)', kind: 'sandbox' }], selected: 'acme-dev-user' });
  p.deliver({ type: 'files', objectChildTypes: [], items: opts.items || LOCAL });
  p.el('status').clientHeight = opts.height || 200;
  p.el('status').clientWidth = opts.width || 400;
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
  // The pane keeps as many notices as runs (3 here), the newest ones.
  const kept = notices.slice(0, 3);
  const newer = kept.filter(n => n.at > S('fxdeployfail').run.startedAt).length;
  const k = 2 + kept.length - newer;
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

check('an expanded older run says how many failures and test failures it did not keep', () => {
  const p = boot({ scenario: 'fxbigdeploy' });
  p.deliver({ type: 'runs', cap: 3, runs: [
    RR.summarizeRun(S('fxbigdeploy').run, { latest: true }),
    RR.summarizeRun(S('fxdeployfail').run, { latest: false }),
    RR.summarizeRun(S('fxtestsfail').run, { latest: false })
  ] });
  click(p.el('statusEarlier'));
  const olders = p.el('status').find(e => has(e, 'run-earlier')).children.filter(e => has(e, 'run-older'));
  for (const o of olders) click(o.children[0]);
  const bodies = p.el('status').findAll(e => has(e, 'run-older-body')).map(text);
  assert.ok(bodies.some(t => t.includes('… 16 more failures not kept')), bodies.join(' || ').slice(0, 400));
  assert.ok(bodies.some(t => t.includes('… 4 more test failures not kept')), bodies.join(' || ').slice(0, 400));
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
  assert.strictEqual(p.el('status').children.filter(e => has(e, 'status-card')).length, 3, 'as many notices as the history keeps');
  assert.strictEqual(p.el('statusEarlier').style.display, 'none');
  p.deliver(runsMsg('fxbigdeploy'));
  assert.ok(p.el('status').find(e => has(e, 'run-card')), 'the first run switches the pane over');
  click(p.el('clearStatus'));
  assert.ok(!p.el('status').find(e => has(e, 'run-card')), 'Clear empties it');
  assert.strictEqual(sent(p, 'clearStatusHistory').length, 1);
});

check('focusing the list — what a click does on mousedown — marks the first row in view in place, so the click itself still lands', () => {
  const p = boot({ scenario: 'fxdeployfail' });
  const list = listOf(p);
  const before = rowNodes(p);
  assert.ok(!before.some(e => has(e, 'focused')), 'no row has the focus yet');
  list.fire('focus');
  const after = rowNodes(p);
  assert.ok(after.length === before.length && after.every((e, i) => e === before[i]), 'the rows under the pointer were rebuilt, which drops the click');
  const focused = after.filter(e => has(e, 'focused'));
  assert.strictEqual(focused.length, 1);
  assert.strictEqual(list.getAttribute('aria-activedescendant'), focused[0].id);
  // The click that follows the mousedown hits that same row: its group folds.
  assert.strictEqual(focused[0].getAttribute('aria-expanded'), 'true');
  focused[0].fire('click');
  const row = rowNodes(p).find(e => e.id === focused[0].id);
  assert.strictEqual(row.getAttribute('aria-expanded'), 'false');
});

check('a different run becoming the newest starts the pane at its top; the same run re-posted keeps the scroll', () => {
  const p = boot({ scenario: 'fxbigdeploy' });
  scrollTo(p, 3000);
  p.deliver(runsMsg('fxbigdeploy'));
  assert.strictEqual(p.el('status').scrollTop, 3000);
  p.deliver(runsMsg('fxdeployfail'));
  assert.strictEqual(p.el('status').scrollTop, 0);
});

check('a poll tick never rebuilds the card, and a rebuild keeps what was typed in the search box', () => {
  const p = boot({ scenario: 'fxrunning' });
  p.deliver({ type: 'busy', busy: true, action: 'Deploy' });
  const input = p.el('status').find(e => has(e, 'run-search'));
  input.value = 'acme ord';
  input.fire('input');
  const card = p.el('status').find(e => has(e, 'run-card'));
  for (let i = 0; i < 3; i++) p.deliver({ type: 'progress', text: `Deploying 900 components: ${i * 300}/900` });
  assert.strictEqual(p.el('status').find(e => has(e, 'run-card')), card, 'a progress tick rebuilt the card');
  assert.strictEqual(p.el('status').find(e => has(e, 'run-search')).value, 'acme ord');
  p.deliver({ type: 'status', card: { kind: 'ok', title: 'No differences with acme-dev', at: Date.now() } });
  const again = p.el('status').find(e => has(e, 'run-search'));
  assert.notStrictEqual(again, input, 'a notice does rebuild the card');
  assert.strictEqual(again.value, 'acme ord', 'half-typed text survives the rebuild');
});

check('the pane keeps as many notices as the provider does — 3 by default, the setting when it says so — and a notice has no buttons', () => {
  const cards = Array.from({ length: 12 }, (_, i) => ({ kind: 'ok', title: `Diff ${i}`, at: NOW - i * 1000 }));
  const shown = (p) => p.el('status').children.filter(e => has(e, 'status-card')).map(e => text(e));
  const d = boot({ notices: cards });
  assert.strictEqual(shown(d).length, 3);
  d.deliver({ type: 'status', card: { kind: 'ok', title: 'Diff live', at: NOW + 500 } });
  assert.strictEqual(shown(d).length, 3, 'a live notice keeps the same length');
  const p = boot();
  p.deliver({ type: 'statusHistory', cards, cap: 10 });
  assert.strictEqual(shown(p).length, 10);
  assert.ok(shown(p)[0].includes('Diff 0') && shown(p)[9].includes('Diff 9'));
  p.deliver({ type: 'status', card: { kind: 'warn', title: 'Diff new', at: NOW + 1000, buttons: [{ label: 'Stale', send: { type: 'retryDeploy' } }] } });
  assert.strictEqual(shown(p).length, 10);
  assert.ok(shown(p)[0].includes('Diff new') && shown(p)[9].includes('Diff 8'));
  assert.ok(!p.el('status').find(e => e.tagName === 'BUTTON' && e.textContent === 'Stale'), 'a card\'s buttons are never drawn');
  // The setting lowered: the next runs post says so, and the list follows.
  p.deliver({ type: 'runs', runs: [], cap: 2 });
  assert.strictEqual(shown(p).length, 2);
});

check('Clear keeps a run that is still running', () => {
  const p = boot({ scenario: 'fxrunning', notices: F.buildNotices(NOW) });
  assert.strictEqual(p.el('clearStatus').style.display, '');
  click(p.el('clearStatus'));
  assert.ok(p.el('status').find(e => has(e, 'run-card')), 'the running run stays');
  assert.ok(!p.el('status').find(e => has(e, 'run-notice')), 'the notices go');
});

// ===================================== 6) long messages: the "more" toggle
// The newest run of fxdeployfail with one failed row's message (and the card's own
// message) long, another short. Copied: the scenarios are shared between checks.
const LONG = Array.from({ length: 40 }, (_, i) => `Problem ${i}: field Acme_Field${i}__c is not visible to the running user.`).join(' ');
function longRun(text = LONG) {
  const msg = runsMsg('fxdeployfail');
  const rows = msg.latestRows.rows.map(r => ({ ...r }));
  const failedRows = rows.filter(r => r.o === 'failed' && r.l);
  failedRows[0].m = text;
  failedRows[1].m = 'Duplicate value';
  msg.latestRows = { ...msg.latestRows, rows };
  msg.runs[0] = { ...msg.runs[0], message: text };
  return { msg, long: failedRows[0].k, short: failedRows[1].k };
}
function longPane(msg, width) {
  const p = boot({ height: 5000, width });
  p.deliver(msg);
  click(chipBtn(p, 'failed'));
  return p;
}
/** A row's characters a line at `width`: floor((width - 68) / 6.62) less the column of slack. */
const rowCols = (width) => Math.floor((width - 68) / 6.62) - 1;
const rowFor = (p, key) => rowNodes(p).find(e => has(e, 'leaf') && e.find(x => has(x, 'run-name') && x.title.startsWith(key + ' ')));
const moreOf = (e) => e.find(x => has(x, 'show-more'));
const msgOf = (e) => e.find(x => has(x, 'run-msg'));
/** A click on a control inside a row, the way a browser delivers it: the control
 *  first, then — unless it stopped the event — the row under it. */
function clickInside(btn, row) {
  let stopped = false;
  btn.fire('click', { stopPropagation() { stopped = true; } });
  if (!stopped) row.fire('click');
  return stopped;
}

check('a failed row whose message is cut by its two lines gets "more ▾"; a short one gets none', () => {
  const { msg, long, short } = longRun();
  const p = longPane(msg);
  const row = rowFor(p, long);
  assert.strictEqual(msgOf(row).textContent, LONG, 'the whole message is in the row, only clamped by CSS');
  assert.ok(!has(msgOf(row), 'open'));
  assert.strictEqual(moreOf(row).textContent, 'more ▾');
  assert.strictEqual(msgOf(row).title, LONG, 'the tooltip stays');
  assert.ok(!moreOf(rowFor(p, short)), 'two lines hold "Duplicate value"');
});

// A message that a character count calls two lines but a browser wraps to three
// (words move to the next line, they are not split) loses its tail to the clamp:
// it needs the toggle too. At 400px a row's line holds 49 characters (50 less a column of slack).
const WRAPPED = 'Variable does not exist: Acme_Discount_Percentage__c in field Acme_Order__c.Acme_Total__c formula';

check('a row whose 97-character message wraps to three lines at 400px gets "more ▾" although two lines of 49 hold its length; a 60-character one does not', () => {
  assert.ok(WRAPPED.length <= 2 * rowCols(400));
  const { msg, long, short } = longRun(WRAPPED);
  const p = longPane(msg);
  assert.strictEqual(msgOf(rowFor(p, long)).textContent, WRAPPED);
  assert.strictEqual(moreOf(rowFor(p, long)).textContent, 'more ▾', 'the field name at the end would be hidden by the clamp');
  assert.ok(!moreOf(rowFor(p, short)));
  const fits = longRun('Required field missing: Acme_Order__c.Acme_Total__c is blank');
  const q = longPane(fits.msg);
  assert.ok(!moreOf(rowFor(q, fits.long)), 'wraps to two lines at 49 columns');
});

// The card's line is proportional text read at 6.8px a character: four words of
// 30 characters take four lines of 47 (48 less a column of slack) although 123 < 3 x 47.
const CARD_WRAPPED = ['a', 'b', 'c', 'd'].map(c => c.repeat(30)).join(' ');

check('the card\'s line that wraps to four lines gets the toggle although three lines hold its length', () => {
  assert.ok(CARD_WRAPPED.length <= 3 * (Math.floor((400 - 68) / 6.8) - 1));
  const { msg } = longRun(CARD_WRAPPED);
  const p = boot({ height: 5000 });
  p.deliver(msg);
  const line = p.el('status').find(e => has(e, 'run-plain') && e.textContent === CARD_WRAPPED);
  assert.ok(line, 'the org message is a plain line');
  assert.strictEqual(line._parent.children[line._parent.children.indexOf(line) + 1].textContent, 'more ▾');
});

// The estimate's numbers, pinned where each flips a toggle at 400px (a row's line
// holds floor((400 - 68) / 6.62) - 1 = 49 characters, the card's floor(332 / 6.8) - 1 = 47).
// ROW_A wraps to four lines at 49 but two at 50 (a 56px overhead, or no slack) or
// 52 (6.2px a character); ROW_B two lines at 49 but four at 48 (two columns of
// slack) or 46 (7px a character). CARD_C: six lines of 47, three at 52 (6.2px);
// CARD_D: six lines of 47, three at 48 (no slack).
const ROW_A = `${'x'.repeat(25)} ${'y'.repeat(24)} ${'z'.repeat(50)}`;
const ROW_B = `${'x'.repeat(24)} ${'y'.repeat(24)} ${'z'.repeat(49)}`;
const CARD_C = Array.from({ length: 3 }, () => `${'x'.repeat(25)} ${'y'.repeat(24)}`).join(' ');
const CARD_D = Array.from({ length: 3 }, () => `${'x'.repeat(24)} ${'y'.repeat(23)}`).join(' ');
const cardHasMore = (text) => {
  const p = boot({ height: 5000 });
  p.deliver(longRun(text).msg);
  const line = p.el('status').find(e => has(e, 'run-plain') && e.textContent === text);
  assert.ok(line, 'the org message is a plain line');
  return line._parent.children[line._parent.children.indexOf(line) + 1].textContent === 'more ▾';
};

check('the toggle follows the estimate\'s numbers: 68px of overhead, 6.62px a character and a column of slack on a row; 6.8px and a column of slack on the card', () => {
  const a = longRun(ROW_A);
  assert.ok(moreOf(rowFor(longPane(a.msg), a.long)), 'four lines of 49: a toggle (a 56px overhead, 6.2px a character or no slack would call it two)');
  const b = longRun(ROW_B);
  assert.ok(!moreOf(rowFor(longPane(b.msg), b.long)), 'two lines of 49: no toggle (two columns of slack or 7px a character would call it four)');
  assert.ok(cardHasMore(CARD_C), 'six lines of 47, three of 52: the card errs early');
  assert.ok(cardHasMore(CARD_D), 'six lines of 47, three of 48: the card keeps its column of slack');
});

// Menlo's advance is 1233/2048em = 6.6226px at 11px, a hair over ROW_PX, so at
// 399px the list holds 49 characters although floor(331 / 6.62) says 50: a message
// that needs exactly three lines of 49 must still get its toggle (and one that
// fits two lines of 49 must not).
const ROW_399 = 'Invalid field Acme_Invoice_Invoice_Customer__c for SObject Acme_Total_Currency_Item_Amount_Total__c';
check('a message that wraps to three lines at 399px (49 characters a line, 50 by the bare estimate) gets "more ▾"', () => {
  assert.deepStrictEqual([RV.msgLines(ROW_399, 49), RV.msgLines(ROW_399, 50)], [3, 2], 'the fixture sits on the boundary');
  const a = longRun(ROW_399);
  assert.strictEqual(moreOf(rowFor(longPane(a.msg, 399), a.long)).textContent, 'more ▾');
  const b = longRun(ROW_B);
  assert.ok(!moreOf(rowFor(longPane(b.msg, 399), b.long)), 'two lines of 49 hold ROW_B at 399px too');
});

check('"more" opens the whole message without opening the file; "less" closes it; the row and those below it follow its height', () => {
  const { msg, long } = longRun();
  const p = longPane(msg);
  const cols = rowCols(400);
  const h = 54 + RV.msgOpenH(LONG, cols) - 30;
  assert.ok(h > 54 + 100, 'the fixture must be long enough to matter');
  const before = rowNodes(p).map(e => e.style.top);
  assert.strictEqual(clickInside(moreOf(rowFor(p, long)), rowFor(p, long)), true, 'the toggle stops the click');
  assert.strictEqual(sent(p, 'openFile').length, 0, 'the row under the toggle did not open its file');
  let row = rowFor(p, long);
  assert.ok(has(msgOf(row), 'open'));
  assert.strictEqual(moreOf(row).textContent, 'less ▴');
  assert.strictEqual(row.style.height, `${h}px`);
  assert.strictEqual(msgOf(row).style.height, `${RV.msgOpenH(LONG, cols)}px`, 'the box is as tall as the lines the list gave the row');
  const nodes = rowNodes(p);
  const at = nodes.indexOf(row);
  assert.strictEqual(nodes[at + 1].style.top, `${parseInt(row.style.top, 10) + h}px`, 'the next row starts below the opened one');
  assert.notStrictEqual(nodes[at + 1].style.top, before[at + 1]);
  clickInside(moreOf(row), row);
  row = rowFor(p, long);
  assert.ok(!has(msgOf(row), 'open'));
  assert.strictEqual(row.style.height, '54px');
  assert.strictEqual(sent(p, 'openFile').length, 0);
  row.fire('click');
  assert.deepStrictEqual(sent(p, 'openFile').map(m => m.key), [long], 'the row itself still opens the file');
});

check('an opened message stays open when the same run is delivered again, and closes for another run', () => {
  const { msg, long } = longRun();
  const p = longPane(msg);
  clickInside(moreOf(rowFor(p, long)), rowFor(p, long));
  p.deliver(msg);
  p.flush();
  assert.ok(has(msgOf(rowFor(p, long)), 'open'), 're-delivered: still open');
  assert.strictEqual(moreOf(rowFor(p, long)).textContent, 'less ▴');
  p.deliver(runsMsg('fxtestsfail'));
  p.deliver(msg);
  assert.ok(!has(msgOf(rowFor(p, long)), 'open'), 'another run was the newest in between: the state is that run\'s');
});

check('a narrower pane re-computes an opened message\'s height', () => {
  const mid = LONG.slice(0, 600);
  const { msg, long } = longRun(mid);
  const p = longPane(msg);
  clickInside(moreOf(rowFor(p, long)), rowFor(p, long));
  const wide = rowFor(p, long).style.height;
  assert.strictEqual(wide, `${54 + RV.msgOpenH(mid, rowCols(400)) - 30}px`);
  p.el('status').clientWidth = 300;
  for (const ro of p.resizeObservers) if (ro.targets.has(p.el('status'))) ro.cb([]);
  p.flush();
  assert.strictEqual(rowFor(p, long).style.height, `${54 + RV.msgOpenH(mid, rowCols(300)) - 30}px`);
  assert.notStrictEqual(rowFor(p, long).style.height, wide);
});

/** The pane's width changes: the observer fires, the frame after it paints. */
function resizeTo(p, width) {
  p.el('status').clientWidth = width;
  for (const ro of p.resizeObservers) if (ro.targets.has(p.el('status'))) ro.cb([]);
  p.flush();
}

check('dragging the pane narrower gives the rows that now wrap past two lines their toggle; wider takes it away', () => {
  const { msg, long } = longRun(WRAPPED);
  const p = boot({ height: 5000, width: 600 });
  p.deliver(msg);
  click(chipBtn(p, 'failed'));
  assert.ok(!moreOf(rowFor(p, long)), 'two lines of 80 hold it at 600px');
  resizeTo(p, 300);
  assert.strictEqual(moreOf(rowFor(p, long)).textContent, 'more ▾', 'three lines of 35 at 300px, with nothing opened');
  resizeTo(p, 600);
  assert.ok(!moreOf(rowFor(p, long)), 'and back');
});

check('a pane first drawn hidden (width 0, read as 320) is drawn again at the width it is shown at; hidden again, it keeps what it has', () => {
  const { msg, long } = longRun(WRAPPED);
  const p = boot({ height: 5000 });
  p.el('status').clientWidth = 0;
  p.deliver(msg);
  click(chipBtn(p, 'failed'));
  assert.ok(moreOf(rowFor(p, long)), 'three lines of 38 at the fallback width');
  resizeTo(p, 700);
  assert.ok(!moreOf(rowFor(p, long)), 'two lines of 95 at the width it is shown at');
  const list = listOf(p);
  resizeTo(p, 0);
  assert.strictEqual(listOf(p), list, 'a width of 0 draws nothing again');
  assert.ok(!moreOf(rowFor(p, long)));
});

check('an Apex test failure with a long message has the same toggle, and does not open the class', () => {
  const msg = runsMsg('fxtestsfail');
  const tests = msg.latestRows.tests.map(t => ({ ...t }));
  tests[0].m = LONG;
  msg.latestRows = { ...msg.latestRows, tests };
  const p = boot({ height: 5000 });
  p.deliver(msg);
  const testRows = () => rowNodes(p).filter(e => has(e, 'test'));
  const row = testRows().find(e => text(e).includes(`${tests[0].cls}.${tests[0].method}`));
  assert.ok(row && moreOf(row), 'the long one has a toggle');
  const cols = rowCols(400);
  assert.deepStrictEqual(testRows().filter(moreOf).length, tests.filter(t => RV.msgLines(t.m, cols) > 2).length, 'a toggle exactly where two lines cut the message');
  clickInside(moreOf(row), row);
  assert.strictEqual(sent(p, 'openFile').length, 0);
  assert.ok(has(msgOf(testRows().find(e => text(e).includes(`${tests[0].cls}.${tests[0].method}`))), 'open'));
});

check('the card\'s own message gets the toggle at three lines, opens in place, and stays open when re-delivered', () => {
  const { msg } = longRun();
  const p = boot({ height: 5000 });
  p.deliver(msg);
  const plainOf = () => p.el('status').find(e => has(e, 'run-plain') && e.textContent === LONG);
  const line = plainOf();
  assert.ok(line, 'the org message is a plain line');
  // The toggle sits right under its line.
  const btn = () => { const l = plainOf(); return l._parent.children[l._parent.children.indexOf(l) + 1]; };
  assert.strictEqual(btn().textContent, 'more ▾');
  assert.ok(!has(line, 'open'));
  assert.strictEqual(line.title, LONG, 'the tooltip stays');
  assert.strictEqual(clickInside(btn(), line), true);
  assert.ok(has(line, 'open'), 'the same line opened in place');
  assert.strictEqual(btn().textContent, 'less ▴');
  p.deliver(msg);
  p.flush();
  assert.ok(has(plainOf(), 'open'), 're-delivered: still open');
  assert.strictEqual(btn().textContent, 'less ▴');
  clickInside(btn(), plainOf());
  assert.ok(!has(plainOf(), 'open'));
  // The lines that fit three get no toggle.
  const q = boot({ scenario: 'fxtestsfail' });
  assert.ok(!q.el('status').find(e => has(e, 'show-more')), 'a 103-character coverage message fits three lines');
});

check('an opened card line stays open when the lines before it come and go: it is keyed by what it says, not its place', () => {
  const { msg } = longRun();
  const p = boot({ height: 5000 });
  p.deliver(msg);
  const plainOf = () => p.el('status').find(e => has(e, 'run-plain') && e.textContent === LONG);
  const lines = () => plainOf()._parent.children.filter(e => has(e, 'run-plain'));
  const place = lines().indexOf(plainOf());
  const l = plainOf();
  clickInside(l._parent.children[l._parent.children.indexOf(l) + 1], l);
  assert.ok(has(plainOf(), 'open'));
  // The same run, now a retrieve: the "nothing changed on the org" line before the message is gone.
  p.deliver({ ...msg, runs: [{ ...msg.runs[0], op: 'retrieve' }, ...msg.runs.slice(1)] });
  p.flush();
  assert.notStrictEqual(lines().indexOf(plainOf()), place, 'the fixture must move the line');
  assert.ok(has(plainOf(), 'open'), 'still open after it moved');
});

check('a skipped row\'s reason column carries the full reason as its tooltip', () => {
  const p = boot({ scenario: 'fxdeployfail', height: 5000 });
  click(chipBtn(p, 'skipped'));
  const col = p.el('status').find(e => has(e, 'run-why-col'));
  assert.ok(col && col.textContent.length > 0);
  assert.strictEqual(col.title, col.textContent);
});

// ===================================== 7) older runs: a long failure opens in place
// An older run's failures are one cut line each. The tooltip and the opened line
// carry the whole message, newlines included; only a long or multi-line one has
// the toggle; it is read-only (the toggle never opens a file).
const OLD_LONG = LONG.slice(0, 1500);
const OLD_MULTI = 'First problem on this component\nSecond problem on this component\nThird problem';
function olderPane(width) {
  const base = JSON.parse(JSON.stringify(S('fxdeployfail').run));
  const failed = base.rows.filter(r => r.o === 'failed');
  failed[0].m = OLD_LONG;
  failed[1].m = OLD_MULTI;
  failed[2].m = 'Duplicate value';
  base.tests = [{ cls: 'AcmeLongTest', method: 'testLong', m: `${OLD_LONG}\nat Class.AcmeLongTest.testLong: line 9`, l: 9, c: 1 }];
  base.counts.testsFailed = 1;
  const older = RR.summarizeRun(base, { latest: false });
  assert.strictEqual(older.rows[0].m, OLD_LONG, 'the fixture survives the older summary');
  const p = boot({ scenario: 'fxbigdeploy', width: width || 600 });
  const msg = { type: 'runs', cap: 3, runs: [RR.summarizeRun(S('fxbigdeploy').run, { latest: true }), older] };
  p.deliver(msg);
  click(p.el('statusEarlier'));
  click(p.el('status').find(e => has(e, 'run-older')).children[0]);
  return { p, msg, keys: failed.map(r => r.k) };
}
const olderLi = (p, start) => p.el('status').find(e => has(e, 'run-older-rows')).children.find(e => e.title.startsWith(start));
const toggleOf = (li) => li.find(x => has(x, 'show-more'));

check('an older run\'s long failure keeps all its text in the tooltip and opens in place with "more"; a short one has no toggle', () => {
  const { p, keys } = olderPane();
  const li = olderLi(p, keys[0]);
  assert.strictEqual(li.title, `${keys[0]} — ${OLD_LONG}`, 'the whole message, not a prefix');
  assert.strictEqual(text(li).replace(/more ▾$/, ''), li.title, 'the line holds the whole text, CSS cuts it');
  assert.ok(!has(li, 'open') && has(li, 'long'));
  assert.strictEqual(toggleOf(li).textContent, 'more ▾');
  assert.strictEqual(clickInside(toggleOf(li), li), true, 'the toggle stops the click');
  assert.strictEqual(sent(p, 'openFile').length, 0, 'read-only: nothing opened');
  assert.ok(has(li, 'open'), 'the same line opened in place');
  assert.strictEqual(toggleOf(li).textContent, 'less ▴');
  clickInside(toggleOf(li), li);
  assert.ok(!has(li, 'open'));
  assert.strictEqual(toggleOf(li).textContent, 'more ▾');
  const short = olderLi(p, keys[2]);
  assert.strictEqual(short.title, `${keys[2]} — Duplicate value`);
  assert.ok(!toggleOf(short) && !has(short, 'long'), 'one short line needs no toggle');
});

check('an older run\'s multi-line failure and test failure show every line in the tooltip, and open too', () => {
  const { p, keys } = olderPane();
  const multi = olderLi(p, keys[1]);
  assert.strictEqual(multi.title, `${keys[1]} — ${OLD_MULTI}`, 'all three lines, not the first');
  assert.ok(toggleOf(multi), 'a message with more than one line is cut by the single line');
  const test = olderLi(p, 'AcmeLongTest.testLong');
  assert.ok(test.title.endsWith('at Class.AcmeLongTest.testLong: line 9') && test.title.includes(OLD_LONG), 'the test failure\'s message in full');
  clickInside(toggleOf(test), test);
  assert.ok(has(test, 'open'));
  assert.ok(!has(multi, 'open'), 'each line opens on its own');
  assert.strictEqual(sent(p, 'openFile').length, 0);
});

check('an opened older failure stays open when the pane is drawn again; the line itself still opens its file', () => {
  const { p, msg, keys } = olderPane();
  clickInside(toggleOf(olderLi(p, keys[0])), olderLi(p, keys[0]));
  p.deliver(msg);
  p.flush();
  assert.ok(has(olderLi(p, keys[0]), 'open'), 're-delivered: still open');
  assert.strictEqual(toggleOf(olderLi(p, keys[0])).textContent, 'less ▴');
  assert.ok(has(olderLi(p, keys[0]), 'nav'), 'the workspace holds this component');
  olderLi(p, keys[0]).fire('click');
  assert.deepStrictEqual(sent(p, 'openFile').map(m => m.key), [keys[0]], 'the line itself still opens its file');
});

check('a narrow pane gives an older failure the toggle sooner', () => {
  const mid = 'Insufficient access rights, ask an admin';
  const base = JSON.parse(JSON.stringify(S('fxdeployfail').run));
  base.rows.filter(r => r.o === 'failed')[0].m = mid;
  const older = RR.summarizeRun(base, { latest: false });
  const key = base.rows.filter(r => r.o === 'failed')[0].k;
  const withToggle = (width) => {
    const p = boot({ scenario: 'fxbigdeploy', width });
    p.deliver({ type: 'runs', cap: 3, runs: [RR.summarizeRun(S('fxbigdeploy').run, { latest: true }), older] });
    click(p.el('statusEarlier'));
    click(p.el('status').find(e => has(e, 'run-older')).children[0]);
    return !!toggleOf(olderLi(p, key));
  };
  assert.strictEqual(withToggle(900), false, 'it fits one line of a wide pane');
  assert.strictEqual(withToggle(300), true, 'not one of a narrow pane');
});

check('the card\'s line and an older failure follow the pane\'s width too', () => {
  const mid = 'Insufficient access rights, ask an admin for the Acme_Order__c object and its fields, then run this again';
  const { msg } = longRun(mid);
  const base = JSON.parse(JSON.stringify(S('fxdeployfail').run));
  const failed = base.rows.filter(r => r.o === 'failed');
  failed[0].m = 'Insufficient access rights';
  const older = RR.summarizeRun(base, { latest: false });
  const p = boot({ height: 5000, width: 600 });
  p.deliver({ ...msg, runs: [msg.runs[0], older] });
  click(p.el('statusEarlier'));
  click(p.el('status').find(e => has(e, 'run-older')).children[0]);
  const card = () => p.el('status').find(e => has(e, 'run-plain') && e.textContent === mid);
  const btnAfter = (l) => { const n = l._parent.children[l._parent.children.indexOf(l) + 1]; return n && has(n, 'show-more') ? n : null; };
  const oldLi = () => olderLi(p, failed[0].k);
  assert.ok(!btnAfter(card()), 'two lines of 78 on the card at 600px');
  assert.ok(!toggleOf(oldLi()), 'the key and message take one line of 66 in the older list');
  resizeTo(p, 300);
  assert.strictEqual(btnAfter(card()).textContent, 'more ▾', 'four lines of 34 on the card');
  assert.strictEqual(toggleOf(oldLi()).textContent, 'more ▾', 'wraps past one line of 29 in the older list');
});

// ================================ 8) a classic scrollbar: the pane settles
// A classic scrollbar (Windows, Linux, macOS set to always show scroll bars;
// an overlay takes no width) takes 10px off the pane once it has content.
// 0.31.3 took the width its redraw key compares from the just-emptied pane, so
// the observer's first report — and every redraw observes the pane afresh —
// always disagreed with it: the pane drew itself again every frame, forever.
// drainResize() runs frames the way a browser does; a pane that never goes
// quiet uses them all.
const CLASSIC = { scrollbars: 'classic' };
/** The same scrollbar where the gutter is not kept while the pane is empty (an
 *  engine without scrollbar-gutter): the redraw key alone must hold the pane still. */
const NO_GUTTER = { scrollbars: 'classic', gutter: false };
const FRAMES = 12;
/** Run frames until the observer has nothing more to say: the pane's whole
 *  redraws meanwhile, and whether it went quiet before FRAMES ran out. */
function settle(p) {
  const st = p.el('status');
  const before = st.htmlResets || 0;
  const frames = p.drainResize(FRAMES);
  return { redraws: (st.htmlResets || 0) - before, quiet: frames < FRAMES };
}

for (const [mode, shim] of [['the page\'s CSS', CLASSIC], ['no gutter kept', NO_GUTTER]]) {
  check(`classic scrollbar (${mode}): a run that fills the pane is drawn once — the observer's first report redraws nothing, and the pane goes quiet`, () => {
    for (const scenario of ['fxdeployfail', 'fxbigdeploy']) {
      const p = boot({ scenario, shim, height: 900 });
      assert.ok(listOf(p), `${scenario}: drawn`);
      assert.deepStrictEqual(settle(p), { redraws: 0, quiet: true }, `${scenario}: settles with no redraw`);
      assert.deepStrictEqual(settle(p), { redraws: 0, quiet: true }, `${scenario}: and stays quiet`);
    }
  });

  check(`classic scrollbar (${mode}): a real width change (400 → 300 → 400) redraws the pane exactly once each way`, () => {
    const p = boot({ scenario: 'fxbigdeploy', shim, height: 900 });
    settle(p);
    p.el('status').clientWidth = 300;
    assert.deepStrictEqual(settle(p), { redraws: 1, quiet: true }, 'narrower');
    p.el('status').clientWidth = 400;
    assert.deepStrictEqual(settle(p), { redraws: 1, quiet: true }, 'and back');
    p.el('status').clientHeight = 500;
    assert.deepStrictEqual(settle(p), { redraws: 0, quiet: true }, 'a height change only repaints the list');
  });

  check(`classic scrollbar (${mode}): a pane drawn hidden (width 0) is drawn again once when shown, then is quiet`, () => {
    const p = boot({ shim, height: 900 });
    p.el('status').clientWidth = 0;
    p.deliver(runsMsg('fxdeployfail'));
    assert.deepStrictEqual(settle(p), { redraws: 0, quiet: true }, 'hidden: nothing to redraw');
    p.el('status').clientWidth = 400;
    assert.deepStrictEqual(settle(p), { redraws: 1, quiet: true }, 'shown');
  });
}

// A redraw decides the toggles while the pane is empty, before the list is in
// it; Expand, a fold or a search rebuilds only the list, in the filled pane.
// With the gutter kept from the start (scrollbar-gutter: stable) both read the
// filled pane's width, so they agree.
// At 400px less the scrollbar the card holds 46 characters a line and a row 47
// (47 and 49 at a full 400): CARD_390 takes three lines of 47 but six of 46,
// ROW_390 two lines of 49 but four of 47.
const CARD_390 = Array.from({ length: 3 }, () => `${'x'.repeat(23)} ${'y'.repeat(23)}`).join(' ');
const ROW_390 = Array.from({ length: 2 }, () => `${'x'.repeat(24)} ${'y'.repeat(24)}`).join(' ');
check('classic scrollbar: the toggles are decided at the width of the filled pane — the gutter is kept while it is still empty', () => {
  const { msg } = longRun(CARD_390);
  const { long } = longRun(ROW_390);
  const rows = msg.latestRows.rows.map(r => (r.k === long ? { ...r, m: ROW_390 } : r));
  const both = { ...msg, latestRows: { ...msg.latestRows, rows } };
  const p = boot({ shim: CLASSIC, height: 5000 });
  p.deliver(both);
  settle(p);
  const card = p.el('status').find(e => has(e, 'run-plain') && e.textContent === CARD_390);
  const after = card._parent.children[card._parent.children.indexOf(card) + 1];
  assert.ok(after && has(after, 'show-more'), 'the card\'s message: six lines of 46 in the filled pane');
  click(chipBtn(p, 'failed'));
  settle(p);
  assert.ok(moreOf(rowFor(p, long)), 'a row, the pane drawn whole for the chip: four lines of 47');
  click(p.el('status').find(e => e.tagName === 'BUTTON' && e.textContent === 'Expand'));
  settle(p);
  assert.ok(moreOf(rowFor(p, long)), 'the same row, only the list rebuilt (Expand): the same toggle');
});

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
check('this harness is registered in package.json "check"', () => {
  assert.ok(pkg.scripts.check.includes('node ./scripts/check-status-pane.cjs'));
});

Promise.all(waiting).then(() => {
  if (failed) { console.error(`status-pane: ${failed}/${ran} checks FAILED`); process.exit(1); }
  console.log(`status-pane: all ${ran} checks passed`);
});
