// Seeded Status-pane runs for the harnesses: every verdict the pane can show,
// from an 11,582-row deploy down to a three-row conflict, as full run records
// (src/runRecords.ts shape). Deterministic for a given `now`. All names are
// fictional placeholders.
//
//   const F = require('./lib/run-fixtures.cjs');
//   const scenarios = F.buildScenarios(now);          // [{ id, label, run, live?, progress? }]
//   const msg = F.runsMessage(scenarios, 'fxbigdeploy', { summarize, cap: 3 });
//
// `summarize` is src/runRecords.ts's summarizeRun (out/runRecords.js), injected
// so this file needs nothing compiled and the pane is fed exactly what the
// provider would keep.
'use strict';

function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a += 0x6D2B79F5; let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const between = (r, a, b) => a + Math.floor(r() * (b - a + 1));
const lc = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const leaf = (p) => (p || '').split('/').pop();

const WORDS = ['Invoice', 'Order', 'Quote', 'Shipment', 'Region', 'Tax', 'Discount', 'Payment', 'Warehouse', 'Route', 'Ticket', 'Return', 'Catalog', 'Price', 'Bundle', 'Contract', 'Renewal', 'Alert', 'Audit', 'Batch', 'Sync', 'Queue', 'Summary', 'Approval', 'Escalation', 'Reminder', 'Metric', 'Score', 'Tier', 'Segment', 'Territory', 'Campaign', 'Asset', 'Snapshot', 'Version', 'Ledger', 'Carrier', 'Depot', 'Pallet', 'Voucher', 'Rebate', 'Loyalty', 'Forecast', 'Inventory', 'Supplier', 'Dispatch', 'Manifest', 'Tariff', 'Customs', 'Fleet'];
const SUFFIX = ['Service', 'Handler', 'Controller', 'Helper', 'Util', 'Selector', 'Domain', 'Wrapper', 'Mapper', 'Builder', 'Factory', 'Scheduler', 'Notifier', 'Validator', 'Formatter', 'Parser', 'Loader', 'Exporter', 'Importer', 'Batch', 'Queueable', 'Sync'];
const NAMERS = {
  ApexClass: (r) => 'Acme' + pick(r, WORDS) + (r() < 0.5 ? pick(r, WORDS) : '') + pick(r, SUFFIX),
  ApexTrigger: (r) => 'Acme' + pick(r, WORDS) + (r() < 0.6 ? pick(r, WORDS) : '') + 'Trigger',
  CustomObject: (r) => 'Acme' + pick(r, WORDS) + (r() < 0.7 ? pick(r, WORDS) : '') + '__c',
  CustomField: (r) => (r() < 0.3 ? pick(r, ['Account', 'Opportunity', 'Contact', 'Case']) : 'Acme' + pick(r, WORDS) + '__c') + '.Acme' + pick(r, WORDS) + pick(r, ['', 'Date', 'Amount', 'Code', 'Status', 'Count']) + '__c',
  Layout: (r) => { const w = pick(r, WORDS); return 'Acme' + w + '__c-Acme ' + w + ' ' + (r() < 0.6 ? pick(r, WORDS) + ' ' : '') + pick(r, ['Layout', 'Compact Layout', 'Service Layout']); },
  FlexiPage: (r) => 'Acme_' + pick(r, WORDS) + '_' + pick(r, WORDS) + '_' + pick(r, ['Record', 'Home', 'App']) + '_Page',
  LightningComponentBundle: (r) => 'acme' + pick(r, WORDS) + (r() < 0.6 ? pick(r, WORDS) : '') + pick(r, ['Card', 'List', 'Panel', 'Form', 'Tile', 'Picker']),
  AuraDefinitionBundle: (r) => 'Acme' + pick(r, WORDS) + pick(r, WORDS) + pick(r, ['Cmp', 'Modal', 'Quick']),
  PermissionSet: (r) => 'Acme_' + pick(r, WORDS) + '_' + pick(r, WORDS) + '_' + pick(r, ['Access', 'Admin', 'ReadOnly']),
  Profile: (r) => 'Acme ' + pick(r, WORDS) + ' ' + pick(r, ['User', 'Manager', 'Analyst', 'Admin']),
  CustomLabel: (r) => 'Acme_' + pick(r, WORDS) + '_' + pick(r, WORDS) + '_' + pick(r, ['Title', 'Error', 'Hint', 'Label', 'Success', 'Empty']),
  StaticResource: (r) => 'acme_' + lc(pick(r, WORDS)) + '_' + pick(r, ['assets', 'icons', 'styles', 'lib']),
  Flow: (r) => 'Acme_' + pick(r, WORDS) + '_' + pick(r, ['Approval', 'Intake', 'Cleanup', 'Routing', 'Followup']),
  ValidationRule: (r) => 'Acme' + pick(r, WORDS) + '__c.Acme_' + pick(r, WORDS) + '_Required',
  CustomMetadata: (r) => 'Acme' + pick(r, WORDS) + 'Setting.' + pick(r, WORDS) + '_' + pick(r, ['Default', 'EU', 'US', 'Legacy']),
  RecordType: (r) => 'Acme' + pick(r, WORDS) + '__c.' + pick(r, ['Standard', 'Express', 'Internal', 'Partner']),
  QuickAction: (r) => 'Acme' + pick(r, WORDS) + '__c.Acme_' + pick(r, ['New', 'Close', 'Escalate', 'Ship']) + '_' + pick(r, WORDS),
  ListView: (r) => 'Acme' + pick(r, WORDS) + '__c.' + pick(r, ['All', 'My', 'Open', 'Recent']) + '_' + pick(r, WORDS),
  Report: (r) => 'AcmeReports/Acme_' + pick(r, WORDS) + '_by_' + pick(r, WORDS),
  Dashboard: (r) => 'AcmeDashboards/Acme_' + pick(r, WORDS) + '_' + pick(r, WORDS) + '_Overview',
  EmailTemplate: (r) => 'AcmeTemplates/Acme_' + pick(r, WORDS) + '_' + pick(r, WORDS) + '_' + pick(r, ['Notice', 'Receipt', 'Reminder']),
  CustomTab: (r) => 'Acme' + pick(r, WORDS) + pick(r, WORDS) + '__c',
  GlobalValueSet: (r) => 'Acme_' + pick(r, WORDS) + '_Values',
  WorkflowRule: (r) => 'Acme' + pick(r, WORDS) + '__c.Acme_' + pick(r, WORDS) + '_Alert',
  ApexPage: (r) => 'Acme' + pick(r, WORDS) + pick(r, ['Print', 'Preview', 'Export']) + 'Page',
  CustomObjectTranslation: (r) => 'Acme' + pick(r, WORDS) + '__c-' + pick(r, ['de', 'fr', 'es', 'pl']),
  Bot: (r) => 'Acme_' + pick(r, WORDS) + '_Assistant'
};
function fileFor(type, name) {
  const dot = name.indexOf('.');
  const obj = dot > 0 ? name.slice(0, dot) : name, sub = dot > 0 ? name.slice(dot + 1) : name;
  switch (type) {
    case 'ApexClass': return name + '.cls';
    case 'ApexTrigger': return name + '.trigger';
    case 'CustomField': return sub + '.field-meta.xml';
    case 'ValidationRule': return sub + '.validationRule-meta.xml';
    case 'Layout': return name + '.layout-meta.xml';
    case 'FlexiPage': return name + '.flexipage-meta.xml';
    case 'LightningComponentBundle': return name + '.js';
    case 'PermissionSet': return name + '.permissionset-meta.xml';
    case 'Flow': return name + '.flow-meta.xml';
    default: return leaf(obj) + '-meta.xml';
  }
}

const BIG_SPEC = [['CustomField', 2800], ['ApexClass', 1800], ['CustomLabel', 700], ['Layout', 640], ['LightningComponentBundle', 420], ['CustomMetadata', 380], ['ValidationRule', 260], ['ListView', 240], ['CustomObject', 210], ['Flow', 210], ['FlexiPage', 180], ['AuraDefinitionBundle', 160], ['Report', 160], ['RecordType', 150], ['StaticResource', 130], ['ApexTrigger', 120], ['PermissionSet', 95], ['QuickAction', 90], ['EmailTemplate', 70], ['WorkflowRule', 60], ['ApexPage', 50], ['CustomTab', 45], ['Dashboard', 40], ['Profile', 25], ['GlobalValueSet', 12]];
const SKIP_SPEC = [['Report', 620], ['ListView', 480], ['Layout', 390], ['CustomField', 300], ['Dashboard', 210], ['EmailTemplate', 160], ['FlexiPage', 120], ['WorkflowRule', 90], ['PermissionSet', 60], ['QuickAction', 40], ['Profile', 35], ['CustomTab', 30]];
const APEX_ERRORS = [
  'Variable does not exist: acmeTotal',
  'Method does not exist or incorrect signature: void calcTax(Decimal) from the type AcmeTaxUtil',
  'Invalid type: AcmeDiscount__mdt',
  'Dependent class is invalid and needs recompilation: AcmeOrderHandler',
  'Illegal assignment from List<AcmeInvoice__c> to List<AcmeOrder__c>',
  'Variable does not exist: shipDate',
  "Unexpected token '}'.",
  'Field is not writeable: AcmeOrder__c.AcmeTotal__c',
  "Didn't understand relationship 'AcmeLines__r' in field path. If you are attempting to use a custom relationship, be sure to append the '__r' after the custom relationship name.",
  'Method is not visible: AcmeLedgerService.post(Id)'
];
const META_ERRORS = {
  CustomField: ['In field: referenceTo - no CustomObject named AcmeCarrier__c found', 'Cannot change type of a custom field with data from Text to Number', 'In field: formula - no field AcmeRegion__c found'],
  Layout: ['In field: QuickAction - no QuickAction named AcmeOrder__c.Acme_Ship found', 'In field: field - no CustomField named AcmeOrder__c.AcmeShipDate__c found'],
  Flow: ['The flow contains an element that references a field that does not exist: AcmeShipDate__c', 'The flow failed to activate because some of its components have errors: invalid formula in AcmeTotalCheck'],
  PermissionSet: ['In field: field - no CustomField named AcmeInvoice__c.AcmeStatus__c found', 'Unknown user permission: ViewAcmeLedger'],
  FlexiPage: ['Property "objectApiName" does not exist on component acmeOrderCard', 'The component acmeShipmentTile is not available for this page'],
  ApexTrigger: ['Variable does not exist: acmeTotals', 'Invalid type: AcmeShipmentBatch']
};
const TEST_FAILS = [
  'System.AssertException: Assertion Failed: Expected: 120.00, Actual: 100.00',
  'System.AssertException: Assertion Failed: Expected: 3, Actual: 2',
  'System.NullPointerException: Attempt to de-reference a null object',
  'System.DmlException: Insert failed. First exception on row 0; first error: REQUIRED_FIELD_MISSING, Required fields are missing: [AcmeRegion__c]',
  'System.LimitException: Too many SOQL queries: 101',
  'System.QueryException: List has no rows for assignment to SObject',
  'System.AssertException: Assertion Failed: Expected: EU, Actual: null'
];

/** Unique Type:Name rows for a [[type, count], …] spec. */
function makeRows(r, spec, outcome, used, decorate) {
  const out = [];
  for (const [type, n] of spec) {
    const namer = NAMERS[type] || ((rr) => 'Acme' + pick(rr, WORDS));
    for (let i = 0; i < n; i++) {
      let name = namer(r), tries = 0;
      while (used.has(type + ':' + name)) {
        name = namer(r);
        if (++tries > 5) { const x = String(between(r, 2, 999)); name = name.endsWith('__c') ? name.slice(0, -3) + x + '__c' : name + x; }
      }
      used.add(type + ':' + name);
      const row = { k: type + ':' + name, o: outcome };
      if (decorate) decorate(row, r, type, name);
      out.push(row);
    }
  }
  return out;
}
/** Scale a spec's counts proportionally so they sum to exactly `total`. */
function scaleSpec(spec, total) {
  const sum = spec.reduce((s, [, n]) => s + n, 0);
  const raw = spec.map(([t, n]) => [t, (n * total) / sum]);
  const out = raw.map(([t, x]) => [t, Math.floor(x)]);
  let rest = total - out.reduce((s, [, n]) => s + n, 0);
  const order = raw.map((x, i) => [x[1] - Math.floor(x[1]), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) out[order[k][1]][1]++;
  return out.filter(([, n]) => n > 0);
}
const sent = (row) => { row.s = 1; };
const orgOnly = (row) => { row.why = 'org'; };
const unread = (row) => { row.why = 'unread'; };
function failing(row, r, type, name) {
  row.s = 1;
  const apex = type === 'ApexClass' || type === 'ApexTrigger';
  row.m = apex ? pick(r, APEX_ERRORS) : pick(r, META_ERRORS[type] || APEX_ERRORS);
  row.f = fileFor(type, name);
  if (apex) { row.l = between(r, 8, 240); row.c = between(r, 1, 60); }
}
function testFailures(r, n) {
  const classes = new Set();
  while (classes.size < Math.max(1, Math.ceil(n / 3))) classes.add(NAMERS.ApexClass(r) + 'Test');
  const cls = [...classes];
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ cls: cls[i % cls.length], method: 'test' + pick(r, WORDS) + pick(r, ['Totals', 'Rollup', 'Insert', 'Bulk', 'Negative', 'Boundary']) + i, m: pick(r, TEST_FAILS), l: between(r, 12, 140), c: 1 });
  }
  return out;
}
function countRows(rows, seeded, extra) {
  const counts = {};
  for (const o of seeded) counts[o] = 0;
  for (const row of rows) counts[row.o] = (counts[row.o] || 0) + 1;
  counts.sent = rows.filter(x => x.s === 1).length;
  return Object.assign(counts, extra || {});
}

const H = 3600e3, D = 24 * H, M = 60e3;
const ORG = {
  dev: { org: 'acme-dev-user', orgLabel: 'acme-dev', orgKind: 'sandbox' },
  prod: { org: 'acme-prod-user', orgLabel: 'acme-prod', orgKind: 'prod' },
  scratch: { org: 'acme-scratch-user', orgLabel: 'acme-scratch-7', orgKind: 'scratch' }
};
function run(base) {
  return Object.assign({ v: 1, target: 'selection', rowsComplete: true, tests: [] }, base);
}

/** Every scenario, newest first by start time. */
function buildScenarios(now) {
  const out = [];
  // One name pool for every scenario: a component is never skipped in one run
  // and deployed from a local file in another.
  const used = new Set();
  { // a big deploy: 9,047 deployed, 2,535 selected rows existed only on the org
    const r = rng(11);
    const rows = makeRows(r, BIG_SPEC, 'deployed', used, sent).concat(makeRows(r, SKIP_SPEC, 'skipped', used, orgOnly));
    out.push({ id: 'fxbigdeploy', label: 'Big deploy, succeeded', run: run({
      id: 'fxbigdeploy', op: 'deploy', status: 'succeeded', ...ORG.dev, startedAt: now - 1.2 * H, finishedAt: now - 1.2 * H + 252e3,
      jobId: '0AfAc000001kQ9zSAE', testLevel: 'NoTestRun', testsRan: false, rows,
      counts: countRows(rows, ['deployed', 'failed', 'skipped'], { orgDeployed: 9047, orgTotal: 9047, orgErrors: 0 })
    }) });
  }
  { // a failed deploy: 41 component errors, the rest rolled back, some skipped
    const r = rng(23);
    const bad = makeRows(r, [['ApexClass', 24], ['ApexTrigger', 3], ['CustomField', 4], ['Layout', 3], ['Flow', 3], ['PermissionSet', 2], ['FlexiPage', 2]], 'failed', used, failing);
    const ok = makeRows(r, scaleSpec(BIG_SPEC, 3120), 'rolledback', used, sent);
    const skip = makeRows(r, [['CustomObjectTranslation', 2], ['Bot', 1]], 'skipped', used, unread)
      .concat(makeRows(r, [['Report', 8], ['Dashboard', 4]], 'skipped', used, orgOnly));
    const rows = bad.concat(ok, skip);
    const cand = ok.filter(x => x.k.startsWith('CustomField:')).slice(0, 3);
    out.push({ id: 'fxdeployfail', label: 'Deploy failed (41 errors)', run: run({
      id: 'fxdeployfail', op: 'deploy', status: 'failed', ...ORG.prod, startedAt: now - 2.5 * H, finishedAt: now - 2.5 * H + 390e3,
      jobId: '0AfAc000001kR2mSAE', testLevel: 'RunLocalTests', testsRan: true, rows,
      counts: countRows(rows, ['rolledback', 'failed', 'skipped'], { orgDeployed: 3120, orgTotal: 3161, orgErrors: 41 }),
      retry: { validateOnly: false, testLevel: 'RunLocalTests' }, suggestId: 'sug-1758790000000-4'
    }), live: { suggest: {
      id: 'sug-1758790000000-4',
      candidates: cand.map((x, i) => ({ key: x.k, from: bad[i + 24] ? bad[i + 24].k : bad[0].k, why: 'In field: field - no CustomField named ' + x.k.slice('CustomField:'.length) + ' found' })),
      unresolved: ['QuickAction:AcmeOrder__c.Acme_Ship']
    } } });
  }
  { // tests failed: every component rolled back, 14 test failures, the org's coverage message
    const r = rng(37);
    const rows = makeRows(r, [['ApexClass', 40], ['ApexTrigger', 6], ['CustomField', 20], ['Layout', 8], ['PermissionSet', 4], ['Flow', 6]], 'rolledback', used, sent);
    const tests = testFailures(r, 14);
    out.push({ id: 'fxtestsfail', label: 'Tests failed', run: run({
      id: 'fxtestsfail', op: 'deploy', status: 'failed', ...ORG.prod, startedAt: now - D - 2 * H, finishedAt: now - D - 2 * H + 1140e3,
      jobId: '0AfAc000001kNw4SAE', testLevel: 'RunLocalTests', testsRan: true, rows, tests,
      counts: countRows(rows, ['rolledback', 'failed'], { testsRun: 412, testsFailed: 14, orgDeployed: 84, orgTotal: 84, orgErrors: 0 }),
      message: 'Average test coverage across all Apex Classes and Triggers is 71%, at least 75% test coverage is required.',
      retry: { validateOnly: false, testLevel: 'RunLocalTests' }
    }) });
  }
  { // a validation that ran tests (Quick Deploy offered), and its quick deploy the next morning
    const r = rng(53);
    const rows = makeRows(r, scaleSpec(BIG_SPEC, 1204), 'validated', used, sent);
    const startedAt = now - D - 20 * M;
    out.push({ id: 'fxvalidateqd', label: 'Validated, Quick Deploy offered', run: run({
      id: 'fxvalidateqd', op: 'validate', status: 'succeeded', ...ORG.prod, startedAt, finishedAt: startedAt + 1380e3,
      jobId: '0AfAc000001kM7pSAE', testLevel: 'RunLocalTests', testsRan: true, rows,
      counts: countRows(rows, ['validated', 'failed', 'skipped'], { testsRun: 380, testsFailed: 0, orgDeployed: 1204, orgTotal: 1204, orgErrors: 0 }),
      retry: { validateOnly: true, testLevel: 'RunLocalTests' }
    }), live: { quick: { jobId: '0AfAc000001kM7pSAE', until: startedAt + 10 * D } } });
    const qrows = rows.map(x => ({ k: x.k, o: 'deployed', s: 1 }));
    out.push({ id: 'fxquickdeploy', label: 'Quick-deployed', run: run({
      id: 'fxquickdeploy', op: 'quickDeploy', status: 'succeeded', ...ORG.prod, target: 'report', startedAt: now - D + 25 * M, finishedAt: now - D + 25 * M + 96e3,
      jobId: '0AfAc000001kM7pSAE', rows: qrows, fromRunId: 'fxvalidateqd',
      counts: countRows(qrows, ['deployed', 'failed'], { orgDeployed: 1204, orgTotal: 1204, orgErrors: 0 })
    }) });
  }
  { // a validation with no tests: Quick Deploy is not possible
    const r = rng(61);
    const rows = makeRows(r, [['ApexClass', 14], ['LightningComponentBundle', 9], ['CustomField', 8], ['Layout', 4], ['CustomLabel', 2]], 'validated', used, sent);
    out.push({ id: 'fxvalidatenotest', label: 'Validated, no tests', run: run({
      id: 'fxvalidatenotest', op: 'validate', status: 'succeeded', ...ORG.dev, startedAt: now - 2 * D, finishedAt: now - 2 * D + 41e3,
      jobId: '0AfAc000001kL1cSAE', testLevel: 'NoTestRun', testsRan: false, rows,
      counts: countRows(rows, ['validated', 'failed', 'skipped']),
      retry: { validateOnly: true, testLevel: 'NoTestRun' }
    }) });
  }
  { // a retrieve of a few hundred components, with a backup of what it overwrote
    const r = rng(71);
    const rows = makeRows(r, scaleSpec(BIG_SPEC, 237), 'changed', used, sent)
      .concat(makeRows(r, scaleSpec(BIG_SPEC, 61), 'created', used, sent))
      .concat(makeRows(r, [['Report', 6], ['Dashboard', 5]], 'unchanged', used, sent))
      .concat(makeRows(r, [['ApexClass', 2], ['Flow', 1]], 'missing', used, sent));
    out.push({ id: 'fxretrieve', label: 'Retrieve with backup', run: run({
      id: 'fxretrieve', op: 'retrieve', status: 'succeeded', ...ORG.dev, startedAt: now - 3 * D, finishedAt: now - 3 * D + 74e3, rows,
      counts: countRows(rows, ['changed', 'created', 'unchanged', 'missing', 'failed']),
      backupDir: '/work/acme-project/.sfdx/sf-deploy-backups/2026-09-22T10-14-03',
      notes: ['ApexClass/AcmeLegacyExport: Entity of type ApexClass named AcmeLegacyExport cannot be found']
    }) });
  }
  { // still running: the skipped rows are known before the org answers
    const r = rng(41);
    const rows = makeRows(r, SKIP_SPEC, 'skipped', used, orgOnly);
    out.push({ id: 'fxrunning', label: 'Running (progress ticks)', run: run({
      id: 'fxrunning', op: 'deploy', status: 'running', ...ORG.dev, startedAt: now - 192e3,
      testLevel: 'RunLocalTests', rows, counts: { skipped: rows.length, sent: 9047 }
    }), progress: { orgStatus: 'InProgress', compDone: 6120, compTotal: 9047, testDone: 0, testTotal: 412, errors: 0 } });
  }
  { // the deploy never started: the CLI's source-conflict check refused it
    const r = rng(29);
    const rows = makeRows(r, [['ApexClass', 9], ['LightningComponentBundle', 3]], 'pending', used, sent);
    out.push({ id: 'fxconflict', label: 'Conflict: Retry + overwrite', run: run({
      id: 'fxconflict', op: 'deploy', status: 'error', ...ORG.dev, startedAt: now - 3 * D - 2 * H, finishedAt: now - 3 * D - 2 * H + 6e3,
      testLevel: 'NoTestRun', rows, counts: countRows(rows, ['pending']),
      message: 'Conflicts detected: 2 components were changed in the org since your last retrieve (ApexClass:' + rows[0].k.split(':')[1] + ', ApexClass:' + rows[1].k.split(':')[1] + ').',
      hint: 'The org has changes that conflict with your local files — retrieve them first, or enable Overwrite org changes in the panel.',
      cliActions: ['Retrieve the conflicting components, then deploy again.', 'Or deploy with Overwrite org changes to replace them.'],
      retry: { validateOnly: false, testLevel: 'NoTestRun' }, conflict: true
    }) });
  }
  { // lost contact while polling: Resume monitoring
    const r = rng(31);
    const rows = makeRows(r, scaleSpec(BIG_SPEC, 800), 'pending', used, sent).concat(makeRows(r, [['Report', 5]], 'skipped', used, orgOnly));
    out.push({ id: 'fxlost', label: 'Lost contact: Resume', run: run({
      id: 'fxlost', op: 'deploy', status: 'lost', ...ORG.prod, startedAt: now - 4 * D, finishedAt: now - 4 * D + 900e3,
      jobId: '0AfAc000001kJ3tSAE', testLevel: 'RunLocalTests', rows, counts: countRows(rows, ['pending', 'skipped']),
      notes: ['Lost contact with the org after several failed status checks — the deploy may still be running.']
    }) });
  }
  { // cancelled by the user: the org stopped and rolled back
    const r = rng(83);
    const rows = makeRows(r, scaleSpec(BIG_SPEC, 410), 'rolledback', used, sent).concat(makeRows(r, [['Report', 30], ['Dashboard', 6]], 'skipped', used, orgOnly));
    out.push({ id: 'fxcancelled', label: 'Cancelled', run: run({
      id: 'fxcancelled', op: 'deploy', status: 'cancelled', ...ORG.dev, startedAt: now - 6 * D, finishedAt: now - 6 * D + 150e3,
      jobId: '0AfAc000001kG2qSAE', testLevel: 'NoTestRun', rows, counts: countRows(rows, ['rolledback', 'failed', 'skipped'], { orgDeployed: 241, orgTotal: 410 })
    }) });
  }
  { // the window closed mid-run
    const r = rng(89);
    const rows = makeRows(r, [['Report', 4]], 'skipped', used, orgOnly);
    out.push({ id: 'fxinterrupted', label: 'Interrupted by a reload', run: run({
      id: 'fxinterrupted', op: 'validate', status: 'interrupted', ...ORG.scratch, startedAt: now - 7 * D, testLevel: 'RunLocalTests',
      rows, counts: { skipped: rows.length, sent: 52 },
      notes: ["The window closed while this ran; its result wasn't recorded. Check Deployment Status in the org."]
    }) });
  }
  out.sort((a, b) => b.run.startedAt - a.run.startedAt);
  return out;
}

/** Status cards as the provider posts them today — they become notices. */
function buildNotices(now) {
  return [
    { kind: 'ok', title: 'Fetched 12,840 components from acme-dev', meta: '95 types · 4 not available on this org', at: now - 20 * M },
    { kind: 'warn', title: 'Diff completed with issues against acme-dev', meta: '3 opened · 1 missing · 0 errors', lines: ['ApexClass:AcmeOrderService — opened', 'ApexClass:AcmeLedgerSync — not on acme-dev'], at: now - 26 * H },
    { kind: 'err', title: 'Fetch Org failed', errText: 'ERROR running org list metadata: INVALID_SESSION_ID: Session expired or invalid', hint: 'Org authentication looks expired or missing — run `sf org login web` and retry.', at: now - 50 * H },
    { kind: 'ok', title: 'Deleted 3 components from acme-scratch-7', lines: ['ApexClass:AcmeScratchOnly', 'ApexClass:AcmeScratchOnlyTest', 'CustomLabel:Acme_Scratch_Title'], at: now - 5 * D }
  ];
}

/** The `runs` message the provider would post with `latestId` as the newest run:
 *  that run's summary first (plus its live payload), then up to cap-1 older
 *  runs as summaries, and — unless `withLatestRows` is false, the state after a
 *  reload that lost the full list — the newest run's full rows. */
function runsMessage(scenarios, latestId, opts) {
  const summarize = opts.summarize;
  const cap = opts.cap || 3;
  const latest = scenarios.find(s => s.id === latestId);
  if (!latest) throw new Error('no scenario ' + latestId);
  const older = scenarios.filter(s => s.run.startedAt < latest.run.startedAt && s.run.status !== 'running').slice(0, cap - 1);
  const head = Object.assign(summarize(latest.run, { latest: true }), latest.live || {});
  const msg = { type: 'runs', runs: [head].concat(older.map(s => summarize(s.run, { latest: false }))), cap };
  if (opts.withLatestRows !== false) msg.latestRows = { runId: latest.run.id, rows: latest.run.rows, tests: latest.run.tests };
  return msg;
}

/** Every key the scenarios would find in the workspace: what was sent, retrieved
 *  or listed as failing — never a skipped or missing row. */
function localItems(scenarios) {
  // A key skipped or missing in any scenario has no local file in all of them
  // (the seeded names can repeat across scenarios).
  const seen = new Set();
  for (const s of scenarios) for (const row of s.run.rows) if (row.o === 'skipped' || row.o === 'missing') seen.add(row.k);
  const items = [];
  for (const s of scenarios) {
    for (const row of s.run.rows) {
      if (seen.has(row.k)) continue;
      seen.add(row.k);
      const c = row.k.indexOf(':');
      const type = row.k.slice(0, c), name = row.k.slice(c + 1);
      items.push({ type, name, filePath: '/work/acme-project/force-app/main/default/' + type + '/' + fileFor(type, name), files: [] });
    }
    for (const t of s.run.tests) {
      const k = 'ApexClass:' + t.cls;
      if (seen.has(k)) continue;
      seen.add(k);
      items.push({ type: 'ApexClass', name: t.cls, filePath: '/work/acme-project/force-app/main/default/classes/' + t.cls + '.cls', files: [] });
    }
  }
  return items;
}

module.exports = { buildScenarios, buildNotices, runsMessage, localItems };
