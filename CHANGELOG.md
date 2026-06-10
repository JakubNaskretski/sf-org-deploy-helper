# Changelog

All notable changes to this extension are documented here.
This file starts at the current release; earlier history predates it.

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
