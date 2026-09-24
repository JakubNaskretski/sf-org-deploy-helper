import * as vscode from 'vscode';
import { OrgStore } from './orgStore';
import { SfCliService } from './sfCliService';
import { DeployPanelProvider } from './panelProvider';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('SF Org Deploy Wrapper');
  const sf = new SfCliService();
  const orgStore = new OrgStore(context.workspaceState, context.globalState, msg => output.appendLine(msg));
  const provider = new DeployPanelProvider(context, orgStore, sf, output);

  // Status bar org indicator (T13)
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'sfOrgDeployWrapper.selectOrg';
  statusBar.tooltip = 'SF Deploy: switch target org';
  const refreshStatus = (username: string | undefined) => {
    if (username) {
      statusBar.text = `$(cloud) ${username}`;
      statusBar.show();
    } else {
      statusBar.text = '$(cloud) no org';
      statusBar.show();
    }
  };
  refreshStatus(orgStore.get());

  context.subscriptions.push(
    output,
    statusBar,
    orgStore,
    orgStore.onDidChange(refreshStatus),
    vscode.window.registerWebviewViewProvider(DeployPanelProvider.viewType, provider, {
      // Keep the webview (org list, selection, status cards) alive when the user
      // switches to another activity-bar view and back, instead of tearing it down
      // and re-running the org/file scan from scratch each time. Matches the soql /
      // apex editor plugins in this family.
      webviewOptions: { retainContextWhenHidden: true }
    }),
    registerSafe('sfOrgDeployWrapper.selectOrg', () => provider.pickOrg()),
    registerSafe('sfOrgDeployWrapper.refreshFiles', () => provider.refreshFiles()),
    registerSafe('sfOrgDeployWrapper.deployFile', (uri?: vscode.Uri) => provider.deployFile(uri ?? vscode.window.activeTextEditor?.document.uri as vscode.Uri)),
    // `uris` is VS Code's full explorer multi-selection (A11) — undefined from
    // the palette/editor, where there's only ever the one active file.
    registerSafe('sfOrgDeployWrapper.deployFileWithDeps', (uri?: vscode.Uri, uris?: vscode.Uri[]) =>
      provider.deployFileWithDeps(uri ?? vscode.window.activeTextEditor?.document.uri as vscode.Uri, uris)),
    registerSafe('sfOrgDeployWrapper.showSuggestionLog', () => provider.showSuggestionLog()),
    registerSafe('sfOrgDeployWrapper.retrieveFile', (uri?: vscode.Uri) => provider.retrieveFile(uri ?? vscode.window.activeTextEditor?.document.uri as vscode.Uri)),
    registerSafe('sfOrgDeployWrapper.diffFile', (uri?: vscode.Uri) => provider.diffFile(uri ?? vscode.window.activeTextEditor?.document.uri as vscode.Uri)),
    registerSafe('sfOrgDeployWrapper.diffFileWithOrg', (uri?: vscode.Uri) => provider.diffFileWithOrg(uri ?? vscode.window.activeTextEditor?.document.uri as vscode.Uri)),
    // Manifest commands pass the uri straight through: from the explorer menu it's
    // the clicked package.xml; from the palette it's undefined, so the provider
    // opens an XML file dialog rather than assuming the active editor.
    registerSafe('sfOrgDeployWrapper.deployManifest', (uri?: vscode.Uri) => provider.deployManifest(uri)),
    registerSafe('sfOrgDeployWrapper.retrieveManifest', (uri?: vscode.Uri) => provider.retrieveManifest(uri)),
    // Palette-only: undo the last (or an earlier) retrieve overwrite from the
    // pre-retrieve backups. No menu entry — it operates on the workspace, not a
    // clicked file.
    registerSafe('sfOrgDeployWrapper.restoreRetrieveBackup', () => provider.restoreRetrieveBackup()),
    // Command-palette parity for webview-only actions (T-usability): same provider
    // paths the webview messages use, so the busy gates / confirm modals / PROD
    // guard are identical either way.
    registerSafe('sfOrgDeployWrapper.loginOrg', () => provider.loginOrg()),
    registerSafe('sfOrgDeployWrapper.openInOrg', (uri?: vscode.Uri) => provider.openInOrg(uri ?? vscode.window.activeTextEditor?.document.uri as vscode.Uri)),
    registerSafe('sfOrgDeployWrapper.deleteFromOrg', (uri?: vscode.Uri) => provider.deleteFromOrg(uri ?? vscode.window.activeTextEditor?.document.uri as vscode.Uri)),
    registerSafe('sfOrgDeployWrapper.help', () => showHelp(context))
  );

  // Settle the remembered org (one-time adoption of the family setting, then a
  // family switch missed while we were shut down). Runs AFTER the listeners above
  // are wired so the resulting change event reaches the status bar and the panel.
  // Fire-and-forget: a failure only costs the remembered org — log it rather than
  // leave a floating rejection.
  void orgStore.migrate().catch(err =>
    output.appendLine(`[migrate] ${err instanceof Error ? err.message : String(err)}`));

  // A rejected command handler (e.g. the status-bar org pick failing to save this
  // plugin's remembered org — or, with syncOrgWithFamily on, to publish it to the
  // family) is otherwise an unhandled rejection the user never sees.
  function registerSafe(id: string, fn: (...args: [vscode.Uri?, vscode.Uri[]?]) => Promise<void> | void): vscode.Disposable {
    return vscode.commands.registerCommand(id, (...args: [vscode.Uri?, vscode.Uri[]?]) => {
      void Promise.resolve(fn(...args)).catch(err => {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[${id}] ${msg}`);
        void vscode.window.showErrorMessage(`SF Deploy: ${msg}`, 'Show Output').then(choice => {
          if (choice === 'Show Output') output.show(true);
        });
      });
    });
  }
}

export function deactivate(): void {
  // no-op
}

// The "?" in the panel title: a short plain-text guide (a modal's detail renders no markdown).
async function showHelp(context: vscode.ExtensionContext): Promise<void> {
  const HELP = `1. Open SF Deploy Wrapper in the Activity Bar and pick an org from the dropdown (＋ logs in to a new one).
2. Tick components in the tree; the All / Selected / Changed tabs and search (acc trig, type:flow) narrow it; the type filter narrows All and Changed.
2a. Changed lists your uncommitted edits plus this branch's commits, one section each — click its header label (or set sfOrgDeployWrapper.changedBaseRef) to compare against a ref instead, or to show uncommitted changes only.
3. Deploy pushes local files; Validate is a check-only deploy; Retrieve pulls the org's copy; Diff compares the two.
4. Fetch Org lists what the org has, so org-only components appear; Rescan re-reads the workspace.
5. Right-click a metadata file in the Explorer or editor for Deploy, Retrieve, Diff, Compare, Deploy File + Dependencies, Open in Org, Delete from Org.
6. Most actions are also in the Command Palette under "SF Deploy:", including Restore Retrieve Backup, which otherwise appears only on a retrieve's result card.
7. Destructive actions confirm first and production orgs get an extra guard; long runs can be cancelled.
8. Needs the Salesforce CLI (sf) on PATH, a logged-in org, and exactly one sfdx-project.json somewhere under the opened folder.`;
  const choice = await vscode.window.showInformationMessage('SF Deploy Wrapper', { modal: true, detail: HELP }, 'Open README');
  if (choice === 'Open README') {
    // vsce ships the file as readme.md while the dev host has README.md: open whichever exists
    for (const name of ['readme.md', 'README.md']) {
      const uri = vscode.Uri.joinPath(context.extensionUri, name);
      try {
        await vscode.workspace.fs.stat(uri);
        await vscode.commands.executeCommand('markdown.showPreview', uri);
        return;
      } catch { /* try the other spelling */ }
    }
    void vscode.window.showWarningMessage('README not found in the extension folder.');
  }
}
