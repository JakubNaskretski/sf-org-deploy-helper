/**
 * Salesforce CLI wrapper for sf-org-deploy-helper.
 *
 * The generic spawn/JSON/cancel core now lives in the shared kit
 * (`src/kit/sfCli.ts`, vendored from sf-kit) — it carries the family-wide fixes
 * this plugin's own copy pre-dated: the Windows `sf.cmd` shim resolution
 * (spawn-safe, no `shell:true`), SIGTERM→SIGKILL escalation on the *timeout*
 * path (was SIGTERM-only here), the "sf not found" inference from a spawn ENOENT
 * only (never from stderr contents), the partial-JSON guard on timeout/maxBuffer,
 * and multi-byte-safe UTF-8 decoding.
 *
 * This file keeps the deploy/retrieve/query/list-metadata domain methods, built
 * on the kit's public run helpers, plus the validate-only / quick-deploy /
 * test-level surface and a server-side deploy-cancel.
 */
import {
  Cancellable,
  OrgInfo,
  SfCliCancelledError,
  SfCliError,
  SfCliService as KitSfCliService,
  SfJsonEnvelope,
  cleanActions,
  stripAnsi
} from './kit/sfCli';

// Re-export the kit types the rest of the plugin imports from here, so callers
// keep a single import site and don't need to know the split.
export { Cancellable, OrgInfo, SfCliCancelledError, SfCliError, stripAnsi };

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

/** A single Apex test failure from a deploy that ran tests (RunLocalTests etc.). */
export interface DeployTestFailure {
  name?: string;
  methodName?: string;
  message?: string;
  stackTrace?: string;
}

export interface DeployResult {
  /** Async job id of the deploy/validation — needed for quick-deploy of a
   *  validated deployment and for a server-side `deploy cancel`. */
  id?: string;
  status: number | string;
  success: boolean;
  numberComponentsDeployed?: number;
  numberComponentsTotal?: number;
  numberComponentErrors?: number;
  numberTestsCompleted?: number;
  numberTestsTotal?: number;
  numberTestErrors?: number;
  details?: {
    componentSuccesses?: DeployFileResult[];
    componentFailures?: DeployFileResult[];
    runTestResult?: {
      numFailures?: number | string;
      numTestsRun?: number | string;
      failures?: DeployTestFailure[];
    };
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

/** Apex test level for a deploy (`--test-level`). NoTestRun is the sandbox
 *  default; RunLocalTests is offered/required for production. */
export type TestLevel = 'NoTestRun' | 'RunSpecifiedTests' | 'RunLocalTests' | 'RunAllTestsInOrg';

export interface DeployOptions {
  ignoreConflicts?: boolean;
  timeoutMs?: number;
  sourceDirs?: string[];
  /** `sf project deploy validate` (check-only) instead of `deploy start`; the
   *  returned `id` can then be quick-deployed. Validation always runs tests, so
   *  callers should pass a non-NoTestRun level (the CLI enforces this). */
  validateOnly?: boolean;
  /** `--test-level`. Omitted → CLI default (NoTestRun for a normal deploy). */
  testLevel?: TestLevel;
  /** Class names for RunSpecifiedTests (`--tests`). */
  runTests?: string[];
}

export class SfCliService extends KitSfCliService {
  deployMetadata(
    metadata: string[],
    targetOrg: string,
    cwd: string,
    opts: DeployOptions = {}
  ): Cancellable<{ result: DeployResult; cmd: string }> {
    // Validation is a check-only deploy that returns a job id for a later
    // quick-deploy; `start` is the real thing. Both take the same arg shape.
    const verb = opts.validateOnly ? 'validate' : 'start';
    const args = ['project', 'deploy', verb];
    // Deploy by explicit path when given (file may live outside the package
    // directories, where --metadata Type:Name can't resolve it); else by metadata.
    if (opts.sourceDirs?.length) for (const d of opts.sourceDirs) args.push('--source-dir', d);
    else for (const m of metadata) args.push('--metadata', m);
    args.push('--target-org', targetOrg);
    if (opts.ignoreConflicts) args.push('--ignore-conflicts');
    if (opts.testLevel) args.push('--test-level', opts.testLevel);
    if (opts.testLevel === 'RunSpecifiedTests') for (const t of opts.runTests ?? []) args.push('--tests', t);
    args.push('--json');
    const cmd = this.formatCmd(args);
    const inner = this.runJsonCancellable<SfJsonEnvelope<DeployResult>>(args, { timeoutMs: opts.timeoutMs, cwd });
    const promise = inner.promise.then(json => ({
      result: this.unwrapResult(json, `project deploy ${verb}`),
      cmd
    }));
    return { promise, cancel: inner.cancel };
  }

  /**
   * Deploy a previously-validated deployment by its job id, skipping the
   * validation/test run (`sf project deploy quick --job-id`). Fast, because the
   * org already validated + ran the tests during `deploy validate`.
   */
  quickDeploy(
    jobId: string,
    targetOrg: string,
    cwd: string,
    opts: { timeoutMs?: number } = {}
  ): Cancellable<{ result: DeployResult; cmd: string }> {
    const args = ['project', 'deploy', 'quick', '--job-id', jobId, '--target-org', targetOrg, '--json'];
    const cmd = this.formatCmd(args);
    const inner = this.runJsonCancellable<SfJsonEnvelope<DeployResult>>(args, { timeoutMs: opts.timeoutMs, cwd });
    const promise = inner.promise.then(json => ({ result: this.unwrapResult(json, 'project deploy quick'), cmd }));
    return { promise, cancel: inner.cancel };
  }

  /**
   * Ask the org to cancel an in-progress deploy by job id
   * (`sf project deploy cancel --job-id`). Best-effort — used after we kill the
   * local `sf` process so a deploy the org already accepted doesn't silently keep
   * running. Not cancellable itself (short-lived); errors are the caller's to
   * surface or swallow.
   */
  async deployCancel(jobId: string, targetOrg: string, cwd: string, opts: { timeoutMs?: number } = {}): Promise<void> {
    await this.runJson<SfJsonEnvelope<unknown>>(
      ['project', 'deploy', 'cancel', '--job-id', jobId, '--target-org', targetOrg, '--json'],
      { timeoutMs: opts.timeoutMs ?? 60_000, cwd }
    );
  }

  retrieveMetadata(
    metadata: string[],
    targetOrg: string,
    cwd: string,
    opts: { outputDir?: string; timeoutMs?: number; sourceDirs?: string[] } = {}
  ): Cancellable<{ result: RetrieveResult; cmd: string }> {
    const args = ['project', 'retrieve', 'start'];
    if (opts.sourceDirs?.length) for (const d of opts.sourceDirs) args.push('--source-dir', d);
    else for (const m of metadata) args.push('--metadata', m);
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
}
