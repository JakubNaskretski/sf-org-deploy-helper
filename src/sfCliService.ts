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
  RunOptions,
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
  /** `details.componentFailures` entries carry the metadata type HERE, not in
   *  `type` — org-verified. Read via fileType(), never `f.type` directly, or a
   *  detail failure renders "undefined:Name". */
  componentType?: string;
  state: string;
  filePath?: string;
  problem?: string;
  /** Modern `sf` puts the failure text here (with a trailing " (line:col)"),
   *  and omits `problem` entirely — org-verified on CLI 2.137. Callers should
   *  read via fileProblem(), never `f.problem` directly. */
  error?: string;
  problemType?: string;
  lineNumber?: number;
  columnNumber?: number;
}

/** The failure text of a files[] entry across CLI generations: older output
 *  uses `problem`, modern output uses `error` and leaves `problem` unset. */
export function fileProblem(f: DeployFileResult): string | undefined {
  return f.problem ?? f.error;
}

/** The metadata type of a failure entry across result shapes: files[] entries
 *  use `type`, details.componentFailures entries use `componentType`. */
export function fileType(f: Pick<DeployFileResult, 'type' | 'componentType'>): string {
  return f.componentType ?? f.type ?? '?';
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
  /** Request-level failure text from the Metadata API status. Set when the org
   *  rejected the deploy as a whole rather than component by component — exactly
   *  the case where `details.componentFailures`/`files` are empty, so this is the
   *  ONLY text naming what went wrong (and it carries the same parseable wording,
   *  e.g. "Invalid type: Foo__mdt"). */
  errorMessage?: string;
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
  /** Modern `sf` reports the failure text here and omits `problem` (same drift
   *  as DeployFileResult.error) — read via retrieveProblem(), not `f.problem`. */
  error?: string;
}

/** Failure text of a retrieve row across CLI shapes (see RetrieveFileResult.error). */
export function retrieveProblem(f: Pick<RetrieveFileResult, 'problem' | 'error'>): string | undefined {
  return f.problem ?? f.error;
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

/**
 * Command-line budget, in characters, for the per-component `--metadata Type:Name`
 * list a deploy or retrieve passes to the CLI.
 *
 * Every selected component becomes one `--metadata` argument, so a big
 * selection grows the command line without bound until the OS refuses to start
 * the CLI at all: Windows cmd.exe stops at 8,191 characters, and macOS/Linux
 * have a far larger but still finite ARG_MAX that the environment shares. Past
 * this budget the list is written to a generated package.xml and the CLI is
 * pointed at it with `--manifest` instead (see buildPackageXml). The CLI parses
 * a manifest member and a `--metadata` entry into the same component-set
 * request and resolves both to local source through the same code, so the set
 * that reaches the org is identical — checked against the CLI itself:
 * `sf project convert source` produces byte-identical output for the two forms
 * (scripts/check-manifest-cli.cjs re-proves it on any machine with `sf`).
 *
 * 6,000 leaves ~2,000 characters under the cmd.exe cap for the launcher path,
 * the fixed flags (`--target-org`, `--test-level`, `--tests …`, `--async`) and
 * quoting. Applied on EVERY platform, decided per call from the actual list, so
 * a large deploy takes the same route on a Mac as on Windows and the manifest
 * path is exercised everywhere rather than only where the limit bites.
 */
export const METADATA_ARGS_BUDGET = 6000;

/** Characters the per-component list adds to the command line, as the shell
 *  sees it: `--metadata <entry>` per component, space-separated, the entry
 *  quoted when it contains whitespace (`Layout:Account-Account Layout`). */
export function metadataArgsLength(metadata: string[]): number {
  let n = 0;
  for (const m of metadata) n += '--metadata '.length + m.length + (/\s/.test(m) ? 2 : 0) + 1;
  return n;
}

/** Whether a per-component `--metadata` list can go on the command line as-is.
 *  False means deployMetadata/retrieveMetadata write it to a generated
 *  package.xml and pass `--manifest` instead. */
export function metadataFitsCommandLine(metadata: string[]): boolean {
  return metadataArgsLength(metadata) <= METADATA_ARGS_BUDGET;
}

/**
 * The package.xml equivalent of a `--metadata` list: every `Type:Name` entry
 * becomes a `<members>` under its type's `<types>` block, spelled exactly as it
 * would have been on the command line. The CLI reads both the same way — split
 * on the FIRST colon (a name may contain colons), trim, a bare `Type` means
 * every member (`*`) — and resolves a manifest member to local source through
 * the same component-set code as a `--metadata` entry, so this names precisely
 * the components the flag would have. Nothing is renamed, re-cased or
 * re-derived from file paths: an entry that resolved via `--metadata` resolves
 * via this manifest, and one that didn't (no local source) fails the same way.
 *
 * Deliberately no `<version>`: a manifest's version OVERRIDES the project's
 * `sourceApiVersion` inside the CLI, whereas with none present the CLI falls
 * back to sfdx-project.json (then the org's) exactly as it does for `--metadata`.
 */
export function buildPackageXml(metadata: string[]): string {
  const byType = new Map<string, Set<string>>();
  for (const entry of metadata) {
    const colon = entry.indexOf(':');
    const type = (colon < 0 ? entry : entry.slice(0, colon)).trim();
    if (!type) continue;
    const name = colon < 0 ? '*' : entry.slice(colon + 1).trim();
    let members = byType.get(type);
    if (!members) byType.set(type, (members = new Set()));
    members.add(name);
  }
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<Package xmlns="http://soap.sforce.com/2006/04/metadata">'];
  for (const [type, members] of byType) {
    lines.push('    <types>');
    for (const m of members) lines.push(`        <members>${escapeXml(m)}</members>`);
    lines.push(`        <name>${escapeXml(type)}</name>`, '    </types>');
  }
  lines.push('</Package>', '');
  return lines.join('\n');
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
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
    const tail = ['--target-org', targetOrg];
    if (opts.ignoreConflicts) tail.push('--ignore-conflicts');
    if (opts.testLevel) tail.push('--test-level', opts.testLevel);
    if (opts.testLevel === 'RunSpecifiedTests') for (const t of opts.runTests ?? []) tail.push('--tests', t);
    // `--async` returns once the org has enqueued the job (id + `Queued`), so the
    // caller polls `deployReport` instead of blocking the whole deploy on one wait.
    if (opts.background) tail.push('--async');
    tail.push('--json');
    return this.runTargeted<DeployResult>(
      ['project', 'deploy', verb], metadata, tail, opts, `project deploy ${verb}`,
      { timeoutMs: opts.timeoutMs, cwd }, 'sfodw-deploy-'
    );
  }

  /**
   * Run a deploy/retrieve whose components are named by, in precedence order:
   *   --manifest    a package.xml the caller supplied (a whole manifest)
   *   --source-dir  explicit path(s) — a file may live outside the package dirs,
   *                 where `--metadata Type:Name` can't resolve it
   *   --metadata    the per-component list — or, when that list would not fit
   *                 on the command line (metadataFitsCommandLine), a GENERATED
   *                 package.xml naming the same components, passed as --manifest
   * A caller-supplied manifest wins: when set, sourceDirs/metadata are ignored.
   * `cmd` in the result is the command that actually ran.
   */
  private runTargeted<R>(
    head: string[],
    metadata: string[],
    tail: string[],
    targets: { manifest?: string; sourceDirs?: string[] },
    what: string,
    runOpts: RunOptions,
    tmpPrefix: string
  ): Cancellable<{ result: R; cmd: string }> {
    if (!targets.manifest && !targets.sourceDirs?.length && !metadataFitsCommandLine(metadata)) {
      return this.runWithGeneratedManifest<R>(
        metadata, manifestPath => [...head, '--manifest', manifestPath, ...tail], what, runOpts, tmpPrefix
      );
    }
    const target: string[] = [];
    if (targets.manifest) target.push('--manifest', targets.manifest);
    else if (targets.sourceDirs?.length) for (const d of targets.sourceDirs) target.push('--source-dir', d);
    else for (const m of metadata) target.push('--metadata', m);
    const args = [...head, ...target, ...tail];
    const cmd = this.formatCmd(args);
    const inner = this.runJsonCancellable<SfJsonEnvelope<R>>(args, runOpts);
    const promise = inner.promise.then(json => ({ result: this.unwrapResult(json, what), cmd }));
    return { promise, cancel: inner.cancel };
  }

  /**
   * The manifest route of runTargeted: write the per-component list to a
   * package.xml in a fresh temp dir (buildPackageXml), run the command against
   * it, and remove the dir once the process is gone. The CLI reads the manifest
   * while it builds its component set — before anything reaches the org, and
   * before an `--async` submit returns — so the file has done its job as soon
   * as the process exits; `deploy report` polls read the CLI's own manifest
   * cache, never this file. Cancel before the process starts simply never
   * starts it; cancel afterwards kills it as usual.
   */
  private runWithGeneratedManifest<R>(
    metadata: string[],
    argsFor: (manifestPath: string) => string[],
    what: string,
    runOpts: RunOptions,
    tmpPrefix: string
  ): Cancellable<{ result: R; cmd: string }> {
    let cancelled = false;
    let inner: Cancellable<SfJsonEnvelope<R>> | undefined;
    const promise = (async (): Promise<{ result: R; cmd: string }> => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), tmpPrefix));
      try {
        const manifestPath = path.join(dir, 'package.xml');
        await fs.writeFile(manifestPath, buildPackageXml(metadata), 'utf8');
        if (cancelled) throw new SfCliCancelledError();
        const args = argsFor(manifestPath);
        inner = this.runJsonCancellable<SfJsonEnvelope<R>>(args, runOpts);
        const json = await inner.promise;
        return { result: this.unwrapResult(json, what), cmd: this.formatCmd(args) };
      } finally {
        // Best-effort: a leftover temp dir is not a failure of the deploy.
        fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    })();
    return {
      promise,
      cancel: () => { cancelled = true; inner?.cancel(); }
    };
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
    opts: { outputDir?: string; timeoutMs?: number; sourceDirs?: string[]; manifest?: string; ignoreConflicts?: boolean } = {}
  ): Cancellable<{ result: RetrieveResult; cmd: string }> {
    // Target precedence (manifest > source-dir > metadata, or a generated manifest
    // for a metadata list too long for the command line) mirrors deployMetadata —
    // see runTargeted.
    const tail = ['--target-org', targetOrg];
    if (opts.outputDir) tail.push('--target-metadata-dir', opts.outputDir, '--unzip');
    // `--ignore-conflicts` skips the CLI's source-tracking conflict check. Only
    // meaningful on tracked orgs (scratch/sandbox); a no-op elsewhere.
    if (opts.ignoreConflicts) tail.push('--ignore-conflicts');
    tail.push('--json');
    return this.runTargeted<RetrieveResult>(
      ['project', 'retrieve', 'start'], metadata, tail, opts, 'project retrieve start',
      { timeoutMs: opts.timeoutMs, cwd }, 'sfodw-retrieve-'
    );
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
