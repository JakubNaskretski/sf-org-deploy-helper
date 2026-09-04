# SF Org Deploy Wrapper

A convenient sidebar for deploying, retrieving, and diffing Salesforce metadata against any authenticated org — without leaving VS Code.

## Features

- Pick any authenticated `sf` org from a dropdown (with `[PROD]` / `[SBX]` / `[SCR]` badges).
- Tree of workspace metadata grouped by type (Apex, LWC, Aura, Flows, Layouts, PermissionSets, EmailTemplates, …).
- Three tree views: **All**, **Selected** (your current pick list, navigable), and
  **Changed** — components whose files have uncommitted git changes, i.e. what you'd
  actually deploy (deleted files aren't listed; deploys can't delete).
- Smart search: word tokens in any order (`acc trig`), camelCase initials (`avt` finds
  `AccountValidationTrigger`), and a type qualifier (`type:flow`, `t:field`) — plus the
  type-filter dropdown, with persisted state across reloads — All / None buttons stay
  above the list, each row has an *only* shortcut, and Expand all / Collapse all sit
  above the tree. OmniStudio types answer to their designer names too (`flexcard`,
  `dataraptor`, `integration procedure`).
- One-click **Deploy**, **Retrieve**, **Diff** against the selected org.
- Modal confirms before destructive ops, plus a hard **PROD** guard.
- Right-click any metadata file in the explorer for Deploy / Retrieve / Diff.
- Status-bar org indicator, status card history, command log with timings.
- Cancel button for long-running deploys/retrieves.

## OmniStudio

Standard-runtime OmniStudio components as `sf` retrieves them — `omniScripts/*.os-meta.xml`,
`omniIntegrationProcedures/*.oip-meta.xml`, `omniDataTransforms/*.rpt-meta.xml`,
`omniUiCard/*.ouc-meta.xml` — show up in the tree and deploy, retrieve and diff like any other
type. Fetch Org can list them only on an org running the standard runtime with
**Setup → OmniStudio Settings → "Use OmniStudio Metadata API"** enabled; elsewhere the result
card names them under *Not available on this org*. Components delivered by a managed package
are hidden unless `sfOrgDeployWrapper.fetchIncludeManaged` is on (the card says how many, per
type). DataPack exports (`vlocity/`, `*_DataPack.json`) are data, not Metadata API source: the
scan flags them but cannot list them.

## Requirements

- Salesforce CLI (`sf`) installed and on `PATH`.
- At least one org authenticated via `sf org login web`.
- An opened folder containing exactly one Salesforce DX project somewhere below it
  (identified by `sfdx-project.json`). The project itself does not have to be the
  opened workspace folder.

## Settings

- `sfOrgDeployWrapper.commandTimeoutMs` — timeout for deploy/retrieve commands (default 180000).
- `sfOrgDeployWrapper.ignoreDeployConflicts` — pass `--ignore-conflicts` to deploys. **Off by default** so the CLI refuses to overwrite org-side changes that aren't in your local source. Also available as **Overwrite org changes** in the panel.
- `sfOrgDeployWrapper.fetchIncludeManaged` — include managed-package components when fetching org metadata (default off — they're read-only and add thousands of entries to the browse tree).
- `sfOrgDeployWrapper.fetchOrgOnOpen` — run Fetch Org automatically when the panel first opens (default on). A remembered listing is shown instantly and re-listed in the background only when stale — also after switching to an org whose remembered listing is stale; otherwise later refreshes stay manual via the Fetch Org button.
- `sfOrgDeployWrapper.fetchConcurrency` — how many metadata types Fetch Org lists in parallel (default 5, 1–12). Machine-scoped: lower it on a weaker machine, raise it on a capable one.
- `sfOrgDeployWrapper.orgCacheMaxAgeHours` — how long (hours, default 24) the remembered per-org listing counts as fresh: the panel opens on it instantly ("org as of HH:MM"), only an older one is re-fetched in the background, and Fetch Org always re-lists.
- `sfOrgDeployWrapper.typeCacheDays` — how many days (default 7) to cache metadata-type rules learned from the `sf` CLI registry, and how long a folder that failed resolution is remembered as a lost cause. 0 disables both caches.
- `sfOrgDeployWrapper.changedBaseRef` — when set (e.g. `main` or `origin/main`), the **Changed** view also shows components that differ from that git ref, not just uncommitted edits. Empty by default (uncommitted changes only).
- `sfOrgDeployWrapper.openDiffInFloatingWindow` — pop org-comparison diffs into their own OS window (default on). Turn off to keep them as diff tabs in the main window.
- `sfOrgDeployWrapper.defaultTestLevel` — the Apex test level preselected in the panel's picker and used by context-menu/editor deploys before the picker is touched this session. Empty by default (smart default: `RunLocalTests` in production, `NoTestRun` in a sandbox).
- `sfOrgDeployWrapper.backupBeforeRetrieve` — back up local files before a retrieve overwrites them (default on), restorable via **SF Deploy: Restore Retrieve Backup**. The last 5 backups per workspace are kept; a retrieve is aborted if its backup can't be written.
- `sfOrgDeployWrapper.syncOrgWithFamily` — follow and publish the Salesforce org shared across the Skrety SF plugins via `skrety.salesforce.targetOrg` (default off — this plugin keeps its own org).
