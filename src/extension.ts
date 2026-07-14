import * as vscode from 'vscode';
import { OrgStore } from './orgStore';
import { SfCliService } from './sfCliService';
import { DeployPanelProvider } from './panelProvider';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('SF Org Deploy Wrapper');
  const sf = new SfCliService();
  const orgStore = new OrgStore(context.globalState);
  // Seed the shared setting from the legacy globalState key so the remembered org
  // survives the move to `skrety.salesforce.targetOrg`. Fire-and-forget: the
  // status bar refreshes off the store's change event once the seed lands. A failed
  // seed only costs the remembered org — log it rather than leave a floating rejection.
  void orgStore.migrate().catch(err =>
    output.appendLine(`[migrate] ${err instanceof Error ? err.message : String(err)}`));
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
    registerSafe('sfOrgDeployWrapper.restoreRetrieveBackup', () => provider.restoreRetrieveBackup())
  );

  // A rejected command handler (e.g. the status-bar org pick failing to save the
  // shared setting) is otherwise an unhandled rejection the user never sees.
  function registerSafe(id: string, fn: (...args: [vscode.Uri?]) => Promise<void> | void): vscode.Disposable {
    return vscode.commands.registerCommand(id, (...args: [vscode.Uri?]) => {
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
