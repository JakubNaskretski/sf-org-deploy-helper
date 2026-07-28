import * as path from 'path';
import { foldPathKey } from './metadataScanner';

/**
 * Decision logic for the workspace file watcher that keeps the panel's item list
 * honest when files are created or deleted OUTSIDE the extension's own
 * operations (a new Apex class, a `git checkout`, a deleted component).
 *
 * Everything here is pure or timer-injected, so the parts that actually decide
 * something — which directories to watch, whether a path can change the item
 * list, how many notifications collapse into one rescan — are testable without
 * an extension host (scripts/check-file-watch.cjs). The `vscode` watcher API
 * itself is not: only VS Code can emit real create/delete events, and its glob
 * semantics are its own. The provider side of the wiring (one watcher per
 * package dir, disposal on root change) is pinned against a stub in the same
 * script; the event delivery behind it is taken on faith.
 */

/** One `vscode.RelativePattern` worth of watching: a package directory and the
 *  glob applied below it. */
export interface WatchTarget {
  /** Absolute directory the watcher is anchored at. */
  base: string;
  /** Glob relative to `base`. */
  pattern: string;
}

/** Everything below a package directory is watched. Narrowing this to metadata
 *  extensions would miss the cases the watcher exists for: a brand-new bundle
 *  folder, a component whose sidecar arrives before its source, a metadata
 *  folder no static rule covers yet. `affectsItemList` filters the noise
 *  instead, and a rescan is a filesystem walk — the cost of an occasional
 *  needless one is far below the cost of a tree that lies. */
const WATCH_GLOB = '**/*';

/** Directory names the scanner refuses to walk (metadataScanner.SKIP_DIRS plus
 *  every dot-directory). A path inside one can never produce or remove an item,
 *  so an event about it must not cost a rescan — `.git` alone would otherwise
 *  fire hundreds of times per checkout, which is exactly the burst the debounce
 *  is meant to survive. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.sfdx', '.localdevserver']);

/** Editor/OS scratch files that appear and vanish next to real sources. They
 *  are never metadata, and vim/emacs write them on every save. */
const TRANSIENT_SUFFIXES = ['~', '.swp', '.swx', '.tmp'];

/** Resolve the package directories of a discovered project into watcher targets.
 *
 * - relative package paths resolve against the project root (`sfdx-project.json`
 *   writes them relative; an absolute one is honored as given),
 * - duplicates collapse, and a directory already covered by another listed one
 *   (`force-app` + `force-app/main`) is dropped — two overlapping watchers
 *   deliver every event twice for no added coverage,
 * - the result is ordered so a re-resolution that found the same directories
 *   produces the same `watchTargetsKey` (see below).
 */
export function watchTargets(root: string | undefined, packageDirs: string[], platform: NodeJS.Platform = process.platform): WatchTarget[] {
  if (!root) return [];
  const bases: string[] = [];
  const seen = new Set<string>();
  for (const dir of packageDirs) {
    if (typeof dir !== 'string') continue;
    const trimmed = dir.trim();
    if (!trimmed) continue;
    const base = path.normalize(path.resolve(root, trimmed));
    const key = foldPathKey(base, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    bases.push(base);
  }
  return bases
    .filter(base => !bases.some(other => other !== base && isInside(base, other, platform)))
    .sort((a, b) => foldPathKey(a, platform).localeCompare(foldPathKey(b, platform)))
    .map(base => ({ base, pattern: WATCH_GLOB }));
}

/** Identity of a watcher set. The provider compares this before tearing watchers
 *  down: every scan re-resolves the package dirs, and re-creating identical
 *  watchers on each one would drop live registrations for no reason. */
export function watchTargetsKey(targets: WatchTarget[], platform: NodeJS.Platform = process.platform): string {
  return targets.map(t => `${foldPathKey(t.base, platform)}\u0000${t.pattern}`).join('\u001f');
}

/** Can a created/deleted path change the scanned item list?
 *
 * Deliberately permissive: it rejects only what the scanner provably ignores
 * (skip-directories, dot-files) and what is provably scratch (editor temp
 * files). Anything else — an unknown extension, a folder, a file under a
 * metadata type no rule covers yet — is treated as relevant, because the
 * alternative is re-deriving the scanner's rule table here and going stale
 * against it. A false positive costs one debounced filesystem walk; a false
 * negative is the bug this watcher exists to fix.
 */
export function affectsItemList(fsPath: string | undefined): boolean {
  if (!fsPath) return false;
  const segments = path.normalize(fsPath).split(/[\\/]+/).filter(Boolean);
  const base = segments[segments.length - 1];
  if (!base) return false;
  // ANY skipped segment disqualifies the path: an ancestor because the scan never
  // walks into it (`.git/objects/ab/cdef` is not metadata whatever the leaf looks
  // like), and the leaf itself because a dot-file (`.DS_Store`, `.Foo.cls.swp`)
  // has no metadata stem while a skip-directory appearing holds nothing that
  // would have been scanned anyway.
  if (segments.some(isSkippedSegment)) return false;
  return !TRANSIENT_SUFFIXES.some(suffix => base.endsWith(suffix));
}

function isSkippedSegment(segment: string): boolean {
  return SKIP_DIRS.has(segment) || segment.startsWith('.');
}

/** Is `child` inside `parent` (strictly below it)? */
function isInside(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const c = foldPathKey(child, platform);
  const p = foldPathKey(parent, platform);
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

export type TimerHandle = unknown;

export interface RescanSchedulerOptions {
  /** Debounce window: how long after the LAST notification the rescan runs. */
  delayMs: number;
  /** True while an operation holds the panel's busy slot. */
  isBusy: () => boolean;
  /** The rescan. Never invoked re-entrantly. */
  run: () => Promise<void>;
  /** Reported instead of thrown — a background refresher must never surface a
   *  rejection the user did not ask for. */
  onError?: (err: unknown) => void;
  /** Injected in tests; real timers by default. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

/**
 * Collapses a burst of watcher notifications into one rescan.
 *
 * Three rules, in this order:
 *  1. TRAILING DEBOUNCE — each notification restarts the window, so a
 *     `git checkout` (thousands of writes, sub-millisecond apart) rescans once,
 *     after it settles, instead of once per file.
 *  2. NEVER DURING AN OPERATION — a rescan swaps the provider's item list; doing
 *     that under a running deploy/retrieve would move the ground beneath it. The
 *     window is simply re-armed, so the rescan lands as soon as the slot frees.
 *  3. NEVER RE-ENTRANT — notifications arriving while a rescan runs re-arm the
 *     window once it finishes, rather than stacking scans or being lost.
 */
export class RescanScheduler {
  private timer: TimerHandle | undefined;
  private running = false;
  private pending = false;
  private disposed = false;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;

  constructor(private readonly options: RescanSchedulerOptions) {
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** One watcher notification. */
  schedule(): void {
    if (this.disposed) return;
    // A rescan is already running: re-arm after it finishes (rule 3) rather than
    // arming a window that would fire into the running scan.
    if (this.running) { this.pending = true; return; }
    this.arm();
  }

  dispose(): void {
    this.disposed = true;
    this.pending = false;
    this.cancelTimer();
  }

  private arm(): void {
    this.cancelTimer();
    this.timer = this.setTimer(() => this.fire(), this.options.delayMs);
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private fire(): void {
    this.timer = undefined;
    if (this.disposed) return;
    if (this.options.isBusy()) { this.arm(); return; }
    this.running = true;
    this.pending = false;
    let done: Promise<unknown>;
    try {
      done = Promise.resolve(this.options.run());
    } catch (err) {
      this.report(err);
      this.finish();
      return;
    }
    void done.catch(err => this.report(err)).then(() => this.finish());
  }

  private finish(): void {
    this.running = false;
    if (this.pending && !this.disposed) {
      this.pending = false;
      this.arm();
    }
  }

  private report(err: unknown): void {
    this.options.onError?.(err);
  }
}
