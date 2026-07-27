// Runnable contract test for depGraph.ts (stripApexNoise / extractTokens /
// resolveLocalDependencies).   No framework.
//   1) npm run compile   2) node scripts/check-dep-graph.cjs
//
// The module resolves a "Deploy File + Dependencies" set from LOCAL Apex source
// by token matching — deliberately not a parser (false positives deploy an
// unchanged copy and are harmless; misses fall back to the failure card's
// Retry + missing). The contract under test: comments/strings never produce
// tokens, matches come ONLY from the scanned item list (canonical casing, so
// file text can never mint a `--metadata` key that isn't a real workspace
// component), platform names and entry keys are excluded, BFS is transitive,
// cycle-safe and deterministic, and both caps (depth / count) report
// truncation only when they actually cut something.
const path = require('path');
const assert = require('assert');
const Module = require('module');
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? {} : origLoad(req, ...rest));

const { stripApexNoise, extractTokens, resolveLocalDependencies } = require(path.join(__dirname, '..', 'out', 'depGraph.js'));
const p = (...s) => s.join(path.sep);

let failed = 0;
let ran = 0;
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const item = (type, name, file) => ({ type, name, filePath: p('ws', file), files: [] });

// A representative scanned workspace. The Acme* classes exist only as match
// targets for specific checks; DepFixService → DepFixHelper → DepFixQueue is
// the transitive chain, AcmeLoopA ⇄ AcmeLoopB the cycle.
const ITEMS = [
  item('ApexClass', 'DepFixService', 'classes/DepFixService.cls'),
  item('ApexClass', 'DepFixHelper', 'classes/DepFixHelper.cls'),
  item('ApexClass', 'DepFixQueue', 'classes/DepFixQueue.cls'),
  item('ApexClass', 'AcmeLoopA', 'classes/AcmeLoopA.cls'),
  item('ApexClass', 'AcmeLoopB', 'classes/AcmeLoopB.cls'),
  item('ApexClass', 'AcmeGen0', 'classes/AcmeGen0.cls'),
  item('ApexClass', 'AcmeGen1', 'classes/AcmeGen1.cls'),
  item('ApexClass', 'AcmeGen2', 'classes/AcmeGen2.cls'),
  item('ApexTrigger', 'WidgetTrigger', 'triggers/WidgetTrigger.trigger'),
  item('CustomObject', 'Widget__c', 'objects/Widget__c'),
  item('CustomObject', 'DepFixRule__mdt', 'objects/DepFixRule__mdt'),
  item('CustomField', 'Widget__c.Size__c', 'objects/Widget__c/fields/Size__c.field-meta.xml'),
  item('Layout', 'Widget__c-Widget Layout', 'layouts/Widget__c-Widget Layout.layout-meta.xml')
];

// Fixture sources, keyed by the items' filePath. String literals only — the
// suite must run from a bare checkout with no fixture tree on disk.
const SOURCES = new Map([
  [p('ws', 'classes/DepFixService.cls'),
    'public class DepFixService {\n  public void run() {\n    DepFixHelper.doThing();\n  }\n}\n'],
  [p('ws', 'classes/DepFixHelper.cls'),
    'public class DepFixHelper {\n  public static void doThing() {\n    DepFixQueue q = new DepFixQueue();\n  }\n}\n'],
  [p('ws', 'classes/DepFixQueue.cls'),
    'public class DepFixQueue {\n  Integer size = 0;\n}\n'],
  [p('ws', 'classes/AcmeLoopA.cls'),
    'public class AcmeLoopA {\n  AcmeLoopB other;\n}\n'],
  [p('ws', 'classes/AcmeLoopB.cls'),
    'public class AcmeLoopB {\n  AcmeLoopA other;\n}\n'],
  [p('ws', 'classes/AcmeGen0.cls'), 'public class AcmeGen0 {}\n'],
  [p('ws', 'classes/AcmeGen1.cls'), 'public class AcmeGen1 {}\n'],
  [p('ws', 'classes/AcmeGen2.cls'), 'public class AcmeGen2 {}\n'],
  [p('ws', 'triggers/WidgetTrigger.trigger'),
    'trigger WidgetTrigger on Widget__c (before insert) {\n'
    + '  DepFixRule__mdt cfg = DepFixRule__mdt.getInstance(\'main\');\n'
    + '  Object fld = Widget__c.Size__c;\n'
    + '}\n'],
  // Deliberately Apex-looking content behind a non-Apex item — proves non-Apex
  // entries are never read, not merely that their text happens to match nothing.
  [p('ws', 'layouts/Widget__c-Widget Layout.layout-meta.xml'),
    'DepFixHelper DepFixQueue Widget__c\n']
]);

const readFile = async fp => SOURCES.get(fp);
const resolve = (entry, opts, items = ITEMS) => resolveLocalDependencies(entry, items, readFile, opts);

// ------------------------------------------------------------ stripApexNoise
check('line comment content is blanked, code before/after survives', () => {
  const out = stripApexNoise('DepFixA // DepFixB\nDepFixC');
  assert.ok(!out.includes('DepFixB'), out);
  assert.ok(out.includes('DepFixA') && out.includes('DepFixC'), out);
});

check('block comment content is blanked', () => {
  const out = stripApexNoise('DepFixA /* DepFixB */ DepFixC');
  assert.ok(!out.includes('DepFixB'), out);
  assert.ok(out.includes('DepFixA') && out.includes('DepFixC'), out);
});

check('nested-looking /* */ ends at the FIRST terminator (Apex does not nest)', () => {
  const out = stripApexNoise('/* a /* b */ DepFixHelper');
  assert.ok(out.includes('DepFixHelper'), out);
  assert.ok(!out.includes(' a '), out);
});

check('string literals are blanked, including escaped quotes', () => {
  const out = stripApexNoise("String s = 'it\\'s DepFixB'; DepFixC");
  assert.ok(!out.includes('DepFixB'), out);
  assert.ok(out.includes('DepFixC'), out);
});

check('a removed span never fuses the tokens around it', () => {
  const out = stripApexNoise('DepFix/*x*/Helper');
  assert.ok(!/DepFixHelper/.test(out), out);
  assert.ok(/DepFix\s+Helper/.test(out), out);
});

check('comment markers inside a string do not open a comment', () => {
  const out = stripApexNoise("String u = '// not a comment'; DepFixC");
  assert.ok(out.includes('DepFixC'), out);
});

// ------------------------------------------------------------- extractTokens
check('dotted pair tolerates whitespace around the dot', () => {
  const toks = extractTokens('x = Widget__c . Size__c;');
  assert.ok(toks.dottedPairs.includes('Widget__c.Size__c'), JSON.stringify(toks.dottedPairs));
});

check('a dotted chain yields consecutive pairs', () => {
  const toks = extractTokens('alpha.beta.gamma');
  assert.deepStrictEqual(toks.dottedPairs, ['alpha.beta', 'beta.gamma']);
});

check('identifiers dedupe case-insensitively in first-appearance order', () => {
  const toks = extractTokens('DepFixHelper depfixhelper DepFixQueue');
  assert.deepStrictEqual(toks.identifiers, ['DepFixHelper', 'DepFixQueue']);
});

// ------------------------------------------------- transitive chain & cycles
check('chain A → B → C resolves transitively, entry key excluded', async () => {
  const out = await resolve([ITEMS[0]]); // DepFixService
  assert.deepStrictEqual(out, { keys: ['ApexClass:DepFixHelper', 'ApexClass:DepFixQueue'], truncated: false });
});

check('cycle A ⇄ B terminates without repeating either side', async () => {
  const out = await resolve([ITEMS.find(i => i.name === 'AcmeLoopA')]);
  assert.deepStrictEqual(out, { keys: ['ApexClass:AcmeLoopB'], truncated: false });
});

check('multi-entry: entry keys are excluded even when they reference each other', async () => {
  const out = await resolve([ITEMS[0], ITEMS[1]]); // Service + Helper
  assert.deepStrictEqual(out.keys, ['ApexClass:DepFixQueue']);
});

// ------------------------------------------- sObject / field token matching
check('trigger source: __c and __mdt identifiers match CustomObject, Obj.Field matches CustomField', async () => {
  const out = await resolve([ITEMS.find(i => i.name === 'WidgetTrigger')]);
  // Identifiers land before dotted pairs — that per-file order is the contract.
  assert.deepStrictEqual(out.keys, [
    'CustomObject:Widget__c',
    'CustomObject:DepFixRule__mdt',
    'CustomField:Widget__c.Size__c'
  ]);
  assert.strictEqual(out.truncated, false);
});

check('an sObject-suffixed token with no scanned object matches nothing', async () => {
  const entry = item('ApexClass', 'AcmeGhostRef', 'classes/AcmeGhostRef.cls');
  SOURCES.set(entry.filePath, 'public class AcmeGhostRef { Ghost__c g; Phantom__mdt m; }\n');
  const out = await resolve([entry]);
  assert.deepStrictEqual(out.keys, []);
});

// ---------------------------------------------------- platform-name exclusion
check('platform names never match, even against colliding scanned items', async () => {
  // Decoys make the check meaningful: without them, [] would also mean "absent".
  const decoys = [
    item('ApexClass', 'String', 'classes/String.cls'),
    item('ApexClass', 'Account', 'classes/Account.cls'),
    item('CustomField', 'System.debug', 'objects/System/fields/debug.field-meta.xml'),
    item('ApexClass', 'Ab', 'classes/Ab.cls'),
    item('ApexClass', 'DepFixReal', 'classes/DepFixReal.cls')
  ];
  const entry = item('ApexClass', 'AcmePlat', 'classes/AcmePlat.cls');
  SOURCES.set(entry.filePath,
    'public class AcmePlat {\n'
    + '  void go() { String s; System.debug(s); Account a; Ab b; DepFixReal r; }\n'
    + '}\n');
  SOURCES.set(decoys[4].filePath, 'public class DepFixReal {}\n');
  const out = await resolve([entry], undefined, [...ITEMS, ...decoys]);
  // String → APEX_BUILTIN_TYPES, Account → STANDARD_NAMES, System.debug →
  // PLATFORM_NAMESPACES, Ab → under the 3-char floor. Only the real class joins.
  assert.deepStrictEqual(out.keys, ['ApexClass:DepFixReal']);
});

// --------------------------------------------------------------- string blind
check('an identifier inside a string literal is NOT matched', async () => {
  const entry = item('ApexClass', 'AcmeStr', 'classes/AcmeStr.cls');
  SOURCES.set(entry.filePath, "public class AcmeStr { public String label = 'DepFixQueue is fine'; }\n");
  const out = await resolve([entry]);
  assert.deepStrictEqual(out.keys, []);
});

// ------------------------------------------------------------------ depth cap
check('depth cap stops expansion and reports truncation when it cut something', async () => {
  const out = await resolve([ITEMS[0]], { maxDepth: 1 }); // Service → Helper (→ Queue cut)
  assert.deepStrictEqual(out, { keys: ['ApexClass:DepFixHelper'], truncated: true });
});

check('depth cap that cuts nothing reports truncated false (boundary is probed, not guessed)', async () => {
  const out = await resolve([ITEMS[0]], { maxDepth: 2 }); // Queue at depth 2 references nothing
  assert.deepStrictEqual(out, { keys: ['ApexClass:DepFixHelper', 'ApexClass:DepFixQueue'], truncated: false });
});

// ----------------------------------------------------------------- deps cap
check('maxDeps cap trims in discovery order and flags truncated', async () => {
  const entry = item('ApexClass', 'AcmeGenRoot', 'classes/AcmeGenRoot.cls');
  SOURCES.set(entry.filePath, 'public class AcmeGenRoot { AcmeGen0 a; AcmeGen1 b; AcmeGen2 c; }\n');
  const out = await resolve([entry], { maxDeps: 2 });
  assert.deepStrictEqual(out, { keys: ['ApexClass:AcmeGen0', 'ApexClass:AcmeGen1'], truncated: true });
});

check('a set landing exactly on maxDeps is NOT truncated', async () => {
  const entry = item('ApexClass', 'AcmeGenRoot', 'classes/AcmeGenRoot.cls');
  const out = await resolve([entry], { maxDeps: 3 });
  assert.deepStrictEqual(out, { keys: ['ApexClass:AcmeGen0', 'ApexClass:AcmeGen1', 'ApexClass:AcmeGen2'], truncated: false });
});

// ---------------------------------------------------------- non-Apex entries
check('a non-Apex entry is never read, even when its file content would match', async () => {
  const out = await resolve([ITEMS.find(i => i.type === 'Layout')]);
  assert.deepStrictEqual(out, { keys: [], truncated: false });
});

check('a CustomObject entry is a leaf too', async () => {
  const out = await resolve([ITEMS.find(i => i.name === 'Widget__c')]);
  assert.deepStrictEqual(out, { keys: [], truncated: false });
});

// --------------------------------------------------------- casing & resilience
check('case-insensitive matches return the ITEM canonical casing, never the token', async () => {
  const entry = item('ApexClass', 'AcmeCase', 'classes/AcmeCase.cls');
  SOURCES.set(entry.filePath, 'public class AcmeCase { depfixqueue q; Object o = WIDGET__C.SIZE__C; }\n');
  const out = await resolve([entry]);
  assert.deepStrictEqual(out.keys, ['ApexClass:DepFixQueue', 'CustomObject:Widget__c', 'CustomField:Widget__c.Size__c']);
});

check('an unreadable entry file degrades to no deps, never a throw', async () => {
  const entry = item('ApexClass', 'AcmeMissing', 'classes/AcmeMissing.cls'); // no SOURCES entry
  const out = await resolve([entry]);
  assert.deepStrictEqual(out, { keys: [], truncated: false });
});

(async () => {
  for (const { name, fn } of checks) {
    ran++;
    try { await fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
  }
  if (failed) { console.error(`\n${failed} of ${ran} check(s) failed`); process.exit(1); }
  console.log(`depGraph: all ${ran} checks passed`);
})();
