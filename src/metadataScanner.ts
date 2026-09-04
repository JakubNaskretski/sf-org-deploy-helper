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

export interface ProjectRootDiscovery {
  /** Directory containing the one discovered sfdx-project.json. */
  root?: string;
  /** De-duplicated sfdx-project.json paths found below the open workspace folders. */
  projectFiles: string[];
  /** User-facing reason discovery could not select exactly one project. */
  error?: string;
}

export interface WorkspaceScan {
  items: MetadataItem[];
  root?: string;
  warning?: string;
  /** A root-discovery failure. No sf command may run when this is set. */
  projectError?: string;
  unknownFolders: string[];
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
  // OmniStudio, standard runtime — directoryName/suffix straight from the sf
  // registry. One default-adapter `<fullName>.<suffix>-meta.xml` per component:
  // no content/meta pair, no bundle, no decomposition. Static so the tree never
  // hangs on a learned rule that expires or is absent while the cache is off.
  { folder: 'omniScripts', type: 'OmniScript', primaryExt: ['.os-meta.xml'] },
  { folder: 'omniIntegrationProcedures', type: 'OmniIntegrationProcedure', primaryExt: ['.oip-meta.xml'] },
  { folder: 'omniDataTransforms', type: 'OmniDataTransform', primaryExt: ['.rpt-meta.xml'] },
  { folder: 'omniUiCard', type: 'OmniUiCard', primaryExt: ['.ouc-meta.xml'] },
];

/** Decomposed children of a CustomObject in SFDX source format. Each is a single
 *  `*-meta.xml` file living under `objects/<Object>/<folder>/`, and each is its own
 *  addressable metadata type with the fullName `Object.Child`
 *  (e.g. `CustomField:Account.MyField__c`). These exist on standard objects too —
 *  even ones with no deployable `*.object-meta.xml` — so they're scanned
 *  independently of the CustomObject bundle. */
/** Folders the static rules own. Registry-derived rules skip these: the static
 *  entry knows shapes the registry's default adapter doesn't (bundles, objects). */
export const STATIC_RULE_FOLDERS: ReadonlySet<string> = new Set([...RULES.map(r => r.folder), 'objects']);

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

/** Types whose scanned `filePath` is a DIRECTORY — the bundle folder (`lwc/<name>`,
 *  `aura/<name>`) or the object folder (`objects/<Object>`) — rather than a file.
 *  That is deliberate: deploy targeting, diff, retrieve backups and findItemForPath
 *  all address the folder. Anything that hands `filePath` to an editor or to a
 *  file-only CLI flag must resolve a real file first (bundleDefinitionFile).
 *  Learned rules can never join this set — deriveRule only ever emits per-file
 *  rules — so the membership here is complete and static. */
export const DIRECTORY_ITEM_TYPES: ReadonlySet<string> = new Set([
  ...RULES.filter(r => r.bundle).map(r => r.type),
  'CustomObject'
]);

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

/**
 * Reduce file-search results to one project root. Kept separate from the VS Code
 * search so the duplicate/multiple-project contract is directly testable.
 */
export function selectProjectRoot(projectFiles: string[]): Pick<ProjectRootDiscovery, 'root' | 'projectFiles'> {
  const byPath = new Map<string, string>();
  for (const file of projectFiles) {
    const normalized = path.normalize(file);
    byPath.set(foldPathKey(normalized), normalized);
  }
  const unique = [...byPath.values()].sort((a, b) => a.localeCompare(b));
  return {
    root: unique.length === 1 ? path.dirname(unique[0]) : undefined,
    projectFiles: unique
  };
}

/**
 * Find the Salesforce project below the open workspace folder(s). The extension
 * intentionally accepts a parent folder as the workspace, but it refuses to
 * guess when that parent contains multiple sfdx-project.json files.
 */
export async function discoverProjectRoot(): Promise<ProjectRootDiscovery> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return { projectFiles: [], error: 'No workspace folder is open.' };
  }

  let found: vscode.Uri[];
  try {
    const perFolder = await Promise.all(folders.map(folder => vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/sfdx-project.json'),
      '**/{node_modules,.git}/**',
      100
    )));
    found = perFolder.flat();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { projectFiles: [], error: `Couldn't search this workspace for Salesforce DX projects: ${message}` };
  }

  const selected = selectProjectRoot(found.map(uri => uri.fsPath));
  if (selected.root) return selected;
  if (selected.projectFiles.length === 0) {
    return {
      ...selected,
      error: 'No Salesforce DX project found in this workspace. Expected exactly one sfdx-project.json.'
    };
  }

  const includeWorkspaceFolder = folders.length > 1;
  const labels = selected.projectFiles.slice(0, 6).map(file =>
    vscode.workspace.asRelativePath(vscode.Uri.file(file), includeWorkspaceFolder)
  );
  const remainder = selected.projectFiles.length - labels.length;
  return {
    ...selected,
    error: `Found more than one Salesforce DX project in this workspace. Expected exactly one sfdx-project.json. Found: ${labels.join(', ')}${remainder > 0 ? `, and ${remainder} more` : ''}.`
  };
}

export async function scanWorkspace(extraRules: FolderRule[] = []): Promise<WorkspaceScan> {
  const discovery = await discoverProjectRoot();
  if (!discovery.root) {
    return { items: [], projectError: discovery.error, unknownFolders: [] };
  }
  const root = discovery.root;
  const pkgDirs = await resolvePackageDirs(root);
  const items: MetadataItem[] = [];
  // Static rules first, learned rules after — a duplicate folder match produces
  // duplicate items, which the existing type:name dedupe below collapses.
  const rules = [...RULES, ...extraRules];
  // Top-level folders under the package default dir that no rule covers — the
  // caller can resolve their types via the sf CLI registry and rescan. A static
  // folder is fully owned. A folder only EXTRA rules cover (registry/learned,
  // always per-file suffix rules) is still unknown when it holds -meta.xml files
  // none of those suffixes match: a mixed folder such as wave/ must keep
  // reaching the CLI for the shapes the registry rules don't describe.
  const unknownFolders: string[] = [];
  const extraExts = new Map<string, string[]>();
  for (const r of extraRules) extraExts.set(r.folder, [...(extraExts.get(r.folder) ?? []), ...(r.primaryExt ?? [])]);
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
        if (!e.isDirectory() || shouldSkipDir(e.name) || STATIC_RULE_FOLDERS.has(e.name)) continue;
        const p = path.join(defaultDir, e.name);
        const metas = await walkForFilesMatching(p, ['-meta.xml']);
        const exts = extraExts.get(e.name);
        const residual = exts ? metas.filter(f => !exts.some(x => f.endsWith(x))) : metas;
        if (residual.length) unknownFolders.push(p);
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
  const warning = await detectDataPackExports(root, pkgDirs);
  return { items: deduped, root, unknownFolders, ...(warning ? { warning } : {}) };
}

/** Banner text for a project carrying OmniStudio DataPack exports (Vlocity Build
 *  Tool / IDX layout). Those are DATA exports, not Metadata API source: the scan
 *  cannot list them, and without this line a DataPack-based project reads as
 *  "the extension ignores OmniStudio". Names the four standard-runtime types
 *  that ARE handled so the reader knows which layout to retrieve instead. */
export const DATAPACK_WARNING = 'OmniStudio DataPack exports (vlocity/, *_DataPack.json) are data records, not Metadata API source, so they are not listed here. This extension handles the standard-runtime types OmniScript, OmniIntegrationProcedure, OmniDataTransform and OmniUiCard as retrieved by sf (omniScripts/, omniIntegrationProcedures/, omniDataTransforms/, omniUiCard/).';

/** DATAPACK_WARNING when a top-level `vlocity/` folder (project root or package
 *  dir) exists or any `*_DataPack.json` sits under a package dir; else undefined.
 *  Pure (root + package dirs in) so the harness can drive it on a temp tree. */
export async function detectDataPackExports(root: string, pkgDirs: string[]): Promise<string | undefined> {
  if (await isDirectory(path.join(root, 'vlocity'))) return DATAPACK_WARNING;
  for (const pkg of pkgDirs) {
    const pkgRoot = path.join(root, pkg);
    if (await isDirectory(path.join(pkgRoot, 'vlocity'))) return DATAPACK_WARNING;
    if (await hasFileMatching(pkgRoot, ['_DataPack.json'])) return DATAPACK_WARNING;
  }
  return undefined;
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

/**
 * Canonical comparison key for a filesystem path. Windows filesystems are
 * case-insensitive AND VS Code's URI sources disagree about drive-letter casing
 * (the workspace folder, the vscode.git extension, and open/save dialogs can each
 * hand back a different case for the same file) — so every cross-source path
 * COMPARISON must run both sides through this, or a mere casing drift reads as a
 * different file. Display strings keep their original casing; only comparison keys
 * are folded. The `platform` param defaults to the host but is overridable so
 * win32 folding is testable off Windows.
 */
export function foldPathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const n = path.normalize(p);
  return platform === 'win32' ? n.toLowerCase() : n;
}

/** Find the workspace metadata item that owns the given absolute file path, if any. */
export function findItemForPath(items: MetadataItem[], absPath: string, platform: NodeJS.Platform = process.platform): MetadataItem | undefined {
  const key = foldPathKey(absPath, platform);
  // 1. Prefer the component whose primary file IS this file — picks the specific
  //    leaf (e.g. a CustomField) over the CustomObject bundle that also contains it.
  let match = items.find(i => foldPathKey(i.filePath, platform) === key);
  if (match) return match;
  // 2. Any component that lists this exact file (e.g. a sidecar -meta.xml).
  match = items.find(i => i.files.some(f => foldPathKey(f, platform) === key));
  if (match) return match;
  // 3. The containing bundle/folder.
  match = items.find(i => key.startsWith(foldPathKey(i.filePath, platform) + path.sep));
  return match;
}

/** Extensions that spell a bundle's OWN definition file, best first. One list for
 *  every directory-typed component, because the resolution rule is the same in
 *  each case: the file named after the folder. `.object-meta.xml` is the whole of
 *  CustomObject (there is no `<Object>.object` in source format); `.js` beats
 *  `.html` for an LWC because the module is where the component is declared and
 *  its imports are; the Aura entries are the four mutually-exclusive bundle roots
 *  plus the two token/design bundles that have no `.cmp`. */
const BUNDLE_DEFINITION_EXTS = ['.object-meta.xml', '.js', '.html', '.cmp', '.app', '.evt', '.intf', '.tokens', '.design'];

/**
 * The concrete FILE to open for a component whose `filePath` is a directory (see
 * DIRECTORY_ITEM_TYPES). Resolution is explicit rather than "first file in the
 * list", because the scan's `files` order is filesystem-dependent and, for a
 * CustomObject, `files` also carries the decomposed children — opening
 * `objects/Widget__c/fields/Size__c.field-meta.xml` for a click on `Widget__c`
 * would show a DIFFERENT component's source and read as a bug of its own.
 *
 * Order: `<name><ext>` directly inside the folder for the ranked extensions above,
 * then any other direct child named `<name>.*`, then the recorded `metaPath`, then
 * the first listed file. Undefined only when the item lists no files at all — the
 * caller must then say so instead of handing a directory to an editor.
 *
 * Name comparison is case-insensitive: `name` is the folder's own basename, so on
 * a case-preserving filesystem the two always agree, and folding costs nothing.
 */
export function bundleDefinitionFile(
  item: Pick<MetadataItem, 'name' | 'filePath' | 'metaPath' | 'files'>,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  const dirKey = foldPathKey(item.filePath, platform);
  const direct = item.files.filter(f => foldPathKey(path.dirname(f), platform) === dirKey);
  const named = direct.filter(f => path.basename(f).toLowerCase().startsWith(`${item.name.toLowerCase()}.`));
  for (const ext of BUNDLE_DEFINITION_EXTS) {
    const want = `${item.name}${ext}`.toLowerCase();
    const hit = named.find(f => path.basename(f).toLowerCase() === want);
    if (hit) return hit;
  }
  return named[0] ?? item.metaPath ?? direct[0] ?? item.files[0];
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

/** Multi-type folder (wave/: WaveDataset .wds next to WaveDashboard .wdash):
 *  one rule per type, but only when the binding is unambiguous — every member
 *  of a type maps to exactly one `-meta.xml` suffix, and no two types claim the
 *  same suffix. A same-named member across two types would bind both suffixes
 *  and is refused wholesale (undefined), as is a type with no derivable file:
 *  a wrong cached rule would mislabel the folder on every scan until expiry. */
export function deriveRulesForTypes(folderName: string, types: Array<{ type: string; members: string[] }>, fileNames: string[]): FolderRule[] | undefined {
  const rules: FolderRule[] = [];
  const claimed = new Set<string>();
  for (const t of types) {
    const suffixes = new Set<string>();
    for (const m of t.members) {
      if (m.includes('/')) continue;
      for (const f of fileNames) {
        if (f.startsWith(m + '.') && f.endsWith('-meta.xml')) suffixes.add(f.slice(m.length));
      }
    }
    if (suffixes.size !== 1) return undefined;
    const [suffix] = suffixes;
    if (claimed.has(suffix)) return undefined;
    claimed.add(suffix);
    rules.push({ folder: folderName, type: t.type, primaryExt: [suffix] });
  }
  return rules.length ? rules : undefined;
}

/** Basenames of every `-meta.xml` under `dir`, at any depth. deriveRule keys on
 *  `<member><suffix>` names, and a folder whose files sit in an org-hint
 *  subfolder (a layout the CLI itself accepts) has none at the top level — a
 *  flat readdir there derived nothing and the folder was negative-cached. */
export async function listMetaFileNames(dir: string): Promise<string[]> {
  return (await walkForFilesMatching(dir, ['-meta.xml'])).map(f => path.basename(f));
}

/** What detectMissingDependencies found in a batch of org failure messages.
 *  `keys` are safe `--metadata Type:Name` targets (every one matched a real local
 *  item); `unresolved` is display-only text for referents the org named but this
 *  workspace doesn't contain — the user still needs to SEE those, because they
 *  are exactly the case where the extension can't help and the person has to
 *  retrieve the component or fix the reference. */
export interface MissingDependencies {
  keys: string[];
  unresolved: string[];
}

/** Custom-object suffixes: a bare type name ending in one of these is an sObject
 *  (custom object, custom metadata type, platform event, big object, external
 *  object), never an Apex class — so `Invalid type: Foo__mdt` resolves against
 *  CustomObject rather than guessing across every metadata type. Exported for
 *  depGraph's source-token matching so the two features can't drift apart on
 *  what counts as an sObject name. */
export const SOBJECT_SUFFIX = /__(mdt|c|e|b|x)$/i;

/** Cap on org-controlled text echoed back into the panel card. The webview sets
 *  it via textContent (no HTML risk) but the output channel and status history
 *  take it verbatim, so bound the length and strip control characters. */
const UNRESOLVED_MAX = 5;
// 100, not 60: the ambiguous-candidate line ("Status__c (ambiguous: Account.Status__c,
// Case.Status__c)") is the actionable one, and a 60-char cap truncated it
// mid-identifier into noise. Still bounded — this is org-controlled text.
const UNRESOLVED_MAX_LEN = 100;

/** Apex built-ins and platform types. A compile failure names these constantly
 *  ("Method does not exist ... from the type List<String>"), and they are NOT
 *  deployable components — telling the user to "retrieve String from an org" is
 *  nonsense, and with only UNRESOLVED_MAX slots the noise would crowd out the one
 *  custom component the report exists to surface.
 *  This is a static list, not the full Apex type registry — extend it when a
 *  real message surfaces a type that shouldn't be reported.
 *  Exported (with PLATFORM_NAMESPACES / STANDARD_NAMES / isPlatformName) so
 *  depGraph's local-source token matching reuses the SAME denylists instead of
 *  maintaining a duplicate that would silently diverge. */
export const APEX_BUILTIN_TYPES = new Set([
  'blob', 'boolean', 'date', 'datetime', 'decimal', 'double', 'id', 'integer', 'long',
  'object', 'string', 'time', 'list', 'set', 'map', 'iterator', 'iterable', 'sobject',
  'exception', 'type', 'trigger', 'test', 'system', 'database', 'schema', 'json',
  'math', 'limits', 'userinfo', 'pattern', 'matcher', 'http', 'httprequest',
  'httpresponse', 'pagereference', 'savepoint', 'version', 'comparable', 'queueable',
  'batchable', 'schedulable', 'callable'
]);

/** Namespaces whose members are platform-provided, so `System.JSONParser` or
 *  `Schema.SObjectType` is never something the user can deploy. */
export const PLATFORM_NAMESPACES = new Set([
  'system', 'schema', 'database', 'messaging', 'connectapi', 'apex', 'auth', 'cache',
  'canvas', 'chatteranswers', 'datacloud', 'dom', 'eventbus', 'flow', 'functions',
  'kbmanagement', 'metadata', 'process', 'quickaction', 'reports', 'search', 'sfc',
  'sfdc_surveys', 'site', 'support', 'territorymgmt', 'txnsecurity', 'userprovisioning', 'wave'
]);

/** Standard sObjects and standard field names the org always has — referencing one
 *  that isn't in the workspace is not a missing dependency. Same noise argument as
 *  APEX_BUILTIN_TYPES; a resolvable LOCAL item of the same name still wins, because
 *  this list only ever suppresses the unresolved REPORT, never a lookup. */
export const STANDARD_NAMES = new Set([
  'account', 'contact', 'lead', 'opportunity', 'case', 'user', 'task', 'event',
  'campaign', 'product2', 'pricebook2', 'pricebookentry', 'order', 'orderitem',
  'quote', 'contract', 'asset', 'attachment', 'note', 'document', 'folder', 'group',
  'profile', 'recordtype', 'organization', 'contentversion', 'contentdocument',
  'opportunitylineitem', 'campaignmember', 'name', 'createddate', 'lastmodifieddate',
  'ownerid', 'isdeleted', 'createdbyid', 'lastmodifiedbyid', 'systemmodstamp'
]);

/** True when a referent is platform-provided and so must never be reported as a
 *  missing workspace component. Applied ONLY to the unresolved report — never to
 *  key resolution, so a genuinely local component with a colliding name still
 *  resolves normally. (depGraph applies it the other way round — to token
 *  LOOKUPS — because there a platform name can only ever be a false positive.) */
export function isPlatformName(raw: string): boolean {
  const lower = raw.toLowerCase();
  if (APEX_BUILTIN_TYPES.has(lower) || STANDARD_NAMES.has(lower)) return true;
  const dot = lower.indexOf('.');
  if (dot > 0) {
    const head = lower.slice(0, dot);
    if (PLATFORM_NAMESPACES.has(head)) return true;
    // "Account.Name" — a standard field on a standard object.
    if (STANDARD_NAMES.has(head) && STANDARD_NAMES.has(lower.slice(dot + 1))) return true;
  }
  return false;
}

/** One referent parsed out of an org error message. `tries` is an ordered list of
 *  (type, name) lookups — first hit wins. `bareName` is the no-type-given case
 *  ("Variable does not exist: X"), which resolves ONLY on a unique match. */
interface Candidate {
  display: string;
  tries?: Array<{ type: string; name: string }>;
  bareName?: string;
}

/** Type guesses for a bare type token from an Apex compile error. A dotted name
 *  is an inner class/enum reference (`Outer.Inner`) whose deployable unit is the
 *  OUTER class; a `__c`/`__mdt`/… suffix is an sObject; anything else is an Apex
 *  class. Each guess is only ever a LOOKUP — an unmatched guess resolves to
 *  nothing, so a wrong shape rule can't mint a bogus key. */
function typeGuesses(raw: string): Array<{ type: string; name: string }> {
  const dot = raw.indexOf('.');
  if (dot > 0) {
    const head = raw.slice(0, dot);
    // `Foo__c.Bar__c` in a type position is an sObject-qualified reference; a
    // plain `Outer.Inner` is Apex. Try both heads, sObject first when it looks it.
    return SOBJECT_SUFFIX.test(head)
      ? [{ type: 'CustomObject', name: head }, { type: 'ApexClass', name: head }]
      : [{ type: 'ApexClass', name: head }];
  }
  return SOBJECT_SUFFIX.test(raw)
    ? [{ type: 'CustomObject', name: raw }]
    : [{ type: 'ApexClass', name: raw }];
}

/** Split a captured type token into the names actually worth resolving:
 *  `List<Widget__c>` -> ['Widget__c'], `Map<Id, Foo__c>` -> ['Id', 'Foo__c'].
 *  Without this the collection wrapper is all we would ever see, and the real
 *  missing component inside it would be invisible. A bare token returns itself. */
function splitTypeTokens(raw: string): string[] {
  const open = raw.indexOf('<');
  if (open < 0) return [raw];
  const inner = raw.slice(open + 1).replace(/>+\s*$/, '');
  const parts = inner.split(',').map(t => t.trim()).filter(Boolean);
  // Keep the outer name too when it isn't a plain collection — a generic custom
  // Apex class is itself deployable.
  const outer = raw.slice(0, open).trim();
  return (outer ? [outer] : []).concat(parts.flatMap(splitTypeTokens));
}

/** Render an ambiguous candidate list so it survives the length cap intact —
 *  truncating mid-identifier turns the one actionable line into noise. */
function describeCandidates(hits: MetadataItem[]): string {
  const shown = hits.slice(0, 2).map(h => h.name);
  const rest = hits.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} +${rest} more` : shown.join(', ');
}

function sanitizeUnresolved(text: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > UNRESOLVED_MAX_LEN ? `${flat.slice(0, UNRESOLVED_MAX_LEN - 1)}…` : flat;
}

/**
 * Parse deploy-failure problem strings for references to components that are
 * MISSING on the target org — feeding both the failure card's dependency
 * suggestions and
 * the card's "referenced but not in your workspace" diagnosis (panelProvider's
 * reportDeployResult), so a dependency the org couldn't find gets added to the
 * next attempt instead of making the user hunt it down.
 *
 * A parsed candidate only becomes a `keys` entry when it matches a REAL local
 * item in `items` — exact `type`+`name`, or (falling back) the same `type` with
 * a case-insensitive `name` match, in which case the ITEM's own casing is
 * returned, never the error text's. This means org-controlled error text can
 * NEVER mint a key for a component that isn't actually part of this workspace's
 * scan — it can only ever surface a key that was already going to be a valid
 * `--metadata Type:Name`. A candidate that resolves to nothing is NOT discarded:
 * it lands in `unresolved` as display-only text, which is the only feedback the
 * user gets when the missing dependency isn't in the workspace at all.
 *
 * Keys already in `deployedKeys` (this attempt's own component list — they
 * failed for some OTHER reason, they're not "missing") are excluded from both
 * lists. Both lists are deduped, first-seen order preserved.
 */
export function detectMissingDependencies(
  problems: string[],
  items: MetadataItem[],
  deployedKeys: Set<string>
): MissingDependencies {
  const byExact = new Map<string, MetadataItem>();
  const byCiName = new Map<string, MetadataItem>(); // `${type}:${name.toLowerCase()}` -> item
  // Bare-name index for the "Variable does not exist" branch. Built ONCE: filtering
  // `items` per candidate was O(candidates x items) and measured at ~32s of
  // synchronous extension-host block on a failure message naming ~190 bare names
  // in a 20k-component workspace.
  const byBareName = new Map<string, MetadataItem[]>();
  const pushBare = (name: string, it: MetadataItem): void => {
    const list = byBareName.get(name);
    if (list) list.push(it); else byBareName.set(name, [it]);
  };
  for (const it of items) {
    byExact.set(`${it.type}:${it.name}`, it);
    const ciKey = `${it.type}:${it.name.toLowerCase()}`;
    if (!byCiName.has(ciKey)) byCiName.set(ciKey, it);
    if (it.type === 'CustomField') pushBare((it.name.split('.').pop() ?? '').toLowerCase(), it);
    else if (it.type === 'ApexClass') pushBare(it.name.toLowerCase(), it);
  }

  const candidates: Candidate[] = [];
  for (const problem of problems) {
    if (!problem) continue;
    // A FlexiPage referencing a QuickAction that doesn't exist on the org:
    // "In field: action - no QuickAction named Account.Foo found"
    // Also matches the destructive-changes variant (org-verified, note the
    // capital and the colon): "No ApexClass named: Foo found".
    // The NAME may contain spaces: a Layout fullName always does
    // ("Account-Account Layout"), so a space-less capture never fired at all for
    // a profile/permission set referencing a missing layout — no suggestion AND
    // no unresolved line, just silence. Bounded so the widened capture can't run
    // off into the surrounding prose: identifier characters only (excludes
    // newlines, commas, quotes, parentheses), a handful of space-separated words,
    // each word length-capped, and LAZY + anchored on the literal " found" so it
    // stops at the first one rather than swallowing everything up to the last.
    // The FIRST word gets the larger cap because a dotted fullName carries no
    // space at all: `Object__c.Field__c` is legal at 40 + 1 + 43 characters (more
    // with namespace prefixes), so a 60-char first word would match NOTHING for
    // those — the same silence the widening exists to remove. Later words are
    // prose-sized (a Layout's "Account-Account Layout"), so 60 covers them.
    // A capture that does pick up a stray word is still safe by construction: it
    // won't match a scanned item, so it can only ever become display-only
    // `unresolved` text — never a --metadata key.
    for (const m of problem.matchAll(/[Nn]o ([A-Za-z0-9_]+) named:? ([\w.\-/]{1,120}(?: [\w.\-/]{1,60}){0,5}?) found/g)) {
      candidates.push({ display: `${m[1]}:${m[2]}`, tries: [{ type: m[1], name: m[2] }] });
    }
    // An Apex class whose own dependency wasn't part of this same batch:
    // "Dependent class is invalid and needs recompilation: Class MyHelper: Invalid type: Bar"
    // Captures the class being RECOMPILED — including it forces a rebuild against
    // the local copy. The inner cause ("Invalid type: Bar") is the real missing
    // dependency and is picked up by the Invalid-type rule below, which scans the
    // same string; both are needed, neither alone is sufficient.
    for (const m of problem.matchAll(/[Dd]ependent class is invalid and needs recompilation:?\s*(?:Class\s+)?([\w.]+)/g)) {
      candidates.push({ display: `ApexClass:${m[1]}`, tries: [{ type: 'ApexClass', name: m[1] }] });
    }
    // SOQL against a field the org doesn't have. Fully typed AND parented, so
    // there is no ambiguity: "No such column 'Status__c' on entity 'Account'".
    for (const m of problem.matchAll(/No such column '([A-Za-z0-9_]+)' on entity '([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)'/g)) {
      candidates.push({ display: `${m[2]}.${m[1]}`, tries: [{ type: 'CustomField', name: `${m[2]}.${m[1]}` }] });
    }
    // Same shape from the other Salesforce phrasing:
    // "Invalid field Status__c for SObject Account".
    for (const m of problem.matchAll(/Invalid field ([A-Za-z0-9_]+) for SObject ([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)/g)) {
      candidates.push({ display: `${m[2]}.${m[1]}`, tries: [{ type: 'CustomField', name: `${m[2]}.${m[1]}` }] });
    }
    // The user's reported case: "Invalid type: smth__mdt" — an Apex reference to
    // an sObject or class the org doesn't have. No type in the text, so resolve
    // by NAME SHAPE (see typeGuesses) rather than scanning every metadata type.
    for (const m of problem.matchAll(/Invalid type:\s*([A-Za-z_][\w.]*(?:<[^>\n]{0,200}>)?)/g)) {
      for (const tok of splitTypeTokens(m[1])) candidates.push({ display: tok, tries: typeGuesses(tok) });
    }
    // "Method does not exist or incorrect signature: void foo() from the type Bar"
    for (const m of problem.matchAll(/Method does not exist or incorrect signature:.*?from the type ([A-Za-z_][\w.]*(?:<[^>\n]{0,200}>)?)/g)) {
      for (const tok of splitTypeTokens(m[1])) candidates.push({ display: tok, tries: typeGuesses(tok) });
    }
    // The hard one: "Variable does not exist: Status__c" gives NO type and no
    // parent, so a bare name can match Account.Status__c and Case.Status__c
    // equally. Resolved unique-match-only (see below) — never guessed.
    for (const m of problem.matchAll(/Variable does not exist:\s*([A-Za-z_]\w*)/g)) {
      candidates.push({ display: m[1], bareName: m[1] });
    }
    // A FlexiPage referencing a field the org doesn't have (org-verified via a
    // user report): "Something went wrong. We couldn't retrieve or load the
    // information on the field: Record.TotalEstimatedRevenue__c". "Record" is
    // the page's assigned object, not a name — so this is a bare-name referent
    // like the Variable case, resolved unique-match-only. The wording drifts
    // ("on"/"of", with/without "the", punctuation), so match tolerantly.
    for (const m of problem.matchAll(/retrieve or load the information (?:on|of) (?:the )?field[:.]?\s*(?:Record\.)?([A-Za-z_]\w*)/gi)) {
      candidates.push({ display: m[1], bareName: m[1] });
    }
    // A QuickAction whose <lightningWebComponent>/<lightningComponent> names a
    // bundle the org doesn't have — the reported case. Org-verified wording:
    // "Unable to retrieve lightning web component by namespace/developer name : myCmp"
    // Lowercase, spaced colon, and the value is the BARE developer name — no `c:`
    // prefix, no quotes, no brackets. The sentence without "web" is the Aura form,
    // so one pattern covers both and "web" only decides which bundle type is tried
    // FIRST; both are lookups, so the second-guess costs nothing and a wrong guess
    // resolves to nothing rather than minting a key.
    // The name ends the sentence, so nothing anchors its right-hand side and the
    // capture must refuse anything it can't consume WHOLE rather than keep a
    // prefix: a prefix names a DIFFERENT component that may well exist locally
    // ("timeline-v2" truncating to a real "timeline"), which is a wrong-attribution
    // key, not a near miss. Hence two guards — no identifier character or `-` may
    // follow, and a `.` may only follow when nothing identifier-ish comes after it,
    // so the sentence-final period and end-of-line still match while "timeline.js"
    // does not. Same refuse-don't-truncate stance as the per-word cap above.
    for (const m of problem.matchAll(/Unable to retrieve lightning (web )?component by namespace\/developer name\s*:\s*([A-Za-z0-9_]{1,80})(?![A-Za-z0-9_\-])(?!\.[A-Za-z0-9_])/gi)) {
      const lwc = { type: 'LightningComponentBundle', name: m[2] };
      const aura = { type: 'AuraDefinitionBundle', name: m[2] };
      candidates.push({ display: m[2], tries: m[1] ? [lwc, aura] : [aura, lwc] });
    }
    // An LWC importing Apex the org can't resolve:
    // "Unable to find Apex action class referenced as 'MyController'."
    // "Unable to find Apex action method referenced as 'MyController.getRows'."
    // The deployable unit is the CLASS either way, so the method form keeps only
    // the segment before the first dot.
    for (const m of problem.matchAll(/Unable to find Apex action (?:class|method) referenced as '([A-Za-z0-9_]{1,80})(?:\.[A-Za-z0-9_]{1,80})?'/g)) {
      candidates.push({ display: `ApexClass:${m[1]}`, tries: [{ type: 'ApexClass', name: m[1] }] });
    }
    // An LWC's static @salesforce import the org can't satisfy:
    // "Invalid reference c.My_Label of type label in file cmp.js"
    // "Invalid reference myResource of type resourceUrl in file cmp.js"
    // The `c.` belongs to the IMPORT syntax, not to the label's fullName, so it is
    // stripped (the resourceUrl form carries no prefix at all). Only these two
    // verified `of type` values are handled — other values are left alone rather
    // than mapped to a guessed metadata type.
    for (const m of problem.matchAll(/Invalid reference (?:c\.)?([A-Za-z0-9_]{1,80}) of type (label|resourceUrl)\b/gi)) {
      const type = m[2].toLowerCase() === 'label' ? 'CustomLabel' : 'StaticResource';
      candidates.push({ display: `${type}:${m[1]}`, tries: [{ type, name: m[1] }] });
    }
    // Aura/LWC markup naming a definition the org doesn't have. Three renderings
    // are verified — "found : [" (v61), the older "found: [", and a bare "found" —
    // so the pattern anchors on " found" and ignores whatever follows it:
    //   "No MODULE named markup://c:childCmp found : [markup://c:parentCmp]"
    //   "No COMPONENT named markup://c:someCmp found"
    // ONLY the `c` namespace can name a local component. force:, flexipage:,
    // lightning: and managed-package namespaces are platform-provided, so they are
    // dropped outright — not even as unresolved text, on the same argument as
    // isPlatformName: "retrieve force:slds from an org" is nonsense.
    // MODULE is the LWC noun and the rest are Aura nouns; the other bundle type is
    // still tried second because either kind can sit behind the same reference.
    for (const m of problem.matchAll(/[Nn]o (MODULE|COMPONENT|APPLICATION|INTERFACE|EVENT) named markup:\/\/([A-Za-z0-9_]{1,40}):([A-Za-z0-9_]{1,80}) found/g)) {
      if (m[2].toLowerCase() !== 'c') continue;
      const lwc = { type: 'LightningComponentBundle', name: m[3] };
      const aura = { type: 'AuraDefinitionBundle', name: m[3] };
      candidates.push({ display: m[3], tries: m[1] === 'MODULE' ? [lwc, aura] : [aura, lwc] });
    }
    // A FlexiPage region holding a component the org can't describe:
    // "We couldn't retrieve the design time component information for component c:myCmp."
    // The apostrophe in "couldn't" arrives curly in some renderings, so the match
    // starts at the stable tail of the sentence rather than at the contraction.
    // Namespace rule as above: only `c` is local. The name is sentence-final here
    // too, so it carries the same two guards as the QuickAction rule — refuse a
    // truncated prefix, but keep matching the real message's closing period.
    for (const m of problem.matchAll(/design[ -]?time component information for component ([A-Za-z0-9_]{1,40}):([A-Za-z0-9_]{1,80})(?![A-Za-z0-9_\-])(?!\.[A-Za-z0-9_])/gi)) {
      if (m[1].toLowerCase() !== 'c') continue;
      candidates.push({
        display: m[2],
        tries: [{ type: 'LightningComponentBundle', name: m[2] }, { type: 'AuraDefinitionBundle', name: m[2] }]
      });
    }
    // A Flow calling an invocable action the org doesn't have:
    // "Get_Rows (Action) - We can't find the MyInvocable action. Verify that it's ..."
    // Flow builder text renders the apostrophe curly, hence the lax "can.?t". The
    // action may be Apex or an autolaunched Flow and the text never says which, so
    // both are tried — a lookup that misses can't mint a key.
    // The separator is written `\s*(?:-\s*)?We` and NOT `\s*-?\s*We`: two adjacent
    // unbounded `\s*` around an optional literal give the engine a fresh split of
    // every whitespace run to try whenever "We" doesn't follow, which is quadratic
    // — "(Action)" plus 100KB of spaces blocked the extension host for ~4.5s. This
    // form leaves exactly one way to consume a run.
    for (const m of problem.matchAll(/\(Action\)\s*(?:-\s*)?We can.?t find the ([A-Za-z0-9_]{1,80}) action/g)) {
      candidates.push({ display: m[1], tries: [{ type: 'ApexClass', name: m[1] }, { type: 'Flow', name: m[1] }] });
    }
    // A Flow screen embedding a component extension the org doesn't have:
    // Screen_1 (Screen Component) - We can't find an extension called "c:myCmp".
    // Same namespace rule as the markup:// rule — only `c` is local; a managed
    // package's extension is not something this workspace can deploy.
    for (const m of problem.matchAll(/We can.?t find an extension called ["“]([A-Za-z0-9_]{1,40}):([A-Za-z0-9_]{1,80})["”]/g)) {
      if (m[1].toLowerCase() !== 'c') continue;
      candidates.push({
        display: m[2],
        tries: [{ type: 'LightningComponentBundle', name: m[2] }, { type: 'AuraDefinitionBundle', name: m[2] }]
      });
    }
    // A Visualforce page whose controller isn't on the org (no trailing period in
    // the real text): "Apex class 'MyController' does not exist".
    for (const m of problem.matchAll(/Apex class '([A-Za-z0-9_]{1,80})' does not exist/gi)) {
      candidates.push({ display: `ApexClass:${m[1]}`, tries: [{ type: 'ApexClass', name: m[1] }] });
    }
    // A CustomObject <actionOverrides> naming a page the org can't use:
    // "Widget_Record_Page does not exist or is not a valid override for action View."
    // The sentence is a DISJUNCTION and the org never says which half fired: the
    // page may be absent, or present-but-invalid for that override (wrong page
    // type, missing formFactor). Deploying the local copy is a plausible fix on
    // BOTH branches — that is why the not-missing branch doesn't disqualify the
    // rule — but it does mean a suggestion here can name a page the org already
    // has. Suggestions are opt-in checkboxes, so that costs a glance, not a deploy.
    // The text doesn't say which KIND of page either, so FlexiPage and ApexPage are
    // both tried; the action name that follows is a standard action, not a
    // component, so it is matched for anchoring only and never captured.
    // The name opens the message, so nothing anchors its LEFT side — and envelope
    // flattening can put prose in front of it. Without the lookbehind, matchAll
    // simply slides right and captures a SUFFIX: an over-long name yields its last
    // 80 characters instead of being refused, and "Legacy-Widget_Record_Page"
    // yields "Widget_Record_Page" — a real local item the org never named. Starting
    // mid-token must refuse, not slide.
    for (const m of problem.matchAll(/(?<![A-Za-z0-9_.\-])([A-Za-z0-9_]{1,80}) does not exist or is not a valid override for action/g)) {
      candidates.push({ display: m[1], tries: [{ type: 'FlexiPage', name: m[1] }, { type: 'ApexPage', name: m[1] }] });
    }
    // The retrieve-side generic, and the only message that names the type itself:
    // "Entity of type 'LightningComponentBundle' named 'myCmp' cannot be found".
    // The quotes bound both captures, so the type token goes straight into the
    // lookup. The name may carry spaces and dots (a Layout fullName does), so it
    // reuses the bounded word shape of the "no X named Y found" rule above — same
    // per-word caps, same refusal to cross a newline.
    for (const m of problem.matchAll(/Entity of type '([A-Za-z0-9_]{1,60})' named '([\w.\-/]{1,120}(?: [\w.\-/]{1,60}){0,5})' cannot be found/g)) {
      candidates.push({ display: `${m[1]}:${m[2]}`, tries: [{ type: m[1], name: m[2] }] });
    }
  }

  const seen = new Set<string>();
  const seenUnresolved = new Set<string>();
  const keys: string[] = [];
  const unresolved: string[] = [];

  const addUnresolved = (text: string, referent?: string): void => {
    if (unresolved.length >= UNRESOLVED_MAX) return;
    // A platform type is not a missing component, and with only UNRESOLVED_MAX
    // slots the noise would crowd out the custom one that matters.
    if (referent !== undefined && isPlatformName(referent)) return;
    const clean = sanitizeUnresolved(text);
    if (!clean || seenUnresolved.has(clean)) return;
    seenUnresolved.add(clean);
    unresolved.push(clean);
  };

  for (const c of candidates) {
    let item: MetadataItem | undefined;
    if (c.tries) {
      for (const t of c.tries) {
        item = byExact.get(`${t.type}:${t.name}`) ?? byCiName.get(`${t.type}:${t.name.toLowerCase()}`);
        if (item) break;
      }
    } else if (c.bareName) {
      // A field is scanned as `CustomField:Object.Field`, so match on the segment
      // after the dot; a static class reference reports as "Variable does not
      // exist" too, hence ApexClass by exact name. EXACTLY ONE hit is required —
      // two objects with the same field name must never be guessed between.
      // Uniqueness is judged over ALL local matches, not just the ones not already
      // deploying: a name whose only matches are already in this deploy is NOT
      // "missing from your workspace", and the shared tail below drops it via
      // deployedKeys. Filtering first would have reported it as not-found.
      const hits = byBareName.get(c.bareName.toLowerCase()) ?? [];
      if (hits.length === 1) {
        item = hits[0];
      } else if (hits.length > 1) {
        const fresh = hits.filter(h => !deployedKeys.has(`${h.type}:${h.name}`));
        if (fresh.length === 0) continue; // every candidate is already deploying
        if (fresh.length === 1) {
          item = fresh[0];
        } else {
          // Ambiguous: name the candidates so the user picks, rather than adding
          // the wrong object's field to their deploy.
          addUnresolved(`${c.display} (ambiguous: ${describeCandidates(fresh)})`, c.display);
          continue;
        }
      }
    }
    if (!item) {
      addUnresolved(c.display, c.display); // the error text alone is never trusted to mint a key
      continue;
    }
    const key = `${item.type}:${item.name}`; // canonical casing from the ITEM, never the error text
    if (deployedKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return { keys, unresolved };
}

/** One suggestion candidate for the failure card: the missing component plus the
 *  failing component whose error text named it. */
export interface SuggestionCandidateInfo {
  key: string;
  from?: string;
}

/**
 * Per-failure-row suggestion candidates for the card's "Try with dependencies"
 * view — the row-level counterpart of detectMissingDependencies, so each
 * suggestion can be shown NEXT TO the error that caused it. Same security
 * invariant (a candidate key always names a real scanned item), same
 * deployedKeys exclusion. Deduped by key, first-seen order; capped so a
 * pathological failure can't render hundreds of checkboxes.
 */
export const SUGGESTION_CANDIDATES_MAX = 20;

export function buildSuggestionCandidates(
  failures: Array<{ from?: string; problem?: string }>,
  items: MetadataItem[],
  deployedKeys: Set<string>
): SuggestionCandidateInfo[] {
  const seen = new Set<string>();
  const out: SuggestionCandidateInfo[] = [];
  for (const f of failures) {
    if (!f.problem) continue;
    const deps = detectMissingDependencies([f.problem], items, deployedKeys);
    for (const key of deps.keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      // `from` carries the failing component's org-reported fullName — the one
      // org-controlled field the suggestion path persists. Same bounds as the
      // unresolved report: control characters flattened, length capped.
      const from = f.from ? sanitizeUnresolved(f.from) : undefined;
      out.push({ key, ...(from ? { from } : {}) });
      if (out.length >= SUGGESTION_CANDIDATES_MAX) return out;
    }
  }
  return out;
}

/**
 * Union a failed deploy's own key set with the branch's changed components, for
 * the "Retry + changed vs branch" card button (panelProvider's
 * retryDeployChanged handler). Pure item-model logic, kept here so the contract
 * is directly testable without the provider:
 * - `retryKeys` lead and are never filtered — they already passed one deploy's
 *   resolution, and dropping one here would silently shrink the retry.
 * - a changed key is added only when it's in `deployableKeys` (components with
 *   LOCAL SOURCE — items with a filePath, mirroring runDeploy's orgOnlySkipped
 *   split): the Changed computation can name org-only components, and
 *   `--metadata` can't deploy what has no local file. This also keeps the
 *   security invariant — a key that never matched a scanned workspace item can't
 *   enter the deploy set through this path.
 * - both sides are deduped; first-seen order is preserved (retry keys first,
 *   then the additions in `changedKeys` order) so the confirm modal and the
 *   result card list the original set before the branch's extras.
 * - `capped` reports that the ADDITION exceeds `cap`. The caller must refuse to
 *   deploy a capped result (a set that size is a release promotion that belongs
 *   in a reviewable manifest, not a one-click retry); `added` is still returned
 *   in full so the refusal can state the real count.
 */
export function mergeChangedKeys(
  retryKeys: string[],
  changedKeys: string[],
  deployableKeys: Set<string>,
  cap: number
): { keys: string[]; added: string[]; capped: boolean } {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const k of retryKeys) {
    if (seen.has(k)) continue;
    seen.add(k);
    keys.push(k);
  }
  const added: string[] = [];
  for (const k of changedKeys) {
    if (seen.has(k) || !deployableKeys.has(k)) continue;
    seen.add(k);
    added.push(k);
    keys.push(k);
  }
  return { keys, added, capped: added.length > cap };
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

async function isDirectory(p: string): Promise<boolean> {
  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
}

/** Whether any file under `dir` matches `exts` — returns at the first hit, so a
 *  positive answer costs far less than a full walk. Same skip/depth bounds. */
async function hasFileMatching(dir: string, exts: string[]): Promise<boolean> {
  const walk = async (d: string, depth: number): Promise<boolean> => {
    if (depth > MAX_SCAN_DEPTH) return false;
    let entries: import('fs').Dirent[];
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      if (e.isFile()) { if (matchExt(e.name, exts)) return true; }
      else if (e.isDirectory() && !shouldSkipDir(e.name) && (await walk(path.join(d, e.name), depth + 1))) return true;
    }
    return false;
  };
  return walk(dir, 0);
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
