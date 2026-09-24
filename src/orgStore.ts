import * as vscode from 'vscode';
import { getSharedOrg, setSharedOrg, SHARED_ORG_SETTING } from './kit/orgs';

/** This plugin's OWN remembered org — the source of truth. Lives in the WINDOW's
 *  workspaceState, so two windows on two projects deploy to two different orgs.
 *  The key NAME is unchanged, which is what lets `migrate` port the value older
 *  releases wrote under it in globalState forward into each window once (see
 *  there); globalState is a separate memento, so the two never collide. */
const PRIVATE_KEY = 'sfOrgDeployWrapper.selectedOrg.v1';
/** One-shot marker for the shared → private adoption below (see `migrate`). Stays
 *  in globalState: that adoption is once per INSTALL, not once per window. */
const MIGRATED_KEY = 'sfOrgDeployWrapper.orgSyncMigrated.v1';
/** Per-WINDOW marker: this window has had its one shot at the legacy globalState
 *  org (see `migrate`). Lives in workspaceState beside the org it guards, and is
 *  stamped whether or not anything moved. */
const PORTED_KEY = 'sfOrgDeployWrapper.orgPortedFromGlobal.v1';

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
 * Target-org store. The org lives in this plugin's private workspaceState key and
 * is written on EVERY applied change (user pick, adopted family switch, startup
 * fallback) — so the plugin remembers its own org even when nothing else in the
 * family agrees. workspaceState is per window and VS Code never propagates it
 * between windows, so each open project keeps its own target org.
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

  /** `privateState` is the window-scoped memento (`context.workspaceState`) that
   *  holds the target org; `installState` is `context.globalState` and holds only
   *  the one-time migration marker.
   *
   *  `log` receives the reason a background (event-driven) write failed; those
   *  paths have no caller to reject to, and dropping them silently would leave the
   *  org quietly out of sync with the family with no trace anywhere. */
  constructor(
    private readonly privateState: vscode.Memento,
    private readonly installState: vscode.Memento,
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
   * (a0) Port forward the legacy org, at most ONCE per window: releases before
   *     the per-window split kept the target in globalState under the SAME key. A
   *     window whose own store is still empty adopts it, so an upgrade changes
   *     nothing the user can see — without this every window would silently fall
   *     back to the CLI default, which may well be production. The hop is stamped
   *     in the window store, and stamped even when there was nothing to port,
   *     because "empty" is also what an org cleared on purpose looks like: once
   *     the auth expires or the org leaves the list, reconciliation clears the
   *     target, and an unstamped port would drag the dead org back in on every
   *     reload. The org is written BEFORE the stamp, so a crash between the two
   *     costs nothing but another attempt next time. The global value is only ever
   *     READ: other windows of this install need it too.
   * (a) One-time adoption, regardless of the opt-in: while the family shared a
   *     single setting this plugin stopped writing its private key, so on the
   *     first run after the toggle shipped that key is stale and the shared value
   *     is the user's actual last choice. The marker is then set unconditionally —
   *     once it is set, a sibling's later switch must not leak in behind a
   *     disabled toggle. The marker is install-wide while the org is per window,
   *     so this adoption lands in the FIRST window that activates; every later
   *     window opens on the org (a0) ported forward, or on its own last pick.
   * (b) With sync ON, adopt a shared org that drifted while we weren't running.
   *
   * Never writes the shared setting: activation is not a user pick.
   */
  async migrate(): Promise<void> {
    if (!this.privateState.get<boolean>(PORTED_KEY)) {
      if (!this.get()) {
        // Read defensively: this is storage written by an older release and
        // editable by hand, so it may hold anything at all — and `normalize`
        // assumes a string. A rejected `migrate()` would leave the window org-less.
        const legacy = this.installState.get<unknown>(PRIVATE_KEY);
        if (typeof legacy === 'string' && legacy.trim()) await this.apply(legacy);
      }
      await this.privateState.update(PORTED_KEY, true);
    }
    if (!this.installState.get<boolean>(MIGRATED_KEY)) {
      const shared = getSharedOrg();
      if (shared) await this.apply(shared);
      await this.installState.update(MIGRATED_KEY, true);
    }
    if (isOrgSyncEnabled()) await this.adoptShared();
  }

  get(): string | undefined {
    return normalize(this.privateState.get<string>(PRIVATE_KEY));
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
    await this.privateState.update(PRIVATE_KEY, next);
    this.emitter.fire(next);
  }

  dispose(): void {
    this.watcher.dispose();
    this.emitter.dispose();
  }
}
