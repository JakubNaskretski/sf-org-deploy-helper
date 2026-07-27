/**
 * Suggestion feedback log — a small, locally-persisted record of every
 * dependency suggestion the failure card offered and what the user did with it.
 * Exists so suggestion quality can be judged from real usage: the
 * "Show Suggestion Log" command renders this as a short copy-pasteable text
 * summary. Pure data + formatting only; persistence lives in the provider
 * (globalState) so this module stays trivially testable.
 */

export interface SuggestionCandidate {
  /** Canonical Type:Name of the suggested component (always a real scanned item). */
  key: string;
  /** The failing component whose error produced this suggestion, Type:Name. */
  from?: string;
}

export interface SuggestionLogEntry {
  /** The card's suggestion id — the correlation key for updates. Two cards can
   *  share an `at` (same-millisecond failures); ids never collide. */
  id?: string;
  /** Epoch millis when the suggestion UI was opened. */
  at: number;
  /** Org label the failed deploy targeted (alias, not username). */
  org?: string;
  candidates: SuggestionCandidate[];
  /** What the user did: opened the panel, deployed with a selection, or backed out. */
  action: 'opened' | 'accepted' | 'declined';
  /** Keys the user kept ticked when deploying. */
  accepted?: string[];
  /** Keys the user unticked (or all, on a full decline). */
  declined?: string[];
  /** The user's answer to "was this suggestion off?" after declining. */
  verdict?: 'bad' | 'fine';
  /** Terminal result of the accepted retry. 'aborted' = never reached the org. */
  outcome?: 'worked' | 'failed' | 'aborted';
}

/** Bounded history — old entries fall off; this is a feedback notebook, not an audit log. */
export const SUGGESTION_LOG_CAP = 200;

/** Append with cap, newest last. Returns a new array; never mutates the input. */
export function appendSuggestionEntry(
  entries: SuggestionLogEntry[],
  entry: SuggestionLogEntry
): SuggestionLogEntry[] {
  const next = [...entries, entry];
  return next.length > SUGGESTION_LOG_CAP ? next.slice(next.length - SUGGESTION_LOG_CAP) : next;
}

/**
 * Merge a patch into the entry with `id` (appending when absent). Fields the
 * patch sets — INCLUDING explicit undefined — win over the stored entry: an
 * accept after a decline must clear the stale verdict/declined residue, or the
 * log reads self-contradictory ("deployed 2/2, marked BAD"). Returns a new
 * array; never mutates.
 */
export function mergeSuggestionEntry(
  entries: SuggestionLogEntry[],
  id: string,
  at: number,
  patch: Partial<SuggestionLogEntry>
): SuggestionLogEntry[] {
  const i = entries.findIndex(e => e.id === id);
  const merged = { ...(i >= 0 ? entries[i] : { id, at, candidates: [], action: 'opened' as const }), ...patch };
  // Drop keys the patch explicitly cleared so persistence stays compact.
  for (const k of Object.keys(merged) as Array<keyof SuggestionLogEntry>) {
    if (merged[k] === undefined) delete merged[k];
  }
  const entry = merged as SuggestionLogEntry;
  return i >= 0 ? [...entries.slice(0, i), entry, ...entries.slice(i + 1)] : appendSuggestionEntry(entries, entry);
}

function two(n: number): string { return n < 10 ? `0${n}` : String(n); }

function stamp(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * Render the log as short plain text, one line per entry, built for pasting
 * into a chat/issue verbatim. Newest entries LAST (chronological reading).
 */
export function formatSuggestionLog(entries: SuggestionLogEntry[]): string {
  if (entries.length === 0) {
    return 'Suggestion log — empty. Suggestions appear on deploy-failure cards when a missing dependency exists in the workspace.';
  }
  const accepted = entries.filter(e => e.action === 'accepted');
  const deployed = accepted.filter(e => e.outcome !== 'aborted');
  const worked = deployed.filter(e => e.outcome === 'worked');
  const notRun = accepted.length - deployed.length;
  const declined = entries.filter(e => e.action === 'declined');
  const bad = declined.filter(e => e.verdict === 'bad');
  const header = `Suggestion log — ${entries.length} entries · ${deployed.length} deployed (${worked.length} worked)${notRun ? ` · ${notRun} not run` : ''} · ${declined.length} declined (${bad.length} marked bad)`;

  const lines = entries.map(e => {
    const what = e.candidates.map(c => c.key).join(', ') || '(none)';
    let act: string;
    if (e.action === 'accepted') {
      const n = e.accepted?.length ?? 0;
      const dropped = e.declined?.length ? ` (unticked ${e.declined.join(', ')})` : '';
      const outcome = e.outcome === 'worked' ? 'retry OK'
        : e.outcome === 'failed' ? 'retry still failed'
        : e.outcome === 'aborted' ? 'retry not run'
        : 'retry outcome unknown';
      act = `deployed ${n}/${e.candidates.length}${dropped} — ${outcome}`;
    } else if (e.action === 'declined') {
      act = `declined${e.verdict === 'bad' ? ', marked BAD' : e.verdict === 'fine' ? ', made sense' : ''}`;
    } else {
      act = 'opened, no decision';
    }
    return `${stamp(e.at)}  ${e.org ?? '?'}  ${what}  ->  ${act}`;
  });
  return [header, '', ...lines].join('\n');
}
