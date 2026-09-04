// Runnable contract test: every command in package.json `contributes.commands`
// is registered in src/extension.ts, and vice versa — plus the three
// webview-only actions that gained palette/context parity (loginOrg, openInOrg,
// deleteFromOrg) reach the SAME provider methods the webview messages use.
// No framework.   1) npm run compile   2) node scripts/check-command-parity.cjs
//
// Why: loginOrg / openInOrg / deleteFromOrg were reachable only by clicking a
// button inside the webview — no command palette entry, no context-menu entry —
// so a user without the sidebar open (or who prefers the palette/right-click,
// like every other action here) had no way to reach them. This is a plain
// static/source pin (regex over package.json + extension.ts + panelProvider.ts):
// it can't drive the real VS Code command registry, but it can guarantee the
// manifest and the wiring never drift apart again, and that the new commands
// dispatch to the exact same handler names the webview's 'loginOrg' /
// 'openInOrg' / 'deleteFromOrg' message cases call.
const path = require('path');
const fs = require('fs');
const assert = require('assert');

let failed = 0;
let ran = 0;
function check(name, fn) {
  ran++;
  try { fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const extSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
const providerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'panelProvider.ts'), 'utf8');

const manifestIds = pkg.contributes.commands.map(c => c.command);
// Every `registerSafe('id', ...)` call in extension.ts.
const registeredIds = [...extSrc.matchAll(/registerSafe\('([^']+)'/g)].map(m => m[1]);

check('every manifest command id is registered in extension.ts', () => {
  const missing = manifestIds.filter(id => !registeredIds.includes(id));
  assert.deepStrictEqual(missing, [], `declared in package.json but never registered: ${missing.join(', ')}`);
});

check('every registered command id is declared in the manifest', () => {
  const missing = registeredIds.filter(id => !manifestIds.includes(id));
  assert.deepStrictEqual(missing, [], `registered in extension.ts but missing from package.json contributes.commands: ${missing.join(', ')}`);
});

check('no duplicate ids on either side', () => {
  assert.strictEqual(new Set(manifestIds).size, manifestIds.length, 'duplicate command id in package.json');
  assert.strictEqual(new Set(registeredIds).size, registeredIds.length, 'duplicate registerSafe(...) call in extension.ts');
});

check('the three new commands are declared with the expected titles', () => {
  const byId = Object.fromEntries(pkg.contributes.commands.map(c => [c.command, c.title]));
  assert.strictEqual(byId['sfOrgDeployWrapper.loginOrg'], 'SF Deploy: Add Org (login)');
  assert.strictEqual(byId['sfOrgDeployWrapper.openInOrg'], 'SF Deploy: Open in Org');
  assert.strictEqual(byId['sfOrgDeployWrapper.deleteFromOrg'], 'SF Deploy: Delete from Org');
});

const FILE_WHEN = "resourceExtname =~ /\\.(cls|trigger|page|component|resource|email)$/ || resourceFilename =~ /-meta\\.xml$/ || resourcePath =~ /[\\\\/](lwc|aura)[\\\\/]/";
check('openInOrg and deleteFromOrg carry the SAME context-menu `when` as diffFile, in both menus', () => {
  const diffFileWhens = pkg.contributes.menus['explorer/context']
    .concat(pkg.contributes.menus['editor/context'])
    .filter(m => m.command === 'sfOrgDeployWrapper.diffFile')
    .map(m => m.when);
  assert.ok(diffFileWhens.length > 0 && diffFileWhens.every(w => w === FILE_WHEN), 'diffFile when changed — update FILE_WHEN above');
  for (const menuName of ['explorer/context', 'editor/context']) {
    for (const id of ['sfOrgDeployWrapper.openInOrg', 'sfOrgDeployWrapper.deleteFromOrg']) {
      const entry = pkg.contributes.menus[menuName].find(m => m.command === id);
      assert.ok(entry, `${id} missing from ${menuName}`);
      assert.strictEqual(entry.when, FILE_WHEN, `${id} in ${menuName} has a different when than diffFile`);
    }
  }
});

check('loginOrg has no context-menu entry — it is not file-scoped', () => {
  for (const menuName of ['explorer/context', 'editor/context']) {
    assert.ok(!pkg.contributes.menus[menuName].some(m => m.command === 'sfOrgDeployWrapper.loginOrg'), `loginOrg unexpectedly in ${menuName}`);
  }
});

// ---- source pins: the three new commands reach the SAME handlers the webview uses

check('loginOrg: command → provider.loginOrg() → the same runLogin() the webview \'loginOrg\' message calls', () => {
  assert.ok(/registerSafe\('sfOrgDeployWrapper\.loginOrg', \(\) => provider\.loginOrg\(\)\)/.test(extSrc), 'extension.ts wiring not found');
  assert.ok(/async loginOrg\(\): Promise<void> \{ return this\.runLogin\(\); \}/.test(providerSrc), 'provider.loginOrg must delegate to runLogin()');
  assert.ok(/case 'loginOrg':\n\s*await this\.runLogin\(\);/.test(providerSrc), 'the webview message case must call the same runLogin()');
});

check('openInOrg: command resolves the clicked file like diffFile, then calls openComponentInOrg — same as the webview message', () => {
  assert.ok(/registerSafe\('sfOrgDeployWrapper\.openInOrg', \(uri\?: vscode\.Uri\) => provider\.openInOrg\(uri \?\? vscode\.window\.activeTextEditor\?\.document\.uri as vscode\.Uri\)\)/.test(extSrc), 'extension.ts wiring not found');
  assert.ok(/async openInOrg\(uri: vscode\.Uri\): Promise<void> \{ return this\.runByUri\(uri, 'openInOrg'\); \}/.test(providerSrc), 'provider.openInOrg must delegate to runByUri(uri, \'openInOrg\')');
  assert.ok(/if \(action === 'openInOrg'\) return this\.openComponentInOrg\(key\);/.test(providerSrc), 'runByUri must resolve the item then call openComponentInOrg — the same method the webview message uses');
  assert.ok(/case 'openInOrg':\n\s*await this\.openComponentInOrg\(msg\.keys\?\.\[0\]\);/.test(providerSrc), 'the webview message case must call the same openComponentInOrg');
});

check('deleteFromOrg: command resolves the clicked file like diffFile, then calls runDelete — same PROD guard/confirm as the webview message', () => {
  assert.ok(/registerSafe\('sfOrgDeployWrapper\.deleteFromOrg', \(uri\?: vscode\.Uri\) => provider\.deleteFromOrg\(uri \?\? vscode\.window\.activeTextEditor\?\.document\.uri as vscode\.Uri\)\)/.test(extSrc), 'extension.ts wiring not found');
  assert.ok(/async deleteFromOrg\(uri: vscode\.Uri\): Promise<void> \{ return this\.runByUri\(uri, 'delete'\); \}/.test(providerSrc), 'provider.deleteFromOrg must delegate to runByUri(uri, \'delete\')');
  assert.ok(/if \(action === 'delete'\) return this\.runDelete\(\[key\]\);/.test(providerSrc), 'runByUri must resolve the item then call runDelete — the same method the webview message uses');
  assert.ok(/case 'deleteFromOrg':\n\s*await this\.runDelete\(msg\.keys\);/.test(providerSrc), 'the webview message case must call the same runDelete');
});

check('runByUri\'s action union grew, but deploy/retrieve/diff wiring is untouched', () => {
  assert.ok(/action: 'deploy' \| 'retrieve' \| 'diff' \| 'openInOrg' \| 'delete'/.test(providerSrc), 'runByUri action union must list all five verbs');
  assert.ok(/if \(action === 'deploy'\) \{ await this\.runDeploy\(\[key\], \{ sourceDir \}\); return; \}/.test(providerSrc));
  assert.ok(/if \(action === 'retrieve'\) return this\.runRetrieve\(\[key\], \{ sourceDir \}\);/.test(providerSrc));
});

check('every id in package.json "check" is a file that actually exists (sanity on the harness list itself)', () => {
  const scripts = [...pkg.scripts.check.matchAll(/node \.\/scripts\/([\w-]+\.cjs)/g)].map(m => m[1]);
  assert.ok(scripts.includes('check-command-parity.cjs'), 'this harness must be registered in package.json "check"');
  for (const s of scripts) assert.ok(fs.existsSync(path.join(__dirname, s)), `missing script: ${s}`);
});

if (failed) { console.error(`command-parity: ${failed}/${ran} checks FAILED`); process.exit(1); }
console.log(`command-parity: all ${ran} checks passed`);
