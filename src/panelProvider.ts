import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { OrgStore } from './orgStore';
import { OrgInfo, RetrieveFileResult, RetrieveResult, SfCliCancelledError, SfCliError, SfCliService } from './sfCliService';
import { MetadataItem, OBJECT_CHILD_TYPES, findItemForPath, scanWorkspace } from './metadataScanner';
import { generateNonce, getPanelHtml } from './panelHtml';

type Inbound =
  | { type: 'ready' }
  | { type: 'refreshOrgs' }
  | { type: 'refreshFiles' }
  | { type: 'selectOrg'; username: string }
  | { type: 'useActiveFile' }
  | { type: 'deploy'; keys: string[] }
  | { type: 'retrieve'; keys: string[] }
  | { type: 'diff'; keys: string[] }
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
      case 'selectOrg':
        await this.orgStore.set(msg.username || undefined);
        this.postOrgs();
        return;
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
    const items = this.resolveKeys(keys);
    if (items.length === 0) return;

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
        this.endCmd(cmdId, success, Date.now() - start);
        if (success) {
          this.post({
            type: 'status',
            card: {
              kind: 'ok',
              title: `Deployed ${items.length} component${items.length === 1 ? '' : 's'} to ${orgLabel}`,
              meta: `${result.numberComponentsDeployed ?? successes.length}/${result.numberComponentsTotal ?? items.length} succeeded`,
              lines
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
              lines: errLines
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

    const confirm = await vscode.window.showWarningMessage(
      `Retrieve ${noun} from ${orgLabel}? This will overwrite local files.`,
      { modal: true },
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

    // Partition into diffable vs unsupported metadata types.
    const diffable = allItems.filter(i => !DIFF_UNSUPPORTED.has(i.type));
    const unsupported = allItems.filter(i => DIFF_UNSUPPORTED.has(i.type));
    const preLines: string[] = unsupported.map(i => `— ${i.type}:${i.name} — diff not supported for this metadata type yet`);

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
          const rStart = Date.now();
          const rCmdId = this.beginCmd(`sf project retrieve start ${this.metadataArgs(slowItems)} --target-org ${org} --target-metadata-dir <tmp> --unzip`);
          const handle = this.sf.retrieveMetadata(
            slowItems.map(i => `${i.type}:${i.name}`), org, root, { outputDir: tmpRoot, timeoutMs: this.timeoutMs() }
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

          // sf usually unzips under tmpRoot/unpackaged/, but the folder name can vary
          // across CLI versions / manifest names — resolve it instead of assuming.
          const unpackagedDir = await resolveUnpackagedDir(tmpRoot);
          const sfFailures = (result.messages ?? []).filter(m => m.problem);
          for (const f of sfFailures) {
            errors.push(`${f.fileName ?? '?'}: ${f.problem}`);
          }
          this.endCmd(rCmdId, sfFailures.length === 0, Date.now() - rStart);

          // Decomposed object children (CustomField, ValidationRule, …) come back inlined
          // in the parent .object file in MDAPI format. Convert the retrieved bundle to
          // source format once so each child can be diffed as its own *-meta.xml against
          // the local file.
          let convertedDir: string | undefined;
          if (slowItems.some(i => OBJECT_CHILD_TYPES.has(i.type))) {
            report('converting to source format…');
            this.postProgress('Converting retrieved metadata to source format…');
            const srcDir = path.join(tmpRoot, 'source');
            tmpPaths.push(srcDir);
            try {
              const conv = this.sf.convertMdapi(unpackagedDir, srcDir, root, { timeoutMs: this.timeoutMs() });
              this.currentCancel = conv.cancel;
              await conv.promise;
              convertedDir = srcDir;
            } catch (e) {
              // Let a user cancel bubble to the outer handler ("Diff cancelled") rather
              // than degrade into a per-child "could not convert" error card.
              if (e instanceof SfCliCancelledError) throw e;
              this.output.appendLine(`[Diff] mdapi→source convert failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }

          report('opening diff editors…');
          for (const item of slowItems) {
            const isChild = OBJECT_CHILD_TYPES.has(item.type);
            let remoteFile: string | undefined;
            if (isChild) {
              // Match the converted file by its `objects/<Object>/<folder>/<file>` suffix so
              // same-named fields on different objects in one batch don't cross-match.
              const childFolder = path.basename(path.dirname(item.filePath));
              const objectFolder = path.basename(path.dirname(path.dirname(item.filePath)));
              const suffix = path.join('objects', objectFolder, childFolder, path.basename(item.filePath));
              remoteFile = convertedDir ? await findFileBySuffix(convertedDir, suffix) : undefined;
            } else {
              remoteFile = await findRetrievedPrimary(unpackagedDir, item);
            }
            if (!remoteFile) {
              if (isChild && !convertedDir) {
                errors.push(`${item.type}:${item.name} — could not convert org metadata to source format for diff`);
              } else {
                missing.push(item);
              }
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
    return this.items.filter(i => set.has(`${i.type}:${i.name}`));
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
        errText: [message, stderr].filter(Boolean).join('\n').trim(),
        hint: hintForError(err)
      }
    });
    vscode.window.showErrorMessage(`SF Deploy: ${action} failed. ${message}`, 'Show Output').then(choice => {
      if (choice === 'Show Output') this.output.show(true);
    });
  }
}

// ---- module-local helpers ----

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

/** Find the primary retrieved file inside the unpackaged folder for a given metadata item. */
async function findRetrievedPrimary(unpackagedDir: string, item: MetadataItem): Promise<string | undefined> {
  try {
    await fs.access(unpackagedDir);
  } catch {
    return undefined;
  }
  // map metadata type to retrieved folder name + expected file name pattern
  const folderByType: Record<string, string> = {
    ApexClass: 'classes',
    ApexTrigger: 'triggers',
    ApexPage: 'pages',
    ApexComponent: 'components',
    LightningComponentBundle: 'lwc',
    AuraDefinitionBundle: 'aura',
    Flow: 'flows',
    Layout: 'layouts',
    PermissionSet: 'permissionsets',
    Profile: 'profiles',
    StaticResource: 'staticresources',
    CustomTab: 'tabs',
    CustomLabels: 'labels',
    Queue: 'queues',
    Group: 'groups',
    GlobalValueSet: 'globalValueSets',
    Workflow: 'workflows',
    EmailTemplate: 'email',
    CustomObject: 'objects',
    CustomMetadata: 'customMetadata',
    FlexiPage: 'flexipages',
    CustomApplication: 'applications',
    QuickAction: 'quickActions',
    CustomPermission: 'customPermissions',
    NamedCredential: 'namedCredentials',
    ExternalDataSource: 'externalDataSources',
    RemoteSiteSetting: 'remoteSiteSettings',
    Role: 'roles',
    Settings: 'settings',
    LightningMessageChannel: 'messageChannels',
    ApexTestSuite: 'testSuites'
  };
  const folder = folderByType[item.type];
  if (!folder) return undefined;
  const base = path.join(unpackagedDir, folder);
  try { await fs.access(base); } catch { return undefined; }

  const localBasename = path.basename(item.filePath);
  // For bundle types: prefer matching same-named file under bundle dir
  if (item.type === 'LightningComponentBundle' || item.type === 'AuraDefinitionBundle' || item.type === 'CustomObject') {
    const bundleDir = path.join(base, item.name);
    try {
      await fs.access(bundleDir);
    } catch {
      return undefined;
    }
    // Try to find the same filename present locally
    const candidate = path.join(bundleDir, localBasename);
    try { await fs.access(candidate); return candidate; } catch { /* fall through */ }
    // Otherwise return the directory itself (vscode.diff supports files only; pick the meta xml if present)
    const entries = await fs.readdir(bundleDir);
    const meta = entries.find(n => n.endsWith('-meta.xml'));
    if (meta) return path.join(bundleDir, meta);
    if (entries[0]) return path.join(bundleDir, entries[0]);
    return undefined;
  }
  // Foldered types (e.g. EmailTemplate) carry the folder in item.name as
  // "Folder/Name", and the retrieve nests the file under that folder.
  const nameSegments = item.name.split('/');
  const folderSegments = nameSegments.slice(0, -1);
  const leaf = nameSegments[nameSegments.length - 1];
  const candidate = path.join(base, ...folderSegments, localBasename);
  try { await fs.access(candidate); return candidate; } catch { /* fall through */ }
  // Fall back: recursively scan for the exact local basename, else a file whose
  // stem matches the leaf name (handles folder nesting and ext differences).
  return findFileMatching(base, localBasename, leaf);
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

/** Resolve the directory the CLI unzipped a metadata-dir retrieve into. Prefers
 *  `<tmpRoot>/unpackaged`, falling back to a single child directory if the CLI
 *  used a different (manifest-derived) folder name. */
async function resolveUnpackagedDir(tmpRoot: string): Promise<string> {
  const preferred = path.join(tmpRoot, 'unpackaged');
  try { await fs.access(preferred); return preferred; } catch { /* fall through */ }
  try {
    const entries = await fs.readdir(tmpRoot, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory());
    if (dirs.length === 1) return path.join(tmpRoot, dirs[0].name);
  } catch { /* ignore */ }
  return preferred; // nothing better; the caller's access() check treats it as missing
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
