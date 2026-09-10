// Runnable contract test for the large-selection manifest path (panelProvider.ts
// runDeploy/runRetrieve, MANIFEST_THRESHOLD/CARD_LINE_CAP/capLines/capForCard;
// metadataScanner.ts buildManifestXml/resolveApiVersion). No framework.
//   1) npm run compile   2) node scripts/check-large-selection.cjs
//
// USER REPORT: deploying thousands of components. Every deploy/validate/retrieve
// passed one `--metadata Type:Name` per component — 8,946 components is ~18k
// argv entries, well past Windows' ~32 KB command-line limit (~500 components),
// slow for the CLI, and the command log echoed the whole string. Result cards
// also listed every component, unbounded on the live post (history already
// capped at 100 lines; the webview collapses at 8 but that's local, not this).
//
// Fix: above MANIFEST_THRESHOLD (30) write a temp package.xml and deploy/
// validate/retrieve via `--manifest` instead — the component SET, its Type:Name
// keys, the retry request, reattach and the org-membership badge flip are all
// unaffected (they key on Type:Name, never on argv shape). Card `lines` are
// capped at CARD_LINE_CAP (100) with a summary tail; the full list still goes to
// the Output channel first. `sf project delete source` has no `--manifest` flag
// (only --metadata/--source-dir), so delete is deliberately NOT touched here —
// see the comment on SfCliService.deleteSource.
//
// Driven through the REAL runDeploy/runRetrieve (DeployPanelProvider.prototype,
// called directly — the same "prototype method + plain object" pattern
// check-retrieve-conflicts.cjs uses for maybeBackupBeforeRetrieve) with `sf`
// recorded and scripted to resolve immediately (no need to drive the double-
// click/queue machinery here — that's check-double-click.cjs's job). Manifest
// files are written to and read from the REAL filesystem (os.tmpdir()), not
// mocked, so the on-disk shape and cleanup are genuinely exercised:
//   a) 31 vs 30 items (deploy) — the manifest/--metadata boundary itself;
//   b) 10,000 items (deploy) — the manifest file exists, is well-formed XML with
//      10,000 <members> grouped into 5 <types> blocks, the echoed command stays
//      short, and the real SfCliService argv (a separate, direct check) carries
//      no --metadata when a manifest is set;
//   c) the same, for retrieve;
//   d) card lines capped at CARD_LINE_CAP with the "and N more" tail, ✗ lines
//      surviving the cut ahead of ✓ lines, and the Output channel getting the
//      FULL uncapped list;
//   e) the temp manifest dir is gone once the run resolves;
//   f) buildManifestXml: escaping and deterministic sort, as a pure unit test;
//   g) a failed 10,000-item deploy's Retry button still carries all 10,000
//      Type:Name keys — the manifest path must not touch RetryRequest at all.
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const assert = require('assert');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------- vscode stub
const cfg = { backupBeforeRetrieve: false }; // skip the (unrelated) backup subsystem
const vscodeStub = {
  window: {
    showWarningMessage: (message, options, ...items) => {
      // Every confirm in these paths is auto-accepted — the double-click/queue
      // harness already covers the modal machinery itself; here only the
      // resulting TEXT (for the "via package.xml" note) and the fact that the
      // run proceeds matter.
      if (options && options.modal) return Promise.resolve(items[0]);
      return Promise.resolve(undefined);
    },
    showInformationMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
    setStatusBarMessage: () => ({ dispose() {} }),
    withProgress: (_o, body) => body({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) })
  },
  workspace: {
    getConfiguration: () => ({
      get: (k, d) => (k in cfg ? cfg[k] : d),
      update: async () => {}
    })
  },
  commands: { executeCommand: async () => {} },
  Uri: { file: fsPath => ({ fsPath, scheme: 'file' }) },
  ProgressLocation: { Notification: 15, Window: 10 },
  ConfigurationTarget: { Global: 1 },
  env: { clipboard: { writeText: async () => {} } }
};
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? vscodeStub : origLoad(req, ...rest));

const { DeployPanelProvider } = require(path.join(ROOT, 'out', 'panelProvider.js'));
const { SfCliService } = require(path.join(ROOT, 'out', 'sfCliService.js'));
const { buildManifestXml } = require(path.join(ROOT, 'out', 'metadataScanner.js'));
const proto = DeployPanelProvider.prototype;

let failed = 0;
const queue = [];
const check = (name, fn) => queue.push([name, fn]);

// ---------------------------------------------------------------- fixtures
const ORG = 'acme-dev-user';
const ORG_LABEL = 'acme-dev';

function makeItems(n, type = 'ApexClass') {
  const items = [];
  for (let i = 0; i < n; i++) {
    const name = `${type}${i}`;
    items.push({ type, name, filePath: `/ws/force-app/main/default/x/${type}_${i}.cls`, files: [] });
  }
  return items;
}

const TEN_K_TYPES = ['ApexClass', 'ApexTrigger', 'LightningComponentBundle', 'CustomObject', 'Layout'];
function makeGroupedItems(total, types) {
  const perType = total / types.length;
  assert.ok(Number.isInteger(perType), 'total must divide evenly across types');
  const items = [];
  for (const type of types) {
    for (let i = 0; i < perType; i++) {
      const name = `${type}${i}`;
      items.push({ type, name, filePath: `/ws/force-app/main/default/x/${type}_${i}.cls`, files: [] });
    }
  }
  return items;
}

const keysOf = items => items.map(i => `${i.type}:${i.name}`);

/** A provider over the real prototype, `sf` stubbed to resolve immediately (no
 *  double-click/queue machinery exercised here — see check-double-click.cjs). */
function provider(items, extra = {}) {
  const posted = [];
  const outputLines = [];
  const calls = { deployMetadata: [], deployReport: [], retrieveMetadata: [] };
  const sf = {
    deployMetadata: (metadata, targetOrg, cwd, opts) => {
      // Read the manifest file (if any) NOW, synchronously — by the time
      // runDeploy resolves its cleanup has already removed it (that's check e).
      const manifestContent = opts.manifest && fs.existsSync(opts.manifest) ? fs.readFileSync(opts.manifest, 'utf8') : undefined;
      calls.deployMetadata.push({ metadata, targetOrg, cwd, opts, manifestContent });
      return {
        promise: Promise.resolve({ result: extra.submitResult ?? { id: 'JOB1' }, cmd: 'sf project deploy start --json' }),
        cancel: () => undefined
      };
    },
    deployReport: (jobId, targetOrg, cwd, opts) => {
      calls.deployReport.push({ jobId, targetOrg, cwd, opts });
      return {
        promise: Promise.resolve({ result: extra.reportResult ?? { status: 'Succeeded', success: true, done: true, id: 'JOB1' } }),
        cancel: () => undefined
      };
    },
    retrieveMetadata: (metadata, targetOrg, cwd, opts) => {
      const manifestContent = opts.manifest && fs.existsSync(opts.manifest) ? fs.readFileSync(opts.manifest, 'utf8') : undefined;
      calls.retrieveMetadata.push({ metadata, targetOrg, cwd, opts, manifestContent });
      return {
        promise: Promise.resolve({ result: extra.retrieveResult ?? { inboundFiles: [] }, cmd: 'sf project retrieve start --json' }),
        cancel: () => undefined
      };
    }
  };
  const s = Object.create(proto);
  Object.assign(s, {
    busy: false, confirmOpen: false, deployQueue: [], cmdSeq: 0,
    orgMembers: new Map(), orgMembersOrg: undefined,
    items, workspaceRoot: '/ws', liveSuggestions: new Map(), suggestionSeq: 0,
    testLevel: undefined, runTests: undefined,
    orgs: [{ username: ORG, alias: ORG_LABEL, instanceUrl: 'https://acme-dev.example.invalid' }],
    orgStore: { get: () => ORG, set: async () => {}, setFromUserPick: async () => {} },
    output: { appendLine: l => outputLines.push(l) },
    context: {
      workspaceState: { get: () => undefined, update: async () => {} },
      globalState: { get: () => undefined, update: async () => {} }
    },
    view: { visible: true, webview: { postMessage() {} } },
    sf,
    post: m => posted.push(m)
  });
  return { s, posted, outputLines, calls };
}

const runDeploy = (p, keys, opts = {}) => proto.runDeploy.call(p.s, keys, opts);
const runRetrieve = (p, keys, opts = {}) => proto.runRetrieve.call(p.s, keys, opts);
const statusCards = p => p.posted.filter(m => m.type === 'status').map(m => m.card);
const firstEchoedCmd = p => p.posted.find(m => m.type === 'cmd' && m.entry.status === 'run')?.entry.command;

// ------------------------------------------------------------- (a) threshold
check('deploy: 31 items go via manifest, 30 go via --metadata', async () => {
  const items31 = makeItems(31);
  const p31 = provider(items31);
  await runDeploy(p31, keysOf(items31));
  assert.strictEqual(p31.calls.deployMetadata.length, 1);
  assert.ok(typeof p31.calls.deployMetadata[0].opts.manifest === 'string', 'expected a manifest path for 31 items');
  assert.ok(firstEchoedCmd(p31).includes('--manifest'), firstEchoedCmd(p31));
  assert.ok(!firstEchoedCmd(p31).includes('--metadata'), firstEchoedCmd(p31));

  const items30 = makeItems(30);
  const p30 = provider(items30);
  await runDeploy(p30, keysOf(items30));
  assert.strictEqual(p30.calls.deployMetadata.length, 1);
  assert.strictEqual(p30.calls.deployMetadata[0].opts.manifest, undefined, 'expected NO manifest for 30 items');
  assert.ok(firstEchoedCmd(p30).includes('--metadata'), firstEchoedCmd(p30));
  assert.ok(!firstEchoedCmd(p30).includes('--manifest'), firstEchoedCmd(p30));
});

check('retrieve: 31 items go via manifest, 30 go via --metadata', async () => {
  const items31 = makeItems(31);
  const p31 = provider(items31);
  await runRetrieve(p31, keysOf(items31));
  assert.strictEqual(p31.calls.retrieveMetadata.length, 1);
  assert.ok(typeof p31.calls.retrieveMetadata[0].opts.manifest === 'string');
  assert.ok(firstEchoedCmd(p31).includes('--manifest'), firstEchoedCmd(p31));

  const items30 = makeItems(30);
  const p30 = provider(items30);
  await runRetrieve(p30, keysOf(items30));
  assert.strictEqual(p30.calls.retrieveMetadata[0].opts.manifest, undefined);
  assert.ok(firstEchoedCmd(p30).includes('--metadata'), firstEchoedCmd(p30));
});

check('a sourceDir-pinned run never switches to manifest, however many items', async () => {
  const items = makeItems(40);
  const p = provider(items);
  await runDeploy(p, keysOf(items), { sourceDir: '/ws/force-app/main/default/x' });
  assert.strictEqual(p.calls.deployMetadata[0].opts.manifest, undefined);
  assert.ok(firstEchoedCmd(p).includes('--source-dir'), firstEchoedCmd(p));
});

check('confirm modal names the manifest path only when it applies', async () => {
  let seenDetail;
  const origWarn = vscodeStub.window.showWarningMessage;
  vscodeStub.window.showWarningMessage = (message, options, ...items) => {
    if (options && options.modal && seenDetail === undefined) seenDetail = options.detail;
    return origWarn(message, options, ...items);
  };
  try {
    const items31 = makeItems(31);
    seenDetail = undefined;
    await runDeploy(provider(items31), keysOf(items31));
    assert.ok((seenDetail || '').includes('package.xml'), seenDetail);

    const items5 = makeItems(5);
    seenDetail = undefined;
    await runDeploy(provider(items5), keysOf(items5));
    assert.ok(!(seenDetail || '').includes('package.xml'), seenDetail);
  } finally {
    vscodeStub.window.showWarningMessage = origWarn;
  }
});

// --------------------------------------------------- (b)/(c) 10,000 fixture
function assertManifestXmlShape(xml, expectedApiVersion) {
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n'), 'missing XML prolog');
  assert.ok(xml.trim().endsWith('</Package>'), 'missing closing </Package>');
  assert.strictEqual((xml.match(/<types>/g) || []).length, TEN_K_TYPES.length);
  assert.strictEqual((xml.match(/<\/types>/g) || []).length, TEN_K_TYPES.length);
  assert.strictEqual((xml.match(/<members>/g) || []).length, 10_000);
  assert.ok(xml.includes(`<version>${expectedApiVersion}</version>`), xml.slice(-80));
  // Types sorted alphabetically.
  const typeOrder = [...xml.matchAll(/<name>([^<]+)<\/name>/g)].map(m => m[1]).filter(n => TEN_K_TYPES.includes(n));
  assert.deepStrictEqual(typeOrder, [...TEN_K_TYPES].sort());
}

check('deploy: 10,000 items → manifest file on disk, well-formed + grouped, short echo, real argv has no per-item entries', async () => {
  const items = makeGroupedItems(10_000, TEN_K_TYPES);
  const p = provider(items);
  await runDeploy(p, keysOf(items));
  const call = p.calls.deployMetadata[0];
  assert.ok(typeof call.opts.manifest === 'string');
  assert.ok(call.manifestContent, 'manifest file was not readable at call time');
  assertManifestXmlShape(call.manifestContent, '62.0'); // no sfdx-project.json at '/ws' → default

  const cmd = firstEchoedCmd(p);
  assert.ok(cmd.length < 300, `echoed command too long (${cmd.length}): ${cmd}`);
  assert.ok(cmd.includes('(10000 components)'), cmd);

  // The REAL SfCliService, given a manifest, never emits per-item --metadata —
  // confirmed directly (not just inferred from panelProvider's call), same
  // "capture argv" pattern check-retrieve-conflicts.cjs uses.
  const real = new SfCliService();
  const rawArgs = [];
  real.runJsonCancellable = args => { rawArgs.push(args); return { promise: new Promise(() => undefined), cancel: () => undefined }; };
  real.deployMetadata(keysOf(items), ORG, '/ws', { manifest: call.opts.manifest });
  assert.strictEqual(rawArgs[0].filter(a => a === '--metadata').length, 0, rawArgs[0].join(' '));
  assert.ok(rawArgs[0].includes('--manifest'), rawArgs[0].join(' '));
});

check('retrieve: 10,000 items → manifest file on disk, well-formed + grouped, short echo, real argv has no per-item entries', async () => {
  const items = makeGroupedItems(10_000, TEN_K_TYPES);
  const p = provider(items, { retrieveResult: { inboundFiles: items.map(i => ({ type: i.type, fullName: i.name, state: 'Changed' })) } });
  await runRetrieve(p, keysOf(items));
  const call = p.calls.retrieveMetadata[0];
  assert.ok(typeof call.opts.manifest === 'string');
  assertManifestXmlShape(call.manifestContent, '62.0');

  const cmd = firstEchoedCmd(p);
  assert.ok(cmd.length < 300, `echoed command too long (${cmd.length}): ${cmd}`);

  const real = new SfCliService();
  const rawArgs = [];
  real.runJsonCancellable = args => { rawArgs.push(args); return { promise: new Promise(() => undefined), cancel: () => undefined }; };
  real.retrieveMetadata(keysOf(items), ORG, '/ws', { manifest: call.opts.manifest });
  assert.strictEqual(rawArgs[0].filter(a => a === '--metadata').length, 0, rawArgs[0].join(' '));
});

// --------------------------------------------------------------- (d) capping
check('deploy success card: lines capped at 100 with a summary tail, full list mirrored to Output', async () => {
  const items = makeItems(150);
  const p = provider(items);
  await runDeploy(p, keysOf(items));
  const card = statusCards(p).find(c => c.kind === 'ok');
  assert.ok(card, 'expected a success card');
  assert.strictEqual(card.lines.length, 101, String(card.lines.length));
  assert.ok(/^… and 50 more — full list in the Output channel$/.test(card.lines[100]), card.lines[100]);
  for (const item of items) {
    assert.ok(p.outputLines.some(l => l.includes(`${item.type}:${item.name}`)), `Output channel missing ${item.type}:${item.name}`);
  }
});

check('retrieve mixed card: ✗ lines survive the cap ahead of ✓ lines, tail present, full list mirrored to Output', async () => {
  const failedItems = makeItems(5, 'ApexTrigger');
  const okItems = makeItems(150, 'ApexClass');
  const all = [...failedItems, ...okItems];
  const p = provider(all, {
    retrieveResult: {
      inboundFiles: [
        ...failedItems.map(i => ({ type: i.type, fullName: i.name, problem: 'boom' })),
        ...okItems.map(i => ({ type: i.type, fullName: i.name, state: 'Changed' }))
      ]
    }
  });
  await runRetrieve(p, keysOf(all));
  const card = statusCards(p).find(c => c.kind === 'err');
  assert.ok(card, 'expected a mixed err card');
  assert.strictEqual(card.lines.length, 101, String(card.lines.length));
  for (let i = 0; i < 5; i++) assert.ok(card.lines[i].startsWith('✗ ApexTrigger:'), card.lines[i]);
  for (let i = 5; i < 100; i++) assert.ok(card.lines[i].startsWith('✓ ApexClass:'), card.lines[i]);
  assert.ok(/^… and 55 more — full list in the Output channel$/.test(card.lines[100]), card.lines[100]);
  for (const item of failedItems) assert.ok(p.outputLines.some(l => l.includes(`✗ ${item.type}:${item.name}`)));
  for (const item of okItems) assert.ok(p.outputLines.some(l => l.includes(`✓ ${item.type}:${item.name}`)));
});

check('a card at or under CARD_LINE_CAP is not capped and Output stays untouched by capForCard', async () => {
  const items = makeItems(30); // <= MANIFEST_THRESHOLD too, so also exercises the plain --metadata path
  const p = provider(items);
  await runDeploy(p, keysOf(items));
  const card = statusCards(p).find(c => c.kind === 'ok');
  assert.strictEqual(card.lines.length, 30);
  assert.ok(!card.lines.some(l => typeof l === 'string' && l.includes('more — full list')));
  assert.strictEqual(p.outputLines.length, 0, 'capForCard must not log when nothing was capped');
});

// -------------------------------------------------------------- (e) cleanup
check('the temp manifest dir is removed once a successful run resolves', async () => {
  const items = makeItems(50);
  const p = provider(items);
  await runDeploy(p, keysOf(items));
  const manifestPath = p.calls.deployMetadata[0].opts.manifest;
  const dir = path.dirname(manifestPath);
  assert.ok(!fs.existsSync(dir), `manifest dir still on disk: ${dir}`);
});

check('the temp manifest dir is removed even when the run fails', async () => {
  const items = makeItems(50);
  const p = provider(items, { reportResult: { status: 'Failed', success: false, done: true, errorMessage: 'boom' } });
  await runDeploy(p, keysOf(items));
  const dir = path.dirname(p.calls.deployMetadata[0].opts.manifest);
  assert.ok(!fs.existsSync(dir));
});

// -------------------------------------------------------------- (g) retry
check('a failed 10,000-item deploy still carries all 10,000 Type:Name keys on Retry', async () => {
  const items = makeGroupedItems(10_000, TEN_K_TYPES);
  const p = provider(items, { reportResult: { status: 'Failed', success: false, done: true, errorMessage: 'Deploy failed for testing' } });
  await runDeploy(p, keysOf(items));
  const card = statusCards(p).find(c => c.kind === 'err');
  assert.ok(card, 'expected a failure card');
  const retryButton = (card.buttons || []).find(b => b.send && b.send.type === 'retryDeploy');
  assert.ok(retryButton, 'expected a Retry button');
  const keys = retryButton.send.request.keys;
  assert.strictEqual(keys.length, 10_000);
  assert.deepStrictEqual([...keys].sort(), keysOf(items).sort());
});

// ----------------------------------------------------- (f) buildManifestXml
check('buildManifestXml escapes &, <, >, quotes', () => {
  const xml = buildManifestXml([
    { type: 'ApexClass', name: 'A & B' },
    { type: 'ApexClass', name: '<Tag>' },
    { type: 'ApexClass', name: `Quote"Both'Kinds` }
  ], '62.0');
  assert.ok(xml.includes('A &amp; B'), xml);
  assert.ok(xml.includes('&lt;Tag&gt;'), xml);
  assert.ok(xml.includes('Quote&quot;Both&apos;Kinds'), xml);
  assert.ok(!xml.includes('<Tag>'), 'raw unescaped angle brackets leaked into the XML');
  // Every <members> body, with legal entities removed, must be free of the five
  // XML-significant characters — anything left over is an unescaped leak.
  const bodies = [...xml.matchAll(/<members>([^<]*)<\/members>/g)].map(m => m[1]);
  assert.strictEqual(bodies.length, 3);
  for (const body of bodies) {
    const withoutEntities = body.replace(/&(amp|lt|gt|quot|apos);/g, '');
    assert.ok(!/[<>&"']/.test(withoutEntities), `unescaped character survived in: ${body}`);
  }
});

check('buildManifestXml groups by type and sorts types + members deterministically, regardless of input order', () => {
  const forward = buildManifestXml([
    { type: 'CustomObject', name: 'Zeta__c' },
    { type: 'ApexClass', name: 'Zebra' },
    { type: 'ApexClass', name: 'Alpha' },
    { type: 'CustomObject', name: 'Alpha__c' }
  ], '62.0');
  const reversed = buildManifestXml([
    { type: 'CustomObject', name: 'Alpha__c' },
    { type: 'ApexClass', name: 'Alpha' },
    { type: 'ApexClass', name: 'Zebra' },
    { type: 'CustomObject', name: 'Zeta__c' }
  ], '62.0');
  assert.strictEqual(forward, reversed, 'input order must not affect the generated XML');
  const apexIdx = forward.indexOf('<name>ApexClass</name>');
  const objIdx = forward.indexOf('<name>CustomObject</name>');
  assert.ok(apexIdx > 0 && objIdx > apexIdx, 'types must sort alphabetically');
  const alphaIdx = forward.indexOf('<members>Alpha</members>');
  const zebraIdx = forward.indexOf('<members>Zebra</members>');
  assert.ok(alphaIdx > 0 && zebraIdx > alphaIdx, 'members must sort alphabetically within a type');
});

check('buildManifestXml de-duplicates a repeated (type, name) pair', () => {
  const xml = buildManifestXml([
    { type: 'ApexClass', name: 'Dup' },
    { type: 'ApexClass', name: 'Dup' }
  ], '62.0');
  assert.strictEqual((xml.match(/<members>Dup<\/members>/g) || []).length, 1);
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
  }
  if (failed) { console.error(`large-selection: ${failed}/${queue.length} checks FAILED`); process.exit(1); }
  console.log(`large-selection: all ${queue.length} checks passed`);
})();
