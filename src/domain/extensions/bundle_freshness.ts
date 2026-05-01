// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { relative, resolve } from "@std/path";
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
 * Sentinel emitted in place of a real sha-256 hex hash when a transitive
 * dep cannot be read (broken symlink, deleted file, FilesystemLoop). The
 * fingerprint then encodes "this dep is currently unreadable" as part of
 * the source state, so a stable broken state produces a stable
 * fingerprint instead of marking the entry permanently stale (#208).
 * Cannot collide with a real hash — "MISSING" contains non-hex
 * characters.
 */
const UNREADABLE_DEP_SENTINEL = "MISSING";

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
 * Unreadable deps (broken symlinks, deleted files, FilesystemLoop)
 * produce an UNREADABLE_DEP_SENTINEL entry instead of throwing — so a
 * stable broken state yields a stable fingerprint, and repairing the
 * dep correctly invalidates it (#208).
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
      fileHash = UNREADABLE_DEP_SENTINEL;
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
 * Walks all source directories, compares each file's current fingerprint
 * against the catalog-stored fingerprint, and returns the files that need
 * rebundling. Also removes catalog entries whose source file has been
 * deleted.
 *
 * A file is stale when —
 *   1. It is new (no catalog entry), or
 *   2. Its computed fingerprint differs from the catalog's, or
 *   3. Fingerprint computation fails (e.g. dep disappeared mid-scan).
 *
 * Previously this was mtime-based. mtime is fragile — atomic-rename
 * saves, rsync --times, and sub-millisecond edits can all leave the
 * source mtime <= catalog mtime while the content has changed. Content
 * fingerprint is strictly stronger.
 */
export async function findStaleFiles(
  params: FindStaleFilesParams,
): Promise<StaleFile[]> {
  const { modelsDir, additionalDirs, catalog, discoverFiles, kinds } = params;
  const stale: StaleFile[] = [];
  const cache = createFreshnessCache();

  const allDirs = [modelsDir, ...(additionalDirs ?? [])];

  const catalogEntries = kinds.flatMap((k) => catalog.findByKind(k));
  const catalogBySource = new Map<string, FreshnessCatalogRow>();
  for (const entry of catalogEntries) {
    catalogBySource.set(entry.source_path, entry);
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
      seenSources.add(absolutePath);

      const catalogEntry = catalogBySource.get(absolutePath);
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
        }
      } catch {
        // Defensive backstop only. computeSourceFingerprint is total
        // since #208 — unreadable transitive deps produce a sentinel
        // entry rather than throwing. Anything reaching this catch is
        // an unforeseen failure (Deno API change, crypto.subtle panic,
        // boundary-dir stat race). Force a rebundle so the error
        // surfaces to the user.
        stale.push({ absolutePath, relativePath, baseDir: dir });
      }
    }
  }

  for (const [sourcePath] of catalogBySource) {
    if (!seenSources.has(sourcePath)) {
      catalog.removeBySourcePath(sourcePath);
    }
  }

  return stale;
}

/**
 * Minimal write-side catalog view the validation-failure helper needs.
 * Same one-way domain→infrastructure boundary as FreshnessCatalog.
 */
export interface ValidationFailureCatalog {
  upsert(row: {
    source_path: string;
    type_normalized: string;
    kind: FreshnessKind;
    bundle_path: string;
    version: string;
    description: string;
    extends_type: string;
    source_mtime: string;
    source_fingerprint: string;
    validation_failed: boolean;
  }): void;
}

export interface MarkCatalogValidationFailedParams {
  catalog: ValidationFailureCatalog;
  sourcePath: string;
  kind: FreshnessKind;
  bundlePath: string;
  sourceMtime: string;
  sourceFingerprint: string;
}

/**
 * Records the dual of findStaleFiles: when an extension's source bundles
 * and imports cleanly but fails schema validation, write the catalog row
 * with the new fingerprint and validation_failed=true. Without this,
 * findStaleFiles keeps marking the file stale on every pass — the
 * `safeParse`-throws-before-upsert pattern in each loader's
 * rebundleAndUpdateCatalog leaves the row's fingerprint pinned at the
 * last-good state, so every command spawns a redundant deno bundle and
 * emits the same warning (swamp-club#209).
 *
 * Storing the new fingerprint terminates the loop: the next
 * findStaleFiles pass compares the computed fingerprint against the
 * stored one, finds them equal, and treats the file as fresh. The row's
 * empty type_normalized + validation_failed=true keeps the broken
 * extension out of the registry — registration call sites filter on
 * the flag.
 *
 * Symmetric to the UNREADABLE_DEP_SENTINEL fix in #208: that one made
 * computeSourceFingerprint total for unreadable transitive deps; this
 * one makes the catalog write total for schema-invalid sources. Both
 * encode "stable broken state" into the freshness contract.
 *
 * Does NOT throw — callers re-throw the original validation error so
 * the existing per-edit warning behavior is preserved.
 */
export function markCatalogValidationFailed(
  params: MarkCatalogValidationFailedParams,
): void {
  const {
    catalog,
    sourcePath,
    kind,
    bundlePath,
    sourceMtime,
    sourceFingerprint,
  } = params;

  catalog.upsert({
    source_path: sourcePath,
    type_normalized: "",
    kind,
    bundle_path: bundlePath,
    version: "",
    description: "",
    extends_type: "",
    source_mtime: sourceMtime,
    source_fingerprint: sourceFingerprint,
    validation_failed: true,
  });
}
