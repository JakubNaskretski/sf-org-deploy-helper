// Pure helpers behind the Changed view's commit sections: the argv for the one
// `git log` the provider spawns, and the parser for its output. No vscode and no
// child_process here on purpose — the provider owns the spawn, this file is what
// the harness can drive directly.

/** How many commits the Changed view lists as sections. Everything the base diff
 *  reports beyond them still shows, collected under one "earlier commits" group,
 *  so the cap hides history — never a component. */
export const COMMIT_CAP = 20;

/** Past this many commits of its own, a checkout is not "a branch of work" — it is
 *  a trunk with a stale branch somewhere behind it, and diffing the whole span
 *  would fill the view with the team's history. The view falls back to
 *  uncommitted-only there and says so. */
export const MAX_BRANCH_COMMITS = 100;

/** Record and field separators for the log format. Both are control characters
 *  git will not emit inside a hash, a timestamp or a one-line subject, so the
 *  parse cannot be confused by a commit message. */
const RS = '\x1e';
const FS = '\x1f';

export interface CommitInfo {
  hash: string;
  /** First 7 of `hash` — what the section header shows. */
  short: string;
  /** Committer date, seconds since the epoch; sorts commits across repositories. */
  when: number;
  subject: string;
  /** Repository-relative paths the commit touched (empty for a merge commit:
   *  `--name-only` reports no files for one without `-m`). */
  files: string[];
}

/** argv for the single `git log` the Changed view runs.
 *
 *  `baseRef` set — the explicit `changedBaseRef` case: the commits in
 *  `<base>..HEAD`, i.e. "what this branch adds on top of that ref".
 *
 *  `baseRef` undefined — the automatic case: the commits reachable from HEAD
 *  that NO other branch contains, local or remote. That is the flow-agnostic
 *  read of "my branch": it needs no idea of which branch is the integration one
 *  (main, devInt, develop — whatever this repo uses), and a pushed branch does
 *  not empty it, because the branch's own remote ref is excluded by name.
 *  Detached HEAD has no name to exclude, so nothing is. */
export function commitLogArgs(opts: { baseRef?: string; branch?: string; cap?: number }): string[] {
  const cap = opts.cap ?? COMMIT_CAP;
  const args = [
    'log',
    // --no-show-signature: with log.showSignature=true a signed commit prepends
    // gpg output, which would land in the -z stream as junk paths.
    '--no-show-signature',
    `--format=${RS}%H${FS}%ct${FS}%s`,
    '--name-only',
    '-z',
    '-n', String(cap)
  ];
  return args.concat(rangeArgs(opts));
}

/** The range itself, shared by the commit listing and the boundary query. */
function rangeArgs(opts: { baseRef?: string; branch?: string }): string[] {
  if (opts.baseRef) return [`${opts.baseRef}..HEAD`];
  const args = ['HEAD', '--not'];
  // Each --exclude applies to the ONE following --branches/--remotes, hence the
  // interleaving; the globs drop this branch and its remote counterparts so the
  // range isn't emptied by its own tips. The patterns are matched with the
  // refs/heads/ and refs/remotes/ prefixes REMOVED — spelling them out matches
  // nothing, and git then quietly reports no commits at all.
  if (opts.branch) args.push(`--exclude=${opts.branch}`);
  args.push('--branches');
  if (opts.branch) args.push(`--exclude=*/${opts.branch}`);
  args.push('--remotes');
  return args;
}

/** argv for the cheap question asked BEFORE the commit listing: where does this
 *  branch join the rest of the repository, and how far back is that? Hashes only
 *  — no file lists — so it stays cheap even on a long range, and it is NOT capped:
 *  a cap here would move the diff base and drop components from the view
 *  entirely, which is the one thing the section cap must never do. */
export function boundaryArgs(opts: { baseRef?: string; branch?: string }): string[] {
  return ['rev-list', '--boundary'].concat(rangeArgs(opts));
}

/** Read `rev-list --boundary`: `-<hash>` lines are the commits just OUTSIDE the
 *  range (where this branch joins the others), the rest are the range itself.
 *
 *  `base` is the first boundary — the point to diff the working tree against so
 *  the view covers every commit of this branch, listed or capped away. No
 *  boundary at all means the range runs to the root: this branch is the whole
 *  repository (a trunk-only checkout), which is not "this branch's work" — the
 *  caller then shows uncommitted changes only.
 *  ponytail: with several boundaries (a branch merged in) the first one is used,
 *  so the diff can be a little wider than this branch alone; the sections still
 *  say where each component came from. */
export function parseBoundary(stdout: string): { count: number; base?: string } {
  let count = 0;
  let base: string | undefined;
  for (const line of stdout.split('\n')) {
    const hash = line.trim();
    if (!hash) continue;
    if (hash.startsWith('-')) { if (!base) base = hash.slice(1); continue; }
    count++;
  }
  return { count, base };
}

/** Parse the output of `commitLogArgs`. Shape per commit: RS, then
 *  `hash FS ct FS subject`, then a NUL-separated file list (`-z`
 *  keeps paths unquoted and unescaped, so a space or a non-ASCII name survives).
 *  Anything malformed is skipped rather than throwing — this feeds a view. */
export function parseCommitLog(stdout: string): CommitInfo[] {
  const out: CommitInfo[] = [];
  for (const chunk of stdout.split(RS)) {
    if (!chunk) continue;
    const parts = chunk.split('\0');
    const head = parts[0].split(FS);
    if (head.length < 3) continue;
    const [hash, ct] = head;
    if (!/^[0-9a-f]{7,40}$/.test(hash)) continue;
    out.push({
      hash,
      short: hash.slice(0, 7),
      when: Number(ct) || 0,
      // A subject may itself contain FS only if someone wrote one; re-join so it
      // survives intact.
      subject: head.slice(2).join(FS).replace(/\n/g, ' ').trim(),
      // The format line ends in a newline before the first path; trailing empties
      // come from the final NUL.
      files: parts.slice(1).map(p => p.replace(/^\n+/, '')).filter(Boolean)
    });
  }
  return out;
}

/** The diff base for a `--boundary` answer, or undefined when the view should
 *  stay uncommitted-only: nothing of this branch's own, no boundary to diff
 *  against (a trunk-only checkout), or more commits than MAX_BRANCH_COMMITS —
 *  at which point "this branch" is someone's trunk, not a piece of work. */
export function baseFromBoundary(b: { count: number; base?: string }): string | undefined {
  // An empty range and an unbounded one both leave `base` undefined, which IS the
  // fallback — the length is the only extra question worth asking.
  if (b.count > MAX_BRANCH_COMMITS) return undefined;
  return b.base;
}
