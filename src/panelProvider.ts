import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { OrgStore } from './orgStore';
import { DeleteResult, DeployFileResult, DeployResult, DeployTestFailure, OrgInfo, OrgMember, RetrieveFileResult, RetrieveResult, SfCliCancelledError, SfCliError, SfCliService, TestLevel, stripAnsi, fileProblem, fileType, retrieveProblem } from './sfCliService';
import { isLikelyProduction } from './kit/orgs';
import { DIRECTORY_ITEM_TYPES, FolderRule, LearnedRule, MetadataItem, MissingDependencies, OBJECT_CHILD_TYPES, bundleDefinitionFile, deriveRule, detectMissingDependencies, findItemForPath, foldPathKey, inferItemForPath, mergeChangedKeys, parseManifestTypes, resolvePackageDirs, scanWorkspace, SuggestionCandidateInfo, buildSuggestionCandidates } from './metadataScanner';
import { RescanScheduler, WatchTarget, affectsItemList, watchTargets, watchTargetsKey } from './fileWatch';
import { SuggestionLogEntry, formatSuggestionLog, mergeSuggestionEntry } from './suggestionLog';
import { canScanDependencies, DEFAULT_MAX_BUNDLE_FILES, DEFAULT_MAX_DEPS, DEFAULT_MAX_DEPTH, formatDependencyAttribution, resolveLocalDependencies } from './depGraph';
import { generateNonce, getPanelHtml } from './panelHtml';

type Inbound =
  | { type: 'ready' }
  | { type: 'refreshOrgs' }
  | { type: 'refreshFiles' }
  | { type: 'fetchOrgMetadata'; username?: string }
  | { type: 'selectOrg'; username: string }
  | { type: 'useActiveFile' }
  | { type: 'useOpenTabs' }
  | { type: 'deploy'; keys: string[]; validateOnly?: boolean; testLevel?: TestLevel; runTests?: string[] }
  | { type: 'setTestLevel'; testLevel?: TestLevel; runTests?: string[] }
  | { type: 'setIgnoreDeployConflicts'; enabled: boolean }
  | { type: 'resumeDeploy'; jobId?: string }
  | { type: 'quickDeploy'; jobId: string }
  | { type: 'retrieve'; keys: string[] }
  | { type: 'deleteFromOrg'; keys: string[] }
  | { type: 'loginOrg' }
  | { type: 'diff'; keys: string[] }
  | { type: 'openFile'; key: string; line?: number; column?: number }
  | { type: 'openInOrg'; keys: string[] }
  | { type: 'copyText'; text: string }
  | { type: 'refreshChanged' }
  | { type: 'retryDeploy'; request?: RetryRequest }
  // "Retry + changed vs branch" card button — the same untrusted RetryRequest
  // round-trip as retryDeploy; the changed set itself is computed provider-side
  // at click time (changedComponentKeys), never carried in the message.
  | { type: 'retryDeployChanged'; request?: RetryRequest }
  // "Select these N" on a successful result card — the keys ride back from the
  // card, which outlives the window via the persisted history, so they are both
  // untrusted and possibly stale: the handler intersects them with the current
  // scan before anything reaches the tree (selectableScannedKeys).
  | { type: 'selectDeployed'; keys?: string[] }
  // Failure-card dependency suggestions. The webview only ever echoes the card's
  // suggestion id plus a SELECTION of keys; the provider validates both against
  // its own liveSuggestions map — the message can neither mint a key nor carry a
  // retry request of its own.
  | { type: 'suggestionOpened'; id?: string }
  | { type: 'suggestionDeploy'; id?: string; keys?: string[] }
  | { type: 'suggestionDeclined'; id?: string }
  | { type: 'suggestionVerdict'; id?: string; bad?: boolean }
  | { type: 'showSuggestionLog' }
  // Deploy-queue strip ✕ (Feature: deploy queue) — `id` is validated as a string
  // before use; an unknown id is simply a no-op removal.
  | { type: 'cancelQueued'; id?: string }
  | { type: 'clearStatusHistory' }
  // Card-button affordances on a retrieve result that made a pre-retrieve backup
  // (see backupCardButtons). `dir` is the webview's copy of the backup's absolute
  // path — untrusted until resolveBackupDir confines it to this workspace's own
  // backup root. Omitted only if a hand-built message reaches us some other way.
  | { type: 'restoreBackup'; dir?: string }
  | { type: 'discardBackup'; dir?: string }
  | { type: 'cancel' };

// Minimal structural slice of the built-in vscode.git extension's API (v1) —
// just what change detection reads; no dependency on the full git.d.ts.
// `diffWith(ref)` matches the real API's `diffWith(ref: string): Promise<Change[]>`
// (each Change carries a non-optional `uri`; we widen to optional defensively). It
// returns the working tree diffed against `ref` — committed AND uncommitted tracked
// differences (untracked files aren't included, which is why the caller also merges
// in workingTreeChanges/indexChanges). Rejects for an unknown ref.
interface GitChangeLite { uri?: vscode.Uri }
interface GitRepoLite {
  state: { workingTreeChanges: GitChangeLite[]; indexChanges: GitChangeLite[] };
  diffWith(ref: string): Promise<GitChangeLite[]>;
}
interface GitApiLite { repositories: GitRepoLite[] }
interface GitExtensionLite { getAPI(version: 1): GitApiLite }

interface OrgPayload { username: string; alias?: string; label: string; kind: 'prod' | 'sandbox' | 'scratch' | 'other'; }

/** globalState key for folder→type rules learned from the sf CLI registry. */
const LEARNED_RULES_KEY = 'learnedTypeRules';
/** workspaceState key for the status-card history (newest first) — the Status
 *  pane doubles as a per-workspace deployment history across window reloads. */
const CARD_HISTORY_KEY = 'statusCardHistory';
/** globalState key for the dependency-suggestion feedback log. */
const SUGGESTION_LOG_KEY = 'sfOrgDeployWrapper.suggestionLog';
const CARD_HISTORY_MAX = 50;
/** Longest key list a card BUTTON may carry into the persisted history (see
 *  pushCardHistory) — matches the 100-line cap applied to `lines` there. */
const HISTORY_BUTTON_KEYS_MAX = 100;
/**
 * Every `send.type` a card button may name today — i.e. the message types the
 * card-building code above still EMITS, which is a narrower thing than the set
 * handleMessage can route. `retryDeployChanged` is exactly that gap: the handler
 * survives (0.15.0 cards persisted with the button, and it may return in some
 * form), but "Retry + changed vs branch" was removed on user feedback, so a card
 * restored from before then must not resurrect its button.
 *
 * A button naming anything outside this set is dead weight by definition — either
 * the provider would ignore the message, or, as here, it advertises a feature that
 * no longer exists. Pruning happens on BOTH read and write of the history, so
 * cards persisted by an older version heal on their first restore.
 *
 * check-card-buttons.cjs re-derives this set from the button literals the code in
 * this file builds, and fails on any drift — so removing the next feature's
 * button-builder forces the entry out of here rather than leaving it to rot.
 */
export const SUPPORTED_CARD_BUTTON_SENDS: ReadonlySet<string> = new Set([
  'retryDeploy', 'resumeDeploy', 'restoreBackup', 'discardBackup', 'selectDeployed'
]);
/** globalState key for folders whose type resolution failed — the negative cache
 *  (same TTL as learned rules). Without it every NEW session re-paid the serial
 *  30s-per-folder registry calls before a context-menu deploy could even confirm. */
const UNRESOLVABLE_KEY = 'unresolvableTypeFolders';
/** workspaceState key for the panel's last-picked Apex test level — restored on
 *  window reload so a collapsed/reopened panel (and context-menu deploys fired
 *  before the panel ever opens) keep honoring the user's last choice instead of
 *  silently reverting to the smart default. */
const TEST_LEVEL_KEY = 'testLevel';
/** workspaceState key for the last RunSpecifiedTests class list typed in the panel —
 *  persisted alongside TEST_LEVEL_KEY so a context-menu deploy fired after a reload
 *  still has classes to run without the panel ever being reopened. */
const RUN_TESTS_KEY = 'runTests';

/** Cap on the deploy queue (Feature: deploy queue). Generous for a human clicking
 *  Deploy/Validate repeatedly while something else runs; an 11th request gets an
 *  honest "queue full" message rather than growing without bound. */
const DEPLOY_QUEUE_MAX = 10;

/** workspaceState key for the async deploy currently being polled. Persisted right
 *  after a successful submit so a window reload (or a hidden panel) can REATTACH to
 *  the still-running org-side job instead of losing it, and cleared on any terminal
 *  outcome. Shape: ActiveDeployJob. */
const ACTIVE_JOB_KEY = 'activeDeployJob';
/** Don't reattach to a persisted job older than this — a day-old id almost
 *  certainly finished long ago, and reattaching would just report stale state. */
const ACTIVE_JOB_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** How long to wait between `deploy report` polls of a running job. */
const DEPLOY_POLL_INTERVAL_MS = 5000;
/** Consecutive poll failures tolerated before we declare contact lost. A single
 *  failed/timed-out poll is transient (network blip, CLI hiccup); five in a row
 *  means we've genuinely lost the job — stop, but KEEP it persisted for reattach. */
const DEPLOY_POLL_MAX_FAILURES = 5;

/** The async-deploy flows, as shown on cards and persisted with the job. The verb
 *  is a distinct value rather than a flag on 'Deploy' precisely so a reattached/
 *  persisted job can never be reported as something it wasn't. */
type DeployVerb = 'Deploy' | 'Validate' | 'Quick Deploy';

/** A submitted async deploy we're polling, persisted so a reload can reattach. */
interface ActiveDeployJob {
  jobId: string;
  org: string;
  orgLabel: string;
  startedAt: number;
  verb: DeployVerb;
  noun: string;
}

/** How a poll loop ended: `terminal` (the org finished — render the result),
 *  `cancelled` (the user cancelled; the org was asked to stop but the final state
 *  couldn't be confirmed), or `lost` (contact lost — keep the job for reattach). */
type PollOutcome =
  | { kind: 'terminal'; result: DeployResult }
  | { kind: 'cancelled'; note: string }
  | { kind: 'lost' };

interface UnresolvableEntry { folder: string; at: number }

/** Everything needed to re-run a failed deploy from its status card — carried on
 *  the card's Retry button and validated again when it comes back (the payload
 *  round-trips through the webview and persisted history). */
interface RetryRequest {
  keys?: string[];
  manifest?: string;
  sourceDir?: string;
  validateOnly?: boolean;
  testLevel?: TestLevel;
  runTests?: string[];
}

/** What a runDeploy call did. `aborted` covers every path that never reached the
 *  org (queued, busy slot refused, no root/org, user dismissed the confirm) —
 *  an auto-resolve loop must stop on it rather than spin. */
interface DeployOutcome {
  status: 'ok' | 'failed' | 'aborted';
  missing: string[];
  unresolved: string[];
}

const ABORTED: DeployOutcome = { status: 'aborted', missing: [], unresolved: [] };

/** Cap on how many changed components one "Retry + changed vs branch" click may
 *  add. A branch that many components ahead of the failed deploy is a release
 *  promotion, not a missing-dependency fix — that deploy belongs in a manifest
 *  the user reviews, not behind a card button. Generous: the confirm modal only
 *  names a COUNT, so past this size "deploy N components?" stops being an
 *  informed yes. */
const CHANGED_RETRY_MAX_ADDED = 100;

/** Pre-retrieve backup limits. A retrieve that would overwrite more than
 *  BACKUP_MAX_FILES local files skips the backup (a copy that large is almost
 *  certainly a whole-package pull, not the targeted retrieve the safety net is for).
 *  BACKUP_KEEP backup dirs are retained per workspace; older ones are pruned. */
const BACKUP_MAX_FILES = 2000;
const BACKUP_KEEP = 5;
/** Reserved manifest filename at the root of every backup dir — describes the
 *  backup (see BackupManifest) and is skipped when restoring files. */
const BACKUP_MANIFEST = 'backup.json';

/** How a metadata scan was asked for. `silent` is the package-directory
 *  watcher's background rescan: nobody clicked anything, so it may not spawn the
 *  CLI, may not notify, and may not escalate a discovery failure. */
interface LoadFilesOptions { silent?: boolean }

/** Debounce window for the package-directory watcher (see RescanScheduler).
 *  Long enough that a bulk write — `git checkout`, a branch switch, a package
 *  install — collapses into ONE rescan: those deliver their events microseconds
 *  to a few milliseconds apart, so any window in the hundreds of ms coalesces
 *  the whole burst. Short enough that "I just saved a new class" feels
 *  immediate. Deliberately in the same order as the 500ms Changed-lens debounce
 *  the panel already uses for saves. */
const WATCH_DEBOUNCE_MS = 600;

/** How long a SUCCESS hidden-panel notice stays on screen before closing itself.
 *  Long enough to be noticed by someone looking at the editor rather than the
 *  corner of the screen; short enough that a run of context-menu deploys doesn't
 *  leave a stack of verdicts to dismiss by hand — which is the behaviour being
 *  fixed, since a notification carrying an action button never goes away on its
 *  own. Only successes take this path: a success needs no follow-up, while a warn
 *  or a failure the user missed must still be findable (VS Code drops a settled
 *  progress notification from the Notification Center entirely). */
const NOTICE_AUTO_DISMISS_MS = 20_000;

interface BackupManifest { at: number; org: string; fileCount: number; workspaceRoot: string }
/** One backup offered for restore: its on-disk dir plus the manifest fields. */
interface BackupEntry { dir: string; at: number; org: string; fileCount: number }

export class DeployPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'sfOrgDeployWrapper.panel';

  private view?: vscode.WebviewView;
  private orgs: OrgInfo[] = [];
  private items: MetadataItem[] = [];
  private workspaceRoot?: string;
  /** Root-discovery failure currently shown to the user. Used to avoid repeating
   *  the same error toast on every refresh/context-menu attempt. */
  private projectDiscoveryError?: string;
  private busy = false;
  private currentCancel?: () => void;
  private currentAction?: string;
  private currentProgressText?: string;
  /** Async job id of the deploy/validate/quick-deploy currently being polled. Now
   *  that deploys submit with `--async` and return an id in seconds, this is set
   *  IMMEDIATELY after submit and held for the whole poll — so a mid-deploy Cancel
   *  genuinely reaches the org-side job (see cancelCurrent/pollDeployJob), and a
   *  window reload can reattach to it. Undefined only during the brief submit call
   *  and between operations. */
  private currentDeployJobId?: string;
  /** The org a `currentDeployJobId` belongs to (for the server-side cancel call). */
  private currentDeployOrg?: string;
  /** Last successful validate-only deployment, offered for quick-deploy on the card. */
  private lastValidated?: { jobId: string; org: string; label: string; count: number };
  /** Keys ("Type:Name") of metadata components that exist on the currently-selected org. */
  private orgMembers = new Map<string, true>();
  /** The org username `orgMembers` was fetched from — guards against using a stale
   *  membership map after the user switches the target org. */
  private orgMembersOrg?: string;
  /** Folders whose type resolution via the CLI registry failed — skipped on
   *  rescans so a refresh doesn't respawn `sf` for a lost cause. Backed by
   *  globalState with the learned-rules TTL; lazily loaded via `unresolvable()`.
   *  An explicit Refresh Files clears it (the deliberate retry path). */
  private unresolvableFolders?: Set<string>;
  /** Panel-chosen Apex test level, mirrored here so EVERY deploy entry point
   *  (tree context menu, editor right-click, palette) honors it — previously only
   *  the two bottom-bar buttons did, and the others silently used defaults. */
  private testLevel: TestLevel | undefined;
  /** Panel-typed RunSpecifiedTests class list, mirrored here for the same reason
   *  as `testLevel` — a context-menu / editor right-click deploy never touches the
   *  webview's #testClasses input, so it has to read the classes from here. */
  private runTests: string[] | undefined;
  /** First underlying CLI error from the latest type-resolution run — shown in
   *  the scan banner so wholesale failures name their cause in-panel. */
  private resolveErrorSample: string | undefined;
  private sfVersionLogged = false;
  /** Deploys/validations deferred behind the single busy slot (Feature: deploy
   *  queue) — session-only, NOT persisted to workspaceState/globalState. A
   *  queued deploy surviving a window reload would silently fire later against
   *  an org the user may no longer expect; dropping it on reload is the safe
   *  default. The org is PINNED at enqueue time (drainQueue targets it via
   *  runDeploy's orgOverride, never the panel's live org selection). */
  private deployQueue: Array<{
    id: string;
    keys: string[];
    opts: { validateOnly?: boolean; testLevel?: TestLevel; runTests?: string[]; sourceDir?: string };
    org: string;
    orgLabel: string;
    noun: string;
  }> = [];
  /** Live watchers over the discovered project's package directories, plus their
   *  event subscriptions — ALL of it, so re-pointing them at a new project root
   *  can dispose the previous set whole (see syncFileWatchers). */
  private fileWatchers: vscode.Disposable[] = [];
  /** Identity of the currently-watched target set; an unchanged one is left
   *  alone rather than re-created on every scan. */
  private watchedTargetsKey?: string;
  /** Collapses watcher notifications into one debounced, silent rescan. */
  private readonly rescanScheduler: RescanScheduler;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly orgStore: OrgStore,
    private readonly sf: SfCliService,
    private readonly output: vscode.OutputChannel
  ) {
    // Restore the panel's last test-level pick (+ RunSpecifiedTests class list) so a
    // window reload doesn't silently revert to the smart default. Shape-guarded (see
    // the read helpers below) since workspaceState can hand back anything after a
    // corrupted write or a hand-edited state DB.
    this.testLevel = this.readStoredTestLevel();
    this.runTests = this.readStoredRunTests();
    // Follow EXTERNAL changes to the shared target-org setting (a sibling Skrety SF
    // plugin, or a hand edit of settings.json): drop org metadata fetched for a
    // different org so stale badges can't describe the new target, then resync the
    // webview dropdown/state. NEVER write orgStore from here — the write is what
    // fired this event, so setting it again would loop. Our own applyOrgSelection /
    // pickOrg writes also land here; they've already reset metadata (making the guard
    // a no-op) and a second postOrgs is harmless. This also closes the cross-plugin
    // clobber: with the dropdown kept current, Fetch Org sends the ACTUAL selected
    // org, so its applyOrgSelection no longer writes a stale org back over the
    // sibling's switch.
    context.subscriptions.push(orgStore.onDidChange(username => {
      if (this.orgMembersOrg && username !== this.orgMembersOrg) this.resetOrgMetadata();
      this.postOrgs();
    }));
    // Recompute the Changed lens when its base ref changes — the setting flips the
    // view between "uncommitted only" and "differs from <ref>" without a rescan.
    // Fire-and-forget: postChangedComponents never throws. Disposed with the
    // extension via context.subscriptions.
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('sfOrgDeployWrapper.changedBaseRef')) void this.postChangedComponents();
      if (e.affectsConfiguration('sfOrgDeployWrapper.ignoreDeployConflicts')) this.postIgnoreDeployConflicts();
    }));
    // Files created or deleted OUTSIDE the panel's own operations (a new Apex
    // class, a branch switch, a deleted component) used to be invisible until a
    // manual Refresh Metadata Files: nothing but the four explicit paths ever
    // rebuilt `this.items`, so the tree, the dependency suggestions and the
    // Changed lens all disagreed with the disk. The watcher itself is created
    // per project root by syncFileWatchers; this scheduler is what keeps its
    // notifications from turning into a rescan storm.
    this.rescanScheduler = new RescanScheduler({
      delayMs: WATCH_DEBOUNCE_MS,
      isBusy: () => this.busy,
      run: () => this.rescanAfterFileChange(),
      onError: err => this.output.appendLine(`[watch] rescan failed: ${err instanceof Error ? err.message : String(err)}`)
    });
    context.subscriptions.push(
      this.rescanScheduler,
      { dispose: () => this.disposeFileWatchers() },
      { dispose: () => this.dismissTimedNotices() }
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'out')]
    };
    view.webview.html = getPanelHtml(view.webview, this.context.extensionUri, generateNonce());
    // Never let a handler rejection vanish — an org-select or refresh that dies
    // in an unhandled promise looks to the user like the panel simply ignoring
    // clicks, with no trace anywhere.
    view.webview.onDidReceiveMessage((m: Inbound) => {
      void this.handleMessage(m).catch(err => this.reportError(m?.type ?? 'panel action', err));
    });
    const editorChangeSub = vscode.window.onDidChangeActiveTextEditor(() => this.sendActiveFile());
    // Keep the "Changed" lens and its tab badge live through the edit→deploy loop:
    // saving a file is the moment git-dirty state actually changes. Debounced —
    // and cheap anyway (reads the git extension's in-memory state, no spawn).
    const saveSub = vscode.workspace.onDidSaveTextDocument(() => this.scheduleChangedRefresh());
    view.onDidDispose(() => {
      editorChangeSub.dispose();
      saveSub.dispose();
      if (this.changedRefreshTimer) clearTimeout(this.changedRefreshTimer);
      this.view = undefined;
    });
  }

  // ---- Public commands ----
  async pickOrg(): Promise<void> {
    // Reachable from the command palette even while an op runs (webview buttons are
    // disabled, palette commands aren't). Refuse without taking the busy slot —
    // switching the org mid-op would retarget a running deploy/fetch.
    if (this.busy) { this.notifyBusy(); return; }
    const username = await this.promptForOrg('Select Salesforce org');
    if (username) {
      await this.orgStore.set(username);
      if (this.orgMembersOrg && username !== this.orgMembersOrg) this.resetOrgMetadata();
      this.postOrgs();
    }
  }

  /**
   * Show a QuickPick of authenticated orgs and return the chosen username
   * (undefined if cancelled or none authenticated). The currently-selected org
   * is marked so the user can tell it apart. Shared by "Select Org" and the
   * per-file "Compare with Org…" flow.
   */
  private async promptForOrg(placeHolder: string): Promise<string | undefined> {
    await this.loadOrgs();
    if (this.orgs.length === 0) {
      const choice = await vscode.window.showWarningMessage(
        'No authenticated Salesforce orgs found. Run `sf org login web` first.',
        'Refresh'
      );
      if (choice === 'Refresh') await this.loadOrgs(true);
      if (this.orgs.length === 0) return undefined;
    }
    const current = this.orgStore.get();
    const picked = await vscode.window.showQuickPick(
      this.orgs.map(o => ({
        label: o.alias ?? o.username,
        description: [o.alias ? o.username : undefined, o.username === current ? '• current' : undefined]
          .filter(Boolean).join('  '),
        detail: o.instanceUrl,
        username: o.username
      })),
      { placeHolder, matchOnDescription: true, matchOnDetail: true }
    );
    return picked?.username;
  }

  async refreshFiles(): Promise<void> {
    // Palette-invocable during a running op (unlike the disabled webview button).
    // Refuse without taking the busy slot — a rescan mid-op would spawn `sf`
    // registry calls alongside the running command.
    if (this.busy) { this.notifyBusy(); return; }
    // Explicit refresh is the retry path: clear the negative cache so folders
    // that failed resolution (CLI fixed, folder cleaned up, …) get another shot.
    // Automatic rescans keep skipping them until the TTL expires.
    // Storage first, then the in-memory set — the reverse order would leave the
    // persisted junk in place if hydration ever failed, killing the repair path.
    await this.context.globalState.update(UNRESOLVABLE_KEY, []);
    this.unresolvable().clear();
    // A refresh must RUN a fresh scan. Joining an in-flight one (what the plain
    // single-flight would do) silently skips the retry the user just asked for —
    // the click looks dead. Let the running scan finish, then go again.
    if (this.loadFilesInflight) await this.loadFilesInflight.catch(() => undefined);
    await this.loadFiles();
    // Initial panel startup deliberately skips all automatic org work when project
    // discovery fails. If the user fixes the workspace and presses Refresh Files,
    // finish that deferred startup now that there is a safe project cwd.
    if (this.workspaceRoot && this.orgs.length === 0) await this.loadOrgs();
    this.maybeAutoFetchOrg();
  }

  async deployFile(uri: vscode.Uri): Promise<void> { return this.runByUri(uri, 'deploy'); }
  async retrieveFile(uri: vscode.Uri): Promise<void> { return this.runByUri(uri, 'retrieve'); }
  async diffFile(uri: vscode.Uri): Promise<void> { return this.runByUri(uri, 'diff'); }

  /**
   * "Deploy File + Dependencies" (context menu / palette): resolve the file's
   * LOCAL dependency closure up front (depGraph — Apex tokens plus LWC/Aura
   * declared references, best-effort) and deploy entry + dependencies as ONE
   * set, instead of reacting to org errors
   * layer by layer the way the failure-card suggestions do. Every dependency key comes
   * from a scanned MetadataItem, so this path upholds the same invariant as the
   * error-driven one: file text can never mint a `--metadata` key that isn't a
   * real workspace component. runDeploy's confirm modal names the full count
   * before anything reaches the org.
   */
  async deployFileWithDeps(uri: vscode.Uri): Promise<void> {
    if (!uri || !uri.fsPath) {
      vscode.window.showInformationMessage('No file selected.');
      return;
    }
    if (!(await this.ensureItemsForMenuAction())) return;
    // Orgs load for the same reason as runByUri: the production guard must be
    // able to classify the target even when the panel never opened.
    if (this.orgs.length === 0) await this.loadOrgs();
    const match = findItemForPath(this.items, uri.fsPath);
    if (!match) {
      // No infer/CLI fallback here, unlike runByUri: an inferred (out-of-package)
      // item deploys via --source-dir, which beats --metadata in the CLI argv
      // (sfCliService.deployMetadata) and would silently discard every dependency
      // key — the one thing this command exists to add. Plain "Deploy to Org"
      // still handles such files.
      vscode.window.showInformationMessage(
        'Not a scanned Salesforce metadata file — dependency resolution needs a file inside the project\'s package directories. Use "SF Deploy: Deploy to Org" for this one.'
      );
      return;
    }
    const key = `${match.type}:${match.name}`;
    if (!canScanDependencies(match.type)) {
      // Still a useful deploy — just be honest that no scan happened, so the
      // user doesn't assume referenced components were included.
      vscode.window.showInformationMessage(
        `Dependency scanning follows Apex, LWC and Aura source — deploying ${key} on its own.`
      );
      await this.runDeploy([key]);
      return;
    }
    const deps = await resolveLocalDependencies([match], this.items, async p => {
      try { return await fs.readFile(p, 'utf8'); } catch { return undefined; }
    });
    // The confirm modal is the LAST point where this set can be refused, and it
    // otherwise names only a total — a number the user cannot check, because they
    // picked one file and the rest was chosen for them. autoIncluded makes the
    // split explicit there (see deployConfirmModal); the attribution card below
    // then answers "which, and referenced by what".
    const outcome = await this.runDeploy([key, ...deps.keys], {
      autoIncluded: deps.keys.length ? { count: deps.keys.length, entryKey: key } : undefined
    });
    // Post-hoc visibility: the result card lists every key but doesn't say which
    // were auto-included or WHY — this card does, so a surprising extra component
    // is traceable to the reference that pulled it in rather than looking like
    // panel state gone wrong.
    // An aborted outcome posts nothing: either no deploy happened (dismissed
    // modal, no org) or it was queued — and a queued run's confirm already named
    // the full count, with the eventual result card listing every key.
    if (deps.keys.length === 0 || outcome.status === 'aborted') return;
    this.post({
      type: 'status',
      card: {
        kind: outcome.status === 'ok' && !deps.truncated ? 'ok' : 'warn',
        title: `Auto-included ${deps.keys.length} local dependenc${deps.keys.length === 1 ? 'y' : 'ies'} of ${key}`,
        meta: 'Each line names the component whose source referenced it.',
        lines: [
          ...(deps.truncated
            ? [`Dependency scan stopped at its caps (depth ${DEFAULT_MAX_DEPTH}, ${DEFAULT_MAX_DEPS} components, ${DEFAULT_MAX_BUNDLE_FILES} files per bundle) — the included set may be incomplete.`]
            : []),
          ...formatDependencyAttribution(deps.refs)
        ]
      }
    });
  }

  /**
   * Deploy a package.xml manifest to the target org (`sf project deploy start
   * --manifest`). Invoked from the explorer context menu (uri passed) or the
   * command palette (no uri → an XML open-dialog). The file is validated and
   * parsed up front, so an unreadable/empty manifest is refused honestly rather
   * than handed to the CLI.
   */
  async deployManifest(uri?: vscode.Uri): Promise<void> {
    const parsed = await this.pickAndParseManifest(uri, 'deploy');
    if (parsed) await this.runManifestDeploy(parsed.path, parsed.types);
  }

  /** Retrieve a package.xml manifest from the target org (`sf project retrieve
   *  start --manifest`). Same pick/validate flow as deployManifest. */
  async retrieveManifest(uri?: vscode.Uri): Promise<void> {
    const parsed = await this.pickAndParseManifest(uri, 'retrieve');
    if (parsed) await this.runManifestRetrieve(parsed.path, parsed.types);
  }

  /** Resolve a manifest path (from a context-menu uri, or an XML open-dialog on a
   *  palette invocation) and parse it with parseManifestTypes. Returns undefined —
   *  with an honest message — when nothing is chosen, the file can't be read (also
   *  the existence check before we spawn `sf`), or it yields zero metadata types
   *  (not a real package.xml). */
  private async pickAndParseManifest(
    uri: vscode.Uri | undefined,
    verb: 'deploy' | 'retrieve'
  ): Promise<{ path: string; types: Array<{ type: string; members: string[] }> } | undefined> {
    let manifestUri = uri;
    if (!manifestUri || !manifestUri.fsPath) {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: verb === 'deploy' ? 'Deploy Manifest' : 'Retrieve Manifest',
        filters: { 'Salesforce manifest (package.xml)': ['xml'] },
        title: verb === 'deploy' ? 'Select a package.xml to deploy' : 'Select a package.xml to retrieve'
      });
      manifestUri = picked?.[0];
      if (!manifestUri) return undefined;
    }
    const manifestPath = manifestUri.fsPath;
    let content: string;
    try {
      // Reading both proves the file exists (before we ever spawn `sf`) and gives
      // us the content to parse. Cap the size first: parseManifestTypes goes
      // quadratic on pathological many-unclosed-<types> input, and a real
      // package.xml is kilobytes — a multi-MB file is either corrupt or hostile
      // (security review F1); refuse instead of freezing the extension host.
      const stat = await fs.stat(manifestPath);
      if (stat.size > 5_000_000) {
        vscode.window.showErrorMessage(`SF Deploy: ${path.basename(manifestPath)} is ${(stat.size / 1_000_000).toFixed(1)} MB — too large for a package.xml manifest.`);
        return undefined;
      }
      content = await fs.readFile(manifestPath, 'utf8');
    } catch (err) {
      vscode.window.showErrorMessage(`Couldn't read manifest ${path.basename(manifestPath)}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    const types = parseManifestTypes(content);
    if (types.length === 0) {
      vscode.window.showErrorMessage(`${path.basename(manifestPath)} is not a readable package.xml manifest (no metadata types found).`);
      return undefined;
    }
    return { path: manifestPath, types };
  }

  /**
   * Right-click "Compare with Org…": pick any authenticated org (not just the
   * currently-selected one) and diff this file against it. Does not change the
   * panel's active deploy target.
   */
  async diffFileWithOrg(uri: vscode.Uri): Promise<void> {
    if (!uri || !uri.fsPath) {
      vscode.window.showInformationMessage('No file selected.');
      return;
    }
    const org = await this.promptForOrg('Compare this file against which org?');
    if (!org) return;
    return this.runByUri(uri, 'diff', org);
  }

  /** Make sure the items list is fresh for a context-menu entry point (the user
   *  may not have opened the panel yet) — but with a FAST scan (static + learned
   *  rules only). Resolving unknown folders via the CLI registry is the panel
   *  tree's concern; doing it here stalled context-menu ops for up to 30s per
   *  unknown folder before the confirm dialog could show. When a full scan is
   *  already running (panel opening in parallel), share it instead. Returns
   *  false — after reporting the discovery failure — when no project root could
   *  be established; callers must bail. */
  private async ensureItemsForMenuAction(): Promise<boolean> {
    if (this.items.length === 0) {
      if (this.loadFilesInflight) await this.loadFilesInflight;
      else {
        const scan = await scanWorkspace(this.learnedRules());
        if (scan.projectError || !scan.root) {
          this.applyProjectDiscoveryFailure(scan.projectError ?? 'Could not determine the Salesforce DX project root.');
          return false;
        }
        this.clearProjectDiscoveryError();
        this.items = scan.items;
        this.workspaceRoot = scan.root;
        // The panel may never open in this session (context-menu-only use), and
        // this.items still drives every menu action — so the watcher starts here
        // too rather than waiting for a panel scan that may never happen.
        await this.syncFileWatchers(scan.root);
      }
    }
    return !!this.workspaceRoot;
  }

  private async runByUri(uri: vscode.Uri, action: 'deploy' | 'retrieve' | 'diff', orgOverride?: string): Promise<void> {
    if (!uri || !uri.fsPath) {
      vscode.window.showInformationMessage('No file selected.');
      return;
    }
    // If the clicked file itself is in an unknown folder, resolveItemViaCli
    // below resolves just that one file.
    if (!(await this.ensureItemsForMenuAction())) return;
    // Load orgs too so the production guard can classify the target on deploys
    // initiated from the explorer/editor context menu (panel may never have opened).
    if (this.orgs.length === 0) await this.loadOrgs();
    // Fall back to inferring the component from the file path so a file the scan
    // didn't pick up — e.g. one outside the project's package directories — still
    // works when the user points at it, rather than being rejected.
    let match = findItemForPath(this.items, uri.fsPath);
    let inferred = false;
    if (!match) {
      // Static + learned rules first (pure path logic); the CLI registry as the
      // authoritative last resort — if that says no, it genuinely isn't metadata.
      match = inferItemForPath(uri.fsPath, this.learnedRules());
      if (!match) {
        try {
          match = await this.withWindowProgress('Resolving metadata type (sf registry)', () => this.resolveItemViaCli(uri.fsPath));
        } catch (err) {
          // CLI failure (timeout, no project, …) — distinct from "not metadata".
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Couldn't resolve this file's metadata type — the sf CLI failed (not a verdict on the file): ${msg}`);
          return;
        }
      }
      if (match) {
        inferred = true;
        const k = `${match.type}:${match.name}`;
        // Make resolveKeys / runDiff see it (they only look at this.items).
        // If a same Type:Name is already scanned in-workspace we keep that one; deploy/
        // retrieve still hit the clicked file via --source-dir. Only a diff of a same-named
        // twin outside the project would compare the in-workspace copy — and duplicate
        // component names in one project aren't valid SFDX anyway.
        if (!this.items.some(i => `${i.type}:${i.name}` === k)) this.items.push(match);
      }
    }
    if (!match) {
      vscode.window.showInformationMessage('Not a recognized Salesforce metadata file.');
      return;
    }
    const key = `${match.type}:${match.name}`;
    // For inferred (unscanned) files, deploy/retrieve by explicit source path —
    // --metadata can't resolve a component outside the package directories. Diff
    // locates the org copy by Type:Name, so it needs no source override.
    const sourceDir = inferred ? match.filePath : undefined;
    if (action === 'deploy') { await this.runDeploy([key], { sourceDir }); return; }
    if (action === 'retrieve') return this.runRetrieve([key], { sourceDir });
    // The clicked path matters for folder-typed components (lwc/aura bundles,
    // objects): the folder has no meaningful diff, the file the user pointed at does.
    return this.runDiff([key], orgOverride, uri.fsPath);
  }

  // ---- Message routing ----
  private async handleMessage(msg: Inbound): Promise<void> {
    switch (msg.type) {
      case 'ready':
        // Project discovery is the gate for every automatic org operation. The old
        // Promise.all started org loading while the scanner blindly treated the
        // first workspace folder as a valid cwd; a missing project could therefore
        // cascade into an automatic Fetch Org with a nonexistent/invalid cwd.
        await this.loadFiles();
        if (this.workspaceRoot) await this.loadOrgs();
        this.sendActiveFile();
        // Re-sync busy state so a webview recreated mid-operation (e.g. after the
        // sidebar was collapsed) doesn't show enabled buttons during a running op.
        this.post({ type: 'busy', busy: this.busy, action: this.currentAction });
        if (this.busy && this.currentProgressText) this.post({ type: 'progress', text: this.currentProgressText });
        // Restore the test-level select after a webview rebuild — the provider is
        // the source of truth so a collapsed/reopened panel can't silently diverge.
        // Falls back to the configured default so the picker shows what will
        // actually apply when neither the panel nor this session has chosen yet.
        this.post({ type: 'testLevel', value: this.testLevel ?? this.configuredTestLevel() ?? '' });
        // This is a machine-scoped VS Code setting rather than webview state. Send
        // the authoritative value on every rebuild so the visible warning toggle
        // always matches what deploys (including context-menu deploys) will do.
        this.postIgnoreDeployConflicts();
        // Replay the persisted card history into the freshly-built webview — the
        // Status pane is the deployment history (survives reloads, newest first).
        if (this.cardHistory().length) this.post({ type: 'statusHistory', cards: this.cardHistory() });
        // Re-sync the deploy-queue strip too — a webview rebuilt mid-session (e.g.
        // sidebar collapsed/reopened) must not show an empty strip while the
        // provider's in-memory queue still has items waiting.
        this.postQueue();
        // Reattach to an async deploy still running on the org (window reloaded, or
        // the panel was closed and reopened) BEFORE auto-fetch, so a live deploy wins
        // the busy slot over a metadata refresh. No-op when there's no pending job.
        if (this.workspaceRoot) {
          this.maybeReattachDeploy();
          this.maybeAutoFetchOrg();
        }
        return;
      case 'setTestLevel':
        this.testLevel = msg.testLevel;
        this.runTests = msg.runTests;
        this.persistTestLevelState();
        return;
      case 'setIgnoreDeployConflicts': {
        const enabled = msg.enabled === true;
        if (enabled && !this.ignoreDeployConflicts()) {
          const choice = await vscode.window.showWarningMessage(
            'Enable overwrite mode? Deploys can overwrite newer changes in the selected org.',
            {
              modal: true,
              detail: 'This passes --ignore-conflicts to deploys and stays enabled for all workspaces on this machine until you turn it off.'
            },
            'Enable overwrite'
          );
          if (choice !== 'Enable overwrite') {
            this.postIgnoreDeployConflicts();
            return;
          }
        }
        await vscode.workspace.getConfiguration('sfOrgDeployWrapper').update(
          'ignoreDeployConflicts',
          enabled,
          vscode.ConfigurationTarget.Global
        );
        this.postIgnoreDeployConflicts();
        return;
      }
      case 'refreshOrgs':
        await this.loadOrgs(true);
        return;
      case 'refreshFiles':
        await this.refreshFiles();
        return;
      case 'fetchOrgMetadata':
        // Trust the org the webview has selected, applied before we read it back —
        // otherwise a fetch fired right after first-launch auto-selection could race
        // the persisted selection and fetch the default org instead of the picked one.
        if (msg.username) await this.applyOrgSelection(msg.username);
        await this.loadOrgMetadata();
        return;
      case 'selectOrg':
        await this.applyOrgSelection(msg.username || undefined);
        return;
      case 'useActiveFile':
        this.sendActiveFile(true, true);
        return;
      case 'useOpenTabs': {
        // Select every open editor tab that maps to a scanned component — across
        // ALL tab groups (visibleTextEditors only sees focused ones). Diff-editor
        // tabs are skipped: their org side is a throwaway temp file.
        const keys = new Set<string>();
        let fileTabs = 0;
        for (const group of vscode.window.tabGroups.all) {
          for (const tab of group.tabs) {
            const uri = tab.input instanceof vscode.TabInputText ? tab.input.uri
              : tab.input instanceof vscode.TabInputCustom ? tab.input.uri : undefined;
            if (!uri || uri.scheme !== 'file') continue;
            fileTabs++;
            const item = findItemForPath(this.items, uri.fsPath);
            if (item) keys.add(`${item.type}:${item.name}`);
          }
        }
        if (keys.size === 0) {
          vscode.window.showInformationMessage(fileTabs === 0
            ? 'No file tabs are open.'
            : 'No open tab is a recognized SF metadata source under the workspace package directories.');
          return;
        }
        this.post({ type: 'selectKeys', keys: [...keys], scroll: true });
        const skipped = fileTabs - keys.size;
        vscode.window.setStatusBarMessage(
          `$(check) SF Deploy: selected ${keys.size} component${keys.size === 1 ? '' : 's'} from open tabs${skipped > 0 ? ` (${skipped} tab${skipped === 1 ? '' : 's'} not metadata)` : ''}`,
          5000
        );
        return;
      }
      case 'deploy':
        // Fields built explicitly, one by one — NEVER spread `msg` into runDeploy's
        // opts. runDeploy's opts type also carries internal-only `orgOverride` /
        // `preConfirmed` fields that drainQueue uses to replay a queued deploy
        // without a second confirm; spreading the raw webview message would let a
        // compromised webview forge those and skip the confirm modal / retarget
        // the org.
        await this.runDeploy(msg.keys, { validateOnly: msg.validateOnly, testLevel: msg.testLevel, runTests: msg.runTests });
        return;
      case 'quickDeploy':
        await this.runQuickDeploy(msg.jobId);
        return;
      case 'resumeDeploy':
        this.resumeDeployMonitoring(msg.jobId);
        return;
      case 'retrieve':
        await this.runRetrieve(msg.keys);
        return;
      case 'deleteFromOrg':
        await this.runDelete(msg.keys);
        return;
      case 'loginOrg':
        await this.runLogin();
        return;
      case 'diff':
        await this.runDiff(msg.keys);
        return;
      case 'openFile': {
        const it = this.resolveKeys([msg.key])[0];
        if (!it?.filePath) {
          vscode.window.showInformationMessage('No matching local source file is available. Refresh Files if it exists locally, or retrieve it from the org.');
          return;
        }
        // `filePath` is a FOLDER for the bundle types (LWC, Aura, CustomObject) —
        // VS Code refuses to open one as a text document ("... is actually a
        // directory"), which is what a click on any object row used to produce.
        const target = await this.openTargetFor(it);
        if (!target) {
          vscode.window.showInformationMessage(`${it.type}:${it.name} is a folder with no source file to open — Refresh Files if its contents changed on disk.`);
          return;
        }
        // Error-card lines carry the CLI-reported position — land the cursor
        // there (VS Code clamps out-of-range positions to the document end).
        const line = typeof msg.line === 'number' && msg.line > 0 ? msg.line - 1 : undefined;
        const col = typeof msg.column === 'number' && msg.column > 0 ? msg.column - 1 : 0;
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target), {
          preview: true,
          ...(line !== undefined ? { selection: new vscode.Range(line, col, line, col) } : {})
        });
        return;
      }
      case 'openInOrg':
        await this.openComponentInOrg(msg.keys?.[0]);
        return;
      case 'refreshChanged':
        await this.postChangedComponents();
        return;
      case 'retryDeploy': {
        // The request round-trips through the webview (and persisted history) —
        // re-validate every field; runDeploy's own confirm modal + org guard then
        // gate the actual deploy exactly like a fresh one.
        const r = msg.request;
        if (!r || typeof r !== 'object') return;
        if (typeof r.manifest === 'string' && r.manifest) {
          await this.deployManifest(vscode.Uri.file(r.manifest));
          return;
        }
        const keys = Array.isArray(r.keys) ? r.keys.filter(k => typeof k === 'string' && k.includes(':')) : [];
        if (keys.length === 0) {
          vscode.window.showInformationMessage('Nothing to retry — the original deploy request is no longer available.');
          return;
        }
        let sourceDir: string | undefined;
        if (typeof r.sourceDir === 'string' && r.sourceDir && this.workspaceRoot
          && isUnder(foldPathKey(path.resolve(this.workspaceRoot)), foldPathKey(path.resolve(r.sourceDir)))) {
          sourceDir = r.sourceDir;
        }
        await this.runDeploy(keys, { ...deployOptsFromRetry(r), sourceDir });
        return;
      }
      case 'retryDeployChanged': {
        // Same round-trip trust model as retryDeploy: the request came back
        // through the webview (and persisted history), so re-validate every
        // field. The changed set is deliberately NOT part of the message — it's
        // computed HERE, at click time, so it's fresh (the user usually edits
        // between attempts) and costs nothing while the button sits unclicked.
        const r = msg.request;
        if (!r || typeof r !== 'object') return;
        const retryKeys = Array.isArray(r.keys) ? r.keys.filter(k => typeof k === 'string' && k.includes(':')) : [];
        if (retryKeys.length === 0) {
          vscode.window.showInformationMessage('Nothing to retry — the original deploy request is no longer available.');
          return;
        }
        // No sourceDir handling on purpose: the button is never offered for a
        // sourceDir-pinned retry (`--source-dir` beats `--metadata` in the CLI
        // argv, which would silently discard every key merged in below), so a
        // request carrying one is forged or stale — ignore the field entirely.
        // The deployable filter below reads this.items — make sure the scan has
        // actually run (a context-menu retry after a window reload arrives with
        // an empty item list, which would misread as "nothing deployable").
        if (!(await this.ensureItemsForMenuAction())) return;
        const changed = await this.changedComponentKeys();
        if ('reason' in changed) {
          vscode.window.showInformationMessage(changed.reason);
          return;
        }
        // Only components with LOCAL SOURCE can join a --metadata deploy — the
        // same split runDeploy applies as orgOnlySkipped, applied early so an
        // org-only entry doesn't inflate the count or trip the cap.
        const deployableKeys = new Set(this.items.filter(i => !!i.filePath).map(i => `${i.type}:${i.name}`));
        const merged = mergeChangedKeys(retryKeys, changed.keys, deployableKeys, CHANGED_RETRY_MAX_ADDED);
        if (merged.added.length === 0) {
          vscode.window.showInformationMessage('No changed components beyond the ones already deployed.');
          return;
        }
        if (merged.capped) {
          vscode.window.showWarningMessage(
            `Your branch has ${merged.added.length} changed components to add — too many for a one-click retry (cap: ${CHANGED_RETRY_MAX_ADDED}). Deploy the branch with a manifest instead.`
          );
          return;
        }
        // No extra confirmation here — runDeploy's own confirm modal names the
        // full merged count against the target org. Deliberately independent of
        // the dependency suggestions: expanding by git state and expanding by
        // org error text are separate answers, and stacking them would deploy an
        // ever-growing set nobody asked for.
        await this.runDeploy(merged.keys, deployOptsFromRetry(r));
        return;
      }
      case 'selectDeployed': {
        // Re-selecting is not an org operation, so it is allowed while busy — but
        // it still needs a scan to validate against (a card clicked right after a
        // window reload can arrive before/without one).
        if (!(await this.ensureItemsForMenuAction())) return;
        const { keys, dropped } = this.selectableScannedKeys(msg.keys, this.items);
        if (keys.length === 0) {
          vscode.window.showInformationMessage(
            'None of those components are in the current workspace scan — Refresh Files if they exist locally, or retrieve them from the org.'
          );
          return;
        }
        // `replace`: the selection BECOMES that run rather than growing by it.
        // The label names a count and the follow-ups this button exists for (diff
        // what just went up, retrieve it back) are wrong against a union with
        // whatever was already ticked — a card is durable history, so "whatever
        // was already ticked" can be an unrelated 40-row work in progress. The
        // additive default stays for the suggestion flow and "Use open tabs",
        // where adding to the current set is the whole point.
        this.post({ type: 'selectKeys', keys, scroll: true, replace: true });
        vscode.window.setStatusBarMessage(
          `$(check) SF Deploy: selected ${keys.length} component${keys.length === 1 ? '' : 's'}${dropped > 0 ? ` (${dropped} no longer in the workspace)` : ''}`,
          5000
        );
        return;
      }
      case 'suggestionOpened': {
        if (typeof msg.id !== 'string') return;
        const live = this.liveSuggestions.get(msg.id);
        if (!live) return; // expired/unknown — opening costs nothing, log nothing
        await this.writeSuggestionEntry(msg.id, {
          action: 'opened', candidates: live.candidates, org: live.orgLabel
        });
        return;
      }
      case 'suggestionDeploy': {
        if (typeof msg.id !== 'string') return;
        const live = this.liveSuggestions.get(msg.id);
        if (!live) {
          vscode.window.showInformationMessage('This suggestion has expired — use Retry deploy instead.');
          return;
        }
        // Selection: intersect the webview's picks with the server-side candidate
        // list. Anything else in the message is ignored — candidates were already
        // validated against scanned items when the card was built.
        const offered = new Set(live.candidates.map(c => c.key));
        const picked = Array.isArray(msg.keys)
          ? [...new Set(msg.keys.filter(k => typeof k === 'string' && offered.has(k)))]
          : [];
        if (picked.length === 0) {
          vscode.window.showInformationMessage('No suggested components selected.');
          return;
        }
        // A running operation would QUEUE this deploy, and the log would then
        // record 'retry not run' for a retry that actually runs later. Refuse
        // up front — nothing is consumed or logged, the card stays actionable.
        if (this.busy) {
          vscode.window.showInformationMessage('A deployment is already running — retry the suggestion when it finishes.');
          this.post({ type: 'suggestionReset', id: msg.id });
          return;
        }
        const baseKeys = (live.retry.keys ?? []).filter(k => typeof k === 'string' && k.includes(':'));
        const declined = live.candidates.map(c => c.key).filter(k => !picked.includes(k));
        // declined is ALWAYS set and verdict/outcome are explicitly cleared: an
        // accept after an earlier decline must not inherit that decline's
        // residue, or the log reads self-contradictory.
        await this.writeSuggestionEntry(msg.id, {
          action: 'accepted', candidates: live.candidates, org: live.orgLabel,
          accepted: picked, declined: declined.length ? declined : undefined,
          verdict: undefined, outcome: undefined
        });
        // Reflect the acceptance in the component tree IMMEDIATELY (before the
        // deploy settles): the added components join the selection and scroll
        // into view, so the retry's contents are visible, not just implied.
        this.post({ type: 'selectKeys', keys: picked, scroll: true });
        // Server-side truth (liveSuggestions), so these are the ORIGINAL run's own
        // modes: a suggestion accepted from a validation failure re-validates, it
        // does not deploy.
        const outcome = await this.runDeploy([...new Set([...baseKeys, ...picked])], deployOptsFromRetry(live.retry));
        if (outcome.status === 'aborted') {
          // Dismissed confirm / no org / refused slot: nothing reached the org.
          // Keep the suggestion alive and un-fold the card so the user can go
          // again — consuming it here would strand the card on a false
          // "Retrying…" line with nothing actually running.
          await this.writeSuggestionEntry(msg.id, { outcome: 'aborted' });
          this.post({ type: 'suggestionReset', id: msg.id });
          return;
        }
        // Terminal result reached — the suggestion is spent now.
        this.liveSuggestions.delete(msg.id);
        await this.writeSuggestionEntry(msg.id, { outcome: outcome.status === 'ok' ? 'worked' : 'failed' });
        return;
      }
      case 'suggestionDeclined': {
        if (typeof msg.id !== 'string') return;
        const live = this.liveSuggestions.get(msg.id);
        if (!live) return;
        await this.writeSuggestionEntry(msg.id, {
          action: 'declined', candidates: live.candidates, org: live.orgLabel,
          declined: live.candidates.map(c => c.key)
        });
        return;
      }
      case 'suggestionVerdict': {
        if (typeof msg.id !== 'string' || typeof msg.bad !== 'boolean') return;
        const live = this.liveSuggestions.get(msg.id);
        // Verdict may arrive after decline; the map entry is still alive (only
        // suggestionDeploy consumes it), so candidates resolve normally.
        if (!live) return;
        await this.writeSuggestionEntry(msg.id, {
          action: 'declined', candidates: live.candidates, verdict: msg.bad ? 'bad' : 'fine'
        });
        return;
      }
      case 'showSuggestionLog':
        await this.showSuggestionLog();
        return;
      case 'cancelQueued':
        if (typeof msg.id !== 'string') return;
        this.deployQueue = this.deployQueue.filter(q => q.id !== msg.id);
        this.postQueue();
        return;
      case 'clearStatusHistory':
        this.cardHistoryCache = [];
        await this.context.workspaceState.update(CARD_HISTORY_KEY, []);
        return;
      case 'restoreBackup':
        await this.restoreRetrieveBackup(msg.dir);
        return;
      case 'discardBackup':
        await this.discardBackup(msg.dir);
        return;
      case 'copyText':
        if (msg.text) {
          await vscode.env.clipboard.writeText(msg.text);
          vscode.window.setStatusBarMessage('$(check) SF Deploy: error copied to clipboard', 2500);
        }
        return;
      case 'cancel':
        this.cancelCurrent();
        return;
    }
  }

  /**
   * The path an EDITOR may be pointed at for a scanned item. Normally that is
   * `filePath`; for the directory-typed components (DIRECTORY_ITEM_TYPES) it is the
   * folder's own definition file instead. The directory check is a stat rather than
   * a type test so the rule stays true for whatever the scanner records next, and
   * an unstattable path deliberately returns `filePath` unchanged — a missing file
   * is not a directory, and openTextDocument's own error names it far better than a
   * guess here would.
   *
   * `filePath` itself is NOT rewritten: deploy targeting, diff, retrieve backups and
   * findItemForPath all address the folder on purpose.
   */
  private async openTargetFor(item: MetadataItem): Promise<string | undefined> {
    let isDir: boolean;
    try { isDir = (await fs.stat(item.filePath)).isDirectory(); } catch { return item.filePath; }
    return isDir ? bundleDefinitionFile(item) : item.filePath;
  }

  /**
   * Cancel the running operation via its installed `currentCancel` handler. For a
   * NON-deploy op (retrieve, diff, fetch, delete, login) that handler just kills the
   * in-flight `sf` process. For an async deploy being polled it's the graceful-cancel
   * closure pollDeployJob installs, which kills the in-flight poll, asks the ORG to
   * cancel the job (`deploy cancel`), then reads the real final state and reports it
   * honestly (Canceled vs it finished anyway). So — unlike before, when the job id
   * only arrived after the deploy finished and this could never reach the org — a
   * mid-deploy Cancel now genuinely stops the org-side job.
   */
  private cancelCurrent(): void {
    if (this.currentCancel) this.currentCancel();
  }

  /** One automatic Fetch Org per session (`fetchOrgOnOpen`, default on), fired
   *  after the panel's first ready — badges appear without a manual click.
   *  Skipped silently when disabled, no org/root yet, or an operation is running
   *  (no "already running" toast for an action the user didn't take; the next
   *  panel open retries in that case). A webview rebuild does NOT re-trigger it,
   *  and later org switches stay manual — Fetch Org remains the refresh. */
  private autoFetchDone = false;

  private maybeAutoFetchOrg(): void {
    if (this.autoFetchDone) return;
    if (!vscode.workspace.getConfiguration('sfOrgDeployWrapper').get<boolean>('fetchOrgOnOpen', true)) return;
    if (this.busy || !this.workspaceRoot || !this.orgStore.get()) return;
    this.autoFetchDone = true;
    void this.loadOrgMetadata().catch(err =>
      this.output.appendLine(`[Fetch Org] auto-fetch failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  // ---- Loaders ----
  private async loadOrgs(notify = false): Promise<void> {
    try {
      this.orgs = await this.sf.listOrgs();
    } catch (err) {
      // One env line so a "works in terminal, fails in panel" report is
      // diagnosable from the log alone (extension-host PATH ≠ shell PATH).
      this.output.appendLine(`[list orgs] diag cwd=${this.workspaceRoot ?? process.cwd()} PATH=${(process.env.PATH ?? '').split(path.delimiter).slice(0, 6).join(path.delimiter)}`);
      const msg = stripAnsi(err instanceof Error ? err.message : String(err)).trim();
      const hint = hintForError(err);
      // The banner carries the real reason — "see output channel" alone strands
      // users who don't know where that is. reportError adds the error card in
      // the panel, the output-channel line, and a toast whose button OPENS the
      // channel; broken org listing means a dead panel, so loud is correct even
      // on the automatic load at startup.
      this.post({ type: 'banner', message: `Failed to list orgs: ${msg}${hint ? ` — ${hint}` : ''}` });
      this.reportError('List orgs', err);
      // Still answer with the (unchanged) list: the webview's ⟳ stays locked
      // until an `orgs` message arrives, whatever the outcome.
      this.postOrgs();
      return;
    }
    try {
      const current = this.orgStore.get();
      if (current && !this.orgs.some(o => o.username === current)) {
        await this.orgStore.set(undefined);
      } else if (!current) {
        const def = this.orgs.find(o => o.isDefaultUsername) ?? this.orgs[0];
        if (def) await this.orgStore.set(def.username);
      }
    } catch (err) {
      // Persisting the selection failed — the listing itself succeeded, so keep
      // going (dropdown still populates) and attribute the error honestly.
      this.reportError('Save org selection', err);
    }
    // If the effective org no longer matches what org metadata was fetched for, drop it.
    if (this.orgMembersOrg && this.orgStore.get() !== this.orgMembersOrg) this.resetOrgMetadata();
    this.postOrgs();
    if (notify && this.orgs.length === 0) {
      vscode.window.showWarningMessage('No authenticated Salesforce orgs found.');
    } else if (notify) {
      // An unchanged list re-renders identically — say it finished.
      vscode.window.setStatusBarMessage(`$(check) SF Deploy: org list refreshed — ${this.orgs.length} org${this.orgs.length === 1 ? '' : 's'}`, 4000);
    }
    this.post({ type: 'banner', message: this.orgs.length === 0 ? 'No authenticated Salesforce orgs found. Run `sf org login web`.' : '' });
  }

  // ---- Learned type rules ----
  // Static RULES in metadataScanner cover the everyday types instantly and
  // offline. Everything else is resolved on demand by the sf CLI's own metadata
  // registry (`sf project generate manifest` — offline, no org call) and cached
  // here as folder→type rules, so new Salesforce types work without a plugin
  // release; the CLI (`sf update`) is the source of truth.

  private typeCacheDays(): number {
    return vscode.workspace.getConfiguration('sfOrgDeployWrapper').get<number>('typeCacheDays', 7);
  }

  /** Cached learned rules, expired entries dropped. Cache off (0 days) → none. */
  private learnedRules(): FolderRule[] {
    const days = this.typeCacheDays();
    if (days <= 0) return [];
    const cutoff = Date.now() - days * 86_400_000;
    // Shape + charset guard: stored rules feed CLI argv tokens; a corrupted or
    // tampered state DB entry must degrade to "rule ignored", never flow onward.
    return this.context.globalState.get<LearnedRule[]>(LEARNED_RULES_KEY, [])
      .filter(r => !!r && typeof r.folder === 'string' && typeof r.type === 'string'
        && /^[A-Za-z0-9_]+$/.test(r.type) && r.learnedAt >= cutoff);
  }

  private async rememberRule(rule: FolderRule): Promise<void> {
    if (this.typeCacheDays() <= 0) return;
    const all = this.context.globalState.get<LearnedRule[]>(LEARNED_RULES_KEY, []);
    const next = all.filter(r => !(r.folder === rule.folder && r.type === rule.type));
    next.push({ ...rule, learnedAt: Date.now() });
    await this.context.globalState.update(LEARNED_RULES_KEY, next);
  }

  /** Negative-cache twin of `learnedRules()`: folders that failed resolution (or
   *  yielded no derivable rule), persisted with the same TTL. Lazily hydrated
   *  from globalState so a new session skips them too. Cache off (0 days) →
   *  session-only behavior, as before. */
  /** Stored negative-cache entries, shape-validated (the state DB can hand back
   *  junk after corruption or manual edits — a raw `.filter` on it would throw
   *  and take every scan down with it) and TTL-pruned. Never throws. */
  private readUnresolvableEntries(cutoff: number): UnresolvableEntry[] {
    const raw = this.context.globalState.get<unknown>(UNRESOLVABLE_KEY, []);
    if (!Array.isArray(raw)) return [];
    const valid = (e: unknown): e is UnresolvableEntry => {
      const r = e as Partial<UnresolvableEntry> | null | undefined;
      return !!r && typeof r.folder === 'string' && typeof r.at === 'number';
    };
    return raw.filter(valid).filter(e => e.at >= cutoff);
  }

  private unresolvable(): Set<string> {
    if (!this.unresolvableFolders) {
      const days = this.typeCacheDays();
      const kept = days > 0 ? this.readUnresolvableEntries(Date.now() - days * 86_400_000) : [];
      // Fold on hydrate so a folder cached under one drive-letter casing still
      // matches this session's scan paths (Windows) — and so entries persisted
      // before folding was introduced keep working. Every .has()/.add() below
      // folds to match; only the comparison key is folded, not the stored value.
      this.unresolvableFolders = new Set(kept.map(e => foldPathKey(e.folder)));
    }
    return this.unresolvableFolders;
  }

  private markUnresolvable(folder: string): void {
    const key = foldPathKey(folder);
    this.unresolvable().add(key);
    const days = this.typeCacheDays();
    if (days <= 0) return;
    // Dedupe case-insensitively (folded) but persist the ORIGINAL path — the
    // stored casing is display/debug fidelity; membership always folds at read.
    const next = this.readUnresolvableEntries(Date.now() - days * 86_400_000).filter(e => foldPathKey(e.folder) !== key);
    next.push({ folder, at: Date.now() });
    // Cap the persisted list so a workspace with thousands of junk folders can't
    // bloat the state DB — entries are time-ordered, drop the oldest.
    if (next.length > 500) next.splice(0, next.length - 500);
    // A lost write only costs one retry next session — log, don't surface.
    void Promise.resolve(this.context.globalState.update(UNRESOLVABLE_KEY, next))
      .catch(err => this.output.appendLine(`[typeResolve] negative-cache write failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Resolve unknown folders' types via the CLI registry, one call per folder so
   *  a folder of junk (TypeInferenceError) can't block a legit one. Returns the
   *  learned rules (also cached) — returned directly so they reach the caller's
   *  rescan even when the cache is disabled (typeCacheDays 0). Failures are
   *  logged and negative-cached for typeCacheDays (Refresh Files retries). */
  private async learnRulesForFolders(folders: string[], root: string): Promise<FolderRule[]> {
    const learned: FolderRule[] = [];
    this.resolveErrorSample = undefined;
    for (const folder of folders) {
      const label = path.basename(folder);
      try {
        const xml = await this.sf.generateManifest([folder], root);
        const types = parseManifestTypes(xml);
        const fileNames = await fs.readdir(folder);
        let ruleFound = false;
        // Derive only from a clean single-type folder — when two types share a
        // folder, a same-named member could bind the other type's file suffix
        // and the wrong cached rule would mislabel the whole folder on every
        // scan until TTL expiry. Multi-type folders stay click-deployable.
        if (types.length === 1) {
          const rule = deriveRule(label, types[0].type, types[0].members, fileNames);
          if (rule) { await this.rememberRule(rule); learned.push(rule); ruleFound = true; }
        }
        if (ruleFound) {
          this.output.appendLine(`[typeResolve] learned ${label} → ${types.map(t => t.type).join(', ')} (sf registry, cached ${this.typeCacheDays()}d)`);
        } else {
          this.markUnresolvable(folder);
          this.output.appendLine(`[typeResolve] ${label}: resolved ${types.map(t => t.type).join(', ') || 'nothing'} but no per-file rule derivable — not shown in tree (deploy via right-click still works)`);
        }
      } catch (err) {
        this.markUnresolvable(folder);
        const msg = stripAnsi(err instanceof Error ? err.message : String(err)).trim();
        if (!this.resolveErrorSample) this.resolveErrorSample = msg;
        this.logSfVersionOnce();
        this.output.appendLine(`[typeResolve] ${label}: ${msg}`);
      }
    }
    return learned;
  }

  /** Last-resort resolution for a single clicked file the rules don't cover: ask
   *  the CLI registry what it is, and learn the folder rule for future scans. */
  private async resolveItemViaCli(absPath: string): Promise<MetadataItem | undefined> {
    const cwd = this.workspaceRoot;
    if (!cwd) return undefined;
    const base = path.basename(absPath);
    try {
      const xml = await this.sf.generateManifest([absPath], cwd);
      const types = parseManifestTypes(xml);
      const t = types[0];
      if (!t?.members.length) return undefined;
      // Name: exact stem match, then prefix match. For aggregate files that list
      // many members (CustomLabels-style) fall back to the file STEM — never
      // members[0], which would put an arbitrary member on the deploy card and
      // break a later diff of that key.
      const stem = base.split('.')[0];
      const leaf = (m: string) => m.split('/').pop() ?? m;
      const byStem = t.members.find(m => leaf(m) === stem);
      const byPrefix = byStem ? undefined : t.members.find(m => base.startsWith(leaf(m) + '.'));
      const name = byStem ?? byPrefix ?? (t.members.length === 1 ? t.members[0] : stem);
      const guessed = !byStem && !byPrefix && t.members.length !== 1;
      // Learn a folder rule only from a clean single-type resolution — a
      // multi-type answer can't be attributed to files safely, and a wrong-type
      // rule would poison every future scan of that folder until TTL expiry.
      const rule = types.length === 1 ? deriveRule(path.basename(path.dirname(absPath)), t.type, t.members, [base]) : undefined;
      if (rule) void this.rememberRule(rule).catch(err => this.output.appendLine(`[typeResolve] cache write failed: ${err instanceof Error ? err.message : String(err)}`));
      this.output.appendLine(`[typeResolve] ${base} → ${t.type}:${name}${guessed ? ' (aggregate: name from file stem)' : ''} (sf registry)`);
      return { type: t.type, name, filePath: absPath, files: [absPath] };
    } catch (err) {
      this.output.appendLine(`[typeResolve] ${base}: ${err instanceof Error ? err.message : String(err)}`);
      // The registry genuinely not knowing the file → undefined ("not metadata",
      // authoritative). Anything else — timeout, no project, transient CLI
      // failure — must NOT masquerade as "not metadata": rethrow for the caller.
      const notMetadata = err instanceof SfCliError &&
        (err.errorName === 'TypeInferenceError' || /TypeInferenceError/.test(err.message));
      if (notMetadata) return undefined;
      throw err;
    }
  }

  /** In-flight scan shared by concurrent callers — panel `ready` and a
   *  context-menu command can both request a scan at once; without this each
   *  spawned its own serial registry resolution (duplicate `sf` processes and
   *  stacked "Resolving metadata types" progress toasts). */
  private loadFilesInflight?: Promise<void>;
  /** Whether the in-flight scan is the watcher's silent one. Only meaningful
   *  while `loadFilesInflight` is set (it is assigned immediately before). */
  private loadFilesInflightSilent = false;

  private async loadFiles(opts: LoadFilesOptions = {}): Promise<void> {
    // A caller that wants the FULL scan must not be answered by the watcher's
    // silent one, which skips CLI type resolution: let that finish, then run for
    // real — the same chaining refreshFiles does for its deliberate retry.
    if (this.loadFilesInflight && this.loadFilesInflightSilent && !opts.silent) {
      await this.loadFilesInflight.catch(() => undefined);
    }
    if (this.loadFilesInflight) return this.loadFilesInflight;
    this.loadFilesInflightSilent = !!opts.silent;
    return this.loadFilesInflight = this.doLoadFiles(opts).finally(() => { this.loadFilesInflight = undefined; });
  }

  private async doLoadFiles(opts: LoadFilesOptions = {}): Promise<void> {
    let scan = await scanWorkspace(this.learnedRules());
    if (scan.projectError || !scan.root) {
      // A background rescan must never ESCALATE a discovery failure. Emptying the
      // tree, dropping org metadata and popping an error toast because a stray
      // file event caught the workspace mid-hiccup would destroy panel state the
      // user never touched — so the silent path keeps the last good list and just
      // logs. An explicit refresh (or the next panel open) still reports it.
      if (opts.silent) {
        this.output.appendLine(`[watch] rescan skipped — ${scan.projectError ?? 'no Salesforce DX project root'}`);
        return;
      }
      this.applyProjectDiscoveryFailure(scan.projectError ?? 'Could not determine the Salesforce DX project root.');
      return;
    }
    this.clearProjectDiscoveryError();
    // A SILENT rescan that came back with nothing, over a list that had components a
    // moment ago, is far more likely to have caught the workspace mid-write — a
    // checkout with the package directory momentarily absent, an editor swapping a
    // tree — than to be the truth about the project. Publishing it empties the tree,
    // and the webview prunes its persisted selection against what it is handed (auto
    // Fetch Org keeps org membership non-empty, so that prune stays armed), which
    // would delete a selection nobody can get back. Keep the last good list and log;
    // the next watcher event, or an explicit Refresh Metadata Files, still reports a
    // genuinely empty workspace.
    if (opts.silent && scan.items.length === 0 && this.items.length > 0) {
      this.output.appendLine(`[watch] rescan found no metadata under ${scan.root} — keeping the last known ${this.items.length} item(s); Refresh Metadata Files re-checks`);
      await this.syncFileWatchers(scan.root);
      return;
    }
    // Folders no rule covers: resolve their types via the CLI registry, then
    // rescan so they land in the tree. Learned rules AND failures persist, so
    // this spawns `sf` only for genuinely new folders (or after cache expiry).
    const pending = scan.unknownFolders.filter(f => !this.unresolvable().has(foldPathKey(f)));
    // A silent rescan reports the folders ALREADY known-unresolvable instead of
    // resolving anything: the banner an earlier real scan earned stays up, and
    // one that no longer applies (folder deleted) disappears.
    let resolveFailures: string[] = opts.silent
      ? scan.unknownFolders.filter(f => this.unresolvable().has(foldPathKey(f))).map(f => path.basename(f))
      : [];
    // Resolving unknown folders spawns `sf` behind a progress notification — the
    // exact interruption a background refresh must not cause — so the silent path
    // stays on static + learned rules, the same fast-scan discipline
    // ensureItemsForMenuAction uses. A genuinely new metadata FOLDER TYPE
    // therefore waits for the next explicit Refresh Metadata Files; every folder
    // an existing rule covers (the reported case: a new Apex class) lands now.
    if (!opts.silent && pending.length && scan.root) {
      const scanRoot = scan.root;
      // Under window progress — this spawns `sf` (30s timeout per folder) and
      // would otherwise stall the tree with zero feedback on panel open/refresh.
      const fresh = await this.withWindowProgress('Resolving metadata types (sf registry)', () => this.learnRulesForFolders(pending, scanRoot));
      // Fresh rules are passed directly (not just via the cache) so the rescan
      // sees them even with typeCacheDays 0.
      if (fresh.length) scan = await scanWorkspace([...this.learnedRules(), ...fresh]);
      if (scan.projectError || !scan.root) {
        this.applyProjectDiscoveryFailure(scan.projectError ?? 'Could not determine the Salesforce DX project root.');
        return;
      }
      resolveFailures = pending.filter(f => this.unresolvable().has(foldPathKey(f))).map(f => path.basename(f));
    }
    const scanNotice = resolveFailures.length
      ? `Couldn't resolve metadata type for: ${resolveFailures.join(', ')}` +
        (this.resolveErrorSample ? ` — ${this.resolveErrorSample}` : '') +
        (this.resolveErrorSample && hintForError(new Error(this.resolveErrorSample)) ? ` — ${hintForError(new Error(this.resolveErrorSample))}` : '')
      : scan.warning ?? (scan.items.length === 0 && scan.root ? 'No metadata found in workspace package directories.' : '');
    this.post({ type: 'scanBanner', message: scanNotice });
    const { items, root } = scan;
    this.items = items;
    this.workspaceRoot = root;
    this.postFiles(items, { silent: !!opts.silent });
    // Keep the "Changed" view honest against the fresh item list. Fire-and-forget:
    // the method never throws, and the tree must not wait on git. This is also
    // why the watcher needs no second trigger of its own: git state is separate
    // from the item list, but every rescan already ends here.
    void this.postChangedComponents();
    // Point the watcher at whatever project this scan settled on. Re-resolved per
    // scan (package dirs can change with sfdx-project.json) and a no-op when the
    // targets are identical.
    await this.syncFileWatchers(root);
  }

  /** Keep a watcher over the discovered project's package directories, so files
   *  created or deleted outside the extension's own operations reach the item
   *  list. `root` undefined (project discovery failed) means NO watcher at all.
   *
   *  An unchanged target set is left running: every scan re-resolves the package
   *  dirs, and tearing identical watchers down each time would churn live
   *  registrations for nothing. A changed one disposes the previous watchers —
   *  and their event subscriptions — BEFORE the new ones exist, which is what
   *  keeps a re-created watcher from leaking the set it replaces.
   *
   *  Never throws: a workspace the watcher API refuses (an unreachable package
   *  dir, a remote filesystem) must cost the tree nothing beyond staying manual. */
  private async syncFileWatchers(root: string | undefined): Promise<void> {
    let targets: WatchTarget[] = [];
    // Declared outside the try so the failure path can dispose what THIS attempt
    // built (see the catch).
    const created: vscode.Disposable[] = [];
    try {
      targets = watchTargets(root, root ? await resolvePackageDirs(root) : []);
      const key = watchTargetsKey(targets);
      if (key === this.watchedTargetsKey) return;
      this.disposeFileWatchers();
      for (const target of targets) {
        // Create and delete only — ignoreChangeEvents is the `true` in the middle.
        // Editing a file's BODY cannot add or remove a component, so an onDidChange
        // rescan would walk the whole package tree on every keystroke-save to
        // rebuild the identical list. What a save DOES change — git state — is
        // already covered by onDidSaveTextDocument → scheduleChangedRefresh.
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(vscode.Uri.file(target.base), target.pattern),
          false,
          true,
          false
        );
        created.push(
          watcher,
          watcher.onDidCreate(uri => this.onWatchedPathChanged(uri)),
          watcher.onDidDelete(uri => this.onWatchedPathChanged(uri))
        );
      }
      this.fileWatchers = created;
      this.watchedTargetsKey = key;
      this.output.appendLine(targets.length
        ? `[watch] watching ${targets.map(t => t.base).join(', ')}`
        : '[watch] no package directories to watch');
    } catch (err) {
      // Half-built state is worse than none: drop whatever was created and leave
      // the key unset so the next scan retries from scratch. The watchers built HERE
      // are disposed BY NAME, because `this.fileWatchers` was emptied by
      // disposeFileWatchers above — disposing only that array would strand every
      // watcher this attempt had already created: unreachable, but still delivering
      // events, so each one keeps scheduling rescans that fail here again and strand
      // another set on top. (Anything already handed to the field is skipped; the
      // call below disposes those.)
      for (const d of created) {
        if (this.fileWatchers.includes(d)) continue;
        try { d.dispose(); } catch { /* a watcher already torn down by VS Code */ }
      }
      this.disposeFileWatchers();
      this.output.appendLine(`[watch] could not watch the package directories: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private disposeFileWatchers(): void {
    for (const d of this.fileWatchers) {
      try { d.dispose(); } catch { /* a watcher already torn down by VS Code */ }
    }
    this.fileWatchers = [];
    this.watchedTargetsKey = undefined;
  }

  /** One create/delete notification from the package-directory watcher. */
  private onWatchedPathChanged(uri: vscode.Uri): void {
    if (!affectsItemList(uri?.fsPath)) return;
    this.rescanScheduler.schedule();
  }

  /** The watcher's rescan: SILENT by design — no toast, no progress
   *  notification, no focus change. The user created or deleted a file; they did
   *  not ask the panel for anything, so the tree simply becomes correct
   *  (selection survives untouched beyond the webview's existing stale-key
   *  prune, which only ever drops keys that no longer exist). */
  private async rescanAfterFileChange(): Promise<void> {
    // Discovery failed since the event was queued — the watcher is disposed on
    // that path, so this is belt-and-braces rather than a live case.
    if (!this.workspaceRoot) return;
    await this.loadFiles({ silent: true });
  }

  private changedRefreshTimer?: ReturnType<typeof setTimeout>;

  /** Apply a failed unique-root search as a hard local stop. In particular, if a
   *  webview rebuild discovers the failure while automatic Fetch Org is already
   *  running, kill its active sf processes before clearing the stale root. */
  private applyProjectDiscoveryFailure(message: string): void {
    const isNew = this.projectDiscoveryError !== message;
    this.projectDiscoveryError = message;
    if (this.currentAction === 'Fetch Org') {
      this.output.appendLine(`[project] ${message} Cancelling Fetch Org.`);
      this.cancelCurrent();
    }
    this.workspaceRoot = undefined;
    this.items = [];
    this.resetOrgMetadata();
    // No valid root means nothing to watch: the package dirs this watcher was
    // anchored at belong to a project the extension no longer accepts.
    this.disposeFileWatchers();
    this.postFiles([]);
    // Root ambiguity is a hard blocker, not the dismissible scan notice used for
    // individual metadata folders the registry could not classify.
    this.post({ type: 'banner', message });
    if (isNew) vscode.window.showErrorMessage(`SF Deploy: ${message}`);
  }

  private clearProjectDiscoveryError(): void {
    if (this.projectDiscoveryError) this.post({ type: 'banner', message: '' });
    this.projectDiscoveryError = undefined;
  }

  /** Publish the item list to the webview. `silent` marks the watcher's background
   *  rescan: the webview prunes (and persists) its selection against whatever list it
   *  is given, and a scan nobody asked for is never authoritative enough to delete a
   *  selection — a partially-written tree would take every key it happened to miss
   *  with it. See the `files` handler in panel.js for the other half. */
  private postFiles(items: MetadataItem[], opts: { silent?: boolean } = {}): void {
    this.post({
      type: 'files',
      ...(opts.silent ? { silent: true } : {}),
      objectChildTypes: [...OBJECT_CHILD_TYPES],
      items: items.map(i => ({
        type: i.type,
        name: i.name,
        filePath: i.filePath,
        files: i.files
      }))
    });
  }

  private scheduleChangedRefresh(): void {
    if (this.changedRefreshTimer) clearTimeout(this.changedRefreshTimer);
    this.changedRefreshTimer = setTimeout(() => { void this.postChangedComponents(); }, 500);
  }

  /** Compute which local components differ, via the built-in vscode.git
   *  extension — shared by the "Changed" view (postChangedComponents) and the
   *  "Retry + changed vs branch" card button (the retryDeployChanged handler).
   *  Default: uncommitted changes only (working tree + index — includes
   *  untracked files, i.e. brand-new components). When
   *  `sfOrgDeployWrapper.changedBaseRef` is set, ALSO include everything that
   *  differs from that ref (committed changes too — the release-promotion
   *  question), reported as `base` alongside the keys. Returns `{ reason }` when
   *  git can't answer (or the ref is bad/unknown), so the caller says why
   *  instead of showing a false "no changes". Computed fresh per call and posts
   *  nothing itself (output-channel logging aside) — callers own presentation.
   *  Never throws. */
  private async changedComponentKeys(): Promise<{ keys: string[]; base?: string } | { reason: string }> {
    try {
      const gitExt = vscode.extensions.getExtension<GitExtensionLite>('vscode.git');
      if (!gitExt) {
        return { reason: 'Change detection unavailable — VS Code git extension is disabled.' };
      }
      const api = (gitExt.isActive ? gitExt.exports : await gitExt.activate()).getAPI(1);
      if (api.repositories.length === 0) {
        return { reason: 'Change detection unavailable — workspace is not a git repository.' };
      }
      // Optional base ref. Trim, and reject a value shaped like a git flag (leading
      // '-') before it reaches `git diff <ref>` argv — execFile blocks shell
      // injection, but a flag-shaped ref would still be mis-read as an option.
      const rawBase = vscode.workspace.getConfiguration('sfOrgDeployWrapper').get<string>('changedBaseRef', '').trim();
      let baseRef: string | undefined;
      if (rawBase) {
        if (rawBase.startsWith('-')) {
          return { reason: `Invalid changedBaseRef "${rawBase}" — a git ref can't start with '-'.` };
        }
        baseRef = rawBase;
      }
      // A pathological repo can report tens of thousands of changed paths
      // (untracked count too), and per-path findItemForPath scans would be
      // O(paths × items) on the extension-host thread. Precompute lookup maps
      // once — same matching (exact primary file > listed file > containing
      // bundle folder, via ancestor walk) at O(items + paths).
      const byPrimary = new Map<string, string>();
      const byFile = new Map<string, string>();
      const byDir = new Map<string, string>();
      // Keys are folded (foldPathKey): vscode.git reports fsPaths whose casing can
      // differ from the scanner root's on Windows, so an unfolded map would leave
      // the Changed lens silently empty. Values keep the original component key.
      for (const item of this.items) {
        const key = `${item.type}:${item.name}`;
        if (item.filePath) {
          const p = foldPathKey(item.filePath);
          if (!byPrimary.has(p)) byPrimary.set(p, key);
          if (!byDir.has(p)) byDir.set(p, key); // bundles: filePath is the folder
        }
        for (const f of item.files) {
          const p = foldPathKey(f);
          if (!byFile.has(p)) byFile.set(p, key);
        }
      }
      const seen = new Set<string>();
      const keys = new Set<string>();
      // Map one changed file path to its owning component key (exact primary >
      // listed file > containing bundle folder), de-duping repeated paths.
      const addPath = (fsPath: string | undefined): void => {
        if (!fsPath) return;
        const p = foldPathKey(fsPath);
        if (seen.has(p)) return; // a staged+modified (or ref+working) file recurs across lists
        seen.add(p);
        let key = byPrimary.get(p) ?? byFile.get(p);
        for (let dir = path.dirname(p); !key; ) {
          key = byDir.get(dir);
          const parent = path.dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
        if (key) keys.add(key);
      };
      for (const repo of api.repositories) {
        if (baseRef) {
          // `diffWith(ref)` = working tree vs the ref (committed + uncommitted
          // tracked differences). An unknown ref rejects — name it rather than
          // showing a false "no changes".
          let refChanges: GitChangeLite[];
          try {
            refChanges = await repo.diffWith(baseRef);
          } catch (err) {
            this.output.appendLine(`[changed] diffWith(${baseRef}) failed: ${err instanceof Error ? err.message : String(err)}`);
            return { reason: `Can't compare against "${baseRef}" — unknown git ref? (${stripAnsi(err instanceof Error ? err.message : String(err)).trim()})` };
          }
          for (const change of refChanges) addPath(change.uri?.fsPath);
        }
        // Uncommitted edits on top: diffWith(ref) omits untracked files (brand-new
        // components), and with no ref this IS the whole answer.
        for (const change of [...repo.state.workingTreeChanges, ...repo.state.indexChanges]) {
          addPath(change.uri?.fsPath);
        }
      }
      return { keys: [...keys], ...(baseRef ? { base: baseRef } : {}) };
    } catch (err) {
      this.output.appendLine(`[changed] git change detection failed: ${err instanceof Error ? err.message : String(err)}`);
      return { reason: 'Change detection failed — see the output channel.' };
    }
  }

  /** Post the Changed-view payload: the computed keys (tagged `base: <ref>` when
   *  a base ref applies), or `keys: null` with the reason git couldn't answer. */
  private async postChangedComponents(): Promise<void> {
    const changed = await this.changedComponentKeys();
    if ('reason' in changed) {
      this.post({ type: 'changed', keys: null, reason: changed.reason });
      return;
    }
    this.post({ type: 'changed', keys: changed.keys, ...(changed.base ? { base: changed.base } : {}) });
  }

  private sendActiveFile(notifyIfMissing = false, selectAndScroll = false): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      if (notifyIfMissing) vscode.window.showInformationMessage('No active editor file.');
      this.post({ type: 'activeFile', key: null });
      return;
    }
    const match = findItemForPath(this.items, editor.document.uri.fsPath);
    if (!match) {
      if (notifyIfMissing) {
        vscode.window.showInformationMessage('Active file is not a recognized SF metadata source under the workspace package directories.');
      }
      this.post({ type: 'activeFile', key: null });
      return;
    }
    this.post({ type: 'activeFile', key: `${match.type}:${match.name}`, select: selectAndScroll, scroll: selectAndScroll });
  }

  // ---- Test level ----
  // this.testLevel/this.runTests are the panel's live picks (mirrored from the
  // webview so context-menu/editor-right-click deploys see them too); the two
  // read* helpers restore them from workspaceState on startup, and
  // configuredTestLevel() reads the settings.json fallback that applies when
  // neither the panel nor this session has chosen anything yet.

  /** Restore the panel's last test level from workspaceState. Validated against the
   *  full TestLevel union — a corrupted or hand-edited state DB entry degrades to
   *  "no stored pick" (→ the configured/smart default), never a bogus CLI arg. */
  private readStoredTestLevel(): TestLevel | undefined {
    const raw = this.context.workspaceState.get<unknown>(TEST_LEVEL_KEY);
    return isTestLevel(raw) ? raw : undefined;
  }

  /** Restore the panel's last RunSpecifiedTests class list from workspaceState.
   *  Shape-guarded like readStoredTestLevel; the individual class-name syntax
   *  check happens later, right before the classes reach CLI argv (runDeploy). */
  private readStoredRunTests(): string[] | undefined {
    const raw = this.context.workspaceState.get<unknown>(RUN_TESTS_KEY);
    return Array.isArray(raw) && raw.every(c => typeof c === 'string') ? raw as string[] : undefined;
  }

  /** Persist the panel's test-level pick (+ RunSpecifiedTests classes) so it
   *  survives a window reload. Fire-and-forget like pushCardHistory's history
   *  write — a lost write only costs one stale default next session, never worth
   *  failing the message handler over. */
  private persistTestLevelState(): void {
    void Promise.resolve(this.context.workspaceState.update(TEST_LEVEL_KEY, this.testLevel))
      .catch(err => this.output.appendLine(`[testLevel] persist failed: ${err instanceof Error ? err.message : String(err)}`));
    void Promise.resolve(this.context.workspaceState.update(RUN_TESTS_KEY, this.runTests))
      .catch(err => this.output.appendLine(`[testLevel] runTests persist failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** sfOrgDeployWrapper.defaultTestLevel, validated against the SETTING's own enum —
   *  deliberately narrower than the full TestLevel union. RunSpecifiedTests needs a
   *  per-deploy class list a single global setting has no way to carry, so it's
   *  rejected here even if a hand-edited settings.json holds it. '' (and anything
   *  else invalid) → undefined, meaning "fall through to the smart default". */
  private configuredTestLevel(): TestLevel | undefined {
    const raw = vscode.workspace.getConfiguration('sfOrgDeployWrapper').get<string>('defaultTestLevel', '');
    return raw === 'NoTestRun' || raw === 'RunLocalTests' || raw === 'RunAllTestsInOrg' ? raw : undefined;
  }

  /** The single source of truth for the conflict override. It is deliberately a
   *  machine-scoped setting: neither webview state nor a repository's committed
   *  settings can silently enable destructive overwrite behaviour. */
  private ignoreDeployConflicts(): boolean {
    return vscode.workspace.getConfiguration('sfOrgDeployWrapper')
      .get<boolean>('ignoreDeployConflicts', false);
  }

  private postIgnoreDeployConflicts(): void {
    this.post({ type: 'ignoreDeployConflicts', enabled: this.ignoreDeployConflicts() });
  }

  // ---- Operations ----
  private async runDeploy(
    keys: string[],
    opts: {
      sourceDir?: string; validateOnly?: boolean; testLevel?: TestLevel; runTests?: string[];
      /** Internal only — set by drainQueue to run a previously-queued deploy
       *  against the org PINNED at enqueue time, bypassing the currently-selected
       *  org. The 'deploy' Inbound handler builds its opts explicitly (see the
       *  comment there) and never spreads the raw webview message, so a
       *  compromised webview can never set this itself. */
      orgOverride?: string;
      /** Internal only — set by drainQueue to skip the confirm modal for a
       *  deploy the user already confirmed at enqueue time. Same invariant as
       *  orgOverride: only drainQueue sets it. */
      preConfirmed?: boolean;
      /** Internal only — set by deployFileWithDeps so the confirm modal can say
       *  how much of the count the user did NOT pick. Display only: it changes
       *  one line of modal text and nothing about what deploys, so unlike
       *  orgOverride/preConfirmed a forged value could not widen anything. */
      autoIncluded?: { count: number; entryKey: string };
    } = {}
  ): Promise<DeployOutcome> {
    // The single busy slot stays THE invariant (see setBusy/reserveBusy) — but a
    // deploy/validate that arrives while it's held is deferred onto the queue
    // instead of refused outright (retrieve/diff/delete/fetch/login still refuse —
    // see their own reserveBusy/notifyBusy calls, untouched). drainQueue re-enters
    // HERE with preConfirmed once the slot frees, so this check must not re-queue
    // a call that's already been dequeued.
    const verb: DeployVerb = opts.validateOnly ? 'Validate' : 'Deploy';
    if (this.busy && !opts.preConfirmed) {
      await this.enqueueDeploy(keys, opts);
      return ABORTED;
    }
    // Reserve the busy slot synchronously, before the first await (the confirm
    // modal): otherwise a second deploy/retrieve/diff fired during the modal
    // passes the entry check and two ops run at once, clobbering currentCancel and
    // re-enabling the UI mid-op (busy-flag TOCTOU). Release on any early
    // return with `releaseBusy()`.
    if (!this.reserveBusy(verb)) return ABORTED;
    let reserved = true;
    const releaseBusy = (): void => { if (reserved) { reserved = false; this.setBusy(false); } };
    // Set by the terminal result callback; drives the auto-resolve loop in the
    // retryDeploy handler. Declared out here so the outcome survives the try/
    // finally that owns the busy slot. `sawTerminal` distinguishes a real
    // success from a run that never produced a terminal result at all
    // (exception, cancelled submit, lost contact) — both leave `detection`
    // undefined, but only the first is an 'ok' the caller may act on.
    let detection: MissingDependencies | undefined;
    let sawTerminal = false;
    try {
      const root = this.requireRoot();
      if (!root) return ABORTED;
      // A drained queue entry targets the org PINNED at enqueue time, not
      // whatever the panel's org selector shows now.
      const org = opts.orgOverride ?? this.requireOrg();
      if (!org) return ABORTED;
      const allResolved = this.resolveKeys(keys);
      const orgOnlySkipped = allResolved.filter(i => !i.filePath);
      const items = allResolved.filter(i => !!i.filePath);
      if (items.length === 0) {
        vscode.window.showInformationMessage('Selected component(s) have no local source — retrieve them first before deploying.');
        return ABORTED;
      }

      const orgInfo = this.orgs.find(o => o.username === org);
      const orgLabel = orgInfo?.alias ?? org;
      // Kit classification: an unknown/unloaded org counts as PRODUCTION (over-warn).
      const isProd = isLikelyProduction(orgInfo);
      const n = items.length;
      const noun = `${n} component${n === 1 ? '' : 's'}`;

      // RunSpecifiedTests needs an actual class list — resolved now (before the
      // confirm modal) so an empty list can refuse the deploy outright instead of
      // sending the org a validate/deploy that's certain to fail. Shared with
      // enqueueDeploy so a queued confirm's test-level note is exactly the one
      // that will actually run.
      const plan = this.resolveTestPlan(opts, isProd);
      if (!plan) return ABORTED; // resolveTestPlan already showed its own warning
      const { testLevel, runTests, testNote } = plan;

      // Read the conflict override HERE, before the confirm, instead of at the
      // deploy site below: the modal is the last gate before a live org change, so
      // it has to name the value this very run will pass to the CLI. A VS Code
      // modal is window-modal, so the setting can't be toggled from the panel or
      // the Settings editor while it's up — what the user reads is what runs.
      const ignoreConflicts = this.ignoreDeployConflicts();

      // A drained (pre-confirmed) deploy skips the modal entirely — the user
      // already confirmed it, against this same pinned org, at enqueue time.
      if (!opts.preConfirmed) {
        const modal = this.deployConfirmModal(
          {
            noun, orgLabel, isProd, validateOnly: !!opts.validateOnly, testNote,
            instanceUrl: orgInfo?.instanceUrl, ignoreConflicts, autoIncluded: opts.autoIncluded
          },
          false
        );
        const confirm = await vscode.window.showWarningMessage(modal.message, modal.options, modal.confirmLabel);
        if (!confirm) return ABORTED;
      }

      // Echo the --tests flags too (one per class, matching how the CLI itself
      // repeats the flag) so the command log names exactly what will run.
      // NoTestRun is `deploy start`'s own default, so it stays off the command
      // line; a validate can never arrive here as NoTestRun (resolveTestPlan
      // resolves that to RunLocalTests, which `deploy validate` requires).
      const testArg = testLevel !== 'NoTestRun'
        ? ` --test-level ${testLevel}${testLevel === 'RunSpecifiedTests' ? runTests.map(t => ` --tests ${t}`).join('') : ''}`
        : '';

      const cmdId = this.beginCmd(`sf project deploy ${opts.validateOnly ? 'validate' : 'start'} ${this.targetArg(opts.sourceDir, items)} --target-org ${org}${ignoreConflicts ? ' --ignore-conflicts' : ''}${testArg}`);
      // From here the async work runs under the reserved slot; the finally block
      // owns releasing it, so stop the early-return releaser from double-firing.
      reserved = false;
      const start = Date.now();
      const progressTitle = opts.validateOnly ? `Validating ${noun} against ${orgLabel}` : `Deploying ${noun} to ${orgLabel}`;
      // `keepPersisted` survives the withWindowProgress body so the finally knows
      // whether contact was lost (keep the job for reattach) or the run ended
      // terminally (clear it).
      let keepPersisted = false;
      try {
        await this.withWindowProgress(progressTitle, async report => {
          this.postProgress(`${progressTitle}…`);
          // Submit ASYNC: the CLI enqueues the deploy (client-side conflict check
          // still runs here) and returns a job id in seconds. Cancel during this
          // brief window kills the submit before any job exists.
          const handle = this.sf.deployMetadata(
            items.map(i => `${i.type}:${i.name}`),
            org,
            root,
            {
              ignoreConflicts,
              timeoutMs: this.timeoutMs(),
              sourceDirs: opts.sourceDir ? [opts.sourceDir] : undefined,
              validateOnly: opts.validateOnly,
              testLevel: testLevel === 'NoTestRun' ? undefined : testLevel,
              runTests: testLevel === 'RunSpecifiedTests' ? runTests : undefined,
              background: true
            }
          );
          this.currentCancel = handle.cancel;
          this.currentDeployOrg = org;
          const { result: submit, cmd } = await handle.promise;
          this.updateCmd(cmdId, cmd);
          const jobId = submit.id;
          if (!jobId) throw new SfCliError(`${verb} submitted but the CLI returned no job id to track.`);
          // The job now exists on the org — pin it (makes Cancel org-side-live) and
          // persist it so a window reload can reattach.
          this.currentDeployJobId = jobId;
          this.persistActiveJob({ jobId, org, orgLabel, startedAt: Date.now(), verb, noun });
          const outcome = await this.drivePolledDeploy(
            { jobId, org, orgLabel, root, verb, noun, cmdId, start, progressTitle }, report,
            result => {
              detection = this.reportPolledDeploy(result, {
                items, orgOnlySkipped, orgLabel, org, noun, cmdId, start, validateOnly: !!opts.validateOnly, verb,
                // Carries the run's own modes so Retry and an accepted dependency
                // suggestion re-run as what this was — a validation must never turn
                // into a deploy on its own.
                retry: buildRetryRequest(opts, items, testLevel, runTests)
              });
              // Set AFTER the report call: a throw out of reportDeployResult must
              // not leave sawTerminal true with detection unset, which would make
              // runDeploy return a false 'ok' for a deploy that never reported.
              // An org-side cancel is terminal but is NOT a success either — leave
              // it false so the caller gets 'aborted', matching the cancelled card
              // reportPolledDeploy posts for that same status.
              sawTerminal = (typeof result.status === 'string' ? result.status : '') !== 'Canceled';
            }
          );
          keepPersisted = outcome.keepPersisted;
        });
      } catch (err) {
        this.endCmd(cmdId, false, Date.now() - start);
        // Org-labelled so exception cards stay attributable in the mixed-org history.
        const labeledAction = `${verb} ${orgPrep(verb)} ${orgLabel}`;
        if (err instanceof SfCliCancelledError) {
          // A cancel this far out means the ASYNC SUBMIT was killed before it
          // returned a job id — the org may still have enqueued it.
          this.reportCancelled(labeledAction, 'The org-side deploy may still complete — check the org.');
        } else if (isTimeoutError(err)) {
          // Only the short submit call can time out now (polls are handled inside
          // drivePolledDeploy); killing it does NOT stop an already-enqueued deploy.
          this.reportDeployTimeout(labeledAction, err);
        } else this.reportError(labeledAction, err);
      } finally {
        if (!keepPersisted) this.clearActiveJob();
        this.currentCancel = undefined;
        this.currentDeployJobId = undefined;
        this.currentDeployOrg = undefined;
        this.setBusy(false);
      }
    } finally {
      releaseBusy();
    }
    if (detection) return { status: 'failed', missing: detection.keys, unresolved: detection.unresolved };
    // A run that never reached a terminal result (or was cancelled org-side,
    // which reportPolledDeploy already carded) is NOT a success — an
    // auto-resolve loop must stop without claiming the deploy landed.
    return sawTerminal ? { status: 'ok', missing: [], unresolved: [] } : ABORTED;
  }

  // ---- Dependency suggestions (failure-card "Try with dependencies") ----

  /** Server-side truth for suggestion cards currently alive in the webview.
   *  The webview only ever echoes an id and a SELECTION; every key it picks is
   *  validated against this map, so a forged message can neither mint a deploy
   *  key nor resurrect an expired suggestion. Bounded: oldest evicted. */
  private liveSuggestions = new Map<string, { candidates: SuggestionCandidateInfo[]; retry: RetryRequest; orgLabel: string }>();
  private suggestionSeq = 0;

  private rememberSuggestion(id: string, data: { candidates: SuggestionCandidateInfo[]; retry: RetryRequest; orgLabel: string }): void {
    this.liveSuggestions.set(id, data);
    // A handful of live cards is plenty — suggestions are meant to be acted on
    // right after the failure, and stale ones render inert after a reload anyway.
    while (this.liveSuggestions.size > 10) {
      const oldest = this.liveSuggestions.keys().next().value;
      if (oldest === undefined) break;
      this.liveSuggestions.delete(oldest);
    }
  }

  private suggestionEntries(): SuggestionLogEntry[] {
    return this.context.globalState.get<SuggestionLogEntry[]>(SUGGESTION_LOG_KEY, []);
  }

  /** Append or update the entry for `id` — the FULL id, because two cards can
   *  share an at-stamp (same-millisecond failures) and must not merge. A patch
   *  field set to undefined CLEARS it (see mergeSuggestionEntry). */
  private async writeSuggestionEntry(id: string, patch: Partial<SuggestionLogEntry>): Promise<void> {
    const next = mergeSuggestionEntry(this.suggestionEntries(), id, this.suggestionAt(id), patch);
    // Persistence failure must never break the deploy flow — the log is a
    // feedback notebook, not state.
    await Promise.resolve(this.context.globalState.update(SUGGESTION_LOG_KEY, next)).catch(() => undefined);
  }

  /** The at-stamp doubles as the log correlation id; parse it back out of the
   *  card's suggestion id ("sug-<at>-<seq>"). */
  private suggestionAt(id: string): number {
    const m = /^sug-(\d+)-\d+$/.exec(id);
    return m ? Number(m[1]) : Date.now();
  }

  /** "Show Suggestion Log" command: open the copy-pasteable summary. */
  async showSuggestionLog(): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({ content: formatSuggestionLog(this.suggestionEntries()), language: 'plaintext' });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  /** Resolve the effective Apex test level + class list (and its confirm-modal
   *  note) for a deploy/validate request — shared by the immediate path
   *  (runDeploy), the enqueue path (enqueueDeploy) and the manifest path
   *  (runManifestDeploy) so a confirm's test-level note is exactly the plan that
   *  will actually run. Returns undefined (after showing its own warning) when
   *  RunSpecifiedTests has no valid class name — the caller must bail without
   *  proceeding. */
  private resolveTestPlan(
    opts: { validateOnly?: boolean; testLevel?: TestLevel; runTests?: string[] },
    isProd: boolean
  ): { testLevel: TestLevel; runTests: string[]; testNote: string } | undefined {
    // Production defaults to running local tests (the org requires them anyway);
    // sandbox defaults to no tests. The configured default sits between the
    // panel's own pick and that hardcoded smart fallback — it only kicks in when
    // neither this call nor the panel/session has an opinion.
    const requested: TestLevel = opts.testLevel
      ?? this.testLevel
      ?? this.configuredTestLevel()
      ?? (isProd ? 'RunLocalTests' : 'NoTestRun');

    // `sf project deploy validate` has no NoTestRun at all — its --test-level
    // defaults to RunLocalTests. Resolving that here, rather than passing
    // NoTestRun on and omitting the flag at the deploy site, is what keeps the
    // confirm modal, the echoed command and the card's retry request describing
    // the tests the org will really run.
    const validateForcesTests = !!opts.validateOnly && requested === 'NoTestRun';
    const testLevel: TestLevel = validateForcesTests ? 'RunLocalTests' : requested;

    let runTests: string[] = [];
    if (testLevel === 'RunSpecifiedTests') {
      const candidates = opts.runTests ?? this.runTests ?? [];
      // Class names become CLI argv (`--tests <name>`) — reject anything that
      // isn't a bare Apex identifier (dots allowed for `Namespace.Class`) so a
      // stray shell metacharacter typed into the panel can't inject an extra flag.
      runTests = candidates.filter(c => /^[A-Za-z0-9_.]+$/.test(c));
      if (runTests.length < candidates.length) {
        this.output.appendLine(`[RunSpecifiedTests] ignored ${candidates.length - runTests.length} invalid class name(s) (must match /^[A-Za-z0-9_.]+$/)`);
      }
      if (runTests.length === 0) {
        vscode.window.showWarningMessage('RunSpecifiedTests needs at least one test class name.');
        return undefined;
      }
    }

    // The note names the level in EVERY case, NoTestRun included. An empty note
    // stayed silent about the one outcome a user is least likely to expect — a
    // deploy that runs no tests at all — which is exactly the case the modal
    // exists to disclose.
    //
    // NoTestRun against production is additionally a level the ORG refuses when
    // the payload contains Apex, so the note warns there. It cannot be reached by
    // the smart default (production falls back to RunLocalTests) — only an
    // explicit pick in the panel or defaultTestLevel gets here, i.e. the user
    // meant it and the deploy is about to bounce. It warns rather than refuses
    // because NoTestRun is legitimate for an Apex-free payload, and nothing here
    // knows whether this one carries Apex.
    const testNote = validateForcesTests
      ? '\n\nTests: RunLocalTests — a validation always runs tests, so NoTestRun does not apply.'
      : testLevel === 'NoTestRun'
        ? (isProd
          ? '\n\nTests: none (NoTestRun) — Salesforce rejects this for a production deploy that contains Apex.'
          : '\n\nTests: none (NoTestRun)')
      : testLevel === 'RunSpecifiedTests' ? `\n\nTests: RunSpecifiedTests (${runTests.length} class${runTests.length === 1 ? '' : 'es'})`
      : `\n\nTests: ${testLevel}`;
    return { testLevel, runTests, testNote };
  }

  /** Build the deploy/validate confirm modal's message/options/label — shared by
   *  the immediate path (runDeploy) and the enqueue path (enqueueDeploy) so a
   *  queued confirm shows EXACTLY the same information an immediate one would.
   *  `queued` adds a "Queue: " message prefix and a detail line noting the deploy
   *  waits for the current operation to finish; `ignoreConflicts` adds the
   *  overwrite-mode notice (see overwriteNotice). With `queued: false` and the
   *  override off this reproduces the pre-existing modal byte-for-byte. */
  private deployConfirmModal(
    args: {
      noun: string; orgLabel: string; isProd: boolean; validateOnly: boolean; testNote: string;
      instanceUrl?: string; ignoreConflicts: boolean; autoIncluded?: { count: number; entryKey: string };
    },
    queued: boolean
  ): { message: string; options: vscode.MessageOptions; confirmLabel: string } {
    const { noun, orgLabel, isProd, validateOnly, testNote, instanceUrl, ignoreConflicts, autoIncluded } = args;
    const prefix = queued ? 'Queue: ' : '';
    const confirmLabel = validateOnly ? 'Validate' : (isProd ? 'Deploy to PROD' : 'Deploy');
    const queueNote = queued ? 'Runs after the current operation finishes.' : undefined;
    const overwriteLine = overwriteNotice(ignoreConflicts, validateOnly, queued);
    const autoLine = autoIncludedNotice(autoIncluded);
    if (isProd && !validateOnly) {
      return {
        message: `${prefix}⚠ Deploy ${noun} to PRODUCTION (${orgLabel})?\n\n${queued ? 'This change will be live on PRODUCTION as soon as it runs.' : 'This change will be live immediately.'}${testNote}`,
        options: { modal: true, detail: [instanceUrl ?? '', autoLine, overwriteLine, queueNote].filter(Boolean).join('\n') },
        confirmLabel
      };
    }
    // Below prod: keep the pre-existing shape — with no lines to show at all the
    // `detail` key stays absent rather than becoming an empty string.
    const rest = [autoLine, overwriteLine, queueNote].filter(Boolean);
    const detail = isProd
      ? [instanceUrl ?? '', ...rest].filter(Boolean).join('\n')
      : (rest.length > 0 ? rest.join('\n') : undefined);
    return {
      message: `${prefix}${validateOnly
        ? `Validate ${noun} against ${orgLabel}? (check-only — nothing is deployed)`
        : `Deploy ${noun} to ${orgLabel}?`}${testNote}`,
      options: { modal: true, ...(detail !== undefined ? { detail } : {}) },
      confirmLabel
    };
  }

  /** A deploy/validate that arrived while the busy slot was taken (see the top of
   *  runDeploy): the single busy slot stays the invariant — retrieve/diff/
   *  delete/fetch/login still refuse outright — but a deploy/validate is
   *  deferred onto `deployQueue` instead, to run automatically once the running
   *  operation frees the slot (setBusy(false) schedules drainQueue). Resolves
   *  items/org/labels exactly like the immediate path in runDeploy and shows the
   *  SAME confirm modal (PROD warning + test-level note included) via
   *  deployConfirmModal — just prefixed "Queue: " with a note that it waits for
   *  the current operation. The target org is PINNED right now (named in the
   *  modal, and used again by drainQueue) — a later org switch in the panel
   *  can't retarget an already-queued deploy. */
  private async enqueueDeploy(
    keys: string[],
    opts: {
      sourceDir?: string; validateOnly?: boolean; testLevel?: TestLevel; runTests?: string[];
      /** Display only — see runDeploy. Carried so a "Deploy File + Dependencies"
       *  that lands on a busy slot discloses the same split at confirm time; it is
       *  deliberately NOT stored on the queue entry, because drainQueue re-enters
       *  runDeploy preConfirmed and shows no second modal. */
      autoIncluded?: { count: number; entryKey: string };
    }
  ): Promise<void> {
    const root = this.requireRoot();
    if (!root) return;
    const org = this.requireOrg();
    if (!org) return;
    const items = this.resolveKeys(keys).filter(i => !!i.filePath);
    if (items.length === 0) {
      vscode.window.showInformationMessage('Selected component(s) have no local source — retrieve them first before deploying.');
      return;
    }

    const orgInfo = this.orgs.find(o => o.username === org);
    const orgLabel = orgInfo?.alias ?? org;
    const isProd = isLikelyProduction(orgInfo);
    const n = items.length;
    const noun = `${n} component${n === 1 ? '' : 's'}`;

    const plan = this.resolveTestPlan(opts, isProd);
    if (!plan) return;
    const { testLevel, runTests, testNote } = plan;

    // The override is machine-scoped and re-read by runDeploy when the queue
    // drains, so what's true NOW is only a snapshot — the queued variant of the
    // notice says so rather than pinning the flag (pinning would change which
    // flags a queued deploy actually runs with).
    const modal = this.deployConfirmModal(
      {
        noun, orgLabel, isProd, validateOnly: !!opts.validateOnly, testNote,
        instanceUrl: orgInfo?.instanceUrl, ignoreConflicts: this.ignoreDeployConflicts(),
        autoIncluded: opts.autoIncluded
      },
      true
    );
    // Cap BEFORE the modal — confirming a deploy only to be told "queue full"
    // wastes the user's read of a modal that could never be honored.
    if (this.deployQueue.length >= DEPLOY_QUEUE_MAX) {
      vscode.window.showInformationMessage(`SF Deploy: queue full (${DEPLOY_QUEUE_MAX} max) — wait for a queued operation to run before adding another.`);
      return;
    }
    const confirm = await vscode.window.showWarningMessage(modal.message, modal.options, modal.confirmLabel);
    if (!confirm) return;
    // Re-check at the push: the early check avoids showing a doomed modal, but
    // the await above is a TOCTOU window — concurrent enqueues could all pass
    // the early check and overshoot the cap (safety gate finding, probe-proven).
    if (this.deployQueue.length >= DEPLOY_QUEUE_MAX) {
      vscode.window.showInformationMessage(`SF Deploy: the queue filled up while the confirmation was open (${DEPLOY_QUEUE_MAX} max) — this deploy was NOT queued.`);
      return;
    }
    this.deployQueue.push({
      id: crypto.randomBytes(8).toString('hex'),
      keys: items.map(i => `${i.type}:${i.name}`),
      opts: { validateOnly: opts.validateOnly, testLevel, runTests: runTests.length ? runTests : undefined, sourceDir: opts.sourceDir },
      org,
      orgLabel,
      noun: `${opts.validateOnly ? 'Validate' : 'Deploy'} ${noun}`
    });
    this.postQueue();
    vscode.window.setStatusBarMessage(`$(watch) SF Deploy: queued (position ${this.deployQueue.length})`, 5000);
    // The running operation may have FINISHED while the confirm modal was open —
    // its setBusy(false) drain then saw an empty queue, and nothing else would
    // ever run this item (post-release review, MED). If the slot is already
    // free, kick the drain ourselves.
    if (!this.busy) queueMicrotask(() => this.drainQueue());
  }

  /** Run the next queued deploy/validate now that the busy slot is free (see
   *  setBusy). No-op if something already re-took the slot or the queue is
   *  empty. The org pinned at enqueue time must still be authenticated; if it
   *  dropped off `this.orgs` (session ended, org removed) since, skip that entry
   *  with an honest card and try the next one instead of silently discarding it
   *  or firing against the wrong org. Otherwise re-enters runDeploy with
   *  preConfirmed+orgOverride so it runs WITHOUT a second confirm, strictly
   *  against the pinned org — even if the panel's org selector has since moved
   *  on to something else. */
  private drainQueue(): void {
    if (this.busy || this.deployQueue.length === 0) return;
    const next = this.deployQueue.shift()!;
    this.postQueue();
    if (!this.orgs.some(o => o.username === next.org)) {
      this.post({
        type: 'status',
        card: {
          kind: 'warn',
          title: `Queued deploy skipped — ${next.orgLabel} is no longer authenticated`,
          lines: next.keys
        }
      });
      this.drainQueue();
      return;
    }
    void this.runDeploy(next.keys, { ...next.opts, orgOverride: next.org, preConfirmed: true });
  }

  /** Push the current queue to the webview — on every change, AND from the
   *  `ready` handler, so the queue strip is never stale across a webview
   *  rebuild (e.g. the sidebar collapsed and reopened mid-session). */
  private postQueue(): void {
    this.post({
      type: 'queue',
      items: this.deployQueue.map(q => ({ id: q.id, noun: q.noun, orgLabel: q.orgLabel }))
    });
  }

  /** Render the status card for a completed deploy/validate, including Apex test
   *  failures (surfaced when a test-level ran) and a Quick Deploy affordance for a
   *  successful validation. */
  /** Posts the deploy/validate result card. Returns the dependency detection for
   *  a FAILED deploy (undefined on success) so an auto-resolving retry can decide
   *  whether another round would add anything. */
  private reportDeployResult(
    result: DeployResult,
    ctx: {
      items: MetadataItem[];
      orgOnlySkipped: MetadataItem[];
      orgLabel: string;
      org: string;
      noun: string;
      cmdId: string;
      start: number;
      validateOnly: boolean;
      retry?: RetryRequest;
    }
  ): MissingDependencies | undefined {
    const { items, orgOnlySkipped, orgLabel, org, cmdId, start, validateOnly } = ctx;
    // Per-component results live under `details.*` on older `sf` output and under
    // `files` on newer output — read both so failures are never silently dropped
    // (and the success gate accounts for both).
    const detailFailures = result.details?.componentFailures ?? [];
    const fileFailures = (result.files ?? []).filter(f => f.state === 'Failed' || !!fileProblem(f));
    const failures = detailFailures.length ? detailFailures : fileFailures;
    const successes = deploySuccessRows(result);
    const testFailures: DeployTestFailure[] = result.details?.runTestResult?.failures ?? [];
    const success = result.success
      && (result.numberComponentErrors == null || result.numberComponentErrors === 0)
      && failures.length === 0
      && testFailures.length === 0;
    const lines = items.map(i => `${i.type}:${i.name}`);
    const skipLines = orgOnlySkipped.map(i => `— ${i.type}:${i.name} — no local source, skipped (retrieve first)`);
    const testMeta = result.numberTestsTotal
      ? ` · ${(result.numberTestsTotal ?? 0) - (result.numberTestErrors ?? 0)}/${result.numberTestsTotal} tests passed`
      : '';
    this.endCmd(cmdId, success, Date.now() - start);
    if (success) {
      if (validateOnly && result.id) {
        // Remember the validated deployment so the card's Quick Deploy button can
        // deploy it without re-validating / re-running tests.
        this.lastValidated = { jobId: result.id, org, label: orgLabel, count: items.length };
      }
      // A real deploy landed these on the org — refresh their badges. Validate-only
      // lands nothing. Failure path deliberately skipped: deploys are atomic
      // (rollbackOnError is never disabled by this extension), so a failed run
      // leaves org membership as it was.
      if (!validateOnly) this.confirmDeployedOnOrg(successes, items, org, orgLabel);
      this.post({
        type: 'status',
        card: {
          kind: orgOnlySkipped.length > 0 ? 'warn' : 'ok',
          title: validateOnly
            ? `Validated ${items.length} component${items.length === 1 ? '' : 's'} against ${orgLabel}`
            : `Deployed ${items.length} component${items.length === 1 ? '' : 's'} to ${orgLabel}`,
          meta: `${result.numberComponentsDeployed ?? successes.length}/${result.numberComponentsTotal ?? items.length} succeeded${testMeta}${orgOnlySkipped.length > 0 ? ` · ${orgOnlySkipped.length} skipped` : ''}`,
          lines: [...lines, ...skipLines],
          // Built from the ITEMS, not from the display lines: a manifest deploy
          // synthesizes its items straight from <members> (wildcards and all) and
          // a reattached job synthesizes them from the org's own report, so those
          // "keys" name nothing the tree could ever tick. selectDeployedButtons
          // keeps only the rows backed by local source — which for a normal run is
          // the whole set, so re-selection reproduces the run exactly.
          ...this.selectDeployedButtons(items),
          ...(validateOnly && result.id
            ? { quickDeploy: { jobId: result.id, label: `Quick Deploy ${items.length} validated component${items.length === 1 ? '' : 's'} to ${orgLabel}` } }
            : {})
        }
      });
      this.notifySuccessIfPanelHidden(validateOnly ? `Validated ${ctx.noun} against ${orgLabel}` : `Deployed ${ctx.noun} to ${orgLabel}`);
    } else {
      // The org's request-level message. Read for EVERY failure, not just the
      // no-rows one: it costs one extra problem string, a duplicate of a
      // component problem simply dedupes inside the detector, and hard-coding
      // "only when there are no rows" would be a second rule to keep in sync with
      // the two result shapes above.
      const envProblem = envelopeProblem(result);
      // Structured lines: `key` (+ optional line/column) makes the row clickable
      // in the panel — it opens the source in a preview tab at the error position.
      const errLines = failures.length
        ? failures.map(f => {
            const key = this.localFailureKey(f, items);
            return {
              text: `${fileType(f)}:${f.fullName} — ${fileProblem(f) ?? 'failed'}${f.lineNumber ? ` (line ${f.lineNumber})` : ''}`,
              ...(key ? { key } : {}),
              ...(f.lineNumber ? { line: f.lineNumber, ...(f.columnNumber ? { column: f.columnNumber } : {}) } : {})
            };
          })
        : (testFailures.length ? [] : [envProblem
          // Say WHAT the org rejected instead of only that it rejected something:
          // with no component rows this is the only text there is, and it is the
          // same string the detection below parses.
          ? `Deploy reported failure with no per-component details: ${envProblem}`
          : 'Deploy reported failure with no per-component details.']);
      const testLines = testFailures.map(t => {
        // Apex stack traces read "Class.Foo.testBar: line 12, column 1".
        const pos = /line (\d+)(?:, column (\d+))?/.exec(t.stackTrace ?? '');
        const key = t.name
          ? this.localFailureKey({ type: 'ApexClass', fullName: t.name })
          : undefined;
        return {
          text: `✗ test ${t.name ?? '?'}.${t.methodName ?? '?'} — ${stripAnsi(t.message ?? 'failed').split('\n')[0]}`,
          ...(key ? { key } : {}),
          ...(pos ? { line: Number(pos[1]), ...(pos[2] ? { column: Number(pos[2]) } : {}) } : {})
        };
      });

      // A failed deploy can reference a component that's missing on the org but
      // DOES exist locally (e.g. a FlexiPage's QuickAction, or an Apex class
      // whose dependency didn't make it into this same batch) — offer to retry
      // WITH it added, instead of making the user hunt it down and re-select it
      // by hand. Only offered when there's a discrete key list to extend (a
      // manifest-based retry has none).
      const retryKeys = ctx.retry?.keys;
      // Detection runs even without a discrete key list (a manifest retry has
      // none): the RESOLVED keys can only be offered when there's a list to
      // extend, but the "referenced but not in your workspace" diagnosis is
      // useful for every failed deploy, and it's the only feedback the user gets
      // when the missing dependency isn't in the workspace at all.
      // Every failure text this result carries: the per-component rows PLUS the
      // request-level message — which is all there is when the org rejected the
      // deploy without naming components, the case that used to reach the
      // detector as an empty list and produce silence. One list feeds both the
      // diagnosis and the suggestion candidates, so the card can't offer a
      // suggestion the diagnosis doesn't know about (or the reverse). The
      // envelope row has no `from` (no component owns it); the card renders that
      // as a plain "add Type:Name".
      const problemRows: Array<{ from?: string; problem: string }> = failures.map(f => ({
        from: `${fileType(f)}:${f.fullName}`,
        problem: fileProblem(f) ?? ''
      }));
      if (envProblem) problemRows.push({ problem: envProblem });
      const deps = detectMissingDependencies(
        problemRows.map(row => row.problem),
        this.items,
        new Set(retryKeys ?? items.map(i => `${i.type}:${i.name}`))
      );
      const buttons = ctx.retry
        ? [
            { label: validateOnly ? 'Retry validation' : 'Retry deploy', send: { type: 'retryDeploy', request: ctx.retry } }
            // "Retry + changed vs branch" was offered here in 0.15.0 and removed
            // on user feedback — the Changed lens already owns that workflow. The
            // retryDeployChanged handler stays: persisted 0.15.0 cards still
            // carry the button, and it may return in some future form.
          ]
        : undefined;
      // Per-row suggestion candidates for the card's "Try with dependencies"
      // view. Same sourceDir exclusion as above (the retry couldn't carry the
      // added keys), and only when there's a discrete key list to extend (a
      // manifest retry has none). The card keeps the suggestion UI; the provider
      // keeps the authority: liveSuggestions holds the server-side truth the
      // webview's clicks are validated against.
      const suggest = retryKeys && !ctx.retry?.sourceDir
        ? buildSuggestionCandidates(problemRows, this.items, new Set(retryKeys))
        : [];
      let suggestPayload: { id: string; candidates: SuggestionCandidateInfo[]; unresolved: string[] } | undefined;
      if (suggest.length && ctx.retry) {
        const id = `sug-${Date.now()}-${this.suggestionSeq++}`;
        this.rememberSuggestion(id, { candidates: suggest, retry: ctx.retry, orgLabel });
        suggestPayload = { id, candidates: suggest, unresolved: deps.unresolved };
      }
      // The unresolved diagnosis still renders as a guidance line when there is
      // no suggestion UI to carry it (nothing resolved locally, or manifest/
      // sourceDir deploys) — it's the only feedback in that case. FIRST, because
      // panel.js collapses a card past MAX_CARD_LINES.
      const guidanceLines = suggestPayload ? [] : [
        // A sourceDir-pinned retry can't be extended automatically (--source-dir
        // beats --metadata) and a manifest retry has no key list — but the user
        // still deserves to KNOW what's missing; that's the 0.14.0 behavior.
        ...(retryKeys && deps.keys.length ? [`Missing but available locally: ${deps.keys.join(', ')} — add them to the deploy by hand.`] : []),
        ...(deps.unresolved.length
          ? [`Referenced but not found in your workspace: ${deps.unresolved.join(', ')} — retrieve it from an org that has it, or fix the reference.`]
          : [])
      ];

      this.post({
        type: 'status',
        card: {
          kind: 'err',
          title: validateOnly ? `Validation failed against ${orgLabel}` : `Deploy failed against ${orgLabel}`,
          meta: `${failures.length} component failure${failures.length === 1 ? '' : 's'}, ${successes.length} success${testFailures.length ? ` · ${testFailures.length} test failure${testFailures.length === 1 ? '' : 's'}` : ''}`,
          lines: [
            ...guidanceLines,
            ...errLines,
            ...testLines,
            ...skipLines
          ],
          ...(buttons ? { buttons } : {}),
          ...(suggestPayload ? { suggest: suggestPayload } : {})
        }
      });
      // An auto-resolving retry round that is about to run again suppresses its
      // own toast — otherwise one logical "resolve the dependencies" action
      // fires a failure toast per round. The final round always reports.
      const failureSummary = `${validateOnly ? 'Validation' : 'Deploy'} failed against ${orgLabel} — ${failures.length ? `${failures.length} component failure${failures.length === 1 ? '' : 's'}` : `${testFailures.length} test failure${testFailures.length === 1 ? '' : 's'}`}.`;
      // Details also mirror into the output channel so "Show Output" opens a log
      // that actually mentions the failure.
      this.failureToast(failureSummary, [...errLines, ...testLines]);
      return deps;
    }
    return undefined;
  }

  // ---- Async deploy: poll / cancel / reattach ----

  /**
   * Drive an already-submitted async job to completion: poll for progress (mirrored
   * to the notification + the in-panel card), then dispatch the outcome. Terminal →
   * `onTerminal(result)` renders the caller's result card. Lost contact → the
   * lost-contact card, and returns `keepPersisted: true` so the caller KEEPS the
   * persisted job for reattach. Cancelled-but-unconfirmed → an honest cancelled card.
   * Never throws (pollDeployJob owns its own errors), so the caller's catch is left
   * for the SUBMIT only.
   */
  private async drivePolledDeploy(
    args: { jobId: string; org: string; orgLabel: string; root: string; verb: DeployVerb; noun: string; cmdId: string; start: number; progressTitle: string },
    report: (message: string) => void,
    onTerminal: (result: DeployResult) => void
  ): Promise<{ keepPersisted: boolean }> {
    const { jobId, org, orgLabel, root, verb, cmdId, start, progressTitle } = args;
    const outcome = await this.pollDeployJob(jobId, org, root, result => {
      const msg = this.formatDeployProgress(result);
      report(msg);
      this.postProgress(`${progressTitle}: ${msg}`);
    });
    const prep = orgPrep(verb);
    if (outcome.kind === 'lost') {
      this.endCmd(cmdId, false, Date.now() - start);
      this.reportDeployLostContact(jobId, orgLabel, verb);
      return { keepPersisted: true };
    }
    if (outcome.kind === 'cancelled') {
      this.endCmd(cmdId, false, Date.now() - start);
      this.reportCancelled(`${verb} ${prep} ${orgLabel}`, outcome.note);
      return { keepPersisted: false };
    }
    onTerminal(outcome.result);
    return { keepPersisted: false };
  }

  /**
   * Poll `deploy report` for a submitted job until it reaches a terminal state,
   * calling `progress` with each fresh snapshot. Installs the graceful-cancel
   * closure into `currentCancel`: a Cancel kills the in-flight poll, then
   * `cancelDeployJob` asks the org to stop and reads the REAL final state. A single
   * failed/timed-out poll is transient (retry next tick); DEPLOY_POLL_MAX_FAILURES
   * in a row → `{ kind: 'lost' }` (the caller keeps the job persisted). Never throws.
   */
  private async pollDeployJob(
    jobId: string,
    org: string,
    root: string,
    progress: (result: DeployResult) => void
  ): Promise<PollOutcome> {
    let cancelRequested = false;
    let activePollCancel: (() => void) | undefined;
    let wake: (() => void) | undefined;
    // Cancel = flag it, kill any in-flight poll, and wake an inter-poll sleep so the
    // loop reaches the cancel branch immediately instead of after the full interval.
    this.currentCancel = () => {
      cancelRequested = true;
      if (activePollCancel) activePollCancel();
      if (wake) wake();
    };
    const sleep = (ms: number): Promise<void> => new Promise(resolve => {
      const t = setTimeout(() => { wake = undefined; resolve(); }, ms);
      wake = () => { clearTimeout(t); wake = undefined; resolve(); };
    });

    let consecutiveFailures = 0;
    for (;;) {
      if (cancelRequested) return this.cancelDeployJob(jobId, org, root);
      let result: DeployResult;
      try {
        const h = this.sf.deployReport(jobId, org, root, { timeoutMs: this.timeoutMs() });
        activePollCancel = h.cancel;
        try {
          result = (await h.promise).result;
        } finally {
          activePollCancel = undefined;
        }
      } catch (err) {
        // A cancel killed this poll → loop back so the cancel branch runs.
        if (cancelRequested) continue;
        consecutiveFailures++;
        this.output.appendLine(`[deploy report] poll of ${jobId} failed (${consecutiveFailures}/${DEPLOY_POLL_MAX_FAILURES}): ${err instanceof Error ? err.message : String(err)}`);
        if (consecutiveFailures >= DEPLOY_POLL_MAX_FAILURES) return { kind: 'lost' };
        await sleep(DEPLOY_POLL_INTERVAL_MS);
        continue;
      }
      consecutiveFailures = 0;
      progress(result);
      if (isTerminalDeploy(result)) return { kind: 'terminal', result };
      await sleep(DEPLOY_POLL_INTERVAL_MS);
    }
  }

  /**
   * The user cancelled a running job: ask the org to cancel it (`deploy cancel`),
   * then poll (bounded) for the REAL final state so the card is honest — a job that
   * had already finished reports its actual Succeeded/Failed result, one the org
   * stops reports Canceled, and one still `Canceling` after the bound reports as
   * cancelled-in-progress. If the confirming reports themselves fail, say so rather
   * than claim a state we couldn't read.
   */
  private async cancelDeployJob(jobId: string, org: string, root: string): Promise<PollOutcome> {
    this.output.appendLine(`[Cancel] requesting org-side cancel of deploy ${jobId} on ${org}`);
    try {
      await this.sf.deployCancel(jobId, org, root);
    } catch (e) {
      // The cancel call itself failed — still read the state below; the job may have
      // finished on its own, and the report tells us the truth either way.
      this.output.appendLine(`[Cancel] deploy cancel call failed for ${jobId}: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Cancellation isn't instant (InProgress → Canceling → Canceled), so read a few
    // times until terminal before giving up.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const { result } = await this.sf.deployReport(jobId, org, root, { timeoutMs: this.timeoutMs() }).promise;
        if (isTerminalDeploy(result)) return { kind: 'terminal', result };
      } catch (e) {
        this.output.appendLine(`[Cancel] confirming report for ${jobId} failed: ${e instanceof Error ? e.message : String(e)}`);
        return { kind: 'cancelled', note: 'Asked the org to cancel the deploy, but couldn\'t read the final state — check the org\'s Deployment Status (Setup).' };
      }
      await new Promise(r => setTimeout(r, DEPLOY_POLL_INTERVAL_MS));
    }
    return { kind: 'cancelled', note: 'Asked the org to cancel the deploy — it\'s still finishing cancellation; check the org\'s Deployment Status (Setup).' };
  }

  /** Progress line for a running deploy: "InProgress · components 12/40 · tests 100/321". */
  private formatDeployProgress(result: DeployResult): string {
    const status = typeof result.status === 'string' && result.status ? result.status : 'In progress';
    const parts: string[] = [];
    const cTotal = result.numberComponentsTotal ?? 0;
    if (cTotal > 0) parts.push(`components ${result.numberComponentsDeployed ?? 0}/${cTotal}`);
    const tTotal = result.numberTestsTotal ?? 0;
    if (tTotal > 0) parts.push(`tests ${result.numberTestsCompleted ?? 0}/${tTotal}`);
    return parts.length ? `${status} · ${parts.join(' · ')}` : status;
  }

  /** Render the terminal card for a polled deploy/validate. A `Canceled` status gets
   *  an honest "cancelled" card (the org actually stopped it); everything else goes
   *  through the normal result renderer. */
  private reportPolledDeploy(
    result: DeployResult,
    ctx: { items: MetadataItem[]; orgOnlySkipped: MetadataItem[]; orgLabel: string; org: string; noun: string; cmdId: string; start: number; validateOnly: boolean; verb: DeployVerb; retry?: RetryRequest }
  ): MissingDependencies | undefined {
    if ((typeof result.status === 'string' ? result.status : '') === 'Canceled') {
      this.endCmd(ctx.cmdId, false, Date.now() - ctx.start);
      this.reportCancelled(`${ctx.verb} ${orgPrep(ctx.verb)} ${ctx.orgLabel}`, 'The org cancelled the deploy.');
      return undefined;
    }
    return this.reportDeployResult(result, ctx);
  }

  /** Honest card when we lose contact with a running job (5 failed polls in a row):
   *  it may still be running, the job is kept persisted, and reopening the panel
   *  reattaches. */
  private reportDeployLostContact(jobId: string, orgLabel: string, verb: DeployVerb): void {
    const prep = verb === 'Validate' ? 'against' : 'to';
    this.post({
      type: 'status',
      card: {
        kind: 'err',
        title: `Lost contact with ${verb.toLowerCase()} ${prep} ${orgLabel}`,
        meta: `Job ${jobId} may still be running on the org`,
        hint: 'Resume monitoring checks the existing job — it does not submit the deployment again.',
        buttons: [{ label: 'Resume monitoring', send: { type: 'resumeDeploy', jobId } }]
      }
    });
    this.failureToast(`Lost contact with the ${verb.toLowerCase()} ${prep} ${orgLabel} — it may still be running. Open the panel and choose Resume monitoring.`);
  }

  /** Synthesize a MetadataItem list from a deploy report's per-component rows, so a
   *  REATTACHED deploy (whose original selection is gone after a reload) still gets a
   *  populated result card. The `package.xml` pseudo-row is skipped. */
  private itemsFromReport(result: DeployResult): MetadataItem[] {
    const rows = [
      ...(result.details?.componentSuccesses ?? []),
      ...(result.details?.componentFailures ?? []),
      ...(result.files ?? [])
    ];
    const seen = new Set<string>();
    const items: MetadataItem[] = [];
    for (const r of rows) {
      if (!r?.type || !r?.fullName) continue;
      if (r.type === 'package.xml' || r.fullName === 'package.xml') continue;
      const key = `${r.type}:${r.fullName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ type: r.type, name: r.fullName, filePath: '', files: [] });
    }
    return items;
  }

  // ---- Async deploy: persistence + reattach ----

  /** Persist the in-flight async job so a reload can reattach. Fire-and-forget like
   *  the other workspaceState writes — a lost write only forgoes one reattach. */
  private persistActiveJob(job: ActiveDeployJob): void {
    void Promise.resolve(this.context.workspaceState.update(ACTIVE_JOB_KEY, job))
      .catch(err => this.output.appendLine(`[activeJob] persist failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Clear the persisted job on any terminal outcome. */
  private clearActiveJob(): void {
    void Promise.resolve(this.context.workspaceState.update(ACTIVE_JOB_KEY, undefined))
      .catch(err => this.output.appendLine(`[activeJob] clear failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Read the persisted job, shape- and charset-guarded (the state DB can hand back
   *  anything after corruption or a hand edit, and jobId becomes a `--job-id` argv
   *  token). Returns undefined on any mismatch. */
  private readActiveJob(): ActiveDeployJob | undefined {
    const raw = this.context.workspaceState.get<unknown>(ACTIVE_JOB_KEY);
    if (!raw || typeof raw !== 'object') return undefined;
    const j = raw as Partial<ActiveDeployJob>;
    if (typeof j.jobId !== 'string' || !/^[A-Za-z0-9]+$/.test(j.jobId)) return undefined;
    // `org` becomes a `--target-org` argv token: inert under execFile, but a
    // flag-shaped value from a tampered state DB has no honest reading — reject.
    if (typeof j.org !== 'string' || j.org.startsWith('-') || /\s/.test(j.org)) return undefined;
    if (typeof j.orgLabel !== 'string' || typeof j.noun !== 'string') return undefined;
    if (typeof j.startedAt !== 'number') return undefined;
    if (j.verb !== 'Deploy' && j.verb !== 'Validate' && j.verb !== 'Quick Deploy') return undefined;
    return { jobId: j.jobId, org: j.org, orgLabel: j.orgLabel, startedAt: j.startedAt, verb: j.verb, noun: j.noun };
  }

  /** On panel `ready`: if a still-recent async job is persisted and the busy slot is
   *  free, reattach and resume polling it. If the slot is busy, leave it persisted —
   *  the next ready retries. A finished job's `deploy report` still returns its
   *  result, so reattaching after completion simply reports the outcome and clears. */
  private maybeReattachDeploy(): void {
    const job = this.readActiveJob();
    if (!job) return;
    if (Date.now() - job.startedAt > ACTIVE_JOB_MAX_AGE_MS) { this.clearActiveJob(); return; }
    if (this.busy) return; // an op holds the slot — leave the job for the next ready
    if (!this.reserveBusy(job.verb)) return;
    void this.reattachDeployJob(job);
  }

  /** User-triggered counterpart to maybeReattachDeploy, reached from a lost-contact
   *  card. The webview-provided id is never used directly in CLI argv: it must match
   *  the shape-validated job persisted by the provider. Resuming only polls that
   *  existing job; it cannot submit a duplicate deployment. */
  private resumeDeployMonitoring(requestedJobId: string | undefined): void {
    const job = this.readActiveJob();
    if (!job || typeof requestedJobId !== 'string' || requestedJobId !== job.jobId) {
      vscode.window.showInformationMessage('That deployment is no longer available to resume. Check Deployment Status in the org for its final result.');
      return;
    }
    if (Date.now() - job.startedAt > ACTIVE_JOB_MAX_AGE_MS) {
      this.clearActiveJob();
      vscode.window.showInformationMessage('That deployment is too old to resume here. Check Deployment Status in the org for its final result.');
      return;
    }
    if (!this.workspaceRoot) {
      vscode.window.showWarningMessage('Open the Salesforce DX project before resuming deployment monitoring.');
      return;
    }
    if (this.busy) { this.notifyBusy(); return; }
    if (!this.reserveBusy(job.verb)) return;
    void this.reattachDeployJob(job);
  }

  /** Resume polling a persisted job under a fresh progress notification, reporting
   *  its outcome exactly like a live deploy. Mirrors runDeploy's finally discipline
   *  (clear cancel/job pins, release the slot; keep the persisted job only on lost
   *  contact). The original component selection is gone, so the result card's list is
   *  synthesized from the report (itemsFromReport). */
  private async reattachDeployJob(job: ActiveDeployJob): Promise<void> {
    const root = this.workspaceRoot ?? process.cwd();
    const prep = orgPrep(job.verb);
    const cmdId = this.beginCmd(`sf project deploy report --job-id ${job.jobId} --target-org ${job.org}`);
    const start = Date.now();
    const progressTitle = `Reattaching to ${job.verb.toLowerCase()} of ${job.noun} ${prep} ${job.orgLabel}`;
    this.currentDeployJobId = job.jobId;
    this.currentDeployOrg = job.org;
    let keepPersisted = false;
    try {
      await this.withWindowProgress(progressTitle, async report => {
        this.postProgress(`${progressTitle}…`);
        const outcome = await this.drivePolledDeploy(
          { jobId: job.jobId, org: job.org, orgLabel: job.orgLabel, root, verb: job.verb, noun: job.noun, cmdId, start, progressTitle }, report,
          result => {
            const items = this.itemsFromReport(result);
            // The persisted verb is the ONLY record that this job was check-only
            // (a validation) once the original run's opts are gone — read once, for
            // both the card and its retry, so the two can never disagree.
            const modes = verbModes(job.verb);
            this.reportPolledDeploy(result, {
              items, orgOnlySkipped: [], orgLabel: job.orgLabel, org: job.org,
              noun: job.noun, cmdId, start, ...modes, verb: job.verb,
              // Reattached cards synthesize their component list from the report —
              // retry re-deploys that set under the CURRENT panel defaults.
              retry: { keys: items.map(i => `${i.type}:${i.name}`), ...modes }
            });
          }
        );
        keepPersisted = outcome.keepPersisted;
      });
    } catch (err) {
      this.endCmd(cmdId, false, Date.now() - start);
      this.reportError(`${job.verb} ${prep} ${job.orgLabel}`, err);
    } finally {
      if (!keepPersisted) this.clearActiveJob();
      this.currentCancel = undefined;
      this.currentDeployJobId = undefined;
      this.currentDeployOrg = undefined;
      this.setBusy(false);
    }
  }

  /** Quick-deploy a previously-validated deployment by its job id — no re-run of
   *  validation or tests. Guarded to the same org the validation ran against. */
  private async runQuickDeploy(jobId: string): Promise<void> {
    if (!this.reserveBusy('Deploy')) return;
    let reserved = true;
    try {
      const root = this.requireRoot();
      if (!root) return;
      const validated = this.lastValidated;
      if (!validated || validated.jobId !== jobId) {
        vscode.window.showWarningMessage('That validated deployment is no longer available — validate again before quick-deploying.');
        return;
      }
      const org = validated.org;
      const orgLabel = validated.label;
      const orgInfo = this.orgs.find(o => o.username === org);
      const isProd = isLikelyProduction(orgInfo);
      const confirm = await vscode.window.showWarningMessage(
        isProd
          ? `⚠ Quick Deploy ${validated.count} validated component${validated.count === 1 ? '' : 's'} to PRODUCTION (${orgLabel})?\n\nThis change will be live immediately.`
          : `Quick Deploy ${validated.count} validated component${validated.count === 1 ? '' : 's'} to ${orgLabel}?`,
        { modal: true, ...(isProd ? { detail: orgInfo?.instanceUrl ?? '' } : {}) },
        isProd ? 'Deploy to PROD' : 'Deploy'
      );
      if (!confirm) return;
      reserved = false;
      const cmdId = this.beginCmd(`sf project deploy quick --job-id ${jobId} --target-org ${org}`);
      const start = Date.now();
      const noun = `${validated.count} component${validated.count === 1 ? '' : 's'}`;
      const progressTitle = `Quick-deploying ${noun} to ${orgLabel}`;
      let keepPersisted = false;
      try {
        await this.withWindowProgress(progressTitle, async report => {
          this.postProgress(`${progressTitle}…`);
          // Submit the quick deploy ASYNC — it creates a NEW deployment job on the
          // org (its own id, distinct from the validation's) that we then poll.
          const handle = this.sf.quickDeploy(jobId, org, root, { timeoutMs: this.timeoutMs(), background: true });
          this.currentCancel = handle.cancel;
          this.currentDeployOrg = org;
          const { result: submit, cmd } = await handle.promise;
          this.updateCmd(cmdId, cmd);
          // The quick deploy consumes the validation — clear it now we've committed.
          this.lastValidated = undefined;
          const quickJobId = submit.id;
          if (!quickJobId) throw new SfCliError('Quick Deploy submitted but the CLI returned no job id to track.');
          this.currentDeployJobId = quickJobId;
          this.persistActiveJob({ jobId: quickJobId, org, orgLabel, startedAt: Date.now(), verb: 'Quick Deploy', noun });
          const outcome = await this.drivePolledDeploy(
            { jobId: quickJobId, org, orgLabel, root, verb: 'Quick Deploy', noun, cmdId, start, progressTitle }, report,
            result => this.reportQuickDeployResult(result, { org, orgLabel, count: validated.count, cmdId, start })
          );
          keepPersisted = outcome.keepPersisted;
        });
      } catch (err) {
        this.endCmd(cmdId, false, Date.now() - start);
        const labeledAction = `Quick Deploy to ${orgLabel}`;
        if (err instanceof SfCliCancelledError) {
          // A cancel here means the ASYNC SUBMIT was killed before it returned a job
          // id — the org may still have enqueued the quick deploy.
          this.reportCancelled(labeledAction, 'The org-side deploy may still complete — check the org.');
        } else if (isTimeoutError(err)) {
          this.reportDeployTimeout(labeledAction, err);
        } else this.reportError(labeledAction, err);
      } finally {
        if (!keepPersisted) this.clearActiveJob();
        this.currentCancel = undefined;
        this.currentDeployJobId = undefined;
        this.currentDeployOrg = undefined;
        this.setBusy(false);
      }
    } finally {
      if (reserved) this.setBusy(false);
    }
  }

  /** Terminal card for a polled quick deploy. `Canceled` → honest cancelled card;
   *  otherwise the quick-deploy-specific success/failure card. */
  private reportQuickDeployResult(
    result: DeployResult,
    ctx: { org: string; orgLabel: string; count: number; cmdId: string; start: number }
  ): void {
    const { org, orgLabel, count, cmdId, start } = ctx;
    const noun = `${count} component${count === 1 ? '' : 's'}`;
    if ((typeof result.status === 'string' ? result.status : '') === 'Canceled') {
      this.endCmd(cmdId, false, Date.now() - start);
      this.reportCancelled(`Quick Deploy to ${orgLabel}`, 'The org cancelled the deploy.');
      return;
    }
    const failures = result.details?.componentFailures
      ?? (result.files ?? []).filter(f => f.state === 'Failed' || !!fileProblem(f));
    const success = result.success
      && (result.numberComponentErrors == null || result.numberComponentErrors === 0)
      && failures.length === 0;
    this.endCmd(cmdId, success, Date.now() - start);
    if (success) {
      // No original item list survives to a quick deploy (only a count), so the
      // row→item mapping leans on the scanner's current items alone.
      this.confirmDeployedOnOrg(deploySuccessRows(result), [], org, orgLabel);
      this.post({
        type: 'status',
        card: {
          kind: 'ok',
          title: `Quick-deployed ${noun} to ${orgLabel}`,
          meta: `${result.numberComponentsDeployed ?? count} deployed`
        }
      });
      this.notifySuccessIfPanelHidden(`Quick-deployed ${noun} to ${orgLabel}`);
    } else {
      const failLines = failures.map(f => {
        const key = this.localFailureKey(f);
        return {
          text: `${fileType(f)}:${f.fullName} — ${fileProblem(f) ?? 'failed'}`,
          ...(key ? { key } : {})
        };
      });
      this.post({
        type: 'status',
        card: {
          kind: 'err',
          title: `Quick Deploy failed against ${orgLabel}`,
          meta: 'The validation may have expired (validated deployments are valid for ~10 days; the org may also have changed).',
          lines: failLines
        }
      });
      this.failureToast(`Quick Deploy failed against ${orgLabel}.`, failLines);
    }
  }

  private async runRetrieve(keys: string[], opts: { sourceDir?: string } = {}): Promise<void> {
    // Reserve the busy slot synchronously before the confirm modal (TOCTOU guard).
    if (!this.reserveBusy('Retrieve')) return;
    let reserved = true;
    const releaseBusy = (): void => { if (reserved) { reserved = false; this.setBusy(false); } };
    try {
      const root = this.requireRoot();
      if (!root) return;
      const org = this.requireOrg();
      if (!org) return;
      const items = this.resolveKeys(keys);
      if (items.length === 0) return;
      const orgLabel = this.orgs.find(o => o.username === org)?.alias ?? org;
      const noun = `${items.length} component${items.length === 1 ? '' : 's'}`;

      const orgOnlyCount = items.filter(i => !i.filePath).length;
      const localCount = items.length - orgOnlyCount;
      const detail = orgOnlyCount > 0 && localCount > 0
        ? `${localCount} local file${localCount !== 1 ? 's' : ''} will be overwritten · ${orgOnlyCount} new file${orgOnlyCount !== 1 ? 's' : ''} will be created`
        : orgOnlyCount > 0
          ? `${orgOnlyCount} new file${orgOnlyCount !== 1 ? 's' : ''} will be created locally`
          : 'This will overwrite your local files.';
      const confirm = await vscode.window.showWarningMessage(
        `Retrieve ${noun} from ${orgLabel}?`,
        { modal: true, detail },
        'Retrieve'
      );
      if (confirm !== 'Retrieve') return;

      // Pre-retrieve backup: save the local copies about to be overwritten so the
      // retrieve is undoable. Only local files matter — org-only/new items have none.
      // A FAILED backup ABORTS the retrieve (see backupBeforeRetrieve): shipping the
      // overwrite without the safety net the user was promised is worse than not
      // having the feature. Runs inside the already-reserved slot.
      let backupNote: string | undefined;
      let backupDir: string | undefined;
      try {
        const backupResult = await this.maybeBackupBeforeRetrieve(root, items.flatMap(i => [i.filePath, ...i.files]), orgLabel);
        backupNote = backupResult?.note;
        backupDir = backupResult?.dir;
      } catch (err) {
        this.reportError(`Backup before retrieve from ${orgLabel}`, err);
        return; // releaseBusy() in the outer finally frees the slot
      }

      const cmdId = this.beginCmd(`sf project retrieve start ${this.targetArg(opts.sourceDir, items)} --target-org ${org}`);
      reserved = false;
      const start = Date.now();
      try {
        await this.withWindowProgress(`Retrieving ${noun} from ${orgLabel}`, async () => {
        this.postProgress(`Retrieving ${noun} from ${orgLabel}…`);
        const handle = this.sf.retrieveMetadata(items.map(i => `${i.type}:${i.name}`), org, root, { timeoutMs: this.timeoutMs(), sourceDirs: opts.sourceDir ? [opts.sourceDir] : undefined });
        this.currentCancel = handle.cancel;
        const { result, cmd } = await handle.promise;
        this.updateCmd(cmdId, cmd);
        const files = (result.inboundFiles ?? result.files ?? []) as RetrieveFileResult[];
        const ok = files.filter(f => !retrieveProblem(f) && (f.state === undefined || f.state !== 'Failed'));
        const failed = files.filter(f => retrieveProblem(f) || f.state === 'Failed');
        const missing = items.filter(i => !files.some(f => f.fullName === i.name && f.type === i.type));
        // Org-level messages (e.g. "entity of type X named Y cannot be found")
        // explain an empty result better than the bare missing list — surface them.
        const msgLines = (result.messages ?? []).filter(m => m.problem).map(m => `${m.fileName ?? '?'}: ${m.problem}`);
        this.endCmd(cmdId, failed.length === 0 && ok.length > 0, Date.now() - start);
        // Every ok row came FROM the org — proof of membership even when the last
        // Fetch Org predates the component. The local side ('On org' → 'In both')
        // is covered by the loadFiles() rescan below.
        this.confirmOnOrg(ok, org, orgLabel);

        if (failed.length === 0 && ok.length > 0 && missing.length === 0) {
          this.post({
            type: 'status',
            card: {
              kind: 'ok',
              title: `Retrieved ${ok.length} component${ok.length === 1 ? '' : 's'} from ${orgLabel}`,
              ...(backupNote ? { meta: backupNote } : {}),
              lines: ok.map(f => `${f.type}:${f.fullName}`),
              ...this.backupCardButtons(backupDir)
            }
          });
          this.notifySuccessIfPanelHidden(`Retrieved ${ok.length} component${ok.length === 1 ? '' : 's'} from ${orgLabel}`);
        } else if (ok.length === 0 && failed.length === 0 && missing.length > 0) {
          this.post({
            type: 'status',
            card: {
              kind: 'warn',
              title: `Nothing retrieved from ${orgLabel}`,
              meta: `${missing.length} component${missing.length === 1 ? '' : 's'} not found on the org`,
              lines: [...missing.map(i => `${i.type}:${i.name} — not on org`), ...msgLines]
            }
          });
          this.notifyIfPanelHidden(`Nothing retrieved from ${orgLabel} — ${missing.length} component${missing.length === 1 ? '' : 's'} not found on the org`, 'warn');
        } else {
          const lines: string[] = [];
          for (const f of ok) lines.push(`✓ ${f.type}:${f.fullName}`);
          for (const f of failed) lines.push(`✗ ${f.type}:${f.fullName} — ${retrieveProblem(f) ?? 'failed'}`);
          for (const m of missing) lines.push(`— ${m.type}:${m.name} — not on org`);
          lines.push(...msgLines);
          this.post({
            type: 'status',
            card: {
              kind: failed.length > 0 ? 'err' : 'warn',
              title: `Retrieve from ${orgLabel} completed with issues`,
              meta: `${ok.length} ok · ${failed.length} failed · ${missing.length} missing${backupNote ? ` · ${backupNote}` : ''}`,
              lines,
              ...this.backupCardButtons(backupDir)
            }
          });
          if (failed.length > 0) this.failureToast(`Retrieve from ${orgLabel}: ${failed.length} component${failed.length === 1 ? '' : 's'} failed.`, lines);
          // Nothing FAILED, but components the user asked for weren't on the org —
          // a warn card only, so with the panel hidden the skipped ones went unsaid.
          else if (missing.length > 0) this.notifyIfPanelHidden(`Retrieve from ${orgLabel}: ${ok.length} retrieved · ${missing.length} not on org`, 'warn');
        }
        // refresh workspace scan (file count badges etc.)
        this.loadFiles().catch(() => undefined);
        });
      } catch (err) {
        this.endCmd(cmdId, false, Date.now() - start);
        // Org-labelled so the exception card is attributable in the mixed-org history.
        if (err instanceof SfCliCancelledError) this.reportCancelled(`Retrieve from ${orgLabel}`);
        else this.reportError(`Retrieve from ${orgLabel}`, err);
      } finally {
        this.currentCancel = undefined;
        this.setBusy(false);
      }
    } finally {
      releaseBusy();
    }
  }

  /**
   * Deploy a whole package.xml manifest (`sf project deploy start --manifest`).
   * Mirrors runDeploy's discipline — synchronous reserveBusy, requireRoot/Org, prod
   * guard + ⚠ confirm, the effective test-level chain (incl. RunSpecifiedTests),
   * withWindowProgress, org-labelled status cards/history, cancel support, and the
   * timeout-honesty path — keyed on a manifest file instead of a component
   * selection. The parsed types drive the confirm noun and the status card's target
   * list; the deploy result drives the counts, test failures and quick-deploy offer.
   */
  private async runManifestDeploy(manifestPath: string, types: Array<{ type: string; members: string[] }>): Promise<void> {
    if (!this.reserveBusy('Deploy')) return;
    let reserved = true;
    const releaseBusy = (): void => { if (reserved) { reserved = false; this.setBusy(false); } };
    try {
      const root = this.requireRoot();
      if (!root) return;
      const org = this.requireOrg();
      if (!org) return;

      const orgInfo = this.orgs.find(o => o.username === org);
      const orgLabel = orgInfo?.alias ?? org;
      // Kit classification: an unknown/unloaded org counts as PRODUCTION (over-warn).
      const isProd = isLikelyProduction(orgInfo);
      const basename = path.basename(manifestPath);
      const typeCount = types.length;
      const memberCount = types.reduce((sum, t) => sum + t.members.length, 0);
      // Synthesize items from the manifest so the result card can list what was
      // targeted; the deploy goes by --manifest, so none carry a local filePath and
      // the actual per-component outcome comes from the deploy result.
      const items: MetadataItem[] = types.flatMap(t => t.members.map(m => ({ type: t.type, name: m, filePath: '', files: [] })));
      const noun = `manifest ${basename} — ${typeCount} type${typeCount === 1 ? '' : 's'}, ${memberCount} member${memberCount === 1 ? '' : 's'}`;

      // Same resolver as the selection deploy — a second copy of the chain is a
      // second place for the confirm note to drift from what actually runs. A
      // manifest deploy is always the real thing, so it passes no validateOnly and
      // carries no per-call level: the panel's live pick, then the configured
      // default, then the smart fallback (RunLocalTests on prod).
      const plan = this.resolveTestPlan({}, isProd);
      // resolveTestPlan already warned (RunSpecifiedTests with no valid class
      // name) — early return before the confirm modal, releaseBusy() in the outer
      // finally covers this.
      if (!plan) return;
      const { testLevel, runTests, testNote } = plan;

      // Same rule as runDeploy: read the conflict override BEFORE the confirm (a
      // manifest deploy passes it too) so the modal names the value this run uses.
      const ignoreConflicts = this.ignoreDeployConflicts();
      // Built by the SAME builder as the selection deploy rather than assembled
      // inline here: a second copy of the detail assembly is a second place for
      // the overwrite notice to go missing, and this one is only ever exercised
      // by a manifest deploy. A manifest deploy is always the real thing and
      // never queues, hence validateOnly off and queued false.
      const modal = this.deployConfirmModal(
        { noun, orgLabel, isProd, validateOnly: false, testNote, instanceUrl: orgInfo?.instanceUrl, ignoreConflicts },
        false
      );
      const confirm = await vscode.window.showWarningMessage(modal.message, modal.options, modal.confirmLabel);
      if (!confirm) return;

      const testArg = testLevel !== 'NoTestRun'
        ? ` --test-level ${testLevel}${testLevel === 'RunSpecifiedTests' ? runTests.map(t => ` --tests ${t}`).join('') : ''}`
        : '';
      const cmdId = this.beginCmd(`sf project deploy start --manifest ${/\s/.test(manifestPath) ? `"${manifestPath}"` : manifestPath} --target-org ${org}${ignoreConflicts ? ' --ignore-conflicts' : ''}${testArg}`);
      reserved = false;
      const start = Date.now();
      const progressTitle = `Deploying ${noun} to ${orgLabel}`;
      let keepPersisted = false;
      try {
        await this.withWindowProgress(progressTitle, async report => {
          this.postProgress(`${progressTitle}…`);
          // Submit ASYNC (see runDeploy) — the manifest deploy returns a job id we poll.
          const handle = this.sf.deployMetadata([], org, root, {
            manifest: manifestPath,
            ignoreConflicts,
            timeoutMs: this.timeoutMs(),
            testLevel: testLevel === 'NoTestRun' ? undefined : testLevel,
            runTests: testLevel === 'RunSpecifiedTests' ? runTests : undefined,
            background: true
          });
          this.currentCancel = handle.cancel;
          this.currentDeployOrg = org;
          const { result: submit, cmd } = await handle.promise;
          this.updateCmd(cmdId, cmd);
          const jobId = submit.id;
          if (!jobId) throw new SfCliError('Deploy submitted but the CLI returned no job id to track.');
          this.currentDeployJobId = jobId;
          this.persistActiveJob({ jobId, org, orgLabel, startedAt: Date.now(), verb: 'Deploy', noun });
          const outcome = await this.drivePolledDeploy(
            { jobId, org, orgLabel, root, verb: 'Deploy', noun, cmdId, start, progressTitle }, report,
            result => this.reportPolledDeploy(result, {
              items, orgOnlySkipped: [], orgLabel, org, noun, cmdId, start, validateOnly: false, verb: 'Deploy',
              retry: { manifest: manifestPath, testLevel }
            })
          );
          keepPersisted = outcome.keepPersisted;
        });
      } catch (err) {
        this.endCmd(cmdId, false, Date.now() - start);
        const labeledAction = `Deploy to ${orgLabel}`;
        if (err instanceof SfCliCancelledError) {
          this.reportCancelled(labeledAction, 'The org-side deploy may still complete — check the org.');
        } else if (isTimeoutError(err)) {
          this.reportDeployTimeout(labeledAction, err);
        } else this.reportError(labeledAction, err);
      } finally {
        if (!keepPersisted) this.clearActiveJob();
        this.currentCancel = undefined;
        this.currentDeployJobId = undefined;
        this.currentDeployOrg = undefined;
        this.setBusy(false);
      }
    } finally {
      releaseBusy();
    }
  }

  /**
   * Retrieve a whole package.xml manifest (`sf project retrieve start --manifest`).
   * Mirrors runRetrieve's discipline and reporting — the confirm warns it overwrites
   * local files, and a successful retrieve rescans the workspace so tree/badges pick
   * up the newly-landed components.
   */
  private async runManifestRetrieve(manifestPath: string, types: Array<{ type: string; members: string[] }>): Promise<void> {
    if (!this.reserveBusy('Retrieve')) return;
    let reserved = true;
    const releaseBusy = (): void => { if (reserved) { reserved = false; this.setBusy(false); } };
    try {
      const root = this.requireRoot();
      if (!root) return;
      const org = this.requireOrg();
      if (!org) return;
      const orgLabel = this.orgs.find(o => o.username === org)?.alias ?? org;
      const basename = path.basename(manifestPath);
      const typeCount = types.length;
      const memberCount = types.reduce((sum, t) => sum + t.members.length, 0);
      const noun = `manifest ${basename} — ${typeCount} type${typeCount === 1 ? '' : 's'}, ${memberCount} member${memberCount === 1 ? '' : 's'}`;

      const confirm = await vscode.window.showWarningMessage(
        `Retrieve ${noun} — from ${orgLabel}?`,
        { modal: true, detail: 'This will overwrite your local files for the manifest\'s components.' },
        'Retrieve'
      );
      if (confirm !== 'Retrieve') return;

      // Pre-retrieve backup (see runRetrieve). The manifest deploy goes by
      // --manifest, so resolve which LOCAL components it names via the workspace
      // scan and back only those up — org-only/new members have no local file to
      // save. A wildcard member (`*`) means "every local component of this type".
      // A failed backup aborts the retrieve.
      const wildcardTypes = new Set(types.filter(t => t.members.includes('*')).map(t => t.type));
      const exactKeys = new Set(types.flatMap(t => t.members.filter(m => m !== '*').map(m => `${t.type}:${m}`)));
      const backupPaths = this.items
        .filter(i => wildcardTypes.has(i.type) || exactKeys.has(`${i.type}:${i.name}`))
        .flatMap(i => [i.filePath, ...i.files]);
      let backupNote: string | undefined;
      let backupDir: string | undefined;
      try {
        const backupResult = await this.maybeBackupBeforeRetrieve(root, backupPaths, orgLabel);
        backupNote = backupResult?.note;
        backupDir = backupResult?.dir;
      } catch (err) {
        this.reportError(`Backup before retrieve from ${orgLabel}`, err);
        return; // releaseBusy() in the outer finally frees the slot
      }

      const cmdId = this.beginCmd(`sf project retrieve start --manifest ${/\s/.test(manifestPath) ? `"${manifestPath}"` : manifestPath} --target-org ${org}`);
      reserved = false;
      const start = Date.now();
      try {
        await this.withWindowProgress(`Retrieving ${noun} from ${orgLabel}`, async () => {
          this.postProgress(`Retrieving ${noun} from ${orgLabel}…`);
          const handle = this.sf.retrieveMetadata([], org, root, { manifest: manifestPath, timeoutMs: this.timeoutMs() });
          this.currentCancel = handle.cancel;
          const { result, cmd } = await handle.promise;
          this.updateCmd(cmdId, cmd);
          const files = (result.inboundFiles ?? result.files ?? []) as RetrieveFileResult[];
          const ok = files.filter(f => !retrieveProblem(f) && (f.state === undefined || f.state !== 'Failed'));
          const failed = files.filter(f => retrieveProblem(f) || f.state === 'Failed');
          const msgLines = (result.messages ?? []).filter(m => m.problem).map(m => `${m.fileName ?? '?'}: ${m.problem}`);
          this.endCmd(cmdId, failed.length === 0 && ok.length > 0, Date.now() - start);
          // See runRetrieve: ok rows are org-confirmed membership.
          this.confirmOnOrg(ok, org, orgLabel);

          if (failed.length === 0 && ok.length > 0) {
            this.post({
              type: 'status',
              card: {
                kind: 'ok',
                title: `Retrieved ${ok.length} component${ok.length === 1 ? '' : 's'} from ${orgLabel}`,
                meta: `manifest ${basename}${backupNote ? ` · ${backupNote}` : ''}`,
                lines: ok.map(f => `${f.type}:${f.fullName}`),
                ...this.backupCardButtons(backupDir)
              }
            });
            this.notifySuccessIfPanelHidden(`Retrieved ${ok.length} component${ok.length === 1 ? '' : 's'} from ${orgLabel}`);
          } else if (ok.length === 0 && failed.length === 0) {
            this.post({
              type: 'status',
              card: {
                kind: 'warn',
                title: `Nothing retrieved from ${orgLabel}`,
                meta: `manifest ${basename}`,
                lines: msgLines.length ? msgLines : ['The org returned no components for this manifest.']
              }
            });
            this.notifyIfPanelHidden(`Nothing retrieved from ${orgLabel} — ${basename} matched no components on the org`, 'warn');
          } else {
            const lines: string[] = [];
            for (const f of ok) lines.push(`✓ ${f.type}:${f.fullName}`);
            for (const f of failed) lines.push(`✗ ${f.type}:${f.fullName} — ${retrieveProblem(f) ?? 'failed'}`);
            lines.push(...msgLines);
            this.post({
              type: 'status',
              card: {
                kind: failed.length > 0 ? 'err' : 'warn',
                title: `Retrieve from ${orgLabel} completed with issues`,
                meta: `${ok.length} ok · ${failed.length} failed${backupNote ? ` · ${backupNote}` : ''}`,
                lines,
                ...this.backupCardButtons(backupDir)
              }
            });
            if (failed.length > 0) this.failureToast(`Retrieve from ${orgLabel}: ${failed.length} component${failed.length === 1 ? '' : 's'} failed.`, lines);
          }
          // refresh workspace scan (file count badges etc.), like runRetrieve.
          this.loadFiles().catch(() => undefined);
        });
      } catch (err) {
        this.endCmd(cmdId, false, Date.now() - start);
        if (err instanceof SfCliCancelledError) this.reportCancelled(`Retrieve from ${orgLabel}`);
        else this.reportError(`Retrieve from ${orgLabel}`, err);
      } finally {
        this.currentCancel = undefined;
        this.setBusy(false);
      }
    } finally {
      releaseBusy();
    }
  }

  /**
   * Delete component(s) from the org AND remove their local source files
   * (`sf project delete source`). DESTRUCTIVE and not undoable by the plugin, so it
   * runs a preview (`--dry-run`) first and lists exactly what would go before a modal
   * confirm. Org-only rows are valid targets (nothing local is removed for those).
   * Follows runDeploy's busy discipline: reserve the slot synchronously, hold it
   * across the preview + confirm + real run, release in the finally.
   */
  private async runDelete(keys: string[]): Promise<void> {
    // Reserve the busy slot synchronously, before the first await (the preview and
    // the confirm modal): the same busy-flag TOCTOU guard runDeploy documents.
    if (!this.reserveBusy('Delete')) return;
    let reserved = true;
    const releaseBusy = (): void => { if (reserved) { reserved = false; this.setBusy(false); } };
    try {
      const root = this.requireRoot();
      if (!root) return;
      const org = this.requireOrg();
      if (!org) return;
      // No local-source filter: org-only components are valid delete targets (the org
      // side is removed; there's simply no local file to delete for those).
      const items = this.resolveKeys(keys);
      if (items.length === 0) {
        vscode.window.showInformationMessage('No matching component(s) to delete.');
        return;
      }
      const orgInfo = this.orgs.find(o => o.username === org);
      const orgLabel = orgInfo?.alias ?? org;
      // Kit classification: an unknown/unloaded org counts as PRODUCTION (over-warn).
      const isProd = isLikelyProduction(orgInfo);
      const metadata = items.map(i => `${i.type}:${i.name}`);
      const n = items.length;
      const noun = `${n} component${n === 1 ? '' : 's'}`;

      // Stage 1 — preview via `--dry-run` (deletes nothing). It validates against the
      // org too, so an auth/network/unknown-component error surfaces HERE, before the
      // destructive confirm, instead of after the user has already committed.
      let preview: string[];
      const previewCmdId = this.beginCmd(`sf project delete source ${this.metadataArgs(items)} --target-org ${org} --no-prompt --dry-run`);
      const previewStart = Date.now();
      try {
        const dry = await this.withWindowProgress(`Previewing delete of ${noun} from ${orgLabel}`, async () => {
          this.postProgress(`Previewing delete of ${noun} from ${orgLabel}…`);
          const handle = this.sf.deleteSource(metadata, org, root, { dryRun: true, timeoutMs: this.timeoutMs() });
          this.currentCancel = handle.cancel;
          const { result, cmd } = await handle.promise;
          this.updateCmd(previewCmdId, cmd);
          return result;
        });
        this.endCmd(previewCmdId, true, Date.now() - previewStart);
        preview = deletedLines(dry);
        // A dry run that reports nothing structured still gets an honest confirm —
        // fall back to exactly the components we targeted.
        if (preview.length === 0) preview = metadata.slice();
      } catch (err) {
        this.endCmd(previewCmdId, false, Date.now() - previewStart);
        this.currentCancel = undefined;
        const labeled = `Delete from ${orgLabel}`;
        // The dry run is a check-only destructive deploy — a local timeout doesn't
        // leave anything half-deleted, but reuse the deploy-timeout guidance for
        // consistency (points at the org's status + the raise-timeout hint).
        if (err instanceof SfCliCancelledError) this.reportCancelled(labeled);
        else if (isTimeoutError(err)) this.reportDeployTimeout(labeled, err);
        else this.reportError(labeled, err);
        return; // releaseBusy() in the outer finally covers this
      } finally {
        this.currentCancel = undefined;
      }

      // Stage 2 — the destructive confirm. Be brutally honest in EVERY variant: this
      // removes the component(s) from the org AND deletes the local source files.
      const shown = preview.slice(0, 20);
      const moreCount = preview.length - shown.length;
      const previewBlock = `\n\nWill delete:\n${shown.map(l => `• ${l}`).join('\n')}${moreCount > 0 ? `\n• …and ${moreCount} more` : ''}`;
      const hardTruth = `Deletes the component(s) from ${orgLabel} AND removes the local source files. This cannot be undone by the plugin.`;
      const confirm = isProd
        ? await vscode.window.showWarningMessage(
            `⚠ Delete ${noun} from PRODUCTION (${orgLabel})?`,
            { modal: true, detail: `${hardTruth}${orgInfo?.instanceUrl ? `\n${orgInfo.instanceUrl}` : ''}${previewBlock}` },
            'Delete from PROD'
          )
        : await vscode.window.showWarningMessage(
            `Delete ${noun} from ${orgLabel}?`,
            { modal: true, detail: `${hardTruth}${previewBlock}` },
            'Delete'
          );
      if (!confirm) return;

      // Stage 3 — the real delete.
      const cmdId = this.beginCmd(`sf project delete source ${this.metadataArgs(items)} --target-org ${org} --no-prompt`);
      // From here the finally owns releasing the slot; stop the early-return releaser
      // from double-firing.
      reserved = false;
      const start = Date.now();
      try {
        await this.withWindowProgress(`Deleting ${noun} from ${orgLabel}`, async () => {
          this.postProgress(`Deleting ${noun} from ${orgLabel}…`);
          const handle = this.sf.deleteSource(metadata, org, root, { timeoutMs: this.timeoutMs() });
          this.currentCancel = handle.cancel;
          const { result, cmd } = await handle.promise;
          this.updateCmd(cmdId, cmd);
          const failures = result.details?.componentFailures
            ?? (result.files ?? []).filter(f => f.state === 'Failed' || !!fileProblem(f));
          const success = result.success
            && (result.numberComponentErrors == null || result.numberComponentErrors === 0)
            && failures.length === 0;
          this.endCmd(cmdId, success, Date.now() - start);
          if (success) {
            const removed = deletedLines(result);
            this.post({
              type: 'status',
              card: {
                kind: 'ok',
                title: `Deleted ${noun} from ${orgLabel}`,
                meta: 'Removed from the org and deleted locally',
                lines: removed.length ? removed : metadata
              }
            });
            this.notifySuccessIfPanelHidden(`Deleted ${noun} from ${orgLabel}`);
            // The components are gone — prune them from the selection/tree/badges.
            await this.afterDelete(metadata, org, orgLabel);
          } else {
            const failLines = failures.map(f => {
              const key = this.localFailureKey(f, items);
              return {
                text: `${fileType(f)}:${f.fullName} — ${fileProblem(f) ?? 'failed'}`,
                ...(key ? { key } : {})
              };
            });
            this.post({
              type: 'status',
              card: {
                kind: 'err',
                title: `Delete failed against ${orgLabel}`,
                meta: `${failures.length} component failure${failures.length === 1 ? '' : 's'}`,
                lines: failLines.length ? failLines : ['Delete reported failure with no per-component details.']
              }
            });
            this.failureToast(`Delete failed against ${orgLabel}.`, failLines);
          }
        });
      } catch (err) {
        this.endCmd(cmdId, false, Date.now() - start);
        const labeled = `Delete from ${orgLabel}`;
        if (err instanceof SfCliCancelledError) {
          // Like a deploy, no job id is captured mid-flight, so a cancel here never
          // requested an org-side cancel — the destructive deploy may still complete.
          this.reportCancelled(labeled, 'The org-side delete may still complete — check the org.');
        } else if (isTimeoutError(err)) {
          // A delete IS a destructive deploy on the org — killing the local process
          // does NOT stop it. Reuse the deploy-timeout guidance verbatim.
          this.reportDeployTimeout(labeled, err);
        } else this.reportError(labeled, err);
      } finally {
        this.currentCancel = undefined;
        this.setBusy(false);
      }
    } finally {
      releaseBusy();
    }
  }

  /** After a successful delete: drop the removed keys from the selection, the local
   *  tree, and cached org membership so nothing keeps describing components that no
   *  longer exist. Order matters — update org membership FIRST (so the webview's
   *  'files' pruning sees the deleted keys in neither local nor org and drops them
   *  from the selection), then rescan local files and refresh the Changed view. */
  private async afterDelete(deletedKeys: string[], org: string, orgLabel: string): Promise<void> {
    // Drop the deleted keys from cached org membership, but only when the map belongs
    // to the org we just deleted from (a stale map for another org must be left alone).
    if (this.orgMembersOrg === org) {
      for (const k of deletedKeys) this.orgMembers.delete(k);
      // Re-post so org-only rows / "on org" badges for the now-gone components vanish.
      this.postOrgMembership(orgLabel);
    }
    // Rescan: the deleted source files are gone, so the tree drops them and — via the
    // webview's 'files' pruning against local+org keys — so does the selection. This
    // also refreshes the Changed view; postChangedComponents again is belt-and-braces
    // (a delete removes files, i.e. changes the working tree). Neither throws.
    await this.loadFiles();
    await this.postChangedComponents();
  }

  /** Re-post the cached org membership to the webview (badges, org-only rows). */
  private postOrgMembership(orgLabel: string): void {
    const orgItems = [...this.orgMembers.keys()].map(k => {
      const colon = k.indexOf(':');
      return { type: k.slice(0, colon), name: k.slice(colon + 1) };
    });
    this.post({ type: 'orgMetadata', orgItems, orgLabel });
  }

  /** After a successful deploy or retrieve: the org itself just confirmed these
   *  components exist on it, so fold them into cached membership and re-post —
   *  flipping "Local only" badges to "In both" without waiting for the next Fetch
   *  Org. Keys come ONLY from the org's per-component result rows, never from the
   *  request (a manifest deploy's `ApexClass:*` must not mint a membership key).
   *  Same guards as afterDelete: leave a membership belonging to another org
   *  alone, and if no fetch ever populated it there are no badges to fix —
   *  posting would falsely mark everything else "Local only".
   *
   *  DEPLOY rows must go through confirmDeployedOnOrg instead: MDAPI detail rows
   *  report bundles per FILE (`myCmp/myCmp.js`), not per component — minting those
   *  verbatim would create phantom org-only tree rows AND never flip the real
   *  bundle badge (same shape problem localFailureKey exists for). Retrieve rows
   *  are component-keyed (runRetrieve's `missing` check depends on exactly that),
   *  so they are folded raw — after validation. */
  private confirmOnOrg(
    rows: Array<Pick<DeployFileResult, 'fullName' | 'type' | 'componentType'>>,
    org: string,
    orgLabel: string
  ): void {
    if (this.orgMembersOrg !== org) return;
    this.addOrgMemberKeys(rows.map(r => {
      const type = fileType(r);
      // Both halves come from `sf --json`, and membership keys later become
      // `--metadata <type>:<name>` argv tokens (resolveKeys) — apply the same
      // defense-in-depth the scanner/learned-rule paths apply to type tokens:
      // reject anything not shaped like a metadata type (flags, whitespace,
      // colons — a colon-carrying type would also silently relabel the key,
      // since every splitter cuts on the FIRST colon). Names keep their full
      // legal charset (folders like `unfiled$public/Report`, dots, spaces) but
      // never a wildcard, and the package.xml pseudo-row is junk, not metadata.
      if (!/^[A-Za-z0-9_]+$/.test(type)) return undefined;
      if (!r.fullName || r.fullName === 'package.xml' || r.fullName.includes('*')) return undefined;
      return `${type}:${r.fullName}`;
    }), orgLabel);
  }

  /** Deploy-flavoured confirmOnOrg: resolve each success row back to a scanned
   *  local item first (exact key, else filePath — bundle sub-file rows land on
   *  their bundle), and fold the ITEM's canonical key. A row no local item
   *  accounts for is dropped — a deploy can only have deployed local source, so
   *  an unmappable row is shape drift, not new membership. Item keys come from
   *  the scanner, so they need no further vetting. */
  private confirmDeployedOnOrg(
    rows: Array<Pick<DeployFileResult, 'fullName' | 'type' | 'componentType' | 'filePath'>>,
    deployedItems: MetadataItem[],
    org: string,
    orgLabel: string
  ): void {
    if (this.orgMembersOrg !== org) return; // skip the per-row item scans when membership can't change
    this.addOrgMemberKeys(rows.map(r => this.localFailureKey(r, deployedItems)), orgLabel);
  }

  /** Shared sink for both confirm paths: fold vetted keys into the map, re-post
   *  only when something actually changed — the common case (components already
   *  on the org) must not re-render the webview tree. */
  private addOrgMemberKeys(keys: Array<string | undefined>, orgLabel: string): void {
    let added = false;
    for (const key of keys) {
      if (!key || this.orgMembers.has(key)) continue;
      this.orgMembers.set(key, true);
      added = true;
    }
    if (added) this.postOrgMembership(orgLabel);
  }

  /**
   * Authenticate a new org from the panel (`sf org login web`). Takes the busy slot
   * ('Org Login') so a deploy/retrieve/fetch can't race the auth. On success: refresh
   * the org list and select the new org as the target. The finally ALWAYS releases the
   * slot, so a user who just closes the browser tab (login never completes → we time
   * out or they Cancel) can never leave the panel stuck busy.
   */
  private async runLogin(): Promise<void> {
    // No await between reserveBusy and the try (the cwd read is synchronous), so the
    // reservation is race-free — same shape as loadOrgMetadata.
    if (!this.reserveBusy('Org Login')) return;
    // `sf org login web` authenticates globally (not project-scoped), so it doesn't
    // need an SFDX project — fall back to process.cwd() so a user can add their FIRST
    // org before any workspace metadata exists.
    const cwd = this.workspaceRoot ?? process.cwd();
    const cmdId = this.beginCmd('sf org login web');
    const start = Date.now();
    try {
      const result = await this.withWindowProgress('Waiting for browser login…', async () => {
        this.postProgress('Waiting for browser login…');
        // No timeoutMs override on purpose — loginWeb defaults to 300s, since the
        // browser round-trip is user-paced and the global commandTimeoutMs would
        // kill a legitimate login mid-flow.
        const handle = this.sf.loginWeb(cwd, {});
        this.currentCancel = handle.cancel;
        const { result, cmd } = await handle.promise;
        this.updateCmd(cmdId, cmd);
        return result;
      });
      this.endCmd(cmdId, true, Date.now() - start);
      const username = result?.username;
      // Always refresh the list — the org was added regardless of whether we got a
      // username back to select.
      await this.loadOrgs(true);
      if (!username) {
        this.post({
          type: 'status',
          card: { kind: 'warn', title: 'Login completed but returned no username', meta: 'Refreshed the org list — pick the new org from the dropdown.' }
        });
        // Panel-triggered, but the browser round-trip is long enough for the user to
        // collapse the sidebar meanwhile — and the success sibling below already
        // notifies, so leaving this one silent is the asymmetry that reads as a hang.
        this.notifyIfPanelHidden('Login completed but returned no username — pick the new org from the dropdown', 'warn');
        return;
      }
      await this.applyOrgSelection(username);
      this.post({
        type: 'status',
        card: { kind: 'ok', title: `Authenticated ${username}`, meta: 'Selected as the target org.' }
      });
      this.notifySuccessIfPanelHidden(`Authenticated ${username}`);
    } catch (err) {
      this.endCmd(cmdId, false, Date.now() - start);
      if (err instanceof SfCliCancelledError) this.reportCancelled('Org Login', 'The browser sign-in was cancelled — no org was added.');
      else this.reportError('Org Login', err);
    } finally {
      this.currentCancel = undefined;
      this.setBusy(false);
    }
  }

  /** Open a component's page in the org via `sf org open --source-file` — the CLI
   *  owns the type→Setup-page mapping; unmapped types open the org home. Quick and
   *  read-only, so it deliberately does NOT take the busy slot. */
  private async openComponentInOrg(key: string | undefined): Promise<void> {
    if (!key) return;
    const root = this.requireRoot();
    if (!root) return;
    const org = this.requireOrg();
    if (!org) return;
    const item = this.resolveKeys([key])[0];
    if (!item?.filePath) {
      vscode.window.showInformationMessage('Org-only — retrieve it first (the deep link is derived from the local file).');
      return;
    }
    const cmdId = this.beginCmd(`sf org open --source-file ${/\s/.test(item.filePath) ? `"${item.filePath}"` : item.filePath} --target-org ${org}`);
    const start = Date.now();
    try {
      // Honor the user's configured timeout instead of sfCliService's hardcoded 30s
      // default — a slow network / large org page can exceed it.
      await this.sf.openInOrg(item.filePath, org, root, { timeoutMs: this.timeoutMs() });
      this.endCmd(cmdId, true, Date.now() - start);
    } catch (err) {
      this.endCmd(cmdId, false, Date.now() - start);
      this.reportError('Open in Org', err);
    }
  }

  /** `focusFile` — the exact file a context-menu diff was invoked on. Only used for
   *  folder-typed components (DIRECTORY_ITEM_TYPES): the bundle/object folder itself
   *  can't go to `vscode.diff`, but the clicked file inside it can. */
  private async runDiff(keys: string[], orgOverride?: string, focusFile?: string): Promise<void> {
    // Reserve the busy slot synchronously before the >5-diff confirm modal and the
    // mkdtemp await (TOCTOU guard). Released via `releaseBusy()` on early return.
    if (!this.reserveBusy('Diff')) return;
    let reserved = true;
    const releaseBusy = (): void => { if (reserved) { reserved = false; this.setBusy(false); } };
    const tmpPaths: string[] = [];
    try {
      const root = this.requireRoot();
      if (!root) return;
      const org = orgOverride ?? this.requireOrg();
      if (!org) return;
      // Friendly label (alias) for titles/messages; falls back to the username.
      const orgLabel = this.orgs.find(o => o.username === org)?.alias ?? org;
      const allItems = this.resolveKeys(keys);
      if (allItems.length === 0) return;

      // Org-only items have no local file — diff is meaningless for them (nothing to compare against).
      const orgOnlySkipped = allItems.filter(i => !i.filePath);
      const withLocalFile = allItems.filter(i => !!i.filePath);

      // A right-click on a file INSIDE a folder-typed component (lwc/aura bundle,
      // object folder) diffs that one file: same retrieve, but the local side is the
      // clicked file instead of the un-diffable folder. `focused` replaces its item
      // by identity so the checks below can spot it without re-deriving the rule.
      // The click only counts as a focus when it landed on a FILE. Right-clicking
      // the bundle folder itself has no single file to compare, and a directory
      // reaching `vscode.diff` is the exact wall DIFF_UNSUPPORTED exists to avoid.
      const clicked = focusFile && await fs.stat(focusFile).then(s => s.isFile(), () => false)
        ? focusFile
        : undefined;
      // `isUnder` also holds when the two paths are EQUAL, which is deliberate for one
      // producer: inferItemForPath records a CustomObject as its `.object-meta.xml`
      // rather than the folder. It is not deliberate for a bundle — that same function
      // mints `LightningComponentBundle:jsconfig.json` for any file sitting directly
      // under `lwc/`, and lifting the gate for one would spend a real org retrieve on a
      // component that cannot exist.
      const focusOwner = clicked
        ? withLocalFile.find(i => DIRECTORY_ITEM_TYPES.has(i.type) && isUnder(i.filePath, clicked)
            && (i.type === 'CustomObject' || foldPathKey(i.filePath) !== foldPathKey(clicked)))
        : undefined;
      // Folder-relative path of the clicked file (`myCmp.js`, `templates/inner.html`) —
      // how it's found in the retrieve tree. EMPTY when the item already points AT that
      // file (the CustomObject case above).
      const focusRel = focusOwner && clicked ? path.relative(focusOwner.filePath, clicked) : undefined;
      // …prefixed with the folder's own name, so the suffix search can't land on a
      // same-named file in a different bundle if one ever shares the retrieve tree.
      const focusSuffix = focusOwner && clicked
        ? (focusRel ? path.join(path.basename(focusOwner.filePath), focusRel) : path.basename(clicked))
        : undefined;
      // What the user is TOLD was compared. Never empty while a focus is in play: an
      // object diffed through its `.object-meta.xml` compares that file alone, and
      // labelling it `CustomObject:Widget__c` would claim the fields, validation rules
      // and record types were compared too — an empty diff editor then reads as "in
      // sync". Separators normalised so a win32 `path.relative` can't render
      // `myCmp/templates\alternate.html`.
      const focusLabel = focusOwner && clicked
        ? (focusRel || path.basename(clicked)).split(path.sep).join('/')
        : undefined;
      const focused = focusOwner && clicked ? { ...focusOwner, filePath: clicked } : undefined;
      const localItems = focused ? withLocalFile.map(i => (i === focusOwner ? focused : i)) : withLocalFile;

      // Partition into diffable vs unsupported metadata types.
      const diffable = localItems.filter(i => i === focused || !DIFF_UNSUPPORTED.has(i.type));
      const unsupported = localItems.filter(i => i !== focused && DIFF_UNSUPPORTED.has(i.type));
      const preLines: string[] = [
        // "not supported for this metadata type yet" became a lie the moment the focus
        // rule shipped: three of the four DIFF_UNSUPPORTED members ARE diffable, one
        // file at a time. The panel has no clicked file to work from, so the honest
        // line says what the user can do instead of what the tool can't.
        ...unsupported.map(i => DIRECTORY_ITEM_TYPES.has(i.type)
          ? `— ${i.type}:${i.name} — no whole-component diff; right-click a file inside it → "Compare with Org…"`
          : `— ${i.type}:${i.name} — diff not supported for this metadata type yet`),
        ...orgOnlySkipped.map(i => `— ${i.type}:${i.name} — org-only, no local file to diff (retrieve first)`)
      ];

      if (diffable.length === 0) {
        this.post({
          type: 'status',
          card: {
            kind: 'warn',
            title: 'Nothing to diff',
            meta: `${unsupported.length} unsupported metadata type${unsupported.length === 1 ? '' : 's'} selected`,
            lines: preLines
          }
        });
        // Highly reachable from the context menu: its when-clause matches lwc/aura
        // paths and both bundle types are DIFF_UNSUPPORTED, so this card was the
        // ONLY feedback for right-clicking an LWC — invisible with the panel closed.
        this.notifyIfPanelHidden(nothingDiffableNotice(unsupported.map(i => i.type), orgOnlySkipped.length), 'warn');
        return;
      }

      // Cap the number of diff editors we open in one go.
      let items = diffable;
      if (diffable.length > 5) {
        const choice = await vscode.window.showWarningMessage(
          `About to open ${diffable.length} diff editors.`,
          { modal: true, detail: 'Opening many diff editors can slow the window down.' },
          'Open All',
          'First 5'
        );
        if (!choice) return;
        if (choice === 'First 5') items = diffable.slice(0, 5);
      }

      // Always isolate temp dir outside the workspace so git doesn't see it.
      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-deploy-diff-'));
      tmpPaths.push(tmpRoot);
      reserved = false;
      try {
      await this.withWindowProgress(`Comparing ${items.length} component${items.length === 1 ? '' : 's'} with ${orgLabel}`, async report => {
        const missing: MetadataItem[] = [];
        const opened: string[] = [];
        const errors: string[] = [];

        // Float strategy: open the FIRST diff as a normal tab, then move JUST that
        // editor to a new window (`moveEditorToNewWindow` moves the active editor
        // only — the user's tabs structurally cannot travel with it, split or not).
        // The floating window then has focus, so the remaining diffs open into it
        // via ViewColumn.Active. If the move fails, diffs simply stay as tabs.
        const floatDiff = vscode.workspace
          .getConfiguration('sfOrgDeployWrapper')
          .get<boolean>('openDiffInFloatingWindow', true);
        const diffColumn = (): vscode.ViewColumn | undefined =>
          floatDiff ? vscode.ViewColumn.Active : undefined;
        let floated = false;
        const floatFirstDiff = async (): Promise<void> => {
          if (!floatDiff || floated) return;
          floated = true;
          await Promise.resolve(
            vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow')
          ).then(undefined, (e) => this.output.appendLine(`[Diff] float failed — diffs stay as tabs: ${String(e)}`));
        };

        // Fast path: Apex/Visualforce bodies come back from a single Tooling API
        // query in ~1-2s, vs a Metadata API retrieve round-trip. Anything the query
        // can't resolve cleanly falls back to the retrieve below.
        const fastItems = items.filter(i => FAST_DIFF_FIELD[i.type]);
        const slowItems = items.filter(i => !FAST_DIFF_FIELD[i.type]);
        if (fastItems.length > 0) {
          report('querying org (Tooling API)…');
          this.postProgress(`Fetching ${fastItems.length} component${fastItems.length === 1 ? '' : 's'} from ${orgLabel} via Tooling API…`);
          const byType = new Map<string, MetadataItem[]>();
          for (const i of fastItems) {
            const arr = byType.get(i.type);
            if (arr) arr.push(i); else byType.set(i.type, [i]);
          }
          // A Cancel landing BETWEEN two per-type queries used to be lost: currentCancel
          // then points at the just-settled query handle, so calling it is a no-op and
          // the loop rolls on to the next type. Mirror loadOrgMetadata's fetchCancelled —
          // the wrapper flips a flag AND kills whatever query is in flight; the loop
          // checks the flag before each query and bails out honestly.
          let diffCancelled = false;
          const activeQueryCancels = new Set<() => void>();
          this.currentCancel = () => {
            diffCancelled = true;
            for (const c of activeQueryCancels) c();
          };
          for (const [type, arr] of byType) {
            if (diffCancelled) throw new SfCliCancelledError();
            const field = FAST_DIFF_FIELD[type];
            const inList = arr.map(i => `'${i.name.replace(/'/g, "\\'")}'`).join(', ');
            const soql = `SELECT Name, NamespacePrefix, ${field} FROM ${type} WHERE Name IN (${inList})`;
            const qStart = Date.now();
            const qCmdId = this.beginCmd(`sf data query --use-tooling-api --target-org ${org} --query "${soql}"`);
            const q = this.sf.queryTooling<ToolingCodeRecord>(soql, org, root, { timeoutMs: this.timeoutMs() });
            activeQueryCancels.add(q.cancel);
            try {
              const { records } = await q.promise;
              this.endCmd(qCmdId, true, Date.now() - qStart);
              for (const item of arr) {
                const recs = records.filter(r => r.Name === item.name);
                // Prefer the unmanaged record; accept a single namespaced one
                // (namespaced dev org). Hidden bodies (managed packages) and
                // ambiguous names fall back to the Metadata API retrieve.
                const rec = recs.find(r => !r.NamespacePrefix) ?? (recs.length === 1 ? recs[0] : undefined);
                const body = rec?.[field];
                if (recs.length === 0) { missing.push(item); continue; }
                if (typeof body !== 'string' || body === '(hidden)') { slowItems.push(item); continue; }
                const staged = await stageDiffText(body, item);
                tmpPaths.push(staged.dir);
                await this.openDiff(item, staged.file, orgLabel, diffColumn());
                opened.push(`${item.type}:${item.name}`);
                await floatFirstDiff();
              }
            } catch (e) {
              this.endCmd(qCmdId, false, Date.now() - qStart);
              if (e instanceof SfCliCancelledError) throw e;
              this.output.appendLine(`[Diff] Tooling query for ${type} failed — falling back to retrieve: ${e instanceof Error ? e.message : String(e)}`);
              slowItems.push(...arr);
            } finally {
              activeQueryCancels.delete(q.cancel);
            }
          }
        }

        if (slowItems.length > 0) {
          report('retrieving from org…');
          this.postProgress(`Retrieving ${slowItems.length} component${slowItems.length === 1 ? '' : 's'} from ${orgLabel}…`);
          // Retrieve in SOURCE format into an isolated throwaway project — the same
          // mechanism the standard Salesforce extension's "diff against org" uses. A
          // metadata-format retrieve (`--target-metadata-dir`) silently comes back empty
          // for some components — custom-metadata-type Layouts
          // (`Foo__mdt-Some Layout.layout`) are the classic case — which surfaced here as
          // a bogus "not on org". Source format also lands each file at the same relative
          // path as the local copy, so top-level types and decomposed object children
          // (CustomField, ValidationRule, …) both match by name with no separate
          // MDAPI→source convert step.
          const proj = path.join(tmpRoot, 'proj');
          await scaffoldSourceProject(proj);
          const rStart = Date.now();
          const rCmdId = this.beginCmd(`sf project retrieve start ${this.metadataArgs(slowItems)} --target-org ${org}`);
          const handle = this.sf.retrieveMetadata(
            slowItems.map(i => `${i.type}:${i.name}`), org, proj, { timeoutMs: this.timeoutMs() }
          );
          this.currentCancel = handle.cancel;
          let result: RetrieveResult;
          try {
            const r = await handle.promise;
            result = r.result;
            this.updateCmd(rCmdId, r.cmd);
          } catch (e) {
            this.endCmd(rCmdId, false, Date.now() - rStart);
            throw e;
          }

          const sfFailures = (result.messages ?? []).filter(m => m.problem);
          for (const f of sfFailures) {
            errors.push(`${f.fileName ?? '?'}: ${f.problem}`);
          }
          this.endCmd(rCmdId, sfFailures.length === 0, Date.now() - rStart);

          report('opening diff editors…');
          for (const item of slowItems) {
            const isChild = OBJECT_CHILD_TYPES.has(item.type);
            let remoteFile: string | undefined;
            if (item === focused) {
              // Retrieve landed the whole bundle/object folder. Match on the
              // folder-relative path so a sibling (`myCmp.html` for a clicked
              // `myCmp.js`) can never cross-match — the basename search below has a
              // prefix fallback that would happily do exactly that.
              remoteFile = await findFileBySuffix(proj, focusSuffix!);
            } else if (isChild) {
              // Match by the `objects/<Object>/<folder>/<file>` suffix so same-named
              // fields on different objects in one batch don't cross-match.
              const childFolder = path.basename(path.dirname(item.filePath));
              const objectFolder = path.basename(path.dirname(path.dirname(item.filePath)));
              const suffix = path.join('objects', objectFolder, childFolder, path.basename(item.filePath));
              remoteFile = await findFileBySuffix(proj, suffix);
            } else {
              // Source format writes each file with the SAME basename as the local copy
              // (e.g. `SomeType__mdt-Some Layout.layout-meta.xml`). Search the whole
              // retrieve tree by basename so this never depends on the exact
              // `<pkgDir>/main/default` nesting the CLI happens to use.
              const localBasename = path.basename(item.filePath);
              const leaf = item.name.split('/').pop() ?? item.name;
              remoteFile = await findFileMatching(proj, localBasename, leaf, path.basename(path.dirname(item.filePath)));
            }
            if (!remoteFile) {
              // Name the FILE for a focused diff: "LightningComponentBundle:myCmp —
              // not on org" would be a wrong verdict when the bundle is on the org
              // and only this file (a new helper, say) isn't.
              missing.push(item === focused && focusLabel ? { ...item, name: `${item.name}/${focusLabel}` } : item);
              continue;
            }
            const staged = await stageDiffCopy(remoteFile, item);
            tmpPaths.push(staged.dir);
            await this.openDiff(item, staged.file, orgLabel, diffColumn(), item === focused ? focusLabel : undefined);
            opened.push(`${item.type}:${item.name}${item === focused && focusLabel ? `/${focusLabel}` : ''}`);
            await floatFirstDiff();
          }
        }

        const lines: string[] = [];
        for (const k of opened) lines.push(`✓ opened diff: ${k}`);
        for (const m of missing) lines.push(`— ${m.type}:${m.name} — not on org`);
        for (const e of errors) lines.push(`✗ ${e}`);
        for (const w of preLines) lines.push(w);

        const outcome = classifyDiffOutcome({
          opened: opened.length, missing: missing.length, errors: errors.length,
          unsupported: unsupported.length, attempted: items.length
        }, orgLabel);
        this.post({
          type: 'status',
          card: { kind: outcome.kind, title: outcome.title, meta: outcome.meta, lines }
        });
        // The whole verdict lived in that card, so with the panel hidden a diff that
        // opened nothing was a dead click. Opened editors need no toast — they are
        // the feedback — which is why this is classified rather than unconditional.
        if (outcome.notify === 'warn') this.notifyIfPanelHidden(outcome.title, 'warn');
        // In-band retrieve errors get the failure treatment (details mirrored into
        // the output channel), but gated on the panel being hidden: unlike the
        // deploy/retrieve failure paths, this one never toasted, and a visible panel
        // is already showing the same err card and lines.
        else if (outcome.notify === 'err' && !this.view?.visible) {
          this.failureToast(`Diff against ${orgLabel}: ${errors.length} error${errors.length === 1 ? '' : 's'}.`, lines);
        }
      });
      } catch (err) {
        // Org-labelled so the exception card is attributable in the mixed-org history.
        if (err instanceof SfCliCancelledError) this.reportCancelled(`Diff against ${orgLabel}`);
        else this.reportError(`Diff against ${orgLabel}`, err);
      } finally {
        this.currentCancel = undefined;
        this.setBusy(false);
        scheduleTmpCleanup(tmpPaths);
      }
    } finally {
      // Released only if we returned before entering the inner op (the inner
      // finally owns setBusy(false) once we commit). Clean up any staged tmp dirs
      // created on an early-return path too.
      if (reserved) {
        this.setBusy(false);
        scheduleTmpCleanup(tmpPaths);
      }
    }
  }

  // ---- Org metadata browse ----

  /** Clear cached org-membership (provider + webview) so stale badges/rows from a
   *  previously-fetched org never describe a different selected org. */
  private resetOrgMetadata(): void {
    this.orgMembers = new Map();
    this.orgMembersOrg = undefined;
    this.post({ type: 'orgMetadataReset' });
  }

  /** Apply a target-org selection from the webview: persist it, drop org metadata
   *  fetched for a different org, and re-broadcast. No-op when unchanged, so it's safe
   *  to call defensively right before an operation that must hit the selected org. */
  private async applyOrgSelection(username: string | undefined): Promise<void> {
    if (username === this.orgStore.get()) return;
    await this.orgStore.set(username);
    if (this.orgMembersOrg && username !== this.orgMembersOrg) this.resetOrgMetadata();
    this.postOrgs();
  }

  private async loadOrgMetadata(): Promise<void> {
    // No await between this check and setBusy below (requireRoot/Org and config
    // reads are synchronous), so reserving here is race-free. reserveBusy keeps the
    // "already running" messaging consistent with the other ops.
    if (!this.reserveBusy('Fetch Org')) return;
    const root = this.requireRoot();
    if (!root) { this.setBusy(false); return; }
    const org = this.requireOrg();
    if (!org) { this.setBusy(false); return; }
    const orgLabel = this.orgs.find(o => o.username === org)?.alias ?? org;

    const cfg = vscode.workspace.getConfiguration('sfOrgDeployWrapper');
    const includeManaged = cfg.get<boolean>('fetchIncludeManaged', false);
    const concurrency = Math.max(1, Math.min(12, cfg.get<number>('fetchConcurrency', 5)));
    const timeoutMs = this.timeoutMs();

    const orgItems: Array<{ type: string; name: string }> = [];
    let managedSkipped = 0;
    const failures: Array<{ label: string; err: unknown }> = [];
    let fetchCancelled = false;
    const activeCancels = new Set<() => void>();

    this.currentCancel = () => {
      fetchCancelled = true;
      for (const c of activeCancels) c();
    };

    // Run one listMetadata call, folding its members into orgItems (honouring the
    // managed-package filter) or recording a failure. Never throws (except cancel).
    const runOne = async (type: string, label: string, folder?: string): Promise<void> => {
      if (fetchCancelled) return;
      const h = this.sf.listMetadata(type, org, root, { timeoutMs, folder });
      activeCancels.add(h.cancel);
      try {
        const { members } = await h.promise;
        for (const m of members) {
          if (!m.fullName) continue;
          if (!includeManaged && m.manageableState === 'installed') { managedSkipped++; continue; }
          orgItems.push({ type, name: m.fullName });
        }
      } catch (err) {
        if (fetchCancelled || err instanceof SfCliCancelledError) throw err;
        failures.push({ label, err });
        this.output.appendLine(`[Fetch Org] ${label}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        activeCancels.delete(h.cancel);
      }
    };

    try {
      await this.withWindowProgress(`Fetching metadata from ${orgLabel}`, async report => {
        // Folder-based types (EmailTemplate) return nothing without --folder: first
        // enumerate the folders, then fetch each folder's members. fullNames come back
        // as `Folder/Name`, matching the local scanner's key for the same component.
        // Curated list UNION whatever types the workspace scan actually produced —
        // a type resolved via the CLI registry (new platform types, OmniStudio
        // extras, …) gets badged without waiting for a plugin release. Types this
        // org doesn't support fail per-type and are reported, never fatal.
        const fetchTypes = new Set<string>(FETCH_ORG_TYPES);
        for (const i of this.items) fetchTypes.add(i.type);
        const tasks: Array<{ type: string; label: string; folder?: string }> = [];
        for (const type of fetchTypes) {
          if (!(type in FOLDERED_TYPES)) tasks.push({ type, label: type });
        }
        for (const [type, folderType] of Object.entries(FOLDERED_TYPES)) {
          if (!fetchTypes.has(type)) continue;
          try {
            const fh = this.sf.listMetadata(folderType, org, root, { timeoutMs });
            activeCancels.add(fh.cancel);
            const { members } = await fh.promise;
            activeCancels.delete(fh.cancel);
            for (const f of members) {
              if (f.fullName) tasks.push({ type, label: `${type} (${f.fullName})`, folder: f.fullName });
            }
          } catch (err) {
            if (fetchCancelled || err instanceof SfCliCancelledError) throw err;
            failures.push({ label: folderType, err });
            this.output.appendLine(`[Fetch Org] ${folderType}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Bounded concurrency pool: at most `concurrency` sf processes in flight at
        // once, instead of spawning one per type/folder all at once.
        const total = tasks.length;
        let done = 0;
        let next = 0;
        const worker = async (): Promise<void> => {
          while (!fetchCancelled) {
            const i = next++;
            if (i >= tasks.length) return;
            const t = tasks[i];
            await runOne(t.type, t.label, t.folder);
            done++;
            report(`${done}/${total}…`);
            this.postProgress(`Fetching org metadata: ${done}/${total}…`);
          }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
        if (fetchCancelled) throw new SfCliCancelledError();
      });

      // If the user switched the target org while this fetch was in flight, the
      // result describes the wrong org — discard it rather than badge org B's tree
      // with org A's membership. (The org select is also disabled while busy; this
      // is the backstop for programmatic org changes.)
      if (org !== this.orgStore.get()) {
        this.output.appendLine(`[Fetch Org] target org changed during fetch (${org} → ${this.orgStore.get() ?? 'none'}); discarding stale result.`);
        this.post({
          type: 'status',
          card: { kind: 'warn', title: 'Fetch Org cancelled', meta: 'Target org changed during the fetch — run Fetch Org again for the current org.' }
        });
        return;
      }

      const fatal = failures.filter(f => isFatalFetchError(f.err));
      // Zero results AND at least one failure → we can't claim the org is empty.
      // Surface a real error instead of a misleading "0 components" success. Prefer an
      // auth/network-class error for the message/hint since that explains a total wipe-out.
      if (orgItems.length === 0 && failures.length > 0) {
        const first = (fatal[0] ?? failures[0]).err;
        this.post({
          type: 'status',
          card: {
            kind: 'err',
            title: `Fetch Org failed against ${orgLabel}`,
            meta: 'Could not list metadata — see command log / output channel',
            errText: stripAnsi(first instanceof Error ? first.message : String(first)),
            actions: first instanceof SfCliError ? first.actions : undefined,
            hint: hintForError(first) ?? 'Check the org authentication and your connection, then retry.'
          }
        });
        // Toast too — with auto-fetch on open (fetchOrgOnOpen) the card can land in a
        // hidden webview, and this total wipe-out is how a user learns their auth
        // expired. Mirror the result-failure path's notification + output mirroring.
        this.failureToast(
          `Fetch Org failed against ${orgLabel} — could not list metadata (${failures.length} type${failures.length === 1 ? '' : 's'} failed).`,
          failures.slice(0, 6).map(f => `${f.label} — ${f.err instanceof Error ? f.err.message : String(f.err)}`)
        );
        return;
      }

      this.orgMembers = new Map(orgItems.map(i => [`${i.type}:${i.name}`, true as const]));
      this.orgMembersOrg = org;
      this.post({ type: 'orgMetadata', orgItems, orgLabel });

      // A fatal (auth/network-class) failure that arrived mid-fetch means some types
      // never listed, so the membership map is INCOMPLETE: a component that exists on
      // the org under a failed type would mis-badge as "local only". We still show what
      // we got (better than nothing), but flag the listing as incomplete so the badges
      // aren't trusted as exhaustive.
      const incomplete = fatal.length > 0;
      const metaParts = [`${orgItems.length} components`];
      if (managedSkipped > 0) metaParts.push(`${managedSkipped} managed skipped`);
      if (failures.length > 0) metaParts.push(`${failures.length} type${failures.length === 1 ? '' : 's'} failed`);
      const card: Record<string, unknown> = {
        kind: incomplete ? 'err' : (failures.length > 0 ? 'warn' : 'ok'),
        title: incomplete ? `Org metadata incomplete for ${orgLabel}` : `Org metadata loaded from ${orgLabel}`,
        meta: metaParts.join(' · ')
      };
      if (failures.length > 0) {
        const lines = failures.slice(0, 8).map(f => `✗ ${f.label} — ${f.err instanceof Error ? f.err.message : String(f.err)}`);
        if (failures.length > 8) lines.push(`…and ${failures.length - 8} more (see output channel)`);
        if (incomplete) lines.unshift('⚠ A connection/auth error interrupted the listing — some "local only" badges may be incomplete. Re-run Fetch Org.');
        if (managedSkipped > 0) lines.unshift(`— ${managedSkipped} managed-package component${managedSkipped === 1 ? '' : 's'} hidden (enable sfOrgDeployWrapper.fetchIncludeManaged to show)`);
        card.lines = lines;
      }
      this.post({ type: 'status', card });
      // An incomplete listing means some "local only" badges can be wrong — with
      // auto-fetch the card may be hidden, so toast that the org view is partial.
      if (incomplete) {
        this.failureToast(
          `Org metadata for ${orgLabel} is incomplete — a connection/auth error interrupted the listing; some "local only" badges may be wrong. Re-run Fetch Org.`,
          failures.slice(0, 6).map(f => `${f.label} — ${f.err instanceof Error ? f.err.message : String(f.err)}`)
        );
      }
    } catch (err) {
      if (err instanceof SfCliCancelledError) this.reportCancelled('Fetch Org');
      else this.reportError('Fetch Org', err);
    } finally {
      this.currentCancel = undefined;
      this.setBusy(false);
    }
  }

  // ---- helpers ----
  private requireRoot(): string | undefined {
    if (this.workspaceRoot) return this.workspaceRoot;
    vscode.window.showWarningMessage('Open a Salesforce DX project workspace first.');
    return undefined;
  }

  private requireOrg(): string | undefined {
    const org = this.orgStore.get();
    if (!org) {
      vscode.window.showWarningMessage('Select a Salesforce org first.');
      return undefined;
    }
    return org;
  }

  private resolveKeys(keys: string[]): MetadataItem[] {
    const set = new Set(keys);
    const result: MetadataItem[] = [];
    const matched = new Set<string>();
    for (const i of this.items) {
      const key = `${i.type}:${i.name}`;
      if (set.has(key)) { result.push(i); matched.add(key); }
    }
    // Include org-only items as virtual MetadataItems (no local file) — valid for
    // retrieve. Only trust the membership map when it was fetched for the org that's
    // currently selected, so a stale map can never synthesize items for a wrong org.
    const membershipValid = !!this.orgMembersOrg && this.orgMembersOrg === this.orgStore.get();
    if (membershipValid) {
      for (const key of set) {
        if (matched.has(key)) continue;
        if (this.orgMembers.has(key)) {
          const colon = key.indexOf(':');
          result.push({ type: key.slice(0, colon), name: key.slice(colon + 1), filePath: '', files: [] });
        }
      }
    }
    return result;
  }

  /** Resolve a CLI deploy-failure row back to a source item that really exists
   *  locally. Exact metadata keys cover the common case; `filePath` covers CLI
   *  result shapes whose reported fullName differs from the scanner's component
   *  key (notably individual files inside bundles). No local match means the
   *  status row stays plain text instead of advertising a dead navigation link. */
  private localFailureKey(
    failure: Pick<DeployFileResult, 'type' | 'componentType' | 'fullName' | 'filePath'>,
    preferredItems: MetadataItem[] = []
  ): string | undefined {
    const candidates = [...preferredItems, ...this.items].filter(i => !!i.filePath);
    const exact = candidates.find(i => i.type === fileType(failure) && i.name === failure.fullName);
    if (exact) return `${exact.type}:${exact.name}`;

    if (!failure.filePath) return undefined;
    const reportedPath = path.isAbsolute(failure.filePath)
      ? failure.filePath
      : (this.workspaceRoot ? path.resolve(this.workspaceRoot, failure.filePath) : undefined);
    if (!reportedPath) return undefined;
    const byPath = findItemForPath(candidates, reportedPath);
    return byPath ? `${byPath.type}:${byPath.name}` : undefined;
  }

  private metadataArgs(items: MetadataItem[]): string {
    return items.map(i => `--metadata ${i.type}:${i.name}`).join(' ');
  }

  /** Echoed-command target: an explicit `--source-dir <path>` when deploying/retrieving
   *  a pointed-at file, else the per-component `--metadata` list. */
  private targetArg(sourceDir: string | undefined, items: MetadataItem[]): string {
    if (!sourceDir) return this.metadataArgs(items);
    return `--source-dir ${/\s/.test(sourceDir) ? `"${sourceDir}"` : sourceDir}`;
  }

  private timeoutMs(): number {
    // Clamp to a 10s floor: VS Code doesn't enforce the schema's minimum at runtime,
    // so a hand-edited settings.json value of 0/500 would time EVERY command out
    // instantly (the deploy never gets off the ground). A too-low value is a
    // footgun; a too-high one is the user's call.
    return Math.max(10_000, vscode.workspace.getConfiguration('sfOrgDeployWrapper').get<number>('commandTimeoutMs', 180_000));
  }

  private setBusy(b: boolean, action?: string): void {
    this.busy = b;
    this.currentAction = b ? action : undefined;
    if (!b) this.currentProgressText = undefined;
    this.post({ type: 'busy', busy: b, action: this.currentAction });
    // Drain the next queued deploy/validate once the slot frees (Feature: deploy
    // queue). A microtask — never synchronous inside the caller's `finally` —
    // so the operation that just finished unwinds its OWN cleanup
    // (currentCancel/currentDeployJobId/currentDeployOrg, etc.) before
    // drainQueue's reserveBusy can reserve the slot again for the next item.
    if (!b) queueMicrotask(() => this.drainQueue());
  }

  /**
   * Atomically claim the busy slot. Returns false (and shows the "already running"
   * message) if an op is in flight. Callers MUST hold the slot across every await
   * up to the finishing `setBusy(false)` — checking `this.busy` and only *later*
   * setting it left a window where a modal-blocked second op slipped through
   * (busy-flag TOCTOU). Setting `busy` here, synchronously before any
   * await, closes that window.
   */
  private reserveBusy(action: string): boolean {
    if (this.busy) {
      this.notifyBusy();
      return false;
    }
    this.setBusy(true, action);
    return true;
  }

  /** The "already running" info-message, shared by reserveBusy and the palette-only
   *  commands (refreshFiles/pickOrg) that must refuse mid-op WITHOUT taking the slot. */
  private notifyBusy(): void {
    vscode.window.showInformationMessage(this.currentAction
      ? `${this.currentAction} is already running — cancel it from the panel or wait for it to finish.`
      : 'Another operation is already running.');
  }

  /** Run `body` under a cancellable VS Code progress notification so operations
   *  give feedback even when the panel is hidden (context-menu flows). The
   *  notification's Cancel button maps onto the currently running sf command. */
  private withWindowProgress<T>(title: string, body: (report: (message: string) => void) => Promise<T>): Promise<T> {
    return Promise.resolve(vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `SF Deploy: ${title}`, cancellable: true },
      (progress, token) => {
        const sub = token.onCancellationRequested(() => this.cancelCurrent());
        return body(message => progress.report({ message })).finally(() => sub.dispose());
      }
    ));
  }

  /** Update the in-panel progress card with the current phase of the running op. */
  private postProgress(text: string): void {
    this.currentProgressText = text;
    this.post({ type: 'progress', text });
  }

  /** Success-kind entry point for notifyIfPanelHidden — the name deploy, quick deploy,
   *  retrieve, manifest retrieve, delete, login and backup restore call, so a success
   *  call site can never be misread as reporting a problem. */
  private notifySuccessIfPanelHidden(message: string): void {
    this.notifyIfPanelHidden(message, 'ok');
  }

  /** Visible verdict when the panel isn't open — e.g. a deploy/retrieve/diff fired
   *  from the Explorer or editor right-click menu, where the result card would
   *  otherwise land in a hidden webview and read as "no feedback". `this.view` is
   *  undefined until the panel is first revealed, so this covers both never-opened
   *  and open-but-hidden.
   *  `kind` picks the presentation, and the two are deliberately different
   *  mechanisms:
   *  - SUCCESS auto-dismisses (see showTimedNotice). The thing the user asked for
   *    happened, so nothing has to be chased; a stack of verdicts to close by hand
   *    is pure cost.
   *  - WARN keeps the persistent toast and its 'Show Panel' button, exactly like a
   *    failure. A warn verdict ("Nothing to diff — not on acme-dev") is the whole
   *    reason this notification exists, and its detail lives on a card in the panel.
   *    VS Code removes a SETTLED progress notification from the Notification Center
   *    entirely, so an auto-dismissing warn the user wasn't watching would leave no
   *    trace and no route back to the card — the reported bug again, one layer down.
   *  A warn is never dressed as success either way: the status-bar line keeps its
   *  $(warning) icon and the notification says so in words, so a "Nothing to diff"
   *  verdict can't read as an accomplishment. */
  private notifyIfPanelHidden(message: string, kind: 'ok' | 'warn' = 'ok'): void {
    if (this.view?.visible) return;
    const warn = kind === 'warn';
    vscode.window.setStatusBarMessage(`${warn ? '$(warning)' : '$(check)'} ${message}`, 8000);
    if (warn) {
      void vscode.window.showWarningMessage(`SF Deploy (warning): ${message}`, 'Show Panel').then(choice => {
        if (choice === 'Show Panel') void vscode.commands.executeCommand('sfOrgDeployWrapper.panel.focus');
      }, () => undefined);
      return;
    }
    this.showTimedNotice(`SF Deploy: ${message}`);
  }

  /** Pending auto-dismiss callbacks for timed notices — invoked early on dispose so
   *  a shutdown doesn't leave notifications spinning on a dead provider. Created on
   *  first use; most sessions never show one. */
  private noticeDismissers?: Set<() => void>;

  /** Show a notification that closes itself after NOTICE_AUTO_DISMISS_MS.
   *  VS Code has no timeout on showInformationMessage/showWarningMessage and no API
   *  to dismiss a notification, and a notification carrying an action button stays
   *  until the user closes it. A progress notification is the one that CAN end on
   *  its own: it is torn down when its promise settles. The trade is that it can't
   *  carry a 'Show Panel' button — hence no `cancellable`, and no buttons at all,
   *  and hence only SUCCESS verdicts come through here (see notifyIfPanelHidden).
   *  Fire-and-forget: the result paths that call this must return immediately, so
   *  nothing here is awaited and the body does no work before its timer fires. */
  private showTimedNotice(title: string): void {
    void Promise.resolve(vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title },
      () => new Promise<void>(resolve => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (): void => {
          if (timer) clearTimeout(timer);
          this.noticeDismissers?.delete(finish);
          resolve();
        };
        timer = setTimeout(finish, NOTICE_AUTO_DISMISS_MS);
        // A notice nobody is waiting on must never be the reason the extension host
        // stays alive. (Absent outside Node, hence the optional call.)
        timer.unref?.();
        (this.noticeDismissers ??= new Set()).add(finish);
      })
    )).catch(() => undefined);
  }

  /** Close every outstanding timed notice — the dispose path for showTimedNotice's
   *  timers. Resolving (rather than only clearing the timer) is what actually takes
   *  the notification off screen; a cleared timer alone would strand it forever. */
  private dismissTimedNotices(): void {
    for (const finish of this.noticeDismissers ? [...this.noticeDismissers] : []) finish();
    this.noticeDismissers?.clear();
  }

  /** `fileLabel` names the single file when the item is a folder-typed component
   *  diffed through one of its files — `Type:Name` alone wouldn't say which. */
  private async openDiff(item: MetadataItem, remoteFile: string, orgLabel: string, viewColumn?: vscode.ViewColumn, fileLabel?: string): Promise<void> {
    // Org copy LEFT (read-only staged temp), local file RIGHT (the editable side) —
    // matches git / the official Salesforce extension, and makes the diff editor's
    // copy-block arrows pull org changes INTO the local file. The reverse order made
    // the arrows "copy" local blocks into a doomed temp file that never reaches the
    // org (deploy is the only upload path).
    const title = `${item.type}:${item.name}${fileLabel ? `/${fileLabel}` : ''} — ${orgLabel} ↔ Local`;
    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(remoteFile), vscode.Uri.file(item.filePath), title, { preview: false, viewColumn });
  }

  private reportCancelled(action: string, note?: string): void {
    this.post({
      type: 'status',
      card: { kind: 'warn', title: `${action} cancelled`, ...(note ? { meta: note } : {}) }
    });
    // A bare cancel needs no notification — the user pressed Cancel and the progress
    // notification vanishing is the acknowledgment. A NOTE is different: it says
    // something the click does NOT imply (the org-side operation may still be
    // running), and with the panel hidden the card carrying it is invisible.
    if (note) this.notifyIfPanelHidden(`${action} cancelled — ${note}`, 'warn');
  }

  private postOrgs(): void {
    const payload: OrgPayload[] = this.orgs.map(o => ({
      username: o.username,
      alias: o.alias,
      label: o.alias ? `${o.alias} (${o.username})` : o.username,
      kind: orgKind(o)
    }));
    this.post({ type: 'orgs', orgs: payload, selected: this.orgStore.get() ?? null });
  }

  private post(msg: unknown): void {
    const m = msg as { type?: string; card?: Record<string, unknown> } | null;
    if (m?.type === 'status' && m.card) {
      // Stamp and persist every result card — the Status pane doubles as the
      // deployment history, surviving webview rebuilds AND window reloads (so a
      // failed context-menu deploy with the sidebar closed leaves a durable trace).
      m.card.at ??= Date.now();
      // The suggestion UI is live-only: a card restored after a reload renders
      // without it (inert), so stale checkboxes can't deploy through an expired
      // liveSuggestions entry. History gets a copy WITHOUT the payload.
      this.pushCardHistory(m.card.suggest ? { ...m.card, suggest: undefined } : m.card);
    }
    this.view?.webview.postMessage(msg);
  }

  /** In-memory mirror of the persisted card history (newest first, capped). */
  private cardHistoryCache?: Array<Record<string, unknown>>;

  /** Persisted history, shape-guarded (a corrupted workspaceState value must
   *  degrade to an empty history, never throw scans down). */
  private cardHistory(): Array<Record<string, unknown>> {
    if (!this.cardHistoryCache) {
      const raw = this.context.workspaceState.get<unknown>(CARD_HISTORY_KEY, []);
      this.cardHistoryCache = Array.isArray(raw)
        ? raw
          .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
          // Cards outlive the features that made them. A history entry written
          // while "Retry + changed vs branch" existed still carries that button,
          // so prune on the way OUT of storage too — pruning only on write would
          // leave every already-persisted card advertising the removed feature
          // until it aged off the 50-card cap.
          .map(c => pruneCardButtons(c))
        : [];
    }
    return this.cardHistoryCache;
  }

  private pushCardHistory(card: Record<string, unknown>): void {
    // Strip the quickDeploy affordance from the persisted copy: its validation
    // anchor (`lastValidated`) is in-memory, so after a reload the button would
    // be dead. The LIVE card posted to the webview keeps it.
    const { quickDeploy: _dropped, ...kept } = card;
    // Then drop any button naming a message the provider no longer offers —
    // before the size rule below, which only ever asks whether a button is too
    // heavy, never whether it still means anything.
    const persistable = pruneCardButtons(kept);
    // Bound the persisted copy: errText can carry full CLI stderr and a card can
    // list hundreds of components — 50 unbounded cards would bloat the state DB.
    if (typeof persistable.errText === 'string' && persistable.errText.length > 8_000) {
      persistable.errText = `${persistable.errText.slice(0, 8_000)}\n… (truncated in history)`;
    }
    if (Array.isArray(persistable.lines) && persistable.lines.length > 100) {
      persistable.lines = [...persistable.lines.slice(0, 100), `… ${persistable.lines.length - 100} more (truncated in history)`];
    }
    // Same bloat bound for a button that carries a key list ("Select these N"):
    // 50 cards × an unbounded deploy set is state-DB weight nobody asked for.
    // Truncating the list would leave a restored button promising N while
    // selecting fewer, so the oversized BUTTON is dropped from the persisted copy
    // instead — the live card, which is where the click normally happens, keeps it.
    const buttons = persistable.buttons;
    if (Array.isArray(buttons)) {
      const kept = buttons.filter(b => {
        const keys = (b as { send?: { keys?: unknown } } | null)?.send?.keys;
        return !Array.isArray(keys) || keys.length <= HISTORY_BUTTON_KEYS_MAX;
      });
      if (kept.length !== buttons.length) persistable.buttons = kept;
    }
    this.cardHistoryCache = [persistable, ...this.cardHistory()].slice(0, CARD_HISTORY_MAX);
    // A lost write costs one history entry — log, don't surface.
    void Promise.resolve(this.context.workspaceState.update(CARD_HISTORY_KEY, this.cardHistoryCache))
      .catch(err => this.output.appendLine(`[history] card-history write failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  // command log helpers
  private cmdSeq = 0;
  private beginCmd(command: string): string {
    const id = `c${++this.cmdSeq}`;
    this.post({ type: 'cmd', entry: { id, timestamp: new Date().toLocaleTimeString(), command, status: 'run' } });
    return id;
  }
  private updateCmd(id: string, command: string): void {
    this.post({ type: 'cmd', entry: { id, timestamp: new Date().toLocaleTimeString(), command, status: 'run' } });
  }
  private endCmd(id: string, success: boolean, durationMs: number): void {
    // Don't send an empty `command` — the webview merges entries by id, and a blank
    // command would otherwise wipe the text shown for the finished command.
    this.post({ type: 'cmd', entry: { id, timestamp: new Date().toLocaleTimeString(), status: success ? 'ok' : 'err', durationMs } });
  }

  private handleError(context: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.output.appendLine(`[${context}] ${message}`);
    if (err instanceof SfCliError && err.stderr) this.output.appendLine(err.stderr);
    this.logSfVersionOnce();
  }

  /** On the first CLI-related error of the session, log the sf CLI version —
   *  the single most useful fact when diagnosing a report from another machine. */
  private logSfVersionOnce(): void {
    if (this.sfVersionLogged) return;
    this.sfVersionLogged = true;
    this.sf.runCancellable(['--version']).promise.then(
      r => this.output.appendLine(`[diag] ${r.stdout.trim().split('\n')[0] || `sf --version exited ${r.code}`}`),
      e => this.output.appendLine(`[diag] sf --version failed: ${e instanceof Error ? e.message : String(e)}`)
    );
  }

  /** Native bottom-right notification for result-level failures (component/test
   *  failures on a completed run). Exceptions already toast via reportError; this
   *  covers the "command succeeded, deployment failed" outcomes. The status card
   *  in the panel stays the durable, detailed record. */
  /** Mirror a result and its detail lines into the output channel. Split out of
   *  failureToast so a QUIET auto-resolve round still records why it failed —
   *  suppressing the toast must never suppress the diagnostics. */
  private logResultLines(message: string, lines: Array<string | { text: string }> = []): void {
    try {
      this.output.appendLine(`[result] ${message}`);
      // Failure lines are org-controlled text — flatten control chars so a hostile
      // org can't forge extra "[result] …" lines or splatter ANSI into the log.
      for (const line of lines) {
        const text = typeof line === 'string' ? line : line.text;
        this.output.appendLine(`  ${stripAnsi(text).replace(/[\x00-\x1f\x7f]/g, ' ')}`);
      }
    } catch (e) {
      this.output.appendLine(`[logResultLines] failed to log "${message}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private failureToast(message: string, lines: Array<string | { text: string }> = []): void {
    // Belt: this is a reporting path, so a synchronous throw from post()/output must
    // not cascade into the caller's catch and mask the real failure. Fall back to the
    // output channel, never rethrow.
    try {
      // The panel's status card is the detailed record — the toast points there
      // first; the details are ALSO mirrored into the output channel so
      // "Show Output" opens a log that actually mentions the failure.
      this.logResultLines(message, lines);
      void vscode.window.showErrorMessage(`SF Deploy: ${message}`, 'Show Panel', 'Show Output').then(choice => {
        if (choice === 'Show Panel') void vscode.commands.executeCommand('sfOrgDeployWrapper.panel.focus');
        if (choice === 'Show Output') this.output.show(true);
      }, () => undefined);
    } catch (e) {
      this.output.appendLine(`[failureToast] failed to report "${message}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private reportError(action: string, err: unknown): void {
    // Belt: reportError is the last line of defense, so a synchronous throw from
    // post()/history persistence here must not cascade into the caller's catch and
    // mask the real error. Fall back to the output channel, never rethrow.
    try {
      const message = err instanceof Error ? err.message : String(err);
      this.handleError(action, err);
      const stderr = err instanceof SfCliError ? err.stderr ?? '' : '';
      this.post({
        type: 'status',
        card: {
          kind: 'err',
          title: `${action} failed`,
          meta: 'See command log / output channel for details',
          errText: stripAnsi([message, stderr].filter(Boolean).join('\n')).trim(),
          actions: err instanceof SfCliError ? err.actions : undefined,
          hint: hintForError(err)
        }
      });
      void vscode.window.showErrorMessage(`SF Deploy: ${action} failed. ${message}`, 'Show Panel', 'Show Output').then(choice => {
        if (choice === 'Show Panel') void vscode.commands.executeCommand('sfOrgDeployWrapper.panel.focus');
        if (choice === 'Show Output') this.output.show(true);
      }, () => undefined);
    } catch (e) {
      this.output.appendLine(`[reportError] failed to report "${action}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Report a deploy/validate whose LOCAL process hit the timeout. Killing the sf
   *  process does NOT stop the org-side deploy — it MAY STILL BE RUNNING — so this
   *  is reported distinctly from a plain failure: a user who retries into that race
   *  gets confusing conflicts. Card + toast point them at the org's status first,
   *  alongside the raise-timeout hint. */
  private reportDeployTimeout(action: string, err: unknown): void {
    try {
      const message = err instanceof Error ? err.message : String(err);
      this.handleError(action, err);
      const note = 'Killing the local command does not stop the deploy on the org — it MAY STILL BE RUNNING. Check the org\'s Deployment Status (Setup) or run `sf project deploy report` before retrying, to avoid deploying twice into a conflict.';
      this.post({
        type: 'status',
        card: {
          kind: 'err',
          title: `${action} timed out`,
          meta: 'Local command timed out — the deploy may still be running on the org',
          errText: stripAnsi(message).trim(),
          hint: `${note} Raise sfOrgDeployWrapper.commandTimeoutMs for large deployments.`
        }
      });
      void vscode.window.showWarningMessage(
        `SF Deploy: ${action} timed out — the deploy may still be running on the org. Check the org before retrying.`,
        'Show Panel', 'Show Output'
      ).then(choice => {
        if (choice === 'Show Panel') void vscode.commands.executeCommand('sfOrgDeployWrapper.panel.focus');
        if (choice === 'Show Output') this.output.show(true);
      }, () => undefined);
    } catch (e) {
      this.output.appendLine(`[reportDeployTimeout] failed to report "${action}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ---- Pre-retrieve backup / restore ----

  private backupsEnabled(): boolean {
    return vscode.workspace.getConfiguration('sfOrgDeployWrapper').get<boolean>('backupBeforeRetrieve', true);
  }

  /** Root of all per-workspace backup dirs, under the extension's global storage. */
  private backupsRoot(): string {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'backups').fsPath;
  }

  /** Stable, collision-free key for one workspace's backups: sanitized basename +
   *  short hash of the absolute root, so two workspaces that share a basename never
   *  land in the same backup dir. */
  private workspaceBackupKey(root: string): string {
    const hash = crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 8);
    return `${sanitizeSegment(path.basename(root))}-${hash}`;
  }

  /**
   * Back up the given local files before a retrieve overwrites them, when the feature
   * is enabled. Returns a note for the result card (files saved, or the over-limit
   * skip), or undefined when disabled / nothing needed saving. THROWS on any
   * copy/write failure so the caller can abort the retrieve — silently proceeding
   * would strip the safety net the setting promises.
   */
  private async maybeBackupBeforeRetrieve(root: string, candidatePaths: string[], orgLabel: string): Promise<{ note: string; dir?: string } | undefined> {
    if (!this.backupsEnabled()) return undefined;
    const result = await this.writeBackup(root, candidatePaths, orgLabel);
    if (result.skippedTooMany) {
      this.output.appendLine(`[backup] skipped — more than ${BACKUP_MAX_FILES} files would be backed up before retrieve`);
      return { note: `backup skipped — over ${BACKUP_MAX_FILES} files` };
    }
    if (result.count === 0) return undefined;
    // `dir` rides along so the caller can offer the card's Restore/Discard buttons
    // (backupCardButtons) against this EXACT backup — never a re-derived "latest".
    return {
      note: `backed up ${result.count} file${result.count === 1 ? '' : 's'} — restore via 'SF Deploy: Restore Retrieve Backup'`,
      dir: result.dir
    };
  }

  /**
   * Copy every existing regular file among `candidatePaths` (deduped, confined to
   * `root`) into a fresh timestamped backup dir, preserving each path RELATIVE to
   * root, alongside a backup.json manifest. Prunes to the newest BACKUP_KEEP dirs
   * afterwards. Creates no dir when there's nothing to copy or the count exceeds
   * BACKUP_MAX_FILES. Rejects (throws) if a copy fails. `opts.protect` names a dir the
   * prune must keep regardless (so a pre-restore backup can't delete its own source).
   * Returns the fresh backup's absolute `dir` when count > 0, so a caller (e.g. the
   * retrieve flows) can offer it straight back for a scoped restore/discard.
   */
  private async writeBackup(root: string, candidatePaths: string[], orgLabel: string, opts: { protect?: string } = {}): Promise<{ count: number; skippedTooMany?: boolean; dir?: string }> {
    const rootResolved = path.resolve(root);
    const seen = new Set<string>();
    const toCopy: string[] = [];
    for (const p of candidatePaths) {
      if (!p) continue; // org-only items carry '' — nothing local to save
      const abs = path.resolve(p);
      if (seen.has(abs)) continue;
      seen.add(abs);
      if (!isUnder(rootResolved, abs)) continue; // never reach outside the workspace
      // lstat, not stat: a hostile workspace can plant an in-tree symlink whose
      // target lives OUTSIDE the workspace — following it would copy that target
      // into extension storage (security review LOW). Links are skipped, not
      // resolved: a retrieve overwrites the link path itself anyway.
      let st: Awaited<ReturnType<typeof fs.lstat>>;
      try { st = await fs.lstat(abs); } catch { continue; } // already gone — nothing to save
      if (st.isSymbolicLink() || !st.isFile()) continue; // bundle dirs listed separately; links skipped
      toCopy.push(abs);
    }
    if (toCopy.length === 0) {
      // A safety net that silently doesn't fire is worse than none. When real
      // candidates were offered (org-only '' entries excluded) but every one was
      // missing or resolved outside the workspace — e.g. a mis-cased inferred path
      // that isUnder now folds, or a file already gone — leave a trace.
      const offered = candidatePaths.filter(Boolean).length;
      if (offered > 0) this.output.appendLine(`[backup] backup skipped ${offered} candidate(s): missing or outside the workspace`);
      return { count: 0 };
    }
    if (toCopy.length > BACKUP_MAX_FILES) return { count: 0, skippedTooMany: true };

    const key = this.workspaceBackupKey(root);
    // Random tail: two same-millisecond backups for one org (restore's undo backup
    // colliding with its own source — security review DH-1) must never share a dir.
    const dirName = `${sanitizeSegment(new Date().toISOString())}__${sanitizeSegment(orgLabel)}__${crypto.randomBytes(3).toString('hex')}`;
    const destRoot = path.join(this.backupsRoot(), key, dirName);
    for (const abs of toCopy) {
      const dest = path.join(destRoot, path.relative(rootResolved, abs));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(abs, dest);
    }
    const manifest: BackupManifest = { at: Date.now(), org: orgLabel, fileCount: toCopy.length, workspaceRoot: rootResolved };
    await fs.mkdir(destRoot, { recursive: true }); // belt-and-braces before the manifest write
    await fs.writeFile(path.join(destRoot, BACKUP_MANIFEST), JSON.stringify(manifest, null, 2), 'utf8');
    await this.pruneBackups(key, opts.protect);
    return { count: toCopy.length, dir: destRoot };
  }

  /** Keep only the newest BACKUP_KEEP backup dirs for a workspace key (dir names are
   *  sanitized ISO timestamps, so lexical order == chronological). `protect` is a dir
   *  name kept regardless — so a pre-restore backup can't prune the very backup being
   *  restored. Never throws: a failed prune only leaves stale dirs, it must not fail
   *  the backup that just succeeded. */
  private async pruneBackups(key: string, protect?: string): Promise<void> {
    const base = path.join(this.backupsRoot(), key);
    let names: string[];
    try {
      names = (await fs.readdir(base, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);
    } catch { return; }
    const doomed = names.sort().reverse().slice(BACKUP_KEEP).filter(n => n !== protect);
    for (const name of doomed) {
      await fs.rm(path.join(base, name), { recursive: true, force: true })
        .catch(err => this.output.appendLine(`[backup] prune failed for ${name}: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  /** Read one backup dir's manifest into a BackupEntry, or undefined when the dir is
   *  missing or its manifest is unreadable/broken — a pruned, in-progress, or
   *  never-written backup. Callers surface this as "backup no longer exists". */
  private async readBackupManifest(dir: string): Promise<BackupEntry | undefined> {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, BACKUP_MANIFEST), 'utf8')) as Partial<BackupManifest>;
      return {
        dir,
        at: typeof raw.at === 'number' ? raw.at : 0,
        org: typeof raw.org === 'string' ? raw.org : '(unknown org)',
        fileCount: typeof raw.fileCount === 'number' ? raw.fileCount : 0
      };
    } catch { return undefined; } // no/broken manifest — not a restorable backup
  }

  /** All valid backups for a workspace, newest first, read from each dir's manifest.
   *  Dirs without a readable backup.json are skipped (a partial/interrupted backup
   *  isn't offered for restore). */
  private async listBackups(key: string): Promise<BackupEntry[]> {
    const base = path.join(this.backupsRoot(), key);
    let names: string[];
    try {
      names = (await fs.readdir(base, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);
    } catch { return []; }
    const out: BackupEntry[] = [];
    for (const name of names) {
      const entry = await this.readBackupManifest(path.join(base, name));
      if (entry) out.push(entry);
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /** Every backed-up file in a dir, as paths relative to that dir, excluding the
   *  top-level manifest. */
  private async listBackupFiles(backupDir: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) await walk(abs);
        else if (e.isFile()) out.push(path.relative(backupDir, abs));
      }
    };
    await walk(backupDir);
    return out.filter(rel => rel !== BACKUP_MANIFEST);
  }

  /**
   * Validate a webview-supplied backup dir BEFORE any fs use. Card buttons round-trip
   * `dir` through postMessage (and through the persisted card history, across
   * reloads) — the webview is a potentially compromised caller, so that string must
   * never reach fs.rm/fs.readFile/fs.copyFile unchecked. Requires the resolved path
   * to be a DIRECT child of this workspace's own backup root
   * (`backupsRoot()/workspaceBackupKey(root)`) — not merely nested somewhere under
   * it, and not another workspace's key. Returns the resolved absolute dir, or
   * undefined when `dir` is missing or fails that check.
   */
  private resolveBackupDir(root: string, dir: string | undefined): string | undefined {
    if (!dir) return undefined;
    const base = path.resolve(path.join(this.backupsRoot(), this.workspaceBackupKey(root)));
    const resolved = path.resolve(dir);
    return path.dirname(resolved) === base ? resolved : undefined;
  }

  /**
   * Restore local files from a pre-retrieve backup — the undo for a retrieve
   * overwrite. Shared by the palette command (`SF Deploy: Restore Retrieve Backup`,
   * `dir` undefined — shows the backup picker first) and a status card's "Restore
   * backup…" button (`dir` already names the exact backup that retrieve made, so the
   * picker is skipped and we go straight to picking which files to restore).
   *
   * Busy-refuses WITHOUT taking the slot (like refreshFiles/pickOrg) so the pickers
   * can't block a running op; reserves the 'Restore' slot only around the copy
   * phase. Before overwriting, the CURRENT copies of the chosen files are backed up
   * (so a restore is itself undoable), then the backup is copied back. Every
   * destination is confined to the workspace root — a tampered backup dir can't
   * write outside it.
   */
  async restoreRetrieveBackup(dir?: string): Promise<void> {
    if (this.busy) { this.notifyBusy(); return; }
    const root = this.requireRoot();
    if (!root) return;

    let backup: BackupEntry | undefined;
    if (dir !== undefined) {
      // Card-button path: dir names the specific backup a retrieve just made.
      // SECURITY: resolve + confine it before any fs use (see resolveBackupDir).
      const resolved = this.resolveBackupDir(root, dir);
      if (!resolved) {
        vscode.window.showWarningMessage('SF Deploy: that backup directory is not valid for this workspace.');
        return;
      }
      backup = await this.readBackupManifest(resolved);
      if (!backup) {
        vscode.window.showWarningMessage(`SF Deploy: backup no longer exists (backups keep the last ${BACKUP_KEEP}).`);
        return;
      }
    } else {
      // Palette path: no dir yet — offer the list of backups for this workspace.
      const key = this.workspaceBackupKey(root);
      const backups = await this.listBackups(key);
      if (backups.length === 0) {
        vscode.window.showInformationMessage('SF Deploy: no retrieve backups for this workspace yet.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        backups.map(b => ({
          label: `${new Date(b.at).toLocaleString()} — ${b.org}`,
          description: `${b.fileCount} file${b.fileCount === 1 ? '' : 's'}`,
          backup: b
        })),
        { placeHolder: 'Restore local files from which retrieve backup?' }
      );
      if (!picked) return;

      // Follow-up step: offer discarding as an alternative to restoring, before
      // committing to the file picker — same confirm + rm path as the card button
      // (discardBackup), just reached from the palette.
      type BackupChoice = vscode.QuickPickItem & { action: 'restore' | 'discard' };
      const next = await vscode.window.showQuickPick<BackupChoice>(
        [
          { label: 'Restore files from this backup…', action: 'restore' },
          { label: 'Discard this backup', description: 'Deletes it permanently — cannot be undone.', action: 'discard' }
        ],
        { placeHolder: `${new Date(picked.backup.at).toLocaleString()} — ${picked.backup.org} · ${picked.backup.fileCount} file${picked.backup.fileCount === 1 ? '' : 's'}` }
      );
      if (!next) return;
      if (next.action === 'discard') { await this.discardBackup(picked.backup.dir); return; }
      backup = picked.backup;
    }

    const when = new Date(backup.at).toLocaleString();
    const relFiles = await this.listBackupFiles(backup.dir);
    if (relFiles.length === 0) {
      vscode.window.showInformationMessage('SF Deploy: this backup has no files to restore.');
      return;
    }
    // canPickMany, ALL preselected — restoring the full backup is the common case
    // (accept the defaults), but any subset can be unchecked first.
    type FilePick = vscode.QuickPickItem & { rel: string };
    const filePicks = await vscode.window.showQuickPick<FilePick>(
      relFiles.map(rel => ({ label: rel, picked: true, rel })),
      { canPickMany: true, placeHolder: `Restore which files from ${when} — ${backup.org}?` }
    );
    if (!filePicks || filePicks.length === 0) return;
    const chosen = filePicks.map(f => f.rel);

    const confirm = await vscode.window.showWarningMessage(
      `Overwrite ${chosen.length} current local file${chosen.length === 1 ? '' : 's'} with the backup from ${when} (${backup.org})? The current copies are themselves backed up first.`,
      { modal: true },
      'Restore'
    );
    if (confirm !== 'Restore') return;

    // Reserve the slot only for the copy phase (finally-release), matching the
    // discipline the deploy/retrieve paths use.
    if (!this.reserveBusy('Restore')) return;
    try {
      const rootResolved = path.resolve(root);
      // Undo-of-the-undo: back up the CURRENT state of the chosen files first.
      // Protect the source dir from that backup's prune so we can't delete what
      // we're about to restore from. A failure here THROWS before anything is
      // overwritten.
      const orgLabel = this.orgs.find(o => o.username === this.orgStore.get())?.alias ?? this.orgStore.get() ?? 'restore';
      await this.writeBackup(root, chosen.map(rel => path.join(rootResolved, rel)), orgLabel, { protect: path.basename(backup.dir) });

      const restored: string[] = [];
      const rejected: string[] = [];
      for (const rel of chosen) {
        const dest = path.resolve(rootResolved, rel);
        // Path-safety: a hand-tampered backup dir could hold a `../` escape; refuse
        // anything that resolves outside the workspace root.
        if (!isUnder(rootResolved, dest)) { rejected.push(rel); continue; }
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(path.join(backup.dir, rel), dest);
        restored.push(rel);
      }
      // Re-scan the tree and refresh the Changed lens against the restored files.
      await this.loadFiles();
      await this.postChangedComponents();

      const lines = [...restored, ...rejected.map(r => `✗ ${r} — outside workspace, skipped`)];
      this.post({
        type: 'status',
        card: {
          kind: rejected.length ? 'warn' : 'ok',
          title: `Restored ${restored.length} file${restored.length === 1 ? '' : 's'} from backup`,
          meta: `${when} — ${backup.org}${rejected.length ? ` · ${rejected.length} skipped` : ''}`,
          lines
        }
      });
      this.notifySuccessIfPanelHidden(`Restored ${restored.length} file${restored.length === 1 ? '' : 's'} from backup`);
    } catch (err) {
      this.reportError('Restore Retrieve Backup', err);
    } finally {
      this.setBusy(false);
    }
  }

  /**
   * Discard a pre-retrieve backup permanently (no undo) — the counterpart to
   * restoreRetrieveBackup, reached from the status-card "Discard backup" button and
   * from the palette restore flow's "Discard this backup" alternative. `dir` is
   * validated exactly like restoreRetrieveBackup's, before any fs use.
   *
   * Busy-refuses WITHOUT taking the slot: discarding is a single fast, local
   * fs.rm — there's no multi-step phase worth a progress slot for, unlike restore's
   * copy phase.
   */
  private async discardBackup(dir: string | undefined): Promise<void> {
    if (this.busy) { this.notifyBusy(); return; }
    const root = this.requireRoot();
    if (!root) return;
    const resolved = this.resolveBackupDir(root, dir);
    if (!resolved) {
      vscode.window.showWarningMessage('SF Deploy: that backup directory is not valid for this workspace.');
      return;
    }
    const entry = await this.readBackupManifest(resolved);
    if (!entry) {
      vscode.window.showWarningMessage(`SF Deploy: backup no longer exists (backups keep the last ${BACKUP_KEEP}).`);
      return;
    }
    const when = new Date(entry.at).toLocaleString();
    const confirm = await vscode.window.showWarningMessage(
      `Discard this backup (${entry.fileCount} file${entry.fileCount === 1 ? '' : 's'}, ${when})? This cannot be undone.`,
      { modal: true },
      'Discard'
    );
    if (confirm !== 'Discard') return;
    try {
      await fs.rm(resolved, { recursive: true, force: true });
      this.post({
        type: 'status',
        card: {
          kind: 'ok',
          title: 'Backup discarded',
          meta: `${when} — ${entry.org} · ${entry.fileCount} file${entry.fileCount === 1 ? '' : 's'}`
        }
      });
    } catch (err) {
      this.reportError('Discard backup', err);
    }
  }

  /** Card `buttons` for a retrieve result that made a backup — spreads to nothing
   *  when no backup was made this run (dir undefined). Both buttons round-trip the
   *  SAME dir through the webview; the provider re-validates it against this
   *  workspace's backup root before acting (resolveBackupDir), so neither a stale
   *  dir (pruned since) nor a tampered one can reach fs directly. */
  private backupCardButtons(dir: string | undefined): { buttons: Array<{ label: string; send: { type: string; dir: string } }> } | Record<string, never> {
    if (!dir) return {};
    return {
      buttons: [
        { label: 'Restore backup…', send: { type: 'restoreBackup', dir } },
        { label: 'Discard backup', send: { type: 'discardBackup', dir } }
      ]
    };
  }

  /** Card `buttons` for a SUCCESSFUL deploy/validate: one control that puts exactly
   *  the components of that run back into the tree selection. Without it a
   *  follow-up action (diff what just went up, retrieve it back, redeploy after one
   *  more edit) means ticking the same rows again by hand — the panel otherwise
   *  keeps no record of a finished run's contents. The keys ride WITH the card
   *  because the card outlives both the selection and the window; they are
   *  re-validated against the live scan on click (selectableScannedKeys), never
   *  trusted back.
   *  Only items with LOCAL SOURCE qualify, and the filter lives HERE rather than
   *  at the call site so no caller can bypass it: a manifest deploy's items come
   *  from <members> (`ApexClass:*` included) and a reattached job's from the org's
   *  report, so a button built from those promises a selection the tree cannot
   *  make and lands on "none of those are in your workspace" — while blaming a
   *  workspace change that never happened. Spreads to nothing when the run
   *  touched no local source at all. */
  private selectDeployedButtons(items: MetadataItem[]): { buttons: Array<{ label: string; send: { type: string; keys: string[] } }> } | Record<string, never> {
    const keys = items.filter(i => !!i.filePath).map(i => `${i.type}:${i.name}`);
    if (keys.length === 0) return {};
    return {
      buttons: [{
        label: keys.length === 1 ? 'Select this component' : `Select these ${keys.length}`,
        send: { type: 'selectDeployed', keys }
      }]
    };
  }

  /** Keys echoed back from a result card, reduced to what can actually be selected
   *  NOW: strings only, de-duplicated, and present in the current scan WITH local
   *  source. Two reasons, not one: the message round-trips through the webview
   *  (so only a real scanned MetadataItem may ever enter a selection that later
   *  becomes a `--metadata` deploy), and a card is durable history (so it can name
   *  a component since renamed, deleted, or moved out of the package directories).
   *  `dropped` counts the losses so the caller can say so instead of quietly
   *  selecting fewer components than the button promised. */
  private selectableScannedKeys(raw: unknown, items: MetadataItem[]): { keys: string[]; dropped: number } {
    const wanted = Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [];
    const scanned = new Set(items.filter(i => !!i.filePath).map(i => `${i.type}:${i.name}`));
    const unique = [...new Set(wanted)];
    const keys = unique.filter(k => scanned.has(k));
    return { keys, dropped: unique.length - keys.length };
  }
}

// ---- module-local helpers ----

/** Sanitize one path segment WE generate (timestamp, org label, workspace key) into a
 *  safe directory name: keep [A-Za-z0-9._-], replace the rest with '-'. Empty or
 *  dot-only results ('' / '.' / '..') collapse to '_' so a segment can never become a
 *  traversal or a meaningless name. */
function sanitizeSegment(s: string): string {
  // Win32 silently strips trailing dots from path components — an org label
  // ending in '.' would make the backup dir's on-disk name diverge from the
  // string this code tracks. Strip them here instead.
  const cleaned = s.replace(/[^A-Za-z0-9._-]/g, '-').replace(/\.+$/, '_');
  return /^\.*$/.test(cleaned) || cleaned === '' ? '_' : cleaned;
}

/** True when `abs` is `root` itself or nested beneath it — the confinement check for
 *  both writing backups and restoring them. Both args must already be resolved
 *  absolute paths. Compares via foldPathKey so a drive-letter/casing drift between
 *  a dialog- or infer-sourced path and the workspace root can't drop an in-tree
 *  file on Windows; callers keep using their ORIGINAL paths for the fs operations. */
function isUnder(root: string, abs: string): boolean {
  const r = foldPathKey(root);
  const a = foldPathKey(abs);
  return a === r || a.startsWith(r + path.sep);
}

/** All metadata types the extension supports — fetched in one batch when the user clicks "Fetch Org". */
const FETCH_ORG_TYPES: readonly string[] = [
  // Apex / Visualforce
  'ApexClass', 'ApexTrigger', 'ApexPage', 'ApexComponent', 'ApexTestSuite',
  // Lightning
  'LightningComponentBundle', 'AuraDefinitionBundle', 'LightningMessageChannel', 'FlexiPage',
  // Automation
  'Flow', 'Workflow',
  // Security / access
  'PermissionSet', 'Profile', 'Role', 'CustomPermission',
  // Object children (returned as ObjectName.MemberName)
  'CustomObject', 'CustomField', 'ValidationRule', 'RecordType', 'ListView',
  'FieldSet', 'CompactLayout', 'WebLink', 'BusinessProcess', 'Index', 'SharingReason',
  // UI / UX
  'Layout', 'CustomTab', 'CustomApplication', 'QuickAction',
  // Data / config
  'CustomLabels', 'CustomMetadata', 'GlobalValueSet',
  'Queue', 'Group', 'StaticResource',
  // Integration / connectivity
  'NamedCredential', 'ExternalDataSource', 'RemoteSiteSetting',
  // Misc
  'EmailTemplate', 'Settings',
  // OmniStudio (standard runtime — where these are real metadata types; on
  // classic managed-runtime orgs the list call fails per-type and is reported,
  // like any other unsupported type)
  'OmniScript', 'OmniIntegrationProcedure', 'OmniDataTransform', 'OmniUiCard',
  // ---- 2026-07 expansion, curated from the sf CLI's own metadata registry ----
  // Picklists & translations
  'StandardValueSet', 'GlobalValueSetTranslation', 'Translations', 'CustomObjectTranslation',
  // Automation & guidance
  'ApprovalProcess', 'FlowTest', 'PathAssistant',
  // Data quality & record routing
  'DuplicateRule', 'MatchingRules', 'AssignmentRules', 'AutoResponseRules', 'EscalationRules', 'SharingRules',
  // Access & auth
  'PermissionSetGroup', 'MutingPermissionSet', 'ConnectedApp', 'AuthProvider',
  'ExternalCredential', 'Certificate', 'CspTrustedSite', 'CorsWhitelistOrigin',
  // UI & branding
  'AppMenu', 'CustomNotificationType', 'LightningExperienceTheme', 'BrandingSet', 'ContentAsset',
  // Analytics (Report/Dashboard are folder-based — see FOLDERED_TYPES)
  'Report', 'Dashboard', 'ReportType',
  // Integration & platform
  'PlatformEventChannel', 'PlatformEventSubscriberConfig', 'PlatformCachePartition',
  'ExternalServiceRegistration', 'EmailServicesFunction', 'DataWeaveResource',
  // Experience Cloud & Service
  'ExperienceBundle', 'Network', 'CustomSite', 'EntitlementProcess', 'MilestoneType', 'Bot',
];

/** Folder-based types: their members only list per folder, so the folders are
 *  enumerated first. Members come back as `Folder/Name`, matching local keys.
 *  (EmailTemplateFolder is the long-standing alias of EmailFolder — kept because
 *  it's what this plugin has always queried successfully.) */
const FOLDERED_TYPES: Record<string, string> = {
  EmailTemplate: 'EmailTemplateFolder',
  Report: 'ReportFolder',
  Dashboard: 'DashboardFolder'
};

function orgKind(o: OrgInfo): 'prod' | 'sandbox' | 'scratch' | 'other' {
  if (o.isScratch) return 'scratch';
  if (o.isSandbox) return 'sandbox';
  const url = (o.instanceUrl ?? '').toLowerCase();
  if (url.includes('.scratch.')) return 'scratch';
  if (url.includes('sandbox')) return 'sandbox';
  if (/\.my\.salesforce\.com$/i.test(url)) return 'prod';
  return 'other';
}

/** Metadata types whose MDAPI-format retrieve differs structurally from source format,
 *  making `vscode.diff` against the local source-format file misleading. Exported
 *  because it is load-bearing beyond diff quality: runDiff hands `item.filePath`
 *  straight to `vscode.diff`, so every DIRECTORY_ITEM_TYPES member has to be in
 *  here or that call would pass a folder to an editor — the same wall the openFile
 *  handler hit. check-open-target.cjs pins the containment. The one way past this
 *  set is runDiff's `focusFile`, which first rewrites `filePath` to a real file
 *  inside the folder. */
export const DIFF_UNSUPPORTED = new Set<string>(['CustomObject', 'LightningComponentBundle', 'AuraDefinitionBundle', 'StaticResource']);

/** Tooling API body field per metadata type eligible for the diff fast path:
 *  one REST query instead of a Metadata API retrieve round-trip. */
const FAST_DIFF_FIELD: Record<string, string> = {
  ApexClass: 'Body',
  ApexTrigger: 'Body',
  ApexPage: 'Markup',
  ApexComponent: 'Markup'
};

interface ToolingCodeRecord {
  Name?: string;
  NamespacePrefix?: string | null;
  [field: string]: unknown;
}

/**
 * Card presentation for a finished diff run, plus whether the verdict needs a
 * native notification when the panel is hidden. Pure, so the "which outcome may
 * stay silent" rule is assertable: an opened diff editor IS the feedback, while a
 * run that opened nothing, or one the org failed part of, would otherwise be a
 * dead click from the context menu.
 * `attempted` is the diffable set actually processed (after the >5 cap), which is
 * what "everything was missing" has to be measured against.
 */
export function classifyDiffOutcome(
  counts: { opened: number; missing: number; errors: number; unsupported: number; attempted: number },
  orgLabel: string
): { kind: 'ok' | 'warn' | 'err'; title: string; meta: string; notify: 'none' | 'warn' | 'err' } {
  const { opened, missing, errors, unsupported, attempted } = counts;
  const kind = errors > 0 ? 'err' : ((missing > 0 || unsupported > 0) ? 'warn' : 'ok');
  const title = opened > 0
    ? `Diff opened for ${opened} component${opened === 1 ? '' : 's'} against ${orgLabel}`
    : (missing === attempted ? `Nothing to diff — not on ${orgLabel}` : `Diff completed with issues against ${orgLabel}`);
  const meta = `${opened} opened · ${missing} missing · ${errors} errors${unsupported ? ` · ${unsupported} unsupported` : ''}`;
  const notify = errors > 0 ? 'err' : (opened === 0 && kind === 'warn' ? 'warn' : 'none');
  return { kind, title, meta, notify };
}

/**
 * Card with every button whose `send.type` is outside `supported` removed (see
 * SUPPORTED_CARD_BUTTON_SENDS). A button with no usable `send.type` at all goes
 * the same way — it could never have posted anything.
 *
 * Returns the card UNCHANGED (same reference) when nothing needed dropping, and
 * omits the `buttons` key entirely rather than leaving an empty array behind, so a
 * pruned card is indistinguishable from one that never had buttons.
 */
export function pruneCardButtons(
  card: Record<string, unknown>,
  supported: ReadonlySet<string> = SUPPORTED_CARD_BUTTON_SENDS
): Record<string, unknown> {
  const buttons = card.buttons;
  if (!Array.isArray(buttons)) return card;
  const kept = buttons.filter(b => {
    const type = (b as { send?: { type?: unknown } } | null)?.send?.type;
    return typeof type === 'string' && supported.has(type);
  });
  if (kept.length === buttons.length) return card;
  const { buttons: _dropped, ...rest } = card;
  return kept.length ? { ...rest, buttons: kept } : rest;
}

/** Condensed reason for a diff that had nothing to compare at all. The toast has no
 *  room for the per-item lines — the card behind 'Show Panel' carries those — but a
 *  single right-clicked file is the common case, so name its type outright. */
export function nothingDiffableNotice(unsupportedTypes: string[], orgOnlyCount: number): string {
  const parts: string[] = [];
  if (unsupportedTypes.length === 1) {
    // Same correction as the card line: a folder-typed component IS diffable through
    // one of its files, so the toast must not tell the user the type isn't supported.
    parts.push(DIRECTORY_ITEM_TYPES.has(unsupportedTypes[0])
      ? `${unsupportedTypes[0]} has no whole-component diff — right-click a file inside it`
      : `diff isn't supported for ${unsupportedTypes[0]} yet`);
  } else if (unsupportedTypes.length > 1) parts.push(`${unsupportedTypes.length} unsupported metadata types`);
  if (orgOnlyCount > 0) parts.push(`${orgOnlyCount} org-only component${orgOnlyCount === 1 ? '' : 's'} (retrieve first)`);
  return `Nothing to diff — ${parts.join(' · ') || 'nothing comparable was selected'}`;
}

/** A fetch error that would affect every metadata type (expired auth, wrong/missing
 *  org, network) rather than being specific to one type. Used to decide whether a
 *  Fetch Org with zero results is a genuine failure vs a legitimately empty org. */
function isFatalFetchError(err: unknown): boolean {
  const name = err instanceof SfCliError ? err.errorName ?? '' : '';
  const message = err instanceof Error ? err.message : String(err);
  const txt = `${name} ${message}`.toLowerCase();
  return /nodefaultenv|namedorgnotfound|noauthinfofound|invalid_grant|expired|refreshtokenauth|enotfound|getaddrinfo|econnrefused|econnreset|etimedout|socket hang up|timed out/.test(txt);
}

/** The local process-kill timeout (SfCliError whose message says it "timed out",
 *  thrown by the CLI runner after SIGTERM→SIGKILL). Distinct from a genuine deploy
 *  failure: killing the local `sf` does NOT stop the org-side deploy, so the caller
 *  must steer the user to the org rather than a bare retry. Cancels are their own
 *  SfCliCancelledError and are matched before this. */
function isTimeoutError(err: unknown): boolean {
  return err instanceof SfCliError && /timed out/i.test(err.message);
}

/** The confirm modal's one-line notice for the conflict override, or undefined when
 *  the override is off (a silent modal then means the CLI's own conflict protection
 *  is intact). Worth saying out loud because the setting is machine-scoped: it is
 *  sticky across every workspace on this machine, so someone who switched it on
 *  months ago in another project carries it into this one with nothing on screen to
 *  say so — and the confirm is the last gate before a live org change. Wording
 *  follows the panel's own "Overwrite org changes" label. A check-only validate gets
 *  a different sentence: it replaces nothing, what it loses is the conflict check
 *  that would have flagged newer org changes. `queued` states the run-time semantics
 *  — the flag is re-read when the queue drains, so this line is a snapshot. */
function overwriteNotice(ignoreConflicts: boolean, validateOnly: boolean, queued: boolean): string | undefined {
  if (!ignoreConflicts) return undefined;
  const body = validateOnly
    ? 'Overwrite org changes is ON — the conflict check is skipped, so this validation will not flag newer changes in the org (--ignore-conflicts).'
    : 'Overwrite org changes is ON — newer changes in the org will be replaced (--ignore-conflicts).';
  return queued ? `${body} The setting is re-read when this queued run starts.` : body;
}

/**
 * Modal detail line for "Deploy File + Dependencies": the one deploy path where
 * the confirmed set is mostly NOT what the user selected. The count alone
 * ("Deploy 26 components to …") reads as panel state gone wrong when the user
 * right-clicked a single file, so name the split — the file they picked, plus how
 * many the dependency scan added — while the deploy can still be refused.
 * Undefined for every other path, which keeps their modals byte-for-byte as they
 * were, and for a scan that added nothing (the count is then simply the truth).
 */
export function autoIncludedNotice(auto: { count: number; entryKey: string } | undefined): string | undefined {
  if (!auto || auto.count <= 0) return undefined;
  return `Includes ${auto.count} component${auto.count === 1 ? '' : 's'} auto-included as local dependencies of ${auto.entryKey} — the result card lists each one and what referenced it.`;
}

/** Preposition for a verb in card / progress / toast text: a check-only run
 *  (validate) goes "against" an org, runs that actually write go "to" it. */
function orgPrep(verb: DeployVerb): 'against' | 'to' {
  return verb === 'Validate' ? 'against' : 'to';
}

/** The retry request a result card carries — built from the options the run
 *  ACTUALLY used, in one place, because every field here is a promise about what
 *  a later click re-runs. `validateOnly` is the load-bearing one: Retry and an
 *  accepted dependency suggestion both re-enter runDeploy through it, so losing it
 *  turns a check into a real deploy behind a button labelled "Retry validation". */
export function buildRetryRequest(
  opts: { validateOnly?: boolean; sourceDir?: string },
  items: MetadataItem[],
  testLevel: TestLevel,
  runTests: string[]
): RetryRequest {
  return {
    keys: items.map(i => `${i.type}:${i.name}`),
    sourceDir: opts.sourceDir,
    validateOnly: !!opts.validateOnly,
    testLevel,
    runTests: runTests.length ? runTests : undefined
  };
}

/** The deploy options a retry-shaped request re-runs with. Shared by every path
 *  that re-enters runDeploy from a card (Retry, Retry + changed, an accepted
 *  dependency suggestion) so the check-only mode can't drift between them.
 *  Strict `=== true`: the request round-trips through the webview and the
 *  persisted history, so a missing field and a forged truthy value both read as
 *  "not check-only" — safe only because runDeploy still confirms every run
 *  against its own modal. `sourceDir` is deliberately NOT handled here: it needs
 *  the workspace root to be validated against, which is the caller's job. */
export function deployOptsFromRetry(r: RetryRequest): {
  validateOnly: boolean; testLevel?: TestLevel; runTests?: string[];
} {
  return {
    validateOnly: r.validateOnly === true,
    testLevel: isTestLevel(r.testLevel) ? r.testLevel : undefined,
    runTests: Array.isArray(r.runTests) ? r.runTests.filter(t => typeof t === 'string') : undefined
  };
}

/** The check-only mode implied by a persisted job's verb. The verb is the ONLY
 *  record that a reattached job was check-only once the original run's opts are
 *  gone — without it a reattached validation reports as a deploy that landed, and
 *  its Retry re-runs as one. */
export function verbModes(verb: DeployVerb): { validateOnly: boolean } {
  return { validateOnly: verb === 'Validate' };
}

/** Cap on the request-level failure text echoed into a card line and fed to the
 *  dependency detector. Org-controlled, so bounded like every other such string;
 *  400 leaves room for the sentence that names the type ("Invalid type: Foo__mdt")
 *  without pasting a whole stack of platform prose into the card. */
const ENVELOPE_PROBLEM_MAX = 400;

/** The org's REQUEST-level failure text (`errorMessage` on the Metadata API deploy
 *  status), flattened and length-bounded; '' when the org didn't send one.
 *  It matters because a deploy CAN fail with no per-component rows at all — the
 *  card then had nothing but "no per-component details" and dependency detection
 *  never ran, even though this string routinely carries the same parseable
 *  "Invalid type: X" wording the per-component problems do. */
export function envelopeProblem(result: DeployResult): string {
  const raw = typeof result.errorMessage === 'string' ? result.errorMessage : '';
  const flat = stripAnsi(raw).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > ENVELOPE_PROBLEM_MAX ? `${flat.slice(0, ENVELOPE_PROBLEM_MAX - 1)}…` : flat;
}

/** Terminal Metadata API deploy statuses — the poll loop stops on any of these.
 *  (`Pending`/`Queued`/`InProgress`/`Canceling` are the non-terminal ones.) */
const TERMINAL_DEPLOY_STATUSES = new Set(['Succeeded', 'SucceededPartial', 'Failed', 'Canceled', 'Error']);

/** True once a polled deploy has finished on the org: a known terminal status, or
 *  any state the CLI flags `done: true` (belt for a status string we don't list). */
function isTerminalDeploy(result: DeployResult): boolean {
  const status = typeof result.status === 'string' ? result.status : '';
  return TERMINAL_DEPLOY_STATUSES.has(status) || result.done === true;
}

/** Per-component success rows of a deploy result across both CLI shapes: prefer
 *  `details.componentSuccesses` when it has rows, else the filtered `files` list.
 *  `.length ?`, not `??` — an empty-but-present detail array must fall through to
 *  `files`, or a shape carrying both silently reports zero successes. Note the
 *  files filter admits any non-Failed state; if a destructive-changes flag is
 *  ever added to deployMetadata, `state: 'Deleted'` rows would count as present
 *  here and need excluding. */
export function deploySuccessRows(result: DeployResult): DeployFileResult[] {
  const detail = result.details?.componentSuccesses ?? [];
  if (detail.length) return detail;
  return (result.files ?? []).filter(f => f.state && f.state !== 'Failed' && !fileProblem(f));
}

/** The `Type:Name` components a delete (or its dry-run) reports as removed. The shape
 *  has drifted across sf versions, so read whichever is populated: `deletedSource`
 *  (newer) or `deletes` (older) for the local removals, then the deploy-style `files`
 *  and `details.componentSuccesses` as fallbacks. De-duplicated, junk rows skipped. */
function deletedLines(result: DeleteResult): string[] {
  const rows = result.deletedSource?.length ? result.deletedSource
    : result.deletes?.length ? result.deletes
    : result.files?.length ? result.files
    : result.details?.componentSuccesses ?? [];
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r?.type || !r?.fullName) continue;
    const key = `${r.type}:${r.fullName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(key);
  }
  return lines;
}

/** Type guard for the full TestLevel union — validates a workspaceState value that
 *  could be anything after a corrupted write or a hand-edited state DB. Unlike
 *  configuredTestLevel() (the settings.json default), this allows RunSpecifiedTests:
 *  it's restoring the panel's own session pick, which legitimately can be it. */
function isTestLevel(v: unknown): v is TestLevel {
  return v === 'NoTestRun' || v === 'RunSpecifiedTests' || v === 'RunLocalTests' || v === 'RunAllTestsInOrg';
}

/** Map well-known sf CLI failures to a one-line actionable hint for the error card. */
function hintForError(err: unknown): string | undefined {
  const name = err instanceof SfCliError ? err.errorName ?? '' : '';
  const message = err instanceof Error ? err.message : String(err);
  const txt = `${name} ${message}`.toLowerCase();
  if (txt.includes('conflict')) {
    return 'The org has changes that conflict with your local files — retrieve them first, or enable Overwrite org changes in the panel.';
  }
  if (/namedorgnotfound|noauthinfofound|invalid_grant|expired|refreshtokenauth/.test(txt)) {
    return 'Org authentication looks expired or missing — run `sf org login web` and retry.';
  }
  if (/requiresproject|sfdx-project\.json/.test(txt)) {
    return 'This workspace is not a Salesforce DX project (sfdx-project.json not found).';
  }
  if (/nonexistent flag|is not a sf command|command [^\s]+ not found/.test(txt)) {
    return 'Your sf CLI looks outdated for this command — run `sf update` (or reinstall @salesforce/cli), then reload VS Code.';
  }
  if (/enotfound|getaddrinfo|econnrefused|econnreset|etimedout|socket hang up/.test(txt)) {
    return 'Network problem reaching the org — check your connection/VPN and retry.';
  }
  if (txt.includes('timed out')) {
    return 'The command hit the configured timeout — raise sfOrgDeployWrapper.commandTimeoutMs for large components.';
  }
  return undefined;
}

/** Recursively find a file under `dir` whose name equals `exactBasename`, else the
 *  first whose name starts with `leafName + '.'`. Bounded by the retrieve output. */
/** First file under `dir`, depth-first, satisfying `pred`. */
async function findFile(dir: string, pred: (name: string, full: string) => boolean): Promise<string | undefined> {
  let entries: import('fs').Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return undefined; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const nested = await findFile(full, pred);
      if (nested) return nested;
    } else if (e.isFile() && pred(e.name, full)) {
      return full;
    }
  }
  return undefined;
}

/** Locate a retrieved component in the throwaway project: the SAME basename as the
 *  local copy (source format's guarantee), and only if the whole tree has none, a
 *  `<leaf>.*` near-miss inside a folder of the same name.
 *
 *  Three walks, most-specific first, because ONE walk showed a different component's
 *  source with no hint anything was wrong:
 *    1. exact basename in a folder of the same name — the only pairing that is certain.
 *       Two EmailTemplates named `Welcome` in different folders (`Folder/Name` is the
 *       fullName, so that is legal) otherwise both resolve to whichever the readdir
 *       reached first.
 *    2. exact basename anywhere — kept so a retrieve nesting we didn't predict still
 *       pairs rather than reporting a present component absent.
 *    3. a `<leaf>.*` near-miss, folder-guarded. Unguarded it let a QuickAction
 *       `Widget__c.New_Widget` answer for a CustomTab `Widget__c`. */
async function findFileMatching(dir: string, exactBasename: string, leafName: string, folderName: string): Promise<string | undefined> {
  const inFolder = (full: string): boolean => path.basename(path.dirname(full)) === folderName;
  return await findFile(dir, (n, full) => n === exactBasename && inFolder(full))
    ?? await findFile(dir, n => n === exactBasename)
    ?? await findFile(dir, (n, full) => n.startsWith(leafName + '.') && inFolder(full));
}

/** Recursively find a file under `dir` whose absolute path ends with `suffixPath`
 *  (a relative path like `objects/Account/fields/Foo__c.field-meta.xml`). Used to
 *  locate a decomposed child inside the converted source tree without assuming the
 *  tree's root nesting, while still keying on the object + child folder. */
async function findFileBySuffix(dir: string, suffixPath: string): Promise<string | undefined> {
  return findFile(dir, (_n, full) => full === suffixPath || full.endsWith(path.sep + suffixPath));
}

/** Scaffold a throwaway SFDX project so a source-format retrieve has somewhere to
 *  land without touching the user's workspace. `sourceApiVersion` is deliberately
 *  omitted so the retrieve uses the org's max API version (what we want for a diff). */
async function scaffoldSourceProject(projDir: string): Promise<void> {
  await fs.mkdir(path.join(projDir, 'force-app'), { recursive: true });
  await fs.writeFile(
    path.join(projDir, 'sfdx-project.json'),
    JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], namespace: '' }, null, 2),
    'utf8'
  );
}

/** `item.name` can contain path separators (e.g. EmailTemplate `Folder/Name`) —
 *  flatten them so the staged file lands inside the staging dir, not a missing subdir. */
function safeStagedName(item: MetadataItem, srcBasename: string): string {
  return `${item.type}__${item.name}__${srcBasename}`.replace(/[\\/:]/g, '_');
}

/** Copy retrieved file into a dedicated diff-staging folder under tmpdir with a friendly name.
 *  Returns both the file path (for opening in diff) and the dir (so the caller can clean it up). */
async function stageDiffCopy(srcPath: string, item: MetadataItem): Promise<{ file: string; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-diff-stage-'));
  const dest = path.join(dir, safeStagedName(item, path.basename(srcPath)));
  await fs.copyFile(srcPath, dest);
  // Read-only so the org side of the diff can't be edited by mistake — edits there
  // would die with the temp dir. (Cleanup uses rm(force); a failure is swallowed,
  // worst case on Windows a staged file lingers until OS temp cleaning.)
  await fs.chmod(dest, 0o444);
  return { file: dest, dir };
}

/** Write org-side text (a tooling-query body) into a diff-staging file named like the
 *  local file so the diff editor gets the right syntax highlighting. */
async function stageDiffText(content: string, item: MetadataItem): Promise<{ file: string; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-diff-stage-'));
  const file = path.join(dir, safeStagedName(item, path.basename(item.filePath)));
  await fs.writeFile(file, content, 'utf8');
  await fs.chmod(file, 0o444); // read-only — see stageDiffCopy
  return { file, dir };
}

/** Clean up tmp folders once no visible editor still references any of them. */
function scheduleTmpCleanup(paths: string[]): void {
  if (paths.length === 0) return;
  const targets = paths.map(p => path.normalize(p));
  // Folded twin for the "still referenced?" test only — fs.rm below must run on
  // the ORIGINAL (unfolded) targets, since an editor's fsPath casing can differ
  // from the staged path's on Windows and a lowercased path would be the wrong
  // thing to delete.
  const foldedTargets = targets.map(t => foldPathKey(t));
  const cleanup = () => Promise.all(targets.map(t => fs.rm(t, { recursive: true, force: true }))).catch(() => undefined);

  let disposed = false;
  const disposable = vscode.window.onDidChangeVisibleTextEditors(editors => {
    if (disposed) return;
    const stillOpen = editors.some(e => {
      const ef = foldPathKey(e.document.uri.fsPath);
      return foldedTargets.some(t => ef.startsWith(t));
    });
    if (!stillOpen) {
      disposed = true;
      disposable.dispose();
      clearTimeout(hardCap);
      cleanup();
    }
  });
  const hardCap = setTimeout(() => {
    if (disposed) return;
    disposed = true;
    disposable.dispose();
    cleanup();
  }, 10 * 60_000);
}
