// AUTO-GENERATED — vendored from sf-kit by scripts/sync-kit.mjs. DO NOT EDIT HERE.
// Edit the source in sf-kit/src/ and re-run the sync. Local edits will be overwritten.
/**
 * Apex debug-log parser for the SF plugin family — a superset merge of
 * apex-editor's and sf-log-reader's `logParser.ts`.
 *
 * From sf-log-reader (the richer base): the full `LogCategory` set
 * (CALLOUT/CODE_UNIT/METHOD/LIMITS/…), the `LogEntry` shape with `lineNumber` /
 * `timestampNanos` / `raw`, and `summarize()`.
 * From apex-editor: `parseLimitUsage()` + `LimitMetric` (the LIMIT_USAGE_FOR_NS
 * governor-limit snapshot) — which sf-log-reader lacked.
 *
 * Every field of both source `LogEntry` types is present, so both plugins can
 * adopt this module without losing information. The category union is a superset
 * of both originals.
 */

export type LogCategory =
  | 'USER_DEBUG'
  | 'SOQL'
  | 'DML'
  | 'EXCEPTION'
  | 'CALLOUT'
  | 'CODE_UNIT'
  | 'METHOD'
  | 'LIMITS'
  | 'SYSTEM';

export interface LogEntry {
  /** 1-based source line of the entry's header line within the raw log. */
  lineNumber: number;
  /** HH:MM:SS.ms — nanos stripped. */
  timestamp: string;
  /** The parenthesised nanosecond counter, when present (else null). */
  timestampNanos: number | null;
  category: LogCategory;
  eventType: string;
  lineRef: string;
  message: string;
  /** The raw header line plus any attached continuation lines. */
  raw: string;
}

export interface LogStats {
  total: number;
  byCategory: Record<LogCategory, number>;
  byEventType: Record<string, number>;
}

export interface LimitMetric {
  name: string;
  used: number;
  max: number;
}

const CATEGORY_MAP: Record<string, LogCategory> = {
  USER_DEBUG: 'USER_DEBUG',
  SOQL_EXECUTE_BEGIN: 'SOQL',
  SOQL_EXECUTE_END: 'SOQL',
  SOQL_EXECUTE_EXPLAIN: 'SOQL',
  SOSL_EXECUTE_BEGIN: 'SOQL',
  SOSL_EXECUTE_END: 'SOQL',
  DML_BEGIN: 'DML',
  DML_END: 'DML',
  EXCEPTION_THROWN: 'EXCEPTION',
  FATAL_ERROR: 'EXCEPTION',
  CALLOUT_REQUEST: 'CALLOUT',
  CALLOUT_RESPONSE: 'CALLOUT',
  CODE_UNIT_STARTED: 'CODE_UNIT',
  CODE_UNIT_FINISHED: 'CODE_UNIT',
  METHOD_ENTRY: 'METHOD',
  METHOD_EXIT: 'METHOD',
  LIMIT_USAGE: 'LIMITS',
  LIMIT_USAGE_FOR_NS: 'LIMITS'
};

const LINE_REF_RE = /^\[.+\]$/;

/**
 * Parse an Apex debug log into structured entries.
 *
 * Line format: `HH:MM:SS.ms (nanos)|EVENT_TYPE|[line]|…fields`
 * Header line:  `59.0 APEX_CODE,DEBUG;APEX_PROFILING,INFO;…` (skipped)
 *
 * Untimestamped follow-up lines (FATAL_ERROR stack traces, LIMIT_USAGE_FOR_NS
 * bodies, variable dumps) are attached to the previous entry — never dropped.
 */
export function parseLogs(raw: string): LogEntry[] {
  if (!raw) return [];
  const entries: LogEntry[] = [];
  const lines = raw.split('\n');
  let last: LogEntry | null = null;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    // Skip the version/debug-level header line.
    if (/^\d+\.\d+\s+\w/.test(trimmed) && trimmed.includes('APEX_CODE')) continue;
    const pipeIdx = trimmed.indexOf('|');
    const timestampField = pipeIdx === -1 ? '' : trimmed.slice(0, pipeIdx);
    const isNewEntry = pipeIdx !== -1 && /^\d{2}:\d{2}:\d{2}/.test(timestampField);
    if (!isNewEntry) {
      // Untimestamped continuation line — attach to the previous entry.
      if (last) {
        last.message = last.message ? `${last.message}\n${trimmed}` : trimmed;
        last.raw = `${last.raw}\n${trimmed}`;
      }
      continue;
    }
    const parts = trimmed.slice(pipeIdx + 1).split('|');
    const eventType = parts[0] ?? '';
    const rest = parts.slice(1);
    // Some events (FATAL_ERROR, anonymous CODE_UNITs) have no [N] line-ref
    // segment. Only treat the first segment as the line ref when it looks like one.
    let lineRef = '';
    let message: string;
    if (rest.length > 0 && LINE_REF_RE.test(rest[0])) {
      lineRef = rest[0];
      message = rest.slice(1).join(' | ');
    } else {
      message = rest.join(' | ');
    }
    const nanoMatch = timestampField.match(/\((\d+)\)/);
    const entry: LogEntry = {
      lineNumber: i + 1,
      timestamp: timestampField.split(' ')[0], // strip nanos, keep HH:MM:SS.ms
      timestampNanos: nanoMatch ? Number(nanoMatch[1]) : null,
      category: CATEGORY_MAP[eventType] ?? 'SYSTEM',
      eventType,
      lineRef,
      message,
      raw: trimmed
    };
    entries.push(entry);
    last = entry;
  }
  return entries;
}

/** Category + event-type histogram over parsed entries. */
export function summarize(entries: LogEntry[]): LogStats {
  const byCategory: Record<LogCategory, number> = {
    USER_DEBUG: 0, SOQL: 0, DML: 0, EXCEPTION: 0, CALLOUT: 0,
    CODE_UNIT: 0, METHOD: 0, LIMITS: 0, SYSTEM: 0
  };
  const byEventType: Record<string, number> = {};
  for (const e of entries) {
    byCategory[e.category] += 1;
    byEventType[e.eventType] = (byEventType[e.eventType] ?? 0) + 1;
  }
  return { total: entries.length, byCategory, byEventType };
}

/**
 * Extract the latest LIMIT_USAGE_FOR_NS governor-limit snapshot from a debug
 * log. Keyed by namespace + metric so a managed package can't overwrite the
 * (default) namespace's numbers; the default namespace's metrics are unprefixed.
 * Ported from apex-editor's `logParser.ts`.
 */
export function parseLimitUsage(raw: string): LimitMetric[] {
  if (!raw) return [];
  let inBlock = false;
  let ns = '';
  const latest = new Map<string, LimitMetric>();
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const nsMatch = line.match(/\|LIMIT_USAGE_FOR_NS\|([^|]*)\|/) || line.trim().match(/^LIMIT_USAGE_FOR_NS\|([^|]*)\|/);
    if (nsMatch) {
      inBlock = true;
      ns = (nsMatch[1] ?? '').trim();
      continue;
    }
    if (!inBlock) continue;
    const trimmed = line.trim();
    if (!trimmed) { inBlock = false; continue; }
    if (/^\d{2}:\d{2}:\d{2}/.test(trimmed)) { inBlock = false; continue; }
    const m = trimmed.match(/^(.+?):\s*(\d+)\s+out of\s+(\d+)/i);
    if (m) {
      const metric = m[1].replace(/^Number of\s+/i, '').trim();
      const isDefault = !ns || /^\(default\)$/i.test(ns);
      const name = isDefault ? metric : `${ns}: ${metric}`;
      latest.set(name, { name, used: Number(m[2]), max: Number(m[3]) });
    }
  }
  return Array.from(latest.values());
}
