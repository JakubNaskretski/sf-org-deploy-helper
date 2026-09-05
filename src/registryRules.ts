import * as fs from 'fs/promises';
import * as path from 'path';
import { FolderRule } from './metadataScanner';

/**
 * Folder rules read straight from the sf CLI's bundled metadata registry
 * (@salesforce/source-deploy-retrieve's metadataRegistry.json). One file read
 * covers every "default-shaped" type — one `<name>.<suffix>-meta.xml` per
 * component, flat in `<directoryName>/` — which is most of the ~500 types the
 * CLI knows. Before, each such folder cost a `sf project generate manifest`
 * spawn and lived in a 7-day cache. Bundles, mixed-content, decomposed and
 * folder types keep the static rules; anything this file doesn't settle still
 * goes through the CLI-manifest fallback, and no CLI on PATH changes nothing.
 */

const REGISTRY_REL = ['node_modules', '@salesforce', 'source-deploy-retrieve', 'lib', 'src', 'registry', 'metadataRegistry.json'];
/** Type names and suffixes later feed `--metadata Type:Name` argv and file globs. */
const TOKEN = /^[A-Za-z0-9_]+$/;
// Needs at least one alphanumeric, so `.` / `..` can never become a folder.
const DIR_TOKEN = /^(?=.*[A-Za-z0-9])[A-Za-z0-9_.-]+$/;
const MAX_WALK_UP = 6;

/** Find the registry via the `sf` on PATH: realpath the binary (npm/Homebrew
 *  symlink → `<cli>/bin/run.js`, installer → `<cli>/bin/sf`, Windows → the
 *  `sf.cmd` shim in the npm prefix), then walk up looking for the SDR package
 *  either hoisted beside the CLI package or nested under it. */
export async function locateRegistry(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const names = process.platform === 'win32' ? ['sf.cmd', 'sf'] : ['sf'];
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      let real: string;
      try { real = await fs.realpath(path.join(dir, name)); } catch { continue; }
      let cur = path.dirname(real);
      for (let i = 0; i < MAX_WALK_UP; i++) {
        for (const cand of [path.join(cur, ...REGISTRY_REL), path.join(cur, 'node_modules', '@salesforce', 'cli', ...REGISTRY_REL)]) {
          try { await fs.access(cand); return cand; } catch { /* next candidate */ }
        }
        const up = path.dirname(cur);
        if (up === cur) break;
        cur = up;
      }
    }
  }
  return undefined;
}

interface RegistryType {
  name?: unknown;
  directoryName?: unknown;
  suffix?: unknown;
  inFolder?: unknown;
  strategies?: unknown;
  children?: unknown;
}

/** Pure: registry JSON → rules for the default-shaped types. `staticFolders`
 *  are skipped (the static rule knows the shape better, e.g. bundles/objects).
 *  Shape- and charset-guarded: the file is local and trusted, but its values
 *  become paths and argv, so a malformed entry degrades to "no rule". */
export function rulesFromRegistry(registry: unknown, staticFolders: ReadonlySet<string>): FolderRule[] {
  const r = registry as { types?: Record<string, RegistryType>; childTypes?: Record<string, unknown> } | null;
  if (!r || typeof r !== 'object' || !r.types || typeof r.types !== 'object') return [];
  const childIds = new Set(Object.keys(r.childTypes && typeof r.childTypes === 'object' ? r.childTypes : {}));
  const out: FolderRule[] = [];
  const seen = new Set<string>();
  for (const [id, t] of Object.entries(r.types)) {
    if (!t || typeof t !== 'object' || childIds.has(id)) continue;
    const { name, directoryName, suffix } = t;
    // Default adapter only. Bundles (lwc), mixedContent (staticresources),
    // matchingContentFile (classes), decomposed (objects) and folder types
    // (reports) have other shapes. A parent with children but no strategy
    // (AssignmentRules, MatchingRules, SharingRules, EscalationRules…) is still
    // ONE `<name>.<suffix>-meta.xml` — the children are elements inside it.
    const adapter = (t.strategies as { adapter?: unknown } | undefined)?.adapter;
    if ((t.strategies && adapter !== 'default') || t.inFolder) continue;
    if (typeof name !== 'string' || typeof directoryName !== 'string' || typeof suffix !== 'string') continue;
    if (!TOKEN.test(name) || !DIR_TOKEN.test(directoryName) || !TOKEN.test(suffix)) continue;
    if (staticFolders.has(directoryName)) continue;
    // Several types can share a folder with different suffixes (wave/, email/);
    // each gets its own rule. Same folder + same suffix keeps the first.
    const key = `${directoryName}/${suffix}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ folder: directoryName, type: name, primaryExt: [`.${suffix}-meta.xml`] });
  }
  return out;
}

/** Folders the registry KNOWS cannot yield a per-file rule — folder-based
 *  types (documents), bundles, mixed/matching content, decomposed types — keyed
 *  by directoryName → type name. The scanner uses this to skip the CLI call
 *  that could only fail, and to tell the user the honest reason. Static
 *  folders are excluded (they have their own shape rules). */
export function nonDerivableFolders(registry: unknown, staticFolders: ReadonlySet<string>): Map<string, string> {
  const r = registry as { types?: Record<string, RegistryType>; childTypes?: Record<string, unknown> } | null;
  const out = new Map<string, string>();
  if (!r || typeof r !== 'object' || !r.types || typeof r.types !== 'object') return out;
  const childIds = new Set(Object.keys(r.childTypes && typeof r.childTypes === 'object' ? r.childTypes : {}));
  for (const [id, t] of Object.entries(r.types)) {
    if (!t || typeof t !== 'object' || childIds.has(id)) continue;
    const { name, directoryName } = t;
    if (typeof name !== 'string' || typeof directoryName !== 'string' || !TOKEN.test(name) || !DIR_TOKEN.test(directoryName)) continue;
    if (staticFolders.has(directoryName)) continue;
    const adapter = (t.strategies as { adapter?: unknown } | undefined)?.adapter;
    const derivable = !(t.strategies && adapter !== 'default') && !t.inFolder;
    if (!derivable && !out.has(directoryName)) out.set(directoryName, name);
  }
  return out;
}

let cached: { registryPath: string | undefined; rules: FolderRule[]; nonDerivable: Map<string, string> } | undefined;

/** Session cache: explicit scans pass `refresh` (a CLI upgrade lands without a
 *  reload), silent rescans reuse. Any failure — no CLI, unreadable or malformed
 *  file — yields no rules, never an error: the scan then behaves exactly as
 *  before this module existed. */
export async function loadRegistryRules(staticFolders: ReadonlySet<string>, opts: { refresh?: boolean } = {}): Promise<FolderRule[]> {
  if (cached && !opts.refresh) return cached.rules;
  let registryPath: string | undefined;
  let rules: FolderRule[] = [];
  let nonDerivable = new Map<string, string>();
  try {
    registryPath = await locateRegistry();
    if (registryPath) {
      const registry: unknown = JSON.parse(await fs.readFile(registryPath, 'utf8'));
      rules = rulesFromRegistry(registry, staticFolders);
      nonDerivable = nonDerivableFolders(registry, staticFolders);
    }
  } catch {
    rules = [];
    nonDerivable = new Map();
  }
  cached = { registryPath, rules, nonDerivable };
  return rules;
}

/** Where the rules came from, for the output channel. */
export function registryRulesSource(): string | undefined {
  return cached?.registryPath;
}

/** directoryName → type for folders the registry says can't yield a per-file
 *  rule (empty until loadRegistryRules ran, or when no CLI was found). */
export function registryNonDerivable(): ReadonlyMap<string, string> {
  return cached?.nonDerivable ?? new Map();
}
