import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { OrgStore } from './orgStore';
import { OrgInfo, OrgMember, RetrieveFileResult, RetrieveResult, SfCliCancelledError, SfCliError, SfCliService, stripAnsi } from './sfCliService';
import { MetadataItem, OBJECT_CHILD_TYPES, findItemForPath, scanWorkspace } from './metadataScanner';
import { generateNonce, getPanelHtml } from './panelHtml';

type Inbound =
  | { type: 'ready' }
  | { type: 'refreshOrgs' }
  | { type: 'refreshFiles' }
  | { type: 'fetchOrgMetadata' }
  | { type: 'selectOrg'; username: string }
  | { type: 'useActiveFile' }
  | { type: 'deploy'; keys: string[] }
  | { type: 'retrieve'; keys: string[] }
  | { type: 'diff'; keys: string[] }
  | { type: 'copyText'; text: string }
  | { type: 'cancel' };

interface OrgPayload { username: string; alias?: string; label: string; kind: 'prod' | 'sandbox' | 'scratch' | 'other'; }

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
  /** Keys ("Type:Name") of metadata components that exist on the currently-selected org. */
  private orgMembers = new Map<string, true>();
  /** The org username `orgMembers` was fetched from — guards against using a stale
   *  membership map after the user switches the target org. */
  private orgMembersOrg?: string;

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
    view.webview.onDidReceiveMessage((m: Inbound) => this.handleMessage(m));
    const editorChangeSub = vscode.window.onDidChangeActiveTextEditor(() => this.sendActiveFile());
    view.onDidDispose(() => { editorChangeSub.dispose(); this.view = undefined; });
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
    // Make sure the items list is fresh (the user may not have opened the panel yet).
    if (this.items.length === 0) await this.loadFiles();
    // Load orgs too so the production guard can classify the target on deploys
    // initiated from the explorer/editor context menu (panel may never have opened).
    if (this.orgs.length === 0) await this.loadOrgs();
    const match = findItemForPath(this.items, uri.fsPath);
    if (!match) {
      vscode.window.showInformationMessage('Not a recognized metadata source under workspace package directories.');
      return;
    }
    const key = `${match.type}:${match.name}`;
    if (action === 'deploy') return this.runDeploy([key]);
    if (action === 'retrieve') return this.runRetrieve([key]);
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
        return;
      case 'refreshOrgs':
        await this.loadOrgs(true);
        return;
      case 'refreshFiles':
        await this.loadFiles();
        return;
      case 'fetchOrgMetadata':
        await this.loadOrgMetadata();
        return;
      case 'selectOrg': {
        const nextOrg = msg.username || undefined;
        await this.orgStore.set(nextOrg);
        // Switching target org invalidates any fetched org-membership data.
        if (this.orgMembersOrg && nextOrg !== this.orgMembersOrg) this.resetOrgMetadata();
        this.postOrgs();
        return;
      }
      case 'useActiveFile':
        this.sendActiveFile(true, true);
        return;
      case 'deploy':
        await this.runDeploy(msg.keys);
        return;
      case 'retrieve':
        await this.runRetrieve(msg.keys);
        return;
      case 'diff':
        await this.runDiff(msg.keys);
        return;
      case 'copyText':
        if (msg.text) {
          await vscode.env.clipboard.writeText(msg.text);
          vscode.window.setStatusBarMessage('$(check) SF Deploy: error copied to clipboard', 2500);
        }
        return;
      case 'cancel':
        if (this.currentCancel) this.currentCancel();
        return;
    }
  }

  // ---- Loaders ----
  private async loadOrgs(notify = false): Promise<void> {
    try {
      this.orgs = await this.sf.listOrgs();
      const current = this.orgStore.get();
      if (current && !this.orgs.some(o => o.username === current)) {
        await this.orgStore.set(undefined);
      } else if (!current) {
        const def = this.orgs.find(o => o.isDefaultUsername) ?? this.orgs[0];
        if (def) await this.orgStore.set(def.username);
      }
      // If the effective org no longer matches what org metadata was fetched for, drop it.
      if (this.orgMembersOrg && this.orgStore.get() !== this.orgMembersOrg) this.resetOrgMetadata();
      this.postOrgs();
      if (notify && this.orgs.length === 0) {
        vscode.window.showWarningMessage('No authenticated Salesforce orgs found.');
      }
      this.post({ type: 'banner', message: this.orgs.length === 0 ? 'No authenticated Salesforce orgs found. Run `sf org login web`.' : '' });
    } catch (err) {
      this.handleError('list orgs', err);
      this.post({ type: 'banner', message: 'Failed to list orgs. See output channel.' });
    }
  }

  private async loadFiles(): Promise<void> {
    const { items, root, warning } = await scanWorkspace();
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
    if (warning) this.post({ type: 'banner', message: warning });
    else if (items.length === 0 && root) this.post({ type: 'banner', message: 'No metadata found in workspace package directories.' });
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
  private async runDeploy(keys: string[]): Promise<void> {
    if (this.busy) { vscode.window.showInformationMessage('Another operation is already running.'); return; }
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
    const isProd = this.sf.isLikelyProduction(orgInfo);
    const n = items.length;
    const noun = `${n} component${n === 1 ? '' : 's'}`;
    const confirm = isProd
      ? await vscode.window.showWarningMessage(
          `⚠ Deploy ${noun} to PRODUCTION (${orgLabel})?\n\nThis change will be live immediately.`,
          { modal: true, detail: orgInfo?.instanceUrl ?? '' },
          'Deploy to PROD'
        )
      : await vscode.window.showWarningMessage(
          `Deploy ${noun} to ${orgLabel}?`,
          { modal: true },
          'Deploy'
        );
    if (!confirm) return;

    const ignoreConflicts = vscode.workspace
      .getConfiguration('sfOrgDeployWrapper')
      .get<boolean>('ignoreDeployConflicts', false);

    const cmdId = this.beginCmd(`sf project deploy start ${this.metadataArgs(items)} --target-org ${org}${ignoreConflicts ? ' --ignore-conflicts' : ''}`);
    this.setBusy(true, 'Deploy');
    const start = Date.now();
    try {
      await this.withWindowProgress(`Deploying ${noun} to ${orgLabel}`, async () => {
        this.postProgress(`Deploying ${noun} to ${orgLabel}…`);
        const handle = this.sf.deployMetadata(
          items.map(i => `${i.type}:${i.name}`),
          org,
          root,
          { ignoreConflicts, timeoutMs: this.timeoutMs() }
        );
        this.currentCancel = handle.cancel;
        const { result, cmd } = await handle.promise;
        this.updateCmd(cmdId, cmd);
        // Per-component results live under `details.*` on older `sf` output and under
        // `files` on newer output — read both so failures are never silently dropped
        // (and the success gate accounts for both).
        const detailFailures = result.details?.componentFailures ?? [];
        const detailSuccesses = result.details?.componentSuccesses ?? [];
        const fileFailures = (result.files ?? []).filter(f => f.state === 'Failed' || !!f.problem);
        const fileSuccesses = (result.files ?? []).filter(f => f.state && f.state !== 'Failed' && !f.problem);
        const failures = detailFailures.length ? detailFailures : fileFailures;
        const successes = detailSuccesses.length ? detailSuccesses : fileSuccesses;
        const success = result.success
          && (result.numberComponentErrors == null || result.numberComponentErrors === 0)
          && failures.length === 0;
        const lines = items.map(i => `${i.type}:${i.name}`);
        const skipLines = orgOnlySkipped.map(i => `— ${i.type}:${i.name} — no local source, skipped (retrieve first)`);
        this.endCmd(cmdId, success, Date.now() - start);
        if (success) {
          this.post({
            type: 'status',
            card: {
              kind: orgOnlySkipped.length > 0 ? 'warn' : 'ok',
              title: `Deployed ${items.length} component${items.length === 1 ? '' : 's'} to ${orgLabel}`,
              meta: `${result.numberComponentsDeployed ?? successes.length}/${result.numberComponentsTotal ?? items.length} succeeded${orgOnlySkipped.length > 0 ? ` · ${orgOnlySkipped.length} skipped` : ''}`,
              lines: [...lines, ...skipLines]
            }
          });
          this.notifySuccessIfPanelHidden(`Deployed ${noun} to ${orgLabel}`);
        } else {
          const errLines = failures.length
            ? failures.map(f => `${f.type}:${f.fullName} — ${f.problem ?? 'failed'}${f.lineNumber ? ` (line ${f.lineNumber})` : ''}`)
            : ['Deploy reported failure with no per-component details.'];
          this.post({
            type: 'status',
            card: {
              kind: 'err',
              title: `Deploy failed against ${orgLabel}`,
              meta: `${failures.length} failure${failures.length === 1 ? '' : 's'}, ${successes.length} success`,
              lines: [...errLines, ...skipLines]
            }
          });
        }
      });
    } catch (err) {
      this.endCmd(cmdId, false, Date.now() - start);
      if (err instanceof SfCliCancelledError) this.reportCancelled('Deploy');
      else this.reportError('Deploy', err);
    } finally {
      this.currentCancel = undefined;
      this.setBusy(false);
    }
  }

  private async runRetrieve(keys: string[]): Promise<void> {
    if (this.busy) { vscode.window.showInformationMessage('Another operation is already running.'); return; }
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

    const cmdId = this.beginCmd(`sf project retrieve start ${this.metadataArgs(items)} --target-org ${org}`);
    this.setBusy(true, 'Retrieve');
    const start = Date.now();
    try {
      await this.withWindowProgress(`Retrieving ${noun} from ${orgLabel}`, async () => {
        this.postProgress(`Retrieving ${noun} from ${orgLabel}…`);
        const handle = this.sf.retrieveMetadata(items.map(i => `${i.type}:${i.name}`), org, root, { timeoutMs: this.timeoutMs() });
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
  }

  private async runDiff(keys: string[], orgOverride?: string): Promise<void> {
    if (this.busy) { vscode.window.showInformationMessage('Another operation is already running.'); return; }
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
    const tmpPaths: string[] = [tmpRoot];
    this.setBusy(true, 'Diff');
    try {
      await this.withWindowProgress(`Comparing ${items.length} component${items.length === 1 ? '' : 's'} with ${orgLabel}`, async report => {
        const missing: MetadataItem[] = [];
        const opened: string[] = [];
        const errors: string[] = [];

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
                await this.openDiff(item, staged.file, orgLabel);
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
            await this.openDiff(item, staged.file, orgLabel);
            opened.push(`${item.type}:${item.name}`);
          }
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
  }

  // ---- Org metadata browse ----

  /** Clear cached org-membership (provider + webview) so stale badges/rows from a
   *  previously-fetched org never describe a different selected org. */
  private resetOrgMetadata(): void {
    this.orgMembers = new Map();
    this.orgMembersOrg = undefined;
    this.post({ type: 'orgMetadataReset' });
  }

  private async loadOrgMetadata(): Promise<void> {
    if (this.busy) { vscode.window.showInformationMessage('Another operation is already running.'); return; }
    const root = this.requireRoot();
    if (!root) return;
    const org = this.requireOrg();
    if (!org) return;
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
    this.setBusy(true, 'Fetch Org');

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

  private timeoutMs(): number {
    return vscode.workspace.getConfiguration('sfOrgDeployWrapper').get<number>('commandTimeoutMs', 180_000);
  }

  private setBusy(b: boolean, action?: string): void {
    this.busy = b;
    this.currentAction = b ? action : undefined;
    if (!b) this.currentProgressText = undefined;
    this.post({ type: 'busy', busy: b, action: this.currentAction });
  }

  /** Run `body` under a cancellable VS Code progress notification so operations
   *  give feedback even when the panel is hidden (context-menu flows). The
   *  notification's Cancel button maps onto the currently running sf command. */
  private withWindowProgress<T>(title: string, body: (report: (message: string) => void) => Promise<T>): Promise<T> {
    return Promise.resolve(vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `SF Deploy: ${title}`, cancellable: true },
      (progress, token) => {
        const sub = token.onCancellationRequested(() => this.currentCancel?.());
        return body(message => progress.report({ message })).finally(() => sub.dispose());
      }
    ));
  }

  /** Update the in-panel progress card with the current phase of the running op. */
  private postProgress(text: string): void {
    this.currentProgressText = text;
    this.post({ type: 'progress', text });
  }

  /** Success toast (status bar) when the panel isn't visible — otherwise the
   *  result card lands in a webview nobody can see. */
  private notifySuccessIfPanelHidden(message: string): void {
    if (!this.view?.visible) vscode.window.setStatusBarMessage(`$(check) ${message}`, 8000);
  }

  private async openDiff(item: MetadataItem, remoteFile: string, orgLabel: string): Promise<void> {
    const title = `${item.type}:${item.name} — Local ↔ ${orgLabel}`;
    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(item.filePath), vscode.Uri.file(remoteFile), title, { preview: false });
  }

  private reportCancelled(action: string): void {
    this.post({
      type: 'status',
      card: { kind: 'warn', title: `${action} cancelled` }
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

  private post(msg: unknown): void {
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
    vscode.window.showErrorMessage(`SF Deploy: ${action} failed. ${message}`, 'Show Output').then(choice => {
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
  return { file: dest, dir };
}

/** Write org-side text (a tooling-query body) into a diff-staging file named like the
 *  local file so the diff editor gets the right syntax highlighting. */
async function stageDiffText(content: string, item: MetadataItem): Promise<{ file: string; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-diff-stage-'));
  const file = path.join(dir, safeStagedName(item, path.basename(item.filePath)));
  await fs.writeFile(file, content, 'utf8');
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
