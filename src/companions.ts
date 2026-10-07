// Context companions: the components a Salesforce "context" type must be
// retrieved WITH to come back complete. The Metadata API fills a Profile,
// an org-wide Translations file or a CustomObjectTranslation only for the
// components named in the same request — `Profile:Admin` alone comes back
// with user permissions and nothing else, `Translations:pl` alone as an
// empty stub. Retrieve and Diff add these companions to the org round trip;
// they are never written to the user's project. For a Translations file or a
// Profile the USER picks what rides along, per companion type (pickRows: this
// project's members, or all on the org); an object translation's companions
// are fixed.
// No vscode here on purpose — this is the part the harness drives directly.
import type { MetadataItem } from './metadataScanner';

/** Types that come back incomplete unless their companions ride along.
 *  PermissionSet / PermissionSetGroup are complete on their own (API 40+), and
 *  GlobalValueSetTranslation was verified byte-identical alone and with its set. */
export const CONTEXT_TYPES: ReadonlySet<string> = new Set(['CustomObjectTranslation', 'Translations', 'Profile']);

export interface Companion { type: string; name: string }

/** How one companion type rides along: `org` — every one of that type on the
 *  org; `project` — the ones this project has. A type with neither is left out. */
export type RowKind = 'project' | 'org';

/** One row of the companion picker (Translations / Profile), and what ticking
 *  it sends. */
export interface PickRow {
  /** `<Type>:project` | `<Type>:org` — what workspaceState remembers per file. */
  id: string;
  type: string;
  kind: RowKind;
  label: string;
  description: string;
  /** Ticked when nothing is remembered for the file: every `this project's`
   *  row (what this project has), and the labels row when the project has a
   *  labels file. */
  byDefault: boolean;
  companions: Companion[];
}

export interface CompanionPlan {
  companions: Companion[];
  /** Card / modal / run-note lines explaining what rides along and why. */
  note: string[];
  /** `Type:Name` of each selected item sent with no companion at all (nothing
   *  ticked): it comes back nearly empty. Never to be promised "complete". */
  incomplete: string[];
  /** Each selected context item's own companions (`Type:Name` key → list), for
   *  the per-item lines describeContext() writes. */
  own: Record<string, Companion[]>;
  /** `Type:Name` of each selected item an org-wide row could fill only from the
   *  project, because the org list was not loaded (or named none of what it
   *  needed): complete for what the project knows, not for the org. */
  partial: string[];
  /** Per picker item (Translations / Profile): the companion types it is
   *  fetched with, in picker order, and how — the org row won where both were
   *  ticked. */
  chosen: Record<string, Array<{ type: string; kind: RowKind; companions: Companion[] }>>;
  /** Per picker item: the companion types nothing was ticked for. */
  leftOut: Record<string, string[]>;
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

/** The items that get a picker, and the companion types each one offers, in
 *  the picker's order. A CustomObjectTranslation is not here: its companions
 *  (its object, that object's layouts and quick actions) are fixed and small. */
export const PICK_TYPES: Readonly<Record<string, readonly string[]>> = {
  Translations: TRANSLATIONS_COMPANION_TYPES,
  Profile: PROFILE_TOP_TYPES
};

/** The companion types the picker offers for an item of `type`, or undefined:
 *  no picker for it. */
export function pickTypesFor(type: string): readonly string[] | undefined {
  return Object.prototype.hasOwnProperty.call(PICK_TYPES, type) ? PICK_TYPES[type] : undefined;
}

/** Of the object children, only fields (fieldPermissions) and record types
 *  (recordTypeVisibilities) appear in a profile. The org row asks for these two
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

type Item = Pick<MetadataItem, 'type' | 'name'>;

const TYPE_LABELS: Readonly<Record<string, string>> = {
  CustomLabels: 'Labels', CustomApplication: 'Apps', CustomTab: 'Tabs', Flow: 'Flows', QuickAction: 'Quick actions',
  ReportType: 'Report types', CustomObject: 'Objects', ApexClass: 'Apex classes', ApexPage: 'Visualforce pages',
  Layout: 'Layouts', CustomPermission: 'Custom permissions', ExternalDataSource: 'External data sources'
};

/** The picker's heading for a companion type (`Tabs`, `Apex classes`). */
export function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

/** `Acme_A, Acme_B, Acme_C +8 more`. */
function nameList(names: readonly string[]): string {
  return names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3} more` : '');
}

/** The standard objects of a list: object files, and the objects of scanned
 *  children (`CustomField:Account.Tier__c` → Account). */
function standardObjectsOf(items: readonly Item[]): string[] {
  const out: string[] = [];
  for (const i of items) {
    const name = i.type === 'CustomObject' ? i.name : PROFILE_OBJECT_CHILD_TYPES.includes(i.type) ? i.name.split('.')[0] : undefined;
    if (name && isStandardObject(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * The picker rows for one selected Translations / Profile item, grouped by
 * companion type in PICK_TYPES order — two per type:
 *   `<Type>: this project's (N)` — the project's members of that type (names in
 *     the description); absent when the project has none. For a profile's
 *     objects: each object file AND each scanned child (field-granular — a
 *     profile comes back with entries for exactly those).
 *   `<Type>: all on the org` — `*`. For a profile's objects: `CustomObject:*`,
 *     `CustomField:*`, `RecordType:*`, plus the standard objects by name (the
 *     wildcard misses them) from the org list and the project.
 * Labels get ONE row: the project's labels file and every label on the org are
 * the same request (`CustomLabels:CustomLabels` is the org's whole label set).
 */
export function pickRows(item: Item, ctx: { localItems: readonly Item[]; orgItems?: readonly Item[]; orgLabel?: string }): PickRow[] {
  const types = pickTypesFor(item.type);
  if (!types) return [];
  const org = ctx.orgLabel ?? 'the org';
  const local = ctx.localItems;
  const rows: PickRow[] = [];
  for (const type of types) {
    const label = typeLabel(type);
    if (type === 'CustomLabels') {
      rows.push({
        id: 'CustomLabels:org', type, kind: 'org', label,
        description: `the labels file — every custom label on ${org}`,
        byDefault: local.some(i => i.type === 'CustomLabels'),
        companions: [{ type, name: 'CustomLabels' }]
      });
      continue;
    }
    if (type === 'CustomObject') {
      const objects = local.filter(i => i.type === 'CustomObject');
      const children = local.filter(i => PROFILE_OBJECT_CHILD_TYPES.includes(i.type));
      const names: string[] = [];
      for (const i of [...objects, ...children]) {
        const n = i.type === 'CustomObject' ? i.name : i.name.split('.')[0];
        if (n && !names.includes(n)) names.push(n);
      }
      if (names.length > 0) {
        rows.push({
          id: `${type}:project`, type, kind: 'project', label: `${label}: this project's (${names.length})`,
          description: nameList(names) + (children.length ? ` · with ${countPhrase(children)}` : ''),
          byDefault: true,
          companions: [...objects, ...children].map(i => ({ type: i.type, name: i.name }))
        });
      }
      const fromOrg = standardObjectsOf((ctx.orgItems ?? []).filter(i => i.type === 'CustomObject'));
      const fromProject = standardObjectsOf(local).filter(n => !fromOrg.includes(n));
      const standard = [...fromOrg, ...fromProject];
      rows.push({
        id: `${type}:org`, type, kind: 'org', label: `${label}: all on the org`,
        description: `every custom object, field and record type on ${org}` + (fromOrg.length
          ? ` + ${fromOrg.length} standard object${fromOrg.length === 1 ? '' : 's'} from the Fetch Org list`
          : ` + this project's standard objects (Fetch Org to name the org's)`),
        byDefault: false,
        companions: [
          { type, name: WILDCARD }, ...PROFILE_ORG_CHILD_WILDCARDS.map(t => ({ type: t, name: WILDCARD })),
          ...standard.map(name => ({ type, name }))
        ]
      });
      continue;
    }
    const mine = local.filter(i => i.type === type);
    if (mine.length > 0) {
      rows.push({
        id: `${type}:project`, type, kind: 'project', label: `${label}: this project's (${mine.length})`,
        description: nameList(mine.map(i => i.name)), byDefault: true,
        companions: mine.map(i => ({ type: i.type, name: i.name }))
      });
    }
    rows.push({
      id: `${type}:org`, type, kind: 'org', label: `${label}: all on the org`,
      description: `every ${noun(type, 1)} on ${org}`, byDefault: false,
      companions: [{ type, name: WILDCARD }]
    });
  }
  return rows;
}

/** The rows ticked when nothing is remembered for the file. */
export function defaultPicks(rows: readonly PickRow[]): string[] {
  return rows.filter(r => r.byDefault).map(r => r.id);
}

/**
 * The companions `selected` needs, as the picker's rows say.
 *
 *   CustomObjectTranslation:<Obj>-<lang> → no picker: always CustomObject:<Obj>
 *     plus the object's layouts (`<Obj>-*`) and quick actions (`<Obj>.*`) from
 *     the org list — the project's when the org list is not loaded, and the
 *     note says so.
 *   Translations:<lang>, Profile:<name> → per companion type, the ticked row
 *     (`picks[Type:Name]`, row ids; absent = defaultPicks): the org row wins
 *     over the project row of the same type; a type with nothing ticked is left
 *     out (`leftOut`, and describeContext says so).
 *
 * Never a component already in `selected`, never one twice, and never a
 * `Type:Name` when the same type is already asked for as `*` (except a standard
 * CustomObject, which the wildcard does not cover).
 */
export function companionsFor(
  selected: readonly Item[],
  ctx: {
    /** Row ids per picker item (`Type:Name`), as the picker returned them. */
    picks?: Readonly<Record<string, readonly string[]>>;
    /** The project's scanned items. */
    localItems: readonly Item[];
    /** The org listing for the target org, when one is loaded. */
    orgItems?: readonly Item[];
  }
): CompanionPlan {
  const context = selected.filter(i => CONTEXT_TYPES.has(i.type));
  if (context.length === 0) return { companions: [], note: [], incomplete: [], partial: [], own: {}, chosen: {}, leftOut: {} };
  const local = ctx.localItems;

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
  const chosen: CompanionPlan['chosen'] = {};
  const leftOut: CompanionPlan['leftOut'] = {};
  const fallbackObjects: string[] = [];
  const noLayoutObjects: string[] = [];
  const fallbackProfiles: string[] = [];

  for (const item of context) {
    current = `${item.type}:${item.name}`;
    if (item.type === 'CustomObjectTranslation') {
      const obj = translatedObject(item.name);
      if (!obj) continue;
      add('CustomObject', obj);
      const isLayout = (i: Item): boolean => i.type === 'Layout' && i.name.startsWith(`${obj}-`);
      const isAction = (i: Item): boolean => i.type === 'QuickAction' && i.name.startsWith(`${obj}.`);
      // The org list, per type — a list with no entries of a type (none on the
      // org, or the type never listed) can't name any; the project's then. No
      // list at all: the project's, said so.
      const org = ctx.orgItems;
      if (!org) {
        fallbackObjects.push(item.name);
        partial.push(current);
      }
      const from = (type: string): readonly Item[] => (org && org.some(i => i.type === type) ? org : local);
      // Every object has a layout, so a loaded list with NO Layout at all never
      // listed the type (its fetch failed): not complete. Zero quick actions is
      // an ordinary org, and says nothing.
      if (org && !org.some(i => i.type === 'Layout')) {
        noLayoutObjects.push(item.name);
        partial.push(current);
      }
      for (const i of from('Layout')) if (isLayout(i)) add(i.type, i.name);
      for (const i of from('QuickAction')) if (isAction(i)) add(i.type, i.name);
      continue;
    }
    const types = pickTypesFor(item.type);
    if (!types) continue;
    const rows = pickRows(item, ctx);
    const ticked = new Set(ctx.picks?.[current] ?? defaultPicks(rows));
    const mine: CompanionPlan['chosen'][string] = [];
    const out: string[] = [];
    for (const type of types) {
      const ofType = rows.filter(r => r.type === type && ticked.has(r.id));
      // Both rows of a type ticked: the org row wins (it covers the project's).
      const row = ofType.find(r => r.kind === 'org') ?? ofType.find(r => r.kind === 'project');
      if (!row) { out.push(type); continue; }
      mine.push({ type, kind: row.kind, companions: row.companions });
      for (const c of row.companions) add(c.type, c.name);
      // The wildcard misses standard objects, so the org row names them — from
      // the org list, or (no list, or one naming none) from the project alone.
      if (type === 'CustomObject' && row.kind === 'org' && !(ctx.orgItems ?? []).some(i => i.type === 'CustomObject' && isStandardObject(i.name))) {
        fallbackProfiles.push(current);
        partial.push(current);
      }
    }
    chosen[current] = mine;
    leftOut[current] = out;
    if (mine.length === 0) incomplete.push(current);
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

  if (companions.length > 0) note.unshift(`companions: ${summarize(companions)}`);
  if (fallbackObjects.length > 0) {
    note.push(`org list not loaded — layouts and quick actions for ${fallbackObjects.join(', ')} were taken from the project; Fetch Org for the org's full set`);
  }
  if (noLayoutObjects.length > 0) {
    note.push(`no Layout entries in the org list — layouts for ${noLayoutObjects.join(', ')} were taken from the project; Fetch Org again for the org's full set`);
  }
  if (fallbackProfiles.length > 0) {
    note.push(`${ctx.orgItems ? 'no standard objects in the org list' : 'org list not loaded'} — standard objects for ${fallbackProfiles.join(', ')} were taken from the project; Fetch Org to include the org's standard objects`);
  }
  return { companions, note, incomplete, partial, own, chosen, leftOut };
}

const NOUNS: Readonly<Record<string, readonly [string, string]>> = {
  CustomLabels: ['label', 'labels'],
  CustomApplication: ['app', 'apps'], CustomTab: ['tab', 'tabs'], Flow: ['flow', 'flows'],
  QuickAction: ['quick action', 'quick actions'], ReportType: ['report type', 'report types'],
  CustomObject: ['object', 'objects'], CustomField: ['field', 'fields'], RecordType: ['record type', 'record types'],
  ApexClass: ['class', 'classes'], ApexPage: ['page', 'pages'], Layout: ['layout', 'layouts'],
  CustomPermission: ['custom permission', 'custom permissions'], ExternalDataSource: ['data source', 'data sources'],
  ListView: ['list view', 'list views'], WebLink: ['button or link', 'buttons and links'], ValidationRule: ['validation rule', 'validation rules'],
  CompactLayout: ['compact layout', 'compact layouts'], BusinessProcess: ['business process', 'business processes'],
  FieldSet: ['field set', 'field sets'], Index: ['index', 'indexes'], SharingReason: ['sharing reason', 'sharing reasons']
};

function noun(type: string, n: number): string {
  const pair = NOUNS[type];
  return pair ? pair[n === 1 ? 0 : 1] : type;
}

/** `a`, `a and b`, `a, b and c`. */
function joinAnd(parts: readonly string[]): string {
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** `the labels, 11 tabs, 33 apps` — what one item's companions are, by type. */
export function countPhrase(companions: readonly Companion[]): string {
  const byType = new Map<string, number>();
  for (const c of companions) byType.set(c.type, (byType.get(c.type) ?? 0) + 1);
  return [...byType].map(([type, n]) => (type === 'CustomLabels' ? 'the labels' : `${n} ${noun(type, n)}`)).join(', ');
}

/**
 * One line per selected context item saying what it is fetched with — the
 * dialog's, the run's and a diff card's promise, so it has to be exact:
 *   - a picker item: the labels, this project's members (`11 tabs (project)`),
 *     the types fetched whole (`all flows on the org`), and what was left out
 *     (`— apps, quick actions and report types left out`). "complete" ONLY when
 *     every type is an org row (and the org list named the standard objects);
 *     nothing ticked at all: it comes back nearly empty, and says so.
 *   - an object translation: its object and the org's layouts and quick
 *     actions — complete; without the org list, only for what the project knows.
 */
export function describeContext(selected: readonly Item[], plan: CompanionPlan): string[] {
  const lines: string[] = [];
  for (const item of selected.filter(i => CONTEXT_TYPES.has(i.type))) {
    const key = `${item.type}:${item.name}`;
    if (item.type === 'CustomObjectTranslation') {
      const extra = (plan.own[key] ?? []).filter(c => c.type !== 'CustomObject');
      lines.push(plan.partial.includes(key)
        ? `${key}: fetched with its object${extra.length ? ` and ${countPhrase(extra)}` : ''} — complete only for what the project knows`
        : `${key}: fetched with its object${extra.length ? ` and the org's ${countPhrase(extra)}` : ''} so it comes back complete`);
      continue;
    }
    if (!pickTypesFor(item.type)) continue;
    const chosen = plan.chosen[key] ?? [];
    const leftOut = plan.leftOut[key] ?? [];
    if (chosen.length === 0) {
      lines.push(`${key}: fetched alone — nothing ticked to fetch it with, so it comes back nearly empty`);
      continue;
    }
    const parts: string[] = [];
    if (chosen.some(c => c.type === 'CustomLabels')) parts.push('the labels');
    const project = chosen.filter(c => c.kind === 'project');
    if (project.length) parts.push(`${countPhrase(project.flatMap(c => c.companions))} (project)`);
    const org = chosen.filter(c => c.kind === 'org' && c.type !== 'CustomLabels');
    if (org.length) parts.push(`all ${joinAnd(org.map(c => noun(c.type, 2)))} on the org`);
    let line = `${key}: fetched with ${parts.join(', ')}`;
    if (leftOut.length) line += ` — ${joinAnd(leftOut.map(t => noun(t, 2)))} left out`;
    else if (project.length === 0) line += plan.partial.includes(key) ? ' — complete only for what the project knows' : ' so it comes back complete';
    lines.push(line);
  }
  return lines;
}

/** True when a picker item is fetched with less than everything on the org — a
 *  project row, or a type left out: the org's file then lacks the entries for
 *  what was not fetched, and a diff shows the local ones as local-only. */
export function fetchedPartly(plan: CompanionPlan): boolean {
  return Object.keys(plan.chosen).some(k => (plan.leftOut[k] ?? []).length > 0 || plan.chosen[k].some(c => c.kind === 'project'));
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
