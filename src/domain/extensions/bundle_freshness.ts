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

/**
 * The extension-catalog kinds this helper can query. Declared
 * domain-local so the freshness check does not import ExtensionKind
 * from the infrastructure catalog store — matches the inline pattern
 * of FreshnessCatalogRow below and preserves the
 * domain→infrastructure boundary rule.
 *
 * Must stay in sync with the ExtensionKind union on ExtensionTypeRow;
 * the infrastructure row type structurally satisfies this helper's
 * FreshnessCatalog interface.
 */
export type FreshnessKind =
  | "model"
  | "extension"
  | "vault"
  | "driver"
  | "datastore"
  | "report";

/**
 * Minimal row shape this module needs from the catalog. The concrete
 * ExtensionTypeRow in the infrastructure layer extends this; keeping
 * the dependency one-way (infrastructure knows the domain shape, not
 * vice versa) respects the domain→infrastructure boundary rule.
 */
export interface FreshnessCatalogRow {
  source_path: string;
  source_fingerprint?: string;
  bundle_path?: string;
  /**
   * Vestigial after W1a (issue swamp-club#211) — the row migrated to
   * the `state` field below. Preserved on the type for back-compat
   * with tests that still assert on it; production code reads
   * `state === 'ValidationFailed'` via {@link findStaleFiles}.
   */
  validation_failed?: boolean;
  /**
   * RowState tag (W1a). `findStaleFiles` checks
   * `state === 'ValidationFailed'` to skip rebundling rows that are
   * known schema-broken — the swamp-club#209 rebundle-loop guard.
   * Optional so legacy fixtures that omit it default to 'Indexed'
   * via {@link mapRow}.
   */
  state?: string;
}

/**
 * Return type for bundleWithCache across all extension loaders.
 * Distinguishes freshly-built bundles from stale cache fallbacks so
 * callers can decide whether to advance the catalog fingerprint.
 */
export interface BundleResult {
  readonly js: string;
  readonly fromCache: boolean;
}

/**
 * Per-invocation cache that dedups file hashing and transitive dep
 * resolution across multiple computeSourceFingerprint calls. Safe to
 * share within a single buildIndex pass — filesystem contents don't
 * change mid-pass. Discard after the pass finishes.
 *
 * Without this, a repo where N entry points share a common _lib/ of M
 * files ends up reading and hashing each shared file up to N times;
 * with it each path is read and hashed exactly once.
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

/**
 * A source file the caller must rebundle — its content no longer matches
 * the catalog's stored fingerprint, or the file is new to the catalog.
 */
export interface StaleFile {
  absolutePath: string;
  relativePath: string;
  baseDir: string;
}

/**
 * Placeholder emitted in place of a real sha-256 hex hash when a
 * transitive dep cannot be read (broken symlink, deleted file,
 * FilesystemLoop). Encodes "this dep is currently unreadable" into the
 * fingerprint so a stable broken state produces a stable fingerprint
 * and repairing the dep correctly invalidates it (#208). Cannot collide
 * with a real hash — contains non-hex characters.
 *
 * Internal to computeSourceFingerprint. No external code compares
 * against this value — ReconcileFromDisk handles broken-dep behavior
 * via the BundleBuildFailed RowState transition.
 */
const UNREADABLE_PLACEHOLDER = "MISSING";

/**
 * Computes a content-based fingerprint covering an entry point and every
 * local .ts file it transitively imports via relative paths.
 *
 * The fingerprint is sha-256 over a sorted list of
 * `{relPath}:{sha256(content)}` entries — so it changes when either the
 * content of any dep changes, or when the dep set changes (rename, add,
 * remove). Non-local imports (npm/jsr/etc.) are excluded because
 * resolveLocalImports stops at the boundary dir, matching the bundler's
 * own dependency scope.
 *
 * Unreadable deps produce a stable placeholder entry instead of
 * throwing, so a stable broken state yields a stable fingerprint (#208).
 */
export async function computeSourceFingerprint(
  absolutePath: string,
  boundaryDir: string,
  cache?: FreshnessCache,
): Promise<string> {
  const resolvedFiles = await resolveDeps(absolutePath, boundaryDir, cache);

  const entries: string[] = [];
  for (const file of resolvedFiles) {
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

async function hashFile(
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

/**
 * Minimal view of the catalog a freshness check needs.
 * Lets loaders pass their ExtensionCatalogStore without coupling this
 * module to every catalog method.
 */
export interface FreshnessCatalog {
  findByKind(kind: FreshnessKind): FreshnessCatalogRow[];
  removeBySourcePath(sourcePath: string): void;
}

export interface FindStaleFilesParams {
  /** The primary directory for local user extensions. */
  modelsDir: string;
  /** Additional directories — source dirs + pulled extension dirs. */
  additionalDirs?: string[];
  /** Catalog view for looking up stored fingerprints. */
  catalog: FreshnessCatalog;
  /** Discovers `.ts` files under a directory, returning repo-relative paths. */
  discoverFiles: (dir: string) => Promise<string[]>;
  /**
   * Catalog kinds to query. Each loader passes its own kind(s) so that
   * findStaleFiles only considers rows it owns. The models loader
   * passes ["model", "extension"] — models plus user-defined extensions
   * that target base models. Sibling loaders pass singletons
   * (["report"], ["driver"], etc.).
   */
  kinds: FreshnessKind[];
}

/**
 * W3 freshness query: a Source is fresh iff its RowState is `Indexed`.
 * All other states are not visible to type resolution. An absent state
 * (`undefined`) is NOT fresh — the source needs indexing.
 */
export function isFresh(state: string | undefined): boolean {
  return state === "Indexed";
}

/**
 * Warm-start incremental change detection. Walks source directories,
 * compares each file's current fingerprint against the catalog, and
 * returns files that need rebundling. Also removes catalog entries
 * whose source file has been deleted.
 *
 * Cold-start reconciliation is handled by ReconcileFromDisk (W3).
 * This function handles the warm-start path: catalog is populated,
 * a few files may have changed since the last run.
 */
export async function findStaleFiles(
  params: FindStaleFilesParams,
): Promise<StaleFile[]> {
  const { modelsDir, additionalDirs, catalog, discoverFiles, kinds } = params;
  const stale: StaleFile[] = [];
  const cache = createFreshnessCache();

  const allDirs = [modelsDir, ...(additionalDirs ?? [])];

  const needsNormalize = SEPARATOR === "\\";
  const normalizePath = (p: string): string =>
    needsNormalize ? p.toLowerCase().replaceAll("\\", "/") : p;

  const catalogEntries = kinds.flatMap((k) => catalog.findByKind(k));
  const catalogBySource = new Map<string, FreshnessCatalogRow>();
  for (const entry of catalogEntries) {
    catalogBySource.set(normalizePath(entry.source_path), entry);
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
      seenSources.add(normalizePath(absolutePath));

      const catalogEntry = catalogBySource.get(normalizePath(absolutePath));
      if (!catalogEntry) {
        stale.push({ absolutePath, relativePath, baseDir: dir });
        continue;
      }

      try {
        const fingerprint = await computeSourceFingerprint(
          absolutePath,
          dir,
          cache,
        );
        if (fingerprint !== catalogEntry.source_fingerprint) {
          stale.push({ absolutePath, relativePath, baseDir: dir });
          continue;
        }

        // A transient bundle-build failure must not be pinned as a satisfied
        // fingerprint-matched cache hit. Re-attempt on the next scan so a
        // later run (e.g. after network is restored) can succeed. Restricted
        // to BundleBuildFailed: ValidationFailed is deterministic — retrying
        // it only thrashes — and stays excluded below. The cold-start
        // ReconcileFromDisk path needs no change: a failed bundle leaves the
        // catalog populated, so daemon-restart recovery routes through this
        // warm path.
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
        }
      } catch {
        stale.push({ absolutePath, relativePath, baseDir: dir });
      }
    }
  }

  const FAILURE_STATES = new Set([
    "BundleBuildFailed",
    "EntryPointUnreadable",
    "OrphanedBundleOnly",
  ]);
  for (const [normalizedPath, entry] of catalogBySource) {
    if (!seenSources.has(normalizedPath)) {
      if (!FAILURE_STATES.has(entry.state ?? "Indexed")) {
        catalog.removeBySourcePath(entry.source_path);
      }
    }
  }

  return stale;
}

async function bundleExists(bundlePath: string): Promise<boolean> {
  try {
    await Deno.stat(bundlePath);
    return true;
  } catch {
    return false;
  }
}
