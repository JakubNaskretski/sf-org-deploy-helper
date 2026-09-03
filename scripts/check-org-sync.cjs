// Runnable contract test for the org-sync toggle (orgStore.ts + its call sites).
// No framework.   1) npm run compile   2) node scripts/check-org-sync.cjs
//
// The rule the whole family now follows: each plugin remembers its OWN org in its
// private globalState key, and the family-shared setting
// `skrety.salesforce.targetOrg` is opt-in per plugin via
// `sfOrgDeployWrapper.syncOrgWithFamily` (default OFF).
//
// Contracts under test, driven through the REAL OrgStore against a vscode stub:
//   - the private key is the source of truth and is written on EVERY applied
//     change (pick, adopted family switch, startup fallback, migration);
//   - the shared setting is written ONLY by a user pick AND only while the opt-in
//     is on — never by activation, the watcher, reconciliation or a fallback;
//   - the watcher reads the opt-in at EVENT time, so toggling needs no reload:
//     off is a no-op, and flipping it on adopts a differing family org;
//   - the store fires its own change event (a pick is visible with sync off),
//     de-duped on same-value writes and never looping on its own shared write;
//   - the one-time migration adopts the shared value once, then stops.
// Plus source pins on the call sites, where "user-initiated" is decided.
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const Module = require('module');

// ---------------------------------------------------------------- vscode stub
const config = new Map();       // full dotted key → value
const configWrites = [];        // every getConfiguration().update() call
const configListeners = [];

class EventEmitter {
  constructor() { this.listeners = []; }
  get event() {
    return (fn) => {
      this.listeners.push(fn);
      return { dispose: () => { this.listeners = this.listeners.filter(l => l !== fn); } };
    };
  }
  fire(v) { for (const l of [...this.listeners]) l(v); }
  dispose() { this.listeners = []; }
}

function emitConfigChange(changedKey) {
  const e = { affectsConfiguration: (k) => changedKey === k || changedKey.startsWith(`${k}.`) };
  for (const l of [...configListeners]) l(e);
}

const vscodeStub = {
  EventEmitter,
  ConfigurationTarget: { Global: 1 },
  workspace: {
    getConfiguration: (section) => {
      const full = (key) => (section ? `${section}.${key}` : key);
      return {
        get: (key, def) => {
          const v = config.get(full(key));
          return v === undefined ? def : v;
        },
        // Mirrors VS Code: a settings write also raises a configuration-change
        // event, so our own shared write re-enters the watcher.
        update: async (key, value, target) => {
          configWrites.push({ key: full(key), value, target });
          if (value === undefined) config.delete(full(key)); else config.set(full(key), value);
          emitConfigChange(full(key));
        }
      };
    },
    onDidChangeConfiguration: (h) => {
      configListeners.push(h);
      return { dispose: () => { const i = configListeners.indexOf(h); if (i >= 0) configListeners.splice(i, 1); } };
    }
  }
};

const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? vscodeStub : origLoad(req, ...rest));

const { OrgStore } = require(path.join(__dirname, '..', 'out', 'orgStore.js'));

const SHARED = 'skrety.salesforce.targetOrg';
const SYNC = 'sfOrgDeployWrapper.syncOrgWithFamily';
const PRIVATE_KEY = 'sfOrgDeployWrapper.selectedOrg.v1';
const MIGRATED_KEY = 'sfOrgDeployWrapper.orgSyncMigrated.v1';
// Fictional fixtures only.
const DEV = 'dev@acme.example';
const QA = 'qa@acme.example';

// ------------------------------------------------------------------- harness
let failed = 0;
let ran = 0;
const cases = [];
function check(name, fn) { cases.push({ name, fn }); }

/** Fresh world: empty settings, a memento seeded from `state`, a live OrgStore. */
function world({ shared, sync, state = {} } = {}) {
  config.clear();
  configWrites.length = 0;
  configListeners.length = 0;
  if (shared !== undefined) config.set(SHARED, shared);
  if (sync !== undefined) config.set(SYNC, sync);
  const store = new Map(Object.entries(state));
  const events = [];
  const logs = [];
  const memento = {
    get: (k, d) => (store.has(k) ? store.get(k) : d),
    update: async (k, v) => { if (v === undefined) store.delete(k); else store.set(k, v); }
  };
  const orgStore = new OrgStore(memento, m => logs.push(m));
  orgStore.onDidChange(v => events.push(v));
  return {
    orgStore, events, logs, configWrites,
    priv: () => store.get(PRIVATE_KEY),
    migrated: () => store.get(MIGRATED_KEY),
    shared: () => config.get(SHARED),
    sharedWrites: () => configWrites.filter(w => w.key === SHARED),
    /** Someone else (a sibling plugin, or a settings.json edit) moves the family org. */
    externalShared: async (username) => {
      if (username === undefined) config.delete(SHARED); else config.set(SHARED, username);
      emitConfigChange(SHARED);
      await settle();
    },
    toggleSync: async (on) => {
      config.set(SYNC, on);
      emitConfigChange(SYNC);
      await settle();
    }
  };
}
/** Let the watcher's fire-and-forget adoption finish. */
const settle = () => new Promise(r => setImmediate(r));

// ------------------------------------------------------------------ sync OFF
check('OFF: a user pick writes the private key and NOT the shared setting', async () => {
  const w = world({ sync: false });
  await w.orgStore.setFromUserPick(DEV);
  assert.strictEqual(w.priv(), DEV);
  assert.strictEqual(w.orgStore.get(), DEV);
  assert.deepStrictEqual(w.sharedWrites(), []);
  assert.strictEqual(w.shared(), undefined);
});

check('OFF: the own pick still fires onDidChange (the watcher is not our event source)', async () => {
  const w = world({ sync: false });
  await w.orgStore.setFromUserPick(DEV);
  assert.deepStrictEqual(w.events, [DEV]);
});

check('OFF: an external shared switch is ignored — org and event both stay put', async () => {
  const w = world({ sync: false, state: { [PRIVATE_KEY]: DEV, [MIGRATED_KEY]: true } });
  await w.externalShared(QA);
  assert.strictEqual(w.orgStore.get(), DEV);
  assert.deepStrictEqual(w.events, []);
});

// ------------------------------------------------------------------- sync ON
check('ON: a user pick publishes to the family setting', async () => {
  const w = world({ sync: true });
  await w.orgStore.setFromUserPick(DEV);
  assert.strictEqual(w.priv(), DEV);
  assert.deepStrictEqual(w.sharedWrites().map(x => x.value), [DEV]);
});

check('ON: our own shared write does not loop back into a second event', async () => {
  const w = world({ sync: true });
  await w.orgStore.setFromUserPick(DEV);
  await settle();
  assert.deepStrictEqual(w.events, [DEV]);
  assert.strictEqual(w.sharedWrites().length, 1);
});

check('ON: an external shared switch is adopted into the private key and fires', async () => {
  const w = world({ sync: true, state: { [PRIVATE_KEY]: DEV, [MIGRATED_KEY]: true } });
  await w.externalShared(QA);
  assert.strictEqual(w.priv(), QA);
  assert.deepStrictEqual(w.events, [QA]);
  assert.deepStrictEqual(w.sharedWrites(), []); // adopting never writes back
});

check('ON: picking the empty placeholder clears US but never blanks the family setting', async () => {
  // The panel's "— select org —" row posts selectOrg with null, which reaches the
  // store as a user-initiated pick of undefined. Publishing that would wipe the
  // shared org for every sibling plugin on a stray click.
  const w = world({ shared: DEV, sync: true, state: { [PRIVATE_KEY]: DEV, [MIGRATED_KEY]: true } });
  await w.orgStore.setFromUserPick(undefined);
  assert.strictEqual(w.orgStore.get(), undefined);     // our own org is cleared
  assert.deepStrictEqual(w.events, [undefined]);
  assert.deepStrictEqual(w.sharedWrites(), []);        // the family setting is untouched
  assert.strictEqual(w.shared(), DEV);
  await w.orgStore.setFromUserPick('   ');             // whitespace is the same "no org"
  assert.deepStrictEqual(w.sharedWrites(), []);
});

check('ON: a CLEARED shared setting is not adopted — it cannot blank our target', async () => {
  const w = world({ shared: DEV, sync: true, state: { [PRIVATE_KEY]: DEV, [MIGRATED_KEY]: true } });
  await w.externalShared(undefined);
  assert.strictEqual(w.orgStore.get(), DEV);
  assert.deepStrictEqual(w.events, []);
});

// ------------------------------------------- programmatic writes stay private
check('programmatic set() never publishes, even with sync ON', async () => {
  const w = world({ sync: true, state: { [MIGRATED_KEY]: true } });
  await w.orgStore.set(DEV);      // startup fallback to the CLI default
  await w.orgStore.set(undefined); // reconciliation: remembered org is gone
  assert.deepStrictEqual(w.sharedWrites(), []);
  assert.deepStrictEqual(w.events, [DEV, undefined]);
});

check('same-value writes are de-duped; blank is normalised to "no org"', async () => {
  const w = world({ sync: false, state: { [MIGRATED_KEY]: true } });
  await w.orgStore.set(DEV);
  await w.orgStore.set(DEV);
  await w.orgStore.setFromUserPick(DEV);
  assert.deepStrictEqual(w.events, [DEV]);
  await w.orgStore.set('   ');
  assert.strictEqual(w.orgStore.get(), undefined);
  assert.deepStrictEqual(w.events, [DEV, undefined]);
});

// ----------------------------------------------------------------- migration
check('migration: first run adopts the shared org even with sync OFF, and marks itself', async () => {
  const w = world({ shared: QA, sync: false, state: { [PRIVATE_KEY]: DEV } });
  await w.orgStore.migrate();
  assert.strictEqual(w.priv(), QA);
  assert.strictEqual(w.migrated(), true);
  assert.deepStrictEqual(w.events, [QA]);
  assert.deepStrictEqual(w.sharedWrites(), []);
});

check('migration: marked once, a later family switch cannot leak in with sync OFF', async () => {
  const w = world({ shared: QA, sync: false, state: { [PRIVATE_KEY]: DEV, [MIGRATED_KEY]: true } });
  await w.orgStore.migrate();
  assert.strictEqual(w.orgStore.get(), DEV);
  assert.deepStrictEqual(w.events, []);
});

check('migration: the marker is stamped UNCONDITIONALLY, even with the shared setting empty', async () => {
  // Migration must run exactly once per install. Left pending because there was
  // nothing to adopt, it would fire on a LATER activation and hand a sync-off
  // plugin whatever org a sibling had since published — off would stop meaning
  // "island". So the marker is stamped, and the next activation is a no-op.
  const w = world({ sync: false });
  await w.orgStore.migrate();
  assert.strictEqual(w.migrated(), true);
  assert.strictEqual(w.orgStore.get(), undefined);

  const later = world({ shared: QA, sync: false, state: { [PRIVATE_KEY]: DEV, [MIGRATED_KEY]: true } });
  await later.orgStore.migrate();
  assert.strictEqual(later.orgStore.get(), DEV);
  assert.deepStrictEqual(later.events, []);
});

check('activation with sync ON adopts a family switch missed while shut down', async () => {
  const w = world({ shared: QA, sync: true, state: { [PRIVATE_KEY]: DEV, [MIGRATED_KEY]: true } });
  await w.orgStore.migrate();
  assert.strictEqual(w.priv(), QA);
  assert.deepStrictEqual(w.events, [QA]);
  assert.deepStrictEqual(w.sharedWrites(), []);
});

// --------------------------------------------------------- toggling, no reload
check('toggle ON adopts the differing family org without a reload', async () => {
  const w = world({ shared: QA, sync: false, state: { [PRIVATE_KEY]: DEV, [MIGRATED_KEY]: true } });
  await w.toggleSync(true);
  assert.strictEqual(w.orgStore.get(), QA);
  assert.deepStrictEqual(w.events, [QA]);
});

check('toggle OFF changes nothing — we just stop following', async () => {
  const w = world({ shared: QA, sync: true, state: { [PRIVATE_KEY]: DEV, [MIGRATED_KEY]: true } });
  await w.toggleSync(false);
  assert.strictEqual(w.orgStore.get(), DEV);
  assert.deepStrictEqual(w.events, []);
  await w.externalShared(DEV === QA ? DEV : QA);
  assert.strictEqual(w.orgStore.get(), DEV);
});

check('a picked org survives a toggle ON→OFF→sibling-switch round trip', async () => {
  const w = world({ sync: true, state: { [MIGRATED_KEY]: true } });
  await w.orgStore.setFromUserPick(DEV);
  await w.toggleSync(false);
  await w.externalShared(QA);
  assert.strictEqual(w.orgStore.get(), DEV);
  await w.orgStore.setFromUserPick(QA);
  assert.deepStrictEqual(w.sharedWrites().map(x => x.value), [DEV]); // only the sync-ON pick
});

check('dispose stops the watcher', async () => {
  const w = world({ sync: true, state: { [PRIVATE_KEY]: DEV, [MIGRATED_KEY]: true } });
  w.orgStore.dispose();
  await w.externalShared(QA);
  assert.strictEqual(w.priv(), DEV);
});

// ------------------------------------------------------------------- source pins
// Where "user-initiated" is decided lives at the call sites — pin it so a future
// edit can't quietly publish a housekeeping write to the whole family.
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const storeSrc = read('src', 'orgStore.ts');
const panelSrc = read('src', 'panelProvider.ts');
const extSrc = read('src', 'extension.ts');
const pkg = JSON.parse(read('package.json'));

check('source: setSharedOrg is called from exactly one place — setFromUserPick', () => {
  const calls = storeSrc.split('\n').filter(l => /(?<!import.*)\bsetSharedOrg\(/.test(l) && !l.startsWith('import'));
  assert.deepStrictEqual(calls.map(l => l.trim()), ['if (picked && isOrgSyncEnabled()) await setSharedOrg(picked);']);
  const body = storeSrc.slice(storeSrc.indexOf('async setFromUserPick('));
  assert.ok(body.slice(0, body.indexOf('\n  }')).includes('await setSharedOrg(picked);'));
});

check('source: nothing outside the store imports the shared-setting writer', () => {
  for (const f of ['panelProvider.ts', 'extension.ts', 'sfCliService.ts', 'fileWatch.ts', 'depGraph.ts', 'metadataScanner.ts', 'suggestionLog.ts', 'panelHtml.ts']) {
    assert.ok(!read('src', f).includes('setSharedOrg'), `${f} must not touch the shared setting`);
  }
});

check('source: the watcher is gated on the opt-in read at event time', () => {
  const w = storeSrc.slice(storeSrc.indexOf('onDidChangeConfiguration'));
  const body = w.slice(0, w.indexOf('});'));
  assert.ok(body.includes('e.affectsConfiguration(SHARED_ORG_SETTING)'));
  assert.ok(body.includes('e.affectsConfiguration(SYNC_SETTING)'));
  assert.ok(body.includes('if (!isOrgSyncEnabled()) return;'));
  assert.ok(!/isOrgSyncEnabled\(\)\s*;?\s*$/m.test(storeSrc.slice(0, storeSrc.indexOf('this.watcher'))),
    'the flag must not be captured before the handler runs');
});

check('source: only genuine picks take the publishing path', () => {
  assert.strictEqual((panelSrc.match(/this\.orgStore\.setFromUserPick\(/g) || []).length, 2);
  assert.ok(panelSrc.includes('await this.orgStore.setFromUserPick(username);'));            // palette / status bar
  assert.ok(panelSrc.includes('await this.applyOrgSelection(msg.username || undefined, true);')); // panel dropdown
  assert.ok(panelSrc.includes('if (msg.username) await this.applyOrgSelection(msg.username);'));  // Fetch Org echo: private
  assert.ok(panelSrc.includes('await this.applyOrgSelection(username);'));                        // post-login auto-select: private
  assert.ok(panelSrc.includes('if (userInitiated) await this.orgStore.setFromUserPick(username);'));
});

check('source: activation only migrates — it never seeds the shared setting', () => {
  assert.ok(extSrc.includes('void orgStore.migrate()'));
  assert.ok(!extSrc.includes('setSharedOrg'));
  assert.ok(!storeSrc.includes('migrateToSharedOrg'));
});

check('package.json: the toggle is contributed, boolean, default off, machine scope', () => {
  const props = pkg.contributes.configuration.properties;
  const s = props['sfOrgDeployWrapper.syncOrgWithFamily'];
  assert.ok(s, 'setting missing');
  assert.strictEqual(s.type, 'boolean');
  assert.strictEqual(s.default, false);
  assert.strictEqual(s.scope, 'machine');
  assert.ok(s.markdownDescription.includes('skrety.salesforce.targetOrg'));
  assert.ok(props['skrety.salesforce.targetOrg'].markdownDescription.includes('syncOrgWithFamily'),
    'the shared setting must say it is opt-in');
  assert.ok(pkg.scripts.check.includes('check-org-sync.cjs'));
});

// --------------------------------------------------------------------- runner
(async () => {
  for (const c of cases) {
    ran++;
    try { await c.fn(); } catch (e) { failed++; console.error(`FAIL ${c.name}: ${e.message}`); }
  }
  if (failed > 0) { console.error(`${failed}/${ran} checks FAILED`); process.exit(1); }
  console.log(`org-sync: all ${ran} checks passed`);
})();
