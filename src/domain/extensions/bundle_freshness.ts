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
  | "datastore"
  | "report"
  | "webhook";

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
  /** The type the row claims; empty when it claims none. */
  type_normalized?: string;
  kind?: FreshnessKind;
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
 *
 * A cached result carries why it came from cache:
 * - `trusted-pulled` — a pulled extension's on-disk bundle was reused
 *   without attempting a rebundle. Nothing failed.
 * - `rebundle-failed` — `deno bundle` threw and the previous bundle was
 *   reused. `bundleWithCache` has already logged the failure: at warn when
 *   it was unexpected, at debug when `expectedFailure` is true.
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
    readonly cacheReason: "rebundle-failed";
    readonly expectedFailure: boolean;
  };

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

/** A seen source whose Indexed catalog row claims no type. */
export interface TypelessRow extends StaleFile {
  row: FreshnessCatalogRow;
}

/** Everything one warm-path scan of the source dirs found. */
export interface FreshnessScan {
  /** Sources that need rebundling. */
  stale: StaleFile[];
  /** Rows deleted because their source was not seen in any scanned dir. */
  removed: FreshnessCatalogRow[];
  /**
   * Seen sources of a primary (non-extension) kind whose Indexed row
   * claims no type and is not already stale — candidates for the
   * loader's typeless-row heal (swamp-club#2490).
   */
  typeless: TypelessRow[];
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
 * The most local modules the catalog records for one source. A longer
 * list is neither written nor read back (swamp-club#3487).
 */
export const MAX_SOURCE_MODULES = 10_000;

/**
 * Where {@link computeSourceFingerprint} finds the local modules a source
 * was last bundled from. The extension catalog records them from the
 * entry point's module graph each time it is bundled (swamp-club#3385).
 */
export interface SourceModuleLookup {
  /**
   * The local modules recorded for `sourcePath`, or `undefined` when none
   * are recorded.
   */
  findSourceModules(sourcePath: string): readonly string[] | undefined;
}

/**
 * Computes a content-based fingerprint covering an entry point and every
 * local module it was bundled from.
 *
 * The modules are the ones `modules` recorded for the entry point from its
 * module graph, wherever they live and however they are imported. A
 * source with no recorded modules falls back to the relative imports
 * resolveLocalImports finds within `boundaryDir`, which is how pulled
 * extensions, whose bundles ship pre-built, are fingerprinted.
 *
 * A recorded list stays valid until the source changes: a relative import
 * can only reach a new module if a recorded module's content changes or a
 * recorded missing module appears, and either changes the fingerprint.
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
 * The sha-256 over a sorted list of `{relPath}:{sha256(content)}` entries,
 * one per distinct file, with paths relative to `boundaryDir`. It changes
 * when either the content of any file changes, or when the file set
 * changes (rename, add, remove).
 *
 * Unreadable files produce a stable placeholder entry instead of
 * throwing, so a stable broken state yields a stable fingerprint (#208).
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
export interface FreshnessCatalog extends SourceModuleLookup {
  findByKind(kind: FreshnessKind): FreshnessCatalogRow[];
  /** Deletes the row stored at exactly this (un-canonicalized) path. */
  removeByRawSourcePath(rawSourcePath: string): void;
  /** Forgets the local modules recorded for `sourcePath`. */
  deleteSourceModules(sourcePath: string): void;
  /**
   * Whether the list recorded for `sourcePath` is the fallback walk,
   * recorded after a good bundle whose module graph could not be read,
   * and the graph has not been retried yet (swamp-club#3487).
   */
  isSourceGraphPending(sourcePath: string): boolean;
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
   * (["report"], ["datastore"], etc.).
   */
  kinds: FreshnessKind[];
  /**
   * The repository root. When given, a local (non-pulled) source with no
   * recorded modules is stale, so a bundle an earlier binary built is
   * rebuilt once and its modules recorded (swamp-club#3385).
   */
  repoDir?: string;
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
 * Catalog row states that record a failure. {@link findStaleFiles} keeps
 * rows in these states even when their source is no longer seen, so the
 * failure stays visible.
 */
export const CATALOG_FAILURE_STATES: ReadonlySet<string> = new Set([
  "BundleBuildFailed",
  "EntryPointUnreadable",
  "OrphanedBundleOnly",
]);

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
  return (await scanCatalogFreshness(params)).stale;
}

/**
 * {@link findStaleFiles}, also reporting the rows it removed and the
 * seen typeless rows, which the loader needs for bundle eviction and the
 * typeless-row heal (swamp-club#2490).
 */
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

        // A fingerprint without recorded modules only covers the relative
        // imports inside `dir`, and so does a fallback recorded when the
        // module graph could not be read, until its one retry
        // (swamp-club#3487). Pulled sources with no recorded modules are
        // not forced stale: they may be served a pre-built bundle that
        // records nothing.
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

/**
 * Normalizes a source path for {@link scanCatalogFreshness}'s seen-set
 * comparisons: lowercase with forward slashes on Windows, unchanged on
 * POSIX.
 */
export function normalizeFreshnessPath(path: string): string {
  return SEPARATOR === "\\" ? path.toLowerCase().replaceAll("\\", "/") : path;
}

/**
 * Collects the normalized absolute paths of every source file the
 * loader's discovery finds under `dirs`. The cold path uses it to apply
 * the same unseen-row removal as the warm path (swamp-club#2490).
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
