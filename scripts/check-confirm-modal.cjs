// Runnable contract test for the deploy/validate confirm modal text
// (deployConfirmModal in panelProvider.ts) and the test-level plan it reports
// (resolveTestPlan).   No framework.
//   1) npm run compile   2) node scripts/check-confirm-modal.cjs
//
// The modal is the last gate before a live org change, so its text is a
// contract, not decoration. Under test: the machine-scoped conflict override
// (sfOrgDeployWrapper.ignoreDeployConflicts) is NAMED whenever it is on — it is
// sticky across workspaces, so a user can carry it in from another project and
// otherwise never see it — a check-only validate gets wording that doesn't claim
// anything is replaced, a queued confirm says the flag is re-read when it runs
// (the provider does NOT pin it), and with the override OFF every variant is
// byte-for-byte what shipped before the notice existed (including the absent
// `detail` key on the plain non-prod case).
//
// The test-level half pins the same honesty rule for tests: the note states the
// level in EVERY case (a NoTestRun deploy said nothing at all before, which is
// how a sandbox deploy could run zero tests without the user knowing), and a
// validate never claims NoTestRun — `sf project deploy validate` has no such
// option, so the plan resolves it to RunLocalTests and the note says why.
//
// Production adds one more: the org REJECTS NoTestRun for a deploy containing
// Apex, so that combination gets a warning in the note. The scope is pinned in
// both directions — a sandbox NoTestRun (the everyday case) and a prod run at any
// other level stay clean, and a prod validate keeps its RunLocalTests upgrade
// sentence without collecting a warning about a level it isn't using.
//
// The modal builder is a pure prototype method that never touches `this`, so it
// is called directly. resolveTestPlan reads four things off `this`
// (testLevel/runTests session picks, configuredTestLevel(), output) — a plain
// object supplies them, so neither needs a provider + webview stood up.
const path = require('path');
const assert = require('assert');
const Module = require('module');
const origLoad = Module._load;
// The only vscode surface resolveTestPlan touches is the warning shown when
// RunSpecifiedTests has no usable class name — capture it so the refusal path is
// assertable instead of silently swallowed.
const warnings = [];
Module._load = (req, ...rest) => (req === 'vscode'
  ? { window: { showWarningMessage: (m) => { warnings.push(m); } } }
  : origLoad(req, ...rest));

const { DeployPanelProvider } = require(path.join(__dirname, '..', 'out', 'panelProvider.js'));
const buildModal = DeployPanelProvider.prototype.deployConfirmModal;
const resolveTestPlan = DeployPanelProvider.prototype.resolveTestPlan;

let failed = 0;
let ran = 0;
function check(name, fn) {
  ran++;
  try { fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}

const INSTANCE_URL = 'https://acme-dev.example.invalid';
// Sandbox deploy, no test note — the plainest variant; each check overrides only
// the flags it is about.
const BASE = { noun: '3 components', orgLabel: 'acme-dev', isProd: false, validateOnly: false, testNote: '', ignoreConflicts: false };
const modal = (over = {}, queued = false) => buildModal.call(null, { ...BASE, ...over }, queued);

// resolveTestPlan against a stand-in provider: `pick` is the panel's live select,
// `classes` its RunSpecifiedTests box, `configured` the settings.json default.
// `opts` is the per-call request (a context-menu deploy, a card retry, or the
// panel's own Deploy/Validate click).
const plan = ({ pick, classes, configured, opts = {}, isProd = false } = {}) => resolveTestPlan.call(
  { testLevel: pick, runTests: classes, configuredTestLevel: () => configured, output: { appendLine: () => {} } },
  opts,
  isProd
);
const noteFor = (over) => plan(over).testNote;

// ------------------------------------------------- override OFF: unchanged
check('override off, plain deploy → no detail key at all', () => {
  const out = modal();
  assert.deepStrictEqual(out.options, { modal: true });
  assert.strictEqual(out.message, 'Deploy 3 components to acme-dev?');
  assert.strictEqual(out.confirmLabel, 'Deploy');
});

check('override off, prod deploy → detail is exactly the instance URL', () => {
  const out = modal({ isProd: true, instanceUrl: INSTANCE_URL });
  assert.deepStrictEqual(out.options, { modal: true, detail: INSTANCE_URL });
  assert.strictEqual(out.confirmLabel, 'Deploy to PROD');
});

check('override off, queued deploy → detail is only the queue note', () => {
  const out = modal({}, true);
  assert.deepStrictEqual(out.options, { modal: true, detail: 'Runs after the current operation finishes.' });
});

check('override off never mentions conflicts in any variant', () => {
  for (const isProd of [false, true]) {
    for (const validateOnly of [false, true]) {
      for (const queued of [false, true]) {
        const out = modal({ isProd, validateOnly, instanceUrl: INSTANCE_URL }, queued);
        const text = `${out.message}\n${out.options.detail ?? ''}`;
        assert.ok(!/ignore-conflicts|Overwrite/i.test(text), `leaked notice: prod=${isProd} validate=${validateOnly} queued=${queued}`);
      }
    }
  }
});

// -------------------------------------------------- override ON: the notice
check('override on, deploy → one detail line naming the flag and the effect', () => {
  const out = modal({ ignoreConflicts: true });
  assert.strictEqual(
    out.options.detail,
    'Overwrite org changes is ON — newer changes in the org will be replaced (--ignore-conflicts).'
  );
  // The notice is additive: the question itself is untouched.
  assert.strictEqual(out.message, 'Deploy 3 components to acme-dev?');
  assert.strictEqual(out.confirmLabel, 'Deploy');
});

check('override on, prod deploy → instance URL keeps the first line', () => {
  const out = modal({ ignoreConflicts: true, isProd: true, instanceUrl: INSTANCE_URL });
  const lines = out.options.detail.split('\n');
  assert.strictEqual(lines[0], INSTANCE_URL);
  assert.ok(lines[1].includes('--ignore-conflicts'), lines[1]);
  assert.strictEqual(lines.length, 2);
});

check('override on, validate → wording never claims anything is replaced', () => {
  const out = modal({ ignoreConflicts: true, validateOnly: true });
  assert.strictEqual(
    out.options.detail,
    'Overwrite org changes is ON — the conflict check is skipped, so this validation will not flag newer changes in the org (--ignore-conflicts).'
  );
  assert.ok(!/will be replaced/.test(out.options.detail));
});

// --------------------------------------------------------- queued semantics
check('override on, queued → says the flag is re-read at run time', () => {
  const out = modal({ ignoreConflicts: true }, true);
  const lines = out.options.detail.split('\n');
  assert.strictEqual(
    lines[0],
    'Overwrite org changes is ON — newer changes in the org will be replaced (--ignore-conflicts). The setting is re-read when this queued run starts.'
  );
  // The queue note stays last, as it did before the notice existed.
  assert.strictEqual(lines[1], 'Runs after the current operation finishes.');
  assert.strictEqual(lines.length, 2);
});

check('immediate confirm makes no re-read claim', () => {
  const out = modal({ ignoreConflicts: true });
  assert.ok(!/re-read/.test(out.options.detail), out.options.detail);
});

check('override on, queued prod deploy → URL, notice, queue note in that order', () => {
  const out = modal({ ignoreConflicts: true, isProd: true, instanceUrl: INSTANCE_URL }, true);
  const lines = out.options.detail.split('\n');
  assert.strictEqual(lines.length, 3);
  assert.strictEqual(lines[0], INSTANCE_URL);
  assert.ok(lines[1].startsWith('Overwrite org changes is ON'), lines[1]);
  assert.strictEqual(lines[2], 'Runs after the current operation finishes.');
});

// ---------------------------------------------------------- manifest deploys
// deployManifest builds its confirm through this same builder instead of
// assembling `detail` inline: a second copy of the assembly is a second place for
// the overwrite notice to go missing, and that path is the one a user reaches
// with a package.xml against production. A manifest deploy is always the real
// thing and never queues, so it is the plain `validateOnly: false, queued: false`
// shape — only the noun differs.
const MANIFEST_NOUN = 'manifest package.xml — 2 types, 5 members';

check('manifest deploy, override off → no detail key at all', () => {
  const out = modal({ noun: MANIFEST_NOUN });
  assert.deepStrictEqual(out.options, { modal: true });
  assert.strictEqual(out.message, `Deploy ${MANIFEST_NOUN} to acme-dev?`);
  assert.strictEqual(out.confirmLabel, 'Deploy');
});

check('manifest deploy to PROD, override off → detail is exactly the instance URL', () => {
  const out = modal({ noun: MANIFEST_NOUN, isProd: true, instanceUrl: INSTANCE_URL });
  assert.deepStrictEqual(out.options, { modal: true, detail: INSTANCE_URL });
  assert.ok(out.message.includes('PRODUCTION (acme-dev)'), out.message);
  assert.strictEqual(out.confirmLabel, 'Deploy to PROD');
});

check('manifest deploy to PROD with the override ON names the flag', () => {
  // The gap this pins: a machine-scoped override carried in from another
  // workspace, a package.xml, and production — the one combination where a
  // missing notice costs the user newer org changes.
  const out = modal({ noun: MANIFEST_NOUN, isProd: true, instanceUrl: INSTANCE_URL, ignoreConflicts: true });
  const lines = out.options.detail.split('\n');
  assert.strictEqual(lines[0], INSTANCE_URL);
  assert.ok(lines[1].includes('--ignore-conflicts'), lines[1]);
  assert.ok(lines[1].includes('will be replaced'), lines[1]);
  assert.strictEqual(lines.length, 2);
});

// A prod org whose instanceUrl never loaded must not open the detail with a
// blank line — the notice has to take the first line instead.
check('override on, prod deploy without an instance URL → notice leads', () => {
  const out = modal({ ignoreConflicts: true, isProd: true });
  assert.strictEqual(out.options.detail.split('\n').length, 1);
  assert.ok(out.options.detail.startsWith('Overwrite org changes is ON'), out.options.detail);
});

// ============================================================ test-level plan
// ------------------------------------------------- the note always names a level
check('NoTestRun deploy → the note names it instead of saying nothing', () => {
  const p = plan({ pick: 'NoTestRun' });
  assert.strictEqual(p.testLevel, 'NoTestRun');
  assert.strictEqual(p.testNote, '\n\nTests: none (NoTestRun)');
});

check('sandbox with nothing picked → NoTestRun, and the note discloses it', () => {
  // The silent case: the picker sits on "Tests: default", the fallback resolves
  // to NoTestRun on a sandbox, and the deploy legitimately runs no tests at all.
  // The modal has to say so — nothing else in the UI does.
  const p = plan({ isProd: false });
  assert.strictEqual(p.testLevel, 'NoTestRun');
  assert.strictEqual(p.testNote, '\n\nTests: none (NoTestRun)');
});

check('production with nothing picked → RunLocalTests', () => {
  const p = plan({ isProd: true });
  assert.strictEqual(p.testLevel, 'RunLocalTests');
  assert.strictEqual(p.testNote, '\n\nTests: RunLocalTests');
});

check('each level still reads correctly', () => {
  assert.strictEqual(noteFor({ pick: 'RunLocalTests' }), '\n\nTests: RunLocalTests');
  assert.strictEqual(noteFor({ pick: 'RunAllTestsInOrg' }), '\n\nTests: RunAllTestsInOrg');
  assert.strictEqual(
    noteFor({ pick: 'RunSpecifiedTests', classes: ['AcmeTest'] }),
    '\n\nTests: RunSpecifiedTests (1 class)'
  );
  assert.strictEqual(
    noteFor({ pick: 'RunSpecifiedTests', classes: ['AcmeTest', 'BillingTest'] }),
    '\n\nTests: RunSpecifiedTests (2 classes)'
  );
});

check('no reachable combination produces an empty note', () => {
  for (const pick of [undefined, 'NoTestRun', 'RunLocalTests', 'RunAllTestsInOrg', 'RunSpecifiedTests']) {
    for (const configured of [undefined, 'NoTestRun', 'RunLocalTests', 'RunAllTestsInOrg']) {
      for (const isProd of [false, true]) {
        for (const validateOnly of [false, true]) {
          const p = plan({ pick, configured, isProd, classes: ['AcmeTest'], opts: { validateOnly } });
          assert.ok(p, `refused: pick=${pick} configured=${configured}`);
          assert.ok(
            p.testNote.startsWith('\n\nTests: ') && p.testNote.length > '\n\nTests: '.length,
            `empty/oddly-shaped note: pick=${pick} configured=${configured} prod=${isProd} validate=${validateOnly} → ${JSON.stringify(p.testNote)}`
          );
        }
      }
    }
  }
});

check('the class-count wording only claims what was accepted', () => {
  // Invalid names are dropped by the argv filter, so the count must come from
  // the surviving list, not the raw input.
  const p = plan({ pick: 'RunSpecifiedTests', classes: ['AcmeTest', 'rm -rf /'] });
  assert.strictEqual(p.runTests.length, 1);
  assert.strictEqual(p.testNote, '\n\nTests: RunSpecifiedTests (1 class)');
});

check('RunSpecifiedTests with no usable class refuses instead of noting', () => {
  warnings.length = 0;
  assert.strictEqual(plan({ pick: 'RunSpecifiedTests', classes: [] }), undefined);
  assert.deepStrictEqual(warnings, ['RunSpecifiedTests needs at least one test class name.']);
});

// ------------------------------------------- validate cannot skip tests
// `sf project deploy validate` has no NoTestRun option at all; its --test-level
// defaults to RunLocalTests. Omitting the flag and letting the CLI decide is what
// made the modal silent about tests on exactly the run that ran them.
check('validate + NoTestRun pick → RunLocalTests, and the note says why', () => {
  const p = plan({ pick: 'NoTestRun', opts: { validateOnly: true } });
  assert.strictEqual(p.testLevel, 'RunLocalTests');
  assert.strictEqual(
    p.testNote,
    '\n\nTests: RunLocalTests — a validation always runs tests, so NoTestRun does not apply.'
  );
  assert.ok(!/none \(NoTestRun\)/.test(p.testNote), p.testNote);
});

check('validate + NoTestRun from the settings default → same resolution', () => {
  const p = plan({ configured: 'NoTestRun', opts: { validateOnly: true } });
  assert.strictEqual(p.testLevel, 'RunLocalTests');
  assert.ok(p.testNote.includes('a validation always runs tests'), p.testNote);
});

check('validate on a sandbox with nothing picked → RunLocalTests, not NoTestRun', () => {
  const p = plan({ isProd: false, opts: { validateOnly: true } });
  assert.strictEqual(p.testLevel, 'RunLocalTests');
});

check('a validate that already names a level is left alone', () => {
  const local = plan({ pick: 'RunLocalTests', opts: { validateOnly: true } });
  assert.strictEqual(local.testLevel, 'RunLocalTests');
  assert.strictEqual(local.testNote, '\n\nTests: RunLocalTests'); // no "does not apply" clause
  const all = plan({ pick: 'RunAllTestsInOrg', opts: { validateOnly: true } });
  assert.strictEqual(all.testLevel, 'RunAllTestsInOrg');
  const specified = plan({ pick: 'RunSpecifiedTests', classes: ['AcmeTest'], opts: { validateOnly: true } });
  assert.strictEqual(specified.testLevel, 'RunSpecifiedTests');
  assert.strictEqual(specified.testNote, '\n\nTests: RunSpecifiedTests (1 class)');
});

check('a real deploy keeps NoTestRun — only validate is upgraded', () => {
  for (const isProd of [false, true]) {
    assert.strictEqual(plan({ pick: 'NoTestRun', isProd }).testLevel, 'NoTestRun');
  }
});

// ------------------------------------- production + NoTestRun is a doomed deploy
// `sf project deploy start --test-level NoTestRun` is refused by a production org
// whenever the payload contains Apex. The smart default can't reach this (prod
// falls back to RunLocalTests), so getting here means the user picked NoTestRun in
// the panel or set it as defaultTestLevel — and the modal is the last place to say
// the org will bounce it. It warns rather than blocks: NoTestRun against prod is
// legal for an Apex-free payload, which nothing on this path can determine.
const PROD_NO_TESTS = '\n\nTests: none (NoTestRun) — Salesforce rejects this for a production deploy that contains Apex.';
const warnsAboutProd = (note) => /Salesforce rejects/.test(note);

check('prod deploy + explicit NoTestRun → the note warns, level unchanged', () => {
  const p = plan({ pick: 'NoTestRun', isProd: true });
  assert.strictEqual(p.testLevel, 'NoTestRun', 'the warning is text only — the CLI args must not change');
  assert.strictEqual(p.testNote, PROD_NO_TESTS);
});

check('the warning follows the resolved level, not where it came from', () => {
  // Same doomed deploy whether NoTestRun arrived from the settings default or
  // from a card retry carrying the original run's level.
  assert.strictEqual(noteFor({ configured: 'NoTestRun', isProd: true }), PROD_NO_TESTS);
  assert.strictEqual(noteFor({ opts: { testLevel: 'NoTestRun' }, isProd: true }), PROD_NO_TESTS);
});

check('SANDBOX + NoTestRun stays clean — the everyday case', () => {
  // The common deploy. A warning here would be wrong (sandboxes accept
  // NoTestRun) and would train the user to ignore the prod one.
  assert.strictEqual(noteFor({ pick: 'NoTestRun', isProd: false }), '\n\nTests: none (NoTestRun)');
  assert.strictEqual(noteFor({ isProd: false }), '\n\nTests: none (NoTestRun)', 'the smart-default sandbox case too');
  assert.strictEqual(noteFor({ configured: 'NoTestRun', isProd: false }), '\n\nTests: none (NoTestRun)');
});

check('no other prod level collects the warning', () => {
  for (const pick of ['RunLocalTests', 'RunAllTestsInOrg', 'RunSpecifiedTests']) {
    const note = noteFor({ pick, classes: ['AcmeTest'], isProd: true });
    assert.ok(!warnsAboutProd(note), `${pick} warned: ${JSON.stringify(note)}`);
  }
  // Including the prod smart default, which is RunLocalTests precisely because
  // the org demands tests.
  assert.strictEqual(noteFor({ isProd: true }), '\n\nTests: RunLocalTests');
});

check('prod validate + NoTestRun keeps the upgrade sentence and gains no warning', () => {
  // The level in force is RunLocalTests, so a rejection warning would describe a
  // deploy that isn't happening — and a validate never writes to the org anyway.
  for (const source of [{ pick: 'NoTestRun' }, { configured: 'NoTestRun' }]) {
    const p = plan({ ...source, isProd: true, opts: { validateOnly: true } });
    assert.strictEqual(p.testLevel, 'RunLocalTests');
    assert.strictEqual(
      p.testNote,
      '\n\nTests: RunLocalTests — a validation always runs tests, so NoTestRun does not apply.'
    );
    assert.ok(!warnsAboutProd(p.testNote), p.testNote);
  }
});

check('the warning appears ONLY on prod + NoTestRun, across every combination', () => {
  for (const pick of [undefined, 'NoTestRun', 'RunLocalTests', 'RunAllTestsInOrg', 'RunSpecifiedTests']) {
    for (const configured of [undefined, 'NoTestRun', 'RunLocalTests', 'RunAllTestsInOrg']) {
      for (const isProd of [false, true]) {
        for (const validateOnly of [false, true]) {
          const p = plan({ pick, configured, isProd, classes: ['AcmeTest'], opts: { validateOnly } });
          const expected = isProd && !validateOnly && p.testLevel === 'NoTestRun';
          assert.strictEqual(
            warnsAboutProd(p.testNote), expected,
            `pick=${pick} configured=${configured} prod=${isProd} validate=${validateOnly} → ${JSON.stringify(p.testNote)}`
          );
        }
      }
    }
  }
});

// ---------------------------------------- the note as each modal renders it
// The note is built once and consumed by three confirms; these pin how it reads
// where the user actually meets it.
check('immediate sandbox deploy names the missing tests in the question', () => {
  const out = modal({ testNote: noteFor({}) });
  assert.strictEqual(out.message, 'Deploy 3 components to acme-dev?\n\nTests: none (NoTestRun)');
  // The note belongs to the message; the detail block stays as it was.
  assert.deepStrictEqual(out.options, { modal: true });
});

check('queued deploy carries the same note under the Queue: prefix', () => {
  const out = modal({ testNote: noteFor({}) }, true);
  assert.strictEqual(out.message, 'Queue: Deploy 3 components to acme-dev?\n\nTests: none (NoTestRun)');
  assert.strictEqual(out.options.detail, 'Runs after the current operation finishes.');
});

check('manifest deploy names the level too', () => {
  const out = modal({ noun: MANIFEST_NOUN, testNote: noteFor({}) });
  assert.strictEqual(out.message, `Deploy ${MANIFEST_NOUN} to acme-dev?\n\nTests: none (NoTestRun)`);
});

check('prod deploy keeps the live-immediately line above the test note', () => {
  const out = modal({ isProd: true, instanceUrl: INSTANCE_URL, testNote: noteFor({ isProd: true }) });
  assert.strictEqual(
    out.message,
    '⚠ Deploy 3 components to PRODUCTION (acme-dev)?\n\nThis change will be live immediately.\n\nTests: RunLocalTests'
  );
});

check('prod deploy confirm reads the rejection warning as its last line', () => {
  const out = modal({ isProd: true, instanceUrl: INSTANCE_URL, testNote: noteFor({ pick: 'NoTestRun', isProd: true }) });
  assert.strictEqual(
    out.message,
    '⚠ Deploy 3 components to PRODUCTION (acme-dev)?\n\nThis change will be live immediately.'
    + '\n\nTests: none (NoTestRun) — Salesforce rejects this for a production deploy that contains Apex.'
  );
  // Still the ordinary confirm — no second dialog, and the detail block is
  // untouched by the warning.
  assert.deepStrictEqual(out.options, { modal: true, detail: INSTANCE_URL });
  assert.strictEqual(out.confirmLabel, 'Deploy to PROD');
});

check('a queued prod deploy carries the same warning', () => {
  // enqueueDeploy builds its note through the same resolveTestPlan call, so the
  // confirm the user answers at enqueue time must not be the quiet one.
  const out = modal({ isProd: true, instanceUrl: INSTANCE_URL, testNote: noteFor({ pick: 'NoTestRun', isProd: true }) }, true);
  assert.ok(out.message.startsWith('Queue: ⚠ Deploy'), out.message);
  assert.ok(/Salesforce rejects this for a production deploy that contains Apex\.$/.test(out.message), out.message);
});

check('validate confirm states the tests it cannot skip', () => {
  const out = modal({ validateOnly: true, testNote: noteFor({ pick: 'NoTestRun', opts: { validateOnly: true } }) });
  assert.strictEqual(
    out.message,
    'Validate 3 components against acme-dev? (check-only — nothing is deployed)'
    + '\n\nTests: RunLocalTests — a validation always runs tests, so NoTestRun does not apply.'
  );
  assert.strictEqual(out.confirmLabel, 'Validate');
});

if (failed) { console.error(`\n${failed} of ${ran} check(s) failed`); process.exit(1); }
console.log(`deployConfirmModal + resolveTestPlan: all ${ran} checks passed`);
