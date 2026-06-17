# Changelog

All notable changes to this extension are documented here.
This file starts at the current release; earlier history predates it.

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
