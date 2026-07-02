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
  // status bar refreshes off the store's change event once the seed lands.
  void orgStore.migrate();
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
    vscode.commands.registerCommand('sfOrgDeployWrapper.selectOrg', () => provider.pickOrg()),
    vscode.commands.registerCommand('sfOrgDeployWrapper.refreshFiles', () => provider.refreshFiles()),
    vscode.commands.registerCommand('sfOrgDeployWrapper.deployFile', (uri?: vscode.Uri) => provider.deployFile(uri ?? vscode.window.activeTextEditor?.document.uri as vscode.Uri)),
    vscode.commands.registerCommand('sfOrgDeployWrapper.retrieveFile', (uri?: vscode.Uri) => provider.retrieveFile(uri ?? vscode.window.activeTextEditor?.document.uri as vscode.Uri)),
    vscode.commands.registerCommand('sfOrgDeployWrapper.diffFile', (uri?: vscode.Uri) => provider.diffFile(uri ?? vscode.window.activeTextEditor?.document.uri as vscode.Uri)),
    vscode.commands.registerCommand('sfOrgDeployWrapper.diffFileWithOrg', (uri?: vscode.Uri) => provider.diffFileWithOrg(uri ?? vscode.window.activeTextEditor?.document.uri as vscode.Uri))
  );
}

export function deactivate(): void {
  // no-op
}
