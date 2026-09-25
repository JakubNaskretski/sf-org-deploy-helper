// Runnable contract test for the Status pane's run-card logic (src/runView.js):
// verdicts, chips, the explain line, the rows of the virtual list, the actions
// of the newest run and the copied text. No framework, no DOM.
//   1) npm run compile   2) node scripts/check-run-view.cjs
//
// The pane answers "what happened to my deploy" in one glance, then lets the
// user dig through thousands of rows, so the words and the numbers are the
// contract:
//   1) every verdict says what the ORG did — a failed deploy changed nothing
//      (all-or-nothing), a validation deploys nothing, a run that never
//      started or lost contact says so and what to do next;
//   2) the chips are the run's exact counts, in a fixed order, and filter the
//      list; the line under them explains what the active filter means, with
//      the skipped-row wording the result card has always used;
//   3) the list groups by type, failures first, opens every group when it is
//      short and only the groups holding a failure when it is long, and says
//      so when the counts know about rows it does not hold;
//   4) only the newest run acts: Retry re-sends exactly what was sent (never a
//      skipped row), Quick Deploy only while the offer is live, an older run
//      can only be copied — and every action honours the busy/pending locks
//      the toolbar does.
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const RV = require(path.join(__dirname, '..', 'src', 'runView.js'));
const RR = require(path.join(__dirname, '..', 'out', 'runRecords.js'));
const F = require('./lib/run-fixtures.cjs');

let failed = 0;
let ran = 0;
function check(name, fn) {
  ran++;
  try { fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}

// A fixed "now" (local time), so "today" / "yesterday" read the same on every run.
const NOW = new Date(2026, 8, 25, 15, 0, 0).getTime();
const SC = F.buildScenarios(NOW);
const S = (id) => { const s = SC.find(x => x.id === id); assert.ok(s, `no scenario ${id}`); return s; };
const run = (id) => S(id).run;
const hm = (t) => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const title = (r, ctx) => RV.titleText(r, Object.assign({ now: NOW }, ctx || {}));
const plain = (r, ctx) => RV.verdictFor(r, Object.assign({ now: NOW }, ctx || {})).plain.map(p => p.text);
const chips = (r) => RV.chipDefs(r).map(c => `${c.id}:${c.n}${c.disabled ? ':off' : ''}`);
const UI = (over) => Object.assign({ filter: 'all', q: '', folds: {}, openAll: undefined }, over || {});
const leaves = (m) => m.rows.filter(r => r.k === 'leaf');
const LATEST = (r, over) => Object.assign({ isLatest: true, busy: false, pending: false, complete: true, sent: RR.sentKeys(r), selectKeys: r.rows.filter(x => x.o !== 'skipped' && x.o !== 'missing').map(x => x.k) }, over || {});
const ids = (a) => a.buttons.map(b => b.id);
const base = (over) => Object.assign({ v: 1, id: 'runtest1', op: 'deploy', status: 'succeeded', org: 'acme-dev-user', orgLabel: 'acme-dev', orgKind: 'sandbox', startedAt: NOW - 60_000, finishedAt: NOW, target: 'selection', counts: {}, rows: [], rowsComplete: true, tests: [] }, over || {});

// ================================================================ vocabulary
check('the outcome vocabulary is exactly the run records\' (a new outcome gets a label, colour and chip slot)', () => {
  assert.deepStrictEqual(Object.keys(RV.OUTCOMES).sort(), [...RR.OUTCOMES].sort());
  for (const o of RR.OUTCOMES) assert.ok(RV.DEPLOY_CHIPS.includes(o) || RV.RETRIEVE_CHIPS.includes(o), `${o} has no chip slot`);
});

// ============================================================ 1) verdicts
check('big deploy: ✓ Deployed to the org; the sub-line is when · how long (the chips carry the counts)', () => {
  const r = run('fxbigdeploy');
  const v = RV.verdictFor(r, { now: NOW });
  assert.strictEqual(v.kind, 'ok');
  assert.strictEqual(v.glyph, '✓');
  assert.strictEqual(title(r), 'Deployed to acme-dev');
  assert.strictEqual(v.sub, `today ${hm(r.startedAt)} · 4m 12s`);
  assert.deepStrictEqual(plain(r), []);
});

check('failed deploy: ✗ Not deployed — the org rejected it, and nothing changed (all-or-nothing)', () => {
  const r = run('fxdeployfail');
  assert.strictEqual(RV.verdictFor(r, { now: NOW }).kind, 'err');
  assert.strictEqual(title(r), 'Not deployed — acme-prod rejected the deploy');
  assert.deepStrictEqual(plain(r), ['Nothing changed on acme-prod: a deploy is all-or-nothing.']);
});

check('tests failed: the title names the tests, the sub-line the pass count, the org\'s own message follows', () => {
  const r = run('fxtestsfail');
  const v = RV.verdictFor(r, { now: NOW });
  assert.strictEqual(title(r), 'Not deployed — tests failed on acme-prod');
  assert.ok(v.sub.endsWith(' · 19m 0s · 398/412 tests passed'), v.sub);
  assert.deepStrictEqual(plain(r), [
    'Nothing changed on acme-prod: a deploy is all-or-nothing.',
    'Average test coverage across all Apex Classes and Triggers is 71%, at least 75% test coverage is required.'
  ]);
});

check('validated with tests: nothing deployed yet; the Quick Deploy offer names its deadline only while it is live', () => {
  const r = run('fxvalidateqd');
  assert.strictEqual(title(r), 'Validated on acme-prod — nothing deployed yet');
  assert.ok(RV.verdictFor(r, { now: NOW }).sub.endsWith('380/380 tests passed'));
  const until = S('fxvalidateqd').live.quick.until;
  const d = new Date(until);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  assert.deepStrictEqual(plain(r, { quick: S('fxvalidateqd').live.quick }), [`Quick Deploy applies exactly this set without re-running tests — available until ${month} ${d.getDate()}.`]);
  assert.deepStrictEqual(plain(r), [], 'no live offer, no deadline');
});

check('validated without tests: the sub-line says no tests ran', () => {
  assert.ok(RV.verdictFor(run('fxvalidatenotest'), { now: NOW }).sub.endsWith(' · no tests run'));
});

check('quick deploy: names the validation it applied and that no tests re-ran', () => {
  const r = run('fxquickdeploy');
  assert.strictEqual(title(r), 'Quick-deployed to acme-prod');
  const from = run('fxvalidateqd');
  assert.deepStrictEqual(plain(r, { fromRun: from }), [`Applied the set validated yesterday ${hm(from.startedAt)} — no tests were re-run.`]);
  assert.deepStrictEqual(plain(r), ['Applied the set validated earlier — no tests were re-run.']);
});

check('retrieve: ↓ Retrieved from the org, with the backup note when one was kept', () => {
  const r = run('fxretrieve');
  const v = RV.verdictFor(r, { now: NOW });
  assert.strictEqual(v.glyph, '↓');
  assert.strictEqual(title(r), 'Retrieved from acme-dev');
  assert.strictEqual(plain(r)[0], 'Your local copies were backed up before being overwritten — Restore or Discard below.');
  const none = base({ op: 'retrieve', counts: { changed: 0, created: 0, unchanged: 0, missing: 2, failed: 0 } });
  assert.strictEqual(title(none), 'Nothing retrieved from acme-dev');
  assert.strictEqual(RV.verdictFor(none, { now: NOW }).kind, 'warn');
});

check('running: a spinner and "…ing to the org"; a requested cancel says what the org was asked', () => {
  const r = run('fxrunning');
  const v = RV.verdictFor(r, { now: NOW });
  assert.strictEqual(v.kind, 'run');
  assert.strictEqual(v.glyph, null);
  assert.strictEqual(title(r), 'Deploying to acme-dev…');
  assert.strictEqual(title(r, { cancelRequested: true }), 'Cancelling on acme-dev…');
  assert.deepStrictEqual(plain(r, { cancelRequested: true }), ['The org was asked to stop; whatever it already processed is rolled back.']);
});

check('a submit that failed: "didn\'t start", the CLI message, the hint and what to try', () => {
  const r = run('fxconflict');
  assert.strictEqual(title(r), "Deploy to acme-dev didn't start");
  const p = plain(r);
  assert.ok(p[0].startsWith('Conflicts detected: 2 components'));
  assert.strictEqual(p[1], 'Hint: The org has changes that conflict with your local files — retrieve them first, or enable Overwrite org changes in the panel.');
  assert.deepStrictEqual(p.slice(2), ['Try: Retrieve the conflicting components, then deploy again.', 'Try: Or deploy with Overwrite org changes to replace them.']);
  assert.strictEqual(title(base({ op: 'validate', status: 'error' })), "Validation on acme-dev didn't start");
});

check('lost contact, cancelled, interrupted, timed out, cancel unconfirmed: each says what is known and what to do', () => {
  assert.strictEqual(title(run('fxlost')), 'Lost contact with the deploy to acme-prod');
  assert.ok(plain(run('fxlost'))[0].includes('Resume monitoring checks the same job — it does not deploy again.'));
  assert.strictEqual(title(run('fxcancelled')), 'Cancelled — nothing changed on acme-dev');
  assert.deepStrictEqual(plain(run('fxcancelled')), ['241 of 410 components had been processed when the org stopped and rolled back.']);
  assert.strictEqual(title(run('fxinterrupted')), 'Interrupted — acme-scratch-7');
  assert.deepStrictEqual(plain(run('fxinterrupted')), ["The window closed while this ran; its result wasn't recorded. Check Deployment Status in the org."]);
  assert.strictEqual(title(base({ status: 'timeout' })), 'Timed out waiting for acme-dev');
  assert.ok(plain(base({ status: 'timeout' }))[0].startsWith('Stopping the wait did not stop the org'));
  assert.strictEqual(title(base({ status: 'cancelUnconfirmed' })), 'Cancel requested — acme-dev may still finish');
});

check('failed validation and failed quick deploy: their own words, never "deployed"', () => {
  assert.strictEqual(title(base({ op: 'validate', status: 'failed', counts: { failed: 1, passed: 3 } })), 'Not validated — acme-dev rejected the validation');
  assert.deepStrictEqual(plain(base({ op: 'validate', status: 'failed', counts: { failed: 1 } })), ['Nothing is deployed by a validation; fix the failures and validate again.']);
  assert.strictEqual(title(base({ op: 'quickDeploy', status: 'failed', counts: { failed: 1 } })), 'Quick Deploy failed on acme-dev');
  assert.ok(plain(base({ op: 'quickDeploy', status: 'failed' }))[0].startsWith('The validation may have expired'));
});

check('partly deployed: ⚠, and the org applied some and rejected others', () => {
  const r = base({ status: 'partial', counts: { deployed: 5, failed: 2 } });
  const v = RV.verdictFor(r, { now: NOW });
  assert.strictEqual(v.kind, 'warn');
  assert.strictEqual(title(r), 'Partly deployed to acme-dev');
  assert.deepStrictEqual(plain(r), ['acme-dev applied some of these and rejected others.']);
});

check('every one-liner of an older run', () => {
  const want = {
    fxbigdeploy: 'Deployed 9,047 → acme-dev · 2,535 skipped',
    fxdeployfail: 'Deploy failed → acme-prod · 41 errors',
    fxtestsfail: 'Deploy failed → acme-prod · 14 tests failed',
    fxvalidateqd: 'Validated 1,204 on acme-prod',
    fxquickdeploy: 'Quick-deployed 1,204 → acme-prod',
    fxvalidatenotest: 'Validated 37 on acme-dev · no tests',
    fxretrieve: 'Retrieved 309 ← acme-dev · 3 not on org',
    fxrunning: 'Deploying to acme-dev…',
    fxconflict: "Deploy didn't start → acme-dev",
    fxlost: 'Lost contact → acme-prod',
    fxcancelled: 'Cancelled deploy → acme-dev',
    fxinterrupted: 'Interrupted validation → acme-scratch-7'
  };
  assert.deepStrictEqual(Object.keys(want).sort(), SC.map(s => s.id).sort(), 'every scenario has a one-liner here');
  for (const [id, text] of Object.entries(want)) assert.strictEqual(RV.histLabel(run(id)).text, text, id);
});

// ============================================================== 2) chips
check('chips are the exact counts, in a fixed order per run; Failed 0 stays (disabled), other zeros and unknowns have none', () => {
  const want = {
    fxbigdeploy: ['all:11582', 'deployed:9047', 'failed:0:off', 'skipped:2535'],
    fxdeployfail: ['all:3176', 'failed:41', 'rolledback:3120', 'skipped:15'],
    fxtestsfail: ['all:98', 'failed:0:off', 'rolledback:84', 'tests:14'],
    fxvalidateqd: ['all:1204', 'validated:1204', 'failed:0:off'],
    fxquickdeploy: ['all:1204', 'deployed:1204', 'failed:0:off'],
    fxvalidatenotest: ['all:37', 'validated:37', 'failed:0:off'],
    fxretrieve: ['all:312', 'changed:237', 'created:61', 'unchanged:11', 'missing:3', 'failed:0:off'],
    fxrunning: ['all:2535', 'skipped:2535'],
    fxconflict: ['all:12', 'pending:12'],
    fxlost: ['all:805', 'pending:800', 'skipped:5'],
    fxcancelled: ['all:446', 'failed:0:off', 'rolledback:410', 'skipped:36'],
    fxinterrupted: ['all:4', 'skipped:4']
  };
  for (const [id, c] of Object.entries(want)) assert.deepStrictEqual(chips(run(id)), c, id);
});

check('chip labels speak the run\'s language: Updated / New / Not on org for a retrieve, Not deployed for a run that never started', () => {
  assert.deepStrictEqual(RV.chipDefs(run('fxretrieve')).map(c => c.label), ['All', 'Updated', 'New', 'Unchanged', 'Not on org', 'Failed']);
  assert.strictEqual(RV.chipDefs(run('fxconflict'))[1].label, 'Not deployed');
  assert.strictEqual(RV.chipDefs(run('fxlost'))[1].label, 'No result');
  assert.strictEqual(RV.chipDefs(run('fxtestsfail')).find(c => c.id === 'tests').label, 'Tests failed');
});

check('a count the run cannot know is no chip at all (a reattached report has no skipped count)', () => {
  const r = base({ target: 'report', counts: { deployed: 250, failed: 0 } });
  assert.ok(!RV.chipDefs(r).some(c => c.id === 'skipped'));
});

// ============================================================ explain line
check('with no filter: one legend line — skipped first, then rolled back, then passed; none otherwise', () => {
  const ex = (r) => { const e = RV.explainFor(r, 'all', r.rows); return e.lead + e.text; };
  assert.strictEqual(ex(run('fxdeployfail')), 'Skipped = selected but never sent, so neither deployed nor failed — the Skipped chip says why.');
  assert.strictEqual(ex(run('fxtestsfail')), 'Rolled back = fine on its own, but not applied: a deploy is all-or-nothing.');
  assert.strictEqual(ex(base({ op: 'validate', status: 'failed', counts: { failed: 1, passed: 3 } })), 'Passed = checked fine on its own; a validation applies nothing either way.');
  assert.strictEqual(ex(run('fxvalidateqd')), '');
});

check('the Skipped filter explains in the result card\'s own words: unread types first (named), then org-only', () => {
  const r = run('fxdeployfail');
  assert.strictEqual(RV.explainFor(r, 'skipped', r.rows).text,
    "3 skipped — this panel can't read Bot, CustomObjectTranslation from your project: if you have them locally, they were NOT deployed — deploy them from the Explorer (right-click the -meta.xml) or with a package.xml."
    + ' 12 skipped — selected, but they exist only on the org, so there was no local file to deploy.');
  const one = base({ counts: { skipped: 1 }, rows: [{ k: 'Report:R', o: 'skipped', why: 'org' }] });
  assert.strictEqual(RV.explainFor(one, 'skipped', one.rows).text, '1 skipped — selected, but it exists only on the org, so there was no local file to deploy.');
});

check('the other filters say what their rows mean', () => {
  const fail = run('fxdeployfail');
  assert.strictEqual(RV.explainFor(fail, 'failed').text, 'acme-prod rejected these. A deploy is all-or-nothing, so nothing from this run was applied.');
  assert.strictEqual(RV.explainFor(fail, 'rolledback').text, 'Fine on their own, but a deploy is all-or-nothing: because 41 components failed, none of these were applied. acme-prod is unchanged.');
  assert.ok(RV.explainFor(run('fxtestsfail'), 'rolledback').text.includes('because tests failed'));
  assert.strictEqual(RV.explainFor(run('fxbigdeploy'), 'deployed').text, 'Live on acme-dev now.');
  assert.strictEqual(RV.explainFor(run('fxconflict'), 'pending').text, 'The deploy stopped before reaching acme-dev — nothing from this run was applied.');
  assert.ok(RV.explainFor(run('fxlost'), 'pending').text.includes('the org may still apply them'));
  assert.strictEqual(RV.explainFor(run('fxretrieve'), 'missing').text, 'Asked for, but acme-dev has no such component — nothing to retrieve.');
  assert.ok(RV.explainFor(run('fxtestsfail'), 'tests').text.endsWith('; the whole deploy was rolled back.'));
});

// ============================================================= 3) the list
check('groups: most failures first, then the biggest; within a group failures first, then by name', () => {
  const r = run('fxdeployfail');
  const m = RV.buildRows(r, r.rows, r.tests, UI());
  const groups = m.rows.filter(x => x.k === 'group');
  assert.strictEqual(groups[0].label, 'ApexClass', 'ApexClass holds the most failures (24)');
  for (let i = 1; i < groups.length; i++) {
    const a = groups[i - 1], b = groups[i];
    assert.ok(a.failed > b.failed || (a.failed === b.failed && (a.n > b.n || (a.n === b.n && a.label < b.label))), `${a.label} before ${b.label}`);
  }
  const apex = [];
  for (let i = m.rows.indexOf(groups[0]) + 1; i < m.rows.length && m.rows[i].k === 'leaf'; i++) apex.push(m.rows[i]);
  const firstOk = apex.findIndex(x => x.row.o !== 'failed');
  assert.strictEqual(firstOk, 24, 'the 24 failures lead the group');
  for (const part of [apex.slice(0, 24), apex.slice(24)]) {
    for (let i = 1; i < part.length; i++) assert.ok(part[i - 1].name <= part[i].name, `${part[i - 1].name} before ${part[i].name}`);
  }
});

check('up to 300 listed rows every group starts open; from 301 only the groups holding a failure', () => {
  const rows = (n, failures) => Array.from({ length: n }, (_, i) => ({ k: `${['ApexClass', 'Flow', 'Layout'][i % 3]}:Acme${String(i).padStart(4, '0')}`, o: i < failures ? 'failed' : 'deployed', s: 1 }));
  const open = (n, failures) => RV.buildRows(base(), rows(n, failures), [], UI()).rows.filter(x => x.k === 'group').map(g => `${g.label}:${g.open}`);
  assert.deepStrictEqual(open(300, 0), ['ApexClass:true', 'Flow:true', 'Layout:true']);
  assert.deepStrictEqual(open(301, 0), ['ApexClass:false', 'Flow:false', 'Layout:false']);
  assert.deepStrictEqual(open(301, 1), ['ApexClass:true', 'Flow:false', 'Layout:false']);
  assert.strictEqual(RV.DEFAULT_OPEN_MAX, 300);
});

check('the 11,582-row deploy opens on its 25 types (no failures to open), and builds fast', () => {
  const r = run('fxbigdeploy');
  const t0 = Date.now();
  const m = RV.buildRows(r, r.rows, r.tests, UI());
  const cold = Date.now() - t0;
  assert.strictEqual(m.rows.length, 25);
  assert.ok(m.rows.every(x => x.k === 'group' && !x.open));
  assert.strictEqual(m.visible.length, 11582);
  assert.ok(cold < 250, `cold build took ${cold} ms`);
  const all = RV.buildRows(r, r.rows, r.tests, UI({ openAll: true }));
  assert.strictEqual(all.rows.length, 11582 + 25);
  assert.strictEqual(all.totalH, 25 * 24 + 11582 * 22);
});

check('a chip filter lists only its rows; search matches name, type, message and file (all terms, any case)', () => {
  const r = run('fxdeployfail');
  const failedOnly = RV.buildRows(r, r.rows, r.tests, UI({ filter: 'failed' }));
  assert.strictEqual(failedOnly.visible.length, 41);
  assert.ok(leaves(failedOnly).every(x => x.row.o === 'failed'));
  const fr = r.rows.find(x => x.o === 'failed' && x.f && x.l);
  const byFile = RV.buildRows(r, r.rows, r.tests, UI({ q: fr.f.toUpperCase() }));
  assert.ok(byFile.visible.some(x => x.k === fr.k));
  const byMsg = RV.buildRows(r, r.rows, r.tests, UI({ q: 'relationship ACMELINES__R' }));
  assert.ok(byMsg.visible.length > 0 && byMsg.visible.every(x => /AcmeLines__r/.test(x.m)));
  const byType = RV.buildRows(r, r.rows, r.tests, UI({ q: 'bot' }));
  assert.ok(byType.visible.some(x => x.k.startsWith('Bot:')));
  assert.strictEqual(RV.buildRows(r, r.rows, r.tests, UI({ q: 'nosuchthing zzz' })).rows.length, 0);
});

check('folds: an explicit fold beats the default, Expand/Collapse all beat the default, and folds are per filter', () => {
  const r = run('fxdeployfail');
  const id = 'all|c|ApexClass';
  const closed = RV.buildRows(r, r.rows, r.tests, UI({ folds: { [id]: false } }));
  assert.strictEqual(closed.rows.find(x => x.id === id).open, false);
  assert.ok(RV.buildRows(r, r.rows, r.tests, UI({ openAll: true })).rows.filter(x => x.k === 'group').every(g => g.open));
  assert.ok(RV.buildRows(r, r.rows, r.tests, UI({ openAll: false })).rows.filter(x => x.k === 'group').every(g => !g.open));
  const other = RV.buildRows(r, r.rows, r.tests, UI({ filter: 'failed', folds: { [id]: false } }));
  assert.strictEqual(other.rows.find(x => x.id === 'failed|c|ApexClass').open, true, 'a fold made under All does not close the Failed view');
});

check('test failures: their own section grouped by class, under a Components section; the Tests chip lists only them', () => {
  const r = run('fxtestsfail');
  const m = RV.buildRows(r, r.rows, r.tests, UI());
  const sections = m.rows.filter(x => x.k === 'section').map(x => `${x.label}:${x.n}`);
  assert.deepStrictEqual(sections, ['Components:84', 'Apex test failures:14']);
  assert.strictEqual(m.rows.filter(x => x.k === 'test').length, 14);
  assert.ok(m.rows.filter(x => x.k === 'tgroup').every(g => g.open), 'test classes always open: every one holds a failure');
  const only = RV.buildRows(r, r.rows, r.tests, UI({ filter: 'tests' }));
  assert.ok(only.rows.every(x => x.k === 'tgroup' || x.k === 'test' || x.k === 'section'));
  assert.strictEqual(only.visibleTests.length, 14);
});

check('row heights are fixed: 22 plain, 54 with a message or a test, 24 a group, 22 a section; offsets add up', () => {
  const r = run('fxtestsfail');
  const m = RV.buildRows(r, r.rows, r.tests, UI());
  for (const x of m.rows) {
    const want = x.k === 'group' || x.k === 'tgroup' ? 24 : x.k === 'section' || x.k === 'note' ? 22 : x.k === 'test' ? 54 : x.row.m ? 54 : 22;
    assert.strictEqual(x.h, want, x.k);
  }
  for (let i = 0; i < m.rows.length; i++) assert.strictEqual(m.offsets[i + 1] - m.offsets[i], m.rows[i].h);
  assert.strictEqual(m.totalH, m.offsets[m.rows.length]);
});

check('a summary list says how many rows it does not hold, and why; the org\'s un-itemized count says so too', () => {
  const r = RR.summarizeRun(run('fxbigdeploy'), { latest: true });
  const m = RV.buildRows(r, r.rows, r.tests, UI(), { complete: r.rowsComplete });
  const note = m.rows.find(x => x.k === 'note');
  assert.ok(note, 'a note row');
  assert.strictEqual(note.text, '11,532 more rows not listed — the full list is kept for the newest run only, and was not available after the window reloaded.');
  const deployedOnly = RV.buildRows(r, r.rows, r.tests, UI({ filter: 'deployed' }), { complete: false });
  assert.ok(deployedOnly.rows.find(x => x.k === 'note').text.startsWith('9,047 more rows not listed'));
  assert.ok(!RV.buildRows(r, r.rows, r.tests, UI({ q: 'acme' }), { complete: false }).rows.some(x => x.k === 'note'), 'a search only speaks for what is listed');
  const report = base({ target: 'report', counts: { deployed: 250, failed: 0 }, rows: [{ k: 'ApexClass:A', o: 'deployed', s: 1 }] });
  assert.ok(RV.buildRows(report, report.rows, [], UI(), { complete: true }).rows.find(x => x.k === 'note').text.endsWith('the org counted them without itemizing them.'));
});

// ====================================================== the window of rows
check('visibleRange: every row meeting the view, plus the overscan either side, end exclusive', () => {
  const offsets = [0, 22, 44, 66, 88, 110, 132, 154, 176, 198, 220];   // ten 22px rows
  assert.deepStrictEqual(RV.visibleRange(offsets, 10, 0, 44, 0), [0, 2]);
  assert.deepStrictEqual(RV.visibleRange(offsets, 10, 23, 44, 0), [1, 4], 'a partly visible row counts');
  assert.deepStrictEqual(RV.visibleRange(offsets, 10, 66, 44, 2), [1, 7]);
  assert.deepStrictEqual(RV.visibleRange(offsets, 10, 176, 44, 6), [2, 10], 'the last row is in at the bottom');
  assert.deepStrictEqual(RV.visibleRange(offsets, 10, -300, 100, 6), [0, 7], 'a list still below the view paints its head only');
  assert.deepStrictEqual(RV.visibleRange(offsets, 0, 0, 100, 6), [0, 0]);
});

// ============================================================ 4) actions
check('only the newest run acts: any other run — every scenario — offers Copy and nothing else', () => {
  for (const s of SC) {
    const a = RV.actionsFor(s.run, Object.assign(LATEST(s.run), { isLatest: false, quick: (s.live || {}).quick, suggest: (s.live || {}).suggest }));
    assert.deepStrictEqual(ids(a), s.run.status === 'running' ? [] : ['copy'], s.id);
    assert.strictEqual(a.why, '', s.id);
  }
});

check('what the newest run offers in each state', () => {
  const offer = (id, over) => { const s = S(id); return ids(RV.actionsFor(s.run, LATEST(s.run, Object.assign({ quick: (s.live || {}).quick, suggest: (s.live || {}).suggest }, over)))); };
  assert.deepStrictEqual(offer('fxrunning'), [], 'running: the toolbar Cancel is the only control');
  assert.deepStrictEqual(offer('fxdeployfail'), ['retry', 'suggest', 'select', 'copy']);
  assert.deepStrictEqual(offer('fxtestsfail'), ['retry', 'select', 'copy']);
  assert.deepStrictEqual(offer('fxconflict'), ['retry', 'retryOverwrite', 'select', 'copy']);
  assert.deepStrictEqual(offer('fxbigdeploy'), ['select', 'copy']);
  assert.deepStrictEqual(offer('fxquickdeploy'), ['select', 'copy']);
  assert.deepStrictEqual(offer('fxvalidateqd'), ['quickDeploy', 'select', 'copy']);
  assert.deepStrictEqual(offer('fxvalidatenotest'), ['select', 'copy']);
  assert.deepStrictEqual(offer('fxretrieve'), ['restore', 'discard', 'select', 'copy']);
  assert.deepStrictEqual(offer('fxlost'), ['resume', 'copy']);
  assert.deepStrictEqual(offer('fxcancelled'), ['copy']);
  assert.deepStrictEqual(offer('fxinterrupted'), ['copy']);
  assert.deepStrictEqual(ids(RV.actionsFor(base({ status: 'timeout' }), LATEST(base()))), ['copy']);
  assert.deepStrictEqual(ids(RV.actionsFor(base({ status: 'cancelUnconfirmed' }), LATEST(base()))), ['copy']);
  assert.deepStrictEqual(ids(RV.actionsFor(base({ op: 'quickDeploy', status: 'failed', counts: { failed: 1 } }), LATEST(base()))), ['copy'], 'a failed quick deploy has no request to retry');
});

check('Retry re-sends exactly the sent rows with the run\'s own options; + overwrite adds ignoreConflicts, never on a validation', () => {
  const r = run('fxconflict');
  const a = RV.actionsFor(r, LATEST(r));
  const retry = a.buttons.find(b => b.id === 'retry');
  assert.deepStrictEqual(retry.message, { type: 'retryDeploy', request: { validateOnly: false, testLevel: 'NoTestRun', keys: RR.sentKeys(r) } });
  assert.strictEqual(retry.label, 'Retry deploy');
  assert.strictEqual(a.buttons.find(b => b.id === 'retryOverwrite').message.request.ignoreConflicts, true);
  const f = run('fxdeployfail');
  const keys = RV.actionsFor(f, LATEST(f)).buttons.find(b => b.id === 'retry').message.request.keys;
  assert.strictEqual(keys.length, 3161);
  assert.ok(!keys.some(k => f.rows.find(x => x.k === k).o === 'skipped'), 'a skipped row is never re-sent');
  const v = base({ op: 'validate', status: 'failed', conflict: true, retry: { validateOnly: true, testLevel: 'RunLocalTests' }, rows: [{ k: 'ApexClass:A', o: 'failed', s: 1 }], counts: { failed: 1 } });
  const va = RV.actionsFor(v, LATEST(v));
  assert.deepStrictEqual(ids(va).filter(x => x.startsWith('retry')), ['retry']);
  assert.strictEqual(va.buttons[0].label, 'Retry validation');
  const man = base({ status: 'failed', target: 'manifest', retry: { validateOnly: false, manifest: '/ws/manifest/package.xml' }, counts: { failed: 1 } });
  assert.deepStrictEqual(RV.actionsFor(man, LATEST(man, { sent: ['ApexClass:A'] })).buttons[0].message.request, { validateOnly: false, manifest: '/ws/manifest/package.xml' }, 'a package.xml retry sends the manifest, not keys');
});

check('Retry is hidden, with the reason, when the full list of what was sent is not here (after a reload)', () => {
  const r = run('fxdeployfail');
  const a = RV.actionsFor(r, LATEST(r, { complete: false }));
  assert.ok(!ids(a).includes('retry'));
  assert.ok(a.why.startsWith('Retry needs the full list of what this run sent'), a.why);
  assert.ok(!ids(RV.actionsFor(r, LATEST(r, { sent: [] }))).includes('retry'));
});

check('Quick Deploy: offered only with the live offer, once; otherwise the reason (no tests ran / not after a reload)', () => {
  const s = S('fxvalidateqd');
  const qd = RV.actionsFor(s.run, LATEST(s.run, { quick: s.live.quick })).buttons[0];
  assert.strictEqual(qd.label, 'Quick Deploy 1,204 to acme-prod');
  assert.deepStrictEqual(qd.message, { type: 'quickDeploy', jobId: '0AfAc000001kM7pSAE' });
  const used = RV.actionsFor(s.run, LATEST(s.run, { quick: s.live.quick, quickUsed: true }));
  assert.ok(!ids(used).includes('quickDeploy') && used.why === '');
  assert.ok(RV.actionsFor(s.run, LATEST(s.run)).why.startsWith("Quick Deploy isn't offered after the window reloads"));
  assert.ok(RV.actionsFor(run('fxvalidatenotest'), LATEST(run('fxvalidatenotest'))).why.startsWith("Quick Deploy isn't possible: no Apex tests ran"));
});

check('Resume, Restore and Discard carry the persisted job and folder the host re-validates', () => {
  const lost = run('fxlost');
  assert.deepStrictEqual(RV.actionsFor(lost, LATEST(lost)).buttons[0].message, { type: 'resumeDeploy', jobId: '0AfAc000001kJ3tSAE' });
  const ret = run('fxretrieve');
  const b = RV.actionsFor(ret, LATEST(ret)).buttons;
  assert.deepStrictEqual(b[0].message, { type: 'restoreBackup', dir: ret.backupDir });
  assert.deepStrictEqual(b[1].message, { type: 'discardBackup', dir: ret.backupDir });
});

check('busy: Retry still queues (says so), the slot-taking actions wait; pending: all of those wait; Select, Copy and Try never do', () => {
  const r = run('fxdeployfail');
  const busy = RV.actionsFor(r, LATEST(r, { busy: true, busyAction: 'Retrieve', suggest: S('fxdeployfail').live.suggest }));
  const retry = busy.buttons.find(b => b.id === 'retry');
  assert.strictEqual(retry.disabled, false);
  assert.strictEqual(retry.title, 'Will queue behind Retrieve');
  const pend = RV.actionsFor(r, LATEST(r, { pending: true, suggest: S('fxdeployfail').live.suggest }));
  assert.strictEqual(pend.buttons.find(b => b.id === 'retry').disabled, true);
  assert.strictEqual(pend.buttons.find(b => b.id === 'retry').title, 'Sending…');
  for (const id of ['select', 'copy', 'suggest']) assert.strictEqual(pend.buttons.find(b => b.id === id).disabled, false, id);
  const s = S('fxvalidateqd');
  for (const over of [{ busy: true }, { pending: true }]) {
    assert.strictEqual(RV.actionsFor(s.run, LATEST(s.run, Object.assign({ quick: s.live.quick }, over))).buttons[0].disabled, true, JSON.stringify(over));
    assert.strictEqual(RV.actionsFor(run('fxlost'), LATEST(run('fxlost'), over)).buttons[0].disabled, true);
    assert.ok(RV.actionsFor(run('fxretrieve'), LATEST(run('fxretrieve'), over)).buttons.slice(0, 2).every(b => b.disabled));
  }
});

check('Select names the count and the filter, and carries exactly the keys it is given', () => {
  const r = run('fxdeployfail');
  const keys = r.rows.filter(x => x.o === 'failed').map(x => x.k);
  const sel = RV.actionsFor(r, LATEST(r, { selectKeys: keys, filterLabel: 'failed' })).buttons.find(b => b.id === 'select');
  assert.strictEqual(sel.label, 'Select 41 failed in tree');
  assert.deepStrictEqual(sel.message, { type: 'selectDeployed', keys });
  assert.strictEqual(RV.actionsFor(r, LATEST(r, { filterLabel: 'failed' })).buttons.find(b => b.id === 'copy').label, 'Copy failed rows');
  assert.ok(!ids(RV.actionsFor(r, LATEST(r, { selectKeys: [] }))).includes('select'), 'nothing local to select, no button');
});

// ================================================================ copy
check('Copy: the verdict, then one block per type with name, outcome, file:line, message and reason', () => {
  const r = run('fxdeployfail');
  const f = r.rows.find(x => x.o === 'failed' && x.l && x.c);
  const text = RV.copyText(r, [f, r.rows.find(x => x.why === 'unread')], [], { now: NOW });
  const lines = text.split('\n');
  assert.ok(lines[0].startsWith('Not deployed — acme-prod rejected the deploy · today '), lines[0]);
  assert.strictEqual(lines[1], 'Nothing changed on acme-prod: a deploy is all-or-nothing.');
  assert.ok(text.includes(`\n  ${f.k} — Failed — ${f.f}:${f.l}:${f.c} — ${f.m}`));
  assert.ok(/\n {2}(Bot|CustomObjectTranslation):\S+ — Skipped — not read from your project \(right-click its -meta.xml to deploy\)/.test(text));
  const t = run('fxtestsfail');
  const tt = RV.copyText(t, [], t.tests.slice(0, 2), { now: NOW });
  assert.ok(tt.includes('\nApex test failures (2)\n  ' + `${t.tests[0].cls}.${t.tests[0].method} — line ${t.tests[0].l}, column 1 — ${t.tests[0].m}`));
});

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
check('this harness is registered in package.json "check"', () => {
  assert.ok(pkg.scripts.check.includes('node ./scripts/check-run-view.cjs'));
});

if (failed) { console.error(`run-view: ${failed}/${ran} checks FAILED`); process.exit(1); }
console.log(`run-view: all ${ran} checks passed`);
