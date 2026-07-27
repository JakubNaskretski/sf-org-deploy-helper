// Fails the build on a let/const that shadows another let/const in an enclosing
// block of the SAME function.   node scripts/check-no-shadow.cjs
//
// Why this exists: a duplicated `let detection` inside an inner try block once
// made runDeploy's terminal callback write the inner binding while the return
// read the outer one — so every failed deploy reported success and the
// auto-resolve loop never ran. `tsc` cannot catch that: shadowing is legal and
// both bindings are "used". Uses the TypeScript compiler API that is already a
// devDependency — no eslint, no new packages.
const path = require('path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
const files = ['depGraph.ts', 'extension.ts', 'metadataScanner.ts', 'orgStore.ts', 'panelHtml.ts', 'panelProvider.ts', 'sfCliService.ts', 'suggestionLog.ts']
  .map(f => path.join(ROOT, 'src', f));

const violations = [];

for (const file of files) {
  const text = require('fs').readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2020, true);
  const line = pos => sf.getLineAndCharacterOfPosition(pos).line + 1;

  // One frame per block; `fnBoundary` marks where a new function starts, because
  // reusing a name inside a nested function is normal and not what bit us.
  const walk = (node, scopes) => {
    const opensBlock = ts.isBlock(node) || ts.isSourceFile(node) || ts.isCaseBlock(node)
      || ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node);
    const opensFn = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
      || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
      || ts.isGetAccessor(node) || ts.isSetAccessor(node);

    let next = scopes;
    if (opensFn) next = [{ names: new Map(), fnBoundary: true }];
    else if (opensBlock) next = scopes.concat([{ names: new Map(), fnBoundary: false }]);

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const declList = node.parent;
      // `var` is function-scoped; only let/const produce the silent-shadow trap.
      const isBlockScoped = ts.isVariableDeclarationList(declList)
        && (declList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
      if (isBlockScoped) {
        const name = node.name.text;
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].names.has(name)) {
            violations.push(`${path.relative(ROOT, file)}:${line(node.name.pos)} — '${name}' shadows the one declared at line ${next[i].names.get(name)}`);
            break;
          }
          if (next[i].fnBoundary) break; // stop at the function boundary
        }
        next[next.length - 1].names.set(name, line(node.name.pos));
      }
    }

    node.forEachChild(c => walk(c, next));
  };
  walk(sf, [{ names: new Map(), fnBoundary: true }]);
}

if (violations.length) {
  console.error('Shadowed block-scoped declarations (a write can silently land on the wrong binding):');
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`no-shadow: clean (${files.length} source files)`);
