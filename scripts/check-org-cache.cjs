// Runnable contract test for the cross-session org-membership cache
// (panelProvider.ts: hydrateOrgSnapshot / readOrgCache / persistOrgSnapshot /
// vetOrgSnapshot, wired through maybeAutoFetchOrg and the org-switch resync).
// No framework.   1) npm run compile   2) node scripts/check-org-cache.cjs
//
// Fetch Org on panel open used to spawn one `sf org list metadata` per type —
// ~90 processes — every session, and the tree had no badges until they all
// returned. Membership is now persisted per org in workspaceState, so the panel
// opens on the last listing (stamped `asOf`) and only re-lists when there is no
// snapshot or it is older than `orgCacheMaxAgeHours`.
//
// Driven through a REAL DeployPanelProvider (the constructor wires the orgStore
// resync) with `sf.listMetadata` scripted, the panel's `ready` and Fetch Org
// messages delivered the way the webview delivers them, and workspaceState an
// in-memory map — so what is pinned is the session a user gets:
//   1. a complete listing persists vetted keys, its stamp and the managed counts;
//   2. ready on a fresh snapshot posts it (with asOf) and spawns NOTHING;
//   3. a stale one posts first, then the auto-fetch replaces it;
//   4. the setting's clamp (0 = always re-list, 720 = a month);
//   5. fetchOrgOnOpen off: cached shown, no fetch; no snapshot: today's behaviour;
//   6. an org switch shows that org's snapshot (stale → fetch) or nothing;
//   7. hostile state is dropped key by key or whole, and never reaches argv;
//   8. an over-cap listing is not persisted (and evicts the org's older one);
//   9. confirm/delete mutations update the snapshot but keep its stamp;
//  10. a manual Fetch Org re-lists a fresh snapshot and overwrites it;
//  11. at most five orgs are kept; an interrupted listing is never persisted;
//  12. a webview rebuild re-posts without re-fetching; source/manifest pins.
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
  workspace: {
    getConfiguration: () => ({ get: (k, fallback) => (k in cfg ? cfg[k] : fallback) }),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    onDidChangeWorkspaceFolders: () => ({ dispose: () => {} })
  },
  Uri: { file: fsPath => ({ fsPath, scheme: 'file' }) },
  ViewColumn: { Active: -1 },
  ProgressLocation: { Notification: 15 }
};
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? vscodeStub : origLoad(req, ...rest));

const { DeployPanelProvider, vetOrgSnapshot } = require(path.join(__dirname, '..', 'out', 'panelProvider.js'));
// This harness's stub finds no project; the startup "no project" retry (0.22.1)
// would otherwise wait 15s inside every ready.
DeployPanelProvider.discoveryRetryDelays = [];
const { SfCliError } = require(path.join(__dirname, '..', 'out', 'sfCliService.js'));
const proto = DeployPanelProvider.prototype;
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'panelProvider.ts'), 'utf8');

let failed = 0;
const queue = [];
const check = (name, fn) => queue.push([name, fn]);

// ------------------------------------------------------------------ driver
const KEY = 'orgMembershipCache';
const DEV = 'acme-dev-user';
const UAT = 'acme-uat-user';
const HOUR = 3_600_000;
const snap = (org, keys, ageMs, extra = {}) => ({ org, keys, at: Date.now() - ageMs, ...extra });
const cacheOf = orgs => ({ [KEY]: Object.fromEntries(orgs.map(s => [s.org, s])) });

/** A real provider over an in-memory workspaceState, a fake org store whose
 *  set() fires the resync the way OrgStore does, and a scripted `sf`:
 *  `script[type]` is the member list (or Error) for that type; unscripted
 *  types list empty. Everything the cache never touches is stubbed. */
function boot({ state = {}, org = DEV, script = {} } = {}) {
  const store = new Map(Object.entries(state));
  const posted = [];
  const log = [];
  const calls = [];
  const fetches = [];
  const errors = [];
  let writes = 0;
  let listener;
  let current = org;
  const setOrg = async v => { if (v === current) return; current = v; if (listener) listener(v); };
  const orgStore = { get: () => current, set: setOrg, setFromUserPick: setOrg, onDidChange: fn => { listener = fn; return { dispose: () => {} }; } };
  const context = {
    subscriptions: [],
    extensionUri: {},
    workspaceState: { get: (k, d) => (store.has(k) ? store.get(k) : d), update: (k, v) => { writes++; store.set(k, v); return Promise.resolve(); } },
    globalState: { get: (_k, d) => d, update: () => Promise.resolve() }
  };
  const sf = {
    listMetadata: type => {
      calls.push(type);
      const r = script[type];
      return { cancel: () => {}, promise: r instanceof Error ? Promise.reject(r) : Promise.resolve({ members: r ?? [], cmd: `sf org list metadata --metadata-type ${type}` }) };
    }
  };
  const inst = new DeployPanelProvider(context, orgStore, sf, { appendLine: l => log.push(l) });
  Object.assign(inst, {
    workspaceRoot: '/ws',
    orgs: [{ username: DEV, alias: 'acme-dev' }, { username: UAT, alias: 'acme-uat' }],
    post: m => posted.push(m),
    loadFiles: async () => {},
    loadOrgs: async () => {},
    postChangedComponents: async () => {},
    sendActiveFile: () => {},
    postBusy: () => {},
    postIgnoreDeployConflicts: () => {},
    postQueue: () => {},
    maybeReattachDeploy: () => {},
    cardHistory: () => [],
    reserveBusy: () => { if (inst.busy) return false; inst.busy = true; return true; },
    setBusy: b => { inst.busy = b; },
    postProgress: () => {},
    failureToast: () => {},
    withWindowProgress: (_t, body) => body(() => {}),
    reportError: (action, err) => errors.push(`${action}: ${err && err.message}`),
    // The auto-fetch is fire-and-forget; keep every listing awaitable.
    loadOrgMetadata: () => { const p = proto.loadOrgMetadata.call(inst); fetches.push(p); return p; }
  });
  const settle = () => Promise.all(fetches);
  return {
    inst, posted, log, calls, errors, store, settle,
    writes: () => writes,
    cache: () => store.get(KEY),
    memberships: () => posted.filter(m => m.type === 'orgMetadata'),
    ready: async () => { await proto.handleMessage.call(inst, { type: 'ready' }); await settle(); },
    fetchOrg: async () => { await proto.handleMessage.call(inst, { type: 'fetchOrgMetadata', username: current }); await settle(); },
    switchOrg: async v => { await setOrg(v); await settle(); }
  };
}
const keysOf = m => m.orgItems.map(i => `${i.type}:${i.name}`).sort();
const ORDER = [{ fullName: 'OrderService' }];

// ------------------------------------------------- 1) a listing persists
check('a complete listing persists vetted keys, its stamp and the per-type managed counts', async () => {
  const t0 = Date.now();
  const p = boot({ script: { ApexClass: [...ORDER, { fullName: 'PkgService', manageableState: 'installed' }], OmniUiCard: [{ fullName: 'Card', manageableState: 'installed' }] } });
  await p.ready();
  assert.ok(p.calls.length > 0, 'no snapshot → the org is listed');
  assert.deepStrictEqual(p.errors, []);
  const s = p.cache()[DEV];
  assert.deepStrictEqual(s.keys, ['ApexClass:OrderService']);
  assert.strictEqual(s.org, DEV);
  assert.ok(s.at >= t0 && s.at <= Date.now(), 'stamped at listing time');
  assert.deepStrictEqual(s.managedHidden, { ApexClass: 1, OmniUiCard: 1 });
  // The fetch's own post carries no asOf — the webview reads it as "now".
  assert.strictEqual(p.memberships().length, 1);
  assert.ok(!('asOf' in p.memberships()[0]) || p.memberships()[0].asOf === undefined);
});

// ------------------------------------------- 2) fresh snapshot: no spawn
check('ready on a fresh snapshot: badges posted with asOf, NO listMetadata spawned', async () => {
  const s = snap(DEV, ['ApexClass:OrderService', 'CustomField:Widget__c.Size__c'], HOUR, { managedHidden: { ApexClass: 3 } });
  const p = boot({ state: cacheOf([s]) });
  await p.ready();
  assert.strictEqual(p.calls.length, 0, `spawned ${p.calls.length} listings`);
  const m = p.memberships();
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].asOf, s.at);
  assert.strictEqual(m[0].orgLabel, 'acme-dev');
  assert.deepStrictEqual(keysOf(m[0]), ['ApexClass:OrderService', 'CustomField:Widget__c.Size__c']);
  assert.strictEqual(p.inst.orgMembersOrg, DEV);
  assert.ok(p.log.some(l => l.startsWith(`[org cache] ${DEV}: 2 components as of `) && l.endsWith('(3 managed hidden)')), p.log.join('\n'));
  assert.strictEqual(p.writes(), 0, 'showing a snapshot writes nothing');
});

// --------------------------------------------- 3) stale snapshot: refresh
check('a stale snapshot shows first, then the auto-fetch replaces it and the snapshot', async () => {
  const s = snap(DEV, ['ApexClass:Old'], 25 * HOUR);
  const p = boot({ state: cacheOf([s]), script: { ApexClass: [{ fullName: 'New' }] } });
  await p.ready();
  assert.ok(p.calls.length > 0, 'stale → re-listed');
  const m = p.memberships();
  assert.strictEqual(m.length, 2);
  assert.strictEqual(m[0].asOf, s.at);
  assert.deepStrictEqual(keysOf(m[0]), ['ApexClass:Old']);
  assert.strictEqual(m[1].asOf, undefined);
  assert.deepStrictEqual(keysOf(m[1]), ['ApexClass:New']);
  assert.deepStrictEqual(p.cache()[DEV].keys, ['ApexClass:New']);
  assert.ok(p.cache()[DEV].at > s.at);
});

// ------------------------------------------------- 4) the setting's clamp
check('orgCacheMaxAgeHours: 0 always re-lists, 720 keeps a month, out-of-range values clamp', async () => {
  const run = async (hours, ageMs) => {
    cfg.orgCacheMaxAgeHours = hours;
    try {
      const p = boot({ state: cacheOf([snap(DEV, ['ApexClass:A'], ageMs)]), script: { ApexClass: ORDER } });
      await p.ready();
      return p.calls.length > 0;
    } finally { delete cfg.orgCacheMaxAgeHours; }
  };
  assert.strictEqual(await run(0, 1000), true, '0 → always');
  assert.strictEqual(await run(-5, 1000), true, 'below 0 clamps to 0');
  assert.strictEqual(await run(720, 29 * 24 * HOUR), false, '720 keeps 29 days');
  assert.strictEqual(await run(720, 31 * 24 * HOUR), true, '720 drops 31 days');
  assert.strictEqual(await run(100000, 29 * 24 * HOUR), false, 'above 720 clamps to 720');
  assert.strictEqual(await run('junk', 23 * HOUR), false, 'a non-number reads as the default 24');
  assert.strictEqual(await run('junk', 25 * HOUR), true);
});

// ------------------------------------ 5) fetchOrgOnOpen off / no snapshot
check('fetchOrgOnOpen off: a stale snapshot still shows, nothing is listed', async () => {
  cfg.fetchOrgOnOpen = false;
  try {
    const s = snap(DEV, ['ApexClass:Old'], 25 * HOUR);
    const p = boot({ state: cacheOf([s]), script: { ApexClass: ORDER } });
    await p.ready();
    assert.strictEqual(p.calls.length, 0);
    assert.strictEqual(p.memberships().length, 1);
    assert.strictEqual(p.memberships()[0].asOf, s.at);
  } finally { delete cfg.fetchOrgOnOpen; }
});

check('no snapshot is exactly the old behaviour: auto-fetch when on, nothing when off', async () => {
  const on = boot({ script: { ApexClass: ORDER } });
  await on.ready();
  assert.ok(on.calls.length > 0);
  assert.strictEqual(on.memberships().length, 1);
  cfg.fetchOrgOnOpen = false;
  try {
    const off = boot({ script: { ApexClass: ORDER } });
    await off.ready();
    assert.strictEqual(off.calls.length, 0);
    assert.strictEqual(off.memberships().length, 0);
    assert.strictEqual(off.cache(), undefined);
  } finally { delete cfg.fetchOrgOnOpen; }
});

// --------------------------------------------------------- 6) org switch
check('org switch: the new org\'s snapshot shows (a stale one re-lists); none → manual as before', async () => {
  const dev = snap(DEV, ['ApexClass:DevOnly'], HOUR);
  const uat = snap(UAT, ['ApexClass:UatOld'], 25 * HOUR);
  const p = boot({ state: cacheOf([dev, uat]), script: { ApexClass: [{ fullName: 'UatNew' }] } });
  await p.ready();
  assert.strictEqual(p.calls.length, 0);
  p.posted.length = 0;
  await p.switchOrg(UAT);
  const types = p.posted.map(m => m.type);
  assert.deepStrictEqual(types.slice(0, 3), ['orgMetadataReset', 'orgs', 'orgMetadata'], types.join(','));
  assert.strictEqual(p.memberships()[0].asOf, uat.at, 'the stale snapshot is shown before the listing');
  assert.ok(p.calls.length > 0, 'stale on switch → re-listed');
  assert.deepStrictEqual(keysOf(p.memberships()[1]), ['ApexClass:UatNew']);
  assert.deepStrictEqual(p.cache()[UAT].keys, ['ApexClass:UatNew']);
  assert.deepStrictEqual(p.cache()[DEV].keys, ['ApexClass:DevOnly'], 'the other org\'s snapshot is untouched');
  // No snapshot: the switch stays manual (no fetch, no membership post).
  const before = p.calls.length;
  p.posted.length = 0;
  await p.switchOrg('acme-other-user');
  assert.deepStrictEqual(p.posted.map(m => m.type), ['orgMetadataReset', 'orgs']);
  assert.strictEqual(p.calls.length, before);
  assert.strictEqual(p.inst.orgMembersOrg, undefined);
  // Back to a fresh one: shown, not listed.
  p.posted.length = 0;
  await p.switchOrg(DEV);
  assert.strictEqual(p.memberships().length, 1);
  assert.strictEqual(p.memberships()[0].asOf, dev.at);
  assert.strictEqual(p.calls.length, before);
});

// ------------------------------------------------------ 7) hostile state
check('hostile or malformed state is ignored whole, or key by key, and never reaches argv', async () => {
  cfg.fetchOrgOnOpen = false;
  try {
    for (const [label, state] of [
      ['array', { [KEY]: [] }],
      ['string', { [KEY]: 'junk' }],
      ['wrong org', { [KEY]: { [DEV]: snap('someone-else', ['ApexClass:A'], HOUR) } }],
      ['keys not an array', { [KEY]: { [DEV]: { org: DEV, keys: 'ApexClass:A', at: Date.now() } } }],
      ['no stamp', { [KEY]: { [DEV]: { org: DEV, keys: ['ApexClass:A'] } } }],
      ['string stamp', { [KEY]: { [DEV]: { org: DEV, keys: ['ApexClass:A'], at: '1' } } }],
      ['entry not an object', { [KEY]: { [DEV]: 42 } }]
    ]) {
      const p = boot({ state });
      await p.ready();
      assert.strictEqual(p.memberships().length, 0, `${label}: hydrated`);
      assert.strictEqual(p.inst.orgMembersOrg, undefined, `${label}: adopted`);
    }
    // Split on the FIRST colon, as every key splitter does: 'Apex:Class:X' is
    // type Apex + name Class:X — legal, exactly as confirmOnOrg would fold it.
    const junk = ['--target-org:X', 'Apex Class:X', '../../etc:X', 'ApexClass:*', 'ApexClass:Order*', 'ApexClass:', 'ApexClass', ':NoType', 'Package:package.xml', 42, null, {},
      'Apex:Class:X', 'ApexClass:Good', 'CustomField:Widget__c.Size__c', 'Report:unfiled$public/AcmeReport', 'Layout:Widget__c-Widget Layout'];
    const p = boot({ state: cacheOf([snap(DEV, junk, HOUR)]) });
    await p.ready();
    assert.deepStrictEqual(keysOf(p.memberships()[0]), ['Apex:Class:X', 'ApexClass:Good', 'CustomField:Widget__c.Size__c', 'Layout:Widget__c-Widget Layout', 'Report:unfiled$public/AcmeReport']);
    // resolveKeys turns membership into `--metadata` argv: the vetted map can
    // only ever hand back what survived the vet.
    p.inst.items = [];
    const resolved = proto.resolveKeys.call(p.inst, ['--target-org:X', 'ApexClass:*', 'ApexClass:Good']);
    assert.deepStrictEqual(resolved.map(i => `${i.type}:${i.name}`), ['ApexClass:Good']);
  } finally { delete cfg.fetchOrgOnOpen; }
});

check('vetOrgSnapshot: a future stamp reads as now; managedHidden keeps only positive counts', () => {
  const future = vetOrgSnapshot(DEV, { org: DEV, keys: [], at: Date.now() + 10 * HOUR });
  assert.ok(future.at <= Date.now());
  assert.strictEqual(vetOrgSnapshot(DEV, { org: DEV, keys: [], at: Number.NaN }), undefined);
  assert.strictEqual(vetOrgSnapshot(DEV, { org: DEV, keys: [], at: Date.now(), managedHidden: [1] }).managedHidden, undefined);
  assert.deepStrictEqual(vetOrgSnapshot(DEV, { org: DEV, keys: [], at: Date.now(), managedHidden: { ApexClass: 2, Flow: -1, Bot: 'x' } }).managedHidden, { ApexClass: 2 });
  assert.strictEqual(vetOrgSnapshot(DEV, { org: DEV, keys: Array(50_001).fill('ApexClass:A'), at: Date.now() }), undefined, 'over-cap entries are dropped whole');
});

// ------------------------------------------------------- 8) the size cap
check('a listing over the cap is not persisted, is logged, and evicts the org\'s older snapshot', async () => {
  const older = snap(DEV, ['ApexClass:Stale'], HOUR);
  const big = Array.from({ length: 50_001 }, (_, i) => ({ fullName: `C${i}` }));
  const p = boot({ state: cacheOf([older, snap(UAT, ['ApexClass:U'], HOUR)]), script: { ApexClass: big } });
  await p.ready();
  assert.strictEqual(p.calls.length, 0, 'fresh → nothing listed yet');
  await p.fetchOrg();
  assert.strictEqual(p.inst.orgMembers.size, 50_001, 'still shown this session');
  assert.strictEqual(p.cache()[DEV], undefined, 'the older snapshot must not resurrect next session');
  assert.deepStrictEqual(p.cache()[UAT].keys, ['ApexClass:U']);
  assert.ok(p.log.some(l => l === `[org cache] ${DEV}: 50001 components exceed the 50000 cap — snapshot not persisted.`), p.log.join('\n'));
});

// ------------------------------------------- 9) mutations keep the stamp
check('confirm and delete update the snapshot\'s keys but keep its stamp and managed counts', async () => {
  const s = snap(DEV, ['ApexClass:OrderService'], HOUR, { managedHidden: { ApexClass: 2 } });
  const p = boot({ state: cacheOf([s]) });
  await p.ready();
  const w0 = p.writes();
  proto.addOrgMemberKeys.call(p.inst, ['ApexClass:Added'], 'acme-dev');
  assert.strictEqual(p.writes(), w0 + 1);
  assert.deepStrictEqual(p.cache()[DEV].keys, ['ApexClass:OrderService', 'ApexClass:Added']);
  assert.strictEqual(p.cache()[DEV].at, s.at, 'a deploy vouches for one component, not the listing');
  assert.deepStrictEqual(p.cache()[DEV].managedHidden, { ApexClass: 2 });
  assert.strictEqual(p.memberships().pop().asOf, s.at, 'the repost keeps the listing time');
  proto.addOrgMemberKeys.call(p.inst, ['ApexClass:Added'], 'acme-dev');
  assert.strictEqual(p.writes(), w0 + 1, 'nothing changed → nothing written');
  await proto.afterDelete.call(p.inst, ['ApexClass:OrderService'], DEV, 'acme-dev');
  assert.deepStrictEqual(p.cache()[DEV].keys, ['ApexClass:Added']);
  assert.strictEqual(p.cache()[DEV].at, s.at);
  await proto.afterDelete.call(p.inst, ['ApexClass:Added'], UAT, 'acme-uat');
  assert.deepStrictEqual(p.cache()[DEV].keys, ['ApexClass:Added'], 'another org\'s delete leaves the snapshot alone');
});

// -------------------------------------------------- 10) manual Fetch Org
check('a manual Fetch Org re-lists a fresh snapshot and overwrites it', async () => {
  const s = snap(DEV, ['ApexClass:Old'], HOUR);
  const p = boot({ state: cacheOf([s]), script: { ApexClass: [{ fullName: 'New' }] } });
  await p.ready();
  assert.strictEqual(p.calls.length, 0);
  await p.fetchOrg();
  assert.ok(p.calls.length > 0);
  assert.deepStrictEqual(p.cache()[DEV].keys, ['ApexClass:New']);
  assert.ok(p.cache()[DEV].at > s.at);
  assert.strictEqual(p.cache()[DEV].managedHidden, undefined, 'a clean listing carries no stale managed counts');
});

// ------------------------------------- 11) five orgs / interrupted listing
check('at most five orgs are kept — the oldest write goes first', async () => {
  const five = [1, 2, 3, 4, 5].map(i => snap(`acme-org${i}-user`, ['ApexClass:A'], HOUR));
  const p = boot({ state: cacheOf(five), org: 'acme-six-user', script: { ApexClass: ORDER } });
  await p.ready();
  const orgs = Object.keys(p.cache());
  assert.strictEqual(orgs.length, 5);
  assert.deepStrictEqual(orgs, ['acme-org2-user', 'acme-org3-user', 'acme-org4-user', 'acme-org5-user', 'acme-six-user']);
  assert.ok(p.cache()['acme-six-user'].org === 'acme-six-user');
});

check('an interrupted (auth/network) listing is shown but never persisted — not even after a confirm', async () => {
  const fatal = new SfCliError('NamedOrgNotFound: No authorization information found');
  fatal.errorName = 'NamedOrgNotFound';
  const p = boot({ script: { ApexClass: fatal, ApexTrigger: [{ fullName: 'T' }] } });
  await p.ready();
  assert.deepStrictEqual(keysOf(p.memberships()[0]), ['ApexTrigger:T'], 'what listed is still shown');
  assert.strictEqual(p.cache(), undefined);
  proto.addOrgMemberKeys.call(p.inst, ['ApexClass:Deployed'], 'acme-dev');
  assert.strictEqual(p.cache(), undefined);
  assert.strictEqual(p.memberships().pop().asOf, undefined);
});

// ---------------------------------------------- 12) rebuild + source pins
check('a webview rebuild (second ready) re-posts the membership and does not re-list', async () => {
  const s = snap(DEV, ['ApexClass:A'], HOUR);
  const cached = boot({ state: cacheOf([s]) });
  await cached.ready();
  await cached.ready();
  assert.strictEqual(cached.calls.length, 0);
  assert.deepStrictEqual(cached.memberships().map(m => m.asOf), [s.at, s.at]);
  const listed = boot({ script: { ApexClass: ORDER } });
  await listed.ready();
  const n = listed.calls.length;
  await listed.ready();
  assert.strictEqual(listed.calls.length, n, 'one auto-fetch per session');
  const m = listed.memberships();
  assert.strictEqual(m.length, 2);
  assert.strictEqual(typeof m[1].asOf, 'number', 'the repost carries the listing time');
  assert.strictEqual(m[1].asOf, listed.cache()[DEV].at);
});

check('source: the org-switch resync hydrates; the listing persists only when complete; both mutations persist', () => {
  assert.ok(/orgStore\.onDidChange\(username => \{[\s\S]*?this\.postOrgs\(\);[\s\S]*?if \(username\) this\.maybeAutoFetchOrg\(true\);\n\s*\}\)\);/.test(src));
  assert.ok(src.includes("this.orgMembersAt = incomplete ? undefined : Date.now();\n      this.persistOrgSnapshot(managedSkipped);"));
  assert.strictEqual((src.match(/this\.persistOrgSnapshot\(/g) || []).length, 3, 'fetch + addOrgMemberKeys + afterDelete');
  assert.ok(src.includes("this.post({ type: 'orgMetadata', orgItems, orgLabel, asOf: this.orgMembersAt });"));
  assert.ok(src.includes("this.orgMembersAt = undefined;\n    this.post({ type: 'orgMetadataReset' });"), 'reset clears the stamp');
});

check('manifest: the setting is declared with its bounds, and this harness is in `check`', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const s = pkg.contributes.configuration.properties['sfOrgDeployWrapper.orgCacheMaxAgeHours'];
  assert.deepStrictEqual([s.type, s.default, s.minimum, s.maximum], ['number', 24, 0, 720]);
  assert.match(s.markdownDescription, /Fetch Org always re-lists/);
  assert.ok(pkg.scripts.check.includes('node ./scripts/check-org-cache.cjs'));
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8').includes('`sfOrgDeployWrapper.orgCacheMaxAgeHours`'));
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
  if (failed) { console.error(`org-cache: ${failed} of ${queue.length} checks failed`); process.exit(1); }
  console.log(`org-cache: all ${queue.length} checks passed`);
})();
