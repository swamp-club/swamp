// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import { relative, resolve, SEPARATOR } from "@std/path";
import { resolveLocalImports } from "../models/local_import_resolver.ts";
import { isPulledExtensionPath } from "./extension_precedence.ts";

/**
 * declared domain-local to keep the domain-to-infrastructure boundary; must
 * stay in sync with the ExtensionKind union on ExtensionTypeRow
 */
export type FreshnessKind =
  | "model"
  | "extension"
  | "vault"
  | "datastore"
  | "report"
  | "webhook";

export interface FreshnessCatalogRow {
  source_path: string;
  source_fingerprint?: string;
  bundle_path?: string;
  type_normalized?: string;
  kind?: FreshnessKind;
  /**
   * vestigial: the row migrated to state; kept on the type for tests that still
   * assert on it, and production reads state === 'ValidationFailed'
   */
  validation_failed?: boolean;
  /**
   * findStaleFiles skips rebundling rows with state ValidationFailed (the
   * rebundle-loop guard); optional so legacy fixtures default to Indexed via
   * mapRow
   */
  state?: string;
}

/**
 * distinguishes fresh bundles from cache fallbacks so callers can decide
 * whether to advance the catalog fingerprint; trusted-pulled reused an on-disk
 * bundle, rebundle-failed reused the previous one
 */
export type BundleResult =
  | { readonly js: string; readonly fromCache: false }
  | {
    readonly js: string;
    readonly fromCache: true;
    readonly cacheReason: "trusted-pulled";
  }
  | {
    readonly js: string;
    readonly fromCache: true;
    readonly cacheReason: "fresh-indexed";
  }
  | {
    readonly js: string;
    readonly fromCache: true;
    readonly cacheReason: "rebundle-failed";
    readonly expectedFailure: boolean;
  };

/**
 * dedups file hashing and dependency resolution within one buildIndex pass,
 * where the filesystem does not change; discard it afterwards
 */
export interface FreshnessCache {
  fileHash: Map<string, Promise<string>>;
  resolvedDeps: Map<string, Promise<string[]>>;
}

export function createFreshnessCache(): FreshnessCache {
  return {
    fileHash: new Map(),
    resolvedDeps: new Map(),
  };
}

export interface StaleFile {
  absolutePath: string;
  relativePath: string;
  baseDir: string;
}

export interface TypelessRow extends StaleFile {
  row: FreshnessCatalogRow;
}

export interface FreshnessScan {
  stale: StaleFile[];
  removed: FreshnessCatalogRow[];
  typeless: TypelessRow[];
}

/**
 * stands in for a hash when a transitive dep is unreadable, so a stable broken
 * state gives a stable fingerprint and repairing it invalidates; cannot collide
 * with a hex hash
 */
const UNREADABLE_PLACEHOLDER = "MISSING";

/** a longer module list is neither written nor read back */
export const MAX_SOURCE_MODULES = 10_000;

export interface SourceModuleLookup {
  findSourceModules(sourcePath: string): readonly string[] | undefined;
}

/**
 * a source with no recorded modules falls back to relative imports within
 * boundaryDir, as pulled extensions with pre-built bundles are fingerprinted. A
 * recorded list stays valid until the source changes.
 */
export async function computeSourceFingerprint(
  absolutePath: string,
  boundaryDir: string,
  modules: SourceModuleLookup,
  cache?: FreshnessCache,
): Promise<string> {
  const recorded = modules.findSourceModules(absolutePath);
  const files = recorded
    ? [absolutePath, ...recorded]
    : await resolveDeps(absolutePath, boundaryDir, cache);
  return await fingerprintSourceModules(files, boundaryDir, cache);
}

/**
 * sha-256 over sorted {relPath}:{sha256(content)} entries relative to
 * boundaryDir, so content or file-set changes alter it; unreadable files get a
 * stable placeholder instead of throwing
 */
async function fingerprintSourceModules(
  files: readonly string[],
  boundaryDir: string,
  cache?: FreshnessCache,
): Promise<string> {
  const entries: string[] = [];
  for (const file of new Set(files)) {
    const relPath = relative(boundaryDir, file);
    let fileHash: string;
    try {
      fileHash = await hashFile(file, cache);
    } catch {
      fileHash = UNREADABLE_PLACEHOLDER;
    }
    entries.push(`${relPath}:${fileHash}`);
  }
  entries.sort();

  const composed = new TextEncoder().encode(entries.join("\n"));
  const digest = await crypto.subtle.digest("SHA-256", composed);
  return toHex(digest);
}

async function resolveDeps(
  entryPoint: string,
  boundaryDir: string,
  cache?: FreshnessCache,
): Promise<string[]> {
  if (cache) {
    const existing = cache.resolvedDeps.get(entryPoint);
    if (existing) return await existing;
    const pending = resolveLocalImports([entryPoint], boundaryDir).then(
      (r) => r.resolvedFiles,
    );
    cache.resolvedDeps.set(entryPoint, pending);
    return await pending;
  }
  const { resolvedFiles } = await resolveLocalImports(
    [entryPoint],
    boundaryDir,
  );
  return resolvedFiles;
}

export async function hashFile(
  path: string,
  cache?: FreshnessCache,
): Promise<string> {
  if (cache) {
    const existing = cache.fileHash.get(path);
    if (existing) return await existing;
    const pending = (async () => {
      const bytes = await Deno.readFile(path);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return toHex(digest);
    })();
    cache.fileHash.set(path, pending);
    return await pending;
  }
  const bytes = await Deno.readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(digest);
}

function toHex(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, "0");
  }
  return out;
}

export interface FreshnessCatalog extends SourceModuleLookup {
  findByKind(kind: FreshnessKind): FreshnessCatalogRow[];
  removeByRawSourcePath(rawSourcePath: string): void;
  deleteSourceModules(sourcePath: string): void;
  /**
   * whether the list recorded for sourcePath is the fallback walk, recorded
   * after a good bundle whose module graph could not be read, and the graph has
   * not been retried yet
   */
  isSourceGraphPending(sourcePath: string): boolean;
}

export interface FindStaleFilesParams {
  modelsDir: string;
  additionalDirs?: string[];
  catalog: FreshnessCatalog;
  discoverFiles: (dir: string) => Promise<string[]>;
  /**
   * each loader passes its own kinds so findStaleFiles considers only rows it
   * owns; the models loader passes model and extension, siblings pass
   * singletons
   */
  kinds: FreshnessKind[];
  /**
   * when given, a local (non-pulled) source with no recorded modules is stale,
   * so a bundle an earlier binary built is rebuilt once and its modules
   * recorded
   */
  repoDir?: string;
}

/**
 * a source is fresh only when its state is Indexed; an absent state is not
 * fresh, as the source needs indexing
 */
export function isFresh(state: string | undefined): boolean {
  return state === "Indexed";
}

/**
 * rows in these states are kept even when their source is not seen, so the
 * failure stays visible
 */
export const CATALOG_FAILURE_STATES: ReadonlySet<string> = new Set([
  "BundleBuildFailed",
  "EntryPointUnreadable",
  "OrphanedBundleOnly",
]);

export async function findStaleFiles(
  params: FindStaleFilesParams,
): Promise<StaleFile[]> {
  return (await scanCatalogFreshness(params)).stale;
}

export async function scanCatalogFreshness(
  params: FindStaleFilesParams,
): Promise<FreshnessScan> {
  const { modelsDir, additionalDirs, catalog, discoverFiles, kinds, repoDir } =
    params;
  const stale: StaleFile[] = [];
  const typeless: TypelessRow[] = [];
  const cache = createFreshnessCache();

  const allDirs = [modelsDir, ...(additionalDirs ?? [])];

  const catalogEntries = kinds.flatMap((k) => catalog.findByKind(k));
  const catalogBySource = new Map<string, FreshnessCatalogRow>();
  for (const entry of catalogEntries) {
    catalogBySource.set(normalizeFreshnessPath(entry.source_path), entry);
  }

  const seenSources = new Set<string>();

  for (const dir of allDirs) {
    try {
      await Deno.stat(dir);
    } catch {
      continue;
    }

    const files = await discoverFiles(dir);
    for (const relativePath of files) {
      const absolutePath = resolve(dir, relativePath);
      seenSources.add(normalizeFreshnessPath(absolutePath));

      const catalogEntry = catalogBySource.get(
        normalizeFreshnessPath(absolutePath),
      );
      if (!catalogEntry) {
        stale.push({ absolutePath, relativePath, baseDir: dir });
        continue;
      }

      try {
        const fingerprint = await computeSourceFingerprint(
          absolutePath,
          dir,
          catalog,
          cache,
        );
        if (fingerprint !== catalogEntry.source_fingerprint) {
          stale.push({ absolutePath, relativePath, baseDir: dir });
          continue;
        }

        // a fingerprint without recorded modules covers only relative imports
        // inside dir, as does a fallback until its one retry; pulled sources
        // are not forced stale since their pre-built bundles may record nothing
        if (
          repoDir !== undefined &&
          !isPulledExtensionPath(
            normalizeFreshnessPath(absolutePath),
            normalizeFreshnessPath(resolve(repoDir)),
          ) &&
          (catalog.findSourceModules(absolutePath) === undefined ||
            catalog.isSourceGraphPending(absolutePath))
        ) {
          stale.push({ absolutePath, relativePath, baseDir: dir });
          continue;
        }

        // a transient BundleBuildFailed must not be pinned as a
        // fingerprint-matched cache hit, so it is retried next scan;
        // ValidationFailed is deterministic and stays excluded below
        if (catalogEntry.state === "BundleBuildFailed") {
          stale.push({ absolutePath, relativePath, baseDir: dir });
          continue;
        }

        if (
          catalogEntry.bundle_path &&
          catalogEntry.state !== "ValidationFailed" &&
          !(await bundleExists(catalogEntry.bundle_path))
        ) {
          stale.push({ absolutePath, relativePath, baseDir: dir });
          continue;
        }

        if (
          (catalogEntry.state ?? "Indexed") === "Indexed" &&
          !catalogEntry.type_normalized &&
          catalogEntry.kind !== "extension"
        ) {
          typeless.push({
            absolutePath,
            relativePath,
            baseDir: dir,
            row: catalogEntry,
          });
        }
      } catch {
        stale.push({ absolutePath, relativePath, baseDir: dir });
      }
    }
  }

  const removed = removeUnseenCatalogRows(
    catalog,
    catalogEntries,
    seenSources,
  );

  return { stale, removed, typeless };
}

export function normalizeFreshnessPath(path: string): string {
  return SEPARATOR === "\\" ? path.toLowerCase().replaceAll("\\", "/") : path;
}

/**
 * collects the normalized absolute paths of every source file the loader's
 * discovery finds under dirs; the cold path uses it to apply the same
 * unseen-row removal as the warm path
 */
export async function collectSeenSources(
  dirs: readonly string[],
  discoverFiles: (dir: string) => Promise<string[]>,
): Promise<Set<string>> {
  const seen = new Set<string>();
  for (const dir of dirs) {
    try {
      await Deno.stat(dir);
    } catch {
      continue;
    }
    for (const relativePath of await discoverFiles(dir)) {
      seen.add(normalizeFreshnessPath(resolve(dir, relativePath)));
    }
  }
  return seen;
}

/**
 * Deletes each of `rows` whose source was not seen in any scanned dir,
 * keeping rows in a failure state so the failure stays visible. Deletes
 * by the raw stored path. Returns the deleted rows.
 */
export function removeUnseenCatalogRows(
  catalog: FreshnessCatalog,
  rows: readonly FreshnessCatalogRow[],
  seenSources: ReadonlySet<string>,
): FreshnessCatalogRow[] {
  const removed: FreshnessCatalogRow[] = [];
  for (const entry of rows) {
    if (seenSources.has(normalizeFreshnessPath(entry.source_path))) continue;
    if (CATALOG_FAILURE_STATES.has(entry.state ?? "Indexed")) continue;
    catalog.removeByRawSourcePath(entry.source_path);
    catalog.deleteSourceModules(entry.source_path);
    removed.push(entry);
  }
  return removed;
}

async function bundleExists(bundlePath: string): Promise<boolean> {
  try {
    await Deno.stat(bundlePath);
    return true;
  } catch {
    return false;
  }
}
