// Context companions: the components a Salesforce "context" type must be
// retrieved WITH to come back complete. The Metadata API fills a Profile,
// an org-wide Translations file or a CustomObjectTranslation only for the
// components named in the same request — `Profile:Admin` alone comes back
// with user permissions and nothing else, `Translations:pl` alone as an
// empty stub. Retrieve and Diff add these companions to the org round trip;
// they are never written to the user's project.
// No vscode here on purpose — this is the part the harness drives directly.
import type { MetadataItem } from './metadataScanner';

/** Types that come back incomplete unless their companions ride along.
 *  PermissionSet / PermissionSetGroup are complete on their own (API 40+), and
 *  GlobalValueSetTranslation was verified byte-identical alone and with its set. */
export const CONTEXT_TYPES: ReadonlySet<string> = new Set(['CustomObjectTranslation', 'Translations', 'Profile']);

/** `org` (default): every component of the companion types on the org — the
 *  file comes back complete, at the cost of a bigger retrieve (disclosed).
 *  `project`: only what the project itself has (fast, field-granular) — the
 *  file is then completed for those components only, and says so. */
export type Scope = 'project' | 'org';
export const CONTEXT_SCOPE_DEFAULT: Scope = 'org';

export interface Companion { type: string; name: string }
export interface CompanionPlan {
  companions: Companion[];
  /** Card / modal / run-note lines explaining what rides along and why. */
  note: string[];
  /** `Type:Name` of each selected item that will come back nearly empty: project
   *  scope found nothing it describes. Never to be promised "complete". */
  incomplete: string[];
  /** Each selected context item's own companions (`Type:Name` key → list), for
   *  the per-item lines describeContext() writes. */
  own: Record<string, Companion[]>;
  /** `Type:Name` of each selected item scope org could fill only from the
   *  project, because the org list was not loaded (or named none of what it
   *  needed): complete for what the project knows, not for the org. */
  partial: string[];
}

/** What an org-wide Translations file translates. */
export const TRANSLATIONS_COMPANION_TYPES: readonly string[] = ['CustomLabels', 'CustomApplication', 'CustomTab', 'Flow', 'QuickAction', 'ReportType'];

/** Decomposed CustomObject children (metadataScanner's OBJECT_CHILD_RULES —
 *  check-companions.cjs pins the two lists equal). */
export const PROFILE_OBJECT_CHILD_TYPES: readonly string[] = [
  'CustomField', 'BusinessProcess', 'CompactLayout', 'FieldSet', 'Index',
  'ListView', 'RecordType', 'SharingReason', 'ValidationRule', 'WebLink'
];

/** The top-level types a Profile grants access to. Not CustomMetadata: a
 *  profile's customMetadataTypeAccesses come with the `__mdt` CustomObject, and
 *  `CustomMetadata:*` would pull every custom metadata RECORD for nothing. */
export const PROFILE_TOP_TYPES: readonly string[] = [
  'CustomObject', 'ApexClass', 'ApexPage', 'CustomApplication', 'CustomTab', 'Layout',
  'CustomPermission', 'Flow', 'ExternalDataSource'
];

/** Of the object children, only fields (fieldPermissions) and record types
 *  (recordTypeVisibilities) appear in a profile. Scope `org` asks for these two
 *  as `*`; every list view, web link and validation rule on the org would add
 *  nothing to the profile and only slow the retrieve. */
const PROFILE_ORG_CHILD_WILDCARDS: readonly string[] = ['CustomField', 'RecordType'];

const WILDCARD = '*';

/** `Account`, `Product2` — not `Acme__c`, `ns__Rate__mdt`. A CustomObject `*`
 *  covers CUSTOM objects only (verified live: `CustomObject:*` + Profile gave no
 *  Product2 field permissions, `*` + `Product2` gave 23), so a standard object
 *  is named next to the wildcard, never suppressed by it. */
function isStandardObject(name: string): boolean {
  return !name.includes('__');
}

/** The object of a CustomObjectTranslation `<Object>-<lang>` (object API names
 *  carry no hyphen, language codes neither). */
export function translatedObject(name: string): string | undefined {
  const dash = name.indexOf('-');
  return dash > 0 ? name.slice(0, dash) : undefined;
}

/**
 * The companions `selected` needs for a complete retrieve.
 *
 *   CustomObjectTranslation:<Obj>-<lang> → always CustomObject:<Obj>; plus the
 *     object's layouts (`<Obj>-*`) and quick actions (`<Obj>.*`) — from the
 *     project (scope project) or from the org list (scope org; the project when
 *     the org list is not loaded, and the note says so).
 *   Translations:<lang> → CustomLabels, CustomApplication, CustomTab, Flow,
 *     QuickAction, ReportType — the project's members, or `*` each.
 *   Profile:<name> → CustomObject + its children, ApexClass, ApexPage,
 *     CustomApplication, CustomTab, Layout, CustomPermission, Flow,
 *     ExternalDataSource — the project's members (field-granular:
 *     `CustomObject:X` for an object file AND each scanned child, which is what
 *     makes the profile's entries for exactly those come back), or `*` each.
 *
 * Never a component already in `selected`, never one twice, and never a
 * `Type:Name` when the same type is already asked for as `*` (except a standard
 * CustomObject, which the wildcard does not cover).
 */
export function companionsFor(
  selected: ReadonlyArray<Pick<MetadataItem, 'type' | 'name'>>,
  ctx: {
    scope: Scope;
    /** The project's scanned items. */
    localItems: ReadonlyArray<Pick<MetadataItem, 'type' | 'name'>>;
    /** The org listing for the target org, when one is loaded. */
    orgItems?: ReadonlyArray<Pick<MetadataItem, 'type' | 'name'>>;
  }
): CompanionPlan {
  const context = selected.filter(i => CONTEXT_TYPES.has(i.type));
  if (context.length === 0) return { companions: [], note: [], incomplete: [], partial: [], own: {} };
  const scope: Scope = ctx.scope === 'org' ? 'org' : 'project';
  const local = ctx.localItems;
  const localOf = (type: string): Array<Pick<MetadataItem, 'type' | 'name'>> => local.filter(i => i.type === type);

  const wanted: Companion[] = [];
  const own: Record<string, Companion[]> = {};
  let current = '';
  const add = (type: string, name: string): void => {
    wanted.push({ type, name });
    const mine = (own[current] ??= []);
    if (!mine.some(c => c.type === type && c.name === name)) mine.push({ type, name });
  };
  const note: string[] = [];
  const incomplete: string[] = [];
  const partial: string[] = [];
  const fallbackObjects: string[] = [];
  const noLayoutObjects: string[] = [];
  const fallbackProfiles: string[] = [];

  for (const item of context) {
    current = `${item.type}:${item.name}`;
    if (item.type === 'CustomObjectTranslation') {
      const obj = translatedObject(item.name);
      if (!obj) continue;
      add('CustomObject', obj);
      const isLayout = (i: Pick<MetadataItem, 'type' | 'name'>): boolean => i.type === 'Layout' && i.name.startsWith(`${obj}-`);
      const isAction = (i: Pick<MetadataItem, 'type' | 'name'>): boolean => i.type === 'QuickAction' && i.name.startsWith(`${obj}.`);
      // Scope org reads the org list — per type, since a list that has no
      // entries of a type (none on the org, or the type never listed) can't
      // name any; the project's then. No list at all: the project's, said so.
      const org = scope === 'org' ? ctx.orgItems : undefined;
      if (scope === 'org' && !org) {
        fallbackObjects.push(item.name);
        partial.push(`${item.type}:${item.name}`);
      }
      const from = (type: string): ReadonlyArray<Pick<MetadataItem, 'type' | 'name'>> =>
        org && org.some(i => i.type === type) ? org : local;
      // Every object has a layout, so a loaded list with NO Layout at all never
      // listed the type (its fetch failed): not complete. Zero quick actions is
      // an ordinary org, and says nothing.
      if (org && !org.some(i => i.type === 'Layout')) {
        noLayoutObjects.push(item.name);
        partial.push(`${item.type}:${item.name}`);
      }
      for (const i of from('Layout')) if (isLayout(i)) add(i.type, i.name);
      for (const i of from('QuickAction')) if (isAction(i)) add(i.type, i.name);
    } else if (item.type === 'Translations') {
      if (scope === 'org') {
        for (const t of TRANSLATIONS_COMPANION_TYPES) add(t, WILDCARD);
      } else {
        const found = TRANSLATIONS_COMPANION_TYPES.flatMap(t => localOf(t));
        for (const i of found) add(i.type, i.name);
        if (found.length === 0) {
          note.push(emptyScopeNote(`${item.type}:${item.name}`, TRANSLATIONS_COMPANION_TYPES));
          incomplete.push(`${item.type}:${item.name}`);
        }
      }
    } else if (item.type === 'Profile') {
      if (scope === 'org') {
        for (const t of PROFILE_TOP_TYPES) add(t, WILDCARD);
        for (const t of PROFILE_ORG_CHILD_WILDCARDS) add(t, WILDCARD);
        // The wildcard misses standard objects: name the org list's (Account,
        // Product2 — their objectPermissions and standard-field permissions come
        // with nothing else), plus the ones the project knows, as an object file
        // or as the parent of a scanned child. No org list, or one that names no
        // standard object: the project's alone, and the note says so.
        const orgObjects = (ctx.orgItems ?? []).filter(i => i.type === 'CustomObject');
        if (!orgObjects.some(i => isStandardObject(i.name))) {
          fallbackProfiles.push(`${item.type}:${item.name}`);
          partial.push(`${item.type}:${item.name}`);
        }
        for (const i of orgObjects) if (isStandardObject(i.name)) add('CustomObject', i.name);
        for (const i of local) {
          if (i.type === 'CustomObject' && isStandardObject(i.name)) add('CustomObject', i.name);
          else if (PROFILE_OBJECT_CHILD_TYPES.includes(i.type)) {
            const parent = i.name.split('.')[0];
            if (parent && isStandardObject(parent)) add('CustomObject', parent);
          }
        }
      } else {
        const found = [...PROFILE_TOP_TYPES, ...PROFILE_OBJECT_CHILD_TYPES].flatMap(t => localOf(t));
        for (const i of found) add(i.type, i.name);
        if (found.length === 0) {
          note.push(emptyScopeNote(`${item.type}:${item.name}`, PROFILE_TOP_TYPES));
          incomplete.push(`${item.type}:${item.name}`);
        }
      }
    }
  }

  // Dedupe: against the selection, against itself, and a `*` for a type
  // suppresses that type's named members (bar standard objects, see above).
  const selectedKeys = new Set(selected.map(i => `${i.type}:${i.name}`));
  const wildTypes = new Set(wanted.filter(c => c.name === WILDCARD).map(c => c.type));
  const seen = new Set<string>();
  const companions: Companion[] = [];
  for (const c of wanted) {
    const key = `${c.type}:${c.name}`;
    if (selectedKeys.has(key) || seen.has(key)) continue;
    if (c.name !== WILDCARD && wildTypes.has(c.type) && !(c.type === 'CustomObject' && isStandardObject(c.name))) continue;
    seen.add(key);
    companions.push(c);
  }

  if (companions.length > 0) note.unshift(`companions: ${summarize(companions)} (scope: ${scope})`);
  if (fallbackObjects.length > 0) {
    note.push(`org list not loaded — layouts and quick actions for ${fallbackObjects.join(', ')} were taken from the project; Fetch Org for the org's full set`);
  }
  if (noLayoutObjects.length > 0) {
    note.push(`no Layout entries in the org list — layouts for ${noLayoutObjects.join(', ')} were taken from the project; Fetch Org again for the org's full set`);
  }
  if (fallbackProfiles.length > 0) {
    note.push(`${ctx.orgItems ? 'no standard objects in the org list' : 'org list not loaded'} — standard objects for ${fallbackProfiles.join(', ')} were taken from the project; Fetch Org to include the org's standard objects`);
  }
  return { companions, note, incomplete, partial, own };
}

const NOUNS: Readonly<Record<string, readonly [string, string]>> = {
  CustomApplication: ['app', 'apps'], CustomTab: ['tab', 'tabs'], Flow: ['flow', 'flows'],
  QuickAction: ['quick action', 'quick actions'], ReportType: ['report type', 'report types'],
  CustomObject: ['object', 'objects'], CustomField: ['field', 'fields'], RecordType: ['record type', 'record types'],
  ApexClass: ['class', 'classes'], ApexPage: ['page', 'pages'], Layout: ['layout', 'layouts'],
  CustomPermission: ['custom permission', 'custom permissions'], ExternalDataSource: ['data source', 'data sources'],
  ListView: ['list view', 'list views'], WebLink: ['button or link', 'buttons and links'], ValidationRule: ['validation rule', 'validation rules'],
  CompactLayout: ['compact layout', 'compact layouts'], BusinessProcess: ['business process', 'business processes'],
  FieldSet: ['field set', 'field sets'], Index: ['index', 'indexes'], SharingReason: ['sharing reason', 'sharing reasons']
};

/** `the labels, 11 tabs, 33 apps` — what one item's companions are, by type. */
export function countPhrase(companions: readonly Companion[]): string {
  const byType = new Map<string, number>();
  for (const c of companions) byType.set(c.type, (byType.get(c.type) ?? 0) + 1);
  return [...byType].map(([type, n]) => {
    if (type === 'CustomLabels') return 'the labels';
    const noun = NOUNS[type];
    return noun ? `${n} ${n === 1 ? noun[0] : noun[1]}` : `${n} ${type}`;
  }).join(', ');
}

const ORG_WHOLESALE: Readonly<Record<string, string>> = {
  Profile: 'every object, field, record type, class, page, app, tab, layout, custom permission, flow and external data source on the org',
  Translations: 'every label, app, tab, flow, quick action and report type on the org'
};
const TO_PROJECT = 'set sfOrgDeployWrapper.contextScope to "project" to limit it to this project';
const TO_ORG = 'scope: project; set sfOrgDeployWrapper.contextScope to "org" for everything';

/**
 * One line per selected context item saying what it comes back with — the
 * dialog's (and, in project scope, the run's) promise, so it has to be exact:
 *   - scope org, filled from the org: "complete", and what is fetched wholesale
 *     (minutes on a big org);
 *   - scope org, filled from the project only (no Fetch Org list): "complete only
 *     for what the project knows" — the plan's note says why;
 *   - scope project: never "complete" — completed for this project's components
 *     only, with what they are, and what is left out;
 *   - nothing to send (project scope found none): no line; the LOUD note speaks.
 */
export function describeContext(selected: ReadonlyArray<Pick<MetadataItem, 'type' | 'name'>>, plan: CompanionPlan, scope: Scope): string[] {
  const lines: string[] = [];
  for (const item of selected.filter(i => CONTEXT_TYPES.has(i.type))) {
    const key = `${item.type}:${item.name}`;
    if (plan.incomplete.includes(key)) continue;
    const mine = plan.own[key] ?? [];
    if (scope === 'org') {
      if (plan.partial.includes(key)) { lines.push(`${key}: complete only for what the project knows.`); continue; }
      if (item.type === 'CustomObjectTranslation') {
        const extra = mine.filter(c => c.type !== 'CustomObject');
        lines.push(`${key}: fetched with its object${extra.length ? ` and the org's ${countPhrase(extra)}` : ''} so it comes back complete.`);
      } else {
        lines.push(`${key}: fetched with ${ORG_WHOLESALE[item.type]} so it comes back complete — minutes on a big org; ${TO_PROJECT}.`);
      }
      continue;
    }
    if (item.type === 'CustomObjectTranslation') {
      const extra = mine.filter(c => c.type !== 'CustomObject');
      lines.push(`${key}: completed for its object and this project's layouts and quick actions only (${extra.length ? countPhrase(extra) : 'none in this project'}) — the org's other layout and quick-action translations are left out (${TO_ORG}).`);
    } else {
      const leftOut = item.type === 'Profile' ? 'permissions' : 'translations';
      lines.push(`${key}: completed for this project's components only (${countPhrase(mine)}) — the org's other ${leftOut} are left out (${TO_ORG}).`);
    }
  }
  return lines;
}

/** The loud one: project scope had nothing to send, so the org will answer with
 *  a stub that, retrieved, overwrites a complete local file. */
function emptyScopeNote(key: string, types: readonly string[]): string {
  return `project scope found no ${types.join('/')} in this project — ${key} will come back nearly empty; set sfOrgDeployWrapper.contextScope to "org"`;
}

/** `CustomObject:Product2, Layout ×3, CustomLabels (all)` — per type, in order. */
export function summarize(companions: readonly Companion[]): string {
  const byType = new Map<string, string[]>();
  for (const c of companions) {
    const names = byType.get(c.type);
    if (names) names.push(c.name); else byType.set(c.type, [c.name]);
  }
  return [...byType].map(([type, names]) => {
    const named = names.filter(n => n !== WILDCARD);
    const parts: string[] = [];
    if (names.includes(WILDCARD)) parts.push(`${type} (all)`);
    if (named.length === 1) parts.push(`${type}:${named[0]}`);
    else if (named.length > 1) parts.push(`${type} ×${named.length}`);
    return parts.join(', ');
  }).join(', ');
}

/** True when any companion is a `*` — those can only travel in a package.xml. */
export function hasWildcard(companions: readonly Companion[]): boolean {
  return companions.some(c => c.name === WILDCARD);
}

/** Where a context item lives in source format: its type folder, and the file
 *  suffix (Profile, Translations) or `dir` (a CustomObjectTranslation folder). */
export const CONTEXT_SHAPES: Readonly<Record<string, { folder: string; suffix?: string; dir?: true }>> = {
  Profile: { folder: 'profiles', suffix: '.profile-meta.xml' },
  Translations: { folder: 'translations', suffix: '.translation-meta.xml' },
  CustomObjectTranslation: { folder: 'objectTranslations', dir: true }
};

/** A retrieve message that concerns the companions only — one not on the org
 *  ("Entity of type 'CustomTab' named 'X' cannot be found"), or a type-level
 *  warning about a type only the companions carry ("You do not have the proper
 *  permissions to access Layout."). Counted as an error it would turn a
 *  profile's diff red because some local tab was never deployed. */
export function isCompanionMessage(
  problem: string,
  companions: readonly Companion[],
  selected: ReadonlyArray<Pick<MetadataItem, 'type' | 'name'>>
): boolean {
  if (companions.length === 0) return false;
  const selectedKeys = new Set(selected.map(i => `${i.type}:${i.name}`));
  const named = /type '([^']+)' named '([^']+)'/i.exec(problem);
  if (named) {
    const key = `${named[1]}:${named[2]}`;
    if (selectedKeys.has(key)) return false;
    return companions.some(c => c.type === named[1] && (c.name === named[2] || c.name === WILDCARD));
  }
  // A message that names a component without the "type X named Y" shape ("Not a
  // registered filter type: ConversationEntryCopy"): about a companion when it
  // names one and nothing the user picked.
  const mentions = (name: string): boolean =>
    new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`).test(problem);
  if (selected.some(i => mentions(i.name))) return false;
  if (companions.some(c => c.name !== WILDCARD && mentions(c.name))) return true;
  const selectedTypes = new Set(selected.map(i => i.type));
  return companions.some(c => !selectedTypes.has(c.type) && new RegExp(`\\b${c.type}\\b`).test(problem));
}
