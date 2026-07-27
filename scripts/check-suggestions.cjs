// Runnable contract test for the dependency-suggestion layer:
// buildSuggestionCandidates (metadataScanner.ts) and the suggestion feedback log
// (suggestionLog.ts). No framework.  1) npm run compile  2) node scripts/check-suggestions.cjs
const path = require('path');
const assert = require('assert');
const Module = require('module');
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? {} : origLoad(req, ...rest));

const { buildSuggestionCandidates, SUGGESTION_CANDIDATES_MAX } = require(path.join(__dirname, '..', 'out', 'metadataScanner.js'));
const { appendSuggestionEntry, formatSuggestionLog, mergeSuggestionEntry, SUGGESTION_LOG_CAP } = require(path.join(__dirname, '..', 'out', 'suggestionLog.js'));

let failed = 0;
let ran = 0;
function check(name, fn) {
  ran++;
  try { fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}

const item = (type, name) => ({ type, name, filePath: path.join('ws', type, name), files: [] });
const ITEMS = [
  item('ApexClass', 'MyHelper'),
  item('CustomObject', 'Billing__mdt'),
  item('CustomField', 'Order__c.Rate__c')
];

// ------------------------------------------------ buildSuggestionCandidates
check('per-row attribution: each candidate carries the failing component', () => {
  const out = buildSuggestionCandidates([
    { from: 'ApexClass:OrderSvc', problem: 'Invalid type: Billing__mdt' },
    { from: 'ApexClass:PayFlow', problem: 'Invalid type: MyHelper' }
  ], ITEMS, new Set());
  assert.deepStrictEqual(out, [
    { key: 'CustomObject:Billing__mdt', from: 'ApexClass:OrderSvc' },
    { key: 'ApexClass:MyHelper', from: 'ApexClass:PayFlow' }
  ]);
});

check('two rows naming the same missing component dedupe to the FIRST row', () => {
  const out = buildSuggestionCandidates([
    { from: 'ApexClass:A', problem: 'Invalid type: MyHelper' },
    { from: 'ApexClass:B', problem: 'Invalid type: MyHelper' }
  ], ITEMS, new Set());
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].from, 'ApexClass:A');
});

check('a component already in the deploy is never suggested', () => {
  const out = buildSuggestionCandidates(
    [{ from: 'ApexClass:A', problem: 'Invalid type: MyHelper' }],
    ITEMS, new Set(['ApexClass:MyHelper'])
  );
  assert.deepStrictEqual(out, []);
});

check('a referent with no local item yields no candidate (minting invariant)', () => {
  const out = buildSuggestionCandidates(
    [{ from: 'ApexClass:A', problem: 'Invalid type: Ghost__mdt' }],
    ITEMS, new Set()
  );
  assert.deepStrictEqual(out, []);
});

check('empty/missing problem strings are skipped', () => {
  const out = buildSuggestionCandidates(
    [{ from: 'ApexClass:A' }, { from: 'ApexClass:B', problem: '' }],
    ITEMS, new Set()
  );
  assert.deepStrictEqual(out, []);
});

check('candidate list is capped', () => {
  const many = [];
  const items = [];
  for (let i = 0; i < SUGGESTION_CANDIDATES_MAX + 10; i++) {
    items.push(item('ApexClass', `Dep${i}`));
    many.push({ from: `ApexClass:Src${i}`, problem: `Invalid type: Dep${i}` });
  }
  const out = buildSuggestionCandidates(many, items, new Set());
  assert.strictEqual(out.length, SUGGESTION_CANDIDATES_MAX);
});

// --------------------------------------------------------- suggestion log
check('appendSuggestionEntry caps and never mutates its input', () => {
  const base = [];
  let cur = base;
  for (let i = 0; i < SUGGESTION_LOG_CAP + 5; i++) {
    cur = appendSuggestionEntry(cur, { at: i, candidates: [], action: 'opened' });
  }
  assert.strictEqual(cur.length, SUGGESTION_LOG_CAP);
  assert.strictEqual(cur[0].at, 5, 'oldest entries fall off');
  assert.strictEqual(base.length, 0, 'input untouched');
});

check('empty log formats to a helpful one-liner', () => {
  const text = formatSuggestionLog([]);
  assert.ok(text.startsWith('Suggestion log — empty'), text);
});

check('format: header totals count deployed/worked/declined/bad, aborted apart', () => {
  const entries = [
    { at: 1730000000000, org: 'dev', candidates: [{ key: 'ApexClass:A' }], action: 'accepted', accepted: ['ApexClass:A'], outcome: 'worked' },
    { at: 1730000060000, org: 'dev', candidates: [{ key: 'ApexClass:B' }], action: 'accepted', accepted: ['ApexClass:B'], outcome: 'failed' },
    // An aborted accept never reached the org — it must NOT count as deployed.
    { at: 1730000090000, org: 'dev', candidates: [{ key: 'ApexClass:E' }], action: 'accepted', accepted: ['ApexClass:E'], outcome: 'aborted' },
    { at: 1730000120000, org: 'dev', candidates: [{ key: 'ApexClass:C' }], action: 'declined', declined: ['ApexClass:C'], verdict: 'bad' },
    { at: 1730000180000, org: 'dev', candidates: [{ key: 'ApexClass:D' }], action: 'opened' }
  ];
  const text = formatSuggestionLog(entries);
  const header = text.split('\n')[0];
  assert.ok(header.includes('5 entries'), header);
  assert.ok(header.includes('2 deployed (1 worked)'), header);
  assert.ok(header.includes('1 not run'), header);
  assert.ok(header.includes('1 declined (1 marked bad)'), header);
});

// ------------------------------------------------------ mergeSuggestionEntry
check('merge: correlates by FULL id — same-millisecond entries never collide', () => {
  let es = mergeSuggestionEntry([], 'sug-1000-0', 1000, { action: 'opened', candidates: [{ key: 'ApexClass:A' }] });
  es = mergeSuggestionEntry(es, 'sug-1000-1', 1000, { action: 'opened', candidates: [{ key: 'ApexClass:B' }] });
  assert.strictEqual(es.length, 2, 'two ids sharing an at-stamp stay separate');
  es = mergeSuggestionEntry(es, 'sug-1000-1', 1000, { outcome: 'worked' });
  assert.strictEqual(es.length, 2);
  assert.strictEqual(es[0].outcome, undefined, 'outcome landed on the right entry');
  assert.strictEqual(es[1].outcome, 'worked');
});

check('merge: accept after decline clears the stale verdict and declined residue', () => {
  let es = mergeSuggestionEntry([], 'sug-2000-0', 2000, {
    action: 'declined', candidates: [{ key: 'ApexClass:A' }], declined: ['ApexClass:A'], verdict: 'bad'
  });
  es = mergeSuggestionEntry(es, 'sug-2000-0', 2000, {
    action: 'accepted', accepted: ['ApexClass:A'], declined: undefined, verdict: undefined, outcome: undefined
  });
  assert.strictEqual(es.length, 1, 'still one entry');
  const e = es[0];
  assert.strictEqual(e.action, 'accepted');
  assert.deepStrictEqual(e.accepted, ['ApexClass:A']);
  assert.ok(!('verdict' in e), 'stale verdict cleared');
  assert.ok(!('declined' in e), 'stale declined cleared');
});

check('merge: a later outcome patch preserves accepted/declined fields', () => {
  let es = mergeSuggestionEntry([], 'sug-3000-0', 3000, {
    action: 'accepted', candidates: [{ key: 'ApexClass:A' }, { key: 'ApexClass:B' }],
    accepted: ['ApexClass:A'], declined: ['ApexClass:B']
  });
  es = mergeSuggestionEntry(es, 'sug-3000-0', 3000, { outcome: 'failed' });
  const e = es[0];
  assert.deepStrictEqual(e.accepted, ['ApexClass:A']);
  assert.deepStrictEqual(e.declined, ['ApexClass:B']);
  assert.strictEqual(e.outcome, 'failed');
});

check('candidate cap literal is pinned (a silent cap change must fail here)', () => {
  assert.strictEqual(SUGGESTION_CANDIDATES_MAX, 20);
});

check('org-controlled from is sanitized: control chars flattened, length capped', () => {
  const items2 = [item('ApexClass', 'MyHelper')];
  const out = buildSuggestionCandidates(
    [{ from: 'ApexClass:Evil\u0000Name\u001b' + 'X'.repeat(200), problem: 'Invalid type: MyHelper' }],
    items2, new Set()
  );
  assert.strictEqual(out.length, 1);
  assert.ok(!/[\x00-\x1f\x7f]/.test(out[0].from), JSON.stringify(out[0].from));
  assert.ok(out[0].from.length <= 100, `len ${out[0].from.length}`);
});

check('format: an accepted entry names outcome and unticked keys', () => {
  const text = formatSuggestionLog([{
    at: 1730000000000, org: 'dev',
    candidates: [{ key: 'ApexClass:A' }, { key: 'ApexClass:B' }],
    action: 'accepted', accepted: ['ApexClass:A'], declined: ['ApexClass:B'], outcome: 'worked'
  }]);
  assert.ok(text.includes('deployed 1/2'), text);
  assert.ok(text.includes('unticked ApexClass:B'), text);
  assert.ok(text.includes('retry OK'), text);
});

check('format: a declined-bad entry says so', () => {
  const text = formatSuggestionLog([{
    at: 1730000000000, org: 'dev', candidates: [{ key: 'ApexClass:A' }],
    action: 'declined', declined: ['ApexClass:A'], verdict: 'bad'
  }]);
  assert.ok(text.includes('declined, marked BAD'), text);
});

check('format: entries render chronologically, one line each', () => {
  const entries = [
    { at: 1730000000000, org: 'dev', candidates: [{ key: 'ApexClass:A' }], action: 'opened' },
    { at: 1730000060000, org: 'dev', candidates: [{ key: 'ApexClass:B' }], action: 'opened' }
  ];
  const lines = formatSuggestionLog(entries).split('\n');
  const iA = lines.findIndex(l => l.includes('ApexClass:A'));
  const iB = lines.findIndex(l => l.includes('ApexClass:B'));
  assert.ok(iA > 0 && iB > iA, `A@${iA} B@${iB}`);
});

if (failed) { console.error(`\n${failed} of ${ran} check(s) failed`); process.exit(1); }
console.log(`suggestions: all ${ran} checks passed`);
