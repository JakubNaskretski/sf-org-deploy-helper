import * as vscode from 'vscode';

const KEY = 'sfOrgDeployWrapper.selectedOrg.v1';

export class OrgStore {
  private readonly emitter = new vscode.EventEmitter<string | undefined>();
  readonly onDidChange: vscode.Event<string | undefined> = this.emitter.event;

  constructor(private readonly memento: vscode.Memento) {}

  get(): string | undefined {
    return this.memento.get<string>(KEY);
  }

  async set(username: string | undefined): Promise<void> {
    await this.memento.update(KEY, username);
    this.emitter.fire(username);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
