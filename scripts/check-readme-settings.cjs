// Runnable contract test: every `sfOrgDeployWrapper.*` setting declared in
// package.json is documented in README.md.   No framework.
//   1) npm run compile   2) node scripts/check-readme-settings.cjs
//
// The README's Settings section used to hand-list a handful of settings and
// silently fall behind as new ones shipped (12 declared, 3 documented at the
// time this check was added) — a setting a user could set in settings.json but
// never learn existed from the README. This does not check WORDING, only that
// each key is named at all, so it can't go stale the way a full-text pin would.
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
const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
const props = pkg.contributes.configuration.properties;
const keys = Object.keys(props).filter(k => k.startsWith('sfOrgDeployWrapper.'));

check('at least one sfOrgDeployWrapper.* setting is declared (the list below isn\'t vacuously true)', () => {
  assert.ok(keys.length > 0);
});

for (const key of keys) {
  check(`README documents \`${key}\``, () => {
    assert.ok(readme.includes(`\`${key}\``), `${key} is declared in package.json but not mentioned (as \`${key}\`) in README.md`);
  });
}

// The other direction: a setting that was REMOVED (0.31.1 dropped
// contextScope for the companion picker) must leave no README row and no
// reader in the code — a README promising a knob that does nothing, or code
// quietly reading an undeclared key, is the same drift turned around.
check('README names no `sfOrgDeployWrapper.*` setting that package.json does not declare', () => {
  const named = [...new Set([...readme.matchAll(/`(sfOrgDeployWrapper\.[A-Za-z]+)`/g)].map(m => m[1]))];
  assert.ok(named.length >= keys.length, `README names ${named.length} settings, ${keys.length} declared`);
  assert.deepStrictEqual(named.filter(k => !(k in props)), []);
});

check('every setting the code reads (`.get<T>(\'name\'`) is declared in package.json', () => {
  const srcDir = path.join(__dirname, '..', 'src');
  const src = fs.readdirSync(srcDir).filter(f => f.endsWith('.ts')).map(f => fs.readFileSync(path.join(srcDir, f), 'utf8')).join('\n');
  const read = [...new Set([...src.matchAll(/\.get<[^>]+>\('([A-Za-z]+)'/g)].map(m => `sfOrgDeployWrapper.${m[1]}`))];
  assert.ok(read.length >= 15, `only ${read.length} setting reads found — the pattern no longer matches the code`);
  assert.deepStrictEqual(read.filter(k => !(k in props)), []);
});

check('this harness is registered in package.json "check"', () => {
  assert.ok(pkg.scripts.check.includes('node ./scripts/check-readme-settings.cjs'));
});

if (failed) { console.error(`readme-settings: ${failed}/${ran} checks FAILED`); process.exit(1); }
console.log(`readme-settings: all ${ran} checks passed`);
