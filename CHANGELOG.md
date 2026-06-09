# Changelog

All notable changes to this extension are documented here.
This file starts at the current release; earlier history predates it.

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
