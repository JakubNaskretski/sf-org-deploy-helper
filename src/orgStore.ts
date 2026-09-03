import * as vscode from 'vscode';
import { getSharedOrg, setSharedOrg, SHARED_ORG_SETTING } from './kit/orgs';

/** This plugin's OWN remembered org — the source of truth. Same globalState key
 *  the plugin has always used, so an existing selection survives this change. */
const PRIVATE_KEY = 'sfOrgDeployWrapper.selectedOrg.v1';
/** One-shot marker for the shared → private adoption below (see `migrate`). */
const MIGRATED_KEY = 'sfOrgDeployWrapper.orgSyncMigrated.v1';

const SYNC_SECTION = 'sfOrgDeployWrapper';
const SYNC_KEY = 'syncOrgWithFamily';
/** Opt-in: follow AND publish the family-shared org. Default off. */
export const SYNC_SETTING = `${SYNC_SECTION}.${SYNC_KEY}`;

/**
 * Is this plugin opted in to the family-shared org?
 *
 * Always read at the MOMENT of the decision, never captured at registration, so
 * flipping the toggle takes effect without a window reload.
 */
export function isOrgSyncEnabled(): boolean {
  return vscode.workspace.getConfiguration(SYNC_SECTION).get<boolean>(SYNC_KEY, false);
}

/** Blank / whitespace-only usernames mean "no org". */
function normalize(username: string | undefined): string | undefined {
  return username && username.trim() ? username : undefined;
}

/**
 * Target-org store. The org lives in this plugin's private globalState key and is
 * written on EVERY applied change (user pick, adopted family switch, startup
 * fallback) — so the plugin remembers its own org even when nothing else in the
 * family agrees.
 *
 * The family-shared setting `skrety.salesforce.targetOrg` is opt-in via
 * `sfOrgDeployWrapper.syncOrgWithFamily` (default OFF):
 *  - OFF: the shared setting is neither followed nor written. Sibling plugins can
 *    switch orgs all they like; this plugin does not move.
 *  - ON: an external change to the shared setting is adopted, and a pick made HERE
 *    is published back — the pre-toggle behaviour.
 *
 * `onDidChange` is fired by this store itself (not by the config watcher), so an
 * own pick raises an event even with sync off. A same-value write fires nothing —
 * nothing changed for the status bar to react to, and callers read `get()`
 * synchronously rather than depending on the event.
 */
export class OrgStore {
  private readonly emitter = new vscode.EventEmitter<string | undefined>();
  readonly onDidChange: vscode.Event<string | undefined> = this.emitter.event;
  private readonly watcher: vscode.Disposable;

  /** `log` receives the reason a background (event-driven) write failed; those
   *  paths have no caller to reject to, and dropping them silently would leave the
   *  org quietly out of sync with the family with no trace anywhere. */
  constructor(
    private readonly memento: vscode.Memento,
    private readonly log: (message: string) => void = () => { /* no sink */ }
  ) {
    this.watcher = vscode.workspace.onDidChangeConfiguration(e => {
      // Two triggers, one response: the shared org changed under us (another
      // plugin, or a hand edit of settings.json), or the opt-in itself was just
      // switched on and there is a family org waiting to be adopted. Both re-read
      // the flag HERE, so a toggle applies without a reload. Toggling off does
      // nothing — we simply stop following.
      if (!e.affectsConfiguration(SHARED_ORG_SETTING) && !e.affectsConfiguration(SYNC_SETTING)) return;
      if (!isOrgSyncEnabled()) return;
      void this.adoptShared().catch(err =>
        this.log(`[orgStore] adopting the shared org failed: ${err instanceof Error ? err.message : String(err)}`));
    });
  }

  /**
   * Activation sequence. Call once, before the first `get()`.
   *
   * (a) One-time adoption, regardless of the opt-in: while the family shared a
   *     single setting this plugin stopped writing its private key, so on the
   *     first run after the toggle shipped that key is stale and the shared value
   *     is the user's actual last choice. The marker is then set unconditionally —
   *     once it is set, a sibling's later switch must not leak in behind a
   *     disabled toggle.
   * (b) With sync ON, adopt a shared org that drifted while we weren't running.
   *
   * Never writes the shared setting: activation is not a user pick.
   */
  async migrate(): Promise<void> {
    if (!this.memento.get<boolean>(MIGRATED_KEY)) {
      const shared = getSharedOrg();
      if (shared) await this.apply(shared);
      await this.memento.update(MIGRATED_KEY, true);
    }
    if (isOrgSyncEnabled()) await this.adoptShared();
  }

  get(): string | undefined {
    return normalize(this.memento.get<string>(PRIVATE_KEY));
  }

  /**
   * Persist an org this plugin chose on the user's behalf — the startup fallback
   * to the CLI default, reconciliation when the remembered org is gone from the
   * org list, re-applying what the webview already has selected. Private only:
   * publishing any of these to the family would let one plugin's housekeeping
   * retarget every other plugin.
   */
  async set(username: string | undefined): Promise<void> {
    await this.apply(username);
  }

  /**
   * Persist an org the user just PICKED (status-bar / palette QuickPick, panel
   * dropdown) and, when synced, publish it to the family. The only path in this
   * plugin allowed to write the shared setting.
   *
   * Picking the panel's empty "— select org —" placeholder clears OUR org but is
   * never published: writing an empty shared setting would blank the target org of
   * every sibling plugin on a stray click, and "no org" is not a target anyone can
   * be asked to follow.
   */
  async setFromUserPick(username: string | undefined): Promise<void> {
    // Gate on the NORMALISED value: a whitespace-only username is truthy but still
    // means "no org", and `setSharedOrg` would turn it into a cleared setting.
    const picked = normalize(username);
    await this.apply(picked);
    if (picked && isOrgSyncEnabled()) await setSharedOrg(picked);
  }

  /** Follow the family-shared org. Callers check the opt-in first. An EMPTY shared
   *  setting is not adopted — someone clearing or never setting the family org is
   *  not a request to blank out this plugin's working target. */
  private async adoptShared(): Promise<void> {
    const shared = getSharedOrg();
    if (shared && shared !== this.get()) await this.apply(shared);
  }

  /** Write the private key and fire exactly one change event when the value really
   *  changed. Single funnel: every applied change lands here. */
  private async apply(username: string | undefined): Promise<void> {
    const next = normalize(username);
    if (next === this.get()) return;
    await this.memento.update(PRIVATE_KEY, next);
    this.emitter.fire(next);
  }

  dispose(): void {
    this.watcher.dispose();
    this.emitter.dispose();
  }
}
