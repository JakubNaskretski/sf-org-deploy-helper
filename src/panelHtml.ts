import * as vscode from 'vscode';
import { randomBytes } from 'crypto';

export function generateNonce(): string {
  // CSPRNG (not Math.random) so the CSP script nonce isn't predictable.
  return randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
}

export function getPanelHtml(webview: vscode.Webview, extensionUri: vscode.Uri, nonce: string): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'panel.js'));
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
.tree-search input { width: 100%; }

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
  display: flex; justify-content: space-between; align-items: center;
  padding: 2px 10px; font-size: 11px; color: var(--muted);
}
.mode-head button {
  background: transparent; border: none; color: var(--muted); cursor: pointer;
  font-size: 11px; font-family: inherit; padding: 0;
}
.mode-head button:hover { color: var(--fg); text-decoration: underline; }
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
.type-filter-actions { display: flex; gap: 6px; margin-top: 4px; }
.type-filter-actions button {
  background: transparent; color: var(--fg); border: 1px solid var(--border);
  border-radius: 2px; padding: 2px 6px; font-size: 11px; cursor: pointer;
  font-family: inherit;
}
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
   .tree-search input: just the sizing, no bespoke look. */
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
.status-card .quick-deploy {
  margin-top: 8px; padding: 4px 10px; border: none; border-radius: 3px;
  background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  cursor: pointer; font-size: 12px; font-family: inherit;
}
.status-card .quick-deploy:hover:not(:disabled) { filter: brightness(1.12); }
.status-card .quick-deploy:disabled { opacity: 0.5; cursor: not-allowed; }
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

/* Card-defined action buttons (Restore backup…/Discard backup on a retrieve result)
   — same small secondary treatment as .card-copy, laid out in a row. */
.status-card .card-buttons { margin-top: 6px; display: flex; gap: 6px; flex-wrap: wrap; }
.status-card .card-btn {
  background: transparent; border: 1px solid var(--border); color: var(--fg);
  border-radius: 2px; padding: 1px 7px; cursor: pointer; font-size: 11px; font-family: inherit;
}
.status-card .card-btn:hover:not(:disabled) { background: var(--row-hover); }
.status-card .card-btn:disabled { opacity: 0.5; cursor: not-allowed; }
/* Failure-card dependency suggestions (state B swaps the error list for these). */
.status-card .suggest-rows { list-style: none; margin: 6px 0 0; padding: 0; }
.status-card .suggest-rows li { padding: 2px 0; }
.status-card .suggest-rows label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.status-card .suggest-rows input[type="checkbox"] { margin: 0; }
.status-card .suggest-unresolved { margin-top: 6px; opacity: 0.65; font-size: 11px; }
.status-card .suggest-summary { margin-top: 6px; opacity: 0.8; font-style: italic; }
.status-card .suggest-feedback { margin-top: 6px; display: flex; align-items: center; gap: 6px; opacity: 0.9; }
.status-card .card-btn.small { padding: 1px 6px; font-size: 11px; }
.status-card .card-btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
.status-card .card-btn.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }

.spinner {
  display: inline-block; width: 10px; height: 10px;
  border: 2px solid var(--muted); border-top-color: transparent;
  border-radius: 50%; animation: spin 0.8s linear infinite;
  vertical-align: middle; margin-right: 6px;
}
@keyframes spin { to { transform: rotate(360deg); } }

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
    <button id="refreshOrgs" class="secondary" title="Refresh org list">⟳</button>
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
        <input id="search" type="text" placeholder="Filter… tokens · initials (avt) · type:flow" />
        <div id="sourceFilterRow" style="display:none;">
          <select id="sourceFilter">
            <option value="all">All sources</option>
            <option value="local-only">Local only (not on org)</option>
            <option value="org-only">Org only (not local)</option>
            <option value="both">In both</option>
          </select>
        </div>
        <div id="typeFilterRow" class="type-filter-row" style="display:none;">
          <details id="typeFilterDetails">
            <summary><span id="typeFilterLabel">All types</span></summary>
            <div id="typeFilterList" class="type-filter-list"></div>
          </details>
        </div>
      </div>
      <div id="tree" class="tree"></div>
      <div class="actions" id="actionsBar">
        <button id="useActive" class="secondary" title="Select the file currently open in editor">Use active file</button>
        <button id="useOpenTabs" class="secondary" title="Select every open editor tab that maps to a metadata component">Use open tabs</button>
        <span class="spacer"></span>
        <span id="selCount" class="selected-count">0 selected</span>
        <button id="clearSel" class="subtle" style="display:none;" title="Clear selection">✕</button>
        <select id="testLevel" class="org" title="Apex test level for deploy/validate">
          <option value="">Tests: default</option>
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
        <button id="validateBtn" class="secondary" disabled title="Check-only deploy: validate + run tests without deploying. A successful validation can be quick-deployed.">Validate</button>
        <button id="deployBtn" class="primary" disabled>Deploy</button>
        <button id="cancelBtn" class="danger" style="display:none;">Cancel</button>
      </div>
    </div>
    <div id="queueStrip" class="queue-strip" style="display:none;"></div>
    <div id="splitter" class="splitter" title="Drag to resize · double-click to reset"></div>
    <div class="right">
      <div class="section-header" id="statusHeader">
        <span>Status</span>
        <button id="clearStatus" class="section-clear" title="Clear status cards" style="display:none;">Clear</button>
      </div>
      <div id="status" class="status">
        <div class="status-empty">No operations yet.</div>
      </div>
    </div>
  </div>

  <div id="cmdlog" class="cmdlog">
    <div class="section-header" id="cmdlogHeader">
      <span>Command log</span>
      <span class="hdr-actions">
        <button id="clearCmdLog" class="section-clear" title="Clear command log" style="display:none;">Clear</button>
        <span class="caret" id="cmdlogCaret">▼</span>
      </span>
    </div>
    <div class="cmdlog-body" id="cmdlogBody"></div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
