import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { OrgStore } from './orgStore';
import { DeployResult, DeployTestFailure, OrgInfo, OrgMember, RetrieveFileResult, RetrieveResult, SfCliCancelledError, SfCliError, SfCliService, TestLevel, stripAnsi } from './sfCliService';
import { isLikelyProduction } from './kit/orgs';
import { FolderRule, LearnedRule, MetadataItem, OBJECT_CHILD_TYPES, deriveRule, findItemForPath, inferItemForPath, parseManifestTypes, scanWorkspace } from './metadataScanner';
import { generateNonce, getPanelHtml } from './panelHtml';

type Inbound =
  | { type: 'ready' }
  | { type: 'refreshOrgs' }
  | { type: 'refreshFiles' }
  | { type: 'fetchOrgMetadata'; username?: string }
  | { type: 'selectOrg'; username: string }
  | { type: 'useActiveFile' }
  | { type: 'deploy'; keys: string[]; validateOnly?: boolean; testLevel?: TestLevel }
  | { type: 'setTestLevel'; testLevel?: TestLevel }
  | { type: 'quickDeploy'; jobId: string }
  | { type: 'retrieve'; keys: string[] }
  | { type: 'diff'; keys: string[] }
  | { type: 'openFile'; key: string }
  | { type: 'openInOrg'; keys: string[] }
  | { type: 'copyText'; text: string }
  | { type: 'refreshChanged' }
  | { type: 'cancel' };

// Minimal structural slice of the built-in vscode.git extension's API (v1) —
// just what change detection reads; no dependency on the full git.d.ts.
interface GitChangeLite { uri?: vscode.Uri }
interface GitRepoLite { state: { workingTreeChanges: GitChangeLite[]; indexChanges: GitChangeLite[] } }
interface GitApiLite { repositories: GitRepoLite[] }
interface GitExtensionLite { getAPI(version: 1): GitApiLite }

interface OrgPayload { username: string; alias?: string; label: string; kind: 'prod' | 'sandbox' | 'scratch' | 'other'; }

/** globalState key for folder→type rules learned from the sf CLI registry. */
const LEARNED_RULES_KEY = 'learnedTypeRules';
/** globalState key for folders whose type resolution failed — the negative cache
 *  (same TTL as learned rules). Without it every NEW session re-paid the serial
 *  30s-per-folder registry calls before a context-menu deploy could even confirm. */
const UNRESOLVABLE_KEY = 'unresolvableTypeFolders';

interface UnresolvableEntry { folder: string; at: number }

export class DeployPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'sfOrgDeployWrapper.panel';

  private view?: vscode.WebviewView;
  private orgs: OrgInfo[] = [];
  private items: MetadataItem[] = [];
  private workspaceRoot?: string;
  private busy = false;
  private currentCancel?: () => void;
  private currentAction?: string;
  private currentProgressText?: string;
  /** Async job id of the running deploy, once the org has accepted it. Lets Cancel
   *  ask the org to cancel the server-side deploy (not just kill the local process),
   *  and lets a validated deployment be quick-deployed. */
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
  /** First underlying CLI error from the latest type-resolution run — shown in
   *  the scan banner so wholesale failures name their cause in-panel. */
  private resolveErrorSample: string | undefined;
  private sfVersionLogged = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly orgStore: OrgStore,
    private readonly sf: SfCliService,
    private readonly output: vscode.OutputChannel
  ) {}

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
  }

  async deployFile(uri: vscode.Uri): Promise<void> { return this.runByUri(uri, 'deploy'); }
  async retrieveFile(uri: vscode.Uri): Promise<void> { return this.runByUri(uri, 'retrieve'); }
  async diffFile(uri: vscode.Uri): Promise<void> { return this.runByUri(uri, 'diff'); }

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

  private async runByUri(uri: vscode.Uri, action: 'deploy' | 'retrieve' | 'diff', orgOverride?: string): Promise<void> {
    if (!uri || !uri.fsPath) {
      vscode.window.showInformationMessage('No file selected.');
      return;
    }
    // Make sure the items list is fresh (the user may not have opened the panel
    // yet) — but with a FAST scan (static + learned rules only). Resolving
    // unknown folders via the CLI registry is the panel tree's concern; doing it
    // here stalled context-menu ops for up to 30s per unknown folder before the
    // confirm dialog could show. If the clicked file itself is in an unknown
    // folder, resolveItemViaCli below resolves just that one file. When a full
    // scan is already running (panel opening in parallel), share it instead.
    if (this.items.length === 0) {
      if (this.loadFilesInflight) await this.loadFilesInflight;
      else {
        const scan = await scanWorkspace(this.learnedRules());
        this.items = scan.items;
        this.workspaceRoot = scan.root;
      }
    }
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
    if (action === 'deploy') return this.runDeploy([key], { sourceDir });
    if (action === 'retrieve') return this.runRetrieve([key], { sourceDir });
    return this.runDiff([key], orgOverride);
  }

  // ---- Message routing ----
  private async handleMessage(msg: Inbound): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await Promise.all([this.loadOrgs(), this.loadFiles()]);
        this.sendActiveFile();
        // Re-sync busy state so a webview recreated mid-operation (e.g. after the
        // sidebar was collapsed) doesn't show enabled buttons during a running op.
        this.post({ type: 'busy', busy: this.busy, action: this.currentAction });
        if (this.busy && this.currentProgressText) this.post({ type: 'progress', text: this.currentProgressText });
        // Restore the test-level select after a webview rebuild — the provider is
        // the source of truth so a collapsed/reopened panel can't silently diverge.
        this.post({ type: 'testLevel', value: this.testLevel ?? '' });
        // Replay the last result card into a freshly-built webview, so opening
        // the panel after a context-menu operation shows its outcome.
        if (this.lastStatusCard) this.post(this.lastStatusCard);
        return;
      case 'setTestLevel':
        this.testLevel = msg.testLevel;
        return;
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
      case 'deploy':
        await this.runDeploy(msg.keys, { validateOnly: msg.validateOnly, testLevel: msg.testLevel });
        return;
      case 'quickDeploy':
        await this.runQuickDeploy(msg.jobId);
        return;
      case 'retrieve':
        await this.runRetrieve(msg.keys);
        return;
      case 'diff':
        await this.runDiff(msg.keys);
        return;
      case 'openFile': {
        const it = this.resolveKeys([msg.key])[0];
        if (!it?.filePath) {
          vscode.window.showInformationMessage('Org-only — retrieve it first to open it locally.');
          return;
        }
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(it.filePath), { preview: true });
        return;
      }
      case 'openInOrg':
        await this.openComponentInOrg(msg.keys?.[0]);
        return;
      case 'refreshChanged':
        await this.postChangedComponents();
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
   * Cancel the running operation. Kills the local `sf` process, then — if a
   * deploy has already been accepted by the org (we have its job id) — asks the
   * org to cancel the server-side deploy too, so "Deploy cancelled" isn't a false
   * safety signal on a PROD flow. If the deploy hasn't reached the org
   * yet (no job id), killing the local process is enough.
   */
  private cancelCurrent(): void {
    const jobId = this.currentDeployJobId;
    const org = this.currentDeployOrg;
    if (this.currentCancel) this.currentCancel();
    if (jobId && org) {
      const root = this.workspaceRoot;
      // Best-effort, out of band: the local kill already rejected the op.
      void (async () => {
        try {
          await this.sf.deployCancel(jobId, org, root ?? process.cwd());
          this.output.appendLine(`[Cancel] requested org-side cancel of deploy ${jobId} on ${org}`);
        } catch (e) {
          this.output.appendLine(`[Cancel] org-side deploy cancel failed for ${jobId}: ${e instanceof Error ? e.message : String(e)}. The deploy may still complete on the org.`);
        }
      })();
    }
  }

  // ---- Loaders ----
  private async loadOrgs(notify = false): Promise<void> {
    try {
      this.orgs = await this.sf.listOrgs();
    } catch (err) {
      // One env line so a "works in terminal, fails in panel" report is
      // diagnosable from the log alone (extension-host PATH ≠ shell PATH).
      this.output.appendLine(`[list orgs] diag cwd=${this.workspaceRoot ?? process.cwd()} PATH=${(process.env.PATH ?? '').split(':').slice(0, 6).join(':')}`);
      const msg = stripAnsi(err instanceof Error ? err.message : String(err)).trim();
      const hint = hintForError(err);
      // The banner carries the real reason — "see output channel" alone strands
      // users who don't know where that is. reportError adds the error card in
      // the panel, the output-channel line, and a toast whose button OPENS the
      // channel; broken org listing means a dead panel, so loud is correct even
      // on the automatic load at startup.
      this.post({ type: 'banner', message: `Failed to list orgs: ${msg}${hint ? ` — ${hint}` : ''}` });
      this.reportError('List orgs', err);
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
    return this.context.globalState.get<LearnedRule[]>(LEARNED_RULES_KEY, []).filter(r => r.learnedAt >= cutoff);
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
      this.unresolvableFolders = new Set(kept.map(e => e.folder));
    }
    return this.unresolvableFolders;
  }

  private markUnresolvable(folder: string): void {
    this.unresolvable().add(folder);
    const days = this.typeCacheDays();
    if (days <= 0) return;
    const next = this.readUnresolvableEntries(Date.now() - days * 86_400_000).filter(e => e.folder !== folder);
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

  private loadFiles(): Promise<void> {
    return this.loadFilesInflight ??= this.doLoadFiles().finally(() => { this.loadFilesInflight = undefined; });
  }

  private async doLoadFiles(): Promise<void> {
    let scan = await scanWorkspace(this.learnedRules());
    // Folders no rule covers: resolve their types via the CLI registry, then
    // rescan so they land in the tree. Learned rules AND failures persist, so
    // this spawns `sf` only for genuinely new folders (or after cache expiry).
    const pending = scan.unknownFolders.filter(f => !this.unresolvable().has(f));
    let resolveFailures: string[] = [];
    if (pending.length && scan.root) {
      const scanRoot = scan.root;
      // Under window progress — this spawns `sf` (30s timeout per folder) and
      // would otherwise stall the tree with zero feedback on panel open/refresh.
      const fresh = await this.withWindowProgress('Resolving metadata types (sf registry)', () => this.learnRulesForFolders(pending, scanRoot));
      // Fresh rules are passed directly (not just via the cache) so the rescan
      // sees them even with typeCacheDays 0.
      if (fresh.length) scan = await scanWorkspace([...this.learnedRules(), ...fresh]);
      resolveFailures = pending.filter(f => this.unresolvable().has(f)).map(f => path.basename(f));
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
    this.post({
      type: 'files',
      objectChildTypes: [...OBJECT_CHILD_TYPES],
      items: items.map(i => ({
        type: i.type,
        name: i.name,
        filePath: i.filePath,
        files: i.files
      }))
    });
    // Keep the "Changed" view honest against the fresh item list. Fire-and-forget:
    // the method never throws, and the tree must not wait on git.
    void this.postChangedComponents();
  }

  private changedRefreshTimer?: ReturnType<typeof setTimeout>;

  private scheduleChangedRefresh(): void {
    if (this.changedRefreshTimer) clearTimeout(this.changedRefreshTimer);
    this.changedRefreshTimer = setTimeout(() => { void this.postChangedComponents(); }, 500);
  }

  /** Compute which local components have uncommitted git changes (working tree +
   *  index — includes untracked files, i.e. brand-new components) via the built-in
   *  vscode.git extension, and post their keys for the "Changed" view. Posts
   *  `keys: null` with a reason when git can't answer, so the view says why
   *  instead of showing a false "no changes". Never throws. */
  private async postChangedComponents(): Promise<void> {
    try {
      const gitExt = vscode.extensions.getExtension<GitExtensionLite>('vscode.git');
      if (!gitExt) {
        this.post({ type: 'changed', keys: null, reason: 'Change detection unavailable — VS Code git extension is disabled.' });
        return;
      }
      const api = (gitExt.isActive ? gitExt.exports : await gitExt.activate()).getAPI(1);
      if (api.repositories.length === 0) {
        this.post({ type: 'changed', keys: null, reason: 'Change detection unavailable — workspace is not a git repository.' });
        return;
      }
      // A pathological repo can report tens of thousands of changed paths
      // (untracked count too), and per-path findItemForPath scans would be
      // O(paths × items) on the extension-host thread. Precompute lookup maps
      // once — same matching (exact primary file > listed file > containing
      // bundle folder, via ancestor walk) at O(items + paths).
      const byPrimary = new Map<string, string>();
      const byFile = new Map<string, string>();
      const byDir = new Map<string, string>();
      for (const item of this.items) {
        const key = `${item.type}:${item.name}`;
        if (item.filePath) {
          const p = path.normalize(item.filePath);
          if (!byPrimary.has(p)) byPrimary.set(p, key);
          if (!byDir.has(p)) byDir.set(p, key); // bundles: filePath is the folder
        }
        for (const f of item.files) {
          const p = path.normalize(f);
          if (!byFile.has(p)) byFile.set(p, key);
        }
      }
      const seen = new Set<string>();
      const keys = new Set<string>();
      for (const repo of api.repositories) {
        for (const change of [...repo.state.workingTreeChanges, ...repo.state.indexChanges]) {
          const fsPath = change.uri?.fsPath;
          if (!fsPath) continue;
          const p = path.normalize(fsPath);
          if (seen.has(p)) continue; // a staged+modified file appears in both lists
          seen.add(p);
          let key = byPrimary.get(p) ?? byFile.get(p);
          for (let dir = path.dirname(p); !key; ) {
            key = byDir.get(dir);
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
          }
          if (key) keys.add(key);
        }
      }
      this.post({ type: 'changed', keys: [...keys] });
    } catch (err) {
      this.output.appendLine(`[changed] git change detection failed: ${err instanceof Error ? err.message : String(err)}`);
      this.post({ type: 'changed', keys: null, reason: 'Change detection failed — see the output channel.' });
    }
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

  // ---- Operations ----
  private async runDeploy(
    keys: string[],
    opts: { sourceDir?: string; validateOnly?: boolean; testLevel?: TestLevel } = {}
  ): Promise<void> {
    // Reserve the busy slot synchronously, before the first await (the confirm
    // modal): otherwise a second deploy/retrieve/diff fired during the modal
    // passes the entry check and two ops run at once, clobbering currentCancel and
    // re-enabling the UI mid-op (busy-flag TOCTOU). Release on any early
    // return with `releaseBusy()`.
    if (!this.reserveBusy(opts.validateOnly ? 'Validate' : 'Deploy')) return;
    let reserved = true;
    const releaseBusy = (): void => { if (reserved) { reserved = false; this.setBusy(false); } };
    try {
      const root = this.requireRoot();
      if (!root) return;
      const org = this.requireOrg();
      if (!org) return;
      const allResolved = this.resolveKeys(keys);
      const orgOnlySkipped = allResolved.filter(i => !i.filePath);
      const items = allResolved.filter(i => !!i.filePath);
      if (items.length === 0) {
        vscode.window.showInformationMessage('Selected component(s) have no local source — retrieve them first before deploying.');
        return;
      }

      const orgInfo = this.orgs.find(o => o.username === org);
      const orgLabel = orgInfo?.alias ?? org;
      // Kit classification: an unknown/unloaded org counts as PRODUCTION (over-warn).
      const isProd = isLikelyProduction(orgInfo);
      const n = items.length;
      const noun = `${n} component${n === 1 ? '' : 's'}`;
      const verb = opts.validateOnly ? 'Validate' : 'Deploy';
      // Production defaults to running local tests (the org requires them anyway);
      // sandbox defaults to no tests. Validate-only always runs tests, so force at
      // least RunLocalTests there.
      const testLevel: TestLevel = opts.testLevel
        ?? this.testLevel
        ?? (opts.validateOnly || isProd ? 'RunLocalTests' : 'NoTestRun');
      const testNote = testLevel === 'NoTestRun' ? '' : `\n\nTests: ${testLevel}`;

      const confirmLabel = opts.validateOnly ? 'Validate' : (isProd ? 'Deploy to PROD' : 'Deploy');
      const confirm = isProd && !opts.validateOnly
        ? await vscode.window.showWarningMessage(
            `⚠ Deploy ${noun} to PRODUCTION (${orgLabel})?\n\nThis change will be live immediately.${testNote}`,
            { modal: true, detail: orgInfo?.instanceUrl ?? '' },
            confirmLabel
          )
        : await vscode.window.showWarningMessage(
            opts.validateOnly
              ? `Validate ${noun} against ${orgLabel}? (check-only — nothing is deployed)${testNote}`
              : `Deploy ${noun} to ${orgLabel}?${testNote}`,
            { modal: true, ...(isProd ? { detail: orgInfo?.instanceUrl ?? '' } : {}) },
            confirmLabel
          );
      if (!confirm) return;

      const ignoreConflicts = vscode.workspace
        .getConfiguration('sfOrgDeployWrapper')
        .get<boolean>('ignoreDeployConflicts', false);
      const testArg = testLevel !== 'NoTestRun' ? ` --test-level ${testLevel}` : '';

      const cmdId = this.beginCmd(`sf project deploy ${opts.validateOnly ? 'validate' : 'start'} ${this.targetArg(opts.sourceDir, items)} --target-org ${org}${ignoreConflicts ? ' --ignore-conflicts' : ''}${testArg}`);
      // From here the async work runs under the reserved slot; the finally block
      // owns releasing it, so stop the early-return releaser from double-firing.
      reserved = false;
      const start = Date.now();
      const progressTitle = opts.validateOnly ? `Validating ${noun} against ${orgLabel}` : `Deploying ${noun} to ${orgLabel}`;
      try {
        await this.withWindowProgress(progressTitle, async () => {
          this.postProgress(`${progressTitle}…`);
          const handle = this.sf.deployMetadata(
            items.map(i => `${i.type}:${i.name}`),
            org,
            root,
            {
              ignoreConflicts,
              timeoutMs: this.timeoutMs(),
              sourceDirs: opts.sourceDir ? [opts.sourceDir] : undefined,
              validateOnly: opts.validateOnly,
              testLevel: testLevel === 'NoTestRun' ? undefined : testLevel
            }
          );
          this.currentCancel = handle.cancel;
          this.currentDeployOrg = org;
          const { result, cmd } = await handle.promise;
          // Capture the job id so Cancel can reach the org-side deploy and a
          // validated deployment can be quick-deployed.
          this.currentDeployJobId = result.id;
          this.updateCmd(cmdId, cmd);
          this.reportDeployResult(result, {
            items, orgOnlySkipped, orgLabel, org, noun, cmdId, start,
            validateOnly: !!opts.validateOnly
          });
        });
      } catch (err) {
        this.endCmd(cmdId, false, Date.now() - start);
        if (err instanceof SfCliCancelledError) {
          this.reportCancelled(verb, this.currentDeployJobId
            ? 'Asked the org to cancel the server-side deploy.'
            : 'The org-side deploy may still complete — check the org.');
        } else this.reportError(verb, err);
      } finally {
        this.currentCancel = undefined;
        this.currentDeployJobId = undefined;
        this.currentDeployOrg = undefined;
        this.setBusy(false);
      }
    } finally {
      releaseBusy();
    }
  }

  /** Render the status card for a completed deploy/validate, including Apex test
   *  failures (surfaced when a test-level ran) and a Quick Deploy affordance for a
   *  successful validation. */
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
    }
  ): void {
    const { items, orgOnlySkipped, orgLabel, org, cmdId, start, validateOnly } = ctx;
    // Per-component results live under `details.*` on older `sf` output and under
    // `files` on newer output — read both so failures are never silently dropped
    // (and the success gate accounts for both).
    const detailFailures = result.details?.componentFailures ?? [];
    const detailSuccesses = result.details?.componentSuccesses ?? [];
    const fileFailures = (result.files ?? []).filter(f => f.state === 'Failed' || !!f.problem);
    const fileSuccesses = (result.files ?? []).filter(f => f.state && f.state !== 'Failed' && !f.problem);
    const failures = detailFailures.length ? detailFailures : fileFailures;
    const successes = detailSuccesses.length ? detailSuccesses : fileSuccesses;
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
      this.post({
        type: 'status',
        card: {
          kind: orgOnlySkipped.length > 0 ? 'warn' : 'ok',
          title: validateOnly
            ? `Validated ${items.length} component${items.length === 1 ? '' : 's'} against ${orgLabel}`
            : `Deployed ${items.length} component${items.length === 1 ? '' : 's'} to ${orgLabel}`,
          meta: `${result.numberComponentsDeployed ?? successes.length}/${result.numberComponentsTotal ?? items.length} succeeded${testMeta}${orgOnlySkipped.length > 0 ? ` · ${orgOnlySkipped.length} skipped` : ''}`,
          lines: [...lines, ...skipLines],
          ...(validateOnly && result.id
            ? { quickDeploy: { jobId: result.id, label: `Quick Deploy ${items.length} validated component${items.length === 1 ? '' : 's'} to ${orgLabel}` } }
            : {})
        }
      });
      this.notifySuccessIfPanelHidden(validateOnly ? `Validated ${ctx.noun} against ${orgLabel}` : `Deployed ${ctx.noun} to ${orgLabel}`);
    } else {
      const errLines = failures.length
        ? failures.map(f => `${f.type}:${f.fullName} — ${f.problem ?? 'failed'}${f.lineNumber ? ` (line ${f.lineNumber})` : ''}`)
        : (testFailures.length ? [] : ['Deploy reported failure with no per-component details.']);
      const testLines = testFailures.map(t =>
        `✗ test ${t.name ?? '?'}.${t.methodName ?? '?'} — ${stripAnsi(t.message ?? 'failed').split('\n')[0]}`
      );
      this.post({
        type: 'status',
        card: {
          kind: 'err',
          title: validateOnly ? `Validation failed against ${orgLabel}` : `Deploy failed against ${orgLabel}`,
          meta: `${failures.length} component failure${failures.length === 1 ? '' : 's'}, ${successes.length} success${testFailures.length ? ` · ${testFailures.length} test failure${testFailures.length === 1 ? '' : 's'}` : ''}`,
          lines: [...errLines, ...testLines, ...skipLines]
        }
      });
      this.failureToast(
        `${validateOnly ? 'Validation' : 'Deploy'} failed against ${orgLabel} — ${failures.length ? `${failures.length} component failure${failures.length === 1 ? '' : 's'}` : `${testFailures.length} test failure${testFailures.length === 1 ? '' : 's'}`}.`,
        [...errLines, ...testLines]
      );
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
      try {
        await this.withWindowProgress(`Quick-deploying to ${orgLabel}`, async () => {
          this.postProgress(`Quick-deploying validated components to ${orgLabel}…`);
          const handle = this.sf.quickDeploy(jobId, org, root, { timeoutMs: this.timeoutMs() });
          this.currentCancel = handle.cancel;
          this.currentDeployOrg = org;
          const { result, cmd } = await handle.promise;
          this.currentDeployJobId = result.id ?? jobId;
          this.updateCmd(cmdId, cmd);
          // The quick deploy consumes the validation — clear it either way.
          this.lastValidated = undefined;
          const noun = `${validated.count} component${validated.count === 1 ? '' : 's'}`;
          this.endCmd(cmdId, !!result.success, Date.now() - start);
          if (result.success) {
            this.post({
              type: 'status',
              card: {
                kind: 'ok',
                title: `Quick-deployed ${noun} to ${orgLabel}`,
                meta: `${result.numberComponentsDeployed ?? validated.count} deployed`
              }
            });
            this.notifySuccessIfPanelHidden(`Quick-deployed ${noun} to ${orgLabel}`);
          } else {
            const failures = result.details?.componentFailures
              ?? (result.files ?? []).filter(f => f.state === 'Failed' || !!f.problem);
            const failLines = failures.map(f => `${f.type}:${f.fullName} — ${f.problem ?? 'failed'}`);
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
        });
      } catch (err) {
        this.endCmd(cmdId, false, Date.now() - start);
        if (err instanceof SfCliCancelledError) {
          this.reportCancelled('Deploy', this.currentDeployJobId
            ? 'Asked the org to cancel the server-side deploy.'
            : 'The org-side deploy may still complete — check the org.');
        } else this.reportError('Quick Deploy', err);
      } finally {
        this.currentCancel = undefined;
        this.currentDeployJobId = undefined;
        this.currentDeployOrg = undefined;
        this.setBusy(false);
      }
    } finally {
      if (reserved) this.setBusy(false);
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
        const ok = files.filter(f => !f.problem && (f.state === undefined || f.state !== 'Failed'));
        const failed = files.filter(f => f.problem || f.state === 'Failed');
        const missing = items.filter(i => !files.some(f => f.fullName === i.name && f.type === i.type));
        // Org-level messages (e.g. "entity of type X named Y cannot be found")
        // explain an empty result better than the bare missing list — surface them.
        const msgLines = (result.messages ?? []).filter(m => m.problem).map(m => `${m.fileName ?? '?'}: ${m.problem}`);
        this.endCmd(cmdId, failed.length === 0 && ok.length > 0, Date.now() - start);

        if (failed.length === 0 && ok.length > 0 && missing.length === 0) {
          this.post({
            type: 'status',
            card: {
              kind: 'ok',
              title: `Retrieved ${ok.length} component${ok.length === 1 ? '' : 's'} from ${orgLabel}`,
              lines: ok.map(f => `${f.type}:${f.fullName}`)
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
        } else {
          const lines: string[] = [];
          for (const f of ok) lines.push(`✓ ${f.type}:${f.fullName}`);
          for (const f of failed) lines.push(`✗ ${f.type}:${f.fullName} — ${f.problem ?? 'failed'}`);
          for (const m of missing) lines.push(`— ${m.type}:${m.name} — not on org`);
          lines.push(...msgLines);
          this.post({
            type: 'status',
            card: {
              kind: failed.length > 0 ? 'err' : 'warn',
              title: `Retrieve from ${orgLabel} completed with issues`,
              meta: `${ok.length} ok · ${failed.length} failed · ${missing.length} missing`,
              lines
            }
          });
          if (failed.length > 0) this.failureToast(`Retrieve from ${orgLabel}: ${failed.length} component${failed.length === 1 ? '' : 's'} failed.`, lines);
        }
        // refresh workspace scan (file count badges etc.)
        this.loadFiles().catch(() => undefined);
        });
      } catch (err) {
        this.endCmd(cmdId, false, Date.now() - start);
        if (err instanceof SfCliCancelledError) this.reportCancelled('Retrieve');
        else this.reportError('Retrieve', err);
      } finally {
        this.currentCancel = undefined;
        this.setBusy(false);
      }
    } finally {
      releaseBusy();
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
      await this.sf.openInOrg(item.filePath, org, root);
      this.endCmd(cmdId, true, Date.now() - start);
    } catch (err) {
      this.endCmd(cmdId, false, Date.now() - start);
      this.reportError('Open in Org', err);
    }
  }

  private async runDiff(keys: string[], orgOverride?: string): Promise<void> {
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

      // Partition into diffable vs unsupported metadata types.
      const diffable = withLocalFile.filter(i => !DIFF_UNSUPPORTED.has(i.type));
      const unsupported = withLocalFile.filter(i => DIFF_UNSUPPORTED.has(i.type));
      const preLines: string[] = [
        ...unsupported.map(i => `— ${i.type}:${i.name} — diff not supported for this metadata type yet`),
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

        // When floating is on, open every diff into ONE dedicated editor group
        // beside the user's tabs (first diff → Beside, rest → Active land in that
        // same new group). Moving *that* group to a new window then carries only
        // the diffs — never the user's pre-existing open tabs.
        const floatDiff = vscode.workspace
          .getConfiguration('sfOrgDeployWrapper')
          .get<boolean>('openDiffInFloatingWindow', true);
        const diffColumn = (): vscode.ViewColumn | undefined =>
          floatDiff ? (opened.length === 0 ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active) : undefined;

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
          for (const [type, arr] of byType) {
            const field = FAST_DIFF_FIELD[type];
            const inList = arr.map(i => `'${i.name.replace(/'/g, "\\'")}'`).join(', ');
            const soql = `SELECT Name, NamespacePrefix, ${field} FROM ${type} WHERE Name IN (${inList})`;
            const qStart = Date.now();
            const qCmdId = this.beginCmd(`sf data query --use-tooling-api --target-org ${org} --query "${soql}"`);
            try {
              const q = this.sf.queryTooling<ToolingCodeRecord>(soql, org, root, { timeoutMs: this.timeoutMs() });
              this.currentCancel = q.cancel;
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
              }
            } catch (e) {
              this.endCmd(qCmdId, false, Date.now() - qStart);
              if (e instanceof SfCliCancelledError) throw e;
              this.output.appendLine(`[Diff] Tooling query for ${type} failed — falling back to retrieve: ${e instanceof Error ? e.message : String(e)}`);
              slowItems.push(...arr);
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
            if (isChild) {
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
              remoteFile = await findFileMatching(proj, localBasename, leaf);
            }
            if (!remoteFile) {
              missing.push(item);
              continue;
            }
            const staged = await stageDiffCopy(remoteFile, item);
            tmpPaths.push(staged.dir);
            await this.openDiff(item, staged.file, orgLabel, diffColumn());
            opened.push(`${item.type}:${item.name}`);
          }
        }

        if (opened.length > 0 && floatDiff) {
          // The diffs opened into a dedicated group beside the user's tabs (see
          // diffColumn above), so that group is now active and holds ONLY the diffs.
          // Pop it into its own OS window — the user's original tabs stay put. No
          // setTimeout tick: vscode.diff is awaited so the diff editor is already active.
          await Promise.resolve(
            vscode.commands.executeCommand('workbench.action.moveEditorGroupToNewWindow')
          ).then(undefined, (e) => this.output.appendLine(`[Diff] float failed: ${String(e)}`));
        }

        const lines: string[] = [];
        for (const k of opened) lines.push(`✓ opened diff: ${k}`);
        for (const m of missing) lines.push(`— ${m.type}:${m.name} — not on org`);
        for (const e of errors) lines.push(`✗ ${e}`);
        for (const w of preLines) lines.push(w);

        const kind = errors.length > 0 ? 'err' : ((missing.length > 0 || unsupported.length > 0) ? 'warn' : 'ok');
        this.post({
          type: 'status',
          card: {
            kind,
            title: opened.length > 0
              ? `Diff opened for ${opened.length} component${opened.length === 1 ? '' : 's'}`
              : (missing.length === items.length ? `Nothing to diff — not on ${orgLabel}` : `Diff completed with issues`),
            meta: `${opened.length} opened · ${missing.length} missing · ${errors.length} errors${unsupported.length ? ` · ${unsupported.length} unsupported` : ''}`,
            lines
          }
        });
      });
      } catch (err) {
        if (err instanceof SfCliCancelledError) this.reportCancelled('Diff');
        else this.reportError('Diff', err);
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
        const tasks: Array<{ type: string; label: string; folder?: string }> = [];
        for (const type of FETCH_ORG_TYPES) {
          if (type === 'EmailTemplate') continue;
          tasks.push({ type, label: type });
        }
        if (FETCH_ORG_TYPES.includes('EmailTemplate')) {
          try {
            const fh = this.sf.listMetadata('EmailTemplateFolder', org, root, { timeoutMs });
            activeCancels.add(fh.cancel);
            const { members } = await fh.promise;
            activeCancels.delete(fh.cancel);
            for (const f of members) {
              if (f.fullName) tasks.push({ type: 'EmailTemplate', label: `EmailTemplate (${f.fullName})`, folder: f.fullName });
            }
          } catch (err) {
            if (fetchCancelled || err instanceof SfCliCancelledError) throw err;
            failures.push({ label: 'EmailTemplateFolder', err });
            this.output.appendLine(`[Fetch Org] EmailTemplateFolder: ${err instanceof Error ? err.message : String(err)}`);
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
    return vscode.workspace.getConfiguration('sfOrgDeployWrapper').get<number>('commandTimeoutMs', 180_000);
  }

  private setBusy(b: boolean, action?: string): void {
    this.busy = b;
    this.currentAction = b ? action : undefined;
    if (!b) this.currentProgressText = undefined;
    this.post({ type: 'busy', busy: b, action: this.currentAction });
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
      vscode.window.showInformationMessage(this.currentAction
        ? `${this.currentAction} is already running — cancel it from the panel or wait for it to finish.`
        : 'Another operation is already running.');
      return false;
    }
    this.setBusy(true, action);
    return true;
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

  /** Visible success confirmation when the panel isn't open — e.g. a deploy/retrieve
   *  fired from the Explorer or editor right-click menu, where the result card would
   *  otherwise land in a hidden webview and read as "no feedback". Mirrors the error
   *  path's notification + action button; offers to open the panel for the details. */
  private notifySuccessIfPanelHidden(message: string): void {
    if (this.view?.visible) return;
    vscode.window.setStatusBarMessage(`$(check) ${message}`, 8000);
    vscode.window.showInformationMessage(`SF Deploy: ${message}`, 'Show Panel').then(choice => {
      if (choice === 'Show Panel') {
        vscode.commands.executeCommand('sfOrgDeployWrapper.panel.focus');
      }
    });
  }

  private async openDiff(item: MetadataItem, remoteFile: string, orgLabel: string, viewColumn?: vscode.ViewColumn): Promise<void> {
    // Org copy LEFT (read-only staged temp), local file RIGHT (the editable side) —
    // matches git / the official Salesforce extension, and makes the diff editor's
    // copy-block arrows pull org changes INTO the local file. The reverse order made
    // the arrows "copy" local blocks into a doomed temp file that never reaches the
    // org (deploy is the only upload path).
    const title = `${item.type}:${item.name} — ${orgLabel} ↔ Local`;
    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(remoteFile), vscode.Uri.file(item.filePath), title, { preview: false, viewColumn });
  }

  private reportCancelled(action: string, note?: string): void {
    this.post({
      type: 'status',
      card: { kind: 'warn', title: `${action} cancelled`, ...(note ? { meta: note } : {}) }
    });
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

  /** Latest status card, retained so a panel opened AFTER an operation (e.g. a
   *  context-menu deploy that failed with the sidebar closed) still shows the
   *  result — posting into a closed webview is a silent no-op, and the "Show
   *  Panel" toast button would otherwise open an empty panel. */
  private lastStatusCard?: unknown;

  private post(msg: unknown): void {
    const m = msg as { type?: string; card?: unknown } | null;
    if (m?.type === 'status' && m.card) this.lastStatusCard = msg;
    this.view?.webview.postMessage(msg);
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
  private failureToast(message: string, detailLines: string[] = []): void {
    // The panel's status card is the detailed record — the toast points there
    // first. The details are ALSO mirrored into the output channel: result-level
    // failures previously wrote nothing to it, which made "Show Output" open a
    // log that never mentioned the failure.
    this.output.appendLine(`[result] ${message}`);
    // Failure lines are org-controlled text — flatten control chars so a hostile
    // org can't forge extra "[result] …" lines or splatter ANSI into the log.
    for (const line of detailLines) this.output.appendLine(`  ${stripAnsi(line).replace(/[\x00-\x1f\x7f]/g, ' ')}`);
    void vscode.window.showErrorMessage(`SF Deploy: ${message}`, 'Show Panel', 'Show Output').then(choice => {
      if (choice === 'Show Panel') void vscode.commands.executeCommand('sfOrgDeployWrapper.panel.focus');
      if (choice === 'Show Output') this.output.show(true);
    });
  }

  private reportError(action: string, err: unknown): void {
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
    vscode.window.showErrorMessage(`SF Deploy: ${action} failed. ${message}`, 'Show Panel', 'Show Output').then(choice => {
      if (choice === 'Show Panel') void vscode.commands.executeCommand('sfOrgDeployWrapper.panel.focus');
      if (choice === 'Show Output') this.output.show(true);
    });
  }
}

// ---- module-local helpers ----

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
];

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
 *  making `vscode.diff` against the local source-format file misleading. */
const DIFF_UNSUPPORTED = new Set<string>(['CustomObject', 'LightningComponentBundle', 'AuraDefinitionBundle', 'StaticResource']);

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

/** A fetch error that would affect every metadata type (expired auth, wrong/missing
 *  org, network) rather than being specific to one type. Used to decide whether a
 *  Fetch Org with zero results is a genuine failure vs a legitimately empty org. */
function isFatalFetchError(err: unknown): boolean {
  const name = err instanceof SfCliError ? err.errorName ?? '' : '';
  const message = err instanceof Error ? err.message : String(err);
  const txt = `${name} ${message}`.toLowerCase();
  return /nodefaultenv|namedorgnotfound|noauthinfofound|invalid_grant|expired|refreshtokenauth|enotfound|getaddrinfo|econnrefused|econnreset|etimedout|socket hang up|timed out/.test(txt);
}

/** Map well-known sf CLI failures to a one-line actionable hint for the error card. */
function hintForError(err: unknown): string | undefined {
  const name = err instanceof SfCliError ? err.errorName ?? '' : '';
  const message = err instanceof Error ? err.message : String(err);
  const txt = `${name} ${message}`.toLowerCase();
  if (txt.includes('conflict')) {
    return 'The org has changes that conflict with your local files — retrieve them first, or enable sfOrgDeployWrapper.ignoreDeployConflicts.';
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
async function findFileMatching(dir: string, exactBasename: string, leafName: string): Promise<string | undefined> {
  let entries: import('fs').Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return undefined; }
  let prefixHit: string | undefined;
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const nested = await findFileMatching(full, exactBasename, leafName);
      if (nested) return nested;
    } else if (e.isFile()) {
      if (e.name === exactBasename) return full;
      if (!prefixHit && e.name.startsWith(leafName + '.')) prefixHit = full;
    }
  }
  return prefixHit;
}

/** Recursively find a file under `dir` whose absolute path ends with `suffixPath`
 *  (a relative path like `objects/Account/fields/Foo__c.field-meta.xml`). Used to
 *  locate a decomposed child inside the converted source tree without assuming the
 *  tree's root nesting, while still keying on the object + child folder. */
async function findFileBySuffix(dir: string, suffixPath: string): Promise<string | undefined> {
  let entries: import('fs').Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return undefined; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const nested = await findFileBySuffix(full, suffixPath);
      if (nested) return nested;
    } else if (e.isFile() && (full === suffixPath || full.endsWith(path.sep + suffixPath))) {
      return full;
    }
  }
  return undefined;
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
  const cleanup = () => Promise.all(targets.map(t => fs.rm(t, { recursive: true, force: true }))).catch(() => undefined);

  let disposed = false;
  const disposable = vscode.window.onDidChangeVisibleTextEditors(editors => {
    if (disposed) return;
    const stillOpen = editors.some(e => targets.some(t => path.normalize(e.document.uri.fsPath).startsWith(t)));
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
