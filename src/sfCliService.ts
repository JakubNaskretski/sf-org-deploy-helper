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
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
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
  /** Metadata API deploy status: a STRING on `deploy report`/async output
   *  (`Pending`/`InProgress`/`Canceling`/`Succeeded`/`SucceededPartial`/`Failed`/
   *  `Canceled`), a number on some older envelopes. */
  status: number | string;
  /** True once the org considers the deploy finished (terminal), from
   *  `deploy report`/async output. Used as the terminal signal for statuses we
   *  don't explicitly enumerate. */
  done?: boolean;
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

/** Result of `sf project delete source`. It's a destructive deploy under the hood,
 *  so it shares DeployResult's success/counts/details/files; the LOCAL files it
 *  removed are additionally reported under `deletedSource` (newer sf) or `deletes`
 *  (older) — read both, plus the deploy-style `files`, since the shape has drifted
 *  across CLI versions. */
export interface DeleteResult extends DeployResult {
  deletedSource?: DeployFileResult[];
  deletes?: DeployFileResult[];
}

/** Result of `sf org login web`. Only `username` is consumed (to select the org);
 *  the result also carries an access token, which is deliberately NOT typed here so
 *  nothing is tempted to log or surface it. */
export interface LoginResult {
  username?: string;
  orgId?: string;
  instanceUrl?: string;
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
  /** `--manifest <package.xml>` — deploy an entire manifest. Mutually exclusive
   *  with sourceDirs/metadata: when set, those targets are ignored. */
  manifest?: string;
  /** `sf project deploy validate` (check-only) instead of `deploy start`; the
   *  returned `id` can then be quick-deployed. Validation always runs tests, so
   *  callers should pass a non-NoTestRun level (the CLI enforces this). */
  validateOnly?: boolean;
  /** `--test-level`. Omitted → CLI default (NoTestRun for a normal deploy). */
  testLevel?: TestLevel;
  /** Class names for RunSpecifiedTests (`--tests`). */
  runTests?: string[];
  /** `--async`: submit the deploy/validation and return AS SOON AS it's enqueued
   *  (job id + `Queued` status, in seconds) instead of blocking until the org
   *  finishes. Client-side conflict detection still runs at submit. The caller
   *  then polls `deployReport(id)` for progress/completion — this is what lets a
   *  long prod deploy outlive the local wait cap and survive a window reload. */
  background?: boolean;
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
    // Target selection, in precedence order (mutually exclusive):
    //   --manifest    a whole package.xml manifest
    //   --source-dir  an explicit path (file may live outside the package dirs,
    //                 where --metadata Type:Name can't resolve it)
    //   --metadata    the per-component list
    // A manifest wins: when set, the sourceDirs/metadata targets are ignored.
    if (opts.manifest) args.push('--manifest', opts.manifest);
    else if (opts.sourceDirs?.length) for (const d of opts.sourceDirs) args.push('--source-dir', d);
    else for (const m of metadata) args.push('--metadata', m);
    args.push('--target-org', targetOrg);
    if (opts.ignoreConflicts) args.push('--ignore-conflicts');
    if (opts.testLevel) args.push('--test-level', opts.testLevel);
    if (opts.testLevel === 'RunSpecifiedTests') for (const t of opts.runTests ?? []) args.push('--tests', t);
    // `--async` returns once the org has enqueued the job (id + `Queued`), so the
    // caller polls `deployReport` instead of blocking the whole deploy on one wait.
    if (opts.background) args.push('--async');
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
   * Report the current state of an async deploy/validate/quick-deploy job
   * (`sf project deploy report --job-id`). A SHORT call — used to poll a job
   * submitted with `background: true` for progress and completion. The `result`
   * is the same MetadataApiDeploy status shape `deploy start` returns (id, status,
   * the numberComponents/numberTests counts, `done`, and `details.componentFailures`
   * / `details.runTestResult`), so it feeds straight into the same result reporting.
   * Cancellable so an in-flight poll can be killed on Cancel.
   */
  deployReport(
    jobId: string,
    targetOrg: string,
    cwd: string,
    opts: { timeoutMs?: number } = {}
  ): Cancellable<{ result: DeployResult; cmd: string }> {
    const args = ['project', 'deploy', 'report', '--job-id', jobId, '--target-org', targetOrg, '--json'];
    const cmd = this.formatCmd(args);
    const inner = this.runJsonCancellable<SfJsonEnvelope<DeployResult>>(args, { timeoutMs: opts.timeoutMs, cwd });
    const promise = inner.promise.then(json => ({ result: this.unwrapResult(json, 'project deploy report'), cmd }));
    return { promise, cancel: inner.cancel };
  }

  /**
   * Delete metadata component(s) from the org AND remove their local source files
   * (`sf project delete source`). This is a DESTRUCTIVE operation: it runs a
   * destructive deploy on the org and, for components that have local source,
   * deletes those files too. `--no-prompt` suppresses the CLI's own interactive
   * confirmation (the caller confirms in VS Code first, and stdin isn't wired up).
   * With `opts.dryRun` it validates the delete without executing — used to preview
   * exactly what would be removed before the destructive confirm.
   */
  deleteSource(
    metadata: string[],
    targetOrg: string,
    cwd: string,
    opts: { dryRun?: boolean; timeoutMs?: number } = {}
  ): Cancellable<{ result: DeleteResult; cmd: string }> {
    const args = ['project', 'delete', 'source'];
    for (const m of metadata) args.push('--metadata', m);
    args.push('--target-org', targetOrg, '--no-prompt');
    if (opts.dryRun) args.push('--dry-run');
    args.push('--json');
    const cmd = this.formatCmd(args);
    const inner = this.runJsonCancellable<SfJsonEnvelope<DeleteResult>>(args, { timeoutMs: opts.timeoutMs, cwd });
    const promise = inner.promise.then(json => ({
      result: this.unwrapResult(json, 'project delete source'),
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
    opts: { timeoutMs?: number; background?: boolean } = {}
  ): Cancellable<{ result: DeployResult; cmd: string }> {
    const args = ['project', 'deploy', 'quick', '--job-id', jobId, '--target-org', targetOrg];
    // `--async` submits the (new) quick-deploy job and returns its id to poll, the
    // same as deployMetadata — the org already validated, but a big quick deploy
    // still shouldn't block the local wait.
    if (opts.background) args.push('--async');
    args.push('--json');
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

  /** Open the org page for a local metadata file in the browser. The CLI maps the
   *  file to its Setup page; files it can't map open the org home instead. */
  async openInOrg(sourceFile: string, targetOrg: string, cwd: string, opts: { timeoutMs?: number } = {}): Promise<void> {
    const json = await this.runJson<SfJsonEnvelope<{ url?: string }>>(
      ['org', 'open', '--source-file', sourceFile, '--target-org', targetOrg, '--json'],
      { timeoutMs: opts.timeoutMs ?? 30_000, cwd }
    );
    this.unwrapResult(json, 'org open');
  }

  /**
   * Authenticate a new org through the browser flow (`sf org login web`). Returns
   * the new org's username so the caller can select it as the target.
   *
   * The browser round-trip is user-paced (open a tab, sign in, approve), so this
   * defaults to a 300s timeout REGARDLESS of the extension's configured
   * commandTimeoutMs — that global default (as low as the 3-minute out-of-box value,
   * clamped no lower than 10s) is sized for CLI round-trips and would kill a
   * legitimate login while the user is still completing it. Cancellable: killing the
   * `sf` process aborts our wait; the browser tab is the user's to close.
   */
  loginWeb(cwd: string, opts: { timeoutMs?: number } = {}): Cancellable<{ result: LoginResult; cmd: string }> {
    const args = ['org', 'login', 'web', '--json'];
    const cmd = this.formatCmd(args);
    const inner = this.runJsonCancellable<SfJsonEnvelope<LoginResult>>(args, { timeoutMs: opts.timeoutMs ?? 300_000, cwd });
    const promise = inner.promise.then(json => ({ result: this.unwrapResult(json, 'org login web'), cmd }));
    return { promise, cancel: inner.cancel };
  }

  /**
   * Resolve metadata types for local paths via `sf project generate manifest` —
   * the CLI's own metadata registry, fully offline (no org call). Returns the
   * generated package.xml content. Throws SfCliError (TypeInferenceError) when a
   * path isn't recognizable metadata; requires cwd inside an SFDX project.
   */
  async generateManifest(sourceDirs: string[], cwd: string, opts: { timeoutMs?: number } = {}): Promise<string> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sfodw-manifest-'));
    try {
      const args = ['project', 'generate', 'manifest'];
      for (const d of sourceDirs) args.push('--source-dir', d);
      args.push('--output-dir', tmp, '--name', 'package.xml', '--json');
      const json = await this.runJson<SfJsonEnvelope<unknown>>(args, { timeoutMs: opts.timeoutMs ?? 30_000, cwd });
      // Surface the CLI's own error (e.g. TypeInferenceError) instead of an
      // ENOENT from reading a manifest that was never written.
      this.unwrapResult(json, 'project generate manifest');
      try {
        return await fs.readFile(path.join(tmp, 'package.xml'), 'utf8');
      } catch {
        // Success envelope but no file at the expected path (e.g. a future CLI
        // writing elsewhere) — a bare ENOENT with a temp path is unactionable.
        throw new SfCliError('sf project generate manifest reported success but wrote no package.xml');
      }
    } finally {
      fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  retrieveMetadata(
    metadata: string[],
    targetOrg: string,
    cwd: string,
    opts: { outputDir?: string; timeoutMs?: number; sourceDirs?: string[]; manifest?: string } = {}
  ): Cancellable<{ result: RetrieveResult; cmd: string }> {
    const args = ['project', 'retrieve', 'start'];
    // A manifest wins over the source-dir / per-component targets (mutually
    // exclusive; when set the sourceDirs/metadata args are ignored). Mirrors
    // deployMetadata's precedence.
    if (opts.manifest) args.push('--manifest', opts.manifest);
    else if (opts.sourceDirs?.length) for (const d of opts.sourceDirs) args.push('--source-dir', d);
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
