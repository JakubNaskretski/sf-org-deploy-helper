// Runnable contract test for the live badge-refresh pipeline (panelProvider.ts):
// deploySuccessRows + confirmOnOrg (retrieve rows) + confirmDeployedOnOrg (deploy
// rows) + addOrgMemberKeys/postOrgMembership.
// No framework.   1) npm run compile   2) node scripts/check-org-membership.cjs
//
// Contracts under test:
//  - deploySuccessRows: detail rows win only when PRESENT AND NON-EMPTY (an empty
//    `componentSuccesses: []` must fall through to `files`), and file rows are
//    filtered (no Failed/problem/error rows can become membership).
//  - confirmDeployedOnOrg: rows resolve to SCANNED LOCAL ITEMS (exact key, else
//    filePath — bundle sub-file rows land on their bundle's canonical key);
//    unmappable rows are dropped, so shape drift can never mint phantom rows.
//  - confirmOnOrg (retrieve): rows fold raw but VETTED — membership keys later
//    become `--metadata type:name` argv tokens via resolveKeys, so a type that
//    isn't /^[A-Za-z0-9_]+$/ (flags, whitespace, colons, traversal) is rejected;
//    names keep folders/dots/spaces but never `*` or the package.xml pseudo-row.
//  - Both paths: membership of another org (or never fetched) is untouched, and
//    the webview is re-posted only when membership actually changed, with keys
//    split on the FIRST colon so dotted names survive.
//  - Source pins: the deploy call is validateOnly-gated and every call site
//    feeds org-result rows, never request keys.
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const Module = require('module');
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? {} : origLoad(req, ...rest));

const { DeployPanelProvider, deploySuccessRows } = require(path.join(__dirname, '..', 'out', 'panelProvider.js'));
const proto = DeployPanelProvider.prototype;

let failed = 0;
let ran = 0;
function check(name, fn) {
  ran++;
  try { fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}

// Minimal provider stand-in: the members the confirm pipeline touches, plus the
// real prototype methods so mapping, vetting and the repost split are under test.
function fake(members, org, items = []) {
  const posts = [];
  return {
    orgMembers: new Map(members.map(k => [k, true])),
    orgMembersOrg: org,
    items,
    workspaceRoot: '/ws',
    addOrgMemberKeys: proto.addOrgMemberKeys,
    postOrgMembership: proto.postOrgMembership,
    localFailureKey: proto.localFailureKey,
    // The snapshot write that follows a repost is check-org-cache.cjs's contract.
    persistOrgSnapshot: () => {},
    post: (m) => posts.push(m),
    posts
  };
}
const ORG = 'acme-dev-user';
const retrieve = (self, rows, org = ORG) => proto.confirmOnOrg.call(self, rows, org, 'acme-dev');
const deploy = (self, rows, items, org = ORG) => proto.confirmDeployedOnOrg.call(self, rows, items, org, 'acme-dev');

// A scanned workspace: a class, a decomposed field, and an LWC bundle.
const CLS = { type: 'ApexClass', name: 'OrderService', filePath: '/ws/force-app/main/default/classes/OrderService.cls', files: ['/ws/force-app/main/default/classes/OrderService.cls'] };
const FIELD = { type: 'CustomField', name: 'Widget__c.Size__c', filePath: '/ws/force-app/main/default/objects/Widget__c/fields/Size__c.field-meta.xml', files: ['/ws/force-app/main/default/objects/Widget__c/fields/Size__c.field-meta.xml'] };
const LWC = {
  type: 'LightningComponentBundle', name: 'myCmp',
  filePath: '/ws/force-app/main/default/lwc/myCmp/myCmp.js',
  files: [
    '/ws/force-app/main/default/lwc/myCmp/myCmp.js',
    '/ws/force-app/main/default/lwc/myCmp/myCmp.html',
    '/ws/force-app/main/default/lwc/myCmp/myCmp.js-meta.xml'
  ]
};

// ------------------------------------------------------------ deploySuccessRows
check('deploySuccessRows: non-empty detail rows win', () => {
  const rows = deploySuccessRows({ details: { componentSuccesses: [{ fullName: 'A', componentType: 'ApexClass' }] }, files: [{ fullName: 'B', type: 'ApexClass', state: 'Changed' }] });
  assert.deepStrictEqual(rows.map(r => r.fullName), ['A']);
});

check('deploySuccessRows: EMPTY detail array falls through to files (?? would not)', () => {
  const rows = deploySuccessRows({ details: { componentSuccesses: [] }, files: [{ fullName: 'B', type: 'ApexClass', state: 'Changed' }] });
  assert.deepStrictEqual(rows.map(r => r.fullName), ['B']);
});

check('deploySuccessRows: Failed/problem/error/stateless file rows filtered out', () => {
  const rows = deploySuccessRows({ files: [
    { fullName: 'Good', type: 'ApexClass', state: 'Changed' },
    { fullName: 'Bad1', type: 'ApexClass', state: 'Failed' },
    { fullName: 'Bad2', type: 'ApexClass', state: 'Changed', problem: 'boom' },
    { fullName: 'Bad3', type: 'ApexClass', state: 'Changed', error: 'boom' },
    { fullName: 'Bad4', type: 'ApexClass' }
  ] });
  assert.deepStrictEqual(rows.map(r => r.fullName), ['Good']);
});

// -------------------------------------------------- confirmDeployedOnOrg (deploy)
check('deploy: exact-key row mints the scanned item key and posts once', () => {
  const self = fake(['ApexClass:Existing'], ORG, [CLS]);
  deploy(self, [{ fullName: 'OrderService', componentType: 'ApexClass' }], [CLS]);
  assert.strictEqual(self.orgMembers.has('ApexClass:OrderService'), true);
  assert.strictEqual(self.posts.length, 1);
  assert.strictEqual(self.posts[0].type, 'orgMetadata');
  assert.strictEqual(self.posts[0].orgLabel, 'acme-dev');
});

check('deploy: bundle sub-file rows land on the BUNDLE key — one key, one post, no phantoms', () => {
  const self = fake([], ORG, [LWC]);
  deploy(self, [
    { fullName: 'myCmp/myCmp.js', componentType: 'LightningComponentBundle', filePath: '/ws/force-app/main/default/lwc/myCmp/myCmp.js' },
    { fullName: 'myCmp/myCmp.html', componentType: 'LightningComponentBundle', filePath: '/ws/force-app/main/default/lwc/myCmp/myCmp.html' },
    { fullName: 'myCmp/myCmp.js-meta.xml', componentType: 'LightningComponentBundle', filePath: '/ws/force-app/main/default/lwc/myCmp/myCmp.js-meta.xml' }
  ], [LWC]);
  assert.deepStrictEqual([...self.orgMembers.keys()], ['LightningComponentBundle:myCmp']);
  assert.strictEqual(self.posts.length, 1);
});

check('deploy: row no local item accounts for is dropped (shape drift ≠ membership)', () => {
  const self = fake([], ORG, [CLS]);
  deploy(self, [{ fullName: 'ghost/ghost.js', componentType: 'LightningComponentBundle', filePath: '/elsewhere/ghost.js' }], [CLS]);
  assert.strictEqual(self.orgMembers.size, 0);
  assert.strictEqual(self.posts.length, 0);
});

check('deploy: membership of ANOTHER org left untouched', () => {
  const self = fake([], 'acme-other-user', [CLS]);
  deploy(self, [{ fullName: 'OrderService', componentType: 'ApexClass' }], [CLS]);
  assert.strictEqual(self.orgMembers.size, 0);
  assert.strictEqual(self.posts.length, 0);
});

// ------------------------------------------------------- confirmOnOrg (retrieve)
check('retrieve: new component-keyed row added and re-posted once', () => {
  const self = fake(['ApexClass:Existing'], ORG);
  retrieve(self, [{ fullName: 'OrderService', type: 'ApexClass' }]);
  assert.strictEqual(self.orgMembers.has('ApexClass:OrderService'), true);
  assert.deepStrictEqual(
    self.posts[0].orgItems.map(i => `${i.type}:${i.name}`).sort(),
    ['ApexClass:Existing', 'ApexClass:OrderService']
  );
});

check('retrieve: already-known keys → no post, no re-render churn', () => {
  const self = fake(['ApexClass:OrderService'], ORG);
  retrieve(self, [{ fullName: 'OrderService', type: 'ApexClass' }]);
  assert.strictEqual(self.posts.length, 0);
});

check('retrieve: never-fetched membership (orgMembersOrg undefined) left untouched', () => {
  const self = fake([], undefined);
  retrieve(self, [{ fullName: 'OrderService', type: 'ApexClass' }]);
  assert.strictEqual(self.orgMembers.size, 0);
  assert.strictEqual(self.posts.length, 0);
});

check('retrieve: argv-hostile / malformed types rejected by the charset vet', () => {
  const self = fake([], ORG);
  retrieve(self, [
    { fullName: 'X', type: '--target-org' },
    { fullName: 'X', type: 'ApexClass', componentType: '--tests' },
    { fullName: 'X', type: 'Apex Class' },
    { fullName: 'X', type: 'Apex:Class' },
    { fullName: 'X', type: '../../../../etc/passwd' },
    { fullName: 'X', type: '?' },
    { fullName: 'X', componentType: '' },
    { fullName: 'X' }
  ]);
  assert.strictEqual(self.orgMembers.size, 0);
  assert.strictEqual(self.posts.length, 0);
});

check('retrieve: junk names rejected (package.xml pseudo-row, wildcard, empty)', () => {
  const self = fake([], ORG);
  retrieve(self, [
    { fullName: 'package.xml', type: 'Package' },
    { fullName: '*', type: 'ApexClass' },
    { fullName: 'Order*', type: 'ApexClass' },
    { fullName: '', type: 'ApexClass' }
  ]);
  assert.strictEqual(self.orgMembers.size, 0);
  assert.strictEqual(self.posts.length, 0);
});

check('retrieve: legal exotic names kept (folders, dots, spaces); componentType wins', () => {
  const self = fake([], ORG);
  retrieve(self, [
    { fullName: 'unfiled$public/AcmeReport', type: 'Report' },
    { fullName: 'Widget__c.Size__c', type: 'CustomField' },
    { fullName: 'Widget__c-Widget Layout', type: 'Layout' },
    { fullName: 'OrderService', type: 'containerFile', componentType: 'ApexClass' }
  ]);
  assert.deepStrictEqual([...self.orgMembers.keys()].sort(), [
    'ApexClass:OrderService',
    'CustomField:Widget__c.Size__c',
    'Layout:Widget__c-Widget Layout',
    'Report:unfiled$public/AcmeReport'
  ]);
});

check('dotted/foldered names survive the key round-trip (split on first colon)', () => {
  const self = fake([], ORG);
  retrieve(self, [{ fullName: 'Widget__c.Size__c', type: 'CustomField' }]);
  assert.deepStrictEqual(self.posts[0].orgItems, [{ type: 'CustomField', name: 'Widget__c.Size__c' }]);
});

// ------------------------------------------------------------------- source pins
// The row-source discipline lives at the call sites — pin it so a future edit
// can't quietly feed request keys or drop the validateOnly gate.
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'panelProvider.ts'), 'utf8');

check('source: deploy confirm is validateOnly-gated and feeds result successes', () => {
  assert.ok(src.includes('if (!validateOnly) this.confirmDeployedOnOrg(successes, items, org, orgLabel);'));
});

check('source: quick deploy feeds deploySuccessRows(result), scanner-only mapping', () => {
  assert.ok(src.includes('this.confirmDeployedOnOrg(deploySuccessRows(result), [], org, orgLabel);'));
});

check('source: both retrieve sites feed org `ok` rows; no other confirm call sites', () => {
  assert.strictEqual((src.match(/this\.confirmOnOrg\(ok, org, orgLabel\);/g) || []).length, 2);
  assert.strictEqual((src.match(/this\.confirmOnOrg\(/g) || []).length, 2);
  assert.strictEqual((src.match(/this\.confirmDeployedOnOrg\(/g) || []).length, 2);
});

if (failed > 0) { console.error(`${failed}/${ran} checks FAILED`); process.exit(1); }
console.log(`org-membership: all ${ran} checks passed`);
