// AUTO-GENERATED — vendored from sf-kit by scripts/sync-kit.mjs. DO NOT EDIT HERE.
// Edit the source in sf-kit/src/ and re-run the sync. Local edits will be overwritten.
import * as vscode from 'vscode';
import { OrgInfo } from './sfCli';

/**
 * Shared org classification + selection helpers for the Skrety SF plugin family.
 *
 * Classification is lifted from apex-editor's `SfCliService.kindOf` /
 * `isLikelyProduction`, with the apex-editor HIGH bug fixed at the root
 * an **undefined / unknown org is treated as PRODUCTION**. The old
 * code mapped `kindOf(undefined) → 'other' → isLikelyProduction === false`, so a
 * palette run fired before the org list loaded skipped the production
 * confirmation. The family's design is over-warn, so unknown MUST err toward
 * prod.
 *
 * Selection: a single shared VS Code setting `skrety.salesforce.targetOrg`
 * (machine scope, ConfigurationTarget.Global) so org choice is shared across all
 * family plugins — read/write/watch helpers plus a QuickPick
 * picker and a status-bar item factory.
 */

export type OrgKind = 'prod' | 'sandbox' | 'scratch' | 'unknown';

/** The one cross-plugin setting key. Contributed (schema-declared) by
 *  sf-org-deploy-helper; every other plugin reads/writes it undeclared. */
export const SHARED_ORG_SETTING = 'skrety.salesforce.targetOrg';

/**
 * Classify an org. Trusts the scratch/sandbox flags from `sf org list` first
 * (set from the bucket the org came from), then URL markers, and defaults to
 * PRODUCTION for a known-but-unmarked org.
 *
 * Returns 'unknown' ONLY when the org itself is undefined (list not loaded yet /
 * lookup failed). `isLikelyProduction` maps 'unknown' to true so an unknown org
 * still triggers the production guard.
 */
export function kindOf(org: OrgInfo | undefined): OrgKind {
  if (!org) return 'unknown';
  if (org.isScratch) return 'scratch';
  if (org.isSandbox) return 'sandbox';
  const url = (org.instanceUrl ?? '').toLowerCase();
  if (/\.scratch\./.test(url)) return 'scratch';
  if (/\.sandbox\.|\.cs\d+\.|test\.salesforce\.com/.test(url)) return 'sandbox';
  return 'prod';
}

/**
 * True when a run against this org should get the production confirmation.
 * Unknown (undefined) orgs count as production — the fix for the apex-editor
 * HIGH silent-bypass. A run guard should call this and, on true, confirm.
 */
export function isLikelyProduction(org: OrgInfo | undefined): boolean {
  const kind = kindOf(org);
  return kind === 'prod' || kind === 'unknown';
}

/** Short uppercase badge for a status bar / QuickPick label. */
export function orgBadge(org: OrgInfo | undefined): string {
  switch (kindOf(org)) {
    case 'prod': return 'PROD';
    case 'sandbox': return 'SBX';
    case 'scratch': return 'SCR';
    default: return 'ORG';
  }
}

// ─────────────────────────── shared setting I/O ───────────────────────────

/** Read the shared target-org username (or undefined if unset). */
export function getSharedOrg(): string | undefined {
  const raw = vscode.workspace.getConfiguration().get<string>(SHARED_ORG_SETTING);
  return raw && raw.trim() ? raw : undefined;
}

/**
 * Write the shared target-org username at global (machine) scope. Passing
 * undefined clears it. Global scope + `"scope": "machine"` in the schema keeps
 * org usernames out of Settings Sync (they're machine-local auth state).
 */
export async function setSharedOrg(username: string | undefined): Promise<void> {
  await vscode.workspace
    .getConfiguration()
    .update(SHARED_ORG_SETTING, username && username.trim() ? username : undefined, vscode.ConfigurationTarget.Global);
}

/**
 * Subscribe to shared-org changes. The callback runs whenever another plugin
 * (or the user) rewrites `skrety.salesforce.targetOrg`. Return value is a
 * Disposable to push into `context.subscriptions`.
 */
export function onSharedOrgChange(handler: (username: string | undefined) => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration(SHARED_ORG_SETTING)) handler(getSharedOrg());
  });
}

/**
 * One-time migration: if the shared setting is empty but a plugin's private
 * globalState key holds a username, seed the shared setting from it. Safe to
 * call on every activation — it no-ops once the shared setting is populated.
 * Returns the effective username (shared, else migrated, else undefined).
 */
export async function migrateToSharedOrg(privateValue: string | undefined): Promise<string | undefined> {
  const shared = getSharedOrg();
  if (shared) return shared;
  if (privateValue && privateValue.trim()) {
    await setSharedOrg(privateValue);
    return privateValue;
  }
  return undefined;
}

// ─────────────────────────────── UI helpers ───────────────────────────────

interface OrgQuickPickItem extends vscode.QuickPickItem {
  username: string;
}

/**
 * Show a QuickPick of orgs and return the chosen username (undefined if
 * cancelled or none). Marks the currently-shared org as "• current" and the
 * CLI default org distinctly. Pure UI — the caller decides whether to persist.
 */
export async function pickOrg(
  orgs: OrgInfo[],
  opts: { placeHolder?: string; current?: string } = {}
): Promise<string | undefined> {
  if (orgs.length === 0) {
    await vscode.window.showWarningMessage('No authenticated Salesforce orgs found. Run `sf org login web` first.');
    return undefined;
  }
  const current = opts.current ?? getSharedOrg();
  const items: OrgQuickPickItem[] = orgs.map(o => ({
    label: `$(cloud) ${o.alias ?? o.username}`,
    description: [
      o.alias ? o.username : undefined,
      `[${orgBadge(o)}]`,
      o.username === current ? '• current' : undefined,
      o.isDefaultUsername ? '• CLI default' : undefined
    ].filter(Boolean).join('  '),
    detail: o.instanceUrl,
    username: o.username
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: opts.placeHolder ?? 'Select a Salesforce org',
    matchOnDescription: true,
    matchOnDetail: true
  });
  return picked?.username;
}

/**
 * Create a status-bar item that shows the current org with a kind badge and
 * runs `command` on click. The caller updates it via the returned `update`.
 * Push `item` into subscriptions. Respects the shared status-bar dedup rule via
 * the `show` option (only one family plugin shows it by default).
 */
export function createOrgStatusBar(opts: {
  command: string;
  tooltip?: string;
  alignment?: vscode.StatusBarAlignment;
  priority?: number;
}): { item: vscode.StatusBarItem; update: (org: OrgInfo | undefined) => void } {
  const item = vscode.window.createStatusBarItem(
    opts.alignment ?? vscode.StatusBarAlignment.Left,
    opts.priority ?? 100
  );
  item.command = opts.command;
  item.tooltip = opts.tooltip ?? 'Select Salesforce org';
  const update = (org: OrgInfo | undefined): void => {
    if (!org) {
      item.text = '$(cloud) No Org';
      item.backgroundColor = undefined;
      return;
    }
    const badge = orgBadge(org);
    item.text = `$(cloud) ${org.alias ?? org.username} [${badge}]`;
    // Warn-tint production so the target is unmistakable before a live run.
    item.backgroundColor = badge === 'PROD'
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
  };
  return { item, update };
}
