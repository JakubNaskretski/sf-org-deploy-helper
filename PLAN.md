# SF Org Deploy Wrapper — Implementation Plan

Tasks from the post-build audit, grouped by priority. Each task is **self-contained** — an agent can pick one up without reading the others. Pick any T# block, follow the spec, run the verification.

**Repo:** `/Users/skrety/Desktop/Dev.nosync/Random/sf-org-deploy-wrapper`
**Run before/after any task:** `npm run compile` (must exit 0).

---

## Phase 1 — Safety (do these first, in any order)

### T1 — Drop `--ignore-conflicts` from deploy, gate behind a setting

**Why:** Today every deploy silently overwrites org-side changes since the last retrieve. This is the opposite of what a VCS-style wrapper should default to. A misconfigured user could wipe a teammate's prod hotfix with one click.

**Files:**
- [src/sfCliService.ts](src/sfCliService.ts) — `deployMetadata`, line ~100 (`'--ignore-conflicts'`)
- [package.json](package.json) — `contributes.configuration.properties`
- [src/panelProvider.ts](src/panelProvider.ts) — call site in `runDeploy`

**Changes:**
1. Remove `'--ignore-conflicts'` from the default `args` array in `deployMetadata`. Change its signature to accept `opts: { ignoreConflicts?: boolean }` and only push the flag when true.
2. Add a new setting in `package.json`:
   ```jsonc
   "sfOrgDeployWrapper.ignoreDeployConflicts": {
     "type": "boolean",
     "default": false,
     "description": "Pass --ignore-conflicts to sf project deploy start. Off by default: the CLI will refuse to overwrite org changes that aren't in your local source."
   }
   ```
3. In `runDeploy`, read the setting and pass it through.

**Verification:**
- `npm run compile` clean.
- Manually: in extension dev host, modify a class on the org via Setup, change it locally too, hit Deploy. Expect failure with conflict message in the status card. Toggle setting on, retry, expect success.

---

### T2 — Add modal confirm + prod-org guard to deploy

**Why:** Retrieve has a modal confirm but deploy doesn't. Deploys can be destructive (especially to prod) and need a friction step. The standard SF extension does the same.

**Files:**
- [src/panelProvider.ts](src/panelProvider.ts) — `runDeploy`, top of function (around line 175)
- [src/sfCliService.ts](src/sfCliService.ts) — `OrgInfo` already has `instanceUrl`; surface a helper `isLikelyProduction(org)`.

**Changes:**
1. Add a helper (in `panelProvider.ts` or `sfCliService.ts`):
   ```ts
   function isLikelyProduction(org: OrgInfo | undefined): boolean {
     const url = org?.instanceUrl ?? '';
     // sandboxes have ".sandbox." in their My Domain URL; prod doesn't.
     // scratch orgs match *.scratch.my.salesforce.com — treat as non-prod.
     return /\.my\.salesforce\.com$/i.test(url) && !/sandbox|scratch/i.test(url);
   }
   ```
2. In `runDeploy`, before launching, look up the selected org's `OrgInfo` from `this.orgs`. Show a modal:
   - **Non-prod:** `Deploy N component(s) to <alias|username>?` → buttons `Deploy`, `Cancel`
   - **Prod:** `⚠ Deploy N component(s) to PRODUCTION (<alias|username>)?\n\nThis change will be live immediately.` with `detail` showing the instanceUrl, button label `Deploy to PROD`.
3. Bail out if user dismisses.

**Verification:** Click Deploy → modal appears; clicking outside cancels (returns nothing); clicking primary proceeds. With a `*.my.salesforce.com` org (no "sandbox" in URL), the prod variant fires.

---

### T3 — Fix diff temp-file cleanup (real leak)

**Why:** Two bugs in [src/panelProvider.ts](src/panelProvider.ts):
- `stageDiffCopy` (line ~476) creates a **second** tmpdir under `os.tmpdir()/sf-diff-stage-*` per item that is **never cleaned up**. Every diff leaves files in `/tmp` indefinitely.
- `scheduleTmpCleanup` (line ~489) polls `visibleTextEditors` for paths under `tmpRoot`, but the diff editor points at the *staged copy* (different tmpdir). So `stillOpen` is always `false`, `tmpRoot` is wiped on the first 10s tick, and the leak is invisible.

**Files:**
- [src/panelProvider.ts](src/panelProvider.ts) — `runDiff`, `stageDiffCopy`, `scheduleTmpCleanup`

**Changes:**
1. Replace `scheduleTmpCleanup`'s polling with an event-driven cleanup:
   ```ts
   function scheduleTmpCleanup(paths: string[]): void {
     const targets = paths.map(p => path.normalize(p));
     const cleanup = () => Promise.all(targets.map(t => fs.rm(t, { recursive: true, force: true }))).catch(() => undefined);
     const disposable = vscode.window.onDidChangeVisibleTextEditors(editors => {
       const stillOpen = editors.some(e => targets.some(t => path.normalize(e.document.uri.fsPath).startsWith(t)));
       if (!stillOpen) { disposable.dispose(); clearTimeout(hardCap); cleanup(); }
     });
     const hardCap = setTimeout(() => { disposable.dispose(); cleanup(); }, 10 * 60_000);
   }
   ```
2. In `runDiff`, accumulate the list of tmp paths created — both `tmpRoot` and every `stageDiffCopy` dir. Pass the array to `scheduleTmpCleanup`.
3. Make `stageDiffCopy` return the *directory* it created (not just the file path) so the cleanup list can include it.

**Verification:**
- Run a diff, close the diff editor, wait a few seconds: both `sf-deploy-diff-*` and `sf-diff-stage-*` folders gone from `/tmp` (check with `ls /tmp | grep sf-`).
- Run a diff, leave it open: no cleanup happens (verify the folders persist while the editor is visible).

---

### T4 — Disable diff for bundle/object types until source-format retrieve is wired

**Why:** `--target-metadata-dir --unzip` retrieves MDAPI format. For `ApexClass`/`ApexTrigger`/`Flow` the content is byte-identical to source format → diff works. For `CustomObject` (one fat XML in MDAPI vs many files in source format) and LWC/Aura bundles, the diff is misleading or just shows the wrong file. Better to fail loudly than mislead.

**Files:**
- [src/panelProvider.ts](src/panelProvider.ts) — `runDiff`
- [src/panel.js](src/panel.js) — optionally gray-out the Diff button when only unsupported types are selected (nice-to-have)

**Changes:**
1. Define a constant in `panelProvider.ts`:
   ```ts
   const DIFF_UNSUPPORTED = new Set(['CustomObject', 'LightningComponentBundle', 'AuraDefinitionBundle', 'StaticResource']);
   ```
2. In `runDiff`, partition `items` into `diffable` and `unsupported`. For each unsupported, append a `warn` line: `— ${type}:${name} — diff not supported for this metadata type yet`. Only attempt the retrieve+diff for `diffable`. If `diffable` is empty, return early with a warn card.
3. (Optional, T4b) In `panel.js`, when the selected set is entirely unsupported types, disable the Diff button and tooltip "Diff not supported for selected metadata types".

**Verification:** Select an LWC bundle + an ApexClass, click Diff. Status card shows: opened diff for the class, warn line for the LWC.

---

## Phase 2 — Correctness / convenience

### T5 — Mutex deploy/retrieve/diff to prevent overlapping `sf` runs

**Why:** `this.busy` only disables the webview buttons. The command palette commands and any future entry points can still trigger `runDeploy/Retrieve/Diff` while another is running, causing parallel `sf` spawns (slow, confusing, possibly conflicting).

**Files:**
- [src/panelProvider.ts](src/panelProvider.ts)

**Changes:**
1. At the top of each of `runDeploy`, `runRetrieve`, `runDiff`, add:
   ```ts
   if (this.busy) { vscode.window.showInformationMessage('Another operation is already running.'); return; }
   ```
2. Make `setBusy(true)` the first thing after the guard (so a re-entry can't slip in before `this.busy = true`).

**Verification:** Trigger Deploy from the panel, immediately trigger Retrieve from the command palette. Second call shows the info toast and returns.

---

### T6 — Surface "Show Output" action on error toasts

**Why:** `output.appendLine` captures stderr but the user has no quick path from the error toast to the output channel. They see the toast, dismiss it, and the context is gone.

**Files:**
- [src/panelProvider.ts](src/panelProvider.ts) — `reportError`

**Changes:**
```ts
const choice = await vscode.window.showErrorMessage(`SF Deploy: ${action} failed. ${message}`, 'Show Output');
if (choice === 'Show Output') this.output.show(true);
```

**Verification:** Force a failure (e.g. logout from sf CLI, try Deploy). Toast shows "Show Output" button. Click → output channel opens.

---

### T7 — Cancel button for long-running deploys

**Why:** Deploys routinely take minutes. Currently no abort path; if the user picks the wrong org they have to wait for completion (or kill the window).

**Files:**
- [src/sfCliService.ts](src/sfCliService.ts) — `run` and `deployMetadata`/`retrieveMetadata`
- [src/panelProvider.ts](src/panelProvider.ts)
- [src/panel.js](src/panel.js)
- [src/panelHtml.ts](src/panelHtml.ts)

**Changes:**
1. Refactor `SfCliService.run` to return `{ promise, cancel: () => void }` where `cancel` calls `child.kill('SIGTERM')` (and a fallback `SIGKILL` after 5s).
2. Plumb the cancel handle through `deployMetadata` / `retrieveMetadata` and store on the provider as `this.currentCancel?: () => void`.
3. In `panel.js`, when `busy: true` is received, swap the action buttons for a single red "Cancel" button. Wire it to send `{ type: 'cancel' }`.
4. Provider handler: `if (this.currentCancel) this.currentCancel();`. On cancellation, emit a status card `{ kind: 'warn', title: '<action> cancelled' }`.

**Verification:** Start a deploy, click Cancel mid-run. `sf` process exits, status card shows cancelled, busy clears.

---

### T8 — Open N diff editors safely

**Why:** Selecting 30 classes and clicking Diff currently opens 30 editor tabs back-to-back. Either annoying or dangerous (sluggish window).

**Files:**
- [src/panelProvider.ts](src/panelProvider.ts) — `runDiff`

**Changes:**
1. If `diffable.length > 5`, show a modal `vscode.window.showWarningMessage` with detail "About to open N diff editors. Continue?" and buttons `Open All` / `First 5` / `Cancel`.
2. Slice accordingly.

**Verification:** Select 6+ Apex classes, click Diff, pick "First 5". Five diff editors open.

---

### T9 — Persist webview state across reloads

**Why:** Expanded groups, search filter text, and scroll position reset every time the panel is recreated (window reload, panel collapse/expand). Annoying for a sidebar you use frequently.

**Files:**
- [src/panel.js](src/panel.js)

**Changes:**
1. Use the `vscode` API already acquired: `vscode.getState()` / `vscode.setState({...})`.
2. On state changes (expand group, change filter, change cmdlog collapse), call `vscode.setState({ expandedGroups: [...state.expandedGroups], filter: state.filter, cmdLogCollapsed: state.cmdLogCollapsed })`.
3. On startup, hydrate from `vscode.getState()` before the first render.

**Verification:** Expand a group, type a filter, reload window (`Cmd+R` in dev host). State preserved.

---

### T10 — Explorer right-click → Deploy / Retrieve / Diff

**Why:** User explicitly asked for "as convenient as possible" file selection. Context-menu integration in the standard file explorer is the single biggest convenience win — no sidebar trip needed.

**Files:**
- [package.json](package.json) — `contributes.menus`, `contributes.commands`
- [src/panelProvider.ts](src/panelProvider.ts) — add public methods `deployFile(uri)`, `retrieveFile(uri)`, `diffFile(uri)`
- [src/extension.ts](src/extension.ts) — register commands

**Changes:**
1. Register three new commands in `package.json`:
   ```jsonc
   { "command": "sfOrgDeployWrapper.deployFile", "title": "SF Deploy: Deploy to Org" },
   { "command": "sfOrgDeployWrapper.retrieveFile", "title": "SF Deploy: Retrieve from Org" },
   { "command": "sfOrgDeployWrapper.diffFile", "title": "SF Deploy: Diff with Org" }
   ```
2. Add menu contributions:
   ```jsonc
   "menus": {
     "explorer/context": [
       { "command": "sfOrgDeployWrapper.deployFile", "when": "resourceExtname =~ /\\.(cls|trigger|page|component|flow-meta\\.xml|object-meta\\.xml|permissionset-meta\\.xml|profile-meta\\.xml|layout-meta\\.xml)$/ || resourceFilename =~ /-meta\\.xml$/", "group": "sfdeploy@1" },
       { "command": "sfOrgDeployWrapper.retrieveFile", "when": "...", "group": "sfdeploy@2" },
       { "command": "sfOrgDeployWrapper.diffFile", "when": "...", "group": "sfdeploy@3" }
     ],
     "editor/context": [ /* same three */ ]
   }
   ```
3. Provider methods: each takes a `vscode.Uri`, calls `findItemForPath(this.items, uri.fsPath)`, and reuses `runDeploy/runRetrieve/runDiff` with the single key. If `findItemForPath` returns nothing, toast "Not a recognized metadata source under workspace package directories."
4. Register the command handlers in `extension.ts`.

**Verification:** Right-click an `.cls` in the file explorer → see three new entries. Each fires the correct action. Right-click a `.md` README → entries hidden by `when` clause.

---

### T11 — Sandbox vs Production badge in org dropdown

**Why:** Helps catch "oops wrong org" before clicking deploy. Cheap to add since `OrgInfo.instanceUrl` is already in hand.

**Files:**
- [src/panelProvider.ts](src/panelProvider.ts) — `postOrgs`
- [src/panel.js](src/panel.js) — `renderOrgs`

**Changes:**
1. Extend the `OrgPayload` to include `kind: 'prod' | 'sandbox' | 'scratch' | 'other'`, computed from `instanceUrl` (reuse the `isLikelyProduction` helper from T2; sandbox URLs contain `.sandbox.`, scratch contain `.scratch.`).
2. In `renderOrgs`, prepend an emoji or `[PROD]` / `[SANDBOX]` tag to each option label. Don't use color (HTML `<select>` styling is limited cross-platform).

**Verification:** Dropdown shows `[PROD] myalias (user@example.com)` for production orgs.

---

### T12 — EmailTemplate folder structure

**Why:** Email templates live under `email/<FolderName>/<TemplateName>.email`, not flat in `email/`. Current scanner misses templates inside folders.

**Files:**
- [src/metadataScanner.ts](src/metadataScanner.ts) — `RULES` and `scanWorkspace`

**Changes:**
1. Either special-case `email` in the loop (walk one level of folders, then files inside), or add a `nested?: boolean` flag to `FolderRule` that triggers a two-level walk. For each found template, `name` should be `Folder/Template` (SF metadata fullName convention).

**Verification:** With an `email/Marketing/Welcome.email` file, the tree shows `EmailTemplate` group with `Marketing/Welcome` entry. Selecting and retrieving works.

---

## Phase 3 — Nice-to-haves (lower priority, ship if time)

### T13 — Status-bar org indicator
Add a `vscode.window.createStatusBarItem`. Text: `$(cloud) <alias-or-username>`. Click action: runs `sfOrgDeployWrapper.selectOrg`. Updates whenever `orgStore` changes.

**File:** [src/extension.ts](src/extension.ts) (or new `src/statusBar.ts`). Needs the `OrgStore` to expose a change event (currently it doesn't — add a `vscode.EventEmitter<string|undefined>` to `OrgStore` and fire on `set`).

---

### T14 — "Select all in group" indeterminate checkbox
In [src/panel.js](src/panel.js), add a checkbox to each group header. Clicking toggles all visible items in that group. Display indeterminate state when partially selected.

---

### T15 — Highlight currently-active editor file in tree
Listen to `vscode.window.onDidChangeActiveTextEditor` in the provider. Post `{ type: 'activeFile', key }` (already implemented) on every change. In `panel.js`, ensure the row gets the `focused` class — currently only set on explicit "Use active file" click.

---

### T16 — `workspaceContains:sfdx-project.json` activation
Add to `activationEvents` in [package.json](package.json) so the extension warms up (org list pre-fetch) the moment a SF project opens, instead of waiting for the sidebar icon click.

---

### T17 — Type-filter dropdown in tree toolbar
Add a multi-select dropdown above the metadata tree to filter by type (`ApexClass`, `Flow`, etc.). Free-text filter and type filter combine with AND.

---

## Suggested ordering for an agent fleet

- **Parallel-safe (no overlap):** T1, T2, T3, T6, T9, T11, T12, T13, T14, T16, T17
- **Touches `runDeploy/Retrieve/Diff`** — serialize these: T4 → T5 → T7 → T8
- **Touches webview wire format** — coordinate: T9, T14, T15 all edit `panel.js`; pick one agent per file or split by line range.

## Common verification checklist for any task

```bash
cd /Users/skrety/Desktop/Dev.nosync/Random/sf-org-deploy-wrapper
npm run compile          # must exit 0
# Then in VS Code: F5 to launch extension dev host
# Open an sfdx-project (e.g. one from ~/Desktop/Dev.nosync/Random/* if any has force-app/)
# Exercise the changed surface, watch for:
#   - status card matches expectations
#   - command-log entry has correct text + status dot
#   - output channel has stderr on failure
#   - no stray files in /tmp after a diff (T3 verification specifically)
```
