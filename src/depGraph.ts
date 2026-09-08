import { MetadataItem, SOBJECT_SUFFIX, isPlatformName } from './metadataScanner';

/**
 * Local dependency resolution for "Deploy File + Dependencies": walk local
 * SOURCE (not org errors) — Apex classes/triggers plus LWC and Aura bundles —
 * and collect the workspace components it references, so the whole set goes up
 * in ONE deploy instead of failing layer by layer and being patched by
 * failure-card suggestion round-trips.
 *
 * The Apex side is deliberately NOT an Apex parser — it is a token-level reference
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

/** Dependency layers to follow (entry = depth 0). TWO covers the realistic
 *  service → helper → utility shape — the entry is the service, its own
 *  references are depth 1, theirs depth 2 — and deeper graphs are better served
 *  by a manifest than by an ever-larger implicit deploy set.
 *
 *  It was 3, which allowed a FOURTH layer the rationale never claimed. Each Apex
 *  layer multiplies, and every entry here is a token GUESS, so that extra layer is
 *  where a one-file deploy turned into the ~25-component set the user could not
 *  account for. Reduced rather than papered over with heuristics: nothing short of
 *  a real parser makes a fourth layer of guesses trustworthy, and a miss is the
 *  cheap failure (the deploy fails and the failure card's suggestions pick it up).
 */
export const DEFAULT_MAX_DEPTH = 2;
/** Cap on auto-included components. Past this size "deploy N components?" in
 *  the confirm modal stops being an informed yes — same reasoning as the
 *  changed-vs-branch retry cap, scaled down because every entry here is a
 *  GUESS from tokens, not a git fact. */
export const DEFAULT_MAX_DEPS = 40;
/** Cap on source files read per LWC/Aura bundle. A bundle is a DIRECTORY, so
 *  unlike an Apex class there is no single file to read and `files` can hold
 *  dozens of entries (extra templates, jest specs, snapshots). Twelve covers
 *  every hand-written bundle shape while keeping the worst case bounded. */
export const DEFAULT_MAX_BUNDLE_FILES = 12;

/** Bundle files worth reading, in READ ORDER (the order also fixes the output
 *  order, see resolveLocalDependencies). LWC: the module first (its imports are
 *  the declared dependencies), then the template (child component tags). Aura:
 *  markup only — an Aura controller/helper `.js` reaches Apex indirectly through
 *  `component.get('c.method')`, which names a method on the component and not a
 *  deployable class, so reading it would add noise and no keys. Nothing else in
 *  a bundle (css, svg, images, snapshots) can declare a component reference. */
const BUNDLE_READ_EXTS = new Map<string, string[]>([
  ['LightningComponentBundle', ['.js', '.html']],
  ['AuraDefinitionBundle', ['.cmp', '.app', '.evt', '.intf', '.design']]
]);

/** Types whose source this module can read. Everything else is a leaf: it either
 *  has no source (CustomObject is a folder of XML) or nothing that names another
 *  workspace component in a shape worth guessing at. Exported so the command can
 *  tell the user the truth BEFORE deploying instead of silently scanning nothing.
 *  ApexPage/ApexComponent (Visualforce) read their own markup — see
 *  extractVisualforceRefs — the same way LWC/Aura read theirs. */
export function canScanDependencies(type: string): boolean {
  return type === 'ApexClass' || type === 'ApexTrigger' || type === 'ApexPage' || type === 'ApexComponent'
    || BUNDLE_READ_EXTS.has(type);
}

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
  /** Identifiers eligible to name a TOP-LEVEL component (see extractTokens' member
   *  rule) — not every identifier in the file. */
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
 *
 * MEMBER RULE: an identifier whose every occurrence sits immediately after a `.`
 * is dropped from `identifiers`. In `a.b`, `b` is a member of `a` — a method, a
 * field, an inner class, a namespaced class — and none of those is a separately
 * deployable component in this workspace; whatever IS deployable there is named
 * by the left side, which is matched on its own. It costs nothing, needs no
 * grammar (the same one-dot-between-tokens test the pairs already use), and it
 * removes a false positive that shows up in ordinary code: `Order__c.Customer__c`
 * used to pull in the CustomObject `Customer__c` on top of the CustomField it
 * really names. One occurrence anywhere in the file outside member position is
 * enough to keep the identifier — which matters because the dedupe is
 * case-insensitive, so in `MyClass myClass = new MyClass();` the type and the
 * variable are the SAME key and a per-key rule must not lose the type.
 */
export function extractTokens(source: string): ApexTokens {
  const stripped = stripApexNoise(source);
  const re = /[A-Za-z_]\w*/g;
  const hits: Array<{ text: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) hits.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  // True when the only thing between hits i-1 and i is a single dot.
  const dotJoined = (i: number): boolean =>
    i > 0 && /^\s*\.\s*$/.test(stripped.slice(hits[i - 1].end, hits[i].start));

  // Keys in first-appearance order, with the spelling of the first occurrence;
  // eligibility is decided across ALL occurrences, so the order stays independent
  // of where the deciding occurrence was.
  const order: string[] = [];
  const spelling = new Map<string, string>();
  const eligible = new Set<string>();
  const dottedPairs: string[] = [];
  const seenPair = new Set<string>();
  for (let i = 0; i < hits.length; i++) {
    const ident = hits[i].text;
    const lower = ident.toLowerCase();
    if (!spelling.has(lower)) { spelling.set(lower, ident); order.push(lower); }
    if (!dotJoined(i)) eligible.add(lower);
    if (i + 1 < hits.length && dotJoined(i + 1)) {
      const pair = `${ident}.${hits[i + 1].text}`;
      const pairLower = pair.toLowerCase();
      if (!seenPair.has(pairLower)) { seenPair.add(pairLower); dottedPairs.push(pair); }
    }
  }
  return { identifiers: order.filter(k => eligible.has(k)).map(k => spelling.get(k)!), dottedPairs };
}

/* ------------------------------------------------------------------ bundles
 * LWC and Aura are the opposite case from Apex: their dependencies are
 * DECLARED, with a fixed grammar (`@salesforce/...` imports, `c:` / `c-` tags),
 * so this branch is a narrow reader rather than the Apex branch's token crop —
 * near-zero false positives, and nothing is matched by accident.
 */

/** One referent found in bundle source, as an ORDERED list of (type, name)
 *  lookups — first hit wins. `c:widget` in Aura markup is either an Aura bundle
 *  or an LWC, and an ordered try-list adds whichever exists instead of both.
 *  Same shape and same reason as metadataScanner's Candidate.tries: a try is
 *  only ever a LOOKUP, so a wrong shape rule resolves to nothing and can never
 *  mint a key. */
export interface BundleRef {
  tries: Array<{ type: string; name: string }>;
}

/** JS source with comments and string CONTENT blanked (delimiters kept), plus
 *  every string literal that survived in CODE position, with the offset of its
 *  opening quote. */
export interface JsStringScan {
  code: string;
  strings: Array<{ value: string; at: number }>;
}

/**
 * The Apex pass blanks strings; here a dependency IS a string
 * (`from '@salesforce/apex/X.y'`), so blanking them would erase exactly what
 * must be read. Instead every literal is RECORDED with its position while the
 * emitted `code` keeps only the positions (comments and string bodies become
 * spaces), which is what later decides whether a literal sits in a module
 * specifier position. Two consequences fall out for free: an import spelled
 * inside a comment leaves no literal at all, and one spelled inside another
 * string is part of THAT literal's body and is never recorded on its own.
 *
 * Backtick templates are treated as plain strings — a `${...}` specifier is not
 * statically resolvable anyway, and holding the whole span as one literal keeps
 * quotes inside the interpolation from desyncing the scan. A regex literal that
 * contains an unmatched quote (`/['"]/`) WILL desync it; that costs a missed or
 * bogus lookup, which is the module's cheap-failure stance, and detecting regex
 * literals needs expression-position tracking this reader has no use for.
 */
export function scanJsStrings(source: string): JsStringScan {
  const out = source.split('');
  const strings: Array<{ value: string; at: number }> = [];
  type State = 'code' | 'line' | 'block' | 'str';
  let state: State = 'code';
  let quote = '';
  let at = -1;
  let value = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; out[i] = ' '; }
      else if (c === '/' && next === '*') { state = 'block'; out[i] = ' '; }
      else if (c === '\'' || c === '"' || c === '`') { state = 'str'; quote = c; at = i; value = ''; }
    } else if (state === 'line') {
      if (c === '\n') state = 'code'; // keep the newline itself
      else out[i] = ' ';
    } else if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; out[i] = ' '; out[i + 1] = ' '; i++; }
      else if (c !== '\n') out[i] = ' ';
    } else { // str
      if (c === '\\') { out[i] = ' '; if (next !== undefined) { out[i + 1] = ' '; value += next; i++; } }
      else if (c === quote) { state = 'code'; strings.push({ value, at }); }
      // An unterminated '/" literal is cut at the newline (same reasoning as the
      // Apex pass); a backtick template legitimately spans lines.
      else if (c === '\n' && quote !== '`') state = 'code';
      else { out[i] = ' '; value += c; }
    }
  }
  return { code: out.join(''), strings };
}

// A literal is a module specifier only when the code immediately before it is
// `import`/`from` (bare, or `import(` for the dynamic form) — so a data string
// that happens to spell '@salesforce/apex/X.y' contributes nothing. Matched
// against a short window before the quote instead of the whole prefix, to keep
// a file with thousands of literals linear; when the window had to be cut, the
// `^` alternative is dropped so a sliced `…myimport` can't read as `import`.
const SPECIFIER_AT_START = /(?:^|[^\w$.])(?:import|from)\s*\(?\s*$/;
const SPECIFIER_AFTER_BREAK = /[^\w$.](?:import|from)\s*\(?\s*$/;
const SPECIFIER_WINDOW = 64;

/** Referents declared by one LWC module's import specifiers. */
export function extractLwcModuleRefs(source: string): BundleRef[] {
  const { code, strings } = scanJsStrings(source);
  const refs: BundleRef[] = [];
  for (const lit of strings) {
    const from = Math.max(0, lit.at - SPECIFIER_WINDOW);
    const before = code.slice(from, lit.at);
    if (!(from === 0 ? SPECIFIER_AT_START : SPECIFIER_AFTER_BREAK).test(before)) continue;
    const ref = specifierRef(lit.value);
    if (ref) refs.push(ref);
  }
  return refs;
}

/**
 * Map one import specifier to the workspace component it names, or undefined.
 * Only the `@salesforce/*` families that address a DEPLOYABLE component are
 * handled — `label`, `i18n`, `user`, `client` and friends either aren't
 * individually deployable (a label lives inside the CustomLabels container) or
 * aren't metadata at all. `lightning/*` and every other namespace is platform
 * or managed code, so the one bare form that can name a workspace component is
 * the `c/` namespace.
 */
function specifierRef(spec: string): BundleRef | undefined {
  const SF = '@salesforce/';
  if (spec.startsWith(SF)) {
    const rest = spec.slice(SF.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return undefined;
    const family = rest.slice(0, slash);
    const arg = rest.slice(slash + 1);
    const parts = arg.split('.');
    if (family === 'apex' || family === 'apexContinuation') {
      // `apex/Class.method`, or bare `apex/Class`. Three segments means
      // `ns.Class.method` — a managed class, nothing in this workspace.
      return parts.length > 2 ? undefined : { tries: [{ type: 'ApexClass', name: parts[0] }] };
    }
    if (family === 'schema') {
      // `schema/Obj.Field` names the FIELD (its own deployable child); a
      // relationship path `Obj.Rel.Field` still starts with the local hop.
      // `schema/Obj` alone names the object. A `Rel__r` hop is the relationship
      // NAME, not a field — `Obj.Rel__r` can never resolve — so when it ends in
      // `__r` also try the `__c` field the relationship is built on (A7).
      if (parts.length >= 2) {
        const tries = [{ type: 'CustomField', name: `${parts[0]}.${parts[1]}` }];
        if (/__r$/i.test(parts[1])) tries.push({ type: 'CustomField', name: `${parts[0]}.${parts[1].replace(/__r$/i, '__c')}` });
        return { tries };
      }
      return { tries: [{ type: 'CustomObject', name: parts[0] }] };
    }
    if (family === 'messageChannel') {
      // The specifier carries the `__c` that the source file name does NOT
      // (`SampleChannel__c` imports `messageChannels/SampleChannel.messageChannel-meta.xml`),
      // so try it verbatim first and stripped second.
      return { tries: [
        { type: 'LightningMessageChannel', name: arg },
        { type: 'LightningMessageChannel', name: arg.replace(/__c$/i, '') }
      ] };
    }
    if (family === 'resourceUrl') return { tries: [{ type: 'StaticResource', name: arg }] };
    return undefined;
  }
  const bare = /^([A-Za-z_]\w*)\/([A-Za-z_]\w*)$/.exec(spec);
  if (!bare || bare[1] !== 'c') return undefined;
  return { tries: [{ type: 'LightningComponentBundle', name: bare[2] }] };
}

/** Blank `<!-- ... -->` spans, space-for-character so surviving markup keeps its
 *  positions (same reasoning as stripApexNoise). Newlines survive. */
export function stripMarkupComments(source: string): string {
  const out = source.split('');
  let i = 0;
  while (i < source.length) {
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      const stop = end < 0 ? source.length : end + 3;
      for (let j = i; j < stop; j++) if (out[j] !== '\n') out[j] = ' ';
      i = stop;
    } else i++;
  }
  return out.join('');
}

/** Child components used by an LWC template: `<c-child-cmp>` addresses the
 *  bundle `childCmp`. The tag is kebab-case and the bundle name is camelCase, so
 *  the dashes are squashed out and the (case-insensitive) index does the rest —
 *  the key still carries the ITEM's casing, never the tag's. */
export function extractLwcTemplateRefs(source: string): BundleRef[] {
  const markup = stripMarkupComments(source);
  const refs: BundleRef[] = [];
  const re = /<\s*c-([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markup))) {
    refs.push({ tries: [{ type: 'LightningComponentBundle', name: m[1].replace(/-/g, '') }] });
  }
  return refs;
}

/** Referents declared by one Aura markup file. Bundle references first (in
 *  appearance order), then Apex controllers — a fixed per-file order, like the
 *  Apex branch's identifiers-then-pairs. */
export function extractAuraRefs(source: string): BundleRef[] {
  const markup = stripMarkupComments(source);
  const refs: BundleRef[] = [];
  // One rule covers every place a `c:` component is named: `<c:child/>`,
  // `</c:child>`, `extends="c:base"`, `implements="c:iface"` and
  // `<aura:dependency resource="c:child"/>`. An Aura tag can also address an
  // LWC, hence the two ordered tries.
  const tag = /(?:^|[^\w.:])c:([A-Za-z_]\w*)/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(markup))) {
    refs.push({ tries: [
      { type: 'AuraDefinitionBundle', name: m[1] },
      { type: 'LightningComponentBundle', name: m[1] }
    ] });
  }
  // `controller="MyCtrl"` on aura:component/aura:application. A managed
  // `ns.MyCtrl` has no local class, but the last segment is the class name in
  // both shapes and an unmatched guess costs nothing.
  const ctrl = /\bcontroller\s*=\s*["']([^"']+)["']/g;
  while ((m = ctrl.exec(markup))) {
    const name = m[1].slice(m[1].lastIndexOf('.') + 1).trim();
    if (name) refs.push({ tries: [{ type: 'ApexClass', name }] });
  }
  // `{!$Resource.X}` (an attribute value) or `$Resource.X` (inside an
  // expression like ltng:require's styles) — either way the static resource
  // name follows the same dotted token (A8).
  const resource = /\$Resource\.(\w+)/g;
  while ((m = resource.exec(markup))) refs.push({ tries: [{ type: 'StaticResource', name: m[1] }] });
  return refs;
}

/**
 * Referents declared by one Visualforce `.page`/`.component` file's markup
 * (A6/A14). Unlike Aura's `c:` (which can address either an Aura bundle or an
 * LWC), VF's `c:` namespace addresses a Visualforce custom COMPONENT only — a
 * single try, not a chain. `standardController="Account"` is deliberately NOT
 * matched: the regex below requires the exact attribute name `controller`, and
 * VF's camelCase `standardController` never contains that lowercase word at a
 * boundary, so no separate exclusion is needed.
 */
export function extractVisualforceRefs(source: string): BundleRef[] {
  const markup = stripMarkupComments(source);
  const refs: BundleRef[] = [];
  let m: RegExpExecArray | null;
  const controller = /\bcontroller\s*=\s*["']([^"']+)["']/g;
  while ((m = controller.exec(markup))) refs.push({ tries: [{ type: 'ApexClass', name: m[1].trim() }] });
  const extensions = /\bextensions\s*=\s*["']([^"']+)["']/g;
  while ((m = extensions.exec(markup))) {
    for (const name of m[1].split(',')) {
      const trimmed = name.trim();
      if (trimmed) refs.push({ tries: [{ type: 'ApexClass', name: trimmed }] });
    }
  }
  const resource = /\$Resource\.(\w+)/g;
  while ((m = resource.exec(markup))) refs.push({ tries: [{ type: 'StaticResource', name: m[1] }] });
  const componentTag = /<\s*c:([A-Za-z_]\w*)/g;
  while ((m = componentTag.exec(markup))) refs.push({ tries: [{ type: 'ApexComponent', name: m[1] }] });
  return refs;
}

/** Like stripApexNoise, but records string-literal CONTENT (with its opening
 *  quote's offset) instead of blanking it — needed only by the narrow
 *  string-literal reference pass below, which has to read the text
 *  stripApexNoise deliberately throws away. Same comment/string rules as
 *  stripApexNoise (single-quote only, backslash escape, block comments don't
 *  nest, an unterminated literal is cut at the newline) — kept as a separate
 *  function rather than a shared flag so stripApexNoise's hot path (every Apex
 *  file read) stays untouched by this narrower need. */
export function scanApexStrings(source: string): JsStringScan {
  const out = source.split('');
  const strings: Array<{ value: string; at: number }> = [];
  type State = 'code' | 'line' | 'block' | 'str';
  let state: State = 'code';
  let at = -1;
  let value = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; out[i] = ' '; }
      else if (c === '/' && next === '*') { state = 'block'; out[i] = ' '; }
      else if (c === '\'') { state = 'str'; at = i; value = ''; out[i] = ' '; }
    } else if (state === 'line') {
      if (c === '\n') state = 'code';
      else out[i] = ' ';
    } else if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; out[i] = ' '; out[i + 1] = ' '; i++; }
      else if (c !== '\n') out[i] = ' ';
    } else { // str
      if (c === '\\') { out[i] = ' '; if (next !== undefined && next !== '\n') { out[i + 1] = ' '; value += next; i++; } }
      else if (c === '\'') { state = 'code'; out[i] = ' '; strings.push({ value, at }); }
      else if (c === '\n') state = 'code'; // unterminated literal — damage stops here
      else { out[i] = ' '; value += c; }
    }
  }
  return { code: out.join(''), strings };
}

const TYPE_FORNAME_WINDOW = 40;
const TYPE_FORNAME_BEFORE = /(?:^|[^\w.])Type\s*\.\s*forName\s*\(\s*$/;
const FROM_OBJECT = /\bFROM\s+([A-Za-z_]\w*(?:__c|__mdt))\b/i;

/**
 * Two narrow, declared-looking shapes read out of Apex string literals (A6) —
 * every OTHER string in the file stays invisible to the token matcher (see
 * stripApexNoise), so reaching into just these two costs no new false-positive
 * surface as long as the shape stays this specific:
 *  - `Type.forName('X')` — dynamic Apex, the one place a class name is only
 *    ever a string, never a token;
 *  - a SOQL `FROM X__c` / `FROM X__mdt` clause inside any string (typically
 *    `Database.query('SELECT … FROM X__c')`) — the query text is what
 *    matters, not what wraps it.
 * Matched against the RAW literal text, so case-folding is intentionally kept
 * here — unlike the identifier/dottedPair branch (see A4's exact-case fix): a
 * hardcoded string is a deliberate, authored reference, not a token collision
 * with a variable/parameter/method name, so lookupRef's case-insensitive
 * resolution is exactly the bundle-ref precedent, not the risk A4 removed.
 */
export function extractApexStringRefs(source: string): BundleRef[] {
  const { code, strings } = scanApexStrings(source);
  const refs: BundleRef[] = [];
  for (const lit of strings) {
    const from = Math.max(0, lit.at - TYPE_FORNAME_WINDOW);
    if (TYPE_FORNAME_BEFORE.test(code.slice(from, lit.at))) {
      refs.push({ tries: [{ type: 'ApexClass', name: lit.value }] });
      continue;
    }
    const m = FROM_OBJECT.exec(lit.value);
    if (m) refs.push({ tries: [{ type: 'CustomObject', name: m[1] }] });
  }
  return refs;
}

/** Scanned items indexed as type → lowercased name → item, for exactly the types
 *  a reader can name. ONE index for both branches, so an LWC import and an Apex
 *  token can never resolve by different rules. First occurrence wins on a
 *  case-insensitive collision — scanWorkspace sorts items, so the winner is
 *  stable across runs. */
type ScanIndex = Map<string, Map<string, MetadataItem>>;

const INDEXED_TYPES = ['ApexClass', 'ApexPage', 'ApexComponent', 'CustomObject', 'CustomField',
  'LightningComponentBundle', 'AuraDefinitionBundle', 'LightningMessageChannel', 'StaticResource'];

function buildIndex(items: MetadataItem[]): ScanIndex {
  const idx: ScanIndex = new Map(INDEXED_TYPES.map(t => [t, new Map<string, MetadataItem>()]));
  for (const it of items) {
    const byName = idx.get(it.type);
    if (!byName) continue;
    const key = it.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, it);
  }
  return idx;
}

/** First hit across a referent's ordered tries. Platform names are skipped for
 *  the same reason the Apex branch skips them in lookups: pulling `Account` into
 *  a deploy set because a component imported `@salesforce/schema/Account.Name`
 *  is exactly the surprise the confirm modal's count cannot explain. The 3-char
 *  identifier floor is NOT applied here — these referents are declared, not
 *  cropped from noise, so a short name is a real reference. */
function lookupRef(ref: BundleRef, idx: ScanIndex): MetadataItem | undefined {
  for (const t of ref.tries) {
    if (isPlatformName(t.name)) continue;
    const hit = idx.get(t.type)?.get(t.name.toLowerCase());
    if (hit) return hit;
  }
  return undefined;
}

const FILE_EXT = /\.[A-Za-z0-9]+$/;
// Jest specs and manual mocks live inside the bundle folder but are never
// deployed, and their imports are test doubles rather than dependencies.
const BUNDLE_SKIP_DIR = /(^|[\\/])__(tests|mocks)__[\\/]/;

/** Read one bundle's source files and resolve everything they declare. Files are
 *  taken from the item's already-scanned `files` (no second directory walk) and
 *  ordered by read rank then path, because the scan's own order is
 *  filesystem-dependent and the output order is part of this module's contract.
 *  `trimmed` is an upper bound, not a proof like the depth probe: past maxFiles
 *  the remaining files are never opened, so whether they held a reference is
 *  unknown and the honest answer is "the set may be incomplete". */
async function collectBundleRefs(
  item: MetadataItem,
  idx: ScanIndex,
  readFile: (p: string) => Promise<string | undefined>,
  maxFiles: number
): Promise<{ found: MetadataItem[]; trimmed: boolean; skippedFiles: number; unreadable: boolean }> {
  const exts = BUNDLE_READ_EXTS.get(item.type) ?? [];
  const ranked = item.files
    .filter(f => !BUNDLE_SKIP_DIR.test(f))
    .map(f => ({ file: f, rank: exts.indexOf((FILE_EXT.exec(f)?.[0] ?? '').toLowerCase()) }))
    .filter(c => c.rank >= 0)
    .sort((a, b) => a.rank - b.rank || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  const found: MetadataItem[] = [];
  const taken = new Set<string>();
  let attempted = 0;
  let readOk = 0;
  for (const cand of ranked.slice(0, maxFiles)) {
    attempted++;
    const text = await readFile(cand.file);
    if (text === undefined) continue; // unreadable file — best-effort, as with Apex
    readOk++;
    const refs = item.type === 'AuraDefinitionBundle'
      ? extractAuraRefs(text)
      : cand.rank === 0 ? extractLwcModuleRefs(text) : extractLwcTemplateRefs(text);
    for (const ref of refs) {
      const hit = lookupRef(ref, idx);
      if (!hit) continue;
      const key = `${hit.type}:${hit.name}`;
      // A child tag repeated 20× in a template is one dependency.
      if (taken.has(key)) continue;
      taken.add(key);
      found.push(hit);
    }
  }
  return {
    found,
    trimmed: ranked.length > maxFiles,
    // Files never opened because of the cap — an "at least N more" component of
    // `dropped` (A13), same bounded-no-extra-walk stance as the depth/count caps.
    skippedFiles: Math.max(0, ranked.length - maxFiles),
    // Every candidate file was attempted AND every attempt failed — as opposed
    // to a bundle with no matching-extension file at all (attempted stays 0),
    // which is "nothing to scan", not "could not read" (A10).
    unreadable: attempted > 0 && readOk === 0
  };
}

/** One auto-included component, WITH the reason it is in the set. A bare key list
 *  is unjudgeable: the user picked one file and got back a set they did not
 *  choose, and "why is ApexClass:Helper here?" has no answer anywhere in the UI.
 *  Attribution is that answer, and it doubles as the diagnosis when the token
 *  matcher over-includes — an entry whose `from` makes no sense localises the bad
 *  match to one file instead of indicting the whole set. */
export interface LocalDependencyRef {
  /** `Type:Name` of the included component. */
  key: string;
  /** `Type:Name` of the component whose SOURCE referenced it. The first discoverer
   *  wins, matching the BFS order and the dedupe: a component reached from two
   *  places is reported once, by the shallowest reference to it. */
  from: string;
  /** Layers below the entry — 1 for something the entry itself references. */
  depth: number;
  /** True when this was a BARE type token (`Foo__c`) rather than a reference to
   *  one of its fields — deploying it sends the whole CustomObject folder
   *  (every field, validation rule, …), not just the token that named it. Unset
   *  when a CustomField on the SAME object already matched from the same file
   *  (A3): the field alone is included and the redundant whole-object match is
   *  dropped, so this flag only ever appears on a standalone object match. */
  bareObject?: boolean;
}

export interface LocalDependencyResult {
  /** `Type:Name` keys of scanned workspace items the entry's source (transitively)
   *  references — entry keys excluded, BFS discovery order, deduped. Derived from
   *  `refs` so the deploy payload and its explanation can never disagree. */
  keys: string[];
  /** One entry per key, same order — see LocalDependencyRef. */
  refs: LocalDependencyRef[];
  /** True when a cap cut something: maxDepth or maxDeps actually dropped a
   *  reference, or maxBundleFiles left part of a bundle unread. Either way the
   *  set may be incomplete. */
  truncated: boolean;
  /** At least this many more reachable references were never followed once a
   *  cap fired — the remaining BFS queue plus the still-unseen finds sitting at
   *  the exact point a cap cut them, deduped (A13). Zero unless `truncated`.
   *  A floor, not a proof: none of it costs another read (bounded, no extra
   *  walk), so it undercounts whatever those unexplored nodes would have found. */
  dropped: number;
  /** `Type:Name` keys of ENTRY items (depth 0) whose file could not be read —
   *  never a deeper dependency, where a miss is ordinary best-effort silence.
   *  An unreadable entry produces an empty dependency set that looks exactly
   *  like "genuinely has none" unless the caller surfaces this (A10). */
  unreadableEntries: string[];
}

/** One display line per auto-included component, naming the component that
 *  referenced it. The depth is spelled out only past the first layer: at depth 1
 *  `from` IS the file the user right-clicked, so "(depth 1)" would only add noise.
 *  A bare-object match (see LocalDependencyRef.bareObject) gets its own honest
 *  parenthetical — deploying it is not just "this one component". Matches the
 *  failure-card suggestion rows' cause-then-effect reading order. */
export function formatDependencyAttribution(refs: LocalDependencyRef[]): string[] {
  return refs.map(r => {
    const depthNote = r.depth > 1 ? ` (depth ${r.depth})` : '';
    const bareNote = r.bareObject ? ' (deploys its local child metadata too)' : '';
    return `${r.key} — referenced by ${r.from}${depthNote}${bareNote}`;
  });
}

/**
 * BFS the local reference graph from `entry`. Only items canScanDependencies
 * accepts are READ; every discovered dependency must match a scanned item in
 * `items`. From Apex/trigger source (tokens), EXACT CASE against the item's
 * canonical name — no folding (A4: a case-folded hit here is what let a local
 * variable/parameter/method name masquerade as a reference to an unrelated
 * class of the same name folded; case-folding stays for bundle/string refs
 * below, which are declared rather than cropped):
 *
 *  - identifier == ApexClass name → that class, enqueued for further expansion;
 *  - identifier with an sObject suffix (SOBJECT_SUFFIX) == CustomObject name →
 *    that object (leaf) — UNLESS a CustomField on the same object already
 *    matched from the same file (A3: the field alone is included, and the
 *    redundant whole-object match — which would deploy every other field and
 *    rule on top of it — is dropped; when a bare object IS added, its
 *    attribution line says so, see formatDependencyAttribution);
 *  - dotted pair `Obj.Field` == CustomField `Obj.Field` → that field (leaf);
 *  - dotted pair `Page.X` == ApexPage `X` → that page (A6, enqueued: a VF page
 *    can itself declare further references);
 *  - two narrow string-literal shapes — `Type.forName('X')` and a SOQL
 *    `FROM X__c`/`FROM X__mdt` clause — see extractApexStringRefs (A6).
 *
 * From an LWC/Aura bundle (declared references — see collectBundleRefs): Apex
 * classes, objects, fields, message channels, static resources, and child
 * bundles, which are enqueued like a class. From a Visualforce page/component
 * (declared references — see extractVisualforceRefs, A6/A14): Apex classes
 * (controller/extensions), static resources, and child VF components.
 *
 * Exclusions, applied BEFORE lookup: platform names (isPlatformName — a
 * platform name in a lookup can only ever be a false positive, e.g. a scanned
 * item unluckily named `Account`) and, for Apex tokens only, identifiers
 * shorter than 3 chars (one- and two-letter locals like `i`/`db` dominate Apex
 * source and a real component name that short is vanishingly rare — pure noise
 * control). extractTokens has already dropped member-position-only identifiers
 * (see its MEMBER RULE) before any of this runs.
 *
 * Matched keys carry the ITEM's canonical casing, never the source token's.
 * Cycle-safe via the seen-set (entry keys pre-seeded, so an entry is never
 * reported as its own dependency). Items dequeued AT maxDepth are read as a
 * PROBE only: their finds are not added, but an unseen find proves the cap
 * genuinely trimmed something, so `truncated` is exact rather than guessed —
 * bought with one extra layer of bounded reads; `dropped` then bounds HOW MUCH
 * was cut (A13), cheaply (remaining queue + unseen finds at the cutoff, no
 * extra reads). An unreadable file is skipped (best-effort stance above: the
 * deploy will tell the truth anyway) — EXCEPT for an entry (depth 0) itself,
 * which is surfaced via `unreadableEntries` (A10) so a read failure can never
 * look identical to "genuinely has no dependencies".
 */
export async function resolveLocalDependencies(
  entry: MetadataItem[],
  items: MetadataItem[],
  readFile: (p: string) => Promise<string | undefined>,
  opts: { maxDepth?: number; maxDeps?: number; maxBundleFiles?: number } = {}
): Promise<LocalDependencyResult> {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxDeps = opts.maxDeps ?? DEFAULT_MAX_DEPS;
  const maxBundleFiles = opts.maxBundleFiles ?? DEFAULT_MAX_BUNDLE_FILES;

  const idx = buildIndex(items);
  const apexByName = idx.get('ApexClass')!;
  const objectByName = idx.get('CustomObject')!;
  const fieldByName = idx.get('CustomField')!;
  const pageByName = idx.get('ApexPage')!;

  const seen = new Set<string>(entry.map(e => `${e.type}:${e.name}`));
  const refs: LocalDependencyRef[] = [];
  let truncated = false;
  let dropped = 0;
  const unreadableEntries: string[] = [];

  // BFS queue of readable items. Depth is monotonically non-decreasing, so
  // once the cap fires everything behind it is at the boundary too.
  const queue: Array<{ item: MetadataItem; depth: number }> = entry
    .filter(e => canScanDependencies(e.type))
    .map(item => ({ item, depth: 0 }));

  outer:
  while (queue.length) {
    const { item: current, depth } = queue.shift()!;
    const currentKey = `${current.type}:${current.name}`;

    // Per-file match order: identifiers in appearance order, then dotted pairs
    // (fields, then Page.X) in appearance order, then string-literal refs
    // (bundles: per file, in read order) — combined with FIFO expansion this
    // fixes the output order completely (deterministic across runs).
    const found: MetadataItem[] = [];
    const bareObjectKeys = new Set<string>();
    if (BUNDLE_READ_EXTS.has(current.type)) {
      const bundle = await collectBundleRefs(current, idx, readFile, maxBundleFiles);
      for (const hit of bundle.found) found.push(hit);
      if (bundle.trimmed) { truncated = true; dropped += bundle.skippedFiles; }
      if (depth === 0 && bundle.unreadable) unreadableEntries.push(currentKey);
    } else if (current.type === 'ApexPage' || current.type === 'ApexComponent') {
      const source = await readFile(current.filePath);
      if (source === undefined) { if (depth === 0) unreadableEntries.push(currentKey); continue; }
      for (const ref of extractVisualforceRefs(source)) {
        const hit = lookupRef(ref, idx);
        if (hit) found.push(hit);
      }
    } else {
      const source = await readFile(current.filePath);
      if (source === undefined) { if (depth === 0) unreadableEntries.push(currentKey); continue; }
      const { identifiers, dottedPairs } = extractTokens(source);

      // Dotted pairs are scanned FIRST (but appended AFTER identifiers below, to
      // keep the existing identifiers-then-pairs output order) so the object/
      // field co-occurrence rule (A3) can see every field match on THIS file
      // before identifiers decide whether a bare object token is redundant.
      const dottedFinds: MetadataItem[] = [];
      const fieldObjectNames = new Set<string>();
      for (const pair of dottedPairs) {
        if (isPlatformName(pair)) continue;
        // CustomField `Obj.Field` — exact case only (A4): a dotted pair cropped
        // from raw source is still a guess, same false-positive risk as a bare
        // identifier.
        const fld = fieldByName.get(pair.toLowerCase());
        if (fld && fld.name === pair) {
          dottedFinds.push(fld);
          const dot = fld.name.indexOf('.');
          if (dot > 0) fieldObjectNames.add(fld.name.slice(0, dot).toLowerCase());
          continue; // a pair that named a field can't also be a Page.X pair
        }
        // `Page.X` (A6) — "Page" is a fixed language keyword, not looked up, so
        // only the captured name needs the exact-case check.
        const pageMatch = /^Page\.(.+)$/i.exec(pair);
        if (pageMatch) {
          const pg = pageByName.get(pageMatch[1].toLowerCase());
          if (pg && pg.name === pageMatch[1]) dottedFinds.push(pg);
        }
      }

      for (const ident of identifiers) {
        if (ident.length < 3 || isPlatformName(ident)) continue;
        const lower = ident.toLowerCase();
        // ApexClass — exact-case match against the item's canonical name (A4):
        // a case-folded hit here is what let a local variable/parameter/method
        // name (`acmeOrder`, `notify`, `payload` …) masquerade as a reference to
        // an unrelated class of the same name folded. Real Apex references a
        // class by its declared spelling, so this costs no genuine reference.
        const cls = apexByName.get(lower);
        if (cls && cls.name === ident) found.push(cls);
        // The suffix gate keeps a bare word from pulling in a same-named object:
        // only `Foo__c`-shaped tokens can be sObject references.
        if (SOBJECT_SUFFIX.test(ident)) {
          const obj = objectByName.get(lower);
          if (obj && obj.name === ident) {
            // A3: a CustomField on this SAME object already matched from this
            // SAME file — deploying that field's CustomObject key would also
            // deploy the whole folder (every other field, every validation
            // rule…) on top of it, purely because the bare type name also
            // appeared. Drop the redundant whole-object match; the field alone
            // already carries the reference.
            if (!fieldObjectNames.has(lower)) {
              found.push(obj);
              bareObjectKeys.add(`${obj.type}:${obj.name}`);
            }
          }
        }
      }
      found.push(...dottedFinds);

      // Narrow string-literal shapes (A6): Type.forName('X'), SOQL 'FROM X__c'.
      // Declared, not cropped — case-folded resolution is safe here (see
      // extractApexStringRefs' own doc comment).
      for (const ref of extractApexStringRefs(source)) {
        const hit = lookupRef(ref, idx);
        if (hit) found.push(hit);
      }
    }

    for (let i = 0; i < found.length; i++) {
      const dep = found[i];
      const depKey = `${dep.type}:${dep.name}`;
      if (seen.has(depKey)) continue;
      if (depth >= maxDepth || refs.length >= maxDeps) {
        // Probe layer / count cap: this unseen find is exactly what the cap
        // cut. `dropped` bounds the rest of the damage without walking any
        // further — the still-unseen finds sitting at this exact cutoff
        // (deduped among themselves) plus every item still waiting in the
        // queue, each of which is now abandoned mid-BFS too.
        truncated = true;
        const remainingUnseen = new Set<string>();
        for (let j = i; j < found.length; j++) {
          const k = `${found[j].type}:${found[j].name}`;
          if (!seen.has(k)) remainingUnseen.add(k);
        }
        dropped += remainingUnseen.size + queue.length;
        break outer;
      }
      seen.add(depKey);
      // `current` is the component whose source was just read, so it IS the
      // referrer — recorded here, at the only point where both sides are known.
      refs.push({
        key: depKey, from: currentKey, depth: depth + 1,
        // Sparse like every other optional field here — omitted (not `false`)
        // when it doesn't apply, so every EXISTING attribution shape (no
        // bare-object matches in play) round-trips through deepStrictEqual
        // unchanged.
        ...(bareObjectKeys.has(depKey) ? { bareObject: true as const } : {})
      });
      // Anything else this module can itself read may reference further
      // components (a class, a bundle, a VF page/component); a field, object,
      // channel or resource is a leaf.
      if (canScanDependencies(dep.type)) queue.push({ item: dep, depth: depth + 1 });
    }
  }
  return { keys: refs.map(r => r.key), refs, truncated, dropped, unreadableEntries };
}
