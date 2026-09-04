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
