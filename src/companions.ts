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

/** `project`: only what the project itself has (fast, field-granular).
 *  `org`: every component of the companion types on the org (complete, slow). */
export type Scope = 'project' | 'org';
export const CONTEXT_SCOPE_DEFAULT: Scope = 'project';

export interface Companion { type: string; name: string }
export interface CompanionPlan {
  companions: Companion[];
  /** Card / modal / run-note lines explaining what rides along and why. */
  note: string[];
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
  if (context.length === 0) return { companions: [], note: [] };
  const scope: Scope = ctx.scope === 'org' ? 'org' : 'project';
  const local = ctx.localItems;
  const localOf = (type: string): Array<Pick<MetadataItem, 'type' | 'name'>> => local.filter(i => i.type === type);

  const wanted: Companion[] = [];
  const add = (type: string, name: string): void => { wanted.push({ type, name }); };
  const note: string[] = [];
  const fallbackObjects: string[] = [];
  let profileOrgNote = false;

  for (const item of context) {
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
      if (scope === 'org' && !org) fallbackObjects.push(item.name);
      const from = (type: string): ReadonlyArray<Pick<MetadataItem, 'type' | 'name'>> =>
        org && org.some(i => i.type === type) ? org : local;
      for (const i of from('Layout')) if (isLayout(i)) add(i.type, i.name);
      for (const i of from('QuickAction')) if (isAction(i)) add(i.type, i.name);
    } else if (item.type === 'Translations') {
      if (scope === 'org') {
        for (const t of TRANSLATIONS_COMPANION_TYPES) add(t, WILDCARD);
      } else {
        const found = TRANSLATIONS_COMPANION_TYPES.flatMap(t => localOf(t));
        for (const i of found) add(i.type, i.name);
        if (found.length === 0) note.push(emptyScopeNote(`${item.type}:${item.name}`, TRANSLATIONS_COMPANION_TYPES));
      }
    } else if (item.type === 'Profile') {
      if (scope === 'org') {
        for (const t of PROFILE_TOP_TYPES) add(t, WILDCARD);
        for (const t of PROFILE_ORG_CHILD_WILDCARDS) add(t, WILDCARD);
        // The wildcard misses standard objects: name the ones the project knows,
        // as an object file or as the parent of a scanned child.
        for (const i of local) {
          if (i.type === 'CustomObject' && isStandardObject(i.name)) add('CustomObject', i.name);
          else if (PROFILE_OBJECT_CHILD_TYPES.includes(i.type)) {
            const parent = i.name.split('.')[0];
            if (parent && isStandardObject(parent)) add('CustomObject', parent);
          }
        }
        profileOrgNote = true;
      } else {
        const found = [...PROFILE_TOP_TYPES, ...PROFILE_OBJECT_CHILD_TYPES].flatMap(t => localOf(t));
        for (const i of found) add(i.type, i.name);
        if (found.length === 0) note.push(emptyScopeNote(`${item.type}:${item.name}`, PROFILE_TOP_TYPES));
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
  if (profileOrgNote) {
    note.push('scope "org" asks for every component of the profile\'s types on the org — slow on big orgs; a CustomObject wildcard covers custom objects only, so standard objects are named from the project');
  }
  return { companions, note };
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
  const selectedTypes = new Set(selected.map(i => i.type));
  return companions.some(c => !selectedTypes.has(c.type) && new RegExp(`\\b${c.type}\\b`).test(problem));
}
