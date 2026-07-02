import * as vscode from 'vscode';
import { getSharedOrg, onSharedOrgChange, setSharedOrg } from './kit/orgs';

/** Legacy per-plugin globalState key. Kept only to seed the shared setting on
 *  first run after the migration, then never written again. */
const LEGACY_KEY = 'sfOrgDeployWrapper.selectedOrg.v1';

/**
 * Target-org store. Backed by the family-shared setting
 * `skrety.salesforce.targetOrg` (machine scope) so the chosen org is shared with
 * the other Skrety SF plugins, rather than this plugin's private globalState
 * The public surface (`get`/`set`/`onDidChange`) is
 * unchanged, so callers didn't need to move.
 *
 * `onDidChange` now fires for BOTH our own writes and external ones (another
 * plugin, or the user editing settings.json) — the config watcher is the single
 * source of change events, so a same-value write is de-duped by the watcher's
 * own change filter.
 */
export class OrgStore {
  private readonly emitter = new vscode.EventEmitter<string | undefined>();
  readonly onDidChange: vscode.Event<string | undefined> = this.emitter.event;
  private readonly watcher: vscode.Disposable;

  constructor(private readonly memento: vscode.Memento) {
    // Re-broadcast external edits to the shared setting so the status bar / panel
    // follow along when another plugin (or the user) switches the org.
    this.watcher = onSharedOrgChange(username => this.emitter.fire(username));
  }

  /**
   * One-time seed: if the shared setting is empty but this plugin's old
   * globalState key still holds a username, copy it into the shared setting so
   * the user's remembered org survives the migration. No-ops once the shared
   * setting is populated. Call once at activation before reading `get()`.
   */
  async migrate(): Promise<void> {
    if (getSharedOrg()) return;
    const legacy = this.memento.get<string>(LEGACY_KEY);
    if (legacy && legacy.trim()) await setSharedOrg(legacy);
  }

  get(): string | undefined {
    return getSharedOrg();
  }

  async set(username: string | undefined): Promise<void> {
    // Write only; the config watcher is the single source of change events, so a
    // real change fires exactly one `onDidChange` (no manual fire → no double
    // event). A redundant same-value set produces no event, which is correct —
    // nothing changed for the status bar to react to, and callers read `get()`
    // synchronously rather than depending on the event.
    await setSharedOrg(username);
  }

  dispose(): void {
    this.watcher.dispose();
    this.emitter.dispose();
  }
}
