import { MetadataItem, SOBJECT_SUFFIX, isPlatformName } from './metadataScanner';

/**
 * Local dependency resolution for "Deploy File + Dependencies": walk Apex SOURCE
 * (not org errors) and collect the workspace components it references, so the
 * whole set goes up in ONE deploy instead of failing layer by layer and being
 * patched by failure-card suggestion round-trips.
 *
 * This is deliberately NOT an Apex parser — it is a token-level reference
 * extractor. Grammar-blind by design: a real parse would need the full Apex
 * language (generics, inner classes, SOQL binds, annotations …) to be RIGHT,
 * while token matching only needs to be USEFUL, because both failure modes are
 * cheap here:
 *
 *  - A FALSE POSITIVE (a token that happens to spell a workspace component's
 *    name without truly referencing it) deploys an unchanged copy of that
 *    component — harmless in a sandbox, and the deploy confirm modal names the
 *    full count before anything runs. The command is explicitly opt-in
 *    ("Deploy File + Dependencies"), so nobody gets an inflated set from a
 *    plain Deploy.
 *  - A MISSED reference simply reproduces today's behavior: the deploy fails,
 *    the failure card diagnoses it, and "Retry + missing" picks it up.
 *
 * So: best-effort inclusion, not a compiler. The security invariant still
 * holds absolutely — every returned key is `${type}:${name}` of a REAL scanned
 * MetadataItem; file text can only ever SELECT from the scan, never mint a key.
 */

/** Dependency layers to follow (entry = depth 0). Three covers the realistic
 *  service → helper → utility shape; deeper graphs are better served by a
 *  manifest than by an ever-larger implicit deploy set. */
export const DEFAULT_MAX_DEPTH = 3;
/** Cap on auto-included components. Past this size "deploy N components?" in
 *  the confirm modal stops being an informed yes — same reasoning as the
 *  changed-vs-branch retry cap, scaled down because every entry here is a
 *  GUESS from tokens, not a git fact. */
export const DEFAULT_MAX_DEPS = 40;

// Blank out line comments, block comments and single-quoted string literals,
// replacing every removed character with a space so surviving tokens keep their
// positions and can never fuse across a removed span (`a/*x*/b` must stay two
// tokens, not become `ab`). Apex has no double-quoted strings and block
// comments do NOT nest, so `/* a /* b */` ends at the FIRST `*/`. Inside a
// string a backslash escapes the next character (`'it\'s'`); an unterminated
// string is cut at the newline — Apex literals can't span lines, and swallowing
// the rest of the file over one stray quote would hide every later reference.
// (Line comments here because the examples must spell `*/` literally.)
export function stripApexNoise(source: string): string {
  const out = source.split('');
  type State = 'code' | 'line' | 'block' | 'str';
  let state: State = 'code';
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; out[i] = ' '; }
      else if (c === '/' && next === '*') { state = 'block'; out[i] = ' '; }
      else if (c === '\'') { state = 'str'; out[i] = ' '; }
    } else if (state === 'line') {
      if (c === '\n') state = 'code'; // keep the newline itself
      else out[i] = ' ';
    } else if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; out[i] = ' '; out[i + 1] = ' '; i++; }
      else if (c !== '\n') out[i] = ' '; // newlines survive for readable debug output
    } else { // str
      if (c === '\\') { out[i] = ' '; if (next !== undefined && next !== '\n') { out[i + 1] = ' '; i++; } }
      else if (c === '\'') { state = 'code'; out[i] = ' '; }
      else if (c === '\n') state = 'code'; // unterminated literal — damage stops here
      else out[i] = ' ';
    }
  }
  return out.join('');
}

/** Token crop from one Apex source: bare identifiers and `A.B` pairs, each
 *  deduped case-insensitively in first-appearance order — the order is what
 *  makes resolveLocalDependencies' output deterministic. */
export interface ApexTokens {
  identifiers: string[];
  dottedPairs: string[];
}

/**
 * Strip, then collect every identifier token `[A-Za-z_]\w*` and every dotted
 * pair `A.B` whose sides are both identifiers (whitespace around the dot
 * allowed — `Obj . Field` is legal Apex). A chain `a.b.c` yields both `a.b`
 * and `b.c`: only pairs are needed, because the one dotted shape that resolves
 * locally is CustomField `Object.Field`. Keywords and other non-references are
 * NOT filtered here — they simply match nothing in the scan, which is the
 * cheaper and safer filter.
 */
export function extractTokens(source: string): ApexTokens {
  const stripped = stripApexNoise(source);
  const re = /[A-Za-z_]\w*/g;
  const hits: Array<{ text: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) hits.push({ text: m[0], start: m.index, end: m.index + m[0].length });

  const identifiers: string[] = [];
  const dottedPairs: string[] = [];
  const seenIdent = new Set<string>();
  const seenPair = new Set<string>();
  for (let i = 0; i < hits.length; i++) {
    const ident = hits[i].text;
    const lower = ident.toLowerCase();
    if (!seenIdent.has(lower)) { seenIdent.add(lower); identifiers.push(ident); }
    if (i + 1 < hits.length && /^\s*\.\s*$/.test(stripped.slice(hits[i].end, hits[i + 1].start))) {
      const pair = `${ident}.${hits[i + 1].text}`;
      const pairLower = pair.toLowerCase();
      if (!seenPair.has(pairLower)) { seenPair.add(pairLower); dottedPairs.push(pair); }
    }
  }
  return { identifiers, dottedPairs };
}

export interface LocalDependencyResult {
  /** `Type:Name` keys of scanned workspace items the entry's source (transitively)
   *  references — entry keys excluded, BFS discovery order, deduped. */
  keys: string[];
  /** True when a cap (maxDepth or maxDeps) actually cut a reference that would
   *  otherwise have been included — the set may be incomplete. */
  truncated: boolean;
}

/**
 * BFS the local reference graph from `entry`. Only ApexClass / ApexTrigger
 * items are READ (they're the only types whose source is matchable tokens);
 * every discovered dependency must match a scanned item in `items`:
 *
 *  - identifier == ApexClass name (case-insensitive) → that class, and it is
 *    enqueued for further expansion;
 *  - identifier with an sObject suffix (SOBJECT_SUFFIX) == CustomObject name →
 *    that object (leaf);
 *  - dotted pair `Obj.Field` == CustomField `Obj.Field` → that field (leaf).
 *
 * Exclusions, applied BEFORE lookup: platform names (isPlatformName — a
 * platform name in a lookup can only ever be a false positive, e.g. a scanned
 * item unluckily named `Account`) and identifiers shorter than 3 chars (one-
 * and two-letter locals like `i`/`db` dominate Apex source and a real
 * component name that short is vanishingly rare — pure noise control).
 *
 * Matched keys carry the ITEM's canonical casing, never the source token's.
 * Cycle-safe via the seen-set (entry keys pre-seeded, so an entry is never
 * reported as its own dependency). Items dequeued AT maxDepth are read as a
 * PROBE only: their finds are not added, but an unseen find proves the cap
 * genuinely trimmed something, so `truncated` is exact rather than guessed —
 * bought with one extra layer of bounded reads. An unreadable file is skipped
 * (best-effort stance above: the deploy will tell the truth anyway).
 */
export async function resolveLocalDependencies(
  entry: MetadataItem[],
  items: MetadataItem[],
  readFile: (p: string) => Promise<string | undefined>,
  opts: { maxDepth?: number; maxDeps?: number } = {}
): Promise<LocalDependencyResult> {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxDeps = opts.maxDeps ?? DEFAULT_MAX_DEPS;

  // First occurrence wins on a case-insensitive collision — scanWorkspace sorts
  // items, so the winner is stable across runs.
  const apexByName = new Map<string, MetadataItem>();
  const objectByName = new Map<string, MetadataItem>();
  const fieldByName = new Map<string, MetadataItem>();
  for (const it of items) {
    const nameKey = it.name.toLowerCase();
    if (it.type === 'ApexClass' && !apexByName.has(nameKey)) apexByName.set(nameKey, it);
    else if (it.type === 'CustomObject' && !objectByName.has(nameKey)) objectByName.set(nameKey, it);
    else if (it.type === 'CustomField' && !fieldByName.has(nameKey)) fieldByName.set(nameKey, it);
  }

  const seen = new Set<string>(entry.map(e => `${e.type}:${e.name}`));
  const keys: string[] = [];
  let truncated = false;

  // BFS queue of Apex items to read. Depth is monotonically non-decreasing, so
  // once the cap fires everything behind it is at the boundary too.
  const queue: Array<{ item: MetadataItem; depth: number }> = entry
    .filter(e => e.type === 'ApexClass' || e.type === 'ApexTrigger')
    .map(item => ({ item, depth: 0 }));

  outer:
  while (queue.length) {
    const { item: current, depth } = queue.shift()!;
    const source = await readFile(current.filePath);
    if (source === undefined) continue;
    const { identifiers, dottedPairs } = extractTokens(source);

    // Per-file match order: identifiers in appearance order, then dotted pairs
    // in appearance order — combined with FIFO expansion this fixes the output
    // order completely (deterministic across runs).
    const found: MetadataItem[] = [];
    for (const ident of identifiers) {
      if (ident.length < 3 || isPlatformName(ident)) continue;
      const lower = ident.toLowerCase();
      const cls = apexByName.get(lower);
      if (cls) found.push(cls);
      // The suffix gate keeps a bare word from pulling in a same-named object:
      // only `Foo__c`-shaped tokens can be sObject references.
      if (SOBJECT_SUFFIX.test(ident)) {
        const obj = objectByName.get(lower);
        if (obj) found.push(obj);
      }
    }
    for (const pair of dottedPairs) {
      if (isPlatformName(pair)) continue;
      const fld = fieldByName.get(pair.toLowerCase());
      if (fld) found.push(fld);
    }

    for (const dep of found) {
      const depKey = `${dep.type}:${dep.name}`;
      if (seen.has(depKey)) continue;
      if (depth >= maxDepth) {
        // Probe layer: this unseen find is exactly what the depth cap cut.
        truncated = true;
        break outer;
      }
      if (keys.length >= maxDeps) {
        truncated = true;
        break outer;
      }
      seen.add(depKey);
      keys.push(depKey);
      if (dep.type === 'ApexClass') queue.push({ item: dep, depth: depth + 1 });
    }
  }
  return { keys, truncated };
}
