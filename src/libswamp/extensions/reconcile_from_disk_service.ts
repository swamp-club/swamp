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
import {
  BUNDLE_LAYOUT_VERSION,
  warnPulledTypeConflicts,
} from "../../infrastructure/persistence/extension_catalog_store.ts";
import type { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import { resolvePulledExtensionsRoot } from "../../infrastructure/persistence/paths.ts";
import {
  enumeratePulledDatastoreExtensionsOnDisk,
  type OnDiskDatastoreExtension,
} from "./enumerate_pulled.ts";
import { ExtensionLoader } from "../../domain/extensions/extension_loader.ts";
import {
  type BundleProber,
  ProbeFailedError,
} from "../../domain/extensions/bundle_prober.ts";
import { modelKindAdapter } from "../../domain/extensions/model_kind_adapter.ts";
import { vaultKindAdapter } from "../../domain/extensions/vault_kind_adapter.ts";
import { datastoreKindAdapter } from "../../domain/extensions/datastore_kind_adapter.ts";
import { reportKindAdapter } from "../../domain/extensions/report_kind_adapter.ts";
import { webhookKindAdapter } from "../../domain/extensions/webhook_kind_adapter.ts";
import type { DenoRuntime } from "../../domain/runtime/deno_runtime.ts";
import {
  collectDirsForKind,
  expandSourcePaths,
  readSwampSources,
  resolveSourceExtensionDirs,
} from "../../infrastructure/persistence/swamp_sources_repository.ts";
import { resolveSourceBaseDirs } from "../../infrastructure/persistence/git_worktree.ts";
import { BEHAVIORS_DIR_NAME } from "../../domain/terminology/behavior_aliases.ts";
import { createDenoInfoModuleGraphReader } from "../../infrastructure/runtime/deno_info_module_graph_reader.ts";

const logger = getLogger(["swamp", "extensions", "reconcile"]);

const KIND_DIRS = [
  "models",
  "vaults",
  "datastores",
  "reports",
  "webhooks",
] as const;

type KindDir = typeof KIND_DIRS[number];

/**
 * includes extensions/behaviors/, the behavior-spelled sibling of
 * extensions/models/.
 */
const LOCAL_KIND_DIRS: ReadonlyArray<readonly [string, KindDir]> = [
  ...KIND_DIRS.map((k) => [k, k] as const),
  [BEHAVIORS_DIR_NAME, "models"],
];

export interface ReconcileTransition {
  readonly source: SourceLocation;
  readonly fromState: RowStateTag | null;
  readonly toState: RowStateTag;
  readonly reason: string;
}

export interface ReconcileResult {
  readonly transitions: readonly ReconcileTransition[];
  readonly applied: boolean;
}

/** each extension is saved on its own, so one failure never rolls back another. */
export type UncataloguedPulledResult =
  | {
    readonly name: string;
    readonly status: "catalogued";
    readonly transitions: readonly ReconcileTransition[];
  }
  | {
    readonly name: string;
    readonly status: "skipped";
    readonly reason: string;
  }
  | {
    readonly name: string;
    readonly status: "failed";
    readonly error: unknown;
  };

/**
 * delegates to per-loader bundleAndIndexOne, not InstallExtensionService: the
 * source is already on disk, so this is state repair. A run that would
 * transition over 50% of rows aborts unapplied, to catch mass-tombstone bugs.
 */
export class ReconcileFromDiskService {
  private readonly denoRuntime: DenoRuntime;
  private readonly repository: ExtensionRepository;
  private readonly lockfileRepository: LockfileRepository;
  private readonly repoDir: string;
  private readonly localManifestIdentity: LocalManifestIdentity | null;
  private readonly pulledExtensionsRoot: string;
  private readonly scanOnDiskDatastores: boolean;
  private readonly additionalInstalledNames: ReadonlySet<string>;
  private readonly bundleProber: BundleProber | undefined;
  private onDiskDatastores = new Map<string, OnDiskDatastoreExtension>();

  constructor(args: {
    denoRuntime: DenoRuntime;
    repository: ExtensionRepository;
    lockfileRepository: LockfileRepository;
    repoDir: string;
    localManifestIdentity?: LocalManifestIdentity | null;
    pulledExtensionsRoot?: string;
    /**
     * walk a lockfile entry's datastore sources at the root the on-disk scan
     * chose (possibly the legacy root after `datastore config migrate`);
     * datastore sources under a chosen dir are never orphaned.
     */
    scanOnDiskDatastores?: boolean;
    /**
     * names installed outside the lockfile this service iterates, such as the
     * transitional in-repo auto-resolve lockfile; their catalog rows are not
     * orphaned. Iteration and versions still use lockfileRepository only.
     */
    additionalInstalledNames?: readonly string[];
    /**
     * probes bundles in isolation instead of importing them into this isolate;
     * released when each pass ends.
     */
    bundleProber?: BundleProber;
  }) {
    this.bundleProber = args.bundleProber;
    this.denoRuntime = args.denoRuntime;
    this.repository = args.repository;
    this.lockfileRepository = args.lockfileRepository;
    this.repoDir = resolve(args.repoDir);
    this.localManifestIdentity = args.localManifestIdentity ?? null;
    this.pulledExtensionsRoot = args.pulledExtensionsRoot ??
      resolvePulledExtensionsRoot(this.repoDir);
    this.scanOnDiskDatastores = args.scanOnDiskDatastores ?? false;
    this.additionalInstalledNames = new Set(args.additionalInstalledNames);
  }

  async execute(
    options?: { dryRun?: boolean },
  ): Promise<ReconcileResult> {
    try {
      return await this.executePass(options);
    } finally {
      await this.bundleProber?.release();
    }
  }

  private async executePass(
    options?: { dryRun?: boolean },
  ): Promise<ReconcileResult> {
    const dryRun = options?.dryRun ?? false;
    const transitions: ReconcileTransition[] = [];

    this.onDiskDatastores = new Map(
      this.scanOnDiskDatastores
        ? (await enumeratePulledDatastoreExtensionsOnDisk(this.repoDir, true))
          .map((d) => [d.name, d])
        : [],
    );

    const existingExtensions = this.repository.loadAll();
    const totalExistingRows = countSources(existingExtensions);

    const { extensions: reconciledExtensions, migrationTransitions } =
      await this.reconcileAll(
        existingExtensions,
        transitions,
      );

    // identity-migration tombstones are expected mass transitions, so they are
    // left out of the guardrail ratio; otherwise a version bump in a repo with
    // 10 or more local sources would block the migration permanently.
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
      // reconcile repairs state it did not create, so two pulled extensions
      // providing one type are settled rather than rolled back, which would
      // leave the catalog empty for every later command.
      this.repository.saveAll(reconciledExtensions, {
        settlePulledTypeConflicts: true,
      });
      warnPulledTypeConflicts(
        logger,
        this.repository.lastPulledTypeConflicts,
      );
      this.markAllKindsPopulated();
      logger
        .info`Extension catalog updated: ${transitions.length} ${
        transitions.length === 1 ? "entry" : "entries"
      } repaired`;
    } else if (!dryRun && totalExistingRows === 0) {
      this.markAllKindsPopulated();
    } else if (transitions.length === 0) {
      // A clean full-tree pass proves every kind is in sync; mark them so
      // kinds added after the catalog was built stop re-triggering reconcile.
      if (!dryRun) this.markAllKindsPopulated();
      logger.debug`Reconcile complete: no transitions`;
    }

    return { transitions, applied: !dryRun && transitions.length > 0 };
  }

  selectUncataloguedPulled(extensionNames: readonly string[]): string[] {
    const skips = this.uncataloguedSkipReasons(extensionNames);
    return extensionNames.filter((name) => !skips.has(name));
  }

  /**
   * creates aggregates only for named extensions that have none; each is saved
   * on its own, so a failure rolls back only that one. Skips unreachable-source
   * pruning, which would delete rows of live sources mounted outside the repo
   * root.
   */
  async reconcileUncataloguedPulled(
    extensionNames: readonly string[],
  ): Promise<UncataloguedPulledResult[]> {
    this.onDiskDatastores = new Map(
      this.scanOnDiskDatastores
        ? (await enumeratePulledDatastoreExtensionsOnDisk(this.repoDir, true))
          .map((d) => [d.name, d])
        : [],
    );
    const skips = this.uncataloguedSkipReasons(extensionNames);
    const cache = createFreshnessCache();
    const results: UncataloguedPulledResult[] = [];

    for (const name of extensionNames) {
      const skipReason = skips.get(name);
      if (skipReason) {
        results.push({ name, status: "skipped", reason: skipReason });
        continue;
      }
      try {
        const transitions: ReconcileTransition[] = [];
        const ext = await this.reconcilePulledEntry(
          name,
          [],
          transitions,
          cache,
        );
        if (transitions.length === 0) {
          results.push({
            name,
            status: "skipped",
            reason: "no entry-point sources on disk",
          });
          continue;
        }
        this.repository.saveAll([ext], { pruneUnreachable: false });
        results.push({ name, status: "catalogued", transitions });
      } catch (error) {
        results.push({ name, status: "failed", error });
      }
    }

    return results;
  }

  private uncataloguedSkipReasons(
    extensionNames: readonly string[],
  ): Map<string, string> {
    const lockfileEntries = this.lockfileRepository.getAllEntries();
    const catalogued = new Set(
      this.repository.loadAll().map((ext) => ext.name),
    );
    const reasons = new Map<string, string>();
    for (const name of extensionNames) {
      if (!lockfileEntries[name]) {
        reasons.set(name, "no lockfile entry");
      } else if (catalogued.has(name)) {
        reasons.set(name, "already catalogued");
      }
    }
    return reasons;
  }

  private async reconcileAll(
    existingExtensions: Extension[],
    transitions: ReconcileTransition[],
  ): Promise<{ extensions: Extension[]; migrationTransitions: number }> {
    const cache = createFreshnessCache();
    const result: Extension[] = [];
    let migrationTransitions = 0;

    // each manifest-bearing subdirectory becomes its own Extension aggregate;
    // remaining files fall back to the @local/<repo> aggregate.
    const localTransitionsBefore = transitions.length;
    const { extensions: localExts, hasManifestPartitions } = await this
      .reconcileLocalAndSourceMounted(
        existingExtensions,
        transitions,
        cache,
      );
    const localTransitionsAdded = transitions.length - localTransitionsBefore;

    // pulled before local in the result array, so saveAll deletes pulled-orphan
    // rows before local inserts; otherwise a removed manifest's old rows would
    // clobber the new @local/ rows at the same source_path.
    const pulledExts = await this.reconcilePulled(
      existingExtensions,
      transitions,
      cache,
    );
    result.push(...pulledExts);

    // tombstones come before the new aggregates: saveAll processes in array
    // order, so removeBySourcePath deletes old rows before upsertWithIdentity
    // writes new ones at the same paths.
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
      // Tombstones and new-source indexing from an identity change, full or
      // partial, count as migration transitions exempt from the >50% guardrail.
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

    // only immediate children are checked; deeper nesting is not an extension
    // boundary. A top-level manifest claims the entire tree, so
    // per-subdirectory manifests are then ignored.
    const subdirManifests = new Map<string, LocalManifestIdentity>();
    if (!topLevelManifest) {
      for (const [dirName] of LOCAL_KIND_DIRS) {
        const kindPath = join(this.repoDir, "extensions", dirName);
        await discoverSubdirManifests(kindPath, subdirManifests);
      }
    }

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

    for (const [dirName, kindDir] of LOCAL_KIND_DIRS) {
      const dir = join(this.repoDir, "extensions", dirName);
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

    const config = await readSwampSources(this.repoDir);
    if (config) {
      const { baseDir, legacyBaseDir } = await resolveSourceBaseDirs(
        this.repoDir,
      );
      const expanded = await expandSourcePaths(
        config,
        this.repoDir,
        baseDir,
        legacyBaseDir,
      );
      const { resolved } = await resolveSourceExtensionDirs(expanded);
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

    const hasManifestPartitions = subdirManifests.size > 0;
    const result: Extension[] = [];
    for (const [key, partition] of partitions) {
      const isDefault = key === defaultKey;

      // when manifest partitions claimed all files of the default partition,
      // skip it; the old @local/<repo> aggregate is tombstoned by the identity
      // migration loop and counted as migration transitions.
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
    const result: Extension[] = [];
    const lockfileEntries = this.lockfileRepository.getAllEntries();

    for (const extensionName of Object.keys(lockfileEntries)) {
      result.push(
        await this.reconcilePulledEntry(
          extensionName,
          existingExtensions,
          transitions,
          cache,
        ),
      );
    }

    const chosenDatastoreDirs = [...this.onDiskDatastores.values()].map((d) => {
      const dir = canonicalizePath(d.datastoresDir);
      return dir.endsWith("/") ? dir : `${dir}/`;
    });
    for (const existing of existingExtensions) {
      if (existing.origin !== "pulled") continue;
      if (lockfileEntries[existing.name]) continue;
      if (this.additionalInstalledNames.has(existing.name)) continue;
      let ext = existing;
      for (const [loc, source] of ext.sources) {
        if (source.state.tag === "Tombstoned") continue;
        if (
          chosenDatastoreDirs.some((dir) => loc.canonicalPath.startsWith(dir))
        ) {
          continue;
        }
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

  private async reconcilePulledEntry(
    extensionName: string,
    existingExtensions: Extension[],
    transitions: ReconcileTransition[],
    cache: FreshnessCache,
  ): Promise<Extension> {
    const extRoot = join(this.pulledExtensionsRoot, extensionName);
    const version = this.lockfileRepository.getLockedVersion(extensionName) ??
      "";
    const existing = existingExtensions.find(
      (e) => e.name === extensionName && e.version === version,
    );

    const onDiskSources = new Map<
      string,
      { kind: KindDir; baseDir: string }
    >();
    const walkedDirs: string[] = [];
    for (const kindDir of KIND_DIRS) {
      const dir = kindDir === "datastores"
        ? this.onDiskDatastores.get(extensionName)?.datastoresDir ??
          join(extRoot, kindDir)
        : join(extRoot, kindDir);
      walkedDirs.push(dir);
      const files = await collectTsFiles(dir);
      for (const absolutePath of files) {
        onDiskSources.set(absolutePath, { kind: kindDir, baseDir: dir });
      }
    }

    const ext = existing ?? makeExtension({
      name: extensionName,
      version,
      origin: "pulled",
      extensionRoot: extRoot,
      sources: [],
    });

    return await this.reconcileExtension(
      ext,
      onDiskSources,
      transitions,
      cache,
      "pulled",
      walkedDirs,
    );
  }

  private async reconcileExtension(
    extension: Extension,
    onDiskSources: Map<string, { kind: KindDir; baseDir: string }>,
    transitions: ReconcileTransition[],
    cache: FreshnessCache,
    originType: "local" | "pulled",
    walkedDirs?: readonly string[],
  ): Promise<Extension> {
    let ext = extension;

    for (const [absolutePath, { kind, baseDir }] of onDiskSources) {
      const loc = makeSourceLocation(absolutePath, ext.extensionRoot);
      const existingSource = findSourceByPath(ext, loc.canonicalPath);
      // use the existing source's id for aggregate operations, since Map key
      // equality is by reference.
      const effectiveLoc = existingSource?.id ?? loc;

      if (existingSource && existingSource.state.tag === "Indexed") {
        try {
          const fp = await computeSourceFingerprint(
            absolutePath,
            baseDir,
            this.repository.getCatalogStore(),
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
          this.repository.getCatalogStore(),
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
        // recorded below as deterministic, so this is the one time the user is
        // told why the source is missing.
        if (error instanceof ProbeFailedError) {
          logger.warn`${error.message}`;
        }
        let failFp: string;
        try {
          failFp = await computeSourceFingerprint(
            absolutePath,
            baseDir,
            this.repository.getCatalogStore(),
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

    // canonicalize on-disk keys for comparison: on Windows the raw path uses
    // backslashes while canonicalPath uses forward slashes.
    const onDiskCanonical = new Set(
      [...onDiskSources.keys()].map(canonicalizePath),
    );
    const walkedPrefixes = walkedDirs?.map((d) => {
      const c = canonicalizePath(d);
      return c.endsWith("/") ? c : `${c}/`;
    });
    for (const [loc, source] of ext.sources) {
      if (source.state.tag === "Tombstoned") continue;
      if (onDiskCanonical.has(loc.canonicalPath)) continue;

      const fromState = source.state.tag;

      if (
        originType === "pulled" && walkedPrefixes !== undefined &&
        !walkedPrefixes.some((p) => loc.canonicalPath.startsWith(p))
      ) {
        // outside every dir walked for this entry, such as a managed repo's
        // pre-migration pulled-extensions copy: the lockfile does not vouch for
        // it, so it is tombstoned, not left as an EntryPointUnreadable row
        ext = markSourceMissing(ext, { location: loc, bundleOnDisk: null });
        transitions.push({
          source: loc,
          fromState,
          toState: "Tombstoned",
          reason: "pulled source outside the extension's walked dirs",
        });
      } else if (originType === "pulled") {
        // pulled: the lockfile is canonical, so a source missing while its
        // lockfile entry is present is EntryPointUnreadable; sources with no
        // lockfile entry are handled in reconcilePulled.
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
          | "datastore"
          | "report"
          | "webhook";
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
          this.bundleProber,
          createDenoInfoModuleGraphReader,
        );
      case "vaults":
        return new ExtensionLoader(
          this.denoRuntime,
          vaultKindAdapter,
          this.repoDir,
          undefined,
          this.repository,
          this.bundleProber,
          createDenoInfoModuleGraphReader,
        );
      case "datastores":
        return new ExtensionLoader(
          this.denoRuntime,
          datastoreKindAdapter,
          this.repoDir,
          undefined,
          this.repository,
          this.bundleProber,
          createDenoInfoModuleGraphReader,
        );
      case "reports":
        return new ExtensionLoader(
          this.denoRuntime,
          reportKindAdapter,
          this.repoDir,
          undefined,
          this.repository,
          this.bundleProber,
          createDenoInfoModuleGraphReader,
        );
      case "webhooks":
        return new ExtensionLoader(
          this.denoRuntime,
          webhookKindAdapter,
          this.repoDir,
          undefined,
          this.repository,
          this.bundleProber,
          createDenoInfoModuleGraphReader,
        );
    }
  }

  private markKindsPopulated(): void {
    const kinds: ExtensionKind[] = [
      "model",
      "vault",
      "datastore",
      "report",
      "webhook",
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
