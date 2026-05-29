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

interface FolderRule {
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
  { folder: 'email', type: 'EmailTemplate', primaryExt: ['.email'], metaSuffix: '.email-meta.xml', nested: true },
];

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

export async function scanWorkspace(): Promise<{ items: MetadataItem[]; root?: string; warning?: string }> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return { items: [], warning: 'No workspace folder open.' };
  }
  const root = folders[0].uri.fsPath;
  const pkgDirs = await resolvePackageDirs(root);
  const items: MetadataItem[] = [];
  for (const pkg of pkgDirs) {
    const defaultDir = path.join(root, pkg, 'main', 'default');
    if (!(await pathExists(defaultDir))) continue;
    for (const rule of RULES) {
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
  return { items: deduped, root };
}

/** Find the workspace metadata item that owns the given absolute file path, if any. */
export function findItemForPath(items: MetadataItem[], absPath: string): MetadataItem | undefined {
  const normalized = path.normalize(absPath);
  // Prefer exact file match first
  let match = items.find(i => i.files.some(f => path.normalize(f) === normalized));
  if (match) return match;
  // Then containing bundle/folder
  match = items.find(i => normalized.startsWith(path.normalize(i.filePath) + path.sep) || path.normalize(i.filePath) === normalized);
  return match;
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
