import * as vscode from 'vscode';
import { randomBytes } from 'crypto';

export function generateNonce(): string {
  // CSPRNG (not Math.random) so the CSP script nonce isn't predictable.
  return randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
}

export function getPanelHtml(webview: vscode.Webview, extensionUri: vscode.Uri, nonce: string): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'panel.js'));
  const runViewUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'runView.js'));
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>SF Deploy</title>
<style>
:root {
  --bg: var(--vscode-sideBar-background);
  --fg: var(--vscode-foreground);
  --muted: var(--vscode-descriptionForeground);
  --border: var(--vscode-panel-border);
  --accent: var(--vscode-button-background);
  --accent-fg: var(--vscode-button-foreground);
  --row-hover: var(--vscode-list-hoverBackground);
  --row-active: var(--vscode-list-activeSelectionBackground);
  --ok: var(--vscode-testing-iconPassed, #4caf50);
  --err: var(--vscode-testing-iconFailed, #f44336);
  --warn: var(--vscode-editorWarning-foreground, #cca700);
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--fg);
  background: var(--bg);
  display: flex; flex-direction: column;
  height: 100vh; overflow: hidden;
}
.toolbar {
  display: flex; gap: 6px; align-items: center;
  padding: 6px 8px; border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.toolbar select, .toolbar input, .toolbar button {
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, var(--border));
  border-radius: 2px;
  padding: 3px 6px;
  font-family: inherit; font-size: inherit;
}
.toolbar button.primary {
  background: var(--accent); color: var(--accent-fg);
  border-color: var(--accent); cursor: pointer;
}
.toolbar button:disabled { opacity: 0.5; cursor: not-allowed; }
.toolbar .grow { flex: 1; }
.toolbar .org { min-width: 0; flex: 1; }

/* Tree (top) and Status (bottom) stack as two rows so each gets the full sidebar
   width — a side-by-side split leaves both halves too cramped to read in a panel
   this narrow. Default split is 3:1 (tree gets ~3/4) since browsing the tree is the
   primary task; the splitter can override it. */
.body {
  flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden;
}
.left {
  flex: 3; display: flex; flex-direction: column; min-width: 0; min-height: 0;
  border-bottom: 1px solid var(--border);
}
/* The tree pane (.left) scrolls internally, so the Status pane keeps a guaranteed
   floor height — expanding a big group can never push Status out of reach. */
.right {
  flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 96px;
}
/* Draggable sash between the tree (top) and the Status pane (bottom). Sits over the
   1px border (negative margin) and is invisible until hovered/dragged, like VS Code's
   own sashes. The panel always stacks vertically, so this is a horizontal gutter. */
.splitter {
  flex: none; position: relative; z-index: 2;
  height: 6px; margin: -3px 0; cursor: row-resize;
  background: transparent; transition: background 0.1s;
}
.splitter:hover, body.resizing .splitter { background: var(--accent); opacity: 0.8; }
body.resizing { cursor: row-resize; user-select: none; }
.section-header {
  padding: 4px 8px; font-size: 11px; text-transform: uppercase;
  color: var(--muted); letter-spacing: 0.5px;
  display: flex; align-items: center; justify-content: space-between;
  cursor: pointer; user-select: none;
}
.section-header .caret { font-size: 9px; opacity: 0.7; }
.section-header .hdr-actions { display: flex; align-items: center; gap: 8px; }
.section-clear {
  background: transparent; border: none; color: var(--muted);
  cursor: pointer; font-size: 11px; font-family: inherit; padding: 0 2px;
}
.section-clear:hover { color: var(--fg); text-decoration: underline; }
.tree {
  flex: 1; overflow-y: auto; padding: 4px 0;
}
.tree-search {
  padding: 4px 8px; border-bottom: 1px solid var(--border);
}
.tree-search textarea {
  width: 100%; box-sizing: border-box; resize: none; overflow: hidden auto; display: block;
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 2px;
  padding: 3px 6px; font-family: inherit; font-size: inherit; line-height: 1.4;
}

/* View modes: All | Selected | Changed — one tree, three lenses (IntelliJ-style).
   Replaces the selected-chip tray: the Selected view IS the selection, fully
   navigable with live checkboxes, and Changed shows git-modified components. */
.view-modes {
  display: flex; gap: 2px; padding: 4px 8px 0 8px; border-bottom: 1px solid var(--border);
}
.view-modes button {
  flex: 1; background: transparent; border: none; border-bottom: 2px solid transparent;
  color: var(--muted); cursor: pointer; font-family: inherit; font-size: 12px;
  padding: 3px 4px 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.view-modes button:hover { color: var(--fg); background: var(--row-hover); }
.view-modes button.active { color: var(--fg); border-bottom-color: var(--accent); font-weight: 600; }
/* Slim per-mode header inside the tree (e.g. "5 selected — Clear all"). */
.mode-head {
  /* Label grows/ellipsizes on the left, buttons stay right — space-between would
     centre the middle button once there are two (Select all + Clear selection). */
  display: flex; align-items: center; gap: 8px; white-space: nowrap;
  padding: 2px 10px; font-size: 11px; color: var(--muted);
}
/* First child grows and ellipsizes — a span in most rows, the base-ref button in
   the Changed header. */
.mode-head > :first-child { flex: 1; overflow: hidden; text-overflow: ellipsis; text-align: left; }
.mode-head > button:first-child { text-decoration: underline dotted; }
.mode-head button {
  background: transparent; border: none; color: var(--muted); cursor: pointer;
  font-size: 11px; font-family: inherit; padding: 0;
}
.mode-head button:hover { color: var(--fg); text-decoration: underline; }
.mode-head button:disabled { opacity: 0.5; cursor: not-allowed; text-decoration: none; }
/* Expand all / Collapse all row above the tree (panel.js renderTreeTools). */
.tree-tools { border-bottom: 1px solid var(--border); padding: 3px 10px; }
/* Deploy-queue strip (Feature: deploy queue): one row per deploy/validate
   deferred behind the single busy slot, between the action bar and the Status
   pane. Rows reuse .mode-head itself (see panel.js renderQueue) rather than a
   parallel look; this rule only styles the CONTAINER. Hidden (toggled in JS)
   when the queue is empty. */
.queue-strip {
  display: none; flex-direction: column;
  border-top: 1px solid var(--border);
  padding: 2px 0;
}
.type-filter-row { margin-top: 4px; font-size: 11px; }
/* Custom disclosure caret: the native <summary> marker renders misaligned in the
   webview (pushed right), which made the whole filter list look skewed. */
.type-filter-row summary {
  cursor: pointer; color: var(--muted); user-select: none;
  list-style: none; display: flex; align-items: center; gap: 5px;
}
.type-filter-row summary::-webkit-details-marker { display: none; }
.type-filter-row summary::before { content: '▸'; font-size: 9px; opacity: 0.8; }
.type-filter-row details[open] summary::before { content: '▾'; }
.type-filter-list {
  margin-top: 4px; padding: 4px 4px;
  border: 1px solid var(--border); border-radius: 2px;
  max-height: 160px; overflow-y: auto;
  display: flex; flex-direction: column; gap: 2px;
}
.type-filter-list label { display: flex; gap: 6px; align-items: center; cursor: pointer; padding: 1px 2px; }
.type-filter-list input[type="checkbox"] { margin: 0; flex: none; width: 13px; height: 13px; }
/* One row per type: the checkbox label plus an "only" shortcut that shows on hover. */
.type-filter-list .type-row { display: flex; align-items: center; gap: 4px; }
.type-filter-list .type-row label { flex: 1; min-width: 0; }
.type-filter-list .type-only {
  visibility: hidden; flex: none; background: transparent; border: none;
  color: var(--muted); font-size: 10px; font-family: inherit; cursor: pointer; padding: 0 2px;
}
.type-filter-list .type-row:hover .type-only, .type-filter-list .type-only:focus { visibility: visible; }
.type-filter-list .type-only:hover { color: var(--fg); text-decoration: underline; }
.type-filter-actions { display: flex; gap: 6px; margin-top: 4px; }
.type-filter-actions button {
  background: transparent; color: var(--fg); border: 1px solid var(--border);
  border-radius: 2px; padding: 2px 6px; font-size: 11px; cursor: pointer;
  font-family: inherit;
}
.type-filter-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
.tree .group-header input[type="checkbox"] { margin: 0; }
.tree .row.active-editor { background: var(--row-active); }
.org-badge {
  font-size: 10px; padding: 1px 4px; margin-right: 4px;
  border-radius: 2px; border: 1px solid var(--border); color: var(--muted);
}
.tree .group { margin-bottom: 2px; }
.tree .group-header {
  padding: 3px 8px; font-weight: 600; cursor: pointer;
  display: flex; align-items: center; gap: 6px;
}
.tree .group-header:hover { background: var(--row-hover); }
/* Changed-view section header (Uncommitted / one per commit): a rule above it
   separates the sections without adding a row of its own. */
.tree .group.section > .group-header { border-top: 1px solid var(--border); }
.tree .group.section > .group-header > span:nth-of-type(2) { overflow: hidden; text-overflow: ellipsis; }
.tree .group-header .count { color: var(--muted); font-weight: normal; font-size: 11px; }
.tree .row {
  padding: 2px 8px 2px 28px; cursor: pointer;
  display: flex; align-items: center; gap: 6px;
  user-select: none;
}
.tree .row:hover { background: var(--row-hover); }
.tree .row.focused { outline: 1px dashed var(--muted); outline-offset: -1px; }
.tree .row input[type="checkbox"] { margin: 0; }
.tree .row .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree .row .badge {
  font-size: 10px; color: var(--muted); padding: 0 4px;
  border: 1px solid var(--border); border-radius: 2px;
}
.source-badge {
  font-size: 10px; padding: 1px 4px; margin-left: 2px;
  border-radius: 2px; border: 1px solid; font-weight: 500;
  flex-shrink: 0; letter-spacing: 0;
}
.source-badge.both { color: var(--ok); border-color: var(--ok); }
.source-badge.local { color: var(--warn); border-color: var(--warn); }
.source-badge.org {
  color: var(--vscode-editorInfo-foreground, #75beff);
  border-color: var(--vscode-editorInfo-foreground, #75beff);
}
.tree .row.org-only .name { opacity: 0.75; font-style: italic; }
/* Source filter + the snapshot's age side by side (Feature: org cache). */
#sourceFilterRow { align-items: center; gap: 6px; }
#sourceFilterRow select { flex: 1; min-width: 0; }
.org-as-of { flex: none; margin-top: 4px; font-size: 10px; color: var(--muted); white-space: nowrap; }
.tree-search select {
  width: 100%; margin-top: 4px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, var(--border));
  border-radius: 2px; padding: 2px 4px;
  font-family: inherit; font-size: inherit;
}

.actions {
  display: flex; gap: 6px; padding: 6px 8px;
  border-top: 1px solid var(--border);
  flex-wrap: wrap;
}
.actions button {
  background: var(--accent); color: var(--accent-fg);
  border: 1px solid var(--accent); border-radius: 2px;
  padding: 4px 10px; cursor: pointer;
  font-family: inherit; font-size: inherit;
}
.actions button.secondary {
  background: transparent; color: var(--fg);
  border-color: var(--border);
}
.actions button.danger {
  background: var(--err); color: #fff;
  border-color: var(--err); cursor: pointer;
}
.actions button:disabled { opacity: 0.5; cursor: not-allowed; }
.actions button:not(:disabled):hover { filter: brightness(1.12); }
.actions button.subtle {
  background: transparent; border: none; color: var(--muted);
  padding: 4px 4px; cursor: pointer;
}
.actions button.subtle:hover { color: var(--fg); filter: none; }
.actions .spacer { flex: 1; }
.actions .selected-count { color: var(--muted); align-self: center; }
/* Deliberate rows instead of accidental flex-wrap at sidebar widths: the test-level
   select takes a full row, and the verb buttons form one equal-width group that
   wraps into even halves when the panel is very narrow. */
.actions select {
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 2px;
  padding: 3px 6px; font-family: inherit; font-size: inherit; flex: 1 1 100%;
}
.actions select:disabled { opacity: 0.5; cursor: not-allowed; }
/* RunSpecifiedTests class-list input — same full-row treatment as #testLevel
   (comment above) so it lands on its own row directly below the select, hidden
   by default via the inline style on the element. Kept as minimal as
   .tree-search textarea: just the sizing, no bespoke look. */
.actions input#testClasses { flex: 1 1 100%; }
.actions input#testClasses.input-error { border-color: var(--err); }
.conflict-toggle {
  display: flex; align-items: center; gap: 6px; flex: 1 1 100%;
  min-height: 24px; padding: 3px 7px; box-sizing: border-box;
  border: 1px solid var(--border); border-radius: 2px;
  color: var(--muted); cursor: pointer; user-select: none;
}
.conflict-toggle:hover { color: var(--fg); background: var(--row-hover); }
.conflict-toggle:focus-within {
  outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px;
}
.conflict-toggle input { margin: 0; }
.conflict-toggle.enabled {
  color: var(--vscode-inputValidation-warningForeground, var(--fg));
  border-color: var(--vscode-inputValidation-warningBorder, var(--warn));
  background: var(--vscode-inputValidation-warningBackground, transparent);
}
.conflict-toggle.disabled { opacity: 0.5; cursor: not-allowed; }
#diffBtn, #retrieveBtn, #validateBtn, #deployBtn {
  flex: 1 1 0; min-width: 68px; white-space: nowrap;
}
/* Cancel carries the active operation name (for example "Cancel Fetch Org").
   Keep it on its own row so that longer names never compete with the queueable
   Deploy/Validate buttons; at exceptionally narrow sidebar widths, wrap inside
   the button instead of letting the final word escape past the panel edge. */
#cancelBtn {
  flex: 1 1 100%; width: 100%; min-width: 0; max-width: 100%;
  white-space: normal; overflow-wrap: anywhere; line-height: 1.25;
}

.status {
  flex: 1; overflow-y: auto; padding: 8px;
  display: flex; flex-direction: column; gap: 8px;
  /* The run list's offsetTop is measured against this box (panel.js paintRunList). */
  position: relative;
}
.status-card {
  border: 1px solid var(--border); border-radius: 3px;
  padding: 6px 8px; background: var(--vscode-editor-background);
}
.status-card.ok { border-left: 3px solid var(--ok); }
.status-card.err { border-left: 3px solid var(--err); }
.status-card.warn { border-left: 3px solid var(--warn); }
.status-card.progress { border-left: 3px solid var(--accent); }
.status-card .title { font-weight: 600; margin-bottom: 2px; display: flex; align-items: center; gap: 6px; }
.status-card .card-icon { font-weight: 700; flex: none; }
.status-card .card-time { margin-left: auto; flex: none; color: var(--muted); font-size: 10px; font-weight: 400; }
.status-card li.nav { cursor: pointer; }
.status-card li.nav:hover { color: var(--fg); text-decoration: underline; }
.status-card .card-icon.ok { color: var(--ok); }
.status-card .card-icon.err { color: var(--err); }
.status-card .card-icon.warn { color: var(--warn); }
.status-card .meta { color: var(--muted); font-size: 11px; margin-bottom: 4px; }
.status-card ul { margin: 4px 0 0 0; padding-left: 16px; font-size: 12px; }
.status-card .err-text {
  color: var(--err); white-space: pre-wrap; word-break: break-word;
  font-family: var(--vscode-editor-font-family); font-size: 11px;
  max-height: 140px; overflow-y: auto;
}
.status-card .try-label { color: var(--muted); font-size: 11px; margin-top: 4px; }
.status-card .hint { margin-top: 4px; font-size: 11px; color: var(--warn); }
.status-card .show-more {
  background: transparent; border: none; padding: 2px 0; margin-top: 2px;
  color: var(--vscode-textLink-foreground, #3794ff);
  cursor: pointer; font-size: 11px; font-family: inherit;
}
.status-empty { color: var(--muted); font-style: italic; text-align: center; padding: 16px 8px; }

/* Cap the command log so a growing history can't crowd out the tree — it scrolls
   inside this bound, and the Clear button empties it. */
.cmdlog {
  border-top: 1px solid var(--border);
  display: flex; flex-direction: column;
  max-height: 30%;
}
.cmdlog.collapsed { max-height: 28px; }
.cmdlog-body {
  overflow-y: auto; padding: 4px 8px;
  font-family: var(--vscode-editor-font-family);
  font-size: 11px;
}
.cmdlog.collapsed .cmdlog-body { display: none; }
.cmd-entry {
  padding: 3px 0; border-bottom: 1px dotted var(--border);
  display: flex; gap: 6px; align-items: flex-start;
}
.cmd-entry:last-child { border-bottom: none; }
.cmd-entry .ts { color: var(--muted); font-size: 10px; min-width: 60px; }
.cmd-entry .cmd { flex: 1; word-break: break-all; }
.cmd-entry .status-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 4px; flex-shrink: 0; }
.cmd-entry .status-dot.ok { background: var(--ok); }
.cmd-entry .status-dot.err { background: var(--err); }
.cmd-entry .status-dot.run { background: var(--warn); }
.cmd-entry .dur { color: var(--muted); font-size: 10px; }

/* Copy affordance on error cards (the card is the durable error record; failures
   additionally raise a native VS Code notification). */
.status-card .card-copy {
  margin-top: 4px; background: transparent; border: 1px solid var(--border); color: var(--fg);
  border-radius: 2px; padding: 1px 7px; cursor: pointer; font-size: 11px; font-family: inherit;
}
.status-card .card-copy:hover { background: var(--row-hover); }

/* The dependency suggestion inside a failed run's card: its Deploy with N / Back
   buttons (same small secondary treatment as .card-copy, laid out in a row) and
   the checkbox rows above them. */
.run-card .card-buttons { margin-top: 6px; display: flex; gap: 6px; flex-wrap: wrap; }
.run-card .card-btn {
  background: transparent; border: 1px solid var(--border); color: var(--fg);
  border-radius: 2px; padding: 1px 7px; cursor: pointer; font-size: 11px; font-family: inherit;
}
.run-card .card-btn:hover:not(:disabled) { background: var(--row-hover); }
.run-card .card-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.run-card .suggest-rows { list-style: none; margin: 6px 0 0; padding: 0; }
.run-card .suggest-rows li { padding: 2px 0; }
.run-card .suggest-rows label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.run-card .suggest-rows input[type="checkbox"] { margin: 0; }
.run-card .suggest-why { margin: 0 0 0 22px; opacity: 0.65; font-size: 11px; }
.run-card .suggest-unresolved { margin-top: 6px; opacity: 0.65; font-size: 11px; }
.run-card .suggest-summary { margin-top: 6px; opacity: 0.8; font-style: italic; }
.run-card .suggest-feedback { margin-top: 6px; display: flex; align-items: center; gap: 6px; opacity: 0.9; }
.run-card .card-btn.small { padding: 1px 6px; font-size: 11px; }
.run-card .card-btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
.run-card .card-btn.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }

/* Run cards: the newest deploy / validation / quick deploy / retrieve in full
   (panel.js renderRunStatus), older runs and notices as one-liners. Sized for a
   pane about 200px tall: the list rows are virtual, with fixed heights that
   runView.js ROW_H mirrors — change one, change both. */
.run-card {
  flex: none; border: 1px solid var(--border); border-left: 3px solid var(--muted);
  border-radius: 3px; background: var(--vscode-editor-background);
}
.run-card.ok { border-left-color: var(--ok); }
.run-card.err { border-left-color: var(--err); }
.run-card.warn { border-left-color: var(--warn); }
.run-card.run { border-left-color: var(--accent); }
.run-head { padding: 6px 8px 6px; }
.run-verdict { display: flex; align-items: flex-start; gap: 6px; }
.run-glyph { flex: none; width: 14px; text-align: center; font-weight: 700; line-height: 18px; }
.run-glyph .spinner { margin: 0; }
.run-glyph.ok { color: var(--ok); } .run-glyph.err { color: var(--err); } .run-glyph.warn { color: var(--warn); } .run-glyph.neutral { color: var(--muted); }
.run-vtext { flex: 1; min-width: 0; }
.run-title { font-weight: 600; line-height: 18px; overflow-wrap: anywhere; }
.run-org { font-family: var(--vscode-editor-font-family); }
.run-pill {
  display: inline-block; margin-left: 4px; padding: 0 4px; border-radius: 8px;
  border: 1px solid currentColor; font-family: var(--vscode-font-family); font-size: 9px;
  font-weight: 700; line-height: 13px; letter-spacing: .04em; vertical-align: 1px;
}
.run-pill.prod {
  color: var(--vscode-statusBarItem-errorForeground, #fff);
  background: var(--vscode-statusBarItem-errorBackground, #c72e0f); border-color: transparent;
}
.run-pill.sandbox, .run-pill.scratch { color: var(--muted); font-weight: 400; }
.run-sub { color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
.run-plain {
  margin-top: 2px; font-size: 11px; overflow-wrap: anywhere;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
.run-plain.err { color: var(--err); } .run-plain.warn { color: var(--warn); } .run-plain.muted { color: var(--muted); }
.run-prog { margin-top: 5px; }
.run-prow { display: flex; align-items: center; gap: 6px; font-size: 11px; min-height: 16px; }
.run-plbl { flex: none; width: 70px; color: var(--muted); }
.run-bar { flex: 1; min-width: 30px; height: 4px; border-radius: 2px; overflow: hidden; background: rgba(128, 128, 128, .25); }
.run-bar i { display: block; height: 100%; width: 0; background: var(--vscode-progressBar-background, var(--accent)); transition: width .5s linear; }
.run-bar.indet i { width: 35%; animation: run-indet 1.4s ease-in-out infinite; }
@keyframes run-indet { 0% { margin-left: -35%; } 100% { margin-left: 100%; } }
.run-pn { flex: none; font-family: var(--vscode-editor-font-family); font-variant-numeric: tabular-nums; }
.run-perr { flex: none; color: var(--err); }
.run-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
.run-chip {
  display: inline-flex; align-items: center; gap: 4px; padding: 0 7px; border-radius: 9px;
  border: 1px solid var(--border); background: transparent; color: var(--muted);
  font-family: inherit; font-size: 11px; line-height: 16px; cursor: pointer; white-space: nowrap;
}
.run-chip:hover:not(:disabled) { background: var(--row-hover); color: var(--fg); }
.run-chip[aria-pressed="true"] { color: var(--fg); background: var(--row-active); border-color: var(--vscode-focusBorder, var(--accent)); font-weight: 600; }
.run-chip:disabled { opacity: .45; cursor: default; }
.run-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--muted); }
.run-chip.k-ok .run-dot { background: var(--ok); }
.run-chip.k-err .run-dot { background: var(--err); }
.run-chip.k-warn .run-dot { background: var(--warn); }
.run-chip.k-info .run-dot { background: var(--vscode-textLink-foreground, #3794ff); }
.run-chip.k-all .run-dot { background: var(--fg); opacity: .5; }
.run-n { font-family: var(--vscode-editor-font-family); font-variant-numeric: tabular-nums; }
.run-explain { margin-top: 4px; font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
.run-explain b { color: var(--fg); font-weight: 600; }
.run-explain.k-err { color: var(--err); } .run-explain.k-warn { color: var(--warn); }
.run-acts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 5px; }
.run-btn {
  background: transparent; border: 1px solid var(--border); color: var(--fg); border-radius: 2px;
  padding: 1px 7px; cursor: pointer; font-family: inherit; font-size: 11px; white-space: nowrap;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis;
}
.run-btn:hover:not(:disabled) { background: var(--row-hover); }
.run-btn.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
.run-btn.primary:hover:not(:disabled) { filter: brightness(1.12); }
.run-btn:disabled { opacity: .5; cursor: not-allowed; }
.run-why { flex-basis: 100%; font-size: 11px; color: var(--muted); }
.run-suggest { margin-top: 6px; padding-top: 5px; border-top: 1px solid var(--border); }
.run-suggest-title { font-weight: 600; }
.run-tools { display: flex; gap: 4px; margin-top: 5px; }
.run-search {
  flex: 1; min-width: 0; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 2px;
  padding: 1px 6px; font-family: inherit; font-size: 12px;
}
.run-list { position: relative; border-top: 1px solid var(--border); outline: none; }
.run-list:focus-visible { outline: 1px solid var(--vscode-focusBorder, var(--accent)); outline-offset: -1px; }
.run-row {
  position: absolute; left: 0; right: 0; box-sizing: border-box; overflow: hidden;
  display: flex; align-items: center; gap: 6px; padding: 0 8px; font-size: 12px; cursor: default;
}
.run-row:hover { background: var(--row-hover); }
.run-row.focused { background: var(--row-active); }
.run-row.section {
  font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted);
  border-bottom: 1px solid var(--border);
}
.run-row.section:hover, .run-row.note:hover { background: transparent; }
.run-row.group, .run-row.tgroup { cursor: pointer; }
.run-row.leaf, .run-row.test { padding-left: 22px; cursor: pointer; }
.run-row.tall { align-items: flex-start; padding-top: 3px; }
.run-caret { flex: none; width: 10px; font-size: 9px; color: var(--muted); }
.run-rglyph { flex: none; width: 12px; text-align: center; font-size: 11px; }
.g-ok { color: var(--ok); } .g-err { color: var(--err); } .g-warn { color: var(--warn); } .g-skip { color: var(--muted); }
.g-info { color: var(--vscode-textLink-foreground, #3794ff); }
.run-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family); }
.run-row.group .run-name, .run-row.tgroup .run-name, .run-row.section .run-name { font-family: inherit; }
.run-row.group .run-name, .run-row.tgroup .run-name { font-weight: 600; }
.run-cnt { flex: none; font-size: 11px; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.run-cnt .bad { color: var(--err); font-weight: 600; }
.run-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.run-l1 { display: flex; align-items: center; gap: 6px; min-height: 16px; }
.run-why-col { flex: none; max-width: 45%; font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-link, .run-loc {
  flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--vscode-editor-font-family); font-size: 11px;
}
.run-link { background: transparent; border: 0; padding: 0; color: var(--vscode-textLink-foreground, #3794ff); cursor: pointer; }
.run-link:hover { text-decoration: underline; }
.run-loc { color: var(--muted); }
.run-mini {
  flex: none; visibility: hidden; background: transparent; border: 1px solid transparent; border-radius: 2px;
  color: var(--muted); cursor: pointer; padding: 0 4px; font-family: inherit; font-size: 10px; line-height: 14px;
}
.run-row:hover .run-mini, .run-row.focused .run-mini, .run-mini:focus-visible { visibility: visible; }
.run-mini:hover { color: var(--fg); border-color: var(--border); }
.run-msg {
  font-family: var(--vscode-editor-font-family); font-size: 11px; line-height: 15px; color: var(--err);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere;
}
.run-note { flex: 1; min-width: 0; color: var(--muted); font-size: 11px; font-style: italic; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-empty { padding: 8px; color: var(--muted); font-size: 12px; font-style: italic; }
.run-earlier, .run-notice, .run-older { flex: none; display: flex; flex-direction: column; }
.run-hrow {
  display: flex; align-items: center; gap: 6px; width: 100%; min-height: 22px; padding: 2px 4px;
  background: transparent; border: 0; border-radius: 2px; color: var(--fg); text-align: left;
  cursor: pointer; font-family: inherit; font-size: 12px;
}
.run-hrow:hover { background: var(--row-hover); }
.run-htxt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-when { flex: none; color: var(--muted); font-size: 10px; white-space: nowrap; }
.run-older-body { margin: 2px 0 4px 16px; padding: 4px 8px; border-left: 2px solid var(--border); font-size: 12px; }
.run-older-rows { margin: 4px 0 0; padding-left: 16px; font-size: 11px; }
.run-older-rows li { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-older-rows li.nav { cursor: pointer; }
.run-older-rows li.nav:hover { text-decoration: underline; }
.run-foot { margin-top: 4px; font-size: 10px; color: var(--muted); font-style: italic; }
.run-notice > .status-card { margin: 2px 0 4px 16px; }
/* Too narrow for the reason column: the Skipped chip's line says it instead. */
@media (max-width: 359px) { .run-why-col { display: none; } }

.spinner {
  display: inline-block; width: 10px; height: 10px;
  border: 2px solid var(--muted); border-top-color: transparent;
  border-radius: 50%; animation: spin 0.8s linear infinite;
  vertical-align: middle; margin-right: 6px;
}
@keyframes spin { to { transform: rotate(360deg); } }
/* ⟳ spins while the provider re-lists orgs — an unchanged dropdown re-renders
   identically, so this is the only sign the click landed. */
#refreshOrgs.loading span { display: inline-block; animation: spin 0.8s linear infinite; }

.banner {
  /* statusBarItem.warning* is a matched fg/bg pair with core defaults in every
     base theme. The old inputValidation-warningBackground + general foreground
     mix rendered near-white text on bright yellow in themes that define the
     background but not inputValidation.warningForeground. */
  padding: 6px 12px; background: var(--vscode-statusBarItem-warningBackground, #7a6400);
  color: var(--vscode-statusBarItem-warningForeground, #ffffff);
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  gap: 8px; align-items: flex-start; /* flex layout when the notice carries a dismiss ✕ */
}
.banner .banner-text { flex: 1; min-width: 0; }
.banner .banner-close {
  flex: none; background: transparent; border: none; color: inherit;
  cursor: pointer; padding: 0 2px; font-size: 12px; opacity: 0.8; line-height: 1.4;
}
.banner .banner-close:hover { opacity: 1; }

/* Right-click context menu for the tree: deploy / retrieve / diff a whole folder
   (group) or a single component without first ticking checkboxes. Positioned at the
   cursor; dismissed on click-away, Escape, scroll, or blur. */
.ctx-menu {
  position: fixed; z-index: 50; min-width: 172px;
  background: var(--vscode-menu-background, var(--vscode-editor-background, var(--bg)));
  color: var(--vscode-menu-foreground, var(--fg));
  border: 1px solid var(--vscode-menu-border, var(--border));
  border-radius: 4px; padding: 4px 0;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.36);
  font-size: 12px; user-select: none;
}
.ctx-menu .ctx-head {
  padding: 3px 12px 4px; font-size: 11px; color: var(--muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 320px;
}
.ctx-menu .ctx-item {
  padding: 4px 12px; cursor: pointer; white-space: nowrap;
  display: flex; align-items: center; gap: 8px;
}
.ctx-menu .ctx-item:hover {
  background: var(--vscode-menu-selectionBackground, var(--row-active));
  color: var(--vscode-menu-selectionForeground, var(--fg));
}
.ctx-menu .ctx-item.disabled { opacity: 0.4; cursor: default; }
.ctx-menu .ctx-item.disabled:hover { background: transparent; color: inherit; }
/* Destructive items (Delete from Org…) read as danger — red text, kept red on the
   selection-highlight hover so it can't be mistaken for a benign action. */
.ctx-menu .ctx-item.danger { color: var(--err); }
.ctx-menu .ctx-item.danger:hover { color: var(--err); }
.ctx-menu .ctx-sep { height: 1px; margin: 4px 0; background: var(--vscode-menu-separatorBackground, var(--border)); }
</style>
</head>
<body>
  <div class="toolbar">
    <span title="Salesforce org">Org:</span>
    <select id="orgSelect" class="org" title="Authenticated orgs"></select>
    <button id="refreshOrgs" class="secondary" title="Refresh org list"><span>⟳</span></button>
    <button id="addOrg" class="secondary" title="Authenticate a new org (sf org login web)">＋</button>
    <button id="refreshFiles" class="secondary" title="Rescan workspace metadata">Rescan</button>
    <button id="fetchOrgBtn" class="secondary" title="Fetch all metadata from the connected org and merge with local workspace">Fetch Org</button>
  </div>
  <div id="banner" class="banner" style="display:none;"></div>
  <div id="scanBanner" class="banner" style="display:none;"></div>

  <div class="body">
    <div class="left">
      <div id="viewModes" class="view-modes" role="tablist">
        <button id="modeAll" data-mode="all" role="tab">All</button>
        <button id="modeSelected" data-mode="selected" role="tab">Selected</button>
        <button id="modeChanged" data-mode="changed" role="tab" title="Components whose files have uncommitted git changes">Changed</button>
      </div>
      <div class="tree-search">
        <textarea id="search" rows="1" wrap="off" spellcheck="false" placeholder="Filter… tokens · initials (avt) · type:flow · or a list of names"></textarea>
        <div id="sourceFilterRow" style="display:none;">
          <select id="sourceFilter">
            <option value="all">All sources</option>
            <option value="local">In project (local)</option>
            <option value="local-only">Local only (not on org)</option>
            <option value="org-only">Org only (not local)</option>
            <option value="both">In both</option>
          </select>
          <span id="orgAsOf" class="org-as-of"></span>
        </div>
        <div id="typeFilterRow" class="type-filter-row" style="display:none;">
          <details id="typeFilterDetails">
            <summary><span id="typeFilterLabel">All types</span></summary>
            <div id="typeFilterActions" class="type-filter-actions">
              <button id="typeFilterAll" type="button" title="Show every type">All</button>
              <button id="typeFilterNone" type="button" title="Hide every type">None</button>
            </div>
            <div id="typeFilterList" class="type-filter-list"></div>
          </details>
        </div>
      </div>
      <div id="treeTools" class="mode-head tree-tools" style="display:none;">
        <span><button id="selectAllRows" type="button" style="display:none;" title="Tick every component this list shows — filters apply">Select all</button></span>
        <button id="expandAll" type="button" title="Expand every group">Expand all</button>
        <button id="collapseAll" type="button" title="Collapse every group">Collapse all</button>
      </div>
      <div id="tree" class="tree"></div>
      <div class="actions" id="actionsBar">
        <button id="useActive" class="secondary" title="Select the file currently open in editor">Use active file</button>
        <button id="useOpenTabs" class="secondary" title="Select every open editor tab that maps to a metadata component">Use open tabs</button>
        <span class="spacer"></span>
        <span id="selCount" class="selected-count">0 selected</span>
        <button id="clearSel" class="subtle" style="display:none;" title="Clear selection">✕</button>
        <select id="testLevel" class="org" title="Apex test level for deploy/validate. 'Tests: default' is resolved from the target org — sandbox: no tests (NoTestRun), production: RunLocalTests — unless the Default Test Level setting names one. A Validate with no tests is a check-only deploy that can't be quick-deployed — pick a level for that. The confirm dialog names the level that will actually run.">
          <option value="" title="Resolved from the target org: sandbox runs no tests (NoTestRun), production runs RunLocalTests. The Default Test Level setting, when set, takes precedence.">Tests: default (sandbox: none, prod: RunLocalTests)</option>
          <option value="NoTestRun">NoTestRun</option>
          <option value="RunSpecifiedTests">RunSpecifiedTests</option>
          <option value="RunLocalTests">RunLocalTests</option>
          <option value="RunAllTestsInOrg">RunAllTestsInOrg</option>
        </select>
        <input id="testClasses" type="text" placeholder="Test classes, comma-separated" title="Apex test classes to run (RunSpecifiedTests)" style="display:none;" />
        <label id="ignoreConflictsControl" class="conflict-toggle" title="Deploy with --ignore-conflicts. Local source can overwrite newer changes in the selected org.">
          <input id="ignoreDeployConflicts" type="checkbox" />
          <span>Overwrite org changes</span>
        </label>
        <button id="diffBtn" class="secondary" disabled>Diff</button>
        <button id="retrieveBtn" disabled>Retrieve</button>
        <button id="validateBtn" class="secondary" disabled title="Check-only deploy: nothing is deployed. With a test level it runs the tests and can be quick-deployed; with no tests it cannot.">Validate</button>
        <button id="deployBtn" class="primary" disabled>Deploy</button>
        <button id="cancelBtn" class="danger" style="display:none;">Cancel</button>
      </div>
    </div>
    <div id="queueStrip" class="queue-strip" style="display:none;"></div>
    <div id="splitter" class="splitter" title="Drag to resize · double-click to reset"></div>
    <div class="right">
      <div class="section-header" id="statusHeader">
        <span>Status</span>
        <span class="hdr-actions">
          <button id="statusEarlier" class="section-clear" type="button" aria-expanded="false" style="display:none;">Earlier</button>
          <button id="clearStatus" class="section-clear" title="Clear status cards" style="display:none;">Clear</button>
        </span>
      </div>
      <div id="status" class="status">
        <div class="status-empty">No operations yet.</div>
      </div>
    </div>
  </div>

  <div id="cmdlog" class="cmdlog collapsed">
    <div class="section-header" id="cmdlogHeader">
      <span>Command log</span>
      <span class="hdr-actions">
        <button id="clearCmdLog" class="section-clear" title="Clear command log" style="display:none;">Clear</button>
        <span class="caret" id="cmdlogCaret">▸</span>
      </span>
    </div>
    <div class="cmdlog-body" id="cmdlogBody"></div>
  </div>

  <script nonce="${nonce}" src="${runViewUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
