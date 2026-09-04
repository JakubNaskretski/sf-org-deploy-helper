// Runnable contract test for the Fetch Org result card (panelProvider.ts
// loadOrgMetadata) and the pieces it leans on. No framework.
//   1) npm run compile   2) node scripts/check-fetch-org.cjs
//
// Two user reports read as "the plugin does not see all my FlexCards", and both
// came down to REPORTING, not listing:
//   * on an org that cannot list OmniUiCard at all (managed-package runtime, or
//     the standard runtime with "Use OmniStudio Metadata API" off) the CLI fails
//     the TYPE with sf:INVALID_TYPE — and that landed as one anonymous ✗ line
//     among up to eight, in a warn card, with no hint;
//   * FlexCards delivered by a managed package are hidden by default, and the one
//     line that explained it rendered ONLY when some other type had also failed.
//
// Driven through the REAL loadOrgMetadata with `sf.listMetadata` scripted per
// type, so what is pinned is the card a user sees, not a helper in isolation:
//   1. unsupported types (sf:INVALID_TYPE / "Cannot use: X in this organization")
//      are ONE grouped line — never ✗ lines, never a 'warn' card, never the
//      zero-result wipe-out card — and an Omni* type adds the OmniStudio hint;
//   2. the hidden-managed line renders whenever anything was hidden, failures or
//      not, and names the counts PER TYPE;
//   3. a real per-type failure and a fatal (auth/network) interruption still
//      report exactly as before;
//   4. learnedRules(includeExpired): the silent/fast scans keep expired rules
//      (source-pinned at both call sites), the explicit scan drops them;
//   5. the SfCliService.listMetadata envelope contract the classifier depends on
//      (empty, one member, INVALID_TYPE error envelope, benign no-result).
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const Module = require('module');

// ---------------------------------------------------------------- vscode stub
// `cfg` holds per-check overrides for sfOrgDeployWrapper.* settings.
const cfg = {};
const vscodeStub = {
  window: {
    setStatusBarMessage: () => ({ dispose: () => {} }),
    showInformationMessage: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
    withProgress: (_o, body) => body({ report: () => {} }, { onCancellationRequested: () => ({ dispose: () => {} }) })
  },
  workspace: { getConfiguration: () => ({ get: (k, fallback) => (k in cfg ? cfg[k] : fallback) }) },
  Uri: { file: fsPath => ({ fsPath, scheme: 'file' }) },
  ViewColumn: { Active: -1 },
  ProgressLocation: { Notification: 15 }
};
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? vscodeStub : origLoad(req, ...rest));

const { DeployPanelProvider, isUnsupportedTypeError, managedHiddenLine, OMNI_UNSUPPORTED_HINT } =
  require(path.join(__dirname, '..', 'out', 'panelProvider.js'));
const { SfCliService, SfCliError } = require(path.join(__dirname, '..', 'out', 'sfCliService.js'));
const proto = DeployPanelProvider.prototype;
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'panelProvider.ts'), 'utf8');

let failed = 0;
const queue = [];
const check = (name, fn) => queue.push([name, fn]);

// ------------------------------------------------------------- fetch driver
// A scripted org: `script[type]` is what listMetadata yields for that type — an
// array of members, or an Error to reject with. Every unscripted type lists
// empty, so the whole curated list runs without noise.
function fetchStub(script) {
  const posted = [];
  const toasts = [];
  const log = [];
  const calls = [];
  const stub = Object.create(proto);
  stub.view = { visible: true };
  stub.items = [];
  stub.orgs = [{ username: 'acme-dev-user', alias: 'acme-dev' }];
  stub.orgStore = { get: () => 'acme-dev-user' };
  stub.post = m => posted.push(m);
  stub.reserveBusy = () => true;
  stub.requireRoot = () => '/ws';
  stub.requireOrg = () => 'acme-dev-user';
  stub.timeoutMs = () => 1000;
  stub.setBusy = () => {};
  stub.postProgress = () => {};
  stub.failureToast = (msg, lines) => toasts.push({ msg, lines });
  stub.output = { appendLine: l => log.push(l) };
  stub.withWindowProgress = (_t, body) => body(() => {});
  stub.sf = {
    listMetadata: type => {
      calls.push(type);
      const r = script[type];
      return {
        cancel: () => {},
        promise: r instanceof Error
          ? Promise.reject(r)
          : Promise.resolve({ members: r ?? [], cmd: `sf org list metadata --metadata-type ${type}` })
      };
    }
  };
  return { stub, posted, toasts, log, calls };
}
const card = posted => posted.filter(m => m.type === 'status').map(m => m.card).pop();
const orgItems = posted => posted.find(m => m.type === 'orgMetadata');
const run = stub => proto.loadOrgMetadata.call(stub);
// The envelope the CLI returns on InzOrg for every OmniStudio type (org-verified).
const invalidType = type => {
  const e = new SfCliError(`sf:INVALID_TYPE: Cannot use: ${type} in this organization`);
  e.errorName = 'sf:INVALID_TYPE';
  return e;
};
const OMNI = ['OmniScript', 'OmniIntegrationProcedure', 'OmniDataTransform', 'OmniUiCard'];
const omniUnsupported = () => Object.fromEntries(OMNI.map(t => [t, invalidType(t)]));
const MANAGED_LINE = types => `— Hidden managed-package components: ${types} (enable sfOrgDeployWrapper.fetchIncludeManaged to show)`;

// ------------------------------------------------------------ the result card
check('clean fetch: ok card, no lines, members reach the webview', async () => {
  const { stub, posted } = fetchStub({ ApexClass: [{ fullName: 'OrderService' }] });
  await run(stub);
  const c = card(posted);
  assert.strictEqual(c.kind, 'ok');
  assert.strictEqual(c.title, 'Org metadata loaded from acme-dev');
  assert.strictEqual(c.meta, '1 components');
  assert.strictEqual(c.lines, undefined);
  assert.deepStrictEqual(orgItems(posted).orgItems, [{ type: 'ApexClass', name: 'OrderService' }]);
});

check('the curated list still asks the org for the four OmniStudio types', async () => {
  const { stub, calls } = fetchStub({});
  await run(stub);
  for (const t of OMNI) assert.ok(calls.includes(t), `${t} was not listed`);
});

check('managed-package members: hidden by default and named PER TYPE with nothing else failing', async () => {
  const { stub, posted } = fetchStub({
    OmniUiCard: [
      { fullName: 'WidgetCard_1', manageableState: 'installed' },
      { fullName: 'WidgetCard_2', manageableState: 'installed' },
      { fullName: 'LocalCard_1', manageableState: 'unmanaged' }
    ],
    ApexClass: [{ fullName: 'PkgService', manageableState: 'installed' }, { fullName: 'OrderService' }]
  });
  await run(stub);
  const c = card(posted);
  assert.strictEqual(c.kind, 'ok');
  assert.strictEqual(c.meta, '2 components · 3 managed skipped');
  assert.deepStrictEqual(c.lines, [MANAGED_LINE('OmniUiCard 2, ApexClass 1')]);
  const names = orgItems(posted).orgItems.map(i => `${i.type}:${i.name}`).sort();
  assert.deepStrictEqual(names, ['ApexClass:OrderService', 'OmniUiCard:LocalCard_1']);
});

check('fetchIncludeManaged on: nothing hidden, no managed line', async () => {
  cfg.fetchIncludeManaged = true;
  try {
    const { stub, posted } = fetchStub({ OmniUiCard: [{ fullName: 'WidgetCard_1', manageableState: 'installed' }] });
    await run(stub);
    const c = card(posted);
    assert.strictEqual(c.meta, '1 components');
    assert.strictEqual(c.lines, undefined);
    assert.deepStrictEqual(orgItems(posted).orgItems, [{ type: 'OmniUiCard', name: 'WidgetCard_1' }]);
  } finally { delete cfg.fetchIncludeManaged; }
});

check('only "installed" is the managed filter — other manageableState values are kept', async () => {
  const { stub, posted } = fetchStub({
    OmniUiCard: [{ fullName: 'A', manageableState: 'released' }, { fullName: 'B', manageableState: 'unmanaged' }, { fullName: 'C' }]
  });
  await run(stub);
  const c = card(posted);
  assert.strictEqual(c.meta, '3 components');
  assert.strictEqual(c.lines, undefined);
});

check('INVALID_TYPE on the OmniStudio types: one grouped line, ok card, OmniStudio hint — never ✗ lines', async () => {
  const { stub, posted, toasts } = fetchStub({ ...omniUnsupported(), ApexClass: [{ fullName: 'OrderService' }] });
  await run(stub);
  const c = card(posted);
  assert.strictEqual(c.kind, 'ok');
  assert.strictEqual(c.title, 'Org metadata loaded from acme-dev');
  assert.strictEqual(c.meta, '1 components · 4 types not available');
  assert.deepStrictEqual(c.lines, [
    '— Not available on this org: OmniDataTransform, OmniIntegrationProcedure, OmniScript, OmniUiCard',
    OMNI_UNSUPPORTED_HINT
  ]);
  assert.match(OMNI_UNSUPPORTED_HINT, /Setup → OmniStudio Settings → "Use OmniStudio Metadata API"/);
  assert.match(OMNI_UNSUPPORTED_HINT, /managed-package runtime .* data records/);
  assert.deepStrictEqual(toasts, []);
  assert.ok(orgItems(posted), 'membership is still published');
});

check('a message-only INVALID_TYPE (no errorName) is grouped too; a non-Omni type gets no OmniStudio hint', async () => {
  const { stub, posted } = fetchStub({ Bot: new Error('Cannot use: Bot in this organization'), ApexClass: [{ fullName: 'A' }] });
  await run(stub);
  const c = card(posted);
  assert.strictEqual(c.kind, 'ok');
  assert.strictEqual(c.meta, '1 components · 1 type not available');
  assert.deepStrictEqual(c.lines, ['— Not available on this org: Bot']);
});

check('a genuine per-type failure still renders as ✗ and flips the card to warn, beside the grouped line', async () => {
  const { stub, posted, log } = fetchStub({ Bot: new Error('boom'), OmniUiCard: invalidType('OmniUiCard'), ApexClass: [{ fullName: 'A' }] });
  await run(stub);
  const c = card(posted);
  assert.strictEqual(c.kind, 'warn');
  assert.strictEqual(c.meta, '1 components · 1 type not available · 1 type failed');
  assert.deepStrictEqual(c.lines, ['— Not available on this org: OmniUiCard', OMNI_UNSUPPORTED_HINT, '✗ Bot — boom']);
  // Both still reach the output channel — the grouping is a card concern only.
  assert.ok(log.some(l => l.startsWith('[Fetch Org] OmniUiCard: sf:INVALID_TYPE')));
  assert.ok(log.some(l => l === '[Fetch Org] Bot: boom'));
});

check('unsupported types alone never trigger the zero-result wipe-out card; a real failure alone still does', async () => {
  const a = fetchStub(omniUnsupported());
  await run(a.stub);
  const ca = card(a.posted);
  assert.strictEqual(ca.kind, 'ok');
  assert.strictEqual(ca.title, 'Org metadata loaded from acme-dev');
  assert.strictEqual(ca.meta, '0 components · 4 types not available');
  assert.deepStrictEqual(a.toasts, []);
  assert.ok(orgItems(a.posted), 'an empty org is still a listed org');

  const b = fetchStub({ ApexClass: new Error('boom') });
  await run(b.stub);
  const cb = card(b.posted);
  assert.strictEqual(cb.kind, 'err');
  assert.strictEqual(cb.title, 'Fetch Org failed against acme-dev');
  assert.strictEqual(b.toasts.length, 1);
  assert.ok(!orgItems(b.posted), 'nothing is published on a wipe-out');
});

check('a fatal (auth/network) interruption still reports incomplete — managed line first, ⚠ second', async () => {
  const fatal = new SfCliError('NamedOrgNotFound: No authorization information found');
  fatal.errorName = 'NamedOrgNotFound';
  const { stub, posted, toasts } = fetchStub({
    ApexClass: fatal,
    ApexTrigger: [{ fullName: 'T' }, { fullName: 'PkgT', manageableState: 'installed' }]
  });
  await run(stub);
  const c = card(posted);
  assert.strictEqual(c.kind, 'err');
  assert.strictEqual(c.title, 'Org metadata incomplete for acme-dev');
  assert.strictEqual(c.meta, '1 components · 1 managed skipped · 1 type failed');
  assert.deepStrictEqual(c.lines, [
    MANAGED_LINE('ApexTrigger 1'),
    '⚠ A connection/auth error interrupted the listing — some "local only" badges may be incomplete. Re-run Fetch Org.',
    '✗ ApexClass — NamedOrgNotFound: No authorization information found'
  ]);
  assert.strictEqual(toasts.length, 1);
});

check('more than eight real failures are still capped with the overflow line', async () => {
  const failing = ['ApexClass', 'ApexTrigger', 'ApexPage', 'ApexComponent', 'ApexTestSuite', 'Flow', 'Workflow', 'Layout', 'CustomTab'];
  const script = Object.fromEntries(failing.map(t => [t, new Error(`${t} broke`)]));
  script.PermissionSet = [{ fullName: 'Admin' }];
  const { stub, posted } = fetchStub(script);
  await run(stub);
  const c = card(posted);
  assert.strictEqual(c.kind, 'warn');
  assert.strictEqual(c.meta, '1 components · 9 types failed');
  assert.strictEqual(c.lines.length, 9);
  assert.strictEqual(c.lines.filter(l => l.startsWith('✗ ')).length, 8);
  assert.strictEqual(c.lines[8], '…and 1 more (see output channel)');
});

// ------------------------------------------------------------------- helpers
check('isUnsupportedTypeError: errorName or message, anchored and bounded', () => {
  assert.ok(isUnsupportedTypeError(invalidType('OmniUiCard')));
  const bare = new SfCliError('x'); bare.errorName = 'INVALID_TYPE';
  assert.ok(isUnsupportedTypeError(bare), 'the un-prefixed name');
  assert.ok(isUnsupportedTypeError(new Error('Cannot use: Bot in this organization')), 'message only');
  assert.ok(!isUnsupportedTypeError(new Error('boom')));
  assert.ok(!isUnsupportedTypeError(new Error('Cannot use: Bot')), 'half a message is not the message');
  const near = new SfCliError('x'); near.errorName = 'sf:INVALID_TYPE_ARGUMENT';
  assert.ok(!isUnsupportedTypeError(near), 'the name match is anchored');
  const fatal = new SfCliError('NamedOrgNotFound: expired'); fatal.errorName = 'NamedOrgNotFound';
  assert.ok(!isUnsupportedTypeError(fatal), 'a fatal error is never "unsupported"');
  // Org-controlled text: the type slot is bounded so a pathological message
  // cannot turn the match into a long backtrack.
  assert.ok(!isUnsupportedTypeError(new Error(`Cannot use: ${'a'.repeat(300)} in this organization`)));
});

check('managedHiddenLine: biggest counts first, ties by name, capped at 12 with the rest counted', () => {
  const m = new Map([['OmniUiCard', 30], ['ApexClass', 210], ['Flow', 30], ['Zero', 0]]);
  assert.strictEqual(managedHiddenLine(m), MANAGED_LINE('ApexClass 210, Flow 30, OmniUiCard 30'));
  const many = new Map(Array.from({ length: 14 }, (_, i) => [`T${String(i).padStart(2, '0')}`, 14 - i]));
  const line = managedHiddenLine(many);
  assert.ok(line.includes('T11 3 and 2 more types (enable'), line);
  assert.ok(!line.includes('T12'), line);
  const thirteen = new Map(Array.from({ length: 13 }, (_, i) => [`T${String(i).padStart(2, '0')}`, 13 - i]));
  assert.ok(managedHiddenLine(thirteen).includes(' and 1 more type (enable'));
});

// ------------------------------------------------------- learned-rule expiry
// The watcher's silent rescan and the context-menu fast scan never re-resolve a
// folder's type, so for them an EXPIRED learned rule must stay in force — or every
// row of that type vanished from the tree on the first file event after the TTL.
const DAY = 86_400_000;
const rulesProvider = (stored, days) => {
  cfg.typeCacheDays = days;
  return {
    context: { globalState: { get: (_k, fallback) => stored ?? fallback } },
    typeCacheDays: proto.typeCacheDays,
    learnedRules: proto.learnedRules
  };
};
const FRESH = { folder: 'freshThings', type: 'FreshThing', primaryExt: ['.fresh-meta.xml'], learnedAt: Date.now() };
const EXPIRED = { folder: 'oldThings', type: 'OldThing', primaryExt: ['.old-meta.xml'], learnedAt: Date.now() - 8 * DAY };

check('learnedRules(): an expired rule is dropped — the explicit scan re-verifies it', () => {
  try {
    const prov = rulesProvider([FRESH, EXPIRED], 7);
    assert.deepStrictEqual(prov.learnedRules().map(r => r.type), ['FreshThing']);
    assert.deepStrictEqual(prov.learnedRules(false).map(r => r.type), ['FreshThing']);
  } finally { delete cfg.typeCacheDays; }
});

check('learnedRules(true): expired rules stay in force for the scans that never re-resolve', () => {
  try {
    const prov = rulesProvider([FRESH, EXPIRED], 7);
    assert.deepStrictEqual(prov.learnedRules(true).map(r => r.type), ['FreshThing', 'OldThing']);
  } finally { delete cfg.typeCacheDays; }
});

check('learnedRules(true) keeps the shape/charset guard — junk never flows toward argv', () => {
  try {
    const junk = [
      null,
      { folder: 'x', type: '--target-org', learnedAt: Date.now() },
      { folder: 'y', type: 'NoStamp' },
      { folder: 7, type: 'T', learnedAt: Date.now() },
      EXPIRED
    ];
    const prov = rulesProvider(junk, 7);
    assert.deepStrictEqual(prov.learnedRules(true).map(r => r.type), ['OldThing']);
    assert.deepStrictEqual(prov.learnedRules(), []);
  } finally { delete cfg.typeCacheDays; }
});

check('cache off (typeCacheDays 0): no learned rules either way', () => {
  try {
    const prov = rulesProvider([FRESH, EXPIRED], 0);
    assert.deepStrictEqual(prov.learnedRules(true), []);
    assert.deepStrictEqual(prov.learnedRules(), []);
  } finally { delete cfg.typeCacheDays; }
});

// ------------------------------------------------------------------ source pins
// 0.21.1: call sites go through ruleSet() (registry → learned); the silent flag
// still reaches learnedRules through it — check-registry-rules.cjs pins ruleSet's body.
check('source: the silent scan keeps expired learned rules; the post-resolution rescan stays on fresh ones', () => {
  assert.ok(src.includes('let scan = await scanWorkspace(this.ruleSet(!!opts.silent));'),
    'doLoadFiles must pass the silent flag through to the rule set');
  assert.ok(src.includes('scan = await scanWorkspace([...this.ruleSet(), ...fresh]);'));
});

check('source: the context-menu fast scan keeps expired rules too', () => {
  assert.ok(src.includes('const scan = await scanWorkspace(this.ruleSet(true));'));
});

check('source: learnRulesForFolders derives from recursive -meta.xml basenames, not a flat readdir', () => {
  assert.ok(src.includes('const fileNames = await listMetaFileNames(folder);'));
  assert.ok(!src.includes('fs.readdir(folder)'));
});

check('source: every per-type listing failure goes through the unsupported classifier', () => {
  assert.ok(src.includes('const recordFailure = (label: string, err: unknown): void => {'));
  assert.strictEqual((src.match(/recordFailure\(/g) || []).length, 2, 'runOne + folder listing');
  // The only push into `failures` is the classifier's else-branch — no call site
  // bypasses it (the folder-listing catch used to push `{ label: folderType, err }`).
  assert.strictEqual((src.match(/failures\.push\(/g) || []).length, 1, 'only recordFailure pushes a failure');
  assert.ok(!src.includes('failures.push({ label: folderType'));
  assert.ok(src.includes('if (isUnsupportedTypeError(err)) unsupported.push(label);'));
});

check('source: hintForError explains INVALID_TYPE', () => {
  assert.ok(src.includes('if (/invalid_type|cannot use: /.test(txt))'));
  assert.ok(src.includes('This metadata type is not available on this org (feature not enabled or wrong runtime).'));
});

check('source: FETCH_ORG_TYPES keeps the four OmniStudio types', () => {
  assert.ok(/const FETCH_ORG_TYPES[\s\S]*?'OmniScript', 'OmniIntegrationProcedure', 'OmniDataTransform', 'OmniUiCard',[\s\S]*?\];/.test(src));
});

// ------------------------------------------------- listMetadata envelopes
// The classifier keys on what SfCliService hands it; pin the envelope contract
// so a kit change cannot silently turn INVALID_TYPE into "0 FlexCards".
const svc = envelope => {
  const sf = new SfCliService();
  sf.runJsonCancellable = () => ({ promise: Promise.resolve(envelope), cancel: () => {} });
  return sf;
};
const list = envelope => svc(envelope).listMetadata('OmniUiCard', 'acme-dev-user', '/ws').promise;

check('listMetadata: {result: []} is an empty listing', async () => {
  const { members } = await list({ status: 0, result: [] });
  assert.deepStrictEqual(members, []);
});

check('listMetadata: one member comes back as-is', async () => {
  const one = { fullName: 'WidgetCard_1', type: 'OmniUiCard', manageableState: 'unmanaged' };
  const { members } = await list({ status: 0, result: [one] });
  assert.deepStrictEqual(members, [one]);
});

check('listMetadata: the INVALID_TYPE envelope rejects with the name the classifier keys on', async () => {
  await assert.rejects(
    list({ name: 'sf:INVALID_TYPE', status: 1, message: 'Cannot use: OmniUiCard in this organization' }),
    err => {
      assert.ok(err instanceof SfCliError);
      assert.strictEqual(err.errorName, 'sf:INVALID_TYPE');
      assert.strictEqual(err.message, 'sf:INVALID_TYPE: Cannot use: OmniUiCard in this organization');
      assert.ok(isUnsupportedTypeError(err), 'the envelope must classify as unsupported end to end');
      return true;
    });
});

check('listMetadata: a status-0 envelope with no result is an empty listing, not an error', async () => {
  const { members } = await list({ status: 0 });
  assert.deepStrictEqual(members, []);
});

check('listMetadata: a non-zero status with no result is an error even without a name', async () => {
  await assert.rejects(list({ status: 1, message: 'boom' }), err => {
    assert.ok(err instanceof SfCliError);
    assert.ok(!isUnsupportedTypeError(err), 'a nameless failure is a failure');
    return /boom/.test(err.message);
  });
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
  if (failed) { console.error(`fetch-org: ${failed} of ${queue.length} checks failed`); process.exit(1); }
  console.log(`fetch-org: all ${queue.length} checks passed`);
})();
