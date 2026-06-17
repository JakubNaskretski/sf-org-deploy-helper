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

.body {
  flex: 1; display: flex; min-height: 0; overflow: hidden;
}
.left {
  flex: 2; display: flex; flex-direction: column; min-width: 0;
  border-right: 1px solid var(--border);
}
.right {
  flex: 1; display: flex; flex-direction: column; min-width: 0;
  min-width: 220px;
}
.section-header {
  padding: 4px 8px; font-size: 11px; text-transform: uppercase;
  color: var(--muted); letter-spacing: 0.5px;
  display: flex; align-items: center; justify-content: space-between;
  cursor: pointer; user-select: none;
}
.section-header .caret { font-size: 9px; opacity: 0.7; }
.tree {
  flex: 1; overflow-y: auto; padding: 4px 0;
}
.tree-search {
  padding: 4px 8px; border-bottom: 1px solid var(--border);
}
.tree-search input { width: 100%; }
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

/* In a narrow sidebar the side-by-side tree/status split is unreadably cramped —
   stack vertically instead. */
@media (max-width: 480px) {
  .body { flex-direction: column; }
  .left { border-right: none; border-bottom: 1px solid var(--border); flex: 3; }
  .right { min-width: 0; flex: 2; }
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
.status-card .card-icon.ok { color: var(--ok); }
.status-card .card-icon.err { color: var(--err); }
.status-card .card-icon.warn { color: var(--warn); }
.status-card .meta { color: var(--muted); font-size: 11px; margin-bottom: 4px; }
.status-card ul { margin: 4px 0 0 0; padding-left: 16px; font-size: 12px; }
.status-card .err-text { color: var(--err); white-space: pre-wrap; font-family: var(--vscode-editor-font-family); font-size: 11px; }
.status-card .hint { margin-top: 4px; font-size: 11px; color: var(--warn); }
.status-card .show-more {
  background: transparent; border: none; padding: 2px 0; margin-top: 2px;
  color: var(--vscode-textLink-foreground, #3794ff);
  cursor: pointer; font-size: 11px; font-family: inherit;
}
.status-empty { color: var(--muted); font-style: italic; text-align: center; padding: 16px 8px; }

.cmdlog {
  border-top: 1px solid var(--border);
  display: flex; flex-direction: column;
  max-height: 50%;
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

.spinner {
  display: inline-block; width: 10px; height: 10px;
  border: 2px solid var(--muted); border-top-color: transparent;
  border-radius: 50%; animation: spin 0.8s linear infinite;
  vertical-align: middle; margin-right: 6px;
}
@keyframes spin { to { transform: rotate(360deg); } }

.banner {
  padding: 6px 8px; background: var(--vscode-inputValidation-warningBackground, #5a4a1a);
  color: var(--vscode-inputValidation-warningForeground, var(--fg));
  border-bottom: 1px solid var(--vscode-inputValidation-warningBorder, var(--border));
  font-size: 12px;
}
</style>
</head>
<body>
  <div class="toolbar">
    <span title="Salesforce org">Org:</span>
    <select id="orgSelect" class="org" title="Authenticated orgs"></select>
    <button id="refreshOrgs" class="secondary" title="Refresh org list">⟳</button>
    <button id="refreshFiles" class="secondary" title="Rescan workspace metadata">Rescan</button>
    <button id="fetchOrgBtn" class="secondary" title="Fetch all metadata from the connected org and merge with local workspace">Fetch Org</button>
  </div>
  <div id="banner" class="banner" style="display:none;"></div>

  <div class="body">
    <div class="left">
      <div class="tree-search">
        <input id="search" type="text" placeholder="Filter… (type or name)" />
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
        <span class="spacer"></span>
        <span id="selCount" class="selected-count">0 selected</span>
        <button id="clearSel" class="subtle" style="display:none;" title="Clear selection">✕</button>
        <button id="diffBtn" class="secondary" disabled>Diff</button>
        <button id="retrieveBtn" disabled>Retrieve</button>
        <button id="deployBtn" class="primary" disabled>Deploy</button>
        <button id="cancelBtn" class="danger" style="display:none;">Cancel</button>
      </div>
    </div>
    <div class="right">
      <div class="section-header">Status</div>
      <div id="status" class="status">
        <div class="status-empty">No operations yet.</div>
      </div>
    </div>
  </div>

  <div id="cmdlog" class="cmdlog">
    <div class="section-header" id="cmdlogHeader">
      <span>Command log</span>
      <span class="caret" id="cmdlogCaret">▼</span>
    </div>
    <div class="cmdlog-body" id="cmdlogBody"></div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
