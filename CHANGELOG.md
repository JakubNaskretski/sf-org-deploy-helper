# Changelog

All notable changes to this extension are documented here.
This file starts at the current release; earlier history predates it.

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
