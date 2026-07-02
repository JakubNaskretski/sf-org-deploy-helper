// AUTO-GENERATED — vendored from sf-kit by scripts/sync-kit.mjs. DO NOT EDIT HERE.
// Edit the source in sf-kit/src/ and re-run the sync. Local edits will be overwritten.
/** Shared webview HTML shell + message-shape guard for the SF plugin family. */
import * as vscode from 'vscode';
import { randomBytes } from 'crypto';

/**
 * Cryptographically strong CSP nonce: 128 bits of entropy from the OS CSPRNG,
 * base64url-encoded. A predictable nonce would let injected markup satisfy the
 * `script-src 'nonce-…'` policy, so this must not use Math.random() (retires
 * soql-editor's and graph-viewer's `Math.random()` nonces). Base: side-notes'
 * `getNonce`.
 */
export function getNonce(): string {
  return randomBytes(16).toString('base64url');
}

export interface WebviewHtmlOptions {
  /** Webview-safe URI of the client script (from `webview.asWebviewUri`). */
  scriptUri: vscode.Uri;
  /** Optional webview-safe URI of a stylesheet. */
  styleUri?: vscode.Uri;
  /** <title> text. */
  title?: string;
  /** Extra CSP source fragments per directive, appended to the strict defaults.
   *  e.g. `{ 'connect-src': ['https://*.salesforce.com'] }` for a REST call. */
  cspExtra?: Partial<Record<'img-src' | 'style-src' | 'script-src' | 'connect-src' | 'font-src', string[]>>;
  /** Body markup inserted before the script tag. Defaults to a JS-not-loaded
   *  fallback banner + an empty `#app` root the client script renders into. */
  bodyHtml?: string;
}

/**
 * Build a strict-CSP webview HTML shell (base: side-notes `panelHtml.ts`).
 *
 * CSP is strict: `default-src 'none'`, scripts only via the per-render nonce (no
 * `'unsafe-inline'`), styles/images only from the webview origin (+`data:`).
 * All UI is rendered by the linked client script; keeping styles in a linked
 * stylesheet is what lets `style-src` stay free of `'unsafe-inline'`.
 */
export function getWebviewHtml(webview: vscode.Webview, opts: WebviewHtmlOptions): string {
  const nonce = getNonce();
  const src = webview.cspSource;
  const extra = opts.cspExtra ?? {};
  const join = (base: string[], key: keyof typeof extra): string =>
    [...base, ...(extra[key] ?? [])].join(' ');

  const directives = [
    `default-src 'none'`,
    `img-src ${join([src, 'data:'], 'img-src')}`,
    `style-src ${join([src], 'style-src')}`,
    `script-src ${join([`'nonce-${nonce}'`], 'script-src')}`,
    `font-src ${join([src], 'font-src')}`
  ];
  if (extra['connect-src']?.length) directives.push(`connect-src ${extra['connect-src'].join(' ')}`);
  const csp = directives.join('; ');

  const styleLink = opts.styleUri ? `<link rel="stylesheet" href="${opts.styleUri}">` : '';
  const body = opts.bodyHtml ?? `
<!-- Fallback banner: shown only if the client script never boots (missing or
     failed script). The script hides it as its first action. -->
<div id="jsCheck" class="js-check">JS NOT LOADED — client script missing or failed to load</div>

<!-- Root container; the client renders its views inside it. -->
<div id="app" class="app"></div>`;

  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp};">
${styleLink}
<title>${opts.title ?? 'Salesforce'}</title>
</head>
<body>
${body}
<script nonce="${nonce}" src="${opts.scriptUri}"></script>
</body>
</html>`;
}

/** A field's expected primitive type in a message-shape descriptor. */
export type FieldType = 'string' | 'number' | 'boolean' | 'object' | 'array';

/** Message-shape descriptor: field name → expected type (append `?` for optional). */
export type MessageShape = Record<string, FieldType | `${FieldType}?`>;

/**
 * Validate an inbound webview message against a shape descriptor. Webview
 * message handlers across the family cast `event.data` without checking it
 * (REVIEW: "webview messages cast without shape validation"), so a malformed or
 * hostile message can crash the host or reach a privileged branch. This is a
 * lightweight guard — it does NOT sanitize values, only asserts their presence
 * and primitive type. Returns a typed narrowing so callers get the fields
 * without re-casting.
 *
 * `?`-suffixed types are optional (absent/undefined passes; a wrong-typed
 * present value fails). Arrays are matched via Array.isArray; `object` excludes
 * arrays and null.
 */
export function validateMessage<T = Record<string, unknown>>(
  shape: MessageShape,
  msg: unknown
): msg is T {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return false;
  const m = msg as Record<string, unknown>;
  for (const [key, spec] of Object.entries(shape)) {
    const optional = spec.endsWith('?');
    const type = (optional ? spec.slice(0, -1) : spec) as FieldType;
    const value = m[key];
    if (value === undefined || value === null) {
      if (optional) continue;
      return false;
    }
    if (!matchesType(value, type)) return false;
  }
  return true;
}

function matchesType(value: unknown, type: FieldType): boolean {
  switch (type) {
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
  }
}
