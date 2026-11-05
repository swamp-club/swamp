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

import { getLogger } from "@logtape/logtape";
import { canonicalizePath } from "./canonicalize_path.ts";
import { deriveExtensionIdentity } from "./derive_extension_identity.ts";
import type {
  ExtensionCatalogStore,
  ExtensionKind,
  ExtensionTypeRow,
  MountedTypeConflict,
  OriginConflict,
  PulledTypeConflict,
} from "./extension_catalog_store.ts";
import { DuplicateTypeError } from "./duplicate_type_error.ts";
import { evictRemovedBundles } from "../../domain/extensions/bundle_eviction.ts";
import { activePulledExtensionsRoot } from "./paths.ts";
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
 * sole gateway to bundle_types for aggregate operations; every save checks
 * (kind, type) uniqueness over non-Tombstoned sources and rolls back with
 * DuplicateTypeError; pulled versions come from the lockfile
 */
export class ExtensionRepository {
  private readonly catalog: ExtensionCatalogStore;

  private readonly lockfileRepository: LockfileRepository;
  private readonly repoRoot: string;
  private readonly localManifestIdentity: LocalManifestIdentity | null;
  /**
   * rows already info-logged for the empty-version fallback, so repeated reads
   * before the write-back commits stay quiet
   */
  private readonly fallbackLoggedSourcePaths: Set<string>;
  private _lastOriginConflicts: OriginConflict[] = [];
  private _lastPulledTypeConflicts: PulledTypeConflict[] = [];
  private readonly activePulledRoot: () => string | undefined;
  private readonly sourceExists: (sourcePath: string) => boolean;
  private readonly mountedSourceDirsCanonical: readonly string[];

  /**
   * activePulledRoot is read at call time because managed status is recorded
   * during startup; sourceExists counts only NotFound as missing
   */
  constructor(args: {
    catalog: ExtensionCatalogStore;
    lockfileRepository: LockfileRepository;
    repoRoot: string;
    localManifestIdentity?: LocalManifestIdentity | null;
    activePulledRoot?: () => string | undefined;
    sourceExists?: (sourcePath: string) => boolean;
    mountedSourceDirs?: readonly string[];
  }) {
    this.catalog = args.catalog;
    this.lockfileRepository = args.lockfileRepository;
    this.repoRoot = canonicalizePath(args.repoRoot);
    this.localManifestIdentity = args.localManifestIdentity ?? null;
    this.fallbackLoggedSourcePaths = new Set();
    // The managed-config registry is keyed by the case-preserving repo
    // dir, so look it up with the raw argument, not the canonical form.
    const rawRepoRoot = args.repoRoot;
    this.activePulledRoot = args.activePulledRoot ??
      (() => activePulledExtensionsRoot(rawRepoRoot));
    this.sourceExists = args.sourceExists ?? sourceFileExists;
    this.mountedSourceDirsCanonical = (args.mountedSourceDirs ?? []).map(
      canonicalizePath,
    );
  }

  get mountedSourceDirs(): readonly string[] {
    return this.mountedSourceDirsCanonical;
  }

  settleMountedTypeConflicts(): MountedTypeConflict[] {
    return this.catalog.settleMountedTypeConflicts(
      this.repoRoot,
      this.mountedSourceDirsCanonical,
    );
  }

  get lastOriginConflicts(): readonly OriginConflict[] {
    return this._lastOriginConflicts;
  }

  get lastPulledTypeConflicts(): readonly PulledTypeConflict[] {
    return this._lastPulledTypeConflicts;
  }

  getCatalogStore(): ExtensionCatalogStore {
    return this.catalog;
  }

  isInstalledExtension(name: string): boolean {
    return this.lockfileRepository.getLockedVersion(name) !== null;
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
    return this.materialiseExtensions(rows, false);
  }

  loadAllWithPruning(): Extension[] {
    const rows = this.catalog.findAll();
    return this.materialiseExtensions(rows, true);
  }

  loadByName(name: string): Extension[] {
    // Need full-table read because findByExtension takes (name, version)
    // and we don't know which versions are present. Filter in-memory by
    // the resolved identity after the empty-identity fallback runs.
    const rows = this.catalog.findAll();
    return this.materialiseExtensions(rows, false).filter((e) =>
      e.name === name
    );
  }

  /**
   * a single save still gets the cross-aggregate uniqueness check: reusing a
   * (kind, type) owned by another extension must throw DuplicateTypeError, not
   * overwrite
   */
  save(extension: Extension): void {
    this.saveAll([extension]);
  }

  /**
   * pruneUnreachable false skips pruning out-of-root rows;
   * settlePulledTypeConflicts true clears later pulled claimants instead of
   * rejecting them (reconcile only; installs still fail with DuplicateTypeError)
   */
  saveAll(
    extensions: readonly Extension[],
    options?: {
      pruneUnreachable?: boolean;
      settlePulledTypeConflicts?: boolean;
    },
  ): void {
    let staleRows: ExtensionTypeRow[] = [];
    let settled: PulledTypeConflict[] = [];
    // Published only once the save commits, so a rolled-back save never
    // reports conflicts that were not kept.
    this._lastPulledTypeConflicts = [];
    this.catalog.runInTransaction(() => {
      // runInTransaction re-runs this callback on lock contention.
      staleRows = [];
      settled = [];
      const protectedPaths = new Set<string>();
      for (const ext of extensions) {
        for (const source of ext.sources.values()) {
          if (source.state.tag !== "Tombstoned") {
            protectedPaths.add(source.id.canonicalPath);
          }
        }
        this.applyDiffForExtension(ext);
      }
      if (options?.pruneUnreachable ?? true) {
        const pruned = this.catalog.pruneUnreachableSources(
          this.repoRoot,
          protectedPaths,
          {
            dirs: this.mountedSourceDirsCanonical,
            sourceExists: this.sourceExists,
          },
        );
        if (pruned.length > 0) {
          logger
            .info`Pruned ${pruned.length} catalog row(s) with unreachable source path(s)`;
        }
        staleRows = this.catalog.pruneStaleSources({
          canonicalRepoRoot: this.repoRoot,
          activePulledRoot: this.activePulledRoot(),
          protectedPaths,
          sourceExists: this.sourceExists,
        });
        if (staleRows.length > 0) {
          logger
            .debug`Pruned ${staleRows.length} catalog row(s) whose source is missing or under the inactive pulled root`;
        }
      }
      const mountedConflicts = this.catalog.settleMountedTypeConflicts(
        this.repoRoot,
        this.mountedSourceDirsCanonical,
      );
      if (mountedConflicts.length > 0) {
        logger
          .debug`Cleared the type on ${mountedConflicts.length} source-mounted catalog row(s) a higher-precedence row also claims`;
      }
      // Pulled-vs-pulled first, then pulled-vs-local, so a local override
      // ends up the only claimant however many pulled rows share a type.
      if (options?.settlePulledTypeConflicts) {
        settled = this.catalog.settlePulledTypeConflicts(this.repoRoot);
      }
      this._lastOriginConflicts = this.catalog.resolveOriginConflicts(
        this.repoRoot,
      );
      this.assertIRepo1(protectedPaths);
    });
    this._lastPulledTypeConflicts = settled;
    evictRemovedBundles(staleRows, this.catalog);
  }

  /**
   * one uniform check for every loader, in priority order: not populated,
   * layout version mismatch, datastore base path mismatch, source dirs
   * fingerprint mismatch
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
   * best-effort: a failure is logged and swallowed so callers do not crash on a
   * missing or corrupt catalog; one transaction so a partial invalidation
   * cannot cause BundleBuildFailed
   */
  invalidateAll(): void {
    const kinds: ExtensionKind[] = [
      "model",
      "vault",
      "datastore",
      "report",
      "webhook",
    ];
    try {
      this.catalog.runInTransaction(() => {
        for (const kind of kinds) {
          this.catalog.invalidate(kind);
        }
      });
    } catch (error) {
      logger.warn`invalidateAll: failed to invalidate (${error})`;
    }
  }

  /**
   * checks only the populated flag, the cheapest cold-start guard; the other
   * guards need loader-computed inputs unavailable at the CLI layer and stay
   * per-loader
   */
  anyKindNeedsInvalidation(): boolean {
    const kinds: ExtensionKind[] = [
      "model",
      "vault",
      "datastore",
      "report",
      "webhook",
    ];
    for (const kind of kinds) {
      if (!this.catalog.isPopulated(kind)) return true;
    }
    return false;
  }

  /**
   * matches by canonical form, not PK lookup, so cross-OS rows are found (a
   * WSL/Linux row keeps its case, which Windows canonicalizePath lowercases);
   * deletion uses the raw PK value
   */
  deleteBySourcePaths(paths: readonly string[]): number {
    const targetSet = new Set(paths.map(canonicalizePath));
    let deleted = 0;
    this.catalog.runInTransaction(() => {
      for (const row of this.catalog.findAll()) {
        if (targetSet.has(canonicalizePath(row.source_path))) {
          this.catalog.removeByRawSourcePath(row.source_path);
          deleted++;
        }
      }
    });
    return deleted;
  }

  manifestIdentityChanged(
    manifest: LocalManifestIdentity | null,
  ): boolean {
    const stored = this.catalog.getManifestIdentity() ?? null;
    const current = manifest ? `${manifest.name}@${manifest.version}` : null;
    return stored !== current;
  }

  private materialiseExtensions(
    rows: ExtensionTypeRow[],
    pruneOrphans: boolean,
  ): Extension[] {
    type Group = {
      name: string;
      version: string;
      origin: ExtensionOrigin;
      extensionRoot: string;
      sources: Source[];
    };
    const groups = new Map<string, Group>();

    const sep = this.repoRoot.endsWith("/") ? "" : "/";
    const pulledPrefix = `${this.repoRoot}${sep}.swamp/pulled-extensions/`;
    const managedPulledPrefix =
      `${this.repoRoot}${sep}.swamp/config/pulled-extensions/`;

    for (const row of rows) {
      const identity = this.resolveIdentity(row, pruneOrphans);
      if (identity === null) continue;

      const origin = (
          this.localManifestIdentity &&
          identity.name === this.localManifestIdentity.name &&
          !row.source_path.startsWith(pulledPrefix) &&
          !row.source_path.startsWith(managedPulledPrefix)
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
        sourceMtime: row.source_mtime ?? "",
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
   * does not repair two pulled versions left by an interrupted upgrade: both
   * resolve to the same version and the next save fails with
   * DuplicateTypeError; repair belongs to reconcile
   */
  private resolveIdentity(
    row: ExtensionTypeRow,
    pruneOrphans: boolean,
  ): { name: string; version: string } | null {
    const hasName = row.extension_name?.length ?? 0;
    const hasVersion = row.extension_version?.length ?? 0;

    let name: string | null = row.extension_name ?? null;
    let version: string | null = row.extension_version ?? null;

    if (!hasName && !hasVersion) {
      const derived = deriveExtensionIdentity(
        row.source_path,
        this.repoRoot,
        Object.keys(this.lockfileRepository.getAllEntries()),
      );
      if (derived === null) {
        if (pruneOrphans) {
          logger
            .warn`Dropping orphan row at ${row.source_path}: source path matches no known extension layout.`;
          this.catalog.removeBySourcePath(row.source_path);
        }
        return null;
      }
      name = derived.name;
      version = derived.version;
      // a manifest-declared identity replaces the synthetic
      // @local/<basename>@0.0.0 for local rows
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
    }

    if (name !== null && (!version || version.length === 0)) {
      const locked = this.lockfileRepository.getLockedVersion(name);
      if (locked === null) {
        if (pruneOrphans) {
          logger
            .warn`Dropping orphan pulled row at ${row.source_path}: lockfile has no entry for ${name}.`;
          this.catalog.removeBySourcePath(row.source_path);
        }
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

    return { name: name ?? "", version: version ?? "" };
  }

  private applyDiffForExtension(extension: Extension): void {
    const currentRows = this.catalog.findByExtension(
      extension.name,
      extension.version,
    );
    const newSourcePaths = new Set<string>();

    for (const source of extension.sources.values()) {
      if (source.state.tag === "Tombstoned") {
        this.catalog.removeBySourcePath(source.id.canonicalPath);
        continue;
      }
      newSourcePaths.add(source.id.canonicalPath);
      const row = sourceToRow(extension, source);
      this.catalog.upsertWithIdentity(row);
    }

    // delete rows the aggregate does not own, such as a new version with fewer
    // files whose sources were dropped without being tombstoned
    for (const row of currentRows) {
      if (!newSourcePaths.has(row.source_path)) {
        this.catalog.removeBySourcePath(row.source_path);
      }
    }
  }

  /**
   * throws on the first conflict, which the caller rolls back; when exactly one
   * side is in savedPaths the other was already in the catalog and is reported
   * as firstSource whatever the scan order
   */
  private assertIRepo1(savedPaths: ReadonlySet<string>): void {
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
        const priorSaved = savedPaths.has(canonicalizePath(prior.source_path));
        const rowSaved = savedPaths.has(canonicalizePath(row.source_path));
        const [first, second] = priorSaved && !rowSaved
          ? [row, prior]
          : [prior, row];
        throw new DuplicateTypeError({
          kind: row.kind,
          typeNormalized: row.type_normalized,
          firstSource: {
            extensionName: first.extension_name ?? "",
            extensionVersion: first.extension_version ?? "",
            canonicalPath: first.source_path,
          },
          secondSource: {
            extensionName: second.extension_name ?? "",
            extensionVersion: second.extension_version ?? "",
            canonicalPath: second.source_path,
          },
        });
      }
      occupants.set(key, row);
    }
  }
}

/**
 * a manifest-declared local extension has a name not starting with @local/, so
 * callers check localManifestIdentity first, before this name-prefix heuristic
 */
function inferOrigin(extensionName: string): ExtensionOrigin {
  return extensionName.startsWith("@local/") ? "local" : "pulled";
}

function computeExtensionRoot(
  origin: ExtensionOrigin,
  extensionName: string,
  repoRoot: string,
  pulledExtensionsRoot?: string,
): string {
  if (origin === "local") return repoRoot;
  if (pulledExtensionsRoot) {
    const trimmed = pulledExtensionsRoot.endsWith("/")
      ? pulledExtensionsRoot.slice(0, -1)
      : pulledExtensionsRoot;
    return `${trimmed}/${extensionName}`;
  }
  const trimmedRoot = repoRoot.endsWith("/") ? repoRoot.slice(0, -1) : repoRoot;
  return `${trimmedRoot}/.swamp/pulled-extensions/${extensionName}`;
}

/**
 * states with payload not recoverable from the row (lastError,
 * OrphanedBundleOnly, EntryPointUnreadable) reconstruct with placeholders;
 * reconcile refreshes the payload
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
      return { tag: "BundleBuildFailed", lastError: row.last_error ?? "" };
    case "ValidationFailed":
      return {
        tag: "ValidationFailed",
        bundle,
        lastError: row.last_error ?? "",
      };
    case "EntryPointUnreadable":
      return {
        tag: "EntryPointUnreadable",
        lastError: row.last_error ?? "",
      };
    case "OrphanedBundleOnly":
      return { tag: "OrphanedBundleOnly", bundle };
    case "Tombstoned":
      return { tag: "Tombstoned", reason: "source-deleted" };
    default:
      // unknown tag: treat as Indexed with the row's type, and warn to surface
      // schema drift
      logger
        .warn`Unknown RowState tag "${row.state}" at ${row.source_path}; defaulting to Indexed.`;
      return { tag: "Indexed", type: row.type_normalized, bundle };
  }
}

/**
 * typeless states and ValidationFailed write an empty type_normalized so they
 * do not occupy the (kind, type) namespace at row level
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
      // carry the bundle but not the type, so I-Repo-1 does not see these rows
      // as occupying the namespace
      bundlePath = state.bundle.canonicalPath;
      break;
    case "BundleBuildFailed":
    case "EntryPointUnreadable":
    case "Tombstoned":
      // the caller filters Tombstoned out; the case keeps the switch exhaustive
      break;
  }

  let lastError = "";
  if (
    state.tag === "BundleBuildFailed" || state.tag === "ValidationFailed" ||
    state.tag === "EntryPointUnreadable"
  ) {
    lastError = state.lastError;
  }

  // an extension row's type_normalized is its target type, so extends_type must
  // mirror it or findExtensionsForType never matches and its methods are
  // dropped; typeless states stay empty
  const extendsType = source.kind === "extension" ? typeNormalized : "";

  return {
    source_path: source.id.canonicalPath,
    type_normalized: typeNormalized,
    kind: source.kind,
    bundle_path: bundlePath,
    version: extension.version,
    description: "",
    extends_type: extendsType,
    source_mtime: source.sourceMtime,
    source_fingerprint: source.fingerprint,
    state: state.tag,
    extension_name: extension.name,
    extension_version: extension.version,
    last_error: lastError,
  };
}

/** A stat where only NotFound counts as missing, so an unreadable
 *  source is never pruned. */
function sourceFileExists(sourcePath: string): boolean {
  try {
    Deno.statSync(sourcePath);
    return true;
  } catch (error) {
    return !(error instanceof Deno.errors.NotFound);
  }
}
