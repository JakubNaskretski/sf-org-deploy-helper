import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';

export interface MetadataItem {
  /** Salesforce metadata type, e.g. ApexClass */
  type: string;
  /** Member name as used in package.xml / sf --metadata */
  name: string;
  /** Primary file (source) path, absolute */
  filePath: string;
  /** Optional sibling -meta.xml file path */
  metaPath?: string;
  /** All workspace files associated (used for bundle types like LWC/Aura) */
  files: string[];
}

export interface FolderRule {
  folder: string;
  type: string;
  /** true = each subfolder is one bundle; false = each file is one component */
  bundle?: boolean;
  /** primary file extension(s) for non-bundle types */
  primaryExt?: string[];
  /** suffix used to detect the sidecar -meta.xml */
  metaSuffix?: string;
  /** when true, primary files live one folder deeper (e.g. email/<Folder>/<Template>.email) and the
   *  fullName takes the form `Folder/Name`. */
  nested?: boolean;
}

const RULES: FolderRule[] = [
  { folder: 'classes', type: 'ApexClass', primaryExt: ['.cls'], metaSuffix: '.cls-meta.xml' },
  { folder: 'triggers', type: 'ApexTrigger', primaryExt: ['.trigger'], metaSuffix: '.trigger-meta.xml' },
  { folder: 'pages', type: 'ApexPage', primaryExt: ['.page'], metaSuffix: '.page-meta.xml' },
  { folder: 'components', type: 'ApexComponent', primaryExt: ['.component'], metaSuffix: '.component-meta.xml' },
  { folder: 'lwc', type: 'LightningComponentBundle', bundle: true },
  { folder: 'aura', type: 'AuraDefinitionBundle', bundle: true },
  { folder: 'flows', type: 'Flow', primaryExt: ['.flow-meta.xml'] },
  { folder: 'layouts', type: 'Layout', primaryExt: ['.layout-meta.xml'] },
  { folder: 'permissionsets', type: 'PermissionSet', primaryExt: ['.permissionset-meta.xml'] },
  { folder: 'profiles', type: 'Profile', primaryExt: ['.profile-meta.xml'] },
  { folder: 'staticresources', type: 'StaticResource', primaryExt: ['.resource'], metaSuffix: '.resource-meta.xml' },
  { folder: 'tabs', type: 'CustomTab', primaryExt: ['.tab-meta.xml'] },
  { folder: 'labels', type: 'CustomLabels', primaryExt: ['.labels-meta.xml'] },
  { folder: 'customMetadata', type: 'CustomMetadata', primaryExt: ['.md-meta.xml'] },
  { folder: 'queues', type: 'Queue', primaryExt: ['.queue-meta.xml'] },
  { folder: 'groups', type: 'Group', primaryExt: ['.group-meta.xml'] },
  { folder: 'globalValueSets', type: 'GlobalValueSet', primaryExt: ['.globalValueSet-meta.xml'] },
  { folder: 'workflows', type: 'Workflow', primaryExt: ['.workflow-meta.xml'] },
  // Single-file top-level types (Tier A). Each is one `*-meta.xml`; the org side
  // diffs cleanly against the MDAPI retrieve (same root element, no decomposition).
  { folder: 'flexipages', type: 'FlexiPage', primaryExt: ['.flexipage-meta.xml'] },
  { folder: 'applications', type: 'CustomApplication', primaryExt: ['.app-meta.xml'] },
  { folder: 'quickActions', type: 'QuickAction', primaryExt: ['.quickAction-meta.xml'] },
  { folder: 'customPermissions', type: 'CustomPermission', primaryExt: ['.customPermission-meta.xml'] },
  { folder: 'namedCredentials', type: 'NamedCredential', primaryExt: ['.namedCredential-meta.xml'] },
  { folder: 'externalDataSources', type: 'ExternalDataSource', primaryExt: ['.externalDataSource-meta.xml'] },
  { folder: 'remoteSiteSettings', type: 'RemoteSiteSetting', primaryExt: ['.remoteSiteSetting-meta.xml'] },
  { folder: 'roles', type: 'Role', primaryExt: ['.role-meta.xml'] },
  { folder: 'settings', type: 'Settings', primaryExt: ['.settings-meta.xml'] },
  { folder: 'messageChannels', type: 'LightningMessageChannel', primaryExt: ['.messageChannel-meta.xml'] },
  { folder: 'testSuites', type: 'ApexTestSuite', primaryExt: ['.testSuite-meta.xml'] },
  { folder: 'platformEventSubscriberConfigs', type: 'PlatformEventSubscriberConfig', primaryExt: ['.platformEventSubscriberConfig-meta.xml'] },
  { folder: 'email', type: 'EmailTemplate', primaryExt: ['.email'], metaSuffix: '.email-meta.xml', nested: true },
];

/** Decomposed children of a CustomObject in SFDX source format. Each is a single
 *  `*-meta.xml` file living under `objects/<Object>/<folder>/`, and each is its own
 *  addressable metadata type with the fullName `Object.Child`
 *  (e.g. `CustomField:Account.MyField__c`). These exist on standard objects too —
 *  even ones with no deployable `*.object-meta.xml` — so they're scanned
 *  independently of the CustomObject bundle. */
const OBJECT_CHILD_RULES: Array<{ folder: string; type: string; suffix: string }> = [
  { folder: 'fields', type: 'CustomField', suffix: '.field-meta.xml' },
  { folder: 'businessProcesses', type: 'BusinessProcess', suffix: '.businessProcess-meta.xml' },
  { folder: 'compactLayouts', type: 'CompactLayout', suffix: '.compactLayout-meta.xml' },
  { folder: 'fieldSets', type: 'FieldSet', suffix: '.fieldSet-meta.xml' },
  { folder: 'indexes', type: 'Index', suffix: '.index-meta.xml' },
  { folder: 'listViews', type: 'ListView', suffix: '.listView-meta.xml' },
  { folder: 'recordTypes', type: 'RecordType', suffix: '.recordType-meta.xml' },
  { folder: 'sharingReasons', type: 'SharingReason', suffix: '.sharingReason-meta.xml' },
  { folder: 'validationRules', type: 'ValidationRule', suffix: '.validationRule-meta.xml' },
  { folder: 'webLinks', type: 'WebLink', suffix: '.webLink-meta.xml' },
];

const OBJECT_CHILD_BY_FOLDER = new Map(OBJECT_CHILD_RULES.map(r => [r.folder, r]));

/** A FolderRule learned at runtime from the sf CLI's own metadata registry
 *  (via `sf project generate manifest`), cached with a timestamp so it can
 *  expire after `typeCacheDays`. Static RULES stay the zero-cost fast path;
 *  learned rules cover every type the CLI knows without a plugin release. */
export type LearnedRule = FolderRule & { learnedAt: number };

/** Metadata types that are decomposed children of a CustomObject (one `*-meta.xml`
 *  file each). The diff flow needs this to know the org side must be converted
 *  MDAPI→source before a meaningful file-to-file diff. */
export const OBJECT_CHILD_TYPES: ReadonlySet<string> = new Set(OBJECT_CHILD_RULES.map(r => r.type));

/** Resolve the package directories from sfdx-project.json or fall back to force-app. */
export async function resolvePackageDirs(root: string): Promise<string[]> {
  try {
    const cfg = await fs.readFile(path.join(root, 'sfdx-project.json'), 'utf8');
    const parsed = JSON.parse(cfg) as { packageDirectories?: Array<{ path?: string }> };
    const dirs = (parsed.packageDirectories ?? []).map(d => d?.path).filter((p): p is string => !!p);
    if (dirs.length) return dirs;
  } catch {
    // ignore
  }
  return ['force-app'];
}

export async function scanWorkspace(extraRules: FolderRule[] = []): Promise<{ items: MetadataItem[]; root?: string; warning?: string; unknownFolders: string[] }> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return { items: [], warning: 'No workspace folder open.', unknownFolders: [] };
  }
  const root = folders[0].uri.fsPath;
  const pkgDirs = await resolvePackageDirs(root);
  const items: MetadataItem[] = [];
  // Static rules first, learned rules after — a duplicate folder match produces
  // duplicate items, which the existing type:name dedupe below collapses.
  const rules = [...RULES, ...extraRules];
  // Top-level folders under the package default dir that no rule covers — the
  // caller can resolve their types via the sf CLI registry and rescan.
  const unknownFolders: string[] = [];
  const knownFolders = new Set([...rules.map(r => r.folder), 'objects']);
  for (const pkg of pkgDirs) {
    // Standard layout is <pkg>/main/default, but SFDX only requires <pkg>; metadata
    // can sit directly under the package dir. Fall back to <pkg> when main/default is
    // absent so non-standard layouts aren't scanned to nothing.
    const pkgRoot = path.join(root, pkg);
    const mainDefault = path.join(pkgRoot, 'main', 'default');
    const defaultDir = (await pathExists(mainDefault)) ? mainDefault : pkgRoot;
    if (!(await pathExists(defaultDir))) continue;
    // Collect unrecognized sibling folders that hold metadata-looking files.
    try {
      for (const e of await fs.readdir(defaultDir, { withFileTypes: true })) {
        if (!e.isDirectory() || shouldSkipDir(e.name) || knownFolders.has(e.name)) continue;
        const p = path.join(defaultDir, e.name);
        if ((await walkForFilesMatching(p, ['-meta.xml'])).length) unknownFolders.push(p);
      }
    } catch { /* unreadable dir — nothing to report */ }
    for (const rule of rules) {
      const dir = path.join(defaultDir, rule.folder);
      if (!(await pathExists(dir))) continue;
      if (rule.bundle) {
        // Walk recursively; treat any folder whose name matches its child metadata file as a bundle.
        const markers = bundleMarkersForType(rule.type);
        const bundleDirs = await walkForBundleDirs(dir, markers);
        for (const bundlePath of bundleDirs) {
          const files = await listAllFiles(bundlePath);
          items.push({ type: rule.type, name: path.basename(bundlePath), filePath: bundlePath, files });
        }
      } else if (rule.nested) {
        // e.g. email/<Folder>/<Template>.email — fullName is `Folder/Template`
        const folderEntries = await fs.readdir(dir, { withFileTypes: true });
        const primaryExts = rule.primaryExt ?? [];
        for (const folderEntry of folderEntries) {
          if (!folderEntry.isDirectory()) continue;
          const sub = path.join(dir, folderEntry.name);
          const inner = await fs.readdir(sub, { withFileTypes: true });
          for (const e of inner) {
            if (!e.isFile()) continue;
            const ext = matchExt(e.name, primaryExts);
            if (!ext) continue;
            const filePath = path.join(sub, e.name);
            const localBase = e.name.slice(0, e.name.length - ext.length);
            const name = `${folderEntry.name}/${localBase}`;
            const metaPath = rule.metaSuffix ? path.join(sub, localBase + rule.metaSuffix) : undefined;
            const files = [filePath];
            if (metaPath && (await pathExists(metaPath))) files.push(metaPath);
            items.push({ type: rule.type, name, filePath, metaPath: metaPath && (await pathExists(metaPath)) ? metaPath : undefined, files });
          }
        }
      } else {
        // Walk recursively — SFDX permits org-hint subfolders under classes/triggers/etc.,
        // and Salesforce flattens them on deploy. The metadata fullName is just the file stem.
        const primaryExts = rule.primaryExt ?? [];
        const found = await walkForFilesMatching(dir, primaryExts);
        for (const filePath of found) {
          const ext = matchExt(path.basename(filePath), primaryExts);
          if (!ext) continue;
          const baseName = path.basename(filePath);
          const name = baseName.slice(0, baseName.length - ext.length);
          const parentDir = path.dirname(filePath);
          const metaPath = rule.metaSuffix ? path.join(parentDir, name + rule.metaSuffix) : undefined;
          const files = [filePath];
          const metaExists = !!(metaPath && (await pathExists(metaPath)));
          if (metaExists && metaPath) files.push(metaPath);
          items.push({ type: rule.type, name, filePath, metaPath: metaExists ? metaPath : undefined, files });
        }
      }
    }
    // CustomObject: walk recursively under objects/ to allow org-hint subfolders.
    const objectsDir = path.join(defaultDir, 'objects');
    if (await pathExists(objectsDir)) {
      const bundleDirs = await walkForBundleDirs(objectsDir, ['.object-meta.xml']);
      for (const bundlePath of bundleDirs) {
        const files = await listAllFiles(bundlePath);
        items.push({ type: 'CustomObject', name: path.basename(bundlePath), filePath: bundlePath, files });
      }
      // Decomposed children (fields, validation rules, record types, …) — scanned
      // independently of the bundle above so they're picked up on standard objects
      // that have no deployable *.object-meta.xml.
      await scanObjectChildren(objectsDir, items);
    }
  }
  // Dedupe by type:name — the same component can appear under multiple package
  // dirs; collapsing to one entry avoids duplicate tree rows and a duplicated
  // `--metadata Type:Name` on deploy. Keep the first occurrence.
  const seenKeys = new Set<string>();
  const deduped = items.filter(i => {
    const key = `${i.type}:${i.name}`;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });
  deduped.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type.localeCompare(b.type)));
  return { items: deduped, root, unknownFolders };
}

/** Walk `objectsDir` and emit one item per decomposed object child. A directory whose
 *  name matches a known child folder (`fields`, `validationRules`, …) has its parent's
 *  basename as the owning object's API name; the files inside are the children. */
async function scanObjectChildren(objectsDir: string, items: MetadataItem[]): Promise<void> {
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries: import('fs').Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || shouldSkipDir(e.name)) continue;
      const rule = OBJECT_CHILD_BY_FOLDER.get(e.name);
      if (rule) {
        const objectName = path.basename(dir);
        const found = await walkForFilesMatching(path.join(dir, e.name), [rule.suffix]);
        for (const filePath of found) {
          const base = path.basename(filePath);
          const stem = base.slice(0, base.length - rule.suffix.length);
          items.push({ type: rule.type, name: `${objectName}.${stem}`, filePath, files: [filePath] });
        }
      } else {
        await walk(path.join(dir, e.name), depth + 1);
      }
    }
  };
  await walk(objectsDir, 0);
}

/** Find the workspace metadata item that owns the given absolute file path, if any. */
export function findItemForPath(items: MetadataItem[], absPath: string): MetadataItem | undefined {
  const normalized = path.normalize(absPath);
  // 1. Prefer the component whose primary file IS this file — picks the specific
  //    leaf (e.g. a CustomField) over the CustomObject bundle that also contains it.
  let match = items.find(i => path.normalize(i.filePath) === normalized);
  if (match) return match;
  // 2. Any component that lists this exact file (e.g. a sidecar -meta.xml).
  match = items.find(i => i.files.some(f => path.normalize(f) === normalized));
  if (match) return match;
  // 3. The containing bundle/folder.
  match = items.find(i => normalized.startsWith(path.normalize(i.filePath) + path.sep));
  return match;
}

/**
 * Infer a MetadataItem straight from any metadata file path, independent of the
 * workspace scan and the project's package-directory layout. Used as a fallback
 * when the user runs a context-menu action on a file the scan didn't pick up —
 * e.g. one that lives outside the declared package directories — so pointing at a
 * file just works instead of being rejected. Mirrors the same folder→type rules
 * the scanner uses. Returns undefined when the path isn't recognizable SF metadata.
 *
 * The caller deploys/retrieves the result by `--source-dir filePath`, which works
 * anywhere (`--metadata Type:Name` can't resolve a file outside the package dirs).
 */
export function inferItemForPath(absPath: string, extraRules: FolderRule[] = []): MetadataItem | undefined {
  const norm = path.normalize(absPath);
  const base = path.basename(norm);
  const segs = norm.split(path.sep);
  const rules = [...RULES, ...extraRules];
  const item = (type: string, name: string, filePath = norm): MetadataItem => ({ type, name, filePath, files: [filePath] });

  // 1. Decomposed object children (and the CustomObject itself) under objects/<Object>/…
  const oi = segs.lastIndexOf('objects');
  if (oi >= 0 && oi + 1 < segs.length) {
    const objectName = segs[oi + 1];
    for (const rule of OBJECT_CHILD_RULES) {
      if (base.endsWith(rule.suffix) && segs.slice(oi + 2).includes(rule.folder)) {
        return item(rule.type, `${objectName}.${base.slice(0, -rule.suffix.length)}`);
      }
    }
    if (base.endsWith('.object-meta.xml')) return item('CustomObject', objectName);
  }

  // 2. Bundle types (LWC/Aura): the component is the bundle directory under lwc/ or aura/.
  for (const rule of rules) {
    if (!rule.bundle) continue;
    const bi = segs.lastIndexOf(rule.folder);
    if (bi >= 0 && bi + 1 < segs.length) {
      const bundleDir = segs.slice(0, bi + 2).join(path.sep);
      return item(rule.type, segs[bi + 1], bundleDir);
    }
  }

  // 3. Nested EmailTemplate: email/<Folder>/<Name>.email → fullName `Folder/Name`.
  // Require a folder level (file at ei+2 or deeper) — a bare email/<Name>.email has no
  // valid fullName, so leave it unrecognized rather than inventing `<Name>.email/<Name>`.
  const ei = segs.lastIndexOf('email');
  if (ei >= 0 && ei + 2 < segs.length) {
    for (const suffix of ['.email-meta.xml', '.email']) {
      if (base.endsWith(suffix)) return item('EmailTemplate', `${segs[ei + 1]}/${base.slice(0, -suffix.length)}`);
    }
  }

  // 4. Regular single-/per-file types — matched by the type's folder plus extension.
  for (const rule of rules) {
    if (rule.bundle || rule.nested || segs.lastIndexOf(rule.folder) < 0) continue;
    for (const ext of rule.primaryExt ?? []) {
      if (base.endsWith(ext)) return item(rule.type, base.slice(0, -ext.length));
    }
    if (rule.metaSuffix && base.endsWith(rule.metaSuffix)) return item(rule.type, base.slice(0, -rule.metaSuffix.length));
  }
  return undefined;
}

/** Parse `<types>` blocks out of a package.xml produced by
 *  `sf project generate manifest`. Deliberately a regex over CLI-emitted XML we
 *  control the producer of — no XML-parser dependency. */
export function parseManifestTypes(xml: string): Array<{ type: string; members: string[] }> {
  const out: Array<{ type: string; members: string[] }> = [];
  for (const block of xml.match(/<types>[\s\S]*?<\/types>/g) ?? []) {
    const type = /<name>([^<]+)<\/name>/.exec(block)?.[1]?.trim();
    // Real metadata type names are strictly alphanumeric. A crafted
    // registryCustomizations block in a hostile sfdx-project.json can echo an
    // arbitrary string here, and resolved types later become CLI argv tokens
    // (--metadata-type) — reject anything shaped like a flag or containing
    // whitespace before it enters the pipeline. (execFile already prevents
    // injection; this is defense-in-depth per security review.)
    if (!type || !/^[A-Za-z0-9_]+$/.test(type)) continue;
    const members = [...block.matchAll(/<members>([^<]+)<\/members>/g)].map(m => m[1].trim()).filter(Boolean);
    if (members.length) out.push({ type, members });
  }
  return out;
}

/**
 * Derive a reusable FolderRule from one CLI-resolved folder: find a member whose
 * file is `<member><suffix>` and generalize to `folder + suffix → type`.
 * Prefers the `-meta.xml` sibling when a type has a content/meta file pair, so
 * the rule keys on the canonical suffix. Returns undefined for shapes that don't
 * generalize from one sample (bundles: member is a directory, no dot; nested
 * types: member contains '/').
 * Known ceiling: per-file suffix rules only — exotic bundle types aren't learned
 * into the tree; context-menu deploy of them still works via --source-dir.
 */
export function deriveRule(folderName: string, type: string, members: string[], fileNames: string[]): FolderRule | undefined {
  const files = [...fileNames].sort((a, b) => Number(b.endsWith('-meta.xml')) - Number(a.endsWith('-meta.xml')));
  for (const m of members) {
    if (m.includes('/')) continue;
    for (const f of files) {
      if (!f.startsWith(m + '.')) continue;
      const suffix = f.slice(m.length);
      // Canonical sidecar suffixes only: a generic content suffix (e.g. `.xml`)
      // would scoop unrelated files on later scans. Every deployable per-file
      // type in source format carries a `*-meta.xml`.
      if (suffix.endsWith('-meta.xml')) return { folder: folderName, type, primaryExt: [suffix] };
    }
  }
  return undefined;
}

function matchExt(name: string, exts: string[]): string | undefined {
  for (const e of exts) if (name.endsWith(e)) return e;
  return undefined;
}

/** Directories that never contain deployable SF metadata — skipped while walking
 *  to bound cost (and avoid following symlink loops into, e.g., node_modules). */
const SKIP_DIRS = new Set(['node_modules', '.git', '.sfdx', '.localdevserver']);
const MAX_SCAN_DEPTH = 20;
function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith('.');
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function listAllFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, depth: number) => {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries: import('fs').Dirent[];
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!shouldSkipDir(e.name)) await walk(p, depth + 1); }
      else if (e.isFile()) out.push(p);
    }
  };
  await walk(dir, 0);
  return out;
}

async function walkForFilesMatching(dir: string, exts: string[]): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, depth: number) => {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries: import('fs').Dirent[];
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!shouldSkipDir(e.name)) await walk(p, depth + 1); }
      else if (e.isFile() && matchExt(e.name, exts)) out.push(p);
    }
  };
  await walk(dir, 0);
  return out;
}

/** Marker -meta.xml suffixes per bundle type. A folder is a bundle iff it contains a file
 *  named `<folderName><suffix>` for one of these suffixes. */
function bundleMarkersForType(type: string): string[] {
  switch (type) {
    case 'LightningComponentBundle':
      return ['.js-meta.xml'];
    case 'AuraDefinitionBundle':
      return ['.cmp-meta.xml', '.app-meta.xml', '.evt-meta.xml', '.intf-meta.xml', '.tokens-meta.xml', '.svg-meta.xml', '.design-meta.xml'];
    default:
      return [];
  }
}

/** Walk the tree under `root`. Returns directories that look like a bundle:
 *  a directory whose name equals the stem of a `*<markerSuffix>` file directly inside it.
 *  Does not descend into folders already identified as bundles. */
async function walkForBundleDirs(root: string, markerSuffixes: string[]): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, depth: number) => {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries: import('fs').Dirent[];
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    const dirName = path.basename(d);
    const isBundle = entries.some(e => e.isFile() && markerSuffixes.some(s => e.name === `${dirName}${s}`));
    if (isBundle) {
      out.push(d);
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !shouldSkipDir(e.name)) await walk(path.join(d, e.name), depth + 1);
    }
  };
  // Don't classify the root itself as a bundle — start from its children.
  let entries: import('fs').Dirent[];
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory() && !shouldSkipDir(e.name)) await walk(path.join(root, e.name), 1);
  }
  return out;
}
