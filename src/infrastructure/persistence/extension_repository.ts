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

import { getLogger } from "@logtape/logtape";
import { canonicalizePath } from "./canonicalize_path.ts";
import { deriveExtensionIdentity } from "./derive_extension_identity.ts";
import type {
  ExtensionCatalogStore,
  ExtensionKind,
  ExtensionTypeRow,
} from "./extension_catalog_store.ts";
import { DuplicateTypeError } from "./duplicate_type_error.ts";
import type { LocalManifestIdentity } from "./local_manifest_reader.ts";
import type { LockfileRepository } from "./lockfile_repository.ts";
import {
  type Extension,
  type ExtensionOrigin,
  makeExtension,
} from "../../domain/extensions/extension.ts";
import { makeBundleLocation } from "../../domain/extensions/bundle_location.ts";
import { makeSourceLocation } from "../../domain/extensions/source_location.ts";
import { makeSource, type Source } from "../../domain/extensions/source.ts";
import type {
  RowState,
  RowStateTag,
} from "../../domain/extensions/row_state.ts";

const logger = getLogger(["swamp", "persistence", "extension-repository"]);

/**
 * Result of evaluating a kind's cold-start invalidation guards. Carries
 * which trigger fired so the loader can log a specific warning ("layout
 * version changed", "datastore base path changed", etc.) instead of a
 * generic one.
 */
export interface InvalidationGuardResult {
  readonly shouldInvalidate: boolean;
  readonly reason:
    | "not-populated"
    | "layout-version-mismatch"
    | "datastore-base-path-changed"
    | "source-dirs-fingerprint-changed"
    | "fresh";
}

/**
 * Sole gateway to {@link ExtensionCatalogStore}'s `bundle_types` table
 * for AGGREGATE-shaped operations on the {@link Extension} aggregate.
 *
 * **Role.** The repository hides SQLite for save/load/saveAll, returning
 * Extensions rather than rows. Loaders, lifecycle services
 * (W2 InstallExtensionService etc.), and `ReconcileFromDisk` (W3) talk
 * to this class and never touch SQL directly. The ExtensionLoader
 * accesses the catalog via {@link ExtensionRepository.getCatalogStore}
 * for row-level operations (buildIndex, loadSingleType).
 *
 * **I-Repo-1 invariant** (cross-aggregate `(kind, typeNormalized)`
 * uniqueness over non-Tombstoned Sources). Evaluated against post-save
 * state on EVERY commit — `save(ext)` is sugar for `saveAll([ext])` and
 * runs the same check. Violation → ROLLBACK + {@link DuplicateTypeError}
 * naming both source paths. The day-to-day case for I-Repo-1 firing
 * legitimately is the upgrade-as-atomic-transition transaction:
 * `saveAll([vN.tombstoneAll(), vN+1])`. v1's Sources are Tombstoned in
 * the post-state, so only v2 occupies the type slot.
 *
 * **Lockfile fallback** (W1b deferred from W1a). Pulled rows in the
 * catalog deliberately have empty `extension_version` because the
 * pulled-extensions on-disk tree encodes only the name. Version is
 * owned by `upstream_extensions.json` (the lockfile) and consulted at
 * read time. The repository takes a {@link LockfileRepository} injected
 * at construction and asks it for the locked version on every fallback
 * lookup.
 *
 * **Snapshot frozen at construction.** The lockfile snapshot lives one
 * layer out, inside the {@link LockfileRepository}. That repository is
 * itself constructed-with-snapshot per its own JSDoc; callers who need
 * a fresh snapshot construct a new {@link LockfileRepository} and pass
 * it to a new {@link ExtensionRepository}. Long-lived instances do NOT
 * auto-refresh — re-construction is the recommended mechanism. The race
 * window between lockfile read and write-back (process A reads v1,
 * process B upgrades to v2 + rewrites lockfile, process A writes back
 * v1) is acknowledged but deferred to W3's `ReconcileFromDisk` for
 * convergence; SQLite's `busy_timeout` serializes the write itself.
 *
 * **Composition over inheritance.** The repository wraps an
 * {@link ExtensionCatalogStore} via composition, NOT inheritance. The
 * {@link ExtensionLoader} accesses the catalog via
 * {@link getCatalogStore} for row-level operations.
 *
 * See `design/extension-rearchitecture.md` (workstream W1) for the full
 * architectural blueprint this class lives inside.
 */
export class ExtensionRepository {
  private readonly catalog: ExtensionCatalogStore;

  private readonly lockfileRepository: LockfileRepository;
  private readonly repoRoot: string;
  private readonly localManifestIdentity: LocalManifestIdentity | null;
  /**
   * Tracks rows we've already info-logged for the empty-version
   * fallback in this process's lifetime. The write-back makes
   * subsequent boots silent; this set keeps a single boot silent on
   * repeated reads of the same row before write-back commits (e.g.
   * concurrent loadByName calls before the UPDATE lands).
   */
  private readonly fallbackLoggedSourcePaths: Set<string>;

  constructor(args: {
    catalog: ExtensionCatalogStore;
    lockfileRepository: LockfileRepository;
    repoRoot: string;
    localManifestIdentity?: LocalManifestIdentity | null;
  }) {
    this.catalog = args.catalog;
    this.lockfileRepository = args.lockfileRepository;
    this.repoRoot = canonicalizePath(args.repoRoot);
    this.localManifestIdentity = args.localManifestIdentity ?? null;
    this.fallbackLoggedSourcePaths = new Set();
  }

  /**
   * Loads every Extension in the catalog. Applies the empty-identity
   * fallback to pulled rows with empty `extension_version` and to W1a
   * leftover rows where both identity columns are empty.
   */
  getCatalogStore(): ExtensionCatalogStore {
    return this.catalog;
  }

  close(): void {
    this.catalog.close();
  }

  findByKind(kind: ExtensionKind): ExtensionTypeRow[] {
    return this.catalog.findByKind(kind);
  }

  setLayoutVersion(version: string): void {
    this.catalog.setLayoutVersion(version);
  }

  markPopulated(kind: ExtensionKind): void {
    this.catalog.markPopulated(kind);
  }

  setManifestIdentity(identity: string | null): void {
    this.catalog.setManifestIdentity(identity);
  }

  loadAll(): Extension[] {
    const rows = this.catalog.findAll();
    return this.materialiseExtensions(rows);
  }

  /**
   * Loads the Extension(s) sharing the given name. Multiple versions of
   * the same name return as multiple Extension instances. Empty array
   * if no rows match (or if every match was orphaned by the lockfile
   * fallback).
   */
  loadByName(name: string): Extension[] {
    // Need full-table read because findByExtension takes (name, version)
    // and we don't know which versions are present. Filter in-memory by
    // the resolved identity after the empty-identity fallback runs.
    const rows = this.catalog.findAll();
    return this.materialiseExtensions(rows).filter((e) => e.name === name);
  }

  /**
   * Saves a single Extension. Sugar for `saveAll([extension])`. Triggers
   * I-Repo-1 evaluation on every call — single-extension saves DO get
   * the cross-aggregate uniqueness check. Required: a single
   * `save(ext)` that reuses a `(kind, type)` already owned by another
   * extension must throw {@link DuplicateTypeError}, not silently
   * overwrite.
   */
  save(extension: Extension): void {
    this.saveAll([extension]);
  }

  /**
   * Saves multiple Extensions atomically. Diff-based: for each
   * Extension, computes per-Source INSERT/UPDATE/DELETE against the
   * current persisted state and applies inside a single SQLite
   * transaction.
   *
   * Tombstoned Sources are DELETEd on save (per I4: retained in-memory
   * until the aggregate is persisted, then dropped). Non-Tombstoned
   * Sources are upserted with explicit `extension_name` /
   * `extension_version` identity columns (the aggregate is authoritative
   * for those — distinct from the loader-shaped upsert which deliberately
   * preserves them).
   *
   * After the diff is applied, evaluates I-Repo-1 against the full
   * post-save catalog state. Violation → ROLLBACK + throw
   * {@link DuplicateTypeError}.
   */
  saveAll(extensions: readonly Extension[]): void {
    this.catalog.runInTransaction(() => {
      for (const ext of extensions) {
        this.applyDiffForExtension(ext);
      }
      this.assertIRepo1();
    });
  }

  /**
   * Encapsulates the cold-start invalidation guards for a kind. Returns
   * which (if any) trigger fired. Replaces the per-loader hand-rolled
   * guard blocks (3 in the model loader, 1 in each sibling) with one
   * uniform check — closes the audit's "model has 3, siblings have 1"
   * coverage gap.
   *
   * Guards (in priority order):
   *   1. populated-flag absent → not yet populated → invalidate.
   *   2. layout-version mismatch → bundle layout changed → invalidate.
   *   3. datastore-base-path mismatch → datastore migrated → invalidate.
   *   4. source-dirs-fingerprint mismatch → extension dirs added/removed
   *      → invalidate.
   * Returns `{ shouldInvalidate: false, reason: "fresh" }` when none fire.
   */
  invalidationGuards(args: {
    kind: ExtensionKind;
    expectedLayoutVersion: string;
    expectedDatastoreBasePath: string;
    expectedSourceDirsFingerprint: string;
  }): InvalidationGuardResult {
    if (!this.catalog.isPopulated(args.kind)) {
      return { shouldInvalidate: true, reason: "not-populated" };
    }
    if (this.catalog.getLayoutVersion() !== args.expectedLayoutVersion) {
      return { shouldInvalidate: true, reason: "layout-version-mismatch" };
    }
    if (
      this.catalog.getDatastoreBasePath(args.kind) !==
        args.expectedDatastoreBasePath
    ) {
      return {
        shouldInvalidate: true,
        reason: "datastore-base-path-changed",
      };
    }
    if (
      this.catalog.getSourceDirsFingerprint(args.kind) !==
        args.expectedSourceDirsFingerprint
    ) {
      return {
        shouldInvalidate: true,
        reason: "source-dirs-fingerprint-changed",
      };
    }
    return { shouldInvalidate: false, reason: "fresh" };
  }

  /**
   * Best-effort full-catalog rescan trigger. Invalidates the populated
   * flag for every known kind. Replaces the standalone
   * `forceCatalogRescan` helper.
   *
   * **Best-effort semantics** — a failure to invalidate any one kind is
   * logged and swallowed so callers (open.ts, doctor_extensions.ts)
   * don't crash on a missing or corrupt catalog. The next loader pass
   * bootstraps a fresh catalog from disk.
   */
  invalidateAll(): void {
    const kinds: ExtensionKind[] = [
      "model",
      "vault",
      "driver",
      "datastore",
      "report",
    ];
    for (const kind of kinds) {
      try {
        this.catalog.invalidate(kind);
      } catch (error) {
        logger.warn`invalidateAll: failed to invalidate ${kind} (${error})`;
      }
    }
  }

  /**
   * Whole-repo cold-start check for {@link ReconcileFromDiskService}.
   * Returns `true` if ANY kind is not yet populated — reconcile then
   * runs a full-tree reconcile across all origins.
   *
   * Checks only the `isPopulated` flag — the cheapest guard that
   * catches the cold-start case (first run, after invalidateAll, after
   * catalog deletion). Per-kind guard values (layout version, base path,
   * source dirs fingerprint) require loader-computed inputs not available
   * at the CLI layer; those guards continue to trigger per-loader
   * rebuilds via {@link invalidationGuards}.
   *
   * Loaders keep their per-kind interface unchanged (W2/legacy path).
   * W4 collapses both entry points when it unifies loaders.
   */
  anyKindNeedsInvalidation(): boolean {
    const kinds: ExtensionKind[] = [
      "model",
      "vault",
      "driver",
      "datastore",
      "report",
    ];
    for (const kind of kinds) {
      if (!this.catalog.isPopulated(kind)) return true;
    }
    return false;
  }

  manifestIdentityChanged(
    manifest: LocalManifestIdentity | null,
  ): boolean {
    const stored = this.catalog.getManifestIdentity() ?? null;
    const current = manifest ? `${manifest.name}@${manifest.version}` : null;
    return stored !== current;
  }

  // ----- private helpers -----

  /**
   * Materialises rows into Extension aggregates. Runs the empty-identity
   * fallback per row, drops rows whose identity can't be resolved, then
   * groups surviving rows by `(extension_name, extension_version)`.
   */
  private materialiseExtensions(rows: ExtensionTypeRow[]): Extension[] {
    type Group = {
      name: string;
      version: string;
      origin: ExtensionOrigin;
      extensionRoot: string;
      sources: Source[];
    };
    const groups = new Map<string, Group>();

    const pulledPrefix = this.repoRoot.endsWith("/")
      ? `${this.repoRoot}.swamp/pulled-extensions/`
      : `${this.repoRoot}/.swamp/pulled-extensions/`;

    for (const row of rows) {
      const identity = this.resolveIdentity(row);
      if (identity === null) continue;

      const origin = (
          this.localManifestIdentity &&
          identity.name === this.localManifestIdentity.name &&
          !row.source_path.startsWith(pulledPrefix)
        )
        ? "local" as ExtensionOrigin
        : inferOrigin(identity.name);
      const extensionRoot = computeExtensionRoot(
        origin,
        identity.name,
        this.repoRoot,
      );
      const location = makeSourceLocation(row.source_path, extensionRoot);
      const state = mapStateRowToRowState(row);
      const source = makeSource({
        id: location,
        kind: row.kind,
        fingerprint: row.source_fingerprint ?? "",
        state,
      });

      const key = `${identity.name}::${identity.version}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          name: identity.name,
          version: identity.version,
          origin,
          extensionRoot,
          sources: [],
        };
        groups.set(key, group);
      }
      group.sources.push(source);
    }

    const result: Extension[] = [];
    for (const group of groups.values()) {
      result.push(
        makeExtension({
          name: group.name,
          version: group.version,
          origin: group.origin,
          extensionRoot: group.extensionRoot,
          sources: group.sources,
        }),
      );
    }
    return result;
  }

  /**
   * Resolves a row's `(extension_name, extension_version)` identity,
   * applying the empty-identity fallback per the W1b contract.
   *
   * Returns `null` when the row should be DELETEd as an orphan — when
   * either the source path matches no known layout (deriveExtensionIdentity
   * returns null) or the lockfile has no entry for a pulled extension.
   *
   * **W1b/W3 boundary.** This fallback does NOT try to repair the
   * "two pulled versions of the same extension on disk after an
   * interrupted upgrade" corruption case. Both rows backfill to the
   * same name; the lockfile gives both the same version; I-Repo-1 then
   * fires with DuplicateTypeError on the next save. That is the correct
   * error in a corrupt state. Repair (drop the stale subtree, re-derive
   * from lockfile) belongs to W3's ReconcileFromDisk.
   */
  private resolveIdentity(
    row: ExtensionTypeRow,
  ): { name: string; version: string } | null {
    const hasName = row.extension_name?.length ?? 0;
    const hasVersion = row.extension_version?.length ?? 0;

    let name: string | null = row.extension_name ?? null;
    let version: string | null = row.extension_version ?? null;

    if (!hasName && !hasVersion) {
      // W1a leftover: both columns empty. Derive from source path.
      const derived = deriveExtensionIdentity(row.source_path, this.repoRoot);
      if (derived === null) {
        logger
          .warn`Dropping orphan row at ${row.source_path}: source path matches no known extension layout.`;
        this.catalog.removeBySourcePath(row.source_path);
        return null;
      }
      name = derived.name;
      version = derived.version;
      // When a manifest declares identity, use it for local rows
      // instead of the synthetic @local/<basename>@0.0.0.
      if (
        version.length > 0 && this.localManifestIdentity &&
        name.startsWith("@local/")
      ) {
        name = this.localManifestIdentity.name;
        version = this.localManifestIdentity.version;
      }
      if (version.length > 0) {
        this.catalog.updateExtensionIdentity(
          row.source_path,
          name,
          version,
        );
        return { name, version };
      }
      // Pulled with empty version — fall through to the lockfile case
      // with the derived name in hand.
    }

    if (name !== null && (!version || version.length === 0)) {
      // Pulled row: name populated, version empty. Consult the lockfile.
      const locked = this.lockfileRepository.getLockedVersion(name);
      if (locked === null) {
        logger
          .warn`Dropping orphan pulled row at ${row.source_path}: lockfile has no entry for ${name}.`;
        this.catalog.removeBySourcePath(row.source_path);
        return null;
      }
      if (!this.fallbackLoggedSourcePaths.has(row.source_path)) {
        this.fallbackLoggedSourcePaths.add(row.source_path);
        logger
          .info`Empty-version fallback resolved ${name}@${locked} for ${row.source_path}; writing back so subsequent boots are silent.`;
      }
      this.catalog.updateExtensionIdentity(row.source_path, name, locked);
      return { name, version: locked };
    }

    // Both populated — no fallback needed.
    return { name: name ?? "", version: version ?? "" };
  }

  /**
   * Applies the diff for one extension: writes/updates rows for the
   * Extension's non-Tombstoned Sources, deletes rows for Tombstoned
   * Sources and rows that the Extension no longer owns.
   */
  private applyDiffForExtension(extension: Extension): void {
    const currentRows = this.catalog.findByExtension(
      extension.name,
      extension.version,
    );
    const newSourcePaths = new Set<string>();

    for (const source of extension.sources.values()) {
      if (source.state.tag === "Tombstoned") {
        // Tombstoned sources are DELETEd on save.
        this.catalog.removeBySourcePath(source.id.canonicalPath);
        continue;
      }
      newSourcePaths.add(source.id.canonicalPath);
      const row = sourceToRow(extension, source);
      this.catalog.upsertWithIdentity(row);
    }

    // DELETE current rows whose source_path is no longer owned by the
    // aggregate (the source was dropped without being explicitly
    // tombstoned — e.g. v2 of an extension with fewer files than v1).
    for (const row of currentRows) {
      if (!newSourcePaths.has(row.source_path)) {
        this.catalog.removeBySourcePath(row.source_path);
      }
    }
  }

  /**
   * Scans the post-save catalog state for I-Repo-1 violations. Throws
   * {@link DuplicateTypeError} on first conflict found — caller's
   * transaction wrapper rolls back. Naming both source paths is a hard
   * requirement.
   */
  private assertIRepo1(): void {
    const rows = this.catalog.findAll();
    const occupants = new Map<string, ExtensionTypeRow>();
    for (const row of rows) {
      if ((row.state ?? "Indexed") === "Tombstoned") continue;
      if (row.type_normalized.length === 0) continue;
      // Extension rows augment a base type — multiple files may target
      // the same type_normalized. Uniqueness only applies to base kinds.
      if (row.kind === "extension") continue;
      const key = `${row.kind}::${row.type_normalized}`;
      const prior = occupants.get(key);
      if (prior) {
        throw new DuplicateTypeError({
          kind: row.kind,
          typeNormalized: row.type_normalized,
          firstSource: {
            extensionName: prior.extension_name ?? "",
            extensionVersion: prior.extension_version ?? "",
            canonicalPath: prior.source_path,
          },
          secondSource: {
            extensionName: row.extension_name ?? "",
            extensionVersion: row.extension_version ?? "",
            canonicalPath: row.source_path,
          },
        });
      }
      occupants.set(key, row);
    }
  }
}

/**
 * Derives an Extension's origin from its name. Pulled extensions are
 * scoped (`@scope/name`) and are NOT under the `@local/` namespace;
 * locals are `@local/<basename>` (synthetic) or manifest-sourced.
 *
 * When a manifest declares identity, the local extension uses the
 * manifest name (e.g. `@hivemq/terraform-harvester`) which does NOT
 * start with `@local/`. Callers in `materialiseExtensions` check the
 * `localManifestIdentity` first to handle this case before falling
 * back to this name-prefix heuristic.
 */
function inferOrigin(extensionName: string): ExtensionOrigin {
  return extensionName.startsWith("@local/") ? "local" : "pulled";
}

/**
 * Computes the canonical extensionRoot for an Extension. Pulled
 * extensions root at `<repoRoot>/.swamp/pulled-extensions/<name>/`;
 * locals root at the repo root itself (synthetic aggregate spans every
 * `extensions/<kind>/` tree).
 */
function computeExtensionRoot(
  origin: ExtensionOrigin,
  extensionName: string,
  repoRoot: string,
): string {
  if (origin === "local") return repoRoot;
  // Pulled: <repoRoot>/.swamp/pulled-extensions/<name>
  // Use forward slashes so the result matches canonicalized paths.
  const trimmedRoot = repoRoot.endsWith("/") ? repoRoot.slice(0, -1) : repoRoot;
  return `${trimmedRoot}/.swamp/pulled-extensions/${extensionName}`;
}

/**
 * Reconstructs a {@link RowState} from a catalog row. The catalog stores
 * the `state` tag as TEXT plus other row fields (bundle_path,
 * source_fingerprint, type_normalized) that flow into the state's
 * payload. States that carry payload not recoverable from the row
 * (lastError strings, the OrphanedBundleOnly / EntryPointUnreadable
 * branches) reconstruct with placeholder values; W3's ReconcileFromDisk
 * is the source of truth for refreshed payload, and `swamp doctor`
 * (W6) surfaces the reconstructed shape verbatim.
 */
function mapStateRowToRowState(row: ExtensionTypeRow): RowState {
  const tag = (row.state ?? "Indexed") as RowStateTag;
  const bundle = makeBundleLocation(
    row.bundle_path,
    row.source_fingerprint ?? "",
  );
  switch (tag) {
    case "Indexed":
      return { tag: "Indexed", type: row.type_normalized, bundle };
    case "Bundled":
      return {
        tag: "Bundled",
        type: row.type_normalized,
        bundle,
        loadedInProcess: false,
      };
    case "BundleBuildFailed":
      return { tag: "BundleBuildFailed", lastError: "" };
    case "ValidationFailed":
      return { tag: "ValidationFailed", bundle, lastError: "" };
    case "EntryPointUnreadable":
      return { tag: "EntryPointUnreadable", lastError: "" };
    case "OrphanedBundleOnly":
      return { tag: "OrphanedBundleOnly", bundle };
    case "Tombstoned":
      return { tag: "Tombstoned", reason: "source-deleted" };
    default:
      // Unknown tag — be defensive and treat as Indexed using the row's
      // type. Logged once per process to surface schema drift.
      logger
        .warn`Unknown RowState tag "${row.state}" at ${row.source_path}; defaulting to Indexed.`;
      return { tag: "Indexed", type: row.type_normalized, bundle };
  }
}

/**
 * Projects a Source into a row tuple suitable for upsertWithIdentity.
 * The state tag goes into the `state` column; the type and bundle go
 * into the `type_normalized` / `bundle_path` / `source_fingerprint`
 * columns where applicable. States without a type (BundleBuildFailed,
 * EntryPointUnreadable, OrphanedBundleOnly, Tombstoned) write empty
 * type_normalized; ValidationFailed also writes empty so it doesn't
 * occupy the `(kind, type)` namespace at the row level either.
 */
function sourceToRow(
  extension: Extension,
  source: Source,
): ExtensionTypeRow & { extension_name: string; extension_version: string } {
  const state = source.state;
  let typeNormalized = "";
  let bundlePath = "";
  switch (state.tag) {
    case "Indexed":
    case "Bundled":
      typeNormalized = state.type;
      bundlePath = state.bundle.canonicalPath;
      break;
    case "ValidationFailed":
    case "OrphanedBundleOnly":
      // Carry bundle but not type — the row's type_normalized stays
      // empty so I-Repo-1 doesn't see these as occupying the namespace.
      bundlePath = state.bundle.canonicalPath;
      break;
    case "BundleBuildFailed":
    case "EntryPointUnreadable":
    case "Tombstoned":
      // Tombstoned shouldn't reach this function (caller filters), but
      // the switch is exhaustive for type safety.
      break;
  }

  return {
    source_path: source.id.canonicalPath,
    type_normalized: typeNormalized,
    kind: source.kind,
    bundle_path: bundlePath,
    version: extension.version, // legacy column; mirrors extension_version
    description: "",
    extends_type: "",
    source_mtime: "",
    source_fingerprint: source.fingerprint,
    state: state.tag,
    extension_name: extension.name,
    extension_version: extension.version,
  };
}
