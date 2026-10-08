# SF Org Deploy Wrapper

A convenient sidebar for deploying, retrieving, and diffing Salesforce metadata against any authenticated org — without leaving VS Code.

## Features

- Pick any authenticated `sf` org from a dropdown (with `[PROD]` / `[SBX]` / `[SCR]` badges).
- Tree of workspace metadata grouped by type (Apex, LWC, Aura, Flows, Layouts, PermissionSets, EmailTemplates, …).
- Three tree views: **All**, **Selected** (your current pick list, navigable), and
  **Changed** — what this branch has done: your uncommitted edits at the top, then one
  collapsible section per commit that no other branch has, so a commit (or a push) no
  longer empties the view. Deleted files aren't listed; deploys can't delete. It follows
  your saves as they happen; no re-entering needed, and the header label switches the
  comparison (this branch, any ref, or uncommitted only).
- Smart search: word tokens in any order (`acc trig`), camelCase initials (`avt` finds
  `AccountValidationTrigger`), a type qualifier (`type:flow`, `t:field`), and a pasted list —
  `AccountService, ContactHandler`, one name per line, or a deploy error's rows as they come
  (paths, `.cls` / `-meta.xml` tails and the error text around a name are ignored) shows
  exactly those, so nothing needs ticking one by one; a single line is read the same way,
  alongside the ordinary search — plus the
  type-filter dropdown, with persisted state across reloads — All / None buttons stay
  above the list, each row has an *only* shortcut, and Select all / Expand all /
  Collapse all sit above the tree. OmniStudio types answer to their designer names too (`flexcard`,
  `dataraptor`, `integration procedure`).
- One-click **Deploy**, **Retrieve**, **Diff** against the selected org.
- Modal confirms before destructive ops, plus a hard **PROD** guard.
- Right-click any metadata file in the explorer for Deploy / Retrieve / Diff.
- Status-bar org indicator, a Status pane with your last runs (see below), command log with timings.
- Progress in the status bar and the panel — no notification pinned over the editor — and a Cancel button in the panel for long-running deploys/retrieves.
- **Validate** runs the test level you pick, none included: with no tests it is a check-only `sf project deploy start --dry-run`; with tests it is `sf project deploy validate`, the kind that can be quick-deployed.

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

## Translations & profiles

A profile, an org-wide translation (`translations/pl.translation-meta.xml`) and an object
translation (`objectTranslations/Product2-pl/`) are not stored on the org as files: the org
builds them on request, and fills in only the parts that describe components named in the SAME
request. Retrieved alone, `Profile:Admin` comes back with its user permissions and nothing else,
and `Translations:pl` as an empty stub — overwriting a complete local file. So Retrieve and Diff
send these types together with their **companions**: an object translation with its object (and
its layouts and quick actions), a translation with the labels, apps, tabs, flows, quick actions,
report types, home-page custom links, bots and in-app guidance prompts it translates, a profile
with the objects, fields, classes, pages, apps, tabs, layouts, custom permissions, flows and
external data sources it grants access to (custom metadata types come with their objects).

The companions go to a temporary project and are never written to yours — only the profile or
translation itself is copied back (an object translation folder is merged: files the org sent
are overwritten, a file only you have is kept). For a translation or a profile **you choose what
rides along**, per type: before the retrieve (or diff) a picker lists each companion type twice
— *this project's (N)*, the ones you have, by name, and *all on the org*, everything of that
type (slower on a big org) — and the labels once. There is one picker for all the profiles you
selected and one for all the translations, however many files. The first time every *this
project's* row is ticked, so Enter fetches the files for what your project has; your choice is
remembered for each of those files and ticked again next time (an empty choice is not
remembered); Escape cancels the whole retrieve or diff before anything is fetched. Tick both
rows of a type and the org row wins; tick neither and that type is left out. Files with
different choices are fetched in separate requests, so each comes back with exactly what was
ticked for it. The confirm dialog, the run and a diff's card say what each file was fetched with
and what was left out — `Translations:pl: fetched with the labels, 11 tabs (project), all flows
on the org — apps, quick actions, report types, custom page links, bots and prompts left out` —
and call it complete only when every type came whole from the org (a profile's standard objects
such as Account need **Fetch Org** for that: a wildcard can't name them). With
`sfOrgDeployWrapper.contextCompanionPrompt` at `remembered` the picker asks once per file. An
object translation needs no picker: it always brings its object and that object's layouts and
quick actions (from the Fetch Org list, or the project's without it). Object translations are
listed in the tree as one folder each, and deploy, validate and diff like any other component; a
diff opens only the files that differ. Deploy and validate need no companions — the full local
file is sent.

## Deploy File + Dependencies

Right-click an Apex class/trigger, an LWC or Aura bundle, or a Visualforce page/component
(also on the command palette, and on an explorer multi-selection of up to 20 files) for
**SF Deploy: Deploy File + Dependencies**. It reads the file's own source for references to
other workspace components — Apex classes it calls, custom objects/fields it touches, child
LWC/Aura bundles, message channels, static resources, Visualforce controllers/extensions —
and deploys the whole local closure as ONE deploy, instead of failing layer by layer and
being patched one failure card at a time. Best-effort, not a parser: a false positive just
deploys an unchanged copy of an unrelated component (harmless), and a miss falls back to the
usual failure card. The confirm modal names how many components were auto-included on top of
what you picked (and why, for the first few); the result card lists every one of them with
the component whose source pulled it in. `sfOrgDeployWrapper.dependencyMaxDepth` and
`sfOrgDeployWrapper.dependencyMaxComponents` bound how far and how wide the scan goes.

## Status pane

Every deploy, validation, quick deploy and retrieve is a **run** in the Status pane from the
moment you confirm it: what it sends, what it skips and why, and progress bars for components
and tests while the org works. The org's answer lands on the same card — every component
deployed, failed, rolled back, validated or retrieved, with file:line links to the failures.
The counts above the list filter it, a search box narrows a long one, and a run of ten
thousand components stays quick to scroll.

The newest run carries the actions: Retry (and Retry + overwrite after a source conflict), Try with
dependencies, Quick Deploy after a validation that ran tests, Run tests after a deploy that sent
Apex (with **SF Test Runner** installed; it locks until the result arrives — the toolbar has the
same button for whatever Apex is selected), Resume monitoring after lost contact, Restore / Discard
backup after a retrieve, Select (ticks the listed rows in the tree) and Copy. Older runs are
one-line summaries under **Earlier** in the pane's header — you can open and copy them, but they
have no buttons; an older retrieve's backup is still restorable with **SF Deploy: Restore Retrieve
Backup**. Other results (diff, delete, Fetch Org…) are short notices in the same history.

The pane keeps your last `sfOrgDeployWrapper.statusHistoryRuns` runs (default 3) across
reloads, the newest with its full list, and as many notices beside them. Quick Deploy is
offered until the window reloads. If the window reloads while a deploy runs, the panel picks
the job up again and finishes the same run.

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
- `sfOrgDeployWrapper.orgCacheMaxAgeHours` — how long (hours, default 168 — a week) the remembered per-org listing counts as fresh: the panel opens on it instantly ("org as of HH:MM"), only an older one is re-fetched in the background, and Fetch Org always re-lists.
- `sfOrgDeployWrapper.typeCacheDays` — how many days (default 7) to cache metadata-type rules learned from the `sf` CLI registry, and how long a folder that failed resolution is remembered as a lost cause. 0 disables both caches.
- `sfOrgDeployWrapper.changedBaseRef` — what the **Changed** view compares against. `auto` (the default) shows your uncommitted edits plus the commits no other branch has, one collapsible section per commit — so work stays listed after a commit and after a push, whatever the integration branch is called. On a checkout with no other branch to compare against, or one more than 100 commits ahead, it falls back to uncommitted-only and says so in the header; standing on the integration branch itself reads its own commits as this branch's work — commits you didn't write are labelled with their author, and you can pick a ref instead. Set a git ref (e.g. `main`, `origin/devInt`) to show everything that differs from it instead, or empty for uncommitted changes only. The label in the Changed view's header switches it.
- `sfOrgDeployWrapper.openDiffInFloatingWindow` — pop org-comparison diffs into their own OS window (default on). Turn off to keep them as diff tabs in the main window.
- `sfOrgDeployWrapper.diffEditorCap` — how many diff editors one Diff may open (default 10, 1–100). Everything selected is compared with the org first and only files that differ get an editor; identical files (line endings ignored) are counted on the result card, and differing files past the cap are listed there as "differs (not opened)".
- `sfOrgDeployWrapper.contextCompanions` — Retrieve and Diff of a profile, an org-wide translation (`translations/pl.translation-meta.xml`) or an object translation also ask the org for the components it describes, so it comes back filled in (default on). The companions land in a temporary project and are never written to yours; only the profile or translation is copied back. Off: these types are retrieved alone, nearly empty, with no picker, and the result says so. See **Translations & profiles** above.
- `sfOrgDeployWrapper.contextCompanionPrompt` — when the companion picker for translations or profiles appears (one picker for all the selected profiles, one for all the translations): `always` (default) — before every Retrieve and Diff of them, ticked as you last chose (when all the selected files of that type chose the same; first time: everything this project has), so Enter repeats it; `remembered` — only until every selected file of that type has a remembered choice, and each file's own is then used without asking (the confirm dialog and the result still name it; a remembered row that no longer exists brings the picker back; an empty choice is never remembered). Escape in the picker cancels the whole retrieve or diff.
- `sfOrgDeployWrapper.defaultTestLevel` — the Apex test level preselected in the panel's picker and used by context-menu/editor deploys before the picker is touched this session. Empty by default (smart default: `RunLocalTests` in production, `NoTestRun` in a sandbox).
- `sfOrgDeployWrapper.backupBeforeRetrieve` — back up local files before a retrieve overwrites them (default on), restorable via **SF Deploy: Restore Retrieve Backup**. The last 5 backups per workspace are kept; a retrieve is aborted if its backup can't be written.
- `sfOrgDeployWrapper.syncOrgWithFamily` — follow and publish the Salesforce org shared across the Skrety SF plugins via `skrety.salesforce.targetOrg` (default off — this plugin keeps its own org, remembered per VS Code window).
- `sfOrgDeployWrapper.debugTiming` — log click-to-modal timing to the **SF Deploy** Output channel, to diagnose a slow confirmation dialog (default off).
- `sfOrgDeployWrapper.dependencyMaxDepth` — how many reference layers **Deploy File + Dependencies** follows below the file(s) you picked (default 2, 1–3).
- `sfOrgDeployWrapper.dependencyMaxComponents` — cap on how many components **Deploy File + Dependencies** may auto-include (default 40, 5–200).
- `sfOrgDeployWrapper.statusHistoryRuns` — how many deploy/validate/quick-deploy/retrieve runs the Status pane keeps across reloads, and how many other results (diff, delete, Fetch Org…) beside them (default 3, 1–10). The newest run is the full result; older ones are one-line summaries.
