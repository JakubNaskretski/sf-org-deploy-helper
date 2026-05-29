# SF Org Deploy Wrapper

A convenient sidebar for deploying, retrieving, and diffing Salesforce metadata against any authenticated org — without leaving VS Code.

## Features

- Pick any authenticated `sf` org from a dropdown (with `[PROD]` / `[SBX]` / `[SCR]` badges).
- Tree of workspace metadata grouped by type (Apex, LWC, Aura, Flows, Layouts, PermissionSets, EmailTemplates, …).
- Free-text filter + type-filter dropdown, with persisted state across reloads.
- One-click **Deploy**, **Retrieve**, **Diff** against the selected org.
- Modal confirms before destructive ops, plus a hard **PROD** guard.
- Right-click any metadata file in the explorer for Deploy / Retrieve / Diff.
- Status-bar org indicator, status card history, command log with timings.
- Cancel button for long-running deploys/retrieves.

## Requirements

- Salesforce CLI (`sf`) installed and on `PATH`.
- At least one org authenticated via `sf org login web`.
- A workspace with an `sfdx-project.json` (or a `force-app/` directory).

## Settings

- `sfOrgDeployWrapper.commandTimeoutMs` — timeout for deploy/retrieve commands (default 180000).
- `sfOrgDeployWrapper.ignoreDeployConflicts` — pass `--ignore-conflicts` to deploys. **Off by default** so the CLI refuses to overwrite org-side changes that aren't in your local source.
