// AUTO-GENERATED — vendored from sf-kit by scripts/sync-kit.mjs. DO NOT EDIT HERE.
// Edit the source in sf-kit/src/ and re-run the sync. Local edits will be overwritten.
/**
 * CSV/TSV formula-injection neutralizer for the SF plugin family.
 *
 * Lifted from soql-editor's `panel.js` (the `neutralizeFormula` + `cell`/`csvEsc`
 * closures around the copy/export buttons). Query results are attacker-
 * influenceable (any org record), so a cell beginning with `= + - @` — or the
 * tab/CR variants some spreadsheet apps also treat as formula leads — could
 * execute when the exported CSV/TSV is opened in Excel / Google Sheets /
 * LibreOffice. Prefixing a `'` (or, more robustly, a space stripped by nothing)
 * defuses it. Maintaining this in ONE place (REVIEW cross-cutting #6: "security
 * code maintained N times").
 */

/** Chars that make a spreadsheet treat a cell as a formula when leading. The
 *  soql-editor original guarded `= + - @`; tab and CR are added because some
 *  spreadsheet importers strip leading whitespace and then see a formula lead. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * Prefix a `'` if the value could be interpreted as a spreadsheet formula, so it
 * imports as literal text. A leading `'` is the standard "treat as text" escape
 * and is not itself displayed by spreadsheet apps.
 */
export function neutralizeFormula(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return FORMULA_LEAD.test(s) ? "'" + s : s;
}

/**
 * Format one value as a TSV cell: neutralize formula leads, then collapse
 * tabs/newlines to a single space so they don't break column/row alignment when
 * pasted into a spreadsheet. `?? ''` semantics preserve 0 / false.
 */
export function toTsvCell(value: unknown): string {
  return neutralizeFormula(value).replace(/[\t\r\n]+/g, ' ');
}

/**
 * Format one value as a CSV cell: neutralize formula leads, then RFC-4180 quote
 * (wrap in `"` and double any embedded `"`) when the value contains a comma,
 * quote, or newline.
 */
export function toCsvCell(value: unknown): string {
  const s = neutralizeFormula(value);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Build a full TSV document from column keys and row objects. */
export function toTsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  const header = columns.join('\t');
  const body = rows.map(r => columns.map(c => toTsvCell(r[c])).join('\t')).join('\n');
  return body ? `${header}\n${body}` : header;
}

/** Build a full CSV document from column keys and row objects. */
export function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  const header = columns.map(toCsvCell).join(',');
  const body = rows.map(r => columns.map(c => toCsvCell(r[c])).join(',')).join('\n');
  return body ? `${header}\n${body}` : header;
}
