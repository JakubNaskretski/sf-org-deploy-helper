// Runnable contract test for the Changed view's commit sections (gitChanges.ts +
// panelProvider.changedComponentKeys). No framework.
//   1) npm run compile   2) node scripts/check-changed-commits.cjs
//
// The lens used to answer one question — "what is uncommitted?" — so a commit
// emptied it and the components you had just been working on were gone. It now
// answers "what has this branch done", split into sections: the uncommitted
// edits, then one per commit. Contract:
//   1. the argv. With a base ref, `<ref>..HEAD`. Without one (the `auto`
//      default), the commits NO other branch has: HEAD --not <every branch but
//      this one>. That is what makes it branch-flow agnostic (main, devInt,
//      develop — never named) and push-proof (the branch's own remote ref is
//      excluded), and the --exclude globs must precede the --branches/--remotes
//      they narrow, or the range collapses to empty;
//   2. the parse. NUL-separated paths (so spaces and non-ASCII survive), the
//      first parent (the diff base), merge commits with no files, and junk
//      skipped rather than thrown;
//   3. the base. The parent of the OLDEST listed commit, so the diff covers
//      exactly the commits shown plus the uncommitted edits — the empty tree for
//      a root commit, nothing at all when there are no commits;
//   4. the payload. keys = the union the lens lists; `uncommitted` and `commits`
//      split it; a commit that touched no component contributes no section; a
//      key reached only through a commit still enters the union (the section
//      listing it must be able to draw it);
//   5. degradation. git failing anywhere costs the SECTIONS, never the lens: an
//      auto base that won't diff falls back to the uncommitted answer, while an
//      explicitly configured ref that won't diff is named (a wrong ref must not
//      read as "nothing changed"), and a flag-shaped ref never reaches argv;
//   6. the empty setting still means uncommitted-only, with no git spawned at all.
const path = require('path');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const Module = require('module');
// The REAL child_process, captured before the stub below replaces it: section 7
// runs the argv against git itself, because git is the only authority on what
// these options mean (the first version of this file asserted a plausible
// --exclude spelling that git silently matches against nothing).
const realExecFileSync = require('child_process').execFileSync;

const ROOT = path.join(__dirname, '..');

// --------------------------------------------------------------- module stubs
let config = { changedBaseRef: 'auto' };
// Mirrors ConfigurationScope: a value set at Workspace scope shadows a User write.
let workspaceScoped = false;
const updates = [];
let quickPick = { pick: async () => undefined, input: async () => undefined, items: null, inputOpts: null };
const vscodeStub = {
  extensions: { getExtension: (id) => (id === 'vscode.git' && git ? { isActive: true, exports: { getAPI: () => git } } : undefined) },
  workspace: {
    getConfiguration: () => ({
      get: (k, d) => (k in config ? config[k] : d),
      inspect: (k) => ({ workspaceValue: workspaceScoped ? config[k] : undefined }),
      update: (k, v, target) => { updates.push([k, v, target]); return Promise.resolve(); }
    })
  },
  window: {
    showQuickPick: async (items, opts) => { quickPick.items = items; return quickPick.pick(items, opts); },
    showInputBox: async (opts) => { quickPick.inputOpts = opts; return quickPick.input(opts); }
  },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  QuickPickItemKind: { Separator: -1 },
  Uri: { file: fsPath => ({ fsPath, scheme: 'file' }) }
};
// The provider spawns `git` through execFile; record every run and answer it.
let gitRuns = [];
let gitAnswer = () => '';
const cpStub = {
  execFile: (bin, args, opts, cb) => {
    gitRuns.push({ bin, args, cwd: opts && opts.cwd });
    let out;
    try { out = gitAnswer(args, opts); } catch (err) { setImmediate(() => cb(err)); return; }
    setImmediate(() => cb(null, out));
  },
  spawn: () => { throw new Error('not stubbed'); },
  execFileSync: () => { throw new Error('not stubbed'); }
};
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? vscodeStub : req === 'child_process' ? cpStub : origLoad(req, ...rest));

const { COMMIT_CAP, MAX_BRANCH_COMMITS, baseFromBoundary, boundaryArgs, commitLogArgs, parseBoundary, parseCommitLog } = require(path.join(ROOT, 'out', 'gitChanges.js'));
const { DeployPanelProvider } = require(path.join(ROOT, 'out', 'panelProvider.js'));
const proto = DeployPanelProvider.prototype;

let failed = 0;
let ran = 0;
const queue = [];
const check = (name, fn) => queue.push([name, fn]);

// ------------------------------------------------------------------ fixtures
const RS = '\x1e';
const FS = '\x1f';
/** One commit's worth of `git log --format=… --name-only -z` output. */
// Shape git actually emits: the format line is NUL-terminated, then a newline,
// then each path NUL-terminated (a merge commit stops after the NUL).
// The identity git reports for this repository's own commits, and what the
// fixtures author their commits as.
const MINE = 'me';
const logged = (hash, ct, subject, files, who = MINE, name = 'Me') =>
  `${RS}${hash}${FS}${ct}${FS}${name}${FS}${who}${FS}${subject}\0`
  + (files.length ? '\n' + files.map(f => f + '\0').join('') : '');

const WS = '/ws';
const CLASSES = 'force-app/main/default/classes';
const cls = (name) => ({
  type: 'ApexClass', name,
  filePath: `${WS}/${CLASSES}/${name}.cls`,
  files: [`${WS}/${CLASSES}/${name}.cls`, `${WS}/${CLASSES}/${name}.cls-meta.xml`]
});
const BUNDLE = {
  type: 'LightningComponentBundle', name: 'acmeCard',
  filePath: `${WS}/force-app/main/default/lwc/acmeCard`,
  files: [`${WS}/force-app/main/default/lwc/acmeCard/acmeCard.js`]
};
const ITEMS = [cls('AcmeA'), cls('AcmeB'), cls('AcmeC'), BUNDLE];

let git; // the vscode.git API stub
// The real API always carries the binary's absolute path; the provider refuses to
// spawn a bare 'git' (a planted git.exe in an untrusted repo's cwd would win on
// Windows), so every stub has one.
const GIT_BIN = { path: '/usr/bin/git' };
function repo(opts = {}) {
  return {
    rootUri: opts.root === null ? undefined : { fsPath: opts.root || WS },
    state: {
      workingTreeChanges: (opts.working || []).map(p => ({ uri: { fsPath: p } })),
      indexChanges: (opts.index || []).map(p => ({ uri: { fsPath: p } })),
      onDidChange: () => ({ dispose() {} }),
      HEAD: opts.branch === null ? undefined : { name: opts.branch || 'feature/acme' },
      refs: opts.refs
    },
    diffWith: opts.diffWith || (async () => (opts.diff || []).map(p => ({ uri: { fsPath: p } }))),
    status: async () => {}
  };
}
function provider(items = ITEMS) {
  const posted = [];
  const log = [];
  const s = Object.create(proto);
  Object.assign(s, { items, output: { appendLine: (l) => log.push(l) }, post: (m) => posted.push(m) });
  return { s, posted, log, last: () => posted[posted.length - 1] };
}
const sections = (msg) => (msg.commits || []).map(c => [c.short, c.keys.slice().sort()]);
/** Answer both calls the auto comparison makes: the boundary query (hashes, the
 *  last one prefixed '-') and the commit listing. `log` may be a function of the
 *  repository's cwd. */
const gitScript = (log, boundary = ['x'.repeat(40), '-' + 'f'.repeat(40)].join('\n'), identity = MINE) =>
  (args, opts) => {
    if (args[0] === 'config') {
      if (identity === null) throw new Error('no user.email configured');
      return identity + '\n';
    }
    if (args[0] === 'rev-list') return typeof boundary === 'function' ? boundary(opts) : boundary;
    return typeof log === 'function' ? log(opts) : log;
  };

// ------------------------------------------------------------------ 1) argv
check('an explicit base ref asks for the commits that ref does not have', () => {
  const args = commitLogArgs({ baseRef: 'origin/devInt', branch: 'feature/acme' });
  assert.ok(args.includes('origin/devInt..HEAD'), 'range');
  assert.ok(!args.includes('--not'), 'a range needs no exclusions');
  assert.ok(!args.some(a => a.startsWith('--exclude')), 'no exclusions either');
});

check('auto asks for the commits no OTHER branch has, excluding this one by name', () => {
  const args = commitLogArgs({ branch: 'feature/acme' });
  const tail = args.slice(args.indexOf('HEAD'));
  assert.deepStrictEqual(tail, [
    'HEAD', '--not',
    '--exclude=feature/acme', '--branches',
    '--exclude=*/feature/acme', '--remotes'
  ], 'each --exclude must precede the option it narrows, and drops the refs/ prefix git strips');
});

check('a detached HEAD excludes nothing, and the cap is the commit count', () => {
  const args = commitLogArgs({ branch: undefined });
  assert.ok(!args.some(a => a.startsWith('--exclude')));
  assert.ok(args.includes('--branches') && args.includes('--remotes'));
  assert.deepStrictEqual(args.slice(args.indexOf('-n'), args.indexOf('-n') + 2), ['-n', String(COMMIT_CAP)]);
  const capped = commitLogArgs({ cap: 3 });
  assert.deepStrictEqual(capped.slice(capped.indexOf('-n'), capped.indexOf('-n') + 2), ['-n', '3']);
});

check('the format is NUL-separated and machine-readable', () => {
  const args = commitLogArgs({});
  assert.ok(args.includes('-z'), 'paths must be NUL-separated, never quoted');
  assert.ok(args.includes('--name-only'));
  assert.ok(args.some(a => a.startsWith('--format=') && a.includes('%H') && a.includes('%ct') && a.includes('%s')));
  assert.ok(args.includes('--no-show-signature'), 'log.showSignature=true would otherwise inject gpg output into the stream');
});

// ----------------------------------------------------------------- 2) parsing
check('a commit list parses to hash, short, time, subject and files', () => {
  const out = logged('a'.repeat(40), '1700000002', 'fix the thing', ['a/One.cls', 'a/Two.cls'])
    + logged('c'.repeat(40), '1700000001', 'first', ['a/One.cls']);
  const commits = parseCommitLog(out);
  assert.strictEqual(commits.length, 2);
  assert.strictEqual(commits[0].hash, 'a'.repeat(40));
  assert.strictEqual(commits[0].short, 'aaaaaaa');
  assert.strictEqual(commits[0].when, 1700000002);
  assert.strictEqual(commits[0].subject, 'fix the thing');
  assert.strictEqual(commits[0].author, 'Me');
  assert.strictEqual(commits[0].email, MINE);
  assert.deepStrictEqual(commits[0].files, ['a/One.cls', 'a/Two.cls'], 'the newline after the format line is not part of a path');
  assert.deepStrictEqual(commits[1].files, ['a/One.cls']);
});

check('a path with spaces survives, and a merge commit reports no files of its own', () => {
  const out = logged('e'.repeat(40), '3', 'Merge branch devInt', [])
    + logged('1'.repeat(40), '2', 'add reports', ['force-app/My Folder/Thing.cls']);
  const commits = parseCommitLog(out);
  assert.deepStrictEqual(commits[0].files, [], 'a merge lists no files without -m');
  assert.deepStrictEqual(commits[1].files, ['force-app/My Folder/Thing.cls']);
});

check('junk is skipped, not thrown', () => {
  assert.deepStrictEqual(parseCommitLog(''), []);
  assert.deepStrictEqual(parseCommitLog('not a commit at all'), []);
  const mixed = `${RS}zzz${FS}1${FS}bad hash\n` + logged('b'.repeat(40), '5', 'root', ['x.cls']);
  const commits = parseCommitLog(mixed);
  assert.strictEqual(commits.length, 1);
  assert.strictEqual(commits[0].subject, 'root');
});

// -------------------------------------------------------------- 3) the base
check('the boundary query is hashes only, the same range, capped ONE past the limit', () => {
  const args = boundaryArgs({ branch: 'feature/acme' });
  assert.deepStrictEqual(args.slice(0, 2), ['rev-list', '--boundary']);
  assert.ok(!args.includes('--name-only'), 'file lists would make this expensive');
  // One past: a walk that STOPS at the cap prints a boundary of its own (see the
  // live-git check below), so the count reaching the cap is the signal to discard
  // the answer — capping AT the limit would make a legal 100-commit branch
  // indistinguishable from a truncated one.
  assert.deepStrictEqual(args.slice(2, 4), ['-n', String(MAX_BRANCH_COMMITS + 1)]);
  assert.deepStrictEqual(args.slice(4), commitLogArgs({ branch: 'feature/acme' }).slice(-6), 'the same range as the listing');
  assert.deepStrictEqual(boundaryArgs({ baseRef: 'main' }).slice(4), ['main..HEAD']);
});

check('the diff base is where the branch joins the rest of the repository', () => {
  const b = parseBoundary(['a'.repeat(40), 'c'.repeat(40), '-' + 'f'.repeat(40), ''].join('\n'));
  assert.deepStrictEqual(b, { count: 2, base: 'f'.repeat(40) });
  assert.deepStrictEqual(baseFromBoundary(b), { base: 'f'.repeat(40) });
});

check('nothing committed, a trunk-only checkout and an over-long branch are told apart', () => {
  // Nothing of this branch's own: no base, but nothing went wrong either.
  assert.deepStrictEqual(baseFromBoundary(parseBoundary('')), { base: undefined });
  // A trunk-only checkout: commits, but no boundary — the range runs to the root.
  assert.deepStrictEqual(
    baseFromBoundary(parseBoundary(['a'.repeat(40), 'b'.repeat(40)].join('\n'))),
    { giveUp: 'whole-history' });
  // At the limit the walk still completed, so the boundary is the real one.
  assert.deepStrictEqual(baseFromBoundary({ count: MAX_BRANCH_COMMITS, base: 'f'.repeat(40) }), { base: 'f'.repeat(40) });
  assert.deepStrictEqual(baseFromBoundary({ count: MAX_BRANCH_COMMITS + 1, base: 'f'.repeat(40) }), { giveUp: 'too-long' });
});

// ----------------------------------------------------------- 4) the payload
const A_CLS = `${WS}/${CLASSES}/AcmeA.cls`;
const B_CLS = `${WS}/${CLASSES}/AcmeB.cls`;
const REL = (name) => `${CLASSES}/${name}.cls`;

check('auto: uncommitted edits and one section per commit, over the union of both', async () => {
  config = { changedBaseRef: 'auto' };
  gitRuns = [];
  gitAnswer = gitScript(logged('a'.repeat(40), '200', 'B and the card', [REL('AcmeB'), 'force-app/main/default/lwc/acmeCard/acmeCard.js'])
    + logged('c'.repeat(40), '100', 'C', [REL('AcmeC')]));
  git = { repositories: [repo({ working: [A_CLS], diff: [B_CLS, `${WS}/${CLASSES}/AcmeC.cls`] })], onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN };
  const p = provider();
  await p.s.postChangedComponents();
  const msg = p.last();
  assert.strictEqual(msg.type, 'changed');
  assert.strictEqual(msg.auto, true, 'the view says which comparison it is showing');
  assert.strictEqual(msg.base, undefined, 'an auto base is an internal commit id, not a ref to display');
  assert.deepStrictEqual(msg.uncommitted, ['ApexClass:AcmeA']);
  assert.deepStrictEqual(sections(msg), [
    ['aaaaaaa', ['ApexClass:AcmeB', 'LightningComponentBundle:acmeCard']],
    ['ccccccc', ['ApexClass:AcmeC']]
  ], 'newest first; a bundle is matched by its containing folder');
  assert.deepStrictEqual(msg.keys.slice().sort(), ['ApexClass:AcmeA', 'ApexClass:AcmeB', 'ApexClass:AcmeC', 'LightningComponentBundle:acmeCard']);
  assert.strictEqual(gitRuns[0].bin, '/usr/bin/git', 'the binary vscode.git itself uses');
  assert.strictEqual(gitRuns[0].cwd, WS, 'run in the repository root');
});

check('a commit that touched no component contributes no section', async () => {
  config = { changedBaseRef: 'auto' };
  gitAnswer = gitScript(logged('a'.repeat(40), '200', 'docs: readme', ['README.md', '.github/workflows/ci.yml'])
    + logged('c'.repeat(40), '100', 'C', [REL('AcmeC')]));
  git = { repositories: [repo({ diff: [`${WS}/${CLASSES}/AcmeC.cls`] })], onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN };
  const p = provider();
  await p.s.postChangedComponents();
  assert.deepStrictEqual(sections(p.last()), [['ccccccc', ['ApexClass:AcmeC']]]);
});

check('a component reverted later still belongs to the commit that touched it', async () => {
  // The base diff no longer reports AcmeB (added, then reverted). The section
  // listing it has to be able to draw it, so the union carries it.
  config = { changedBaseRef: 'auto' };
  gitAnswer = gitScript(logged('a'.repeat(40), '200', 'add B', [REL('AcmeB')]));
  git = { repositories: [repo({ working: [A_CLS], diff: [] })], onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN };
  const p = provider();
  await p.s.postChangedComponents();
  assert.ok(p.last().keys.includes('ApexClass:AcmeB'));
  assert.deepStrictEqual(p.last().uncommitted, ['ApexClass:AcmeA']);
});

check('staged and unstaged edits to one component are one entry', async () => {
  config = { changedBaseRef: '' };
  git = { repositories: [repo({ working: [A_CLS], index: [A_CLS, `${WS}/${CLASSES}/AcmeA.cls-meta.xml`] })], onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN };
  const p = provider();
  await p.s.postChangedComponents();
  assert.deepStrictEqual(p.last().uncommitted, ['ApexClass:AcmeA']);
  assert.deepStrictEqual(p.last().keys, ['ApexClass:AcmeA']);
});

check('an explicit ref is the base, is named in the payload, and bounds the commit list', async () => {
  config = { changedBaseRef: 'origin/devInt' };
  gitRuns = [];
  gitAnswer = () => logged('a'.repeat(40), '200', 'B', [REL('AcmeB')]);
  let diffedWith;
  git = {
    repositories: [repo({ diffWith: async (ref) => { diffedWith = ref; return [{ uri: { fsPath: B_CLS } }]; } })],
    onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN
  };
  const p = provider();
  await p.s.postChangedComponents();
  assert.strictEqual(diffedWith, 'origin/devInt');
  assert.strictEqual(p.last().base, 'origin/devInt');
  assert.strictEqual(p.last().auto, undefined);
  assert.ok(gitRuns[0].args.includes('origin/devInt..HEAD'));
  assert.deepStrictEqual(sections(p.last()), [['aaaaaaa', ['ApexClass:AcmeB']]]);
});

check('the empty setting is uncommitted-only, and spawns no git at all', async () => {
  config = { changedBaseRef: '' };
  gitRuns = [];
  let diffed = false;
  git = { repositories: [repo({ working: [A_CLS], diffWith: async () => { diffed = true; return []; } })], onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN };
  const p = provider();
  await p.s.postChangedComponents();
  assert.deepStrictEqual(p.last().keys, ['ApexClass:AcmeA']);
  assert.deepStrictEqual(p.last().commits, []);
  assert.strictEqual(p.last().base, undefined);
  assert.strictEqual(p.last().auto, undefined);
  assert.strictEqual(gitRuns.length, 0, 'no commit listing');
  assert.strictEqual(diffed, false, 'and no ref diff');
});

// ------------------------------------------------------------ 5) degradation
check('an auto base that will not diff falls back to the uncommitted answer', async () => {
  config = { changedBaseRef: 'auto' };
  gitAnswer = gitScript(logged('a'.repeat(40), '200', 'B', [REL('AcmeB')]));
  git = {
    repositories: [repo({ working: [A_CLS], diffWith: async () => { throw new Error('bad object p…'); } })],
    onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN
  };
  const p = provider();
  await p.s.postChangedComponents();
  assert.strictEqual(p.last().keys === null, false, 'the lens still answers');
  assert.deepStrictEqual(p.last().uncommitted, ['ApexClass:AcmeA']);
  assert.ok(p.log.some(l => l.includes('diffWith')), 'and says why in the output channel');
});

check('an explicitly configured ref that will not diff is named, never shown as "no changes"', async () => {
  config = { changedBaseRef: 'origin/nope' };
  gitAnswer = () => '';
  git = {
    repositories: [repo({ working: [A_CLS], diffWith: async () => { throw new Error("unknown revision 'origin/nope'"); } })],
    onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN
  };
  const p = provider();
  await p.s.postChangedComponents();
  assert.strictEqual(p.last().keys, null);
  assert.ok(p.last().reason.includes('origin/nope'));
});

check('a flag-shaped ref never reaches argv', async () => {
  config = { changedBaseRef: '--upload-pack=sh' };
  gitRuns = [];
  git = { repositories: [repo({ working: [A_CLS] })], onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN };
  const p = provider();
  await p.s.postChangedComponents();
  assert.strictEqual(p.last().keys, null);
  assert.ok(p.last().reason.includes("can't start with '-'"));
  assert.strictEqual(gitRuns.length, 0);
});

check('git failing costs the sections, not the lens — at either call', async () => {
  config = { changedBaseRef: 'auto' };
  gitAnswer = () => { throw new Error('git not found'); };
  git = { repositories: [repo({ working: [A_CLS] })], onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN };
  const p = provider();
  await p.s.postChangedComponents();
  assert.deepStrictEqual(p.last().keys, ['ApexClass:AcmeA']);
  assert.deepStrictEqual(p.last().commits, []);
  assert.ok(p.log.some(l => l.includes('branch range failed')));
  // The range answers, the listing does not: the base is known but there is
  // nothing to section by, so the lens is the base diff alone.
  gitAnswer = gitScript(() => { throw new Error('boom'); });
  const q = provider();
  await q.s.postChangedComponents();
  assert.deepStrictEqual(q.last().commits, []);
  assert.ok(q.log.some(l => l.includes('commit list failed')));
});

check('a trunk-only checkout shows uncommitted changes only, and says why', async () => {
  // Nothing excludes anything (one branch, its own remote ref skipped), so the
  // range runs to the root: this is the project's history, not "my branch".
  config = { changedBaseRef: 'auto' };
  gitAnswer = gitScript(logged('a'.repeat(40), '200', 'c3', [REL('AcmeB')]), ['a'.repeat(40), 'b'.repeat(40)].join('\n'));
  let diffed = false;
  git = { repositories: [repo({ working: [A_CLS], diffWith: async () => { diffed = true; return []; } })], onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN };
  const p = provider();
  await p.s.postChangedComponents();
  assert.deepStrictEqual(p.last().keys, ['ApexClass:AcmeA'], 'every tracked file would otherwise read as changed');
  assert.deepStrictEqual(p.last().commits, []);
  assert.strictEqual(diffed, false, 'and no diff against the empty tree');
  assert.ok(p.log.some(l => l.includes('whole repository')));
  assert.ok(/whole repository/.test(p.last().note), 'the view has to say so too — the label would otherwise claim a comparison');
});

check('a range longer than a branch of work falls back, naming the setting', async () => {
  config = { changedBaseRef: 'auto' };
  const long = Array.from({ length: MAX_BRANCH_COMMITS + 1 }, (_, i) => String(i).padEnd(40, '0'));
  gitAnswer = gitScript(logged('a'.repeat(40), '200', 'x', [REL('AcmeB')]), [...long, '-' + 'f'.repeat(40)].join('\n'));
  git = { repositories: [repo({ working: [A_CLS] })], onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN };
  const p = provider();
  await p.s.postChangedComponents();
  assert.deepStrictEqual(p.last().keys, ['ApexClass:AcmeA']);
  assert.ok(p.log.some(l => l.includes('changedBaseRef')), 'the way out has to be discoverable');
  assert.ok(p.last().note.includes('changedBaseRef'), 'and discoverable in the view, not only the log');
});

check('a commit that is not yours is disclosed by name', async () => {
  // Standing ON a shared branch (rather than one cut from it) reads the team's
  // commits as "this branch" — the section has to say whose work it is, with
  // "Select all" one click from a deploy.
  config = { changedBaseRef: 'auto' };
  gitAnswer = gitScript(
    logged('a'.repeat(40), '200', 'their fix', [REL('AcmeB')], 'jane', 'Jane')
    + logged('c'.repeat(40), '100', 'my fix', [REL('AcmeC')]));
  git = { repositories: [repo({ diff: [B_CLS, `${WS}/${CLASSES}/AcmeC.cls`] })], onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN };
  const p = provider();
  await p.s.postChangedComponents();
  assert.deepStrictEqual(p.last().commits.map(c => [c.short, c.author]), [['aaaaaaa', 'Jane'], ['ccccccc', undefined]]);
  // The identity is read once per repository, not once per refresh.
  const configRuns = () => gitRuns.filter(r => r.args[0] === 'config').length;
  gitRuns = [];
  await p.s.postChangedComponents();
  assert.strictEqual(configRuns(), 0, 'cached for the session');
});

check('with no git identity configured, nothing is marked as someone else\'s', async () => {
  config = { changedBaseRef: 'auto' };
  gitAnswer = gitScript(logged('a'.repeat(40), '200', 'their fix', [REL('AcmeB')], 'jane', 'Jane'), undefined, null);
  git = { repositories: [repo({ diff: [B_CLS] })], onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN };
  const p = provider();
  await p.s.postChangedComponents();
  assert.strictEqual(p.last().commits[0].author, undefined, 'marking everything would be worse than marking nothing');
});

check('a slower refresh never posts over a newer one', async () => {
  config = { changedBaseRef: '' };
  git = { repositories: [repo({ working: [A_CLS] })], onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN };
  const p = provider();
  const first = p.s.postChangedComponents();
  const second = p.s.postChangedComponents();
  await Promise.all([first, second]);
  assert.strictEqual(p.posted.length, 1, 'two overlapping refreshes, one payload — the newer one');
});

check('without an absolute git path nothing is spawned, and the lens still answers', async () => {
  // Bare 'git' is refused on purpose: the cwd is a repository we did not write,
  // and Windows resolves a bare command name from the child's cwd first.
  config = { changedBaseRef: 'auto' };
  gitRuns = [];
  gitAnswer = gitScript(logged('a'.repeat(40), '200', 'B', [REL('AcmeB')]));
  git = { repositories: [repo({ working: [A_CLS] })], onDidOpenRepository: () => ({ dispose() {} }) };
  const p = provider();
  await p.s.postChangedComponents();
  assert.deepStrictEqual(p.last().keys, ['ApexClass:AcmeA']);
  assert.strictEqual(gitRuns.length, 0);
});

check('a repository whose root is unknown is skipped, not fatal', async () => {
  config = { changedBaseRef: 'auto' };
  gitRuns = [];
  gitAnswer = () => '';
  git = { repositories: [repo({ root: null, working: [A_CLS] })], onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN };
  const p = provider();
  await p.s.postChangedComponents();
  assert.deepStrictEqual(p.last().keys, ['ApexClass:AcmeA']);
  assert.strictEqual(gitRuns.length, 0, 'nothing to run it in');
});

check('no git extension, and no repositories, each say why', async () => {
  config = { changedBaseRef: 'auto' };
  git = undefined;
  const p = provider();
  await p.s.postChangedComponents();
  assert.strictEqual(p.last().keys, null);
  assert.ok(/git extension/i.test(p.last().reason));
  git = { repositories: [], onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN };
  const q = provider();
  await q.s.postChangedComponents();
  assert.strictEqual(q.last().keys, null);
  assert.ok(/not a git repository/i.test(q.last().reason));
});

check('sections from several repositories interleave by date and stay capped', async () => {
  config = { changedBaseRef: 'auto' };
  // Each repo reports COMMIT_CAP commits of its own; the payload keeps the
  // newest COMMIT_CAP across both.
  const many = (prefix, base, file) => {
    let out = '';
    for (let i = 0; i < COMMIT_CAP; i++) {
      out += logged((prefix + i).padEnd(40, '0'), String(base + i), `c${i}`, [file]);
    }
    return out;
  };
  gitAnswer = gitScript(opts => (opts.cwd === WS ? many('a', 1000, REL('AcmeA')) : many('b', 2000, REL('AcmeD'))));
  // The second repository's commits are repo-relative to ITS root: a component
  // there must resolve against /ws2, never against the first repository.
  const other = { type: 'ApexClass', name: 'AcmeD', filePath: `/ws2/${CLASSES}/AcmeD.cls`, files: [`/ws2/${CLASSES}/AcmeD.cls`] };
  git = {
    repositories: [repo({ diff: [A_CLS] }), repo({ root: '/ws2', diff: [] })],
    onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN
  };
  const p = provider([...ITEMS, other]);
  await p.s.postChangedComponents();
  const got = p.last().commits;
  assert.strictEqual(got.length, COMMIT_CAP, 'capped');
  assert.ok(got.every((c, i) => i === 0 || got[i - 1].when >= c.when), 'newest first');
  assert.strictEqual(got[0].when, 2000 + COMMIT_CAP - 1, 'the newest commit of either repository leads');
  assert.deepStrictEqual(got[0].keys, ['ApexClass:AcmeD'], 'and its paths resolved against its own root');
});

// ------------------------------------------------- 6) the header's base picker
check('picking "This branch" writes auto at user scope', async () => {
  config = { changedBaseRef: '' };
  updates.length = 0;
  git = { repositories: [repo({ refs: [{ name: 'main', type: 0 }, { name: 'origin/devInt', type: 1 }, { name: 'v1.0', type: 2 }] })], onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN };
  quickPick = { pick: async (items) => items.find(i => i.value === 'auto'), input: async () => undefined };
  const p = provider();
  await p.s.pickChangedBase();
  assert.deepStrictEqual(updates, [['changedBaseRef', 'auto', vscodeStub.ConfigurationTarget.Global]]);
  const labels = quickPick.items.filter(i => i.kind !== vscodeStub.QuickPickItemKind.Separator).map(i => i.label);
  assert.ok(labels.includes('main') && labels.includes('origin/devInt'), 'branches are offered');
  assert.ok(!labels.includes('v1.0'), 'tags are not — "Other ref…" covers them');
});

check('a workspace-scoped setting is written where it will be read', async () => {
  // A User write under a Workspace value changes nothing the user can see — the
  // picker would look inert.
  config = { changedBaseRef: 'main' };
  workspaceScoped = true;
  updates.length = 0;
  git = { repositories: [repo({})], onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN };
  quickPick = { pick: async (items) => items.find(i => i.value === 'auto'), input: async () => undefined };
  const p = provider();
  await p.s.pickChangedBase();
  assert.deepStrictEqual(updates, [['changedBaseRef', 'auto', vscodeStub.ConfigurationTarget.Workspace]]);
  workspaceScoped = false;
});

check('"Other ref…" takes a typed ref, and rejects a flag-shaped one', async () => {
  config = { changedBaseRef: 'auto' };
  updates.length = 0;
  git = { repositories: [repo({})], onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN };
  quickPick = { pick: async (items) => items.find(i => i.label === 'Other ref…'), input: async () => ' origin/release ' };
  const p = provider();
  await p.s.pickChangedBase();
  assert.deepStrictEqual(updates, [['changedBaseRef', 'origin/release', vscodeStub.ConfigurationTarget.Global]]);
  assert.strictEqual(quickPick.inputOpts.validateInput('-x'), "A git ref can't start with '-'.");
  assert.strictEqual(quickPick.inputOpts.validateInput('main'), undefined);
});

check('cancelling, or picking what is already set, writes nothing', async () => {
  config = { changedBaseRef: 'auto' };
  updates.length = 0;
  git = { repositories: [repo({})], onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN };
  quickPick = { pick: async () => undefined, input: async () => undefined };
  const p = provider();
  await p.s.pickChangedBase();
  quickPick = { pick: async (items) => items.find(i => i.value === 'auto'), input: async () => undefined };
  await p.s.pickChangedBase();
  quickPick = { pick: async (items) => items.find(i => i.label === 'Other ref…'), input: async () => undefined };
  await p.s.pickChangedBase();
  assert.deepStrictEqual(updates, []);
});

// -------------------------------------------- 7) the argv, against git itself
// Everything above pins the argv as a string. Only git can say whether that
// string means what the feature needs, so this builds a throwaway repository and
// asks it. No network, no fixtures — one init and four commits.
check('git agrees: the range is this branch\'s own commits, and a push does not empty it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfodw-git-'));
  const g = (...args) => realExecFileSync('git', [
    '-c', 'user.email=check', '-c', 'user.name=check',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args
  ], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = (file, msg) => { fs.writeFileSync(path.join(dir, file), msg); g('add', file); g('commit', '-m', msg); return g('rev-parse', 'HEAD').trim(); };
  const log = (opts) => parseCommitLog(g(...commitLogArgs(opts)));
  const base = (opts) => baseFromBoundary(parseBoundary(g(...boundaryArgs(opts)))).base;
  const boundary = (opts) => parseBoundary(g(...boundaryArgs(opts)));
  try {
    g('init', '-b', 'main');
    const first = commit('a.cls', 'on main');
    // A trunk-only checkout: nothing else exists to measure against, so the range
    // reaches the root and there is no base — the view stays uncommitted-only
    // rather than reporting every tracked file as changed.
    assert.strictEqual(base({ branch: 'main' }), undefined);
    g('update-ref', 'refs/remotes/origin/main', first);
    assert.strictEqual(base({ branch: 'main' }), undefined, 'the branch\'s own remote ref is not the other side');

    g('checkout', '-q', '-b', 'feature/acme');
    commit('b.cls', 'mine one');
    const mine2 = commit('c.cls', 'mine two');
    const ours = log({ branch: 'feature/acme' });
    assert.deepStrictEqual(ours.map(c => c.subject), ['mine two', 'mine one'], 'newest first, and main\'s commit is not mine');
    assert.deepStrictEqual(ours[0].files, ['c.cls']);
    assert.strictEqual(base({ branch: 'feature/acme' }), first, 'the diff base is where the branch left main');

    // Pushed: a remote-tracking ref for this very branch must not exclude it.
    g('update-ref', 'refs/remotes/origin/feature/acme', mine2);
    assert.deepStrictEqual(log({ branch: 'feature/acme' }).map(c => c.subject), ['mine two', 'mine one'], 'a push emptied the view');
    assert.strictEqual(base({ branch: 'feature/acme' }), first);

    // Merged elsewhere: once another branch carries them, they are no longer this
    // branch's own work and the view falls back to uncommitted-only.
    g('branch', 'devInt', mine2);
    assert.deepStrictEqual(log({ branch: 'feature/acme' }), []);
    assert.strictEqual(base({ branch: 'feature/acme' }), undefined);

    // The explicit-ref form is a plain range and answers regardless.
    assert.deepStrictEqual(log({ baseRef: 'main', branch: 'feature/acme' }).map(c => c.subject), ['mine two', 'mine one']);

    // A merge commit lists no files but still carries the branch's history.
    g('checkout', '-q', 'main');
    commit('d.cls', 'theirs');
    g('checkout', '-q', 'feature/acme');
    g('-c', 'core.mergeoptions=--no-ff', 'merge', '--no-edit', '-q', 'main');
    const merged = log({ baseRef: 'devInt', branch: 'feature/acme' });
    assert.ok(merged.some(c => c.files.length === 0 && /Merge/i.test(c.subject)), 'a merge commit is listed, with no files of its own');

    // Past the section cap the base must NOT move: a component whose only change
    // is in a commit the cap dropped would vanish from the view entirely — it
    // would be in no section AND outside the diff.
    g('checkout', '-q', '-b', 'feature/big', first);
    for (let i = 0; i < COMMIT_CAP + 5; i++) commit(`x${i}.cls`, `extra ${i}`);
    assert.strictEqual(log({ branch: 'feature/big' }).length, COMMIT_CAP, 'the listing is capped');
    assert.strictEqual(base({ branch: 'feature/big' }), first, 'the base is still the fork point, not the oldest LISTED commit');

    // Why the boundary query is capped one PAST the limit: a walk cut short by
    // -n still prints a boundary, and it is the parent of the last commit walked
    // — a truncation artifact. Reaching the cap is the only way to tell.
    const cut = boundary({ branch: 'feature/big', cap: 4 });
    assert.strictEqual(cut.count, 4, 'the walk stopped at the cap');
    assert.ok(cut.base && cut.base !== first, 'and printed a boundary that is NOT the fork point');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------- run
(async () => {
  for (const [name, fn] of queue) {
    ran++;
    try { await fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
  }
  if (failed) { console.error(`changed-commits: ${failed} of ${ran} checks FAILED`); process.exit(1); }
  console.log(`changed-commits: all ${ran} checks passed`);
})();
