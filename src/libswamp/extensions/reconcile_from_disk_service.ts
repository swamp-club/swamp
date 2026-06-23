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
import {
  basename as pathBasename,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import {
  type Extension,
  makeExtension,
  makeLocalExtension,
  markSourceMissing,
  observeFreshSource,
  recordBundled,
  recordEntryPointUnreadable,
  tombstoneAll,
} from "../../domain/extensions/extension.ts";
import type { LocalManifestIdentity } from "../../infrastructure/persistence/local_manifest_reader.ts";
import { readManifestIdentityAt } from "../../infrastructure/persistence/local_manifest_reader.ts";
import { canonicalizePath } from "../../infrastructure/persistence/canonicalize_path.ts";
import { makeSourceLocation } from "../../domain/extensions/source_location.ts";
import { makeBundleLocation } from "../../domain/extensions/bundle_location.ts";
import {
  computeSourceFingerprint,
  createFreshnessCache,
  type FreshnessCache,
} from "../../domain/extensions/bundle_freshness.ts";
import type { RowStateTag } from "../../domain/extensions/row_state.ts";
import type { SourceLocation } from "../../domain/extensions/source_location.ts";
import type { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import {
  findSourceByPath,
  recordSourceFailure,
} from "../../domain/extensions/source_failure_recorder.ts";
import type {
  ExtensionKind,
} from "../../infrastructure/persistence/extension_catalog_store.ts";
import { BUNDLE_LAYOUT_VERSION } from "../../infrastructure/persistence/extension_catalog_store.ts";
import type { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import { ExtensionLoader } from "../../domain/extensions/extension_loader.ts";
import { modelKindAdapter } from "../../domain/extensions/model_kind_adapter.ts";
import { vaultKindAdapter } from "../../domain/extensions/vault_kind_adapter.ts";
import { datastoreKindAdapter } from "../../domain/extensions/datastore_kind_adapter.ts";
import { reportKindAdapter } from "../../domain/extensions/report_kind_adapter.ts";
import type { DenoRuntime } from "../../domain/runtime/deno_runtime.ts";
import {
  collectDirsForKind,
  expandSourcePaths,
  readSwampSources,
  resolveSourceExtensionDirs,
} from "../../infrastructure/persistence/swamp_sources_repository.ts";

const logger = getLogger(["swamp", "extensions", "reconcile"]);

/** Subdirectories of a per-extension subtree, paired with their kind. */
const KIND_DIRS = [
  "models",
  "vaults",
  "datastores",
  "reports",
] as const;

type KindDir = typeof KIND_DIRS[number];

/**
 * A single state transition produced by reconcile. Structured value —
 * W6's `swamp doctor extensions` renders this directly.
 */
export interface ReconcileTransition {
  readonly source: SourceLocation;
  readonly fromState: RowStateTag | null;
  readonly toState: RowStateTag;
  readonly reason: string;
}

/**
 * Result of a reconcile run.
 */
export interface ReconcileResult {
  readonly transitions: readonly ReconcileTransition[];
  readonly applied: boolean;
}

/**
 * W3 application service — reconciles on-disk extension state against
 * the persisted catalog aggregate state.
 *
 * Walks the on-disk source tree across all three origin types (locals,
 * pulled, source-mounted), loads the current aggregate state via
 * {@link ExtensionRepository.loadAll}, diffs the two, and emits
 * {@link ReconcileTransition} records.
 *
 * Delegates to per-loader `bundleAndIndexOne` for type extraction —
 * NOT {@link InstallExtensionService}. The source is already on disk
 * and the lockfile already exists; reconcile is post-hoc state repair,
 * not a fresh install.
 *
 * **Trigger points:** cold-start (when `anyKindNeedsInvalidation()`
 * returns true) + explicit `swamp doctor extensions` call. NOT on
 * every command.
 *
 * **dryRun mode:** when `dryRun: true`, collects transitions without
 * calling `repository.saveAll()`. Returns the same structured result
 * either way.
 *
 * **Transition-count guardrail:** if any single run would transition
 * > 50% of existing rows, the run aborts and returns the transitions
 * without applying them. Catches mass-tombstone bugs before they
 * destroy legitimate rows.
 */
export class ReconcileFromDiskService {
  private readonly denoRuntime: DenoRuntime;
  private readonly repository: ExtensionRepository;
  private readonly lockfileRepository: LockfileRepository;
  private readonly repoDir: string;
  private readonly localManifestIdentity: LocalManifestIdentity | null;

  constructor(args: {
    denoRuntime: DenoRuntime;
    repository: ExtensionRepository;
    lockfileRepository: LockfileRepository;
    repoDir: string;
    localManifestIdentity?: LocalManifestIdentity | null;
  }) {
    this.denoRuntime = args.denoRuntime;
    this.repository = args.repository;
    this.lockfileRepository = args.lockfileRepository;
    this.repoDir = resolve(args.repoDir);
    this.localManifestIdentity = args.localManifestIdentity ?? null;
  }

  async execute(
    options?: { dryRun?: boolean },
  ): Promise<ReconcileResult> {
    const dryRun = options?.dryRun ?? false;
    const transitions: ReconcileTransition[] = [];

    const existingExtensions = this.repository.loadAll();
    const totalExistingRows = countSources(existingExtensions);

    const { extensions: reconciledExtensions, migrationTransitions } =
      await this.reconcileAll(
        existingExtensions,
        transitions,
      );

    // Identity-migration tombstones are expected mass-transitions, not
    // repair anomalies. Exclude them from the guardrail ratio so a
    // version bump in a repo with ≥10 local sources doesn't permanently
    // block the migration.
    const repairCount = transitions.length - migrationTransitions;
    const GUARDRAIL_MIN_ROWS = 10;
    if (
      repairCount > 0 && totalExistingRows >= GUARDRAIL_MIN_ROWS
    ) {
      const ratio = repairCount / totalExistingRows;
      if (ratio > 0.5) {
        if (!dryRun) this.markKindsPopulated();
        logger
          .warn`Skipped catalog repair: too many entries would change (${repairCount}/${totalExistingRows}). Run ${"swamp doctor extensions"} to inspect.`;
        return { transitions, applied: false };
      }
    }

    if (!dryRun && transitions.length > 0) {
      this.repository.saveAll(reconciledExtensions);
      this.markAllKindsPopulated();
      logger
        .info`Extension catalog updated: ${transitions.length} ${
        transitions.length === 1 ? "entry" : "entries"
      } repaired`;
    } else if (!dryRun && totalExistingRows === 0) {
      this.markAllKindsPopulated();
    } else if (transitions.length === 0) {
      logger.debug`Reconcile complete: no transitions`;
    }

    return { transitions, applied: !dryRun && transitions.length > 0 };
  }

  private async reconcileAll(
    existingExtensions: Extension[],
    transitions: ReconcileTransition[],
  ): Promise<{ extensions: Extension[]; migrationTransitions: number }> {
    const cache = createFreshnessCache();
    const result: Extension[] = [];
    let migrationTransitions = 0;

    // Gather local + source-mounted on-disk sources, partitioned by
    // per-subdirectory manifests. Each manifest-bearing subdirectory
    // becomes its own Extension aggregate; remaining files fall back
    // to the @local/<repo> aggregate.
    const localTransitionsBefore = transitions.length;
    const { extensions: localExts, hasManifestPartitions } = await this
      .reconcileLocalAndSourceMounted(
        existingExtensions,
        transitions,
        cache,
      );
    const localTransitionsAdded = transitions.length - localTransitionsBefore;

    // Pulled extensions next. Processed BEFORE local aggregates in
    // the result array so saveAll DELETEs pulled-orphan rows before
    // local INSERTs. Prevents the manifest-deletion case from losing
    // data: old manifest-named rows are inferred as "pulled" after the
    // manifest is removed, orphan-tombstoned, and their DELETEs must
    // not clobber the new @local/ rows at the same source_path.
    const pulledExts = await this.reconcilePulled(
      existingExtensions,
      transitions,
      cache,
    );
    result.push(...pulledExts);

    // Atomic identity migration: tombstone stale local-origin aggregates
    // BEFORE the new aggregates. saveAll processes in array order —
    // tombstones must come first so removeBySourcePath deletes old rows
    // before upsertWithIdentity writes new ones at the same paths.
    const localIdentities = new Set(
      localExts.map((e) => `${e.name}@${e.version}`),
    );
    if (localExts.length > 0) {
      let isMigration = false;
      let tombstoneCount = 0;
      for (const existing of existingExtensions) {
        if (existing.origin !== "local") continue;
        if (localIdentities.has(`${existing.name}@${existing.version}`)) {
          continue;
        }
        isMigration = true;
        const reason =
          `identity migration: ${existing.name}@${existing.version} → [${
            [...localIdentities].join(", ")
          }]`;
        for (const [loc, source] of existing.sources) {
          if (source.state.tag === "Tombstoned") continue;
          transitions.push({
            source: loc,
            fromState: source.state.tag,
            toState: "Tombstoned",
            reason,
          });
          tombstoneCount++;
        }
        result.push(tombstoneAll(existing));
      }
      // When migrating identities (full: monolithic @local/<repo> is
      // entirely replaced, or partial: some files remain in the default
      // partition while others move to manifest partitions), the
      // tombstones and new-source indexing are expected consequences of
      // the identity change. Count both as migration transitions so
      // they're exempt from the >50% guardrail.
      // hasManifestPartitions covers the partial-adoption case where
      // @local/<repo> remains in localIdentities but files are being
      // re-partitioned to manifest-declared aggregates.
      if (isMigration || hasManifestPartitions) {
        migrationTransitions = tombstoneCount + localTransitionsAdded;
      } else {
        migrationTransitions = tombstoneCount;
      }
      result.push(...localExts);
    }

    return { extensions: result, migrationTransitions };
  }

  private async reconcileLocalAndSourceMounted(
    existingExtensions: Extension[],
    transitions: ReconcileTransition[],
    cache: FreshnessCache,
  ): Promise<{ extensions: Extension[]; hasManifestPartitions: boolean }> {
    const topLevelManifest = this.localManifestIdentity;
    const basename = pathBasename(this.repoDir) || "unknown";
    const defaultName = topLevelManifest
      ? topLevelManifest.name
      : `@local/${basename}`;
    const defaultVersion = topLevelManifest
      ? topLevelManifest.version
      : "0.0.0";

    // Discover per-subdirectory manifests under each extensions/<kind>/
    // directory. Only immediate children are checked — deeper nesting
    // is not treated as an extension boundary.
    // When a top-level manifest exists, per-subdirectory manifests are
    // ignored — the top-level identity claims the entire tree.
    const subdirManifests = new Map<string, LocalManifestIdentity>();
    if (!topLevelManifest) {
      for (const kindDir of KIND_DIRS) {
        const kindPath = join(this.repoDir, "extensions", kindDir);
        await discoverSubdirManifests(kindPath, subdirManifests);
      }
    }

    // Collect all on-disk sources, partitioned by extension identity.
    // Key: "<name>@<version>" for all partitions, including the
    // fallback @local/<repo> aggregate.
    const partitions = new Map<
      string,
      {
        name: string;
        version: string;
        extensionRoot: string;
        sources: Map<string, { kind: KindDir; baseDir: string }>;
      }
    >();

    const defaultKey = `${defaultName}@${defaultVersion}`;
    partitions.set(defaultKey, {
      name: defaultName,
      version: defaultVersion,
      extensionRoot: this.repoDir,
      sources: new Map(),
    });

    // Pre-populate partitions for all discovered subdirectory manifests.
    for (const [, manifest] of subdirManifests) {
      const key = `${manifest.name}@${manifest.version}`;
      if (!partitions.has(key)) {
        partitions.set(key, {
          name: manifest.name,
          version: manifest.version,
          extensionRoot: this.repoDir,
          sources: new Map(),
        });
      }
    }

    // Local extensions under extensions/<kind>/
    for (const kindDir of KIND_DIRS) {
      const dir = join(this.repoDir, "extensions", kindDir);
      const files = await collectTsFiles(dir);
      for (const absolutePath of files) {
        const ownerKey = findOwningManifest(
          absolutePath,
          subdirManifests,
          defaultKey,
        );
        const partition = partitions.get(ownerKey);
        if (!partition) continue;
        partition.sources.set(absolutePath, { kind: kindDir, baseDir: dir });
      }
    }

    // Source-mounted extensions from .swamp-sources.yaml
    const config = await readSwampSources(this.repoDir);
    if (config) {
      const expanded = await expandSourcePaths(config, this.repoDir);
      const resolved = await resolveSourceExtensionDirs(expanded);
      for (const sourceDirs of resolved) {
        for (const kindDir of KIND_DIRS) {
          const dirs = collectDirsForKind([sourceDirs], kindDir);
          for (const dir of dirs) {
            const files = await collectTsFiles(dir);
            for (const absolutePath of files) {
              const defaultPartition = partitions.get(defaultKey)!;
              defaultPartition.sources.set(absolutePath, {
                kind: kindDir,
                baseDir: dir,
              });
            }
          }
        }
      }
    }

    // Reconcile each partition into an Extension aggregate.
    const hasManifestPartitions = subdirManifests.size > 0;
    const result: Extension[] = [];
    for (const [key, partition] of partitions) {
      const isDefault = key === defaultKey;

      // When manifest partitions have claimed all files from the default
      // partition, skip reconciling it entirely. The old @local/<repo>
      // aggregate (if one exists) will be tombstoned by the identity
      // migration loop in reconcileAll(), which counts its transitions
      // as migrationTransitions — exempt from the >50% guardrail.
      if (
        isDefault && hasManifestPartitions && partition.sources.size === 0
      ) {
        continue;
      }

      const existing = existingExtensions.find(
        (e) => e.name === partition.name && e.origin === "local",
      );

      let ext: Extension;
      if (existing && existing.version !== partition.version) {
        ext = makeExtension({
          name: partition.name,
          version: partition.version,
          origin: "local",
          extensionRoot: partition.extensionRoot,
          sources: existing.sources.values(),
        });
        logger
          .info`Local extension ${partition.name} version migrated: ${existing.version} → ${partition.version}`;
      } else if (existing) {
        ext = existing;
      } else if (isDefault && !topLevelManifest) {
        ext = makeLocalExtension({ repoRoot: this.repoDir, basename });
      } else {
        ext = makeExtension({
          name: partition.name,
          version: partition.version,
          origin: "local",
          extensionRoot: partition.extensionRoot,
          sources: [],
        });
      }

      ext = await this.reconcileExtension(
        ext,
        partition.sources,
        transitions,
        cache,
        "local",
      );

      if (ext.sources.size === 0 && !existing) continue;
      result.push(ext);
    }

    return { extensions: result, hasManifestPartitions };
  }

  private async reconcilePulled(
    existingExtensions: Extension[],
    transitions: ReconcileTransition[],
    cache: FreshnessCache,
  ): Promise<Extension[]> {
    const pulledRoot = swampPath(this.repoDir, "pulled-extensions");
    const result: Extension[] = [];
    const lockfileEntries = this.lockfileRepository.getAllEntries();

    for (const extensionName of Object.keys(lockfileEntries)) {
      const extRoot = join(pulledRoot, extensionName);
      const version = this.lockfileRepository.getLockedVersion(extensionName) ??
        "";
      const existing = existingExtensions.find(
        (e) => e.name === extensionName && e.version === version,
      );

      const onDiskSources = new Map<
        string,
        { kind: KindDir; baseDir: string }
      >();
      for (const kindDir of KIND_DIRS) {
        const dir = join(extRoot, kindDir);
        const files = await collectTsFiles(dir);
        for (const absolutePath of files) {
          onDiskSources.set(absolutePath, { kind: kindDir, baseDir: dir });
        }
      }

      let ext = existing ?? makeExtension({
        name: extensionName,
        version,
        origin: "pulled",
        extensionRoot: extRoot,
        sources: [],
      });

      ext = await this.reconcileExtension(
        ext,
        onDiskSources,
        transitions,
        cache,
        "pulled",
      );

      result.push(ext);
    }

    // Handle orphaned pulled extensions: in catalog but not in lockfile.
    for (const existing of existingExtensions) {
      if (existing.origin !== "pulled") continue;
      if (lockfileEntries[existing.name]) continue;
      let ext = existing;
      for (const [loc, source] of ext.sources) {
        if (source.state.tag === "Tombstoned") continue;
        transitions.push({
          source: loc,
          fromState: source.state.tag,
          toState: "Tombstoned",
          reason: "orphan: no lockfile entry",
        });
        ext = markSourceMissing(ext, { location: loc, bundleOnDisk: null });
      }
      result.push(ext);
    }

    return result;
  }

  private async reconcileExtension(
    extension: Extension,
    onDiskSources: Map<string, { kind: KindDir; baseDir: string }>,
    transitions: ReconcileTransition[],
    cache: FreshnessCache,
    originType: "local" | "pulled",
  ): Promise<Extension> {
    let ext = extension;

    // Phase 1: Sources on disk — ensure they're in the aggregate.
    for (const [absolutePath, { kind, baseDir }] of onDiskSources) {
      const loc = makeSourceLocation(absolutePath, ext.extensionRoot);
      const existingSource = findSourceByPath(ext, loc.canonicalPath);
      // Use the existing source's id for aggregate operations (Map key
      // equality is by reference). For new sources, use the fresh loc.
      const effectiveLoc = existingSource?.id ?? loc;

      if (existingSource && existingSource.state.tag === "Indexed") {
        try {
          const fp = await computeSourceFingerprint(
            absolutePath,
            baseDir,
            cache,
          );
          if (fp === existingSource.fingerprint) continue;
        } catch {
          // Fingerprint failed — fall through to re-bundle.
        }
      }

      const loader = this.makeLoaderForKind(kind);
      const relativePath = relative(baseDir, absolutePath);
      const sourceStat = await Deno.stat(absolutePath);
      const sourceMtime = sourceStat.mtime?.toISOString() ?? "";
      try {
        const out = await loader.bundleAndIndexOne({
          absolutePath,
          relativePath,
          baseDir,
          trustPulledCache: originType === "pulled",
        });
        if (!out) continue;

        const fp = await computeSourceFingerprint(
          absolutePath,
          baseDir,
          cache,
        );
        const bundle = makeBundleLocation(out.bundlePath, fp);
        const fromState = existingSource?.state.tag ?? null;

        ext = observeFreshSource(ext, {
          location: effectiveLoc,
          kind: out.kind,
          fingerprint: fp,
          type: out.typeNormalized,
          bundle,
          sourceMtime,
        });

        ext = recordBundled(ext, {
          location: effectiveLoc,
          type: out.typeNormalized,
          bundle,
        });

        if (fromState !== "Indexed") {
          transitions.push({
            source: effectiveLoc,
            fromState,
            toState: "Indexed",
            reason: fromState === null
              ? "new source discovered on disk"
              : `re-indexed from ${fromState}`,
          });
        }
      } catch (error) {
        let failFp: string;
        try {
          failFp = await computeSourceFingerprint(
            absolutePath,
            baseDir,
            cache,
          );
        } catch {
          failFp = "";
        }

        const result = recordSourceFailure({
          extension: ext,
          location: effectiveLoc,
          kindDir: kind,
          error,
          existingSource,
          fingerprint: failFp,
          sourceMtime,
        });
        ext = result.extension;
        if (result.transition) {
          transitions.push(result.transition);
        }
      }
    }

    // Phase 2: Sources in aggregate but NOT on disk → transition.
    // Canonicalize on-disk keys for comparison — on Windows the raw
    // absolutePath uses backslashes while loc.canonicalPath uses forward
    // slashes (see canonicalizePath).
    const onDiskCanonical = new Set(
      [...onDiskSources.keys()].map(canonicalizePath),
    );
    for (const [loc, source] of ext.sources) {
      if (source.state.tag === "Tombstoned") continue;
      if (onDiskCanonical.has(loc.canonicalPath)) continue;

      const fromState = source.state.tag;

      if (originType === "pulled") {
        // Pulled: lockfile is canonical. Source missing but lockfile
        // entry present → EntryPointUnreadable (re-fetch is W4).
        // This path only fires if the lockfile has the entry —
        // orphan handling (no lockfile entry) is in reconcilePulled.
        ext = recordEntryPointUnreadable(ext, {
          location: loc,
          lastError: "source file missing from disk",
        });
        transitions.push({
          source: loc,
          fromState,
          toState: "EntryPointUnreadable",
          reason: "pulled source missing from disk (lockfile entry present)",
        });
      } else {
        // Local / source-mounted: source is canonical → tombstone.
        const bundleOnDisk = extractBundlePath(source.state);
        ext = markSourceMissing(ext, { location: loc, bundleOnDisk });
        const newState = bundleOnDisk ? "OrphanedBundleOnly" : "Tombstoned";
        transitions.push({
          source: loc,
          fromState,
          toState: newState,
          reason: "source file deleted from disk",
        });
      }
    }

    return ext;
  }

  private makeLoaderForKind(
    kindDir: KindDir,
  ): {
    bundleAndIndexOne: (args: {
      absolutePath: string;
      relativePath: string;
      baseDir: string;
      trustPulledCache?: boolean;
    }) => Promise<
      | {
        kind:
          | "model"
          | "extension"
          | "vault"
          | "driver"
          | "datastore"
          | "report";
        typeNormalized: string;
        bundlePath: string;
        fingerprint: string;
      }
      | null
    >;
  } {
    switch (kindDir) {
      case "models":
        return new ExtensionLoader(
          this.denoRuntime,
          modelKindAdapter,
          this.repoDir,
          undefined,
          this.repository,
        );
      case "vaults":
        return new ExtensionLoader(
          this.denoRuntime,
          vaultKindAdapter,
          this.repoDir,
          undefined,
          this.repository,
        );
      case "datastores":
        return new ExtensionLoader(
          this.denoRuntime,
          datastoreKindAdapter,
          this.repoDir,
          undefined,
          this.repository,
        );
      case "reports":
        return new ExtensionLoader(
          this.denoRuntime,
          reportKindAdapter,
          this.repoDir,
          undefined,
          this.repository,
        );
    }
  }

  private markKindsPopulated(): void {
    const kinds: ExtensionKind[] = [
      "model",
      "vault",
      "datastore",
      "report",
    ];
    this.repository.setLayoutVersion(BUNDLE_LAYOUT_VERSION);
    for (const kind of kinds) {
      this.repository.markPopulated(kind);
    }
  }

  private markAllKindsPopulated(): void {
    this.markKindsPopulated();
    const m = this.localManifestIdentity;
    this.repository.setManifestIdentity(
      m ? `${m.name}@${m.version}` : null,
    );
  }
}

function countSources(extensions: Extension[]): number {
  let count = 0;
  for (const ext of extensions) {
    for (const source of ext.sources.values()) {
      if (source.state.tag !== "Tombstoned") count++;
    }
  }
  return count;
}

function extractBundlePath(
  state: { tag: string; bundle?: { canonicalPath: string } },
): ReturnType<typeof makeBundleLocation> | null {
  if ("bundle" in state && state.bundle) {
    return state.bundle as ReturnType<typeof makeBundleLocation>;
  }
  return null;
}

async function collectTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isFile && entry.name.endsWith(".ts")) {
        out.push(path);
      } else if (entry.isDirectory && !entry.name.startsWith("_")) {
        out.push(...await collectTsFiles(path));
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return out;
}

/**
 * Scans immediate subdirectories of `kindDir` for `manifest.yaml`
 * files that declare both `name` and `version`. Populates `out` with
 * entries keyed by the subdirectory's absolute path.
 */
async function discoverSubdirManifests(
  kindDir: string,
  out: Map<string, LocalManifestIdentity>,
): Promise<void> {
  try {
    for await (const entry of Deno.readDir(kindDir)) {
      if (!entry.isDirectory || entry.name.startsWith("_")) continue;
      const subdirPath = join(kindDir, entry.name);
      const manifestPath = join(subdirPath, "manifest.yaml");
      const identity = readManifestIdentityAt(manifestPath);
      if (identity) {
        out.set(subdirPath, identity);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

/**
 * Determines which manifest-bearing subdirectory owns `filePath`.
 * Returns the partition key (`"<name>@<version>"`) for the owning
 * subdirectory, or `defaultKey` if the file is not under any
 * manifest-bearing subdirectory.
 */
function findOwningManifest(
  filePath: string,
  subdirManifests: Map<string, LocalManifestIdentity>,
  defaultKey: string,
): string {
  for (const [subdirPath, manifest] of subdirManifests) {
    if (filePath.startsWith(subdirPath + SEPARATOR)) {
      return `${manifest.name}@${manifest.version}`;
    }
  }
  return defaultKey;
}
