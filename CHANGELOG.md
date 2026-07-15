# Changelog

All notable changes to this extension are documented here.
This file starts at the current release; earlier history predates it.

## 0.13.0

- New: **Deploy queue.** Starting a deploy or validation while another operation runs no
  longer refuses — you confirm it right away (org named, production guard included) and it
  queues, shown in a strip above the status pane with a per-item ✕. Each queued deploy runs
  against the org you confirmed, even if you switch orgs while waiting; if that org's
  authentication disappears meanwhile, the item is skipped with a note. Retrieve, diff and
  delete still wait their turn the old way.
- New: **Retry with missing dependencies.** When a deploy fails because a referenced
  component wasn't included — "no QuickAction named X found" on a FlexiPage, or an Apex
  class needing recompilation — and that component exists in your workspace, the failure
  card offers **Retry + N missing**: one click re-deploys the original set plus what it
  needed. Only components actually found in your local project are ever added.

## 0.12.0

- New: **Retry from the card.** Failed deploys and validations carry a **Retry** button —
  including cards restored from history and deploys reattached after a reload — re-running
  the same components, test level and options through the normal confirmation.
- Fixed: **Copy copies the actual error.** Since error rows became clickable, the card's
  Copy button put `[object Object]` on the clipboard instead of the failure text.

## 0.11.1

- Fixed: **The diff window never touches your tabs — properly this time.** Instead of
  moving an editor group (which could carry your own tabs, or skip floating entirely),
  the first diff is moved to the new window on its own — moving a single editor can't
  drag anything else — and the remaining diffs open straight into that window. If the
  move isn't possible, diffs just stay as normal tabs.

## 0.11.0

- New: **Backup buttons.** Retrieve result cards now carry **Restore backup…** and
  **Discard backup** buttons, restore lets you pick individual files (all preselected),
  and the palette flow offers discard too.
- Fixed: **Windows support.** The `sf` CLI now launches on Windows (recent VS Code
  builds refused to start `sf.cmd`), path comparisons are case-insensitive there — so
  the Changed tab, backups, active-file sync and Use open tabs work regardless of
  drive-letter casing — and backup folder names are Windows-safe.
- Fixed: **Cancelling a browser login works.** Cancel now force-kills a login that
  ignores the polite termination — previously the panel could stay stuck on
  "Waiting for browser login…" forever, even after closing the browser.
- Fixed: **Diff floating window can't kidnap your tabs.** When the editor is already
  split, org diffs no longer drag your own tabs into the new window — the float is
  skipped unless the target group contains only the freshly opened diffs.

## 0.10.0

- New: **Deploys no longer tie up the window — or die at a timeout.** Deploys, validations
  and quick deploys are submitted asynchronously: the job id arrives in seconds, progress
  shows live component and test counts, and the 15-minute waiting cap is gone — the panel
  simply follows the org until it finishes. Reload the window (or close it for an hour)
  and the panel reattaches to the running deploy on next open, reporting its result even
  if it finished in the meantime. **Cancel now genuinely asks the org to cancel** the
  deployment and reports the real final state — including "it finished anyway".
- New: **Retrieves are undoable.** Before a retrieve overwrites local files, the current
  copies are backed up (the last 5 retrieves per workspace are kept). **SF Deploy: Restore
  Retrieve Backup** brings a picked backup back — and the restore backs up the current
  state first, so it's undoable too. If the backup can't be written, the retrieve refuses
  to run unprotected. Setting: `sfOrgDeployWrapper.backupBeforeRetrieve` (on by default).
- Fixed: **Org messages name their org.** "No metadata found in workspace or on uat" and
  the source badges' tooltips now say which org they describe, so a message arriving late
  after quick org switches is never ambiguous.

## 0.9.0

- New: **Delete from Org.** Right-click components → "Delete from Org…": a dry-run preview
  first, then a confirmation listing exactly what will be removed — from the org AND the
  local source files (that is how `sf project delete source` works) — with the extra
  production guard on top.
- New: **Deploy or retrieve a manifest.** Right-click any `package*.xml` in the Explorer
  (or use the palette commands) to deploy or retrieve everything it lists — same
  confirmations, test levels and PROD guard as tree deploys.
- New: **Changed view against a branch.** Set `sfOrgDeployWrapper.changedBaseRef` (e.g.
  `origin/main`) and the Changed tab shows components differing from that ref — committed
  changes included — answering "what does this release deploy", not just "what's uncommitted".
- New: **Authenticate from the panel.** The ＋ button beside the org list runs
  `sf org login web` and selects the new org when the browser flow completes.
- New: **Run specific Apex tests.** The test-level picker gained `RunSpecifiedTests` with a
  class-name input, there's a `defaultTestLevel` setting for your standing policy, and the
  picker's choice now survives window reloads.
- Fixed: **Org switches made in sibling Skrety plugins update this panel immediately.**
  Previously the tree kept the old org's badges (which could talk you into overwriting a
  component that exists on the new org), and clicking Fetch Org in that state wrote the old
  org back over the switch for every plugin.
- Fixed: **Timed-out deploys tell the truth.** A deploy outliving the local timeout is
  reported as possibly still running on the org — check its Deployment Status — instead of
  a plain failure that invites a conflicting retry.
- Fixed: **Failures during the automatic Fetch Org raise a notification** instead of landing
  silently in a hidden panel, so expired auth is visible again.
- Changed: **Safety settings are machine-scoped.** `ignoreDeployConflicts` and
  `fetchConcurrency` can no longer be overridden by a repository's committed
  `.vscode/settings.json`.

## 0.8.0

- New: **The Status pane is now your deployment history.** Result cards — deploys,
  validations, retrieves, diffs, successes and failures with their full details — carry a
  timestamp and survive window reloads: the last 50 operations per workspace stay in the
  pane, newest first. **Clear** wipes the history too.
- New: **Org badges appear on their own.** The panel runs Fetch Org automatically once per
  session when it first opens, so local/org badges and org-only components show up without
  a manual click. New setting `sfOrgDeployWrapper.fetchOrgOnOpen` (on by default) turns it
  off; later refreshes and org switches stay manual.
- New: **Nearly twice the metadata coverage.** Fetch Org now covers 86 metadata types (was
  45), curated from the sf CLI's own registry — including OmniStudio (OmniScripts,
  Integration Procedures, DataRaptors, FlexCards), Reports and Dashboards (with folder
  support), approval processes, duplicate/assignment/sharing rules, connected apps,
  permission set groups, platform events and more. Beyond the list, every metadata type
  found in your workspace is now always fetched — so components of brand-new or unusual
  types get their badges without waiting for a plugin update.

## 0.7.0

- New: **Three tree views — All, Selected, Changed.** Tabs above the search box switch the
  tree between everything, your current pick list, and the components whose files have
  uncommitted git changes (new files included) — the "what do I need to deploy" view.
  Checkboxes are one selection everywhere: tick things in Changed, prune them in Selected,
  deploy from any tab. Changed refreshes on every file save and says why when git can't
  answer; deleted files aren't listed (deploys can't delete). The selected-chips tray is
  replaced by the Selected view — unchecking there keeps the row visible until you re-enter
  the tab, so an accidental untick is one click to undo and double-click-to-open stays safe.
- New: **Smarter search.** Word tokens match in any order (`acc trig`), camelCase initials
  work (`avt` finds `AccountValidationTrigger`), and `type:flow` / `t:field` narrows by
  metadata type.
- Fixed: **Failure notifications lead somewhere useful.** The error toast now offers
  **Show Panel** — the status card with the full per-component and test failures — alongside
  Show Output, and those failure details are now also written to the output channel, which
  previously contained nothing about a failed deployment. The last result card is replayed
  when the panel opens, so a failed right-click deploy with the sidebar closed no longer
  vanishes without a trace.
- Fixed: **Rescan always rescans.** Clicking it while a scan was already running silently
  joined that scan; it now queues a fresh one. Toolbar buttons locked during an operation
  explain why in their tooltip.

## 0.6.5

- Fixed: **Right-click deploys no longer stall in a fresh window.** Deploy, Retrieve and
  Compare from the Explorer or editor context menu used to run the panel's full workspace
  type-resolution (one `sf` call per unrecognized folder, up to 30 seconds each) before
  showing the org confirmation — in a new VS Code session this looked like the extension
  hanging, with only "Resolving metadata types" popups for feedback. Context-menu actions
  now do a fast local scan and resolve only the file you clicked, so the confirmation
  appears right away.
- Fixed: **Folders that fail type resolution are remembered between sessions.** Previously
  only successful lookups were cached, so every new window re-paid the slow failing ones.
  Failures now follow the same `typeCacheDays` cache; **Refresh Files** clears it and
  retries everything.
- Fixed: **Concurrent scans no longer double up.** Opening the panel while a context-menu
  action is already scanning shares the one scan instead of spawning duplicate `sf`
  processes and stacked progress notifications.

## 0.6.4

- New: **Open in Org.** Right-click a component → "Open in Org" opens its page in the org in
  your browser (flows, objects, classes, permission sets, …). Types without a mapped Setup
  page open the org home instead. One component at a time; org-only rows need a retrieve
  first (the link is derived from the local file).
- New: **Double-click a tree row to open its source file** in the editor. The checkbox
  selection is left unchanged; org-only rows point to Retrieve instead.
- Changed: **Failures notify like the rest of VS Code.** The full-width red error block at
  the bottom of the panel is gone — it duplicated the status card and could cover half the
  panel. Failed deploys, validations and retrieves now raise a standard VS Code error
  notification with a **Show Output** button, and the status card — now with its own
  **Copy** button — remains the detailed record.

## 0.6.3

- Fixed: **Org compare opens the right way around.** The diff shows the org's copy on the
  left (read-only) and your local file on the right, so the diff editor's copy-change arrows
  pull org-side changes into your local file. Previously the sides were reversed and the
  arrows copied local text into a throwaway temp file that never reached the org.
- Fixed: **The test-level picker applies to every deploy.** Deploys started from the tree's
  right-click menu or the editor context menu now honor the selected Apex test level —
  previously only the action bar's Deploy/Validate buttons did, and the other paths silently
  used the defaults. The picker's choice also survives closing and reopening the panel.
- New: **Validate from the right-click menu.** Tree rows, folders and the current selection
  offer check-only validation from the context menu, not just from the action bar.
- Fixed: commands started from the status bar, Command Palette, or editor context menu could
  fail without any message (for example when saving the org selection fails); they now show
  an error notification with a **Show Output** button.
- Improved: the "couldn't resolve metadata type" notice can be dismissed (✕) and stays
  dismissed until its content changes; banner side padding improved.
- Improved: starting an operation while another is running now tells you which one is
  running; the type filter reads "0 of N types" when None is selected.

## 0.6.2

- Fixed: **Type-resolution failures now say why.** When metadata types can't be resolved
  through the CLI registry, the notice shows the underlying CLI error (and a suggested fix,
  e.g. an outdated `sf` CLI) instead of only listing folder names and pointing at the
  output channel.
- Fixed: **Scan notices no longer overwrite org errors.** Type-resolution and workspace-scan
  notices had shared one banner slot with org errors — whichever came last hid the other.
  They now display independently.
- Improved: on the first CLI-related error of a session, the installed `sf` CLI version is
  logged to the output channel to make problem reports self-contained.

## 0.6.1

- Fixed: **Errors now tell you what went wrong.** When listing orgs fails, the panel banner
  shows the actual reason (plus a suggested fix where one is known — expired auth, CLI not
  installed, network, timeout) instead of just "see output channel", an error card with the
  full text appears in the panel, and a notification's **Show Output** button jumps straight
  to the extension's log.
- Fixed: **A failed settings write no longer looks like a failed org list.** If saving the
  selected org failed (for example an unwritable settings file), the panel wrongly reported
  "Failed to list orgs" and left the org dropdown empty and unusable. Listing and saving are
  now independent: the dropdown always fills from the successful listing, and the save error
  is reported as what it is.
- Fixed: **No more silent failures on panel actions.** An action that failed early — like an
  org selection that didn't stick — could previously fail with no message at all. Every
  panel action now reports its error.
- Fixed: **Warning banner readable in all themes.** The banner used a theme color pair that
  some themes render as near-white text on bright yellow; it now uses a matched
  high-contrast pair.
- Improved: **Tidier action bar.** The test-level picker sits on its own row, the
  Diff / Retrieve / Validate / Deploy buttons are evenly sized instead of wrapping raggedly,
  and Cancel is a single full-width button while an operation runs.

## 0.6.0

- New: **Any metadata type can now be deployed, retrieved and diffed.** Previously the
  extension recognized ~36 common types from a built-in list and rejected everything else
  ("not a recognized metadata file"). Unknown types are now resolved through the Salesforce
  CLI's own metadata registry (offline, no org call) — anything your installed `sf` CLI
  knows just works, including types Salesforce ships in the future. Newly resolved types
  appear in the file tree automatically.
- New: `sfOrgDeployWrapper.typeCacheDays` setting — how many days resolved type rules stay
  cached (default 7; 0 re-resolves every time).

## 0.5.0

- New: **Validate-only deploy.** A **Validate** button runs a check-only deploy
  (`sf project deploy validate`) that validates and runs Apex tests without deploying.
  A successful validation shows a **Quick Deploy** button on its status card that deploys
  the already-validated components without re-running validation or the tests.
- New: **Test level control.** A test-level selector on the action bar lets you choose the
  Apex test level for a deploy or validation (defaults to running local tests for
  production and validations, no tests for sandboxes).
- New: **LWC & Aura context menu.** Right-clicking a Lightning Web Component or Aura bundle
  file now shows the Deploy / Retrieve / Diff / Compare menu (the bundle deploy already
  worked; only the menu entry point was missing).
- Fixed: **Cancel now reaches the org.** Cancelling a deploy also asks the org to cancel the
  server-side deployment when its job id is known; otherwise the status card now says the
  org-side deploy may still complete, instead of implying it was fully stopped.
- Fixed: a second deploy/retrieve/diff started while a confirmation dialog was open could
  slip past the "already running" guard and run concurrently; operations now reserve the
  busy slot before any prompt.
- Internal: the Salesforce CLI wrapper and org handling now sit on the shared family core
  (fixes Windows `sf.cmd` launching and a few edge cases), and the target org is stored in
  the shared `skrety.salesforce.targetOrg` setting so it's shared across the Skrety SF
  plugins. Your previously remembered org is migrated automatically.

## 0.4.5

- Fixed: **Fetch Org** now always targets the org selected in the dropdown. On a fresh
  start it could fetch from your default org instead of the one you had just picked.
- New: **Clear** buttons on the Status and Command Log sections to wipe accumulated
  entries.
- The Command Log no longer grows tall enough to crowd out the component tree — it stays
  in a bounded, scrollable area at the bottom of the panel.

## 0.4.4

- The file tree now takes about three-quarters of the panel by default (was two-thirds),
  and the Status panel keeps a minimum height — expanding a large group can no longer push
  Status out of reach; the tree scrolls within its own area instead.
- Right-click a folder or a single component in the tree to **Deploy**, **Retrieve**, or
  **Diff** it directly, without ticking checkboxes first. When components are checked, the
  menu adds a **Selected (N)** section that acts on the whole selection.

## 0.4.3

- New: **Deploy, retrieve, and compare files anywhere.** Right-clicking a Salesforce
  source file now works even when it lives outside the default package directory — the
  file you point at is deployed, retrieved, or compared directly, instead of being
  rejected as "not under a package directory".
- New: **Selected components tray.** Checked components appear as removable chips pinned
  above the file tree, so your current selection is always visible. Click a chip's ✕ (or
  untick it below) to drop it — the tree stays put, nothing jumps around.
- New: **Open comparisons in a separate window.** Org-comparison diffs can pop into their
  own window so you can read them next to your code; toggle with the new
  `sfOrgDeployWrapper.openDiffInFloatingWindow` setting (on by default).
- Faster org list: the org picker no longer waits on a per-org connection check, so it
  loads near-instantly and reliably remembers your last selected org.
- The file tree and Status panel now stack as two rows, giving each the full sidebar
  width instead of splitting it into two cramped columns.

## 0.4.2

- New: **Resize the Status panel.** Drag the divider between the file tree and the
  Status panel to give status messages more room — whether the two are shown
  side-by-side or stacked in a narrow sidebar. The size is remembered across
  reloads; double-click the divider to reset it.
- New: **Full-width error bar.** When an operation fails, the error is also shown
  across the full width of the panel, above the command log, where long messages
  are far easier to read — with a one-click **Copy** button. Dismiss it manually,
  or it clears when the next operation starts.
- Errors now surface the Salesforce CLI's own suggested next steps when it provides
  them, and colour codes are stripped so messages read cleanly. Long error text now
  scrolls within its card instead of stretching the panel.

## 0.4.1

- Add a branded extension icon — shown on the Marketplace listing and the activity-bar.

## 0.4.0

- New: **Browse org metadata.** A "Fetch Org" button lists every component on the
  selected org — not just what's already in your workspace — across ~40 metadata
  types. Each row is badged **local**, **org**, or **local+org**, with a source
  filter to show only what's missing locally, only what's on the org, or both.
  Components that exist only on the org can be selected and retrieved directly;
  once retrieved they flip to "local+org". Deploy and Diff stay limited to
  components you have locally.
- Folder-based email templates are now included in the org listing (they were
  previously skipped because folder metadata needs to be enumerated separately).
- Installed managed-package components are hidden from the org listing by default
  to keep the tree readable; enable `sfOrgDeployWrapper.fetchIncludeManaged` to
  show them.
- Fetch Org now reports a real error if it can't reach the org (expired auth,
  wrong org, network) instead of silently showing an empty result, and warns when
  some metadata types fail to list. If a connection drops part-way through, the
  listing is flagged as incomplete so the source badges aren't trusted as
  exhaustive.
- The org switcher and Fetch/Rescan buttons are locked while an operation is
  running, so an in-flight fetch can't be applied to the wrong org after a switch.
- Performance: the org listing is fetched with a bounded number of parallel CLI
  calls (`sfOrgDeployWrapper.fetchConcurrency`, default 5), and the tree caps how
  many rows it paints at once so large orgs stay responsive — narrow with the
  filter to see more.

## 0.3.2

- Fixed a regression in 0.3.1: "Compare with Org" reported layouts and other
  single-file metadata (permission sets, FlexiPages, custom apps, …) as "not on
  the org" even when present. The org copy was being looked up in the wrong
  folder of the retrieve; it's now located by file name anywhere in the
  retrieved tree, so every supported type is matched. Object-child diffs
  (custom fields, validation rules, …) were unaffected.

## 0.3.1

- Fixed: "Compare with Org" wrongly reported some components as "not on the
  org" — most visibly layouts on custom metadata types
  (`SomeType__mdt-Some Layout`). The diff now fetches the org copy with a
  source-format retrieve, the same mechanism the standard Salesforce extension
  uses, instead of a metadata-format retrieve that silently returned nothing for
  these components. As a side effect the separate metadata-to-source conversion
  step is gone, so object-child diffs do one less round-trip.
- The panel no longer reloads the org and metadata lists from scratch each time
  you switch to another activity-bar view and back — the view keeps its state
  while hidden.

## 0.3.0

- Clear errors for CLI-level failures: expired auth, source conflicts, and
  similar errors now surface the sf CLI's own message (with an actionable hint)
  instead of being misreported as "component not found on the org".
- Faster diff for Apex classes, triggers, Visualforce pages and components: the
  org copy is fetched with a single Tooling API query instead of a Metadata API
  retrieve. Falls back to retrieve for managed/ambiguous components.
- Live progress: a spinner card in the panel shows the current phase
  (querying / retrieving / converting) with elapsed time, plus a cancellable
  VS Code progress notification — so context-menu operations give feedback even
  with the panel closed, and successes show a status-bar confirmation.
- Retrieve results now include the org's own messages (e.g. "entity not found")
  on the status card.
- UI polish: fixed the misaligned type-filter disclosure arrow and checkbox
  rows; status cards gained kind icons and collapse past 8 lines ("Show all");
  command-log durations display as seconds; a ✕ button clears the selection;
  the tree/status split stacks vertically in narrow sidebars.
- Fixed: diffing an EmailTemplate (`Folder/Name`) failed when staging the org
  copy for comparison.

## 0.2.0

- Decomposed object children are now first-class: custom fields, validation
  rules, record types, list views, field sets, compact layouts, web links,
  business processes, indexes, and sharing reasons can be retrieved, deployed,
  and diffed individually — including children on standard objects, not just the
  whole object bundle.
- Child diffs compare source-to-source (the org copy is converted to source
  format first); conversion failures or cancellation are reported instead of
  shown as a misleading empty diff.
- More single-file metadata types supported: Lightning pages, apps, quick
  actions, custom permissions, named credentials, external data sources, remote
  site settings, roles, settings, Lightning message channels, and Apex test
  suites.
- New nested tree view: Objects → object → child-type groups → items, with
  cascading select-all. Non-object types remain flat type groups.

## 0.1.3

- Deploy, retrieve, and diff Salesforce metadata against any authenticated org
  from a sidebar panel.
