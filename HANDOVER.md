# Handover — T1 & T2 complete

**Date:** 2026-05-25
**Repo:** `/Users/skrety/Desktop/Dev.nosync/Random/sf-org-deploy-wrapper`
**Compile:** `npm run compile` exits 0.

---

## What was done

### T1 — `--ignore-conflicts` is now opt-in
- [src/sfCliService.ts](src/sfCliService.ts) — `deployMetadata` signature changed. Was `(metadata, targetOrg, cwd, timeoutMs?)`; now `(metadata, targetOrg, cwd, opts: { ignoreConflicts?: boolean; timeoutMs?: number })`. The flag is appended only when `opts.ignoreConflicts === true`.
- [package.json](package.json) — added setting `sfOrgDeployWrapper.ignoreDeployConflicts` (boolean, default `false`).
- [src/panelProvider.ts](src/panelProvider.ts) `runDeploy` — reads the setting via `vscode.workspace.getConfiguration(...)` and threads it into `deployMetadata`. The `beginCmd` log line also includes ` --ignore-conflicts` when on, so the command log faithfully reflects what ran.

**Default behavior is now safer:** a deploy that would overwrite org-side changes not in local source will be rejected by the CLI. Users who want the old behavior must opt in via setting.

### T2 — Modal confirm + prod-org guard on deploy
- [src/sfCliService.ts](src/sfCliService.ts) — added `isLikelyProduction(org: OrgInfo | undefined): boolean`. Logic: `instanceUrl` ends with `.my.salesforce.com` AND does **not** contain `sandbox` or `scratch` (case-insensitive). Lives on `SfCliService` per the plan's "or" option since `OrgInfo` is defined in the same module.
- [src/panelProvider.ts](src/panelProvider.ts) `runDeploy` — added a modal confirm before any work happens:
  - **Non-prod:** title `Deploy N component(s) to <alias|username>?`, button `Deploy`.
  - **Prod:** title prefixed `⚠`, body mentions `PRODUCTION` and immediate liveness, `detail` set to `instanceUrl`, button `Deploy to PROD`.
  - Bails on dismiss/cancel — no busy state, no command log entry written. The `beginCmd`/`setBusy(true)` only run after confirmation.

---

## How to verify manually

### T1
1. Open the extension dev host (F5).
2. Pick an org with at least one Apex class. Modify the class **both** on the org (via Setup) and locally.
3. Click Deploy. Expect failure — status card should show a conflict-related problem, command log entry should end without `--ignore-conflicts`.
4. Open settings, toggle `Sf Org Deploy Wrapper: Ignore Deploy Conflicts` on.
5. Click Deploy again. Expect success; command log entry now includes `--ignore-conflicts`.

### T2
1. With a sandbox/scratch org selected, click Deploy. Modal shows the standard wording, primary button is `Deploy`.
2. Click outside / press Esc — no work runs, no busy state, no command log entry.
3. With a production org selected (or any org whose `instanceUrl` matches `*.my.salesforce.com` and lacks `sandbox`/`scratch`), click Deploy. Modal title prefixed `⚠`, body mentions PRODUCTION, button reads `Deploy to PROD`, the `detail` line shows the instance URL.

---

## Files touched

- [src/sfCliService.ts](src/sfCliService.ts) — new `isLikelyProduction`; `deployMetadata` opts object.
- [src/panelProvider.ts](src/panelProvider.ts) — `runDeploy` confirm + setting wiring.
- [package.json](package.json) — new `sfOrgDeployWrapper.ignoreDeployConflicts` setting.

No other call sites of `deployMetadata` exist (grep `deployMetadata\(` returns only the one site in `panelProvider.ts`), so the signature change is contained.

---

## What's next from PLAN.md

Remaining safety tasks:
- **T3** — Diff temp-file cleanup (real leak; event-driven not poll-driven). Touches [src/panelProvider.ts](src/panelProvider.ts) only.
- **T4** — Disable diff for bundle/object types until source-format retrieve is wired. Touches [src/panelProvider.ts](src/panelProvider.ts) and optionally [src/panel.js](src/panel.js).

Phase 2 onward is in PLAN.md. The `isLikelyProduction` helper added here is also the dependency for **T11** (sandbox/prod badge in org dropdown).

---

## Notes for the next agent

- The plan's snippet for `isLikelyProduction` was placed on `SfCliService` (not a free function) so future tasks (T11) can call it directly via the injected service. If you'd rather have it free-standing, both the panel and the org-list path can import from the module.
- The confirm flow runs **before** `setBusy(true)` and `beginCmd`, so a cancelled confirm leaves zero side-effects (no flicker, no log noise). Preserve this if you refactor.
- Command-log text now reflects the actual flag set. If you change how flags are decided, keep that mirroring.
