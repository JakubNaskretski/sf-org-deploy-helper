// AUTO-GENERATED — vendored from sf-kit by scripts/sync-kit.mjs. DO NOT EDIT HERE.
// Edit the source in sf-kit/src/ and re-run the sync. Local edits will be overwritten.
import { spawn } from 'child_process';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';

/**
 * Shared Salesforce CLI wrapper for the Skrety SF plugin family.
 *
 * Base: sf-org-deploy-helper's `src/sfCliService.ts` (cancellable spawn,
 * `--skip-connection-status`, error-envelope `actions[]`, SIGTERM→SIGKILL
 * cancel escalation). Family-wide fixes folded in for the kit:
 *  - Windows: the `sf` launcher is a `.cmd`/`.ps1` shim that Node refuses to
 *    spawn directly (EINVAL since the CVE-2024-27980 hardening). We resolve the
 *    real shim path ONCE via PATHEXT / `where sf` and spawn that absolute path
 *    with `shell:false` — never `shell:true` (which would need per-arg cmd.exe
 *    quoting and is a shell-injection surface). Previously every plugin
 *    misreported this as "sf not found on PATH".
 *  - Timeout: SIGTERM then SIGKILL escalation after 5s (the deploy-helper
 *    timeout path was SIGTERM-only); the error message says
 *    "timed out after Nms".
 *  - "sf not found" is inferred ONLY from a spawn `error` ENOENT — never from
 *    stderr contents (sf plugins print ENOENT warnings on exit 0; the
 *    sf-log-reader MED bug misfired on those).
 *  - Partial-JSON guard: on a timeout or maxBuffer kill we do NOT JSON.parse the
 *    partial stdout (the sf-test-runner MED bug surfaced raw
 *    "Unexpected end of JSON input" to the user).
 *  - stdout/stderr are collected as raw Buffers and decoded once as UTF-8, so a
 *    multi-byte character split across stream chunks (common in large logs)
 *    isn't corrupted (folded from sf-log-reader 0.5.0's `run`).
 */

export interface OrgInfo {
  username: string;
  alias?: string;
  orgId?: string;
  instanceUrl?: string;
  isDefaultUsername?: boolean;
  isDefaultDevHubUsername?: boolean;
  connectedStatus?: string;
  /** True when `sf org list` reported this org under its sandboxes bucket (or the entry is flagged). */
  isSandbox?: boolean;
  /** True when `sf org list` reported this org under its scratchOrgs bucket (or the entry is flagged). */
  isScratch?: boolean;
}

export class SfCliError extends Error {
  /** sf CLI error name from the JSON envelope (e.g. NamedOrgNotFound), when known. */
  public errorName?: string;
  /** The CLI's own suggested next steps from the envelope's `actions[]`, when present.
   *  These are command-specific and usually more precise than any hint we guess. */
  public actions?: string[];
  constructor(message: string, public readonly stderr?: string, public readonly raw?: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'SfCliError';
  }
}

export class SfCliCancelledError extends SfCliError {
  constructor() {
    super('sf command cancelled');
    this.name = 'SfCliCancelledError';
  }
}

/** Distinct reasons a run terminated without a clean exit, so JSON parsing can
 *  refuse to touch partial output (timeout/maxBuffer) but still parse a normal
 *  non-zero exit (which carries a valid sf error envelope on stdout). */
type RunTermination = 'exit' | 'timeout' | 'maxBuffer';

/** Strip ANSI colour escapes so an error rendered in a panel (plain text) isn't
 *  littered with `[31m`-style codes when the CLI colourises its message. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '');
}

/** Normalise the envelope's `actions` into clean, non-empty lines (or undefined). */
export function cleanActions(actions: unknown): string[] | undefined {
  if (!Array.isArray(actions)) return undefined;
  const lines = actions
    .filter((a): a is string => typeof a === 'string')
    .map(a => stripAnsi(a).trim())
    .filter(Boolean);
  return lines.length ? lines : undefined;
}

/** Top-level envelope every `sf … --json` command prints. CLI-level failures
 *  (expired auth, source conflicts, bad project, …) carry `name`/`message` at
 *  the top and omit `result`; many also carry `actions[]` with suggested fixes. */
export interface SfJsonEnvelope<R> {
  status?: number;
  result?: R;
  name?: string;
  message?: string;
  actions?: string[];
}

export interface RunOptions {
  timeoutMs?: number;
  cwd?: string;
  /** AbortSignal — aborting kills the process (SIGTERM→SIGKILL) and rejects with SfCliCancelledError. */
  signal?: AbortSignal;
  /** Max bytes to buffer from stdout+stderr before killing the process. Default 512 MB. */
  maxBuffer?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface Cancellable<T> {
  promise: Promise<T>;
  cancel: () => void;
}

/**
 * Resolve the absolute path of the `sf` executable once. On Windows the real
 * launcher is `sf.cmd` (or `sf.ps1`); Node's `spawn('sf', …, {shell:false})`
 * cannot start it (EINVAL) and `spawn('sf', …, {shell:true})` opens a
 * shell-injection surface — so we look up the shim's absolute path and spawn
 * that directly with `shell:false`.
 *
 * On non-Windows, `sf` is a real executable that spawns fine, so we return
 * `'sf'` and let PATH resolution happen in `spawn`.
 *
 * Exported for tests.
 */
export function resolveSfCommand(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  /** Predicate for whether a candidate path exists — injectable for tests. */
  exists: (p: string) => boolean = existsSync
): string {
  if (platform !== 'win32') return 'sf';
  // Use the win32 path flavour explicitly so path building is correct even when
  // this runs on a non-Windows host (tests) — the `sf` resolution only matters
  // on real Windows, but the logic must be host-independent.
  const win = path.win32;
  // Candidate shim names in PATHEXT-ish priority order. `sf.exe` first for the
  // rare native build; then the cmd/ps1/bat shims the standard installer ships.
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  const preferred = ['.exe', '.cmd', '.ps1', '.bat'].filter(e => exts.includes(e) || e === '.ps1');
  const dirs = (env.PATH ?? env.Path ?? '').split(win.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of preferred) {
      const candidate = win.join(dir, `sf${ext}`);
      try {
        if (exists(candidate)) return candidate;
      } catch { /* unreadable dir — keep scanning */ }
    }
  }
  // Fall back to `where sf`, which consults the same PATHEXT resolution the
  // shell uses. First line is the highest-priority match.
  try {
    const out = execFileSync('where', ['sf'], { encoding: 'utf8', env });
    const first = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean)[0];
    if (first) return first;
  } catch { /* `where` failed → fall through to the bare name */ }
  // Last resort: the bare name. spawn will likely fail with ENOENT, which we
  // report honestly as "not found on PATH" — never as a bogus success.
  return 'sf';
}

export class SfCliService {
  private readonly defaultTimeoutMs: number;
  /** Default 512 MB cap on buffered stdout+stderr. A runaway/huge response is
   *  killed instead of exhausting the extension host's heap. */
  private readonly defaultMaxBuffer = 512 * 1024 * 1024;
  private resolvedSf: string | undefined;

  constructor(opts: { defaultTimeoutMs?: number } = {}) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 180_000;
  }

  /** Cache the resolved `sf` launcher path so we pay the Windows lookup once. */
  private sfCommand(): string {
    if (this.resolvedSf === undefined) this.resolvedSf = resolveSfCommand();
    return this.resolvedSf;
  }

  async listOrgs(opts: { timeoutMs?: number } = {}): Promise<OrgInfo[]> {
    // --skip-connection-status: don't probe every org's auth over the network.
    // That probe is the slow part of `sf org list` (seconds per org), and an org
    // that fails it can drop out of the result — which used to wipe the saved
    // selection. We never read connectedStatus, so skipping it is pure win.
    const json = await this.runJson<{
      result: {
        nonScratchOrgs?: OrgInfo[];
        scratchOrgs?: OrgInfo[];
        sandboxes?: OrgInfo[];
        other?: OrgInfo[];
      };
    }>(['org', 'list', '--skip-connection-status', '--json'], { timeoutMs: opts.timeoutMs });
    const r = json.result ?? {};
    // Merge the buckets by username, tagging scratch/sandbox from the bucket the
    // org came from (the most reliable signal) so production classification is
    // accurate regardless of My Domain URL shape.
    const byUser = new Map<string, OrgInfo>();
    const add = (orgs: OrgInfo[] | undefined, extra: Partial<OrgInfo>): void => {
      for (const o of orgs ?? []) {
        if (!o?.username) continue;
        const prev = byUser.get(o.username) ?? ({} as OrgInfo);
        byUser.set(o.username, {
          ...prev,
          ...o,
          isSandbox: extra.isSandbox || o.isSandbox || prev.isSandbox,
          isScratch: extra.isScratch || o.isScratch || prev.isScratch
        });
      }
    };
    add(r.nonScratchOrgs, {});
    add(r.scratchOrgs, { isScratch: true });
    add(r.sandboxes, { isSandbox: true });
    add(r.other, {});
    return [...byUser.values()];
  }

  /**
   * Run an arbitrary `sf … --json` command and return the parsed envelope's
   * `result`, throwing an SfCliError (with the envelope's `name`/`actions`) on a
   * CLI-level failure. Cancellable — the returned `cancel()` kills the process.
   */
  runResult<R>(
    args: string[],
    what: string,
    opts: RunOptions = {}
  ): Cancellable<R> {
    const inner = this.runJsonCancellable<SfJsonEnvelope<R>>(args, opts);
    const promise = inner.promise.then(json => this.unwrapResult(json, what));
    return { promise, cancel: inner.cancel };
  }

  /**
   * Unwrap `result` from an sf JSON envelope, rejecting with the envelope's own
   * error name/message when there is none (CLI-level failure: expired auth,
   * source conflicts, bad project, …). Without this, callers see an empty
   * result and misreport the failure as e.g. "component not on org".
   */
  unwrapResult<R>(json: SfJsonEnvelope<R>, what: string): R {
    if (json.result != null) return json.result;
    const msg = stripAnsi((json.message ?? '').trim()) || `sf ${what} returned no result (status ${json.status ?? '?'})`;
    const err = new SfCliError(json.name ? `${json.name}: ${msg}` : msg);
    err.errorName = json.name;
    err.actions = cleanActions(json.actions);
    throw err;
  }

  /** Quote args containing whitespace so the echoed command is copy-pasteable. */
  formatCmd(args: string[]): string {
    return 'sf ' + args.filter(a => a !== '--json').map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  }

  async runJson<T>(args: string[], options: RunOptions = {}): Promise<T> {
    return this.runJsonCancellable<T>(args, options).promise;
  }

  runJsonCancellable<T>(args: string[], options: RunOptions = {}): Cancellable<T> {
    const inner = this.runCancellable(args, options);
    const promise = inner.promise.then(({ stdout, stderr, code }) => {
      const trimmed = stdout.trim();
      if (!trimmed) {
        throw new SfCliError(`sf ${args.join(' ')} produced no output (exit ${code})`, stderr);
      }
      try {
        return JSON.parse(trimmed) as T;
      } catch (err) {
        throw new SfCliError(`Failed to parse JSON from sf ${args.join(' ')}`, stderr, trimmed, err);
      }
    });
    return { promise, cancel: inner.cancel };
  }

  runCancellable(args: string[], options: RunOptions = {}): Cancellable<RunResult> {
    let cancelFn: () => void = () => undefined;
    const promise = new Promise<RunResult>((resolve, reject) => {
      const child = spawn(this.sfCommand(), args, { shell: false, cwd: options.cwd });
      const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
      const maxBuffer = options.maxBuffer ?? this.defaultMaxBuffer;
      let settled = false;
      let cancelled = false;
      let termination: RunTermination = 'exit';
      let killTimer: NodeJS.Timeout | undefined;

      // Single teardown path so the timeout, cancel-kill, and abort timers are
      // always cleared exactly once (no stray SIGKILL timer after settle).
      const cleanup = (): void => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (options.signal) options.signal.removeEventListener('abort', onAbort);
      };
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      // SIGTERM now, SIGKILL after 5s if the process ignores it. Shared by the
      // timeout, maxBuffer, cancel and abort paths so nothing lingers.
      const killEscalating = (): void => {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, 5000);
      };

      const timer = setTimeout(() => {
        termination = 'timeout';
        killEscalating();
        settle(() => reject(new SfCliError(`sf ${args.join(' ')} timed out after ${timeoutMs}ms`)));
      }, timeoutMs);

      const onAbort = (): void => {
        if (settled || cancelled) return;
        cancelled = true;
        killEscalating();
      };
      cancelFn = onAbort;
      if (options.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort, { once: true });
      }

      // Collect raw Buffers and decode once at the end, so multi-byte UTF-8
      // sequences split across chunks (common in large logs) aren't corrupted.
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let bufferedBytes = 0;
      const onChunk = (chunks: Buffer[], c: Buffer): void => {
        chunks.push(c);
        bufferedBytes += c.length;
        if (bufferedBytes > maxBuffer && !settled) {
          termination = 'maxBuffer';
          killEscalating();
          settle(() => reject(new SfCliError(
            `sf ${args.join(' ')} exceeded the ${maxBuffer}-byte output cap`,
            Buffer.concat(stderrChunks).toString('utf8')
          )));
        }
      };
      child.stdout.on('data', c => onChunk(stdoutChunks, Buffer.from(c)));
      child.stderr.on('data', c => onChunk(stderrChunks, Buffer.from(c)));

      child.on('error', err => settle(() => {
        if (cancelled) return reject(new SfCliCancelledError());
        // "sf not found" is ONLY inferred here, from a spawn ENOENT — never from
        // stderr contents (sf plugins print ENOENT warnings on exit 0).
        const isEnoent = (err as NodeJS.ErrnoException).code === 'ENOENT';
        const detail = isEnoent
          ? 'Salesforce CLI (sf) not found on PATH. Install it and reload VS Code.'
          : `Failed to launch sf CLI: ${(err as Error).message}`;
        reject(new SfCliError(detail, undefined, undefined, err));
      }));

      child.on('close', code => settle(() => {
        if (cancelled) return reject(new SfCliCancelledError());
        // On a timeout/maxBuffer kill we've already rejected above; this close
        // is the dying process. `settled` guards it. On a NORMAL exit we resolve
        // — even non-zero, because sf writes a valid error envelope to stdout.
        // We never hand partial stdout from a killed run to the JSON parser.
        if (termination !== 'exit') return;
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        resolve({ stdout, stderr, code: code ?? -1 });
      }));
    });
    return { promise, cancel: () => cancelFn() };
  }
}
