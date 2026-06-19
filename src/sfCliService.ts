import { spawn } from 'child_process';

export interface OrgInfo {
  username: string;
  alias?: string;
  orgId?: string;
  instanceUrl?: string;
  isDefaultUsername?: boolean;
  connectedStatus?: string;
  /** True when `sf org list` reported this org under its sandboxes bucket (or the entry is flagged). */
  isSandbox?: boolean;
  /** True when `sf org list` reported this org under its scratchOrgs bucket (or the entry is flagged). */
  isScratch?: boolean;
}

export interface DeployFileResult {
  fullName: string;
  type: string;
  state: string;
  filePath?: string;
  problem?: string;
  problemType?: string;
  lineNumber?: number;
  columnNumber?: number;
}

export interface DeployResult {
  status: number;
  success: boolean;
  numberComponentsDeployed?: number;
  numberComponentsTotal?: number;
  numberComponentErrors?: number;
  details?: {
    componentSuccesses?: DeployFileResult[];
    componentFailures?: DeployFileResult[];
  };
  files?: DeployFileResult[];
}

export interface RetrieveFileResult {
  fullName: string;
  type: string;
  state?: string;
  filePath?: string;
  problem?: string;
}

export interface OrgMember {
  fullName: string;
  fileName?: string;
  manageableState?: string;
  namespacePrefix?: string;
}

export interface RetrieveResult {
  status: number;
  success: boolean;
  files?: RetrieveFileResult[];
  messages?: Array<{ fileName?: string; problem?: string }>;
  inboundFiles?: RetrieveFileResult[];
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

/** Strip ANSI colour escapes so an error rendered in the panel (plain text) isn't
 *  littered with `\u001b[31m`-style codes when the CLI colourises its message. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

/** Normalise the envelope's `actions` into clean, non-empty lines (or undefined). */
function cleanActions(actions: unknown): string[] | undefined {
  if (!Array.isArray(actions)) return undefined;
  const lines = actions
    .filter((a): a is string => typeof a === 'string')
    .map(a => stripAnsi(a).trim())
    .filter(Boolean);
  return lines.length ? lines : undefined;
}

/** Top-level envelope every `sf … --json` command prints. CLI-level failures
 *  (expired auth, source conflicts, bad project, …) carry `name`/`message` at the
 *  top and omit `result`; many also carry `actions[]` with suggested fixes. */
interface SfJsonEnvelope<R> {
  status?: number;
  result?: R;
  name?: string;
  message?: string;
  actions?: string[];
}

interface RunOptions {
  timeoutMs?: number;
  cwd?: string;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface Cancellable<T> {
  promise: Promise<T>;
  cancel: () => void;
}

export class SfCliCancelledError extends SfCliError {
  constructor() {
    super('sf command cancelled');
    this.name = 'SfCliCancelledError';
  }
}

export class SfCliService {
  private readonly defaultTimeoutMs = 180_000;

  async listOrgs(): Promise<OrgInfo[]> {
    const json = await this.runJson<{
      result: {
        nonScratchOrgs?: OrgInfo[];
        scratchOrgs?: OrgInfo[];
        sandboxes?: OrgInfo[];
        other?: OrgInfo[];
      };
    }>(['org', 'list', '--json']);
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

  deployMetadata(
    metadata: string[],
    targetOrg: string,
    cwd: string,
    opts: { ignoreConflicts?: boolean; timeoutMs?: number } = {}
  ): Cancellable<{ result: DeployResult; cmd: string }> {
    const args = ['project', 'deploy', 'start'];
    for (const m of metadata) args.push('--metadata', m);
    args.push('--target-org', targetOrg);
    if (opts.ignoreConflicts) args.push('--ignore-conflicts');
    args.push('--json');
    const cmd = this.formatCmd(args);
    const inner = this.runJsonCancellable<SfJsonEnvelope<DeployResult>>(args, { timeoutMs: opts.timeoutMs, cwd });
    const promise = inner.promise.then(json => ({ result: this.unwrapResult(json, 'project deploy start'), cmd }));
    return { promise, cancel: inner.cancel };
  }

  /**
   * Is this org likely a production org (vs sandbox/scratch)?
   *
   * Trusts the scratch/sandbox flags from `sf org list` first (set from the bucket
   * the org came from). Otherwise treats the org as production unless the URL has a
   * clear non-prod marker — so production orgs on classic instance hosts or vanity
   * domains (not just `*.my.salesforce.com`) still trigger the production
   * confirmation. We err toward over-warning rather than a silent prod deploy.
   */
  isLikelyProduction(org: OrgInfo | undefined): boolean {
    if (!org) return false;
    if (org.isScratch || org.isSandbox) return false;
    const url = (org.instanceUrl ?? '').toLowerCase();
    if (/\.sandbox\.|\.scratch\.|\.cs\d+\.|test\.salesforce\.com/.test(url)) return false;
    return true;
  }

  retrieveMetadata(
    metadata: string[],
    targetOrg: string,
    cwd: string,
    opts: { outputDir?: string; timeoutMs?: number } = {}
  ): Cancellable<{ result: RetrieveResult; cmd: string }> {
    const args = ['project', 'retrieve', 'start'];
    for (const m of metadata) args.push('--metadata', m);
    args.push('--target-org', targetOrg);
    if (opts.outputDir) args.push('--target-metadata-dir', opts.outputDir, '--unzip');
    args.push('--json');
    const cmd = this.formatCmd(args);
    const inner = this.runJsonCancellable<SfJsonEnvelope<RetrieveResult>>(args, { timeoutMs: opts.timeoutMs, cwd });
    const promise = inner.promise.then(json => ({ result: this.unwrapResult(json, 'project retrieve start'), cmd }));
    return { promise, cancel: inner.cancel };
  }

  /**
   * Tooling API SOQL query via `sf data query --use-tooling-api`. The diff fast
   * path uses this to fetch Apex/Visualforce bodies in one REST call instead of a
   * Metadata API retrieve round-trip.
   */
  queryTooling<T = Record<string, unknown>>(
    soql: string,
    targetOrg: string,
    cwd: string,
    opts: { timeoutMs?: number } = {}
  ): Cancellable<{ records: T[]; cmd: string }> {
    const args = ['data', 'query', '--query', soql, '--use-tooling-api', '--target-org', targetOrg, '--json'];
    const cmd = this.formatCmd(args);
    const inner = this.runJsonCancellable<SfJsonEnvelope<{ records?: T[] }>>(args, { timeoutMs: opts.timeoutMs, cwd });
    const promise = inner.promise.then(json => ({ records: this.unwrapResult(json, 'data query').records ?? [], cmd }));
    return { promise, cancel: inner.cancel };
  }

  /**
   * List metadata members of a given type on the connected org.
   *
   * Returns an empty array when the type genuinely has no members. THROWS an
   * SfCliError for real failures (expired auth, named-org-not-found,
   * no-default-org, network) so the caller can surface them instead of silently
   * reporting "0 components" success — the previous behaviour, which coerced
   * every error envelope to an empty array.
   *
   * `opts.folder` is required for folder-based types (EmailTemplate, Report,
   * Dashboard, Document): a folderless list of those types returns nothing.
   */
  listMetadata(
    metadataType: string,
    targetOrg: string,
    cwd: string,
    opts: { timeoutMs?: number; folder?: string } = {}
  ): Cancellable<{ members: OrgMember[]; cmd: string }> {
    const args = ['org', 'list', 'metadata', '--metadata-type', metadataType];
    if (opts.folder) args.push('--folder', opts.folder);
    args.push('--target-org', targetOrg, '--json');
    const cmd = this.formatCmd(args);
    const inner = this.runJsonCancellable<SfJsonEnvelope<OrgMember[]>>(args, { timeoutMs: opts.timeoutMs, cwd });
    const promise = inner.promise.then(json => {
      if (json.result == null) {
        // No `result`. Distinguish a genuine error envelope (carries a `name`,
        // or a non-zero status) from a benign empty listing. Only the former
        // should fail the call; an empty type just yields zero members.
        const isError = !!json.name || (typeof json.status === 'number' && json.status !== 0);
        if (isError) {
          const msg = stripAnsi((json.message ?? '').trim()) || `sf org list metadata ${metadataType} returned no result`;
          const err = new SfCliError(json.name ? `${json.name}: ${msg}` : msg);
          err.errorName = json.name;
          err.actions = cleanActions(json.actions);
          throw err;
        }
        return { members: [], cmd };
      }
      const members = Array.isArray(json.result) ? json.result.filter(m => !!m?.fullName) : [];
      return { members, cmd };
    });
    return { promise, cancel: inner.cancel };
  }

  /**
   * Unwrap `result` from an sf JSON envelope, rejecting with the envelope's own
   * error name/message when there is none (CLI-level failure: expired auth,
   * source conflicts, bad project, …). Without this, callers see an empty result
   * and misreport the failure as e.g. "component not on org".
   */
  private unwrapResult<R>(json: SfJsonEnvelope<R>, what: string): R {
    if (json.result != null) return json.result;
    const msg = stripAnsi((json.message ?? '').trim()) || `sf ${what} returned no result (status ${json.status ?? '?'})`;
    const err = new SfCliError(json.name ? `${json.name}: ${msg}` : msg);
    err.errorName = json.name;
    err.actions = cleanActions(json.actions);
    throw err;
  }

  private formatCmd(args: string[]): string {
    // Quote args containing whitespace so the echoed command is copy-pasteable
    // (e.g. an EmailTemplate fullName "Folder/My Template").
    return 'sf ' + args.filter(a => a !== '--json').map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  }

  private async runJson<T>(args: string[], options: RunOptions = {}): Promise<T> {
    return this.runJsonCancellable<T>(args, options).promise;
  }

  private runJsonCancellable<T>(args: string[], options: RunOptions = {}): Cancellable<T> {
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

  private runCancellable(args: string[], options: RunOptions = {}): Cancellable<RunResult> {
    let cancelFn: () => void = () => undefined;
    const promise = new Promise<RunResult>((resolve, reject) => {
      const child = spawn('sf', args, { shell: false, cwd: options.cwd });
      const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
      let settled = false;
      let cancelled = false;
      let killTimer: NodeJS.Timeout | undefined;
      let timer: NodeJS.Timeout;

      // Single teardown path so the timeout, cancel-kill, and close/error timers
      // are always cleared exactly once (no stray SIGKILL timer after settle).
      const cleanup = (): void => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
      };
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      timer = setTimeout(() => settle(() => {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        reject(new SfCliError(`sf ${args.join(' ')} timed out after ${timeoutMs}ms`));
      }), timeoutMs);

      cancelFn = () => {
        if (settled || cancelled) return;
        cancelled = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, 5000);
      };

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', c => { stdout += c.toString(); });
      child.stderr.on('data', c => { stderr += c.toString(); });
      child.on('error', err => settle(() => {
        if (cancelled) reject(new SfCliCancelledError());
        else reject(new SfCliError(`Failed to launch sf CLI: ${(err as Error).message}. Is the Salesforce CLI installed and on PATH?`, undefined, undefined, err));
      }));
      child.on('close', code => settle(() => {
        if (cancelled) reject(new SfCliCancelledError());
        else resolve({ stdout, stderr, code: code ?? -1 });
      }));
    });
    return { promise, cancel: () => cancelFn() };
  }
}
