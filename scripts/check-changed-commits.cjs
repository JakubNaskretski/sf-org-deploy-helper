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
//   3. the bases. EVERY boundary of the range (`rev-list --boundary`): the fork
//      point, and after a merge also the merged-in tip (main, a sibling branch) —
//      in an order git does not promise, so none may be picked alone. The
//      provider drops the ones that are ancestors of another (`merge-base
//      --independent`), diffs the working tree against each that is left, and
//      keeps only the paths EVERY diff reports: a file this branch changed
//      differs from every lineage it merged in, a file a merge brought in equals
//      that lineage's tip. One boundary is the plain diff. None means nothing
//      committed to show, or a reason to stay uncommitted-only. A merge still IN
//      PROGRESS (a conflict, or --no-commit) has no merge commit and git has
//      STAGED everything it brings in: MERGE_HEAD stands in as a base (and, on a
//      branch with no commits of its own, HEAD does too, so what HEAD already has
//      and main lacks stays out), a staged file counts as uncommitted only if it
//      differs from every base (a clean incoming file equals MERGE_HEAD), and the
//      files in conflict are listed. That holds when the branch gives up too (more
//      than MAX_BRANCH_COMMITS of its own, the usual state on an integration branch
//      that main is merged back into): MERGE_HEAD is still read and diffed, only to
//      filter the staged files, and no committed key is added. With no commit section
//      to list a file again, a staged file goes only if the merge itself brought it in:
//      the merged side changed it (`diff HEAD...MERGE_HEAD`, a pull's too) AND it equals
//      another lineage's tip, so a revert of a file it never touched stays. A `git pull` is the
//      exception: it merges the branch's OWN remote, so MERGE_HEAD (listed in the
//      range when it is asked with HEAD as a second tip) is the branch's work, not a
//      base — the fork point stays the base and what the pull brings in shows. If its
//      remote merged main, that tip is a boundary of its own and filters the index; on
//      a give-up the same boundaries come from one more query (what the pull brings
//      in: MERGE_HEAD --not HEAD and the other branches), minus the ones HEAD already
//      has (the pushed commit is this branch's own, and a file put back to its version
//      is not the pull's), and filter it the same way, for the files the pull changed;
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
      // Left out unless given, so every check without a merge also covers a state
      // that has no such field.
      mergeChanges: opts.mergeChanges && opts.mergeChanges.map(p => ({ uri: { fsPath: p } })),
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
const HEAD_TIP = '4'.repeat(40);
/** Answer the calls the auto comparison makes: the boundary query (hashes, the
 *  boundaries prefixed '-'), the commit listing, `rev-parse -q --verify MERGE_HEAD`
 *  (a rejection, like git's exit 1, unless `mergeHead` is given), `rev-parse HEAD`
 *  (`head`, or a rejection when null), with several bases `merge-base
 *  --independent` (by default nothing is dropped) and `diff --name-only
 *  HEAD...MERGE_HEAD` (the repository-relative paths in `changedByMerge`, or a
 *  rejection when null). `log` may be a function of the repository's cwd;
 *  `boundary` may be a function of the cwd and the argv. */
const gitScript = (log, boundary = ['x'.repeat(40), '-' + 'f'.repeat(40)].join('\n'), identity = MINE,
  independent = (args) => args.slice(2).join('\n') + '\n', mergeHead = null, head = HEAD_TIP, changedByMerge = []) =>
  (args, opts) => {
    if (args[0] === 'rev-parse') {
      const asked = args.join(' ');
      if (asked === 'rev-parse -q --verify MERGE_HEAD') {
        if (!mergeHead) throw new Error('exit 1');
        return mergeHead + '\n';
      }
      if (asked === 'rev-parse HEAD') {
        if (!head) throw new Error('boom');
        return head + '\n';
      }
      throw new Error(`unexpected ${asked}`);
    }
    if (args[0] === 'config') {
      if (identity === null) throw new Error('no user.email configured');
      return identity + '\n';
    }
    if (args[0] === 'merge-base') return independent(args);
    if (args[0] === 'diff') {
      if (!changedByMerge) throw new Error('boom');
      return changedByMerge.map(f => f + '\0').join('');
    }
    if (args[0] === 'rev-list') return typeof boundary === 'function' ? boundary(opts, args) : boundary;
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

check('the boundary query can start from more than HEAD; the commit listing never does', () => {
  const tip = '9'.repeat(40);
  const args = boundaryArgs({ branch: 'feature/acme', tips: ['HEAD', tip] });
  assert.deepStrictEqual(args.slice(4), ['HEAD', tip, '--not', '--exclude=feature/acme', '--branches', '--exclude=*/feature/acme', '--remotes']);
  assert.deepStrictEqual(boundaryArgs({ branch: 'feature/acme' }).slice(4, 6), ['HEAD', '--not'], 'HEAD alone by default');
  assert.deepStrictEqual(boundaryArgs({ baseRef: 'main', tips: ['HEAD', tip] }).slice(4), ['main..HEAD'], 'a configured ref is a plain range');
  // What an open pull brings in: its tip, minus everything HEAD already has.
  assert.deepStrictEqual(boundaryArgs({ branch: 'feature/acme', tips: [tip], not: ['HEAD'] }).slice(4),
    [tip, '--not', 'HEAD', '--exclude=feature/acme', '--branches', '--exclude=*/feature/acme', '--remotes']);
  assert.deepStrictEqual(boundaryArgs({ branch: 'feature/acme' }).slice(4, 7), ['HEAD', '--not', '--exclude=feature/acme'], 'nothing extra by default');
  assert.ok(!commitLogArgs({ branch: 'feature/acme' }).includes(tip), 'what a merge brings in becomes a section once committed, not before');
});

check('the diff base is where the branch joins the rest of the repository', () => {
  const b = parseBoundary(['a'.repeat(40), 'c'.repeat(40), '-' + 'f'.repeat(40), ''].join('\n'));
  assert.deepStrictEqual(b, { count: 2, bases: ['f'.repeat(40)], listed: ['a'.repeat(40), 'c'.repeat(40)] });
  assert.deepStrictEqual(baseFromBoundary(b), { bases: ['f'.repeat(40)] });
});

check('a merge adds a boundary of its own, and every one is kept in the order git printed it', () => {
  // The fork point and the merged-in tip: which comes first is git's business.
  const fork = '1'.repeat(40);
  const tip = '2'.repeat(40);
  const one = parseBoundary(['a'.repeat(40), '-' + fork, '-' + tip].join('\n'));
  assert.deepStrictEqual(one, { count: 1, bases: [fork, tip], listed: ['a'.repeat(40)] });
  assert.deepStrictEqual(parseBoundary(['a'.repeat(40), '-' + tip, '-' + fork].join('\n')).bases, [tip, fork]);
  assert.deepStrictEqual(baseFromBoundary(one), { bases: [fork, tip] });
});

check('nothing committed, a trunk-only checkout and an over-long branch are told apart', () => {
  // Nothing of this branch's own: no base, but nothing went wrong either.
  assert.deepStrictEqual(baseFromBoundary(parseBoundary('')), { bases: [] });
  // A trunk-only checkout: commits, but no boundary — the range runs to the root.
  assert.deepStrictEqual(
    baseFromBoundary(parseBoundary(['a'.repeat(40), 'b'.repeat(40)].join('\n'))),
    { giveUp: 'whole-history' });
  // At the limit the walk still completed, so the boundary is the real one.
  assert.deepStrictEqual(baseFromBoundary({ count: MAX_BRANCH_COMMITS, bases: ['f'.repeat(40)] }), { bases: ['f'.repeat(40)] });
  assert.deepStrictEqual(baseFromBoundary({ count: MAX_BRANCH_COMMITS + 1, bases: ['f'.repeat(40)] }), { giveUp: 'too-long' });
});

// ----------------------------------------------------------- 4) the payload
const A_CLS = `${WS}/${CLASSES}/AcmeA.cls`;
const B_CLS = `${WS}/${CLASSES}/AcmeB.cls`;
const C_CLS = `${WS}/${CLASSES}/AcmeC.cls`;
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

check('a file deleted inside an unzipped static resource marks the resource changed', async () => {
  // Its filePath is the meta, not the folder, so the folder is registered on its own.
  const SR = `${WS}/force-app/main/default/staticresources`;
  const zip = { type: 'StaticResource', name: 'AcmeZip', filePath: `${SR}/AcmeZip.resource-meta.xml`, files: [`${SR}/AcmeZip.resource-meta.xml`, `${SR}/AcmeZip/js/a.js`] };
  config = { changedBaseRef: '' };
  git = { repositories: [repo({ working: [`${SR}/AcmeZip/js/gone.js`] })], onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN };
  const p = provider([...ITEMS, zip]);
  await p.s.postChangedComponents();
  assert.deepStrictEqual(p.last().uncommitted, ['StaticResource:AcmeZip']);
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
  assert.ok(gitRuns.every(r => r.args[0] !== 'rev-list' && r.args[0] !== 'merge-base'), 'the configured ref is the one base — nothing to look up');
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

// A merge brings another lineage in, so the range has more than one boundary.
// The commit only touches README.md (no component, no section) so the keys below
// are the base diffs' answer alone.
const FORK = '1'.repeat(40);
const TIP = '2'.repeat(40);
const SIB = '3'.repeat(40);
const README_ONLY = logged('a'.repeat(40), '200', 'docs', ['README.md']);
const multi = (opts) => {
  const diffed = [];
  const diffs = opts.diffs || {};
  const r = repo({
    working: opts.working, index: opts.index, mergeChanges: opts.mergeChanges,
    diffWith: async (ref) => {
      diffed.push(ref);
      const d = diffs[ref];
      if (d instanceof Error) throw d;
      return (d || []).map(f => ({ uri: { fsPath: f } }));
    }
  });
  git = { repositories: [r], onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN };
  return diffed;
};

check('one boundary is the plain diff: no merge-base is asked for', async () => {
  config = { changedBaseRef: 'auto' };
  gitRuns = [];
  gitAnswer = gitScript(README_ONLY);
  const diffed = multi({ diffs: { ['f'.repeat(40)]: [B_CLS] } });
  const p = provider();
  await p.s.postChangedComponents();
  assert.deepStrictEqual(diffed, ['f'.repeat(40)]);
  assert.deepStrictEqual(p.last().keys, ['ApexClass:AcmeB']);
  assert.ok(gitRuns.every(r => r.args[0] !== 'merge-base'), 'one boundary has nothing to reduce');
});

check('a merged-in tip contains the fork point: only the tip is diffed against', async () => {
  config = { changedBaseRef: 'auto' };
  gitRuns = [];
  gitAnswer = gitScript(README_ONLY, ['a'.repeat(40), '-' + FORK, '-' + TIP].join('\n'), MINE, () => TIP + '\n');
  // Against the fork point, main's own change (AcmeC) would read as this branch's.
  const diffed = multi({ diffs: { [FORK]: [B_CLS, `${WS}/${CLASSES}/AcmeC.cls`], [TIP]: [B_CLS] } });
  const p = provider();
  await p.s.postChangedComponents();
  assert.deepStrictEqual(gitRuns.find(r => r.args[0] === 'merge-base').args, ['merge-base', '--independent', FORK, TIP]);
  assert.deepStrictEqual(diffed, [TIP], 'the boundary another one contains is dropped');
  assert.deepStrictEqual(p.last().keys, ['ApexClass:AcmeB']);
});

check('two lineages merged in: only the paths every diff reports reach the view', async () => {
  // A sibling branch and main, neither containing the other. A file one of them
  // brought in equals THAT tip and drops out of its diff, so no single boundary
  // gives the right answer — taking the first (or any one) leaks the other's files.
  config = { changedBaseRef: 'auto' };
  const run = async (order) => {
    gitAnswer = gitScript(README_ONLY, ['a'.repeat(40), ...order.map(h => '-' + h)].join('\n'));
    const diffed = multi({ diffs: { [SIB]: [B_CLS, C_CLS], [TIP]: [B_CLS, A_CLS] } });
    const p = provider();
    await p.s.postChangedComponents();
    assert.deepStrictEqual(diffed.slice().sort(), [SIB, TIP].sort(), 'one diff per independent boundary');
    assert.deepStrictEqual(p.last().keys, ['ApexClass:AcmeB'], 'the sibling\'s AcmeC and main\'s AcmeA are not this branch\'s');
  };
  await run([SIB, TIP]);
  await run([TIP, SIB]);
});

check('merge-base failing keeps every boundary — slower, not wrong', async () => {
  config = { changedBaseRef: 'auto' };
  gitAnswer = gitScript(README_ONLY, ['a'.repeat(40), '-' + SIB, '-' + TIP].join('\n'), MINE, () => { throw new Error('boom'); });
  const diffed = multi({ diffs: { [SIB]: [B_CLS, `${WS}/${CLASSES}/AcmeC.cls`], [TIP]: [B_CLS] } });
  const p = provider();
  await p.s.postChangedComponents();
  assert.deepStrictEqual(diffed.slice().sort(), [SIB, TIP].sort());
  assert.deepStrictEqual(p.last().keys, ['ApexClass:AcmeB']);
  assert.ok(p.log.some(l => l.includes('merge-base --independent failed')), 'and says so in the output channel');
});

check('one of several diffs failing degrades to the uncommitted answer, never half a diff', async () => {
  config = { changedBaseRef: 'auto' };
  gitAnswer = gitScript(README_ONLY, ['a'.repeat(40), '-' + SIB, '-' + TIP].join('\n'));
  multi({ working: [A_CLS], diffs: { [SIB]: [B_CLS], [TIP]: new Error('bad object') } });
  const p = provider();
  await p.s.postChangedComponents();
  assert.strictEqual(p.last().keys === null, false, 'the lens still answers');
  assert.deepStrictEqual(p.last().keys, ['ApexClass:AcmeA'], 'the diff that did come back is not shown alone');
  assert.ok(p.log.some(l => l.includes('diffWith')));
});

// A merge still IN PROGRESS (stopped on a conflict, or run --no-commit) has no
// merge commit: the merged-in tip is no boundary, and git has STAGED every file
// it brings in. MERGE_HEAD stands in as the base, and a staged file that equals
// it is main's, not the branch's.
const CARD_JS = `${WS}/force-app/main/default/lwc/acmeCard/acmeCard.js`;
const ONE_BOUNDARY = ['a'.repeat(40), '-' + FORK].join('\n');
const CARD = 'LightningComponentBundle:acmeCard';

check('a merge still open: what it staged stays out, a conflict and your own staged edit show', async () => {
  config = { changedBaseRef: 'auto' };
  gitRuns = [];
  // The fork point is the only boundary; MERGE_HEAD is the merged-in tip and contains it.
  gitAnswer = gitScript(README_ONLY, ONE_BOUNDARY, MINE, () => TIP + '\n', TIP);
  // Against the tip: AcmeB (your own staged edit) and AcmeC (conflict markers)
  // differ; AcmeA, which main brought in and git staged, equals it. The new
  // component is untracked, so no diff reports it.
  const diffed = multi({ working: [CARD_JS], index: [A_CLS, B_CLS], mergeChanges: [C_CLS], diffs: { [TIP]: [B_CLS, C_CLS] } });
  const p = provider();
  await p.s.postChangedComponents();
  assert.deepStrictEqual(gitRuns.find(r => r.args[0] === 'rev-parse').args, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  assert.deepStrictEqual(gitRuns.find(r => r.args[0] === 'merge-base').args, ['merge-base', '--independent', FORK, TIP],
    'MERGE_HEAD joins the boundaries before they are reduced');
  assert.deepStrictEqual(diffed, [TIP], 'the fork point is the tip\'s ancestor and is dropped');
  assert.ok(gitRuns.every(r => r.args[0] !== 'diff'), 'with a commit section to list it again the diff against the tip alone is the filter');
  assert.deepStrictEqual(p.last().uncommitted.slice().sort(), ['ApexClass:AcmeB', 'ApexClass:AcmeC', CARD],
    'the conflict is listed, the untracked file is not filtered, main\'s staged file is gone');
  assert.deepStrictEqual(p.last().keys.slice().sort(), ['ApexClass:AcmeB', 'ApexClass:AcmeC', CARD]);
});

check('a merge open on a branch with no commits of its own: HEAD is a base beside MERGE_HEAD', async () => {
  // Cut from a teammate's branch: HEAD has the teammate's AcmeC, which main lacks, so
  // against MERGE_HEAD alone AcmeC would read as changed.
  config = { changedBaseRef: 'auto' };
  gitRuns = [];
  gitAnswer = gitScript('', '', MINE, undefined, TIP);
  const diffed = multi({ index: [A_CLS, B_CLS], diffs: { [TIP]: [B_CLS, C_CLS], [HEAD_TIP]: [A_CLS, B_CLS] } });
  const p = provider();
  await p.s.postChangedComponents();
  assert.deepStrictEqual(gitRuns.find(r => r.args[0] === 'rev-parse' && r.args[1] === 'HEAD').args, ['rev-parse', 'HEAD']);
  assert.deepStrictEqual(gitRuns.find(r => r.args[0] === 'merge-base').args, ['merge-base', '--independent', TIP, HEAD_TIP]);
  assert.deepStrictEqual(diffed.slice().sort(), [HEAD_TIP, TIP].sort());
  assert.deepStrictEqual(p.last().uncommitted, ['ApexClass:AcmeB'], 'AcmeA equals MERGE_HEAD: main\'s');
  assert.deepStrictEqual(p.last().keys, ['ApexClass:AcmeB'], 'AcmeC is HEAD\'s own, committed before the merge');
});

check('a merge open on a branch at the fork point: HEAD is MERGE_HEAD\'s ancestor and drops out', async () => {
  config = { changedBaseRef: 'auto' };
  gitRuns = [];
  gitAnswer = gitScript('', '', MINE, () => TIP + '\n', TIP);
  const diffed = multi({ index: [A_CLS, B_CLS], diffs: { [TIP]: [B_CLS] } });
  const p = provider();
  await p.s.postChangedComponents();
  assert.deepStrictEqual(diffed, [TIP]);
  assert.deepStrictEqual(p.last().uncommitted, ['ApexClass:AcmeB']);
  assert.deepStrictEqual(p.last().keys, ['ApexClass:AcmeB']);
});

check('rev-parse HEAD failing falls back to the name HEAD; with no merge open it is not asked at all', async () => {
  config = { changedBaseRef: 'auto' };
  gitAnswer = gitScript('', '', MINE, undefined, TIP, null);
  const diffed = multi({ diffs: { [TIP]: [B_CLS, C_CLS], HEAD: [B_CLS] } });
  const p = provider();
  await p.s.postChangedComponents();
  assert.deepStrictEqual(diffed.slice().sort(), ['HEAD', TIP].sort());
  assert.deepStrictEqual(p.last().keys, ['ApexClass:AcmeB']);
  gitRuns = [];
  gitAnswer = gitScript('', '');
  multi({});
  const q = provider();
  await q.s.postChangedComponents();
  assert.ok(gitRuns.every(r => r.args.join(' ') !== 'rev-parse HEAD'), 'no merge open: an empty range is just empty');
  assert.deepStrictEqual(q.last().keys, []);
});

check('no merge open: the staged files are all yours, and MERGE_HEAD is asked for each time', async () => {
  config = { changedBaseRef: 'auto' };
  gitRuns = [];
  gitAnswer = gitScript(README_ONLY, ONE_BOUNDARY);
  multi({ index: [A_CLS], diffs: { [FORK]: [B_CLS] } });
  const p = provider();
  await p.s.postChangedComponents();
  assert.ok(gitRuns.some(r => r.args[0] === 'rev-parse'), 'asked');
  assert.deepStrictEqual(p.last().uncommitted, ['ApexClass:AcmeA'], 'a staged edit must not need to differ from anything');
  assert.deepStrictEqual(p.last().keys.slice().sort(), ['ApexClass:AcmeA', 'ApexClass:AcmeB']);
  assert.ok(p.log.length === 0, 'no merge is the usual answer and is not logged');
});

check('MERGE_HEAD stays a base even when merge-base --independent leaves it out', async () => {
  config = { changedBaseRef: 'auto' };
  gitAnswer = gitScript(README_ONLY, ONE_BOUNDARY, MINE, () => FORK + '\n', TIP);
  const diffed = multi({ index: [A_CLS, B_CLS], diffs: { [FORK]: [A_CLS, B_CLS], [TIP]: [B_CLS] } });
  const p = provider();
  await p.s.postChangedComponents();
  assert.deepStrictEqual(diffed.slice().sort(), [FORK, TIP].sort());
  assert.deepStrictEqual(p.last().uncommitted, ['ApexClass:AcmeB'], 'its own diff is what tells main\'s staged file from yours');
});

check('MERGE_HEAD listed in the range is the branch\'s own remote (a pull): not a base, nothing of it filtered out', async () => {
  config = { changedBaseRef: 'auto' };
  gitRuns = [];
  // Asked with MERGE_HEAD as a second tip, git lists it among the branch's own commits.
  gitAnswer = gitScript(README_ONLY, ['a'.repeat(40), TIP, '-' + FORK].join('\n'), MINE, undefined, TIP);
  // The teammate's staged file (AcmeA) equals MERGE_HEAD but differs from the fork point.
  const diffed = multi({ index: [A_CLS, B_CLS], mergeChanges: [C_CLS], diffs: { [FORK]: [A_CLS, B_CLS], [TIP]: [B_CLS] } });
  const p = provider();
  await p.s.postChangedComponents();
  const range = gitRuns.find(r => r.args[0] === 'rev-list').args;
  assert.deepStrictEqual(range.slice(range.indexOf('HEAD'), range.indexOf('--not')), ['HEAD', TIP], 'the boundary query starts from both tips');
  assert.deepStrictEqual(diffed, [FORK], 'the fork point stays the base');
  assert.ok(gitRuns.every(r => r.args[0] !== 'merge-base'), 'one boundary, nothing to reduce');
  assert.deepStrictEqual(p.last().uncommitted.slice().sort(), ['ApexClass:AcmeA', 'ApexClass:AcmeB', 'ApexClass:AcmeC']);
  assert.deepStrictEqual(p.last().keys.slice().sort(), ['ApexClass:AcmeA', 'ApexClass:AcmeB', 'ApexClass:AcmeC']);
  // Not listed: another lineage, a base as before.
  gitRuns = [];
  gitAnswer = gitScript(README_ONLY, ONE_BOUNDARY, MINE, () => TIP + '\n', TIP);
  const other = multi({ index: [A_CLS, B_CLS], diffs: { [TIP]: [B_CLS] } });
  const q = provider();
  await q.s.postChangedComponents();
  assert.deepStrictEqual(other, [TIP]);
  assert.deepStrictEqual(q.last().uncommitted, ['ApexClass:AcmeB']);
});

check('a pulled remote that merged main: the staged files are filtered by every base, not by MERGE_HEAD alone', async () => {
  // The remote's own merge of main makes main's tip a boundary (a base). AcmeA is main's
  // (equals it), AcmeB the teammate's and AcmeC your own staged edit (both differ from it).
  // MERGE_HEAD contains all three, so a diff against it alone would drop every one.
  config = { changedBaseRef: 'auto' };
  gitAnswer = gitScript(README_ONLY, ['a'.repeat(40), TIP, '-' + FORK, '-' + SIB].join('\n'), MINE, () => SIB + '\n', TIP);
  const diffed = multi({ index: [A_CLS, B_CLS, C_CLS], diffs: { [SIB]: [B_CLS, C_CLS], [TIP]: [] } });
  const p = provider();
  await p.s.postChangedComponents();
  assert.deepStrictEqual(diffed, [SIB], 'main\'s tip is the base; MERGE_HEAD is not diffed at all');
  assert.deepStrictEqual(p.last().uncommitted.slice().sort(), ['ApexClass:AcmeB', 'ApexClass:AcmeC']);
});

// A pull open on a branch that gives up. MERGE_HEAD is the branch's own, so it is no
// base and not diffed; but the remote may have merged main in, and git staged main's
// files with the pull. The range is asked once more from MERGE_HEAD, minus HEAD, and
// the commits just outside it (the pushed commit, main's tip) filter the index.
const PUSHED = '5'.repeat(40);
// What git answers to `merge-base --independent HEAD <boundaries>`: the boundaries HEAD
// already has are dropped, HEAD itself (its hash, not the name) stays.
const outsideHead = (...ancestors) => (args) => [HEAD_TIP, ...args.slice(3).filter(h => !ancestors.includes(h))].join('\n') + '\n';
const rel = (abs) => abs.slice(WS.length + 1);
const pullGiveUp = (incoming) => (opts, args) => (args[4] === 'HEAD' ? [TIP, LONG_RANGE].join('\n') : typeof incoming === 'function' ? incoming() : incoming);
const incomingRange = (...bases) => [TIP, ...bases.map(b => '-' + b)].join('\n');

check('a pull open while the branch gives up: what its remote merged from another lineage is filtered, the pull\'s own work is not', async () => {
  config = { changedBaseRef: 'auto' };
  gitRuns = [];
  // The remote merged main: the pushed commit and main's tip are the boundaries of what
  // the pull brings in, and the pushed commit is HEAD's own ancestor, so main's tip is the
  // only one left to filter by. AcmeA is main's (equals its tip), AcmeB a file you staged
  // back to the pushed version (equals that commit, so a diff against it would drop your
  // own file) and AcmeC your own staged edit (differs from both). MERGE_HEAD is never diffed.
  gitAnswer = gitScript(README_ONLY, pullGiveUp(incomingRange(PUSHED, SIB)), MINE, outsideHead(PUSHED), TIP, HEAD_TIP, [rel(A_CLS)]);
  const diffed = multi({ index: [A_CLS, B_CLS, C_CLS], diffs: { [PUSHED]: [A_CLS, C_CLS], [SIB]: [B_CLS, C_CLS], [TIP]: [] } });
  const p = provider();
  await p.s.postChangedComponents();
  const asked = gitRuns.filter(r => r.args[0] === 'rev-list').map(r => r.args.slice(4));
  assert.deepStrictEqual(asked[0].slice(0, 3), ['HEAD', TIP, '--not'], 'the branch range, from both tips');
  assert.deepStrictEqual(asked[1].slice(0, 3), [TIP, '--not', 'HEAD'], 'then what the pull brings in: its tip, minus HEAD');
  assert.strictEqual(asked.length, 2);
  assert.deepStrictEqual(gitRuns.find(r => r.args[0] === 'merge-base').args, ['merge-base', '--independent', 'HEAD', PUSHED, SIB],
    'the boundaries HEAD already has are dropped with one reduction');
  assert.deepStrictEqual(diffed, [SIB], 'one diff, against the boundary HEAD lacks');
  assert.ok(gitRuns.every(r => r.args[0] !== 'log'), 'no commit listing');
  assert.deepStrictEqual(gitRuns.find(r => r.args[0] === 'diff').args, ['diff', '--name-only', '-z', '--no-renames', `HEAD...${TIP}`],
    'and the files the pull changed come from the three-dot diff, as for a merge');
  assert.deepStrictEqual(p.last().uncommitted.slice().sort(), ['ApexClass:AcmeB', 'ApexClass:AcmeC']);
  assert.deepStrictEqual(p.last().keys.slice().sort(), ['ApexClass:AcmeB', 'ApexClass:AcmeC'], 'uncommitted only: no committed key is added');
  assert.deepStrictEqual(p.last().commits, []);
  assert.ok(p.last().note, 'still the fallback');
  // A remote that merged nothing: the one boundary is the pushed commit, HEAD's own, so
  // nothing is filtered — AcmeB, put back to its version, included.
  gitAnswer = gitScript(README_ONLY, pullGiveUp(incomingRange(PUSHED)), MINE, outsideHead(PUSHED), TIP);
  const plain = multi({ index: [A_CLS, B_CLS], diffs: { [PUSHED]: [A_CLS] } });
  const q = provider();
  await q.s.postChangedComponents();
  assert.deepStrictEqual(plain, []);
  assert.deepStrictEqual(q.last().uncommitted.slice().sort(), ['ApexClass:AcmeA', 'ApexClass:AcmeB']);
});

check('a pull open while the branch gives up: a staged file equal to main\'s tip that the pull never changed stays', async () => {
  config = { changedBaseRef: 'auto' };
  // AcmeA: the pull brought it in from main (changed since the merge base, equals the tip).
  // AcmeC: your own file staged back to the fork-point version, which equals main's tip too
  // because main never touched it; the three-dot diff does not list it, so a diff against the
  // tip alone would drop it. AcmeB: your edit, differs from the tip.
  gitAnswer = gitScript(README_ONLY, pullGiveUp(incomingRange(PUSHED, SIB)), MINE, outsideHead(PUSHED), TIP, HEAD_TIP, [rel(A_CLS), rel(B_CLS)]);
  multi({ index: [A_CLS, B_CLS, C_CLS], diffs: { [SIB]: [B_CLS] } });
  const p = provider();
  await p.s.postChangedComponents();
  assert.deepStrictEqual(p.last().uncommitted.slice().sort(), ['ApexClass:AcmeB', 'ApexClass:AcmeC']);
  assert.deepStrictEqual(p.last().keys.slice().sort(), ['ApexClass:AcmeB', 'ApexClass:AcmeC'], 'uncommitted only');
  // The three-dot diff failing: unfiltered, never half a filter, and it says so.
  gitAnswer = gitScript(README_ONLY, pullGiveUp(incomingRange(PUSHED, SIB)), MINE, outsideHead(PUSHED), TIP, HEAD_TIP, null);
  multi({ index: [A_CLS, B_CLS, C_CLS], diffs: { [SIB]: [B_CLS] } });
  const q = provider();
  await q.s.postChangedComponents();
  assert.deepStrictEqual(q.last().uncommitted.slice().sort(), ['ApexClass:AcmeA', 'ApexClass:AcmeB', 'ApexClass:AcmeC']);
  assert.ok(q.log.some(l => l.includes('diffWith')));
});

check('a pull open while the branch gives up: nothing found, or a failing query or diff, leaves the staged files unfiltered', async () => {
  config = { changedBaseRef: 'auto' };
  // No boundary at all (the range ran to the root), a walk cut at the cap, a query that throws.
  const cases = {
    'no boundary': () => TIP,
    'past the cap': () => incomingRange(PUSHED) + '\n' + LONG_RANGE.split('\n').slice(0, MAX_BRANCH_COMMITS + 1).join('\n'),
    'query fails': () => { throw new Error('bad revision'); }
  };
  for (const [why, incoming] of Object.entries(cases)) {
    gitAnswer = gitScript(README_ONLY, pullGiveUp(incoming), MINE, undefined, TIP);
    const diffed = multi({ index: [A_CLS, B_CLS], diffs: { [PUSHED]: [B_CLS] } });
    const p = provider();
    await p.s.postChangedComponents();
    assert.deepStrictEqual(diffed, [], `${why}: nothing to diff against`);
    assert.deepStrictEqual(p.last().uncommitted.slice().sort(), ['ApexClass:AcmeA', 'ApexClass:AcmeB'], why);
    assert.ok(p.last().note, `${why}: still the fallback`);
    if (why === 'query fails') assert.ok(p.log.some(l => l.includes('what the pull brings in failed')), 'and says so');
  }
  gitAnswer = gitScript(README_ONLY, pullGiveUp(incomingRange(PUSHED, SIB)), MINE, outsideHead(PUSHED), TIP);
  multi({ index: [A_CLS, B_CLS], mergeChanges: [C_CLS], diffs: { [SIB]: new Error('bad object') } });
  const p = provider();
  await p.s.postChangedComponents();
  assert.deepStrictEqual(p.last().uncommitted.slice().sort(), ['ApexClass:AcmeA', 'ApexClass:AcmeB', 'ApexClass:AcmeC'], 'a diff that fails is no half a filter');
  assert.ok(p.log.some(l => l.includes('diffWith')));
  // The ancestor check failing (HEAD's hash, or the reduction itself): no half a filter either.
  for (const [why, script] of [
    ['merge-base fails', gitScript(README_ONLY, pullGiveUp(incomingRange(PUSHED, SIB)), MINE, () => { throw new Error('boom'); }, TIP)],
    ['rev-parse HEAD fails', gitScript(README_ONLY, pullGiveUp(incomingRange(PUSHED, SIB)), MINE, outsideHead(PUSHED), TIP, null)]
  ]) {
    gitAnswer = script;
    const diffed = multi({ index: [A_CLS, B_CLS], diffs: { [SIB]: [B_CLS] } });
    const q = provider();
    await q.s.postChangedComponents();
    assert.deepStrictEqual(diffed, [], `${why}: nothing to diff against`);
    assert.deepStrictEqual(q.last().uncommitted.slice().sort(), ['ApexClass:AcmeA', 'ApexClass:AcmeB'], why);
    assert.ok(q.log.some(l => l.includes('what the pull brings in failed')), `${why}: and says so`);
  }
});

check('the branch query failing during an open merge still filters the index against MERGE_HEAD', async () => {
  // Whether it is a pull is unknown, so it is read as another lineage's merge.
  config = { changedBaseRef: 'auto' };
  gitAnswer = gitScript(README_ONLY, () => { throw new Error('boom'); }, MINE, undefined, TIP, HEAD_TIP, [rel(A_CLS), rel(B_CLS)]);
  const diffed = multi({ index: [A_CLS, B_CLS], mergeChanges: [C_CLS], diffs: { [TIP]: [B_CLS, C_CLS] } });
  const p = provider();
  await p.s.postChangedComponents();
  assert.deepStrictEqual(diffed, [TIP]);
  assert.deepStrictEqual(p.last().uncommitted.slice().sort(), ['ApexClass:AcmeB', 'ApexClass:AcmeC']);
  assert.ok(p.log.some(l => l.includes('branch range failed')));
});

check('the merged-in tip failing to diff leaves the staged files unfiltered, and says so', async () => {
  config = { changedBaseRef: 'auto' };
  gitAnswer = gitScript(README_ONLY, ONE_BOUNDARY, MINE, () => TIP + '\n', TIP);
  multi({ index: [A_CLS], mergeChanges: [C_CLS], diffs: { [TIP]: new Error('bad object') } });
  const p = provider();
  await p.s.postChangedComponents();
  assert.deepStrictEqual(p.last().uncommitted.slice().sort(), ['ApexClass:AcmeA', 'ApexClass:AcmeC']);
  assert.ok(p.log.some(l => l.includes('diffWith')));
});

const LONG_RANGE = [...Array.from({ length: MAX_BRANCH_COMMITS + 1 }, (_, i) => String(i + 1).padStart(40, '0')), '-' + FORK].join('\n');
const WHOLE_HISTORY = ['a'.repeat(40), 'b'.repeat(40)].join('\n');

check('a merge open while the branch gives up (too long, whole history): main\'s staged files stay out, no committed key is added', async () => {
  for (const [why, boundary] of [['too-long', LONG_RANGE], ['whole-history', WHOLE_HISTORY]]) {
    config = { changedBaseRef: 'auto' };
    gitRuns = [];
    gitAnswer = gitScript(README_ONLY, boundary, MINE, undefined, TIP, HEAD_TIP, [rel(A_CLS), rel(B_CLS), rel(C_CLS)]);
    // The tip's diff is asked for once, as a filter: AcmeB is your staged edit and AcmeC
    // is in conflict (both differ from it), AcmeA is main's. A diff against any other
    // ref would answer with files that must not enter the view.
    const diffed = multi({ working: [CARD_JS], index: [A_CLS, B_CLS], mergeChanges: [C_CLS], diffs: { [TIP]: [B_CLS, C_CLS], [FORK]: [A_CLS] } });
    const p = provider();
    await p.s.postChangedComponents();
    assert.deepStrictEqual(diffed, [TIP], why);
    assert.ok(gitRuns.every(r => r.args[0] !== 'log' && r.args[0] !== 'merge-base'), `${why}: no commit listing, nothing to reduce`);
    assert.deepStrictEqual(p.last().uncommitted.slice().sort(), ['ApexClass:AcmeB', 'ApexClass:AcmeC', CARD], why);
    assert.deepStrictEqual(p.last().keys.slice().sort(), ['ApexClass:AcmeB', 'ApexClass:AcmeC', CARD], `${why}: uncommitted only`);
    assert.deepStrictEqual(p.last().commits, [], why);
    assert.ok(p.last().note, `${why}: the fallback note stays`);
  }
});

check('the merged-in tip failing to diff on a give-up leaves the staged files unfiltered, says so, and adds no committed key', async () => {
  config = { changedBaseRef: 'auto' };
  gitAnswer = gitScript(README_ONLY, LONG_RANGE, MINE, undefined, TIP);
  multi({ index: [A_CLS], mergeChanges: [C_CLS], diffs: { [TIP]: new Error('bad object') } });
  const p = provider();
  await p.s.postChangedComponents();
  assert.deepStrictEqual(p.last().uncommitted.slice().sort(), ['ApexClass:AcmeA', 'ApexClass:AcmeC']);
  assert.deepStrictEqual(p.last().keys.slice().sort(), ['ApexClass:AcmeA', 'ApexClass:AcmeC']);
  assert.ok(p.log.some(l => l.includes('diffWith')));
  assert.ok(p.last().note, 'still the fallback');
});

check('a merge open while the branch gives up: a staged file is main\'s only if main changed it and it equals main\'s tip', async () => {
  config = { changedBaseRef: 'auto' };
  gitRuns = [];
  // AcmeA: main changed it and the file equals its tip, so the merge brought it in. AcmeB:
  // main changed it and you resolved it your way. AcmeC: main never touched it and you staged
  // it back to an older version, which equals the tip too — a plain diff against the tip drops it.
  gitAnswer = gitScript(README_ONLY, LONG_RANGE, MINE, undefined, TIP, HEAD_TIP, [rel(A_CLS), rel(B_CLS)]);
  multi({ index: [A_CLS, B_CLS, C_CLS], diffs: { [TIP]: [B_CLS] } });
  const p = provider();
  await p.s.postChangedComponents();
  assert.deepStrictEqual(gitRuns.find(r => r.args[0] === 'diff').args, ['diff', '--name-only', '-z', '--no-renames', `HEAD...${TIP}`]);
  assert.deepStrictEqual(p.last().uncommitted.slice().sort(), ['ApexClass:AcmeB', 'ApexClass:AcmeC']);
  // The three-dot diff failing: unfiltered, never half a filter, and it says so.
  gitAnswer = gitScript(README_ONLY, LONG_RANGE, MINE, undefined, TIP, HEAD_TIP, null);
  multi({ index: [A_CLS, B_CLS, C_CLS], diffs: { [TIP]: [B_CLS] } });
  const q = provider();
  await q.s.postChangedComponents();
  assert.deepStrictEqual(q.last().uncommitted.slice().sort(), ['ApexClass:AcmeA', 'ApexClass:AcmeB', 'ApexClass:AcmeC']);
  assert.ok(q.log.some(l => l.includes('diffWith')));
});

check('a give-up with no merge open never diffs: the view is the working tree alone', async () => {
  config = { changedBaseRef: 'auto' };
  gitAnswer = gitScript(README_ONLY, LONG_RANGE);
  const diffed = multi({ index: [A_CLS], working: [B_CLS] });
  const p = provider();
  await p.s.postChangedComponents();
  assert.deepStrictEqual(diffed, []);
  assert.deepStrictEqual(p.last().keys.slice().sort(), ['ApexClass:AcmeA', 'ApexClass:AcmeB']);
});

check('a configured ref and the empty setting keep their uncommitted section, plus the files in conflict', async () => {
  // Only the auto comparison knows about a merge in progress: with a ref the index
  // is listed whole, as before, and no MERGE_HEAD is looked up.
  const state = { index: [A_CLS], mergeChanges: [C_CLS], diff: [B_CLS] };
  config = { changedBaseRef: 'main' };
  gitRuns = [];
  gitAnswer = () => '';
  git = { repositories: [repo(state)], onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN };
  const p = provider();
  await p.s.postChangedComponents();
  assert.deepStrictEqual(p.last().uncommitted.slice().sort(), ['ApexClass:AcmeA', 'ApexClass:AcmeC']);
  assert.deepStrictEqual(p.last().keys.slice().sort(), ['ApexClass:AcmeA', 'ApexClass:AcmeB', 'ApexClass:AcmeC']);
  assert.ok(gitRuns.every(r => r.args[0] !== 'rev-parse'));
  config = { changedBaseRef: '' };
  gitRuns = [];
  const q = provider();
  await q.s.postChangedComponents();
  assert.deepStrictEqual(q.last().uncommitted.slice().sort(), ['ApexClass:AcmeA', 'ApexClass:AcmeC']);
  assert.strictEqual(gitRuns.length, 0);
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

check('one repository giving up does not label the whole view a fallback', async () => {
  // Multi-root: a trunk-only repo alongside a real feature branch. The header
  // speaks for the view, and the view is showing sections.
  config = { changedBaseRef: 'auto' };
  gitAnswer = gitScript(
    opts => (opts.cwd === WS ? '' : logged('a'.repeat(40), '200', 'B', [REL('AcmeB')])),
    opts => (opts.cwd === WS ? ['a'.repeat(40), 'b'.repeat(40)].join('\n') : ['x'.repeat(40), '-' + 'f'.repeat(40)].join('\n')));
  git = {
    repositories: [repo({ working: [A_CLS] }), repo({ root: '/ws2', diff: [] })],
    onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN
  };
  const other = { type: 'ApexClass', name: 'AcmeB', filePath: `/ws2/${CLASSES}/AcmeB.cls`, files: [`/ws2/${CLASSES}/AcmeB.cls`] };
  const p = provider([...ITEMS, other]);
  await p.s.postChangedComponents();
  assert.strictEqual(p.last().commits.length, 1, 'the other repository still contributed its section');
  assert.strictEqual(p.last().note, undefined, 'so the header must not announce a fallback above it');
});

check('the branch being shown is named, unless the repositories disagree', async () => {
  config = { changedBaseRef: 'auto' };
  gitAnswer = gitScript(logged('a'.repeat(40), '200', 'B', [REL('AcmeB')]));
  git = { repositories: [repo({ branch: 'feature/acme', diff: [B_CLS] })], onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN };
  const p = provider();
  await p.s.postChangedComponents();
  assert.strictEqual(p.last().branch, 'feature/acme');
  // Two repositories on different branches: no single name means anything.
  git = {
    repositories: [repo({ branch: 'feature/acme', diff: [B_CLS] }), repo({ root: '/ws2', branch: 'devInt', diff: [] })],
    onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN
  };
  const q = provider();
  await q.s.postChangedComponents();
  assert.strictEqual(q.last().branch, undefined);
  // Detached HEAD has no name at all.
  git = { repositories: [repo({ branch: null, diff: [B_CLS] })], onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN };
  const r = provider();
  await r.s.postChangedComponents();
  assert.strictEqual(r.last().branch, undefined);
  // An explicit ref names itself; the branch is not the comparison then.
  config = { changedBaseRef: 'main' };
  git = { repositories: [repo({ branch: 'feature/acme', diff: [B_CLS] })], onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN };
  const t = provider();
  await t.s.postChangedComponents();
  assert.strictEqual(t.last().branch, undefined);
  assert.strictEqual(t.last().base, 'main');
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
  const bases = (opts) => baseFromBoundary(parseBoundary(g(...boundaryArgs(opts)))).bases ?? [];
  const boundary = (opts) => parseBoundary(g(...boundaryArgs(opts)));
  try {
    g('init', '-b', 'main');
    const first = commit('a.cls', 'on main');
    // A trunk-only checkout: nothing else exists to measure against, so the range
    // reaches the root and there is no base — the view stays uncommitted-only
    // rather than reporting every tracked file as changed.
    assert.deepStrictEqual(bases({ branch: 'main' }), []);
    g('update-ref', 'refs/remotes/origin/main', first);
    assert.deepStrictEqual(bases({ branch: 'main' }), [], 'the branch\'s own remote ref is not the other side');

    g('checkout', '-q', '-b', 'feature/acme');
    commit('b.cls', 'mine one');
    const mine2 = commit('c.cls', 'mine two');
    const ours = log({ branch: 'feature/acme' });
    assert.deepStrictEqual(ours.map(c => c.subject), ['mine two', 'mine one'], 'newest first, and main\'s commit is not mine');
    assert.deepStrictEqual(ours[0].files, ['c.cls']);
    assert.deepStrictEqual(bases({ branch: 'feature/acme' }), [first], 'the diff base is where the branch left main');

    // Pushed: a remote-tracking ref for this very branch must not exclude it.
    g('update-ref', 'refs/remotes/origin/feature/acme', mine2);
    assert.deepStrictEqual(log({ branch: 'feature/acme' }).map(c => c.subject), ['mine two', 'mine one'], 'a push emptied the view');
    assert.deepStrictEqual(bases({ branch: 'feature/acme' }), [first]);

    // Merged elsewhere: once another branch carries them, they are no longer this
    // branch's own work and the view falls back to uncommitted-only.
    g('branch', 'devInt', mine2);
    assert.deepStrictEqual(log({ branch: 'feature/acme' }), []);
    assert.deepStrictEqual(bases({ branch: 'feature/acme' }), []);

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
    assert.deepStrictEqual(bases({ branch: 'feature/big' }), [first], 'the base is still the fork point, not the oldest LISTED commit');

    // Why the boundary query is capped one PAST the limit: a walk cut short by
    // -n still prints a boundary, and it is the parent of the last commit walked
    // — a truncation artifact. Reaching the cap is the only way to tell.
    const cut = boundary({ branch: 'feature/big', cap: 4 });
    assert.strictEqual(cut.count, 4, 'the walk stopped at the cap');
    assert.ok(cut.bases.length === 1 && cut.bases[0] !== first, 'and printed a boundary that is NOT the fork point');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------- 8) merges and rebases, against git itself
// A merge brings another lineage in, and that lineage's tip becomes a second
// boundary of the range. Git alone says which boundaries a real merge produces
// and what each diff against them contains, so these build the situations and
// ask: the exported helpers drive the argv, git answers, and the provider itself
// runs against the same repository (real git behind its spawn and its diffWith).
function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfodw-merge-'));
  let tick = 1700000000;
  // A fresh committer date per command: rev-list orders by it, and commits made
  // inside one second would leave the order of the boundaries to chance.
  const g = (...args) => realExecFileSync('git', [
    '-c', 'user.email=check', '-c', 'user.name=check',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args
  ], {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_DATE: `${++tick} +0000`, GIT_COMMITTER_DATE: `${tick} +0000` }
  });
  const c = (file, text) => { fs.writeFileSync(path.join(dir, file), text + '\n'); g('add', file); g('commit', '-q', '-m', text); return g('rev-parse', 'HEAD').trim(); };
  g('init', '-q', '-b', 'main');
  const fork = c('base.cls', 'base');
  return { dir, g, c, fork, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
/** The provider's auto path, step by step, with real git: every boundary, the
 *  independent ones, and the paths all their diffs share. */
function asProvider(r, branch) {
  const raw = baseFromBoundary(parseBoundary(r.g(...boundaryArgs({ branch })))).bases ?? [];
  const bases = raw.length > 1 ? r.g('merge-base', '--independent', ...raw).split('\n').filter(Boolean) : raw;
  const diffOf = (b) => r.g('diff', '--name-only', b).split('\n').filter(Boolean);
  const shared = bases.length ? bases.map(diffOf).reduce((a, d) => a.filter(f => d.includes(f))) : [];
  return { raw, bases, shared: shared.sort(), diffOf };
}
/** The repository state vscode.git would report, read from `git status`: a path
 *  in conflict is in the merge group only, never also staged or unstaged; an
 *  untracked file is in the working tree group. */
function stateOf(r) {
  const state = { working: [], index: [], mergeChanges: [] };
  for (const line of r.g('status', '--porcelain').split('\n').filter(Boolean)) {
    const xy = line.slice(0, 2);
    const file = path.join(r.dir, line.slice(3));
    if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(xy)) { state.mergeChanges.push(file); continue; }
    if (xy[0] !== ' ' && xy !== '??') state.index.push(file);
    if (xy[1] !== ' ') state.working.push(file);
  }
  return state;
}
/** The Changed view's keys from the real provider code, git behind both its
 *  spawns and its diffWith, and the state git reports — what the user would see. */
async function viaProvider(r, branch) {
  config = { changedBaseRef: 'auto' };
  gitRuns = [];
  const diffed = [];
  gitAnswer = (args, opts) => (args[0] === 'config' ? 'check\n' : realExecFileSync('git', args, { cwd: opts.cwd, encoding: 'utf8' }));
  const names = fs.readdirSync(r.dir).filter(f => f.endsWith('.cls'));
  const items = names.map(f => ({ type: 'ApexClass', name: f.slice(0, -4), filePath: path.join(r.dir, f), files: [path.join(r.dir, f)] }));
  git = {
    repositories: [repo({
      root: r.dir, branch, ...stateOf(r),
      diffWith: async (ref) => { diffed.push(ref); return r.g('diff', '--name-only', ref).split('\n').filter(Boolean).map(f => ({ uri: { fsPath: path.join(r.dir, f) } })); }
    })],
    onDidOpenRepository: () => ({ dispose() {} }), git: GIT_BIN
  };
  const p = provider(items);
  await p.s.postChangedComponents();
  return {
    keys: p.last().keys.slice().sort(), uncommitted: p.last().uncommitted.slice().sort(), diffed,
    note: p.last().note, commits: p.last().commits,
    mergeBase: gitRuns.some(x => x.args[0] === 'merge-base')
  };
}
const keysOf = (...files) => files.map(f => 'ApexClass:' + f.replace(/\.cls$/, '')).sort();

check('git agrees: merging main into the branch brings none of main\'s files into the view', async () => {
  const r = mkRepo();
  try {
    r.g('checkout', '-q', '-b', 'feature/acme');
    r.c('mine.cls', 'mine');
    r.g('checkout', '-q', 'main');
    r.c('theirs1.cls', 'theirs1');
    r.c('theirs2.cls', 'theirs2');
    r.g('checkout', '-q', 'feature/acme');
    r.g('merge', '-q', '--no-edit', 'main');
    const v = asProvider(r, 'feature/acme');
    assert.strictEqual(v.raw.length, 2, 'the fork point and the merged-in main tip');
    // The order the old code trusted: git prints the fork point first here, and a
    // diff against it reads everything main changed as this branch's work.
    assert.strictEqual(v.raw[0], r.fork);
    assert.ok(v.diffOf(r.fork).includes('theirs1.cls') && v.diffOf(r.fork).includes('theirs2.cls'));
    assert.deepStrictEqual(v.bases, [v.raw[1]], 'main\'s tip contains the fork point');
    assert.deepStrictEqual(v.shared, ['mine.cls']);
    const got = await viaProvider(r, 'feature/acme');
    assert.deepStrictEqual(got.keys, keysOf('mine.cls'), 'main\'s files leaked into the view');
    assert.deepStrictEqual(got.diffed, v.bases);
  } finally { r.done(); }
});

check('git agrees: a pushed sibling branch and main both merged in — no single boundary is right', async () => {
  const r = mkRepo();
  try {
    r.g('checkout', '-q', '-b', 'feature/acme');
    r.c('mine.cls', 'mine');
    r.g('checkout', '-q', '-b', 'feature/sibling', 'main');
    const sib = r.c('sib.cls', 'sibling');
    r.g('update-ref', 'refs/remotes/origin/feature/sibling', sib);
    r.g('checkout', '-q', 'main');
    r.c('t1.cls', 't1');
    r.g('checkout', '-q', 'feature/acme');
    r.g('merge', '-q', '--no-edit', 'feature/sibling');
    r.g('merge', '-q', '--no-edit', 'main');
    const v = asProvider(r, 'feature/acme');
    assert.strictEqual(v.bases.length, 2, 'the sibling\'s tip and main\'s tip, neither containing the other');
    // The mutation guard: whichever boundary is picked alone, the view is wrong.
    for (const b of v.raw) assert.notDeepStrictEqual(v.diffOf(b), ['mine.cls'], `diffing against ${b.slice(0, 7)} alone is the bug`);
    assert.deepStrictEqual(v.shared, ['mine.cls']);
    const got = await viaProvider(r, 'feature/acme');
    assert.deepStrictEqual(got.keys, keysOf('mine.cls'));
    assert.strictEqual(got.diffed.length, 2, 'one diff per independent boundary');
  } finally { r.done(); }
});

check('git agrees: a conflict resolved with an extra file in the merge commit — the extra file is listed', async () => {
  const r = mkRepo();
  try {
    r.g('checkout', '-q', '-b', 'feature/acme');
    r.c('shared.cls', 'feature side');
    r.g('checkout', '-q', 'main');
    r.c('shared.cls', 'main side');
    r.g('checkout', '-q', 'feature/acme');
    assert.throws(() => r.g('merge', '-q', '--no-edit', 'main'), 'the merge has to conflict');
    fs.writeFileSync(path.join(r.dir, 'shared.cls'), 'resolved\n');
    fs.writeFileSync(path.join(r.dir, 'extra.cls'), 'only in the merge commit\n');
    r.g('add', '.');
    r.g('commit', '-q', '-m', 'merge main');
    const v = asProvider(r, 'feature/acme');
    // A merge commit lists no files of its own, so extra.cls reaches the view only
    // through the diff — and it differs from the merged-in tip, so it stays.
    assert.deepStrictEqual(v.shared, ['extra.cls', 'shared.cls']);
    const got = await viaProvider(r, 'feature/acme');
    assert.deepStrictEqual(got.keys, keysOf('extra.cls', 'shared.cls'));
  } finally { r.done(); }
});

check('git agrees: main merged twice with own commits between — one tip is diffed, own files only', async () => {
  const r = mkRepo();
  try {
    r.g('checkout', '-q', '-b', 'feature/acme');
    r.c('mine.cls', 'mine');
    r.g('checkout', '-q', 'main');
    r.c('t1.cls', 't1');
    r.g('checkout', '-q', 'feature/acme');
    r.g('merge', '-q', '--no-edit', 'main');
    r.c('mine2.cls', 'mine two');
    r.g('checkout', '-q', 'main');
    r.c('t2.cls', 't2');
    r.g('checkout', '-q', 'feature/acme');
    r.g('merge', '-q', '--no-edit', 'main');
    const v = asProvider(r, 'feature/acme');
    assert.strictEqual(v.raw.length, 3, 'the fork point and both merged-in tips');
    assert.strictEqual(v.bases.length, 1, 'the later tip contains the others');
    assert.deepStrictEqual(v.shared, ['mine.cls', 'mine2.cls']);
    const got = await viaProvider(r, 'feature/acme');
    assert.deepStrictEqual(got.keys, keysOf('mine.cls', 'mine2.cls'));
    assert.strictEqual(got.diffed.length, 1, 'fifty merges of main must not mean fifty diffs');
    assert.ok(got.mergeBase);
  } finally { r.done(); }
});

check('git agrees: a rebase onto main (stale remote ref left behind) lists only the branch\'s own files', async () => {
  const r = mkRepo();
  try {
    r.g('checkout', '-q', '-b', 'feature/acme');
    const old = r.c('mine.cls', 'mine');
    r.g('update-ref', 'refs/remotes/origin/feature/acme', old);
    r.g('checkout', '-q', 'main');
    r.c('t1.cls', 't1');
    r.g('checkout', '-q', 'feature/acme');
    r.g('rebase', '-q', 'main');
    const v = asProvider(r, 'feature/acme');
    assert.strictEqual(v.raw.length, 1, 'one boundary: the tip it was rebased onto');
    assert.deepStrictEqual(v.shared, ['mine.cls']);
    const got = await viaProvider(r, 'feature/acme');
    assert.deepStrictEqual(got.keys, keysOf('mine.cls'));
    assert.strictEqual(got.mergeBase, false);
  } finally { r.done(); }
});

check('git agrees: a squash merge elsewhere and a fast-forward of main each keep the view on the branch\'s own work', async () => {
  const sq = mkRepo();
  try {
    sq.g('checkout', '-q', '-b', 'feature/acme');
    sq.c('mine.cls', 'mine');
    sq.g('checkout', '-q', 'main');
    sq.g('merge', '--squash', '-q', 'feature/acme');
    sq.g('commit', '-q', '-m', 'squash');
    sq.g('checkout', '-q', 'feature/acme');
    // The squash commit is a new commit: the branch's own is still in no other branch.
    assert.deepStrictEqual((await viaProvider(sq, 'feature/acme')).keys, keysOf('mine.cls'));
  } finally { sq.done(); }
  const ff = mkRepo();
  try {
    ff.g('checkout', '-q', '-b', 'feature/acme');
    ff.g('checkout', '-q', 'main');
    ff.c('t1.cls', 't1');
    ff.g('checkout', '-q', 'feature/acme');
    ff.g('merge', '-q', 'main'); // fast-forward: nothing of main's lands in the range
    ff.c('mine.cls', 'mine');
    assert.deepStrictEqual((await viaProvider(ff, 'feature/acme')).keys, keysOf('mine.cls'));
  } finally { ff.done(); }
});

check('git agrees: an edit on the branch to a file main brought in is still listed', async () => {
  const r = mkRepo();
  try {
    r.g('checkout', '-q', '-b', 'feature/acme');
    r.c('mine.cls', 'mine');
    r.g('checkout', '-q', 'main');
    r.c('t1.cls', 't1');
    r.g('checkout', '-q', 'feature/acme');
    r.g('merge', '-q', '--no-edit', 'main');
    r.c('t1.cls', 'edited on the branch');
    const got = await viaProvider(r, 'feature/acme');
    assert.deepStrictEqual(got.keys, keysOf('mine.cls', 't1.cls'), 'it differs from main\'s tip, so the intersection keeps it');
  } finally { r.done(); }
});

// A merge that is still open: `git merge main` stopped on a conflict, or run with
// --no-commit. There is no merge commit, so the merged-in tip is no boundary, and
// git has STAGED every file main brought in — they would read as this branch's
// uncommitted work, one click from a deploy.
/** feature/acme changed mine.cls and shared.cls; main changed shared.cls the other
 *  way and added t1.cls and t2.cls. Merging main conflicts on shared.cls. */
function conflictRepo(detach = false, pad = 0) {
  const r = mkRepo();
  r.c('shared.cls', 'shared');
  r.g('checkout', '-q', '-b', 'feature/acme');
  r.c('mine.cls', 'mine');
  r.c('shared.cls', 'feature side');
  for (let i = 0; i < pad; i++) r.g('commit', '-q', '--allow-empty', '-m', `pad ${i}`);
  r.g('checkout', '-q', 'main');
  r.c('shared.cls', 'main side');
  r.c('t1.cls', 't1');
  r.c('t2.cls', 't2');
  r.g('checkout', '-q', 'feature/acme');
  if (detach) r.g('checkout', '-q', '--detach'); // HEAD at the branch tip, no branch name
  assert.throws(() => r.g('merge', '-q', '--no-edit', 'main'), 'the merge has to conflict');
  return r;
}
const names = (files) => files.map(f => path.basename(f)).sort();

check('git agrees: a merge stopped on a conflict — your files and the conflicted one, none of main\'s clean ones', async () => {
  const r = conflictRepo();
  try {
    // The premise: git staged main's clean files and put the conflict in its own group.
    const st = stateOf(r);
    assert.deepStrictEqual(names(st.index), ['t1.cls', 't2.cls']);
    assert.deepStrictEqual(names(st.mergeChanges), ['shared.cls']);
    const got = await viaProvider(r, 'feature/acme');
    assert.deepStrictEqual(got.keys, keysOf('mine.cls', 'shared.cls'), 'main\'s staged files leaked into the view');
    assert.deepStrictEqual(got.uncommitted, keysOf('shared.cls'), 'the conflict is listed under Uncommitted');
    assert.deepStrictEqual(got.diffed, [r.g('rev-parse', 'MERGE_HEAD').trim()], 'the merged-in tip is the base; the fork point is its ancestor');
    // Resolved and staged, merge not yet committed: the resolution differs from main's
    // version of the file, so it is still listed; main's clean files still are not.
    fs.writeFileSync(path.join(r.dir, 'shared.cls'), 'resolved\n');
    r.g('add', 'shared.cls');
    const resolved = await viaProvider(r, 'feature/acme');
    assert.deepStrictEqual(resolved.keys, keysOf('mine.cls', 'shared.cls'));
    assert.deepStrictEqual(resolved.uncommitted, keysOf('shared.cls'));
  } finally { r.done(); }
});

check('git agrees: a merge run with --no-commit — main\'s staged files stay out', async () => {
  const r = mkRepo();
  try {
    r.g('checkout', '-q', '-b', 'feature/acme');
    r.c('mine.cls', 'mine');
    r.g('checkout', '-q', 'main');
    r.c('t1.cls', 't1');
    r.c('t2.cls', 't2');
    r.g('checkout', '-q', 'feature/acme');
    r.g('merge', '-q', '--no-commit', '--no-ff', 'main');
    assert.deepStrictEqual(names(stateOf(r).index), ['t1.cls', 't2.cls'], 'git staged them');
    const got = await viaProvider(r, 'feature/acme');
    assert.deepStrictEqual(got.keys, keysOf('mine.cls'));
    assert.deepStrictEqual(got.uncommitted, []);
  } finally { r.done(); }
});

check('git agrees: aborting the merge puts the view back to the plain branch answer', async () => {
  const r = conflictRepo();
  try {
    const open = await viaProvider(r, 'feature/acme');
    assert.deepStrictEqual(open.keys, keysOf('mine.cls', 'shared.cls'));
    assert.deepStrictEqual(open.uncommitted, keysOf('shared.cls'));
    r.g('merge', '--abort');
    const v = asProvider(r, 'feature/acme');
    assert.deepStrictEqual(v.bases, [r.g('merge-base', 'HEAD', 'main').trim()], 'the fork point again');
    const got = await viaProvider(r, 'feature/acme');
    assert.deepStrictEqual(got.keys, keysOf('mine.cls', 'shared.cls'));
    assert.deepStrictEqual(got.uncommitted, [], 'nothing is left uncommitted');
    assert.deepStrictEqual(got.diffed, v.bases);
    assert.strictEqual(got.mergeBase, false);
  } finally { r.done(); }
});

check('git agrees: a merge open on a branch with no commits of its own — only your edits show', async () => {
  const r = mkRepo();
  try {
    r.g('checkout', '-q', '-b', 'feature/acme');
    r.g('checkout', '-q', 'main');
    r.c('t1.cls', 't1');
    r.c('t2.cls', 't2');
    r.g('checkout', '-q', 'feature/acme');
    r.g('merge', '-q', '--no-commit', '--no-ff', 'main');
    // Your work on top of the open merge: a new file, and a further edit of one main brought in.
    fs.writeFileSync(path.join(r.dir, 'own.cls'), 'own\n');
    fs.writeFileSync(path.join(r.dir, 't1.cls'), 'edited on the branch\n');
    r.g('add', 't1.cls');
    const got = await viaProvider(r, 'feature/acme');
    assert.deepStrictEqual(got.uncommitted, keysOf('own.cls', 't1.cls'), 't2.cls is main\'s and equals the tip being merged');
    assert.deepStrictEqual(got.keys, keysOf('own.cls', 't1.cls'));
    assert.strictEqual(got.diffed.length, 1);
  } finally { r.done(); }
});

check('git agrees: a merge open on a branch cut from a teammate\'s branch — what the teammate added stays out', async () => {
  const r = mkRepo();
  try {
    r.g('checkout', '-q', '-b', 'teammate/acme');
    r.c('tm1.cls', 'tm1');
    r.g('checkout', '-q', '-b', 'feature/acme'); // no commits of its own
    r.g('checkout', '-q', 'main');
    r.c('t1.cls', 't1');
    r.c('t2.cls', 't2');
    r.g('checkout', '-q', 'feature/acme');
    assert.deepStrictEqual((await viaProvider(r, 'feature/acme')).keys, [], 'before the merge: nothing');
    r.g('merge', '-q', '--no-commit', '--no-ff', 'main');
    assert.deepStrictEqual(names(stateOf(r).index), ['t1.cls', 't2.cls'], 'git staged main\'s files');
    const open = await viaProvider(r, 'feature/acme');
    assert.deepStrictEqual(open.keys, [], 'against MERGE_HEAD alone tm1.cls, which HEAD has and main lacks, would show');
    assert.deepStrictEqual(open.uncommitted, []);
    assert.deepStrictEqual(open.diffed.slice().sort(), [r.g('rev-parse', 'HEAD').trim(), r.g('rev-parse', 'MERGE_HEAD').trim()].sort(),
      'HEAD is a base beside MERGE_HEAD');
    r.g('commit', '-q', '--no-edit');
    assert.deepStrictEqual((await viaProvider(r, 'feature/acme')).keys, [], 'committed: still nothing');
  } finally { r.done(); }
});

check('git agrees: a conflicted merge on a detached HEAD at the branch tip — only the conflict shows', async () => {
  const r = conflictRepo(true);
  try {
    assert.strictEqual(r.g('branch', '--show-current').trim(), '', 'detached');
    const got = await viaProvider(r, null);
    assert.deepStrictEqual(got.keys, keysOf('shared.cls'), 'mine.cls is on the branch HEAD sits at; against MERGE_HEAD alone it would show with no section');
    assert.deepStrictEqual(got.uncommitted, keysOf('shared.cls'));
  } finally { r.done(); }
});

// The branch gives up: more than MAX_BRANCH_COMMITS commits of its own, the usual
// state on an integration branch that main is merged back into. The view is then
// the uncommitted answer alone, and an open merge's staged files must stay out of it.
check('git agrees: a conflicted merge on a branch past the commit limit — the conflict only, the fallback note kept', async () => {
  const r = conflictRepo(false, MAX_BRANCH_COMMITS);
  try {
    assert.strictEqual(parseBoundary(r.g(...boundaryArgs({ branch: 'feature/acme' }))).count, MAX_BRANCH_COMMITS + 1, 'past the limit');
    assert.deepStrictEqual(names(stateOf(r).index), ['t1.cls', 't2.cls'], 'git staged main\'s files');
    const got = await viaProvider(r, 'feature/acme');
    assert.deepStrictEqual(got.keys, keysOf('shared.cls'), 'main\'s staged files leaked into the view, or committed work was added');
    assert.deepStrictEqual(got.uncommitted, keysOf('shared.cls'));
    assert.deepStrictEqual(got.commits, []);
    assert.deepStrictEqual(got.diffed, [r.g('rev-parse', 'MERGE_HEAD').trim()], 'the tip is diffed once, only to filter the index');
    assert.ok(got.note && got.note.includes('changedBaseRef'), 'the header still says it is uncommitted only');
  } finally { r.done(); }
});

check('git agrees: a --no-commit merge on a branch past the commit limit — main\'s staged files stay out, your own edits show', async () => {
  const r = mkRepo();
  try {
    r.g('checkout', '-q', '-b', 'devInt');
    r.c('own.cls', 'own');
    for (let i = 0; i < MAX_BRANCH_COMMITS; i++) r.g('commit', '-q', '--allow-empty', '-m', `pad ${i}`);
    r.g('checkout', '-q', 'main');
    r.c('t1.cls', 't1');
    r.c('t2.cls', 't2');
    r.g('checkout', '-q', 'devInt');
    r.g('merge', '-q', '--no-commit', '--no-ff', 'main');
    assert.deepStrictEqual(names(stateOf(r).index), ['t1.cls', 't2.cls'], 'git staged them');
    // Your work on top of the open merge: an unstaged edit, and a staged edit of a file main brought in.
    fs.writeFileSync(path.join(r.dir, 'own.cls'), 'edited\n');
    fs.writeFileSync(path.join(r.dir, 't1.cls'), 'edited on the branch\n');
    r.g('add', 't1.cls');
    const got = await viaProvider(r, 'devInt');
    assert.deepStrictEqual(got.uncommitted, keysOf('own.cls', 't1.cls'), 't2.cls is main\'s and equals the tip being merged');
    assert.deepStrictEqual(got.keys, keysOf('own.cls', 't1.cls'));
    assert.deepStrictEqual(got.commits, []);
    assert.strictEqual(got.diffed.length, 1);
    assert.ok(got.note, 'the fallback note is still there');
    // Committed: the merge is a commit and the range is still past the limit, so what is
    // left is the unstaged edit alone.
    r.g('commit', '-q', '--no-edit');
    const done = await viaProvider(r, 'devInt');
    assert.deepStrictEqual(done.keys, keysOf('own.cls'), 'only the unstaged edit, nothing of main\'s');
  } finally { r.done(); }
});

// A `git pull`: the merge is of the branch's OWN remote, which already holds the
// work pushed from here, a teammate's commits on top and, optionally, a merge of
// main. All of it is this branch's work — MERGE_HEAD must not become the base, or
// every own file only the older commits touched drops out and, with more commits
// than the section cap, shows nowhere. The pull stops on a conflict.
function pullRepo(own, remoteMergedMain, pad = 0, editOwn, editX, teammateEditsOwn) {
  const r = mkRepo();
  r.c('shared.cls', 'shared');
  r.c('x.cls', 'x0');
  r.fork = r.g('rev-parse', 'HEAD').trim();
  r.g('checkout', '-q', '-b', 'feature/acme');
  for (let i = 0; i < own; i++) r.c(`own${i}.cls`, `own ${i}`);
  if (editX) r.c('x.cls', 'x1 mine'); // pushed too; main never touches x.cls
  for (let i = 0; i < pad; i++) r.g('commit', '-q', '--allow-empty', '-m', `pad ${i}`);
  const pushed = r.pushed = r.g('rev-parse', 'HEAD').trim();
  r.g('checkout', '-q', 'main');
  r.mainTip = r.c('t1.cls', 't1'); // after the fork point, and never merged here
  r.g('checkout', '-q', '-b', 'teammate', pushed);
  r.c('shared.cls', 'teammate side');
  r.c('tm.cls', 'teammate');
  if (teammateEditsOwn) r.c(`${editOwn}.cls`, 'teammate edit'); // conflicts with the local edit below
  if (remoteMergedMain) r.g('merge', '-q', '--no-edit', 'main');
  r.g('update-ref', 'refs/remotes/origin/feature/acme', r.g('rev-parse', 'HEAD').trim());
  r.g('checkout', '-q', 'feature/acme');
  r.g('branch', '-D', 'teammate');
  r.c('shared.cls', 'my local side');
  r.c('local.cls', 'local');
  if (editOwn) r.c(`${editOwn}.cls`, 'edited locally, not pushed');
  assert.throws(() => r.g('merge', '-q', '--no-edit', 'origin/feature/acme'), 'the pull has to conflict');
  return r;
}

check('git agrees: only a merge of the branch\'s own remote has MERGE_HEAD in the range', () => {
  const pull = pullRepo(3, false);
  try {
    const mergeHead = pull.g('rev-parse', 'MERGE_HEAD').trim();
    const range = parseBoundary(pull.g(...boundaryArgs({ branch: 'feature/acme', tips: ['HEAD', mergeHead] })));
    assert.ok(range.listed.includes(mergeHead), 'the remote\'s tip is this branch\'s own commit');
    assert.deepStrictEqual(range.bases, [pull.fork], 'and the fork point is the only boundary');
  } finally { pull.done(); }
  const main = conflictRepo();
  try {
    const mergeHead = main.g('rev-parse', 'MERGE_HEAD').trim();
    const range = parseBoundary(main.g(...boundaryArgs({ branch: 'feature/acme', tips: ['HEAD', mergeHead] })));
    assert.ok(!range.listed.includes(mergeHead) && !range.bases.includes(mergeHead), 'main\'s tip is in neither list');
    assert.deepStrictEqual(range.count, 2, 'and the range is the branch\'s own two commits');
  } finally { main.done(); }
});

check('git agrees: a pull stopped on a conflict, past the section cap — every own file shows, and what the pull brought in', async () => {
  const own = COMMIT_CAP + 5;
  const r = pullRepo(own, false);
  try {
    const ownFiles = Array.from({ length: own }, (_, i) => `own${i}.cls`);
    const st = stateOf(r);
    assert.deepStrictEqual(names(st.index), ['tm.cls'], 'git staged the teammate\'s new file');
    assert.deepStrictEqual(names(st.mergeChanges), ['shared.cls']);
    const got = await viaProvider(r, 'feature/acme');
    assert.strictEqual(got.commits.length, COMMIT_CAP, 'the sections stop at the cap');
    assert.ok(!got.commits.some(c => c.keys.includes('ApexClass:own0')), 'so own0 is in no section');
    assert.deepStrictEqual(got.keys, keysOf(...ownFiles, 'local.cls', 'shared.cls', 'tm.cls'), 'own files only the older commits touched vanished');
    assert.deepStrictEqual(got.uncommitted, keysOf('shared.cls', 'tm.cls'), 'the conflict and the teammate\'s staged file');
    assert.deepStrictEqual(got.diffed, [r.fork], 'the fork point, not MERGE_HEAD');
    // Resolved and committed: the same view, now with the teammate's file in a section.
    fs.writeFileSync(path.join(r.dir, 'shared.cls'), 'resolved\n');
    r.g('add', 'shared.cls');
    r.g('commit', '-q', '--no-edit');
    const done = await viaProvider(r, 'feature/acme');
    assert.deepStrictEqual(done.keys, got.keys);
    assert.deepStrictEqual(done.uncommitted, []);
  } finally { r.done(); }
});

check('git agrees: a pull of a remote that merged main — main\'s files stay out, the teammate\'s and your own stay in', async () => {
  const own = COMMIT_CAP + 5;
  const r = pullRepo(own, true);
  try {
    const ownFiles = Array.from({ length: own }, (_, i) => `own${i}.cls`);
    // Premise: main's t1.cls came in with the pull, staged beside the teammate's file.
    assert.deepStrictEqual(names(stateOf(r).index), ['t1.cls', 'tm.cls']);
    // Your own staged edit on top of the open pull.
    fs.writeFileSync(path.join(r.dir, 'own3.cls'), 'edited\n');
    r.g('add', 'own3.cls');
    const got = await viaProvider(r, 'feature/acme');
    assert.deepStrictEqual(got.keys, keysOf(...ownFiles, 'local.cls', 'shared.cls', 'tm.cls'), 'main\'s t1.cls leaked, or an own file went missing');
    assert.deepStrictEqual(got.uncommitted, keysOf('own3.cls', 'shared.cls', 'tm.cls'));
    assert.deepStrictEqual(got.diffed, [r.mainTip], 'main\'s tip, which the remote merged, is the base; MERGE_HEAD is not');
    r.g('add', '.');
    r.g('commit', '-q', '-m', 'merge origin');
    assert.deepStrictEqual((await viaProvider(r, 'feature/acme')).keys, got.keys, 'committed: the same view');
  } finally { r.done(); }
});

// The same pull on a branch past the commit limit (an integration branch): the view is
// the uncommitted answer alone, and what the remote merged in from main is still staged.
check('git agrees: a pull of a remote that merged main, on a branch past the commit limit — main\'s staged files stay out', async () => {
  const r = pullRepo(4, true, MAX_BRANCH_COMMITS);
  try {
    assert.strictEqual(parseBoundary(r.g(...boundaryArgs({ branch: 'feature/acme', tips: ['HEAD', r.g('rev-parse', 'MERGE_HEAD').trim()] }))).count,
      MAX_BRANCH_COMMITS + 1, 'past the limit');
    // The premise: main's t1.cls came in with the pull, staged beside the teammate's file.
    assert.deepStrictEqual(names(stateOf(r).index), ['t1.cls', 'tm.cls']);
    // Your own staged edit on top of the open pull, and an unstaged one.
    fs.writeFileSync(path.join(r.dir, 'own3.cls'), 'edited\n');
    r.g('add', 'own3.cls');
    fs.writeFileSync(path.join(r.dir, 'own1.cls'), 'edited too\n');
    const got = await viaProvider(r, 'feature/acme');
    assert.deepStrictEqual(got.uncommitted, keysOf('own1.cls', 'own3.cls', 'shared.cls', 'tm.cls'), 'main\'s t1.cls leaked, or the teammate\'s file went missing');
    assert.deepStrictEqual(got.keys, got.uncommitted, 'uncommitted only');
    assert.deepStrictEqual(got.commits, []);
    assert.ok(got.note && got.note.includes('changedBaseRef'), 'the header still says it is uncommitted only');
    assert.deepStrictEqual(got.diffed, [r.mainTip], 'main\'s tip, just outside what the pull brings in; the pushed commit is HEAD\'s own and MERGE_HEAD is not diffed');
  } finally { r.done(); }
  // A remote that merged nothing: its one boundary is the pushed commit, HEAD's own
  // ancestor, so there is nothing to filter and nothing is diffed.
  const plain = pullRepo(4, false, MAX_BRANCH_COMMITS);
  try {
    fs.writeFileSync(path.join(plain.dir, 'own3.cls'), 'edited\n');
    plain.g('add', 'own3.cls');
    const got = await viaProvider(plain, 'feature/acme');
    assert.deepStrictEqual(got.uncommitted, keysOf('own3.cls', 'shared.cls', 'tm.cls'));
    assert.deepStrictEqual(got.diffed, []);
    assert.ok(got.note);
  } finally { plain.done(); }
});

// On a give-up branch an open merge or pull leaves nothing to list a staged file again,
// so a file you put back to the version the OTHER side has is only the merge's if that
// side changed it. M1: a pull, own3.cls edited in a local commit and staged back to the
// pushed version (an ancestor of HEAD, so it is no other lineage). M3: a merge of main,
// x.cls edited in a local commit and staged back to the older version main still has.
// N5: M3 on a pull whose remote merged main.
check('git agrees: a pull past the commit limit — a file you stage back to its pushed version still shows', async () => {
  // teammateEdits: the teammate edited it on top of the pushed commit, so the pull changed it
  // too, and you resolved it back to the pushed version. Only that commit being HEAD's own
  // ancestor keeps it from reading as the pull's.
  for (const [mergedMain, teammateEdits] of [[false, true], [true, true], [false, false], [true, false]]) {
    const r = pullRepo(4, mergedMain, MAX_BRANCH_COMMITS, 'own3', false, teammateEdits);
    try {
      fs.writeFileSync(path.join(r.dir, 'own3.cls'), 'own 3\n'); // the pushed version
      r.g('add', 'own3.cls');
      assert.deepStrictEqual(names(stateOf(r).index), mergedMain ? ['own3.cls', 't1.cls', 'tm.cls'] : ['own3.cls', 'tm.cls']);
      const got = await viaProvider(r, 'feature/acme');
      assert.deepStrictEqual(got.uncommitted, keysOf('own3.cls', 'shared.cls', 'tm.cls'), `mergedMain=${mergedMain} teammateEdits=${teammateEdits}: own3.cls equals the pushed commit and was dropped, or main\'s t1.cls leaked`);
      assert.deepStrictEqual(got.keys, got.uncommitted, 'uncommitted only');
      assert.deepStrictEqual(got.diffed, mergedMain ? [r.mainTip] : [], 'the pushed commit is never diffed');
      assert.ok(got.note);
    } finally { r.done(); }
  }
});

// The fork-point version of x.cls is main's tip's version too, so a diff against the tip alone
// drops it; the pull never changed it.
check('git agrees: a pull past the commit limit — your own file staged back to the fork-point version still shows, main\'s t1.cls does not', async () => {
  for (const mergedMain of [false, true]) {
    const r = pullRepo(4, mergedMain, MAX_BRANCH_COMMITS, undefined, true);
    try {
      fs.writeFileSync(path.join(r.dir, 'x.cls'), 'x0\n'); // main\'s version too
      r.g('add', 'x.cls');
      assert.deepStrictEqual(names(stateOf(r).index), mergedMain ? ['t1.cls', 'tm.cls', 'x.cls'] : ['tm.cls', 'x.cls']);
      const got = await viaProvider(r, 'feature/acme');
      assert.deepStrictEqual(got.uncommitted, keysOf('shared.cls', 'tm.cls', 'x.cls'), `mergedMain=${mergedMain}: x.cls equals main\'s tip and was dropped, or main\'s t1.cls leaked`);
      assert.deepStrictEqual(got.keys, got.uncommitted, 'uncommitted only');
      assert.deepStrictEqual(got.diffed, mergedMain ? [r.mainTip] : [], 'the pushed commit is never diffed');
      assert.ok(got.note);
    } finally { r.done(); }
  }
});

check('git agrees: a merge of main past the commit limit — a revert of your own change to a file main never touched still shows', async () => {
  const r = mkRepo();
  try {
    r.c('shared.cls', 'shared');
    r.c('x.cls', 'x0');
    r.g('checkout', '-q', '-b', 'feature/acme');
    r.c('x.cls', 'x1 mine');
    r.c('shared.cls', 'feature side');
    for (let i = 0; i < MAX_BRANCH_COMMITS; i++) r.g('commit', '-q', '--allow-empty', '-m', `pad ${i}`);
    r.g('checkout', '-q', 'main');
    r.c('shared.cls', 'main side');
    r.c('t1.cls', 't1');
    r.g('checkout', '-q', 'feature/acme');
    assert.throws(() => r.g('merge', '-q', '--no-edit', 'main'), 'the merge has to conflict');
    fs.writeFileSync(path.join(r.dir, 'x.cls'), 'x0\n'); // main\'s version too: it never touched x.cls
    r.g('add', 'x.cls');
    assert.deepStrictEqual(names(stateOf(r).index), ['t1.cls', 'x.cls']);
    const got = await viaProvider(r, 'feature/acme');
    assert.deepStrictEqual(got.uncommitted, keysOf('shared.cls', 'x.cls'), 'x.cls equals the tip being merged and was dropped, or main\'s t1.cls leaked');
    assert.deepStrictEqual(got.keys, got.uncommitted, 'uncommitted only');
    assert.deepStrictEqual(got.diffed, [r.g('rev-parse', 'MERGE_HEAD').trim()]);
    assert.ok(got.note);
  } finally { r.done(); }
});

// A rebase stopped on a conflict: HEAD is detached at the tip being rebased onto
// plus the commits replayed so far, REBASE_HEAD names the one that stopped, and there
// is no MERGE_HEAD. The range holds only the replayed work and the boundary is main's
// tip, so nothing main changed can reach the view.
check('git agrees: a rebase stopped on a conflict — the replayed own work and the conflicted file, nothing from main', async () => {
  for (const replayedFirst of [true, false]) {
    const r = mkRepo();
    try {
      r.c('shared.cls', 'shared');
      r.g('checkout', '-q', '-b', 'feature/acme');
      if (replayedFirst) r.c('mine.cls', 'mine');
      r.c('shared.cls', 'feature side');
      r.g('checkout', '-q', 'main');
      r.c('shared.cls', 'main side');
      r.c('t1.cls', 't1');
      r.c('t2.cls', 't2');
      r.g('checkout', '-q', 'feature/acme');
      assert.throws(() => r.g('rebase', '-q', 'main'), 'the rebase has to stop on the conflict');
      assert.ok(fs.existsSync(path.join(r.dir, '.git', 'rebase-merge')), 'a rebase is open');
      assert.throws(() => r.g('rev-parse', '-q', '--verify', 'MERGE_HEAD'), 'and it is no merge');
      assert.strictEqual(r.g('branch', '--show-current').trim(), '', 'detached');
      assert.deepStrictEqual(names(stateOf(r).mergeChanges), ['shared.cls']);
      const got = await viaProvider(r, null);
      // With the first commit replayed it is the range itself (a commit section and a
      // diff against main's tip); without, the range is empty and the conflict is all there is.
      assert.deepStrictEqual(got.keys, replayedFirst ? keysOf('mine.cls', 'shared.cls') : keysOf('shared.cls'), `replayedFirst=${replayedFirst}: main's files leaked into the view`);
      assert.deepStrictEqual(got.uncommitted, keysOf('shared.cls'));
      assert.strictEqual(got.mergeBase, false);
      assert.strictEqual(got.diffed.length, replayedFirst ? 1 : 0);
    } finally { r.done(); }
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
