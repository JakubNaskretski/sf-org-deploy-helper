// Pure helpers behind the Changed view's commit sections: the argv for the one
// `git log` the provider spawns, and the parser for its output. No vscode and no
// child_process here on purpose — the provider owns the spawn, this file is what
// the harness can drive directly.

/** How many commits the Changed view lists as sections. Everything the base diff
 *  reports beyond them still shows, collected under one "earlier commits" group,
 *  so the cap hides history — never a component. */
export const COMMIT_CAP = 20;

/** `git`'s empty tree. Stands in as the diff base when the oldest listed commit
 *  is the repository's root commit (it has no parent to diff against). */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

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
  /** First parent, or '' for a root commit. */
  parent: string;
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
    `--format=${RS}%H${FS}%ct${FS}%P${FS}%s`,
    '--name-only',
    '-z',
    '-n', String(cap)
  ];
  if (opts.baseRef) {
    args.push(`${opts.baseRef}..HEAD`);
    return args;
  }
  args.push('HEAD', '--not');
  // Each --exclude applies to the ONE following --branches/--remotes, hence the
  // interleaving; the globs drop this branch and its remote counterparts so the
  // range isn't emptied by its own tips.
  if (opts.branch) args.push(`--exclude=refs/heads/${opts.branch}`);
  args.push('--branches');
  if (opts.branch) args.push(`--exclude=refs/remotes/*/${opts.branch}`);
  args.push('--remotes');
  return args;
}

/** Parse the output of `commitLogArgs`. Shape per commit: RS, then
 *  `hash FS ct FS parents FS subject`, then a NUL-separated file list (`-z`
 *  keeps paths unquoted and unescaped, so a space or a non-ASCII name survives).
 *  Anything malformed is skipped rather than throwing — this feeds a view. */
export function parseCommitLog(stdout: string): CommitInfo[] {
  const out: CommitInfo[] = [];
  for (const chunk of stdout.split(RS)) {
    if (!chunk) continue;
    const parts = chunk.split('\0');
    const head = parts[0].split(FS);
    if (head.length < 4) continue;
    const [hash, ct, parents] = head;
    if (!/^[0-9a-f]{7,40}$/.test(hash)) continue;
    out.push({
      hash,
      short: hash.slice(0, 7),
      when: Number(ct) || 0,
      parent: (parents || '').trim().split(' ')[0] || '',
      // A subject may itself contain FS only if someone wrote one; re-join so it
      // survives intact.
      subject: head.slice(3).join(FS).replace(/\n/g, ' ').trim(),
      // The format line ends in a newline before the first path; trailing empties
      // come from the final NUL.
      files: parts.slice(1).map(p => p.replace(/^\n+/, '')).filter(Boolean)
    });
  }
  return out;
}

/** The ref to diff the working tree against so the view shows every listed
 *  commit plus the uncommitted edits on top: the parent of the OLDEST listed
 *  commit (the empty tree when that is a root commit). Undefined when there are
 *  no commits — the view is then uncommitted-only, as before. */
export function baseRefForCommits(commits: CommitInfo[]): string | undefined {
  if (commits.length === 0) return undefined;
  const oldest = commits[commits.length - 1];
  return oldest.parent || EMPTY_TREE;
}
