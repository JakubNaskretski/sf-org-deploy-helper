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

export interface RetrieveResult {
  status: number;
  success: boolean;
  files?: RetrieveFileResult[];
  messages?: Array<{ fileName?: string; problem?: string }>;
  inboundFiles?: RetrieveFileResult[];
}

export class SfCliError extends Error {
  constructor(message: string, public readonly stderr?: string, public readonly raw?: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'SfCliError';
  }
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
    const inner = this.runJsonCancellable<{ result: DeployResult; status?: number }>(args, { timeoutMs: opts.timeoutMs, cwd });
    const promise = inner.promise.then(json => ({
      result: json.result ?? ({ status: json.status ?? 1, success: false } as DeployResult),
      cmd
    }));
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
    const inner = this.runJsonCancellable<{ result: RetrieveResult; status?: number }>(args, { timeoutMs: opts.timeoutMs, cwd });
    const promise = inner.promise.then(json => ({
      result: json.result ?? ({ status: json.status ?? 1, success: false } as RetrieveResult),
      cmd
    }));
    return { promise, cancel: inner.cancel };
  }

  /**
   * Convert an MDAPI-format tree (`rootDir`) to SFDX source format under `outputDir`.
   * Used by the diff flow so a decomposed object child (CustomField, ValidationRule,
   * …) retrieved in metadata format can be compared file-to-file against the local
   * source-format `*-meta.xml`. Does not require an org.
   */
  convertMdapi(
    rootDir: string,
    outputDir: string,
    cwd: string,
    opts: { timeoutMs?: number } = {}
  ): Cancellable<{ cmd: string }> {
    const args = ['project', 'convert', 'mdapi', '--root-dir', rootDir, '--output-dir', outputDir, '--json'];
    const cmd = this.formatCmd(args);
    const inner = this.runJsonCancellable<{ status?: number; name?: string; message?: string }>(args, { timeoutMs: opts.timeoutMs, cwd });
    // runJsonCancellable resolves on process close regardless of exit code, so a
    // failed-but-JSON convert (`{"status":1,…}`) would otherwise look like success.
    // Inspect the status envelope and reject so the caller surfaces a real error
    // instead of silently treating every child as "not on org".
    const promise = inner.promise.then(json => {
      if (json.status && json.status !== 0) {
        throw new SfCliError(`sf project convert mdapi failed (status ${json.status})${json.message ? `: ${json.message}` : ''}`);
      }
      return { cmd };
    });
    return { promise, cancel: inner.cancel };
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
